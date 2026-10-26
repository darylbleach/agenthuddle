// Isolation: each agent CLI runs as its own Unix user with a private home (0700), so one agent
// can't read another's logins. Git runs as `ar-git`. Each room's workspace belongs to its own
// group, so an agent working in one room can't touch another room's checkout.
// Outside the container (local dev, not root, users missing) everything runs as the current user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const AGENT_USERS = { claude: 'ar-claude', codex: 'ar-codex', agy: 'ar-agy', 'cursor-agent': 'ar-cursor', grok: 'ar-grok' };
const PRESET_USERS = {
  'claude-login': 'ar-claude', 'claude-status': 'ar-claude',
  'codex-login': 'ar-codex', 'codex-status': 'ar-codex',
  agy: 'ar-agy', 'grok-login': 'ar-grok', 'cursor-login': 'ar-cursor', 'cursor-status': 'ar-cursor',
};

function lookup(name) {
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.startsWith(name + ':'));
    if (!line) return null;
    const [, , uid, gid, , home] = line.split(':');
    return { name, uid: Number(uid), gid: Number(gid), home };
  } catch { return null; }
}

export const ISOLATED = process.env.AGENT_HUDDLE_LOCAL !== '1' && process.getuid?.() === 0 && !!lookup('ar-git') && Object.values(AGENT_USERS).every((u) => lookup(u));
const SELF = { name: os.userInfo().username, uid: process.getuid?.(), gid: process.getgid?.(), home: os.homedir(), self: true };

/** The user an agent CLI runs as. */
export function userFor(cmd) { return (ISOLATED && lookup(AGENT_USERS[cmd] || 'ar-shell')) || SELF; }
export function gitUser() { return (ISOLATED && lookup('ar-git')) || SELF; }
export function consoleUser(preset) { return (ISOLATED && lookup(PRESET_USERS[preset] || 'ar-shell')) || SELF; }
/** Which user's home a saved login file belongs to (path relative to that home). */
export function userForCredPath(rel) {
  rel = String(rel).replace(/^\.agenthuddle\/accounts\/[a-z0-9-]{1,30}\//, ''); // an extra account's files belong to the same CLI user
  if (/^\.claude(\.json|\/)/.test(rel)) return userFor('claude');
  if (rel.startsWith('.codex/')) return userFor('codex');
  if (rel.startsWith('.grok/')) return userFor('grok');
  if (/^\.(cursor|config\/cursor)\//.test(rel)) return userFor('cursor-agent');
  if (/^\.(gemini|antigravity|local\/share\/keyrings|config\/antigravity)/.test(rel)) return userFor('agy');
  return null;
}

/** A group per room; created on first use. Returns its gid (or the current gid outside isolation). */
const roomGids = new Map();
export function roomGid(roomId) {
  if (!ISOLATED) return SELF.gid;
  if (!/^[a-z0-9-]{1,40}$/i.test(roomId)) throw new Error('bad room id');
  if (roomGids.has(roomId)) return roomGids.get(roomId);
  const name = `ar-r-${roomId.toLowerCase()}`.slice(0, 32);
  const find = () => { const l = fs.readFileSync('/etc/group', 'utf8').split('\n').find((x) => x.startsWith(name + ':')); return l ? Number(l.split(':')[2]) : null; };
  let gid = find();
  if (gid == null) { execFileSync('/usr/sbin/groupadd', [name]); gid = find(); }
  roomGids.set(roomId, gid);
  return gid;
}

/** spawn() options to run as `user` (optionally with a room's group), with a clean, minimal environment. */
export function asUser(user, { gid, env = {}, cwd } = {}) {
  const base = { PATH: process.env.PATH, LANG: process.env.LANG || 'C.UTF-8', HOME: user.home, USER: user.name, LOGNAME: user.name, TMPDIR: '/tmp' };
  const opts = { env: { ...base, ...env }, cwd: cwd || user.home };
  if (!user.self) { opts.uid = user.uid; opts.gid = gid ?? user.gid; }
  return opts;
}

/** Make sure an agent's home exists and is private. */
export function prepareHome(user) {
  if (user.self) return;
  fs.mkdirSync(user.home, { recursive: true });
  fs.chownSync(user.home, user.uid, user.gid);
  fs.chmodSync(user.home, 0o700);
}

/**
 * File work inside an agent's home or a room workspace is done by a short-lived child process
 * running AS that user, never by root: a symlink an agent planted can then only lead where that
 * user could write anyway. ops: [{op:'write', path, b64, mode?}, {op:'read', path, max?},
 * {op:'walk', root, skip?, max?}, {op:'append-line', path, line}, {op:'mkdir', path}]
 */
const FILEOPS = `
const fs=require('fs'),path=require('path');let ops='';process.stdin.on('data',d=>ops+=d).on('end',()=>{
const out=[];for(const o of JSON.parse(ops)){try{
if(o.op==='write'){fs.mkdirSync(path.dirname(o.path),{recursive:true,mode:0o700});const t=o.path+'.tmp-'+process.pid;fs.writeFileSync(t,Buffer.from(o.b64,'base64'),{mode:o.mode||0o600});fs.renameSync(t,o.path);out.push(true);}
else if(o.op==='unlink'){try{fs.unlinkSync(o.path)}catch{}out.push(true);}
else if(o.op==='mkdir'){fs.mkdirSync(o.path,{recursive:true,mode:o.mode||0o700});out.push(true);}
else if(o.op==='append-line'){let c='';try{c=fs.readFileSync(o.path,'utf8')}catch{}if(!c.split('\\n').includes(o.line)){fs.mkdirSync(path.dirname(o.path),{recursive:true});fs.appendFileSync(o.path,(c&&!c.endsWith('\\n')?'\\n':'')+o.line+'\\n');}out.push(true);}
else if(o.op==='read'){const st=fs.lstatSync(o.path);out.push(st.isFile()&&st.size<=(o.max||262144)?fs.readFileSync(o.path).toString('base64'):null);}
else if(o.op==='walk'){const res={};let total=0;const skip=new Set(o.skip||[]);const go=(rel)=>{const full=path.join(o.root,rel);let st;try{st=fs.lstatSync(full)}catch{return}if(st.isSymbolicLink())return;
if(st.isDirectory()){if(skip.has(path.basename(rel)))return;for(const f of fs.readdirSync(full))go(path.join(rel,f));}
else if(st.isFile()&&st.size<=(o.max||262144)&&total+st.size<1500000){total+=st.size;res[rel]=fs.readFileSync(full).toString('base64');}};for(const r of o.rels)go(r);out.push(res);}
else out.push(null);}catch(e){out.push(null)}}process.stdout.write(JSON.stringify(out));});`;
export function fileOps(user, ops, { gid } = {}) {
  const opts = { input: JSON.stringify(ops), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000, env: { PATH: process.env.PATH, HOME: user.home } };
  if (!user.self) { opts.uid = user.uid; opts.gid = gid ?? user.gid; }
  opts.cwd = '/';
  const r = spawnSync(process.execPath, ['-e', FILEOPS], { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
  try { return JSON.parse(r.stdout); } catch { return ops.map(() => null); }
}
