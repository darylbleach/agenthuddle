// Agent Huddle runner — runs inside the Cloudflare Container (as root).
// Executes agent CLI/API jobs, manages per-room git workspaces, a login console, and exports/imports
// the agents' login files so they survive container restarts.
//
// Isolation (see users.mjs): each agent CLI runs as its own Unix user with a private home; git runs
// as `ar-git`; each room's workspace belongs to its own group. All file work in agent homes and
// workspaces happens AS that user (fileOps), never as root. The GitHub token only ever reaches git,
// through GIT_ASKPASS, while cloning, fetching or pushing. Requests must carry RUNNER_SECRET.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readUsage, listModels, configureUsage } from './usage.mjs';
import { startKeyring, keyringEnv } from './keyring.mjs';
import { runCodexTurn } from './codex-app.mjs';
import { ISOLATED, AGENT_USERS, userFor, gitUser, consoleUser, userForCredPath, roomGid, asUser, prepareHome, fileOps } from './users.mjs';

process.umask(0o007); // files are shared with the room's group, never with everyone
process.on('uncaughtException', (e) => console.error('uncaught', e));
process.on('unhandledRejection', (e) => console.error('unhandled', e));

const WORK = process.env.AGENT_HUDDLE_WORK || '/work';
const PORT = Number(process.env.PORT || 8080);
// The Mac app hands the secret over on file descriptor 3, so agents (same macOS user) can't read
// it from this process's environment; the cloud container passes it in the environment.
const SECRET = process.env.AGENT_HUDDLE_SECRET_FD === '3' ? (() => { try { return JSON.parse(fs.readFileSync(3, 'utf8')).runnerSecret || ''; } catch { return ''; } })() : (process.env.RUNNER_SECRET || '');
if (process.env.AGENT_HUDDLE_SECRET_FD === '3' && !SECRET) { console.error('runner: no secret on fd 3'); process.exit(2); }
const ALLOW_FILE_REPOS = process.env.AGENT_HUDDLE_ALLOW_FILE_REPOS === '1'; // local tests only
// Local mode: the runner runs on your own Mac (started by the Mac app) instead of in a container.
// The CLIs use the logins already on the Mac, so nothing is exported or restored, and the runner
// only listens on 127.0.0.1. On macOS each agent runs inside a sandbox that only lets it write to
// its room's folder and its own settings folders (see sandboxProfile).
const LOCAL = process.env.AGENT_HUDDLE_LOCAL === '1';
const MAC = process.platform === 'darwin';
const HOST = process.env.AGENT_HUDDLE_HOST || (LOCAL ? '127.0.0.1' : '0.0.0.0');
const SANDBOX = LOCAL && MAC && process.env.AGENT_HUDDLE_SANDBOX !== '0' && fs.existsSync('/usr/bin/sandbox-exec');
const PRIVATE_PATHS = (process.env.AGENT_HUDDLE_PRIVATE || '').split(':').filter(Boolean); // Agent Huddle's own data
fs.mkdirSync(WORK, { recursive: true });
if (ISOLATED) fs.chmodSync(WORK, 0o711);
const META = path.join(WORK, '.meta'); // which repo/branch each room's checkout holds (root only)
fs.mkdirSync(META, { recursive: true, mode: 0o700 });
const ASKPASS = path.join(os.tmpdir(), 'agenthuddle-askpass.sh');
fs.writeFileSync(ASKPASS, '#!/bin/sh\ncase "$1" in Username*) echo x-access-token ;; *) echo "$AR_GIT_TOKEN" ;; esac\n', { mode: 0o755 });
fs.chmodSync(ASKPASS, 0o755);

let restored = false;
const jobs = new Map();
const stoppedIds = new Map(); // stop requests that arrived before the job did

// ---------- saved logins ----------
// Only token files are saved and restored — never CLI config (hooks, notify commands, MCP servers),
// which an agent could otherwise rewrite to run code after every restart.
// Extra accounts (several logins for the same CLI) live under .agenthuddle/accounts/<name>/.
const ACCT = '(\\.agenthuddle\\/accounts\\/[a-z0-9-]{1,30}\\/)?';
const CRED_ALLOW = [
  new RegExp(`^${ACCT}\\.claude\\/\\.credentials\\.json$`),
  new RegExp(`^${ACCT}\\.codex\\/auth\\.json$`),
  new RegExp(`^${ACCT}\\.grok\\/auth\\.json$`),
  /^\.config\/cursor\/[\w.-]+\.json$/, /^\.cursor\/[\w.-]+\.json$/,
  /^\.local\/share\/keyrings\/[\w.-]+$/,
  /^\.gemini\/(oauth_creds|google_accounts)\.json$/, /^\.gemini\/installation_id$/,
  /^\.gemini\/antigravity-cli\/(?!(log|logs|plugins|skills|hooks|mcp|conversations|brain|presence|updater)\/)[\w./-]+$/,
];
export const credAllowed = (rel) => typeof rel === 'string' && !rel.includes('..') && !rel.startsWith('/') && CRED_ALLOW.some((r) => r.test(rel)) && !/\.(log|db|sqlite|jsonl|lock)$/.test(rel);
const CRED_ROOTS = { claude: ['.claude/.credentials.json', '.agenthuddle/accounts'], codex: ['.codex/auth.json', '.agenthuddle/accounts'], grok: ['.grok/auth.json', '.agenthuddle/accounts'], 'cursor-agent': ['.config/cursor', '.cursor'], agy: ['.local/share/keyrings', '.gemini'] };
const SKIP_DIRS = ['conversations', 'history', 'brain', 'projects', 'logs', 'log', 'chats', 'extensions', 'cache', 'Cache', 'tmp', 'worktrees', 'snapshots', 'sessions', 'node_modules', 'bin', 'versions', 'plugins', 'skills', 'presence', 'updater'];

function exportCreds() {
  if (LOCAL) return { hash: 'local', files: {} };
  const files = {};
  for (const [cmd, rels] of Object.entries(CRED_ROOTS)) {
    const u = userFor(cmd);
    const got = fileOps(u, [{ op: 'walk', root: u.home, rels, skip: SKIP_DIRS }])[0] || {};
    for (const [rel, b64] of Object.entries(got)) if (credAllowed(rel)) files[rel] = b64;
  }
  const hash = crypto.createHash('sha256').update(JSON.stringify(Object.entries(files).sort())).digest('hex').slice(0, 16);
  return { hash, files };
}
function importCreds(files = {}) {
  if (LOCAL) return;
  const byUser = new Map();
  for (const [rel, b64] of Object.entries(files || {})) {
    if (!credAllowed(rel) || typeof b64 !== 'string') continue;
    const u = userForCredPath(rel); if (!u) continue;
    if (!byUser.has(u.name)) byUser.set(u.name, { u, ops: [] });
    byUser.get(u.name).ops.push({ op: 'write', path: path.join(u.home, rel), b64 });
  }
  for (const { u, ops } of byUser.values()) fileOps(u, ops);
  // Defaults so headless CLIs don't stop on first-run prompts (written fresh; never restored from storage).
  const cu = userFor('claude');
  if (!fileOps(cu, [{ op: 'read', path: path.join(cu.home, '.claude.json') }])[0]) fileOps(cu, [{ op: 'write', path: path.join(cu.home, '.claude.json'), b64: Buffer.from(JSON.stringify({ hasCompletedOnboarding: true })).toString('base64') }]);
  const gu = userFor('agy');
  const gemini = { security: { folderTrust: { enabled: false } } };
  if (files['.gemini/oauth_creds.json']) gemini.security.auth = { selectedType: 'oauth-personal' };
  fileOps(gu, [{ op: 'write', path: path.join(gu.home, '.gemini/settings.json'), b64: Buffer.from(JSON.stringify(gemini, null, 2)).toString('base64') }]);
}
const credsHash = () => exportCreds().hash;
for (const cmd of Object.keys(AGENT_USERS)) prepareHome(userFor(cmd));
prepareHome(consoleUser('bash'));

// ---------- helpers ----------
const stripAnsi = (s) => s
  .replace(/\r\n/g, '\n')
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/\x1b[()][A-Za-z0-9]/g, '')
  .replace(/\x1b[=>78DEHM]/g, '')
  .replace(/\r(?!\n)/g, '\n');

// Run a process to completion with a time limit (kills its whole process group).
function run(cmd, args, opts = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let p, out = '', done = false;
    try { p = spawn(cmd, args, { ...opts, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: e.message }); }
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out }); };
    const t = setTimeout(() => { killTree(p, 'SIGKILL'); out += '\n(timed out)'; finish(-1); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('error', (e) => { out += e.message; finish(-1); });
    p.on('close', (code) => finish(code));
  });
}
function killTree(p, sig) { if (!p?.pid) return; try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} } }

// Repos are GitHub owner/name or an https URL; branches are plain names (no options, no "..").
function repoUrl(repo) {
  const r = String(repo || '').trim().replace(/\.git$/, '');
  const m = r.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)$/) || r.match(/^([\w.-]+\/[\w.-]+)$/);
  if (m && !m[1].startsWith('-')) return `https://github.com/${m[1]}.git`;
  if (/^https:\/\/[\w.-]+(:\d+)?\/[\w./-]+$/.test(r)) return r + '.git';
  if (ALLOW_FILE_REPOS && String(repo).startsWith('/')) return String(repo).trim();
  throw new Error('Unsupported repository. Use owner/name or an https:// URL.');
}
const validBranch = (b) => !b || (/^[\w./-]{1,100}$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock'));

// git always runs as ar-git with repository config it can't be tricked by: hooks, fsmonitor,
// credential helpers and non-https transports are switched off on every call.
const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'credential.helper=', '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always', ...(ALLOW_FILE_REPOS ? ['-c', 'protocol.file.allow=always'] : []), '-c', 'safe.directory=*', '-c', 'core.sshCommand=false'];
function git(dir, args, { gid, token, timeoutMs } = {}) {
  const u = gitUser();
  const env = { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (token) Object.assign(env, { GIT_ASKPASS: ASKPASS, AR_GIT_TOKEN: token });
  return run('git', [...GIT_SAFE, ...args], asUser(u, { gid, env, cwd: dir }), timeoutMs || (token ? 300000 : 60000))
    .then((r) => (token ? { ...r, out: r.out.replaceAll(token, '***') } : r));
}
// Rewrite .git/config from scratch: an agent may have added url rewrites, filters or include files.
function sanitizeGit(dir, gid, room) {
  const branch = room.branch;
  const cfg = `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tsharedRepository = group\n`
    + `[remote "origin"]\n\turl = ${repoUrl(room.repo)}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
    + (branch ? `[branch "${branch}"]\n\tremote = origin\n\tmerge = refs/heads/${branch}\n` : '')
    + `[user]\n\tname = ${String(room.gitName || 'Agent Huddle').replace(/[\n\\"]/g, ' ')}\n\temail = ${String(room.gitEmail || 'agent-huddle@users.noreply.github.com').replace(/[\n\\"]/g, '')}\n`;
  fileOps(gitUser(), [
    { op: 'write', path: path.join(dir, '.git/config'), b64: Buffer.from(cfg).toString('base64'), mode: 0o660 },
    { op: 'append-line', path: path.join(dir, '.git/info/exclude'), line: '.agenthuddle/' },
  ], { gid });
}
function readMeta(roomId) { try { return JSON.parse(fs.readFileSync(path.join(META, `${roomId}.json`), 'utf8')); } catch { return null; } }
function writeMeta(roomId, m) { fs.writeFileSync(path.join(META, `${roomId}.json`), JSON.stringify(m), { mode: 0o600 }); }
function makeRoomDir(dir, gid) {
  fs.mkdirSync(dir, { recursive: true });
  if (ISOLATED) { const g = gitUser(); fs.chownSync(dir, g.uid, gid); fs.chmodSync(dir, 0o2770); }
}

// One job at a time per room for workspace setup, commit/push and clean-up.
const roomLocks = new Map();
function withRoomLock(roomId, fn) {
  const prev = roomLocks.get(roomId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  roomLocks.set(roomId, next.catch(() => {}));
  return next;
}

// ---------- workspace ----------
async function ensureWorkspace(room, token, log) {
  const gid = roomGid(room.id);
  if (!room.repo) {
    const dir = path.join(WORK, `${room.id}-chat`);
    if (!fs.existsSync(dir)) makeRoomDir(dir, gid);
    return { dir, gid };
  }
  if (!validBranch(room.branch)) throw new Error('Invalid branch name.');
  const url = repoUrl(room.repo);
  const dir = path.join(WORK, room.id);
  const meta = readMeta(room.id);
  if (!fs.existsSync(path.join(dir, '.git')) || meta?.repo !== url) {
    // New room, or the room's repo changed: start from a fresh clone.
    log(`$ git clone ${url}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
    makeRoomDir(dir, gid);
    const c = await git(WORK, ['clone', '--filter=blob:none', '--', url, dir], { gid, token });
    log(c.out);
    if (c.code !== 0) throw new Error(`git clone failed — check the repo name and your GitHub token.\n${c.out.slice(-800)}`);
    sanitizeGit(dir, gid, room);
    await checkoutBranch(dir, gid, room, token, log);
    writeMeta(room.id, { repo: url, branch: room.branch || '' });
    return { dir, gid };
  }
  sanitizeGit(dir, gid, room);
  if ((meta.branch || '') !== (room.branch || '')) {
    await git(dir, ['stash', 'push', '-u', '-m', 'agent-huddle: before switching branch'], { gid });
    await checkoutBranch(dir, gid, room, token, log);
    writeMeta(room.id, { repo: url, branch: room.branch || '' });
  }
  if (room.allowEdits) {
    // Don't let a crashed or stopped job's half-done edits be committed under the next agent's name.
    const st = await git(dir, ['status', '--porcelain'], { gid });
    if (st.out.trim()) {
      await git(dir, ['stash', 'push', '-u', '-m', `agent-huddle: leftover changes ${new Date().toISOString()}`], { gid });
      log(`(Set aside leftover uncommitted changes with git stash.)\n`);
    }
    // Pick up commits pushed from elsewhere so our push isn't rejected.
    const br = room.branch || (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { gid })).out.trim();
    if (br && br !== 'HEAD' && validBranch(br)) {
      const f = await git(dir, ['fetch', 'origin', '--', br], { gid, token });
      if (f.code === 0) { const m = await git(dir, ['merge', '--ff-only', 'FETCH_HEAD'], { gid }); if (m.code !== 0) log(`(Couldn't fast-forward to origin/${br}; continuing on the local copy.)\n`); }
    }
  }
  return { dir, gid };
}
async function checkoutBranch(dir, gid, room, token, log) {
  if (!room.branch) return;
  const f = await git(dir, ['fetch', 'origin', '--', room.branch], { gid, token });
  if (f.code === 0) await git(dir, ['checkout', '-B', room.branch, 'FETCH_HEAD'], { gid });
  else await git(dir, ['checkout', '-B', room.branch], { gid });
  log(`On branch ${room.branch}\n`);
}
async function commitAndPush(room, dir, gid, agentName, token, log) {
  sanitizeGit(dir, gid, room);
  await git(dir, ['add', '-A'], { gid });
  const st = await git(dir, ['status', '--porcelain'], { gid });
  if (st.out.trim()) {
    const c = await git(dir, ['commit', '-q', '-m', `${String(agentName).slice(0, 60)}: changes from Agent Huddle`], { gid });
    log(`\n$ git commit\n${c.out}`);
  }
  const branch = room.branch || (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], { gid })).out.trim();
  if (!validBranch(branch) || branch === 'HEAD') return '⚠️ Not on a branch, so nothing was pushed.';
  const ahead = await git(dir, ['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], { gid });
  if (ahead.code !== 0 || Number(ahead.out.trim()) > 0) {
    const p = await git(dir, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], { gid, token });
    log(`\n$ git push origin ${branch}\n${p.out}`);
    return p.code === 0 ? `Pushed to \`${branch}\`.` : `⚠️ Push to \`${branch}\` failed — see activity log.`;
  }
  return '';
}
async function discardChanges(room, dir, gid, log) {
  sanitizeGit(dir, gid, room);
  const st = await git(dir, ['status', '--porcelain'], { gid });
  if (st.out.trim()) {
    await git(dir, ['reset', '--hard', '-q'], { gid });
    await git(dir, ['clean', '-fdq', '-e', '.agenthuddle/'], { gid });
    log(`\n(Edits are off in this room, so these file changes were discarded:)\n${st.out}`);
  }
}

// Attached images go in .agenthuddle/attachments inside the workspace (git-ignored), written as ar-git.
function writeAttachments(dir, gid, list) {
  if (!list?.length) return;
  const base = path.join(dir, '.agenthuddle', 'attachments');
  const ops = [{ op: 'mkdir', path: base, mode: 0o2770 }];
  for (const a of list) {
    const file = path.join(dir, String(a.path || ''));
    if (!file.startsWith(base + path.sep) || typeof a.b64 !== 'string') continue;
    ops.push({ op: 'write', path: file, b64: a.b64, mode: 0o640 });
  }
  fileOps(gitUser(), ops, { gid });
}

// ---------- jobs ----------
async function callApi(api, prompt, env, signal, images = []) {
  const key = env[api.keyEnv];
  if (!key) throw new Error(`Add ${api.keyEnv} in Accounts to use API mode.`);
  let r, j;
  if (api.provider === 'anthropic') {
    r = await fetch(api.baseUrl || 'https://api.anthropic.com/v1/messages', { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: api.model, max_tokens: api.maxTokens || 4096, messages: [{ role: 'user', content: [
        ...images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.b64 } })), { type: 'text', text: prompt }] }] }) });
    j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
    return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  }
  if (api.provider === 'gemini') {
    r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${api.model}:generateContent`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [...images.map((i) => ({ inline_data: { mime_type: i.mime, data: i.b64 } })), { text: prompt }] }] }) });
    j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }
  r = await fetch(`${api.baseUrl || 'https://api.openai.com/v1'}/chat/completions`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: api.model, messages: [{ role: 'user', content: images.length
      ? [{ type: 'text', text: prompt }, ...images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.b64}` } }))]
      : prompt }] }) });
  j = await r.json(); if (!r.ok) throw new Error(j.error?.message || r.statusText);
  return j.choices?.[0]?.message?.content || '';
}


// Tokens each CLI may see (and nothing else of the user's).
const TOKEN_FOR = { claude: ['CLAUDE_CODE_OAUTH_TOKEN'], 'cursor-agent': ['CURSOR_API_KEY'] };
function agentEnv(cmd, given = {}) {
  const out = {};
  for (const k of TOKEN_FOR[cmd] || []) if (given[k]) out[k] = given[k];
  return out;
}

// macOS sandbox for agents in local mode: reads are allowed (agents need your tools and libraries),
// writes only to the room's folder, temp folders and the CLIs' own settings/cache folders, and
// Agent Huddle's data, SSH and cloud keys can't be read at all. Later rules win.
function sandboxProfile(workspace) {
  const q = (x) => `"${String(x).replace(/[\\"]/g, '\\$&')}"`;
  const re = (x) => String(x).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const H = os.homedir();
  const homeRe = `^${re(H)}/(\\.(claude|claude\\.json[^/]*|codex|gemini|antigravity[^/]*|grok|cursor|config|cache|local|npm|bun|agenthuddle)|Library/(Caches|Logs|Application Support/(Claude|Cursor|cursor-agent|Antigravity|antigravity[^/]*|Google|grok[^/]*|xai[^/]*)))(/|$)`;
  return [
    '(version 1)', '(allow default)', '(deny file-write*)',
    `(allow file-write* (subpath ${q(workspace)}) (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/dev") (regex #${q(homeRe)}))`,
    // Also the app's web storage (its sign-in cookie would let an agent approve its own requests).
    `(deny file-read* file-write* ${[...PRIVATE_PATHS, `${H}/.ssh`, `${H}/.aws`, `${H}/.gnupg`, `${H}/.config/gh`, `${H}/Library/WebKit`, `${H}/Library/HTTPStorages`, `${H}/Library/Cookies`].map((x) => `(subpath ${q(x)})`).join(' ')} (literal ${q(`${H}/.netrc`)}))`,
  ].join('\n');
}

// ---------- extra accounts ----------
// Claude Code and Codex have official settings for where their login lives (CLAUDE_CONFIG_DIR,
// CODEX_HOME); Grok keeps it in ~/.grok, so it gets its own HOME. On macOS Claude Code names its
// Keychain item after the config folder, so each account keeps a separate login there too.
const ACCOUNT_CMDS = ['claude', 'codex', 'grok'];
const validAccount = (a) => typeof a === 'string' && /^[a-z0-9-]{1,30}$/.test(a);
const accountHome = (user, account) => path.join(user.home, '.agenthuddle', 'accounts', account);
function accountEnv(cmd, user, account) {
  if (!account || !ACCOUNT_CMDS.includes(cmd) || !validAccount(account)) return {};
  const h = accountHome(user, account);
  if (cmd === 'claude') return { CLAUDE_CONFIG_DIR: path.join(h, '.claude') };
  if (cmd === 'codex') return { CODEX_HOME: path.join(h, '.codex') };
  return { HOME: h };
}
function prepareAccount(cmd, user, account) {
  const env = accountEnv(cmd, user, account);
  if (!Object.keys(env).length) return env;
  const h = accountHome(user, account);
  const dir = cmd === 'claude' ? path.join(h, '.claude') : cmd === 'codex' ? path.join(h, '.codex') : path.join(h, '.grok');
  fileOps(user, [{ op: 'mkdir', path: dir }]);
  // Claude Code reads its onboarding state from <config dir>/.claude.json; skip the first-run prompts.
  if (cmd === 'claude' && !fileOps(user, [{ op: 'read', path: path.join(dir, '.claude.json') }])[0])
    fileOps(user, [{ op: 'write', path: path.join(dir, '.claude.json'), b64: Buffer.from(JSON.stringify({ hasCompletedOnboarding: true })).toString('base64') }]);
  return env;
}
// ---------- in-chat approvals ----------
// "Ask in chat" rooms run Claude Code with --permission-prompt-tool pointing at approve-mcp.mjs.
// That helper posts each request to /approval/<token> (a token good for one running job only);
// the Hub sees it on the job, shows Approve / Deny in the chat, and answers with the runner secret.
const APPROVE_MCP = path.join(path.dirname(new URL(import.meta.url).pathname), 'approve-mcp.mjs');
const approvalTokens = new Map(); // token -> job id
function summarize(tool, input = {}) {
  const pick = input.command || input.file_path || input.path || input.url || input.pattern || '';
  const s = pick ? String(pick) : JSON.stringify(input);
  return s.length > 600 ? s.slice(0, 600) + '…' : s;
}
const jobLog = (job, t) => { job.out += t; if (job.out.length > 200000) job.out = job.out.slice(-100000); };
function settleApprovals(job, allow, message) {
  for (const a of job.approvals || []) a.resolve({ allow, message });
  if (job.approvals) job.approvals.length = 0;
}
const PRESET_CMD = { 'claude-login': 'claude', 'claude-status': 'claude', 'codex-login': 'codex', 'codex-status': 'codex', 'grok-login': 'grok' };

// Codex in an "Ask in chat" room: one turn through `codex app-server` (container/codex-app.mjs).
async function runCodexJob(job, spec, { user, env, ws, log }) {
  const argv = ['app-server', ...(spec.codexApp.extraArgs || [])];
  const [cmd, args] = SANDBOX ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile(ws.dir), 'codex', ...argv]] : ['codex', argv];
  log(`$ codex app-server (approvals in chat)\n`);
  const p = spawn(cmd, args, { ...asUser(user, { gid: ws.gid, env, cwd: ws.dir }), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  job.proc = p;
  p.stderr.on('data', (d) => log(stripAnsi(String(d))));
  p.stdin.on('error', () => {});
  const t = setTimeout(() => { job.stopped = true; killTree(p, 'SIGTERM'); setTimeout(() => killTree(p, 'SIGKILL'), 5000); }, (spec.timeoutSec || 900) * 1000);
  try {
    return await runCodexTurn(p, {
      prompt: spec.stdin || '', cwd: ws.dir, model: spec.codexApp.model || null, instructions: spec.codexApp.instructions || null, sandbox: spec.codexApp.sandbox || 'read-only', approvalPolicy: 'untrusted',
      images: (spec.attachments || []).map((a) => path.join(ws.dir, a.path)).filter((f) => fs.existsSync(f)),
      log: (s) => log(stripAnsi(String(s))),
      onApproval: ({ tool, summary }) => new Promise((resolve) => {
        if (job.stopped || job.approvals.length >= 5) return resolve({ allow: false });
        job.approvals.push({ id: crypto.randomUUID().slice(0, 8), tool, summary: summary.length > 600 ? summary.slice(0, 600) + '…' : summary, at: Date.now(), resolve });
      }),
    });
  } catch (e) {
    if (job.stopped) throw Object.assign(new Error('Stopped'), { stopped: true });
    throw e;
  } finally { clearTimeout(t); killTree(p, 'SIGKILL'); }
}

function startJob(spec) {
  const job = { id: spec.id, status: 'running', out: '', result: '', error: '', started: Date.now(), proc: null, ctrl: null, stopped: false, approvals: [], approvalToken: null };
  jobs.set(job.id, job);
  if (stoppedIds.has(spec.id)) job.stopped = true;
  const log = (s) => { job.out += s; if (job.out.length > 200000) job.out = job.out.slice(-100000); };
  const room = spec.room || {};
  const token = spec.gitToken || '';
  const isCli = spec.kind !== 'api';
  const editsRoom = !!(room.repo && room.allowEdits && isCli);
  const readOnly = !!(room.repo && !room.allowEdits && isCli);
  const stopped = () => Object.assign(new Error('Stopped'), { stopped: true });
  (async () => {
    let ws = null;
    try {
      if (job.stopped) throw stopped();
      if (!isCli) {
        // API agents don't run anything in the workspace; they just get the prompt and images.
        job.ctrl = new AbortController();
        const t = setTimeout(() => job.ctrl.abort(), (spec.timeoutSec || 900) * 1000);
        try { job.result = await callApi(spec.api, spec.prompt, spec.env || {}, job.ctrl.signal, spec.attachments || []); }
        catch (e) { if (e.name === 'AbortError') throw stopped(); throw e; }
        finally { clearTimeout(t); }
      } else {
        ws = await withRoomLock(room.id, () => ensureWorkspace(room, token, log));
        if (job.stopped) throw stopped();
        try { writeAttachments(ws.dir, ws.gid, spec.attachments); } catch (e) { log(`(couldn't save attached images: ${e.message})\n`); }
        const user = userFor(spec.command);
        const outfile = path.join(os.tmpdir(), `job-${crypto.randomUUID()}.txt`);
        const args = (spec.args || []).map((a) => String(a).replaceAll('{outfile}', outfile).replaceAll('{workspace}', ws.dir));
        if (spec.approval === 'ask' && spec.command === 'claude') {
          job.approvalToken = crypto.randomBytes(24).toString('base64url');
          approvalTokens.set(job.approvalToken, job.id);
          // The helper runs next to the runner, so it reaches it on 127.0.0.1.
          args.push('--mcp-config', JSON.stringify({ mcpServers: { agenthuddle: { command: process.execPath, args: [APPROVE_MCP], env: { AR_APPROVAL_URL: `http://127.0.0.1:${PORT}/approval/${job.approvalToken}` } } } }));
        }
        const acct = prepareAccount(spec.command, user, spec.account);
        // An extra account uses its own login only, never the main account's token.
        const env = { ...(spec.account ? {} : agentEnv(spec.command, spec.env)), ...(spec.command === 'agy' ? keyringEnv(user) : {}), ...acct, CI: '1', TERM: 'dumb', NO_COLOR: '1' };
        log(`$ ${spec.command} ${args.map((a) => (a.length > 60 ? a.slice(0, 57) + '…' : a)).join(' ')}\n`);
        // "Ask in chat" rooms run Codex through its app-server, so its approval requests come to the chat.
        if (spec.codexApp) job.result = await runCodexJob(job, spec, { user, env, ws, log });
        else job.result = await new Promise((resolve, reject) => {
          let p;
          const [cmd, argv] = SANDBOX ? ['/usr/bin/sandbox-exec', ['-p', sandboxProfile(ws.dir), spec.command, ...args]] : [spec.command, args];
          try { p = spawn(cmd, argv, { ...asUser(user, { gid: ws.gid, env, cwd: ws.dir }), detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
          catch (e) { return reject(new Error(e.message)); }
          job.proc = p;
          let stdout = '', settled = false;
          p.stdout.on('data', (d) => { stdout += d; if (stdout.length > 2e6) stdout = stdout.slice(-1e6); log(stripAnsi(String(d))); });
          p.stderr.on('data', (d) => log(stripAnsi(String(d))));
          p.stdin.on('error', () => {}); // the CLI may exit before reading all of the prompt
          p.on('error', (e) => { if (settled) return; settled = true; reject(new Error(e.code === 'ENOENT' ? `${spec.command} is not installed in the container.` : e.message)); });
          const t = setTimeout(() => { job.stopped = true; killTree(p, 'SIGTERM'); setTimeout(() => killTree(p, 'SIGKILL'), 5000); }, (spec.timeoutSec || 900) * 1000);
          const finish = (code) => {
            if (settled) return; settled = true;
            clearTimeout(t);
            killTree(p, 'SIGKILL'); // leftovers in its process group (background servers etc.)
            let res = '';
            const got = fileOps(user, [{ op: 'read', path: outfile, max: 4e6 }, { op: 'unlink', path: outfile }], { gid: ws.gid })[0];
            if (got) res = Buffer.from(got, 'base64').toString('utf8');
            if (!res.trim()) res = stripAnsi(stdout);
            if (job.stopped) return reject(Object.assign(stopped(), { partial: res }));
            if (code !== 0 && !res.trim()) return reject(new Error(`${spec.command} exited with code ${code}. See the activity log.\n\n${job.out.slice(-1200)}`));
            resolve(res);
          };
          p.on('close', finish);
          // A grandchild holding stdout open mustn't keep the job alive after the CLI itself exits.
          p.on('exit', (code) => setTimeout(() => { p.stdout.destroy(); p.stderr.destroy(); finish(code); }, 3000));
          if (spec.stdin != null) p.stdin.end(spec.stdin); else p.stdin.end();
        });
      }
      if (editsRoom) {
        const note = await withRoomLock(room.id, () => commitAndPush(room, ws.dir, ws.gid, spec.agentName || 'Agent', token, log));
        if (note) job.result = `${job.result.trim()}\n\n_${note}_`;
      }
      job.status = 'done';
    } catch (e) {
      job.status = e.stopped ? 'stopped' : 'error';
      job.error = e.message;
      job.result = e.partial || '';
    }
    if (readOnly && ws && fs.existsSync(path.join(ws.dir, '.git'))) {
      try { await withRoomLock(room.id, () => discardChanges(room, ws.dir, ws.gid, log)); } catch {}
    }
    if (job.approvalToken) approvalTokens.delete(job.approvalToken);
    settleApprovals(job, false, 'The agent finished or was stopped.');
    job.finished = Date.now();
    try { job.credsHash = credsHash(); } catch {}
    job.proc = null;
  })();
  return job;
}
setInterval(() => { // forget finished jobs after 30 min, stale stop requests after 10
  for (const [id, j] of jobs) if (j.finished && Date.now() - j.finished > 30 * 60e3) jobs.delete(id);
  for (const [id, t] of stoppedIds) if (Date.now() - t > 10 * 60e3) stoppedIds.delete(id);
}, 60e3);

// ---------- usage & models run each CLI as its own user ----------
configureUsage((cmd, env = {}) => {
  const u = userFor(cmd);
  const account = validAccount(env.AR_ACCOUNT) && ACCOUNT_CMDS.includes(cmd) ? env.AR_ACCOUNT : '';
  const home = account ? accountHome(u, account) : u.home;
  return {
    opts: asUser(u, { env: { ...agentEnv(cmd, env), ...(cmd === 'agy' ? keyringEnv(u) : {}), ...accountEnv(cmd, u, account), NO_COLOR: '1', TERM: 'dumb' } }),
    home,
    readFile: (rel) => { const r = fileOps(u, [{ op: 'read', path: path.join(home, rel) }])[0]; return r ? Buffer.from(r, 'base64').toString('utf8') : null; },
  };
});

// ---------- login console ----------
let con = null;
function startConsole(preset, command, env, account) {
  if (con?.proc) killTree(con.proc, 'SIGKILL');
  const user = consoleUser(preset);
  const me = con = { out: '', offset: 0, running: true, command, pending: '', links: [] };
  // `script` gives the CLI a pseudo-terminal so interactive logins work. The terminal is made
  // very wide so CLIs print sign-in links on one line instead of wrapping them mid-URL.
  const line = `stty cols 1000 rows 50 2>/dev/null; ${command}`;
  // Makes browser-login CLIs (agy, grok) print a URL to open on your phone/laptop instead of launching a
  // browser. Not needed on your own Mac, where they can simply open your browser.
  const remote = LOCAL ? {} : { NO_BROWSER: 'true', BROWSER: 'echo', SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22', SSH_CLIENT: '10.0.0.2 50000 22', SSH_TTY: '/dev/pts/0' };
  // The CLI gets a terminal: on the Mac from the app's own helper (macos/ahpty.c), because macOS's `script`
  // won't start without a terminal of its own; on Linux from util-linux `script`.
  const pty = process.env.AGENT_HUDDLE_PTY && fs.existsSync(process.env.AGENT_HUDDLE_PTY) ? process.env.AGENT_HUDDLE_PTY : null;
  const [ptyCmd, ptyArgs] = pty ? [pty, ['/bin/bash', '-lc', line]] : MAC ? ['script', ['-q', '/dev/null', '/bin/bash', '-lc', line]] : ['script', ['-qfec', line, '/dev/null']];
  const p = spawn(ptyCmd, ptyArgs, {
    ...asUser(user, { env: { ...(account ? {} : env), ...(preset === 'agy' ? keyringEnv(user) : {}), ...(PRESET_CMD[preset] ? prepareAccount(PRESET_CMD[preset], user, account) : {}), TERM: 'xterm-256color', COLUMNS: '1000', LINES: '50', ...remote } }),
    detached: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.stdin.on('error', () => {});
  me.proc = p;
  // Handlers use `me`, not the global: a replaced console's exit must not touch the new one.
  const add = (d) => {
    // Escape sequences can be split across chunks: hold back an unfinished one until the rest arrives.
    let text = me.pending + String(d); me.pending = '';
    const esc = text.lastIndexOf('\x1b');
    if (esc >= 0 && esc > text.length - 4096) {
      const tail = text.slice(esc);
      const done = /^\x1b\[[0-?]*[ -/]*[@-~]/.test(tail) || /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.test(tail) || /^\x1b[()][A-Za-z0-9]/.test(tail) || /^\x1b[^\[\]()]/.test(tail);
      if (!done) { me.pending = tail; text = text.slice(0, esc); }
    }
    // Clickable terminal links (OSC 8) carry the full URL even when the visible text wraps.
    for (const m of text.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https?:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g)) addLink(m[1]);
    const clean = stripAnsi(text);
    for (const m of clean.matchAll(/https?:\/\/[^\s"'<>]+/g)) addLink(m[0]);
    me.out += clean;
    if (me.out.length > 100000) { me.offset += me.out.length - 50000; me.out = me.out.slice(-50000); }
  };
  const addLink = (u) => {
    u = u.replace(/[).,;]+$/, '');
    if (u.length < 12 || me.links.some((x) => x === u || x.startsWith(u))) return;
    // Terms, privacy and help pages that CLIs print in their banners aren't sign-in links.
    if (/\/(terms|privacy|policies|legal|tos)\b|privacy-notice|support\.google\.com|\/docs?\b/i.test(u) && !/oauth|auth|login|signin|device|code=/i.test(u)) return;
    me.links = me.links.filter((x) => !u.startsWith(x)); // a longer copy of the same link replaces a cut-off one
    me.links.push(u); if (me.links.length > 10) me.links.shift();
  };
  // Decode as UTF-8 across chunk boundaries, so characters split between two reads don't turn into "�".
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stdout.on('data', add); p.stderr.on('data', add);
  p.on('close', (code) => { me.running = false; me.proc = null; add(`\n[exited with code ${code}]\n`); });
}


// ---------- http ----------
const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const body = (req) => new Promise((r) => { let b = '', n = 0; req.on('data', (d) => { n += d.length; if (n < 64e6) b += d; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); });
const authorized = (req) => {
  if (!SECRET) return true; // local development
  const got = Buffer.from(String(req.headers['x-runner-secret'] || ''));
  const want = Buffer.from(SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const which = (cmd) => { try { return execFileSync('/usr/bin/env', ['which', cmd], { encoding: 'utf8' }).trim(); } catch { return null; } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    // Approval requests from a job's own helper: no runner secret, just that job's token.
    const ap = p.match(/^\/approval\/([\w-]{20,64})$/);
    if (ap && req.method === 'POST') {
      const job = jobs.get(approvalTokens.get(ap[1]));
      if (!job || job.status !== 'running' || job.stopped) return send(res, 200, { allow: false, message: 'This job is no longer running.' });
      if (job.approvals.length >= 5) return send(res, 200, { allow: false, message: 'Too many approval requests waiting.' });
      const b = await body(req);
      const tool = String(b.tool || 'tool').slice(0, 80);
      const decision = await new Promise((resolve) => {
        const a = { id: crypto.randomUUID().slice(0, 8), tool, summary: summarize(tool, b.input), at: Date.now(), resolve };
        job.approvals.push(a);
        jobLog(job, `\n[waiting for approval] ${tool}: ${a.summary}\n`);
        req.on('close', () => { const i = job.approvals.indexOf(a); if (i >= 0) job.approvals.splice(i, 1); });
      });
      return send(res, 200, decision);
    }
    if (p === '/health') {
      return send(res, 200, { ok: true, restored, isolated: ISOLATED, local: LOCAL, sandbox: SANDBOX, uptime: process.uptime(), running: [...jobs.values()].filter((j) => j.status === 'running').length,
        clis: Object.fromEntries(['claude', 'codex', 'agy', 'grok', 'cursor-agent', 'git'].map((c) => [c, !!which(c)])) });
    }
    if (!authorized(req)) return send(res, 403, { error: 'forbidden' });
    if (p === '/restore' && req.method === 'POST') {
      const b = await body(req); importCreds(b.files); restored = true;
      await startKeyring(userFor('agy')).catch(() => false);
      return send(res, 200, { ok: true, hash: credsHash() });
    }
    if (p === '/creds' && req.method === 'GET') return send(res, 200, exportCreds());
    if (p === '/jobs' && req.method === 'POST') { const b = await body(req); if (!b.id || jobs.has(b.id)) return send(res, 200, { id: b.id }); startJob(b); return send(res, 200, { id: b.id }); }
    const am = p.match(/^\/jobs\/([\w-]+)\/approve$/);
    if (am && req.method === 'POST') {
      const j = jobs.get(am[1]); const b = await body(req);
      const a = j?.approvals.find((x) => x.id === b.reqId);
      if (!a) return send(res, 404, { error: 'That request is no longer waiting.' });
      j.approvals.splice(j.approvals.indexOf(a), 1);
      jobLog(j, `[${b.allow ? 'approved' : 'denied'} in chat] ${a.tool}\n`);
      a.resolve({ allow: !!b.allow, message: b.allow ? '' : (String(b.message || '').slice(0, 300) || 'Denied in Agent Huddle.') });
      return send(res, 200, { ok: true });
    }
    const m = p.match(/^\/jobs\/([\w-]+)(\/stop)?$/);
    if (m) {
      const j = jobs.get(m[1]);
      if (m[2] && req.method === 'POST') {
        if (!j) { stoppedIds.set(m[1], Date.now()); return send(res, 200, { ok: true, pending: true }); }
        j.stopped = true; j.ctrl?.abort();
        if (j.proc) { killTree(j.proc, 'SIGTERM'); const pr = j.proc; setTimeout(() => killTree(pr, 'SIGKILL'), 3000); }
        return send(res, 200, { ok: true });
      }
      if (!j) return send(res, 404, { error: 'unknown job' });
      return send(res, 200, { id: j.id, status: j.status, activity: j.out.slice(-4000), result: j.result, error: j.error, credsHash: j.credsHash || null, elapsed: (j.finished || Date.now()) - j.started,
        approvals: (j.approvals || []).map(({ id, tool, summary, at }) => ({ id, tool, summary, at })) });
    }
    const rm = p.match(/^\/rooms\/([a-z0-9-]{1,40})$/i);
    if (rm && req.method === 'DELETE') {
      for (const d of [rm[1], `${rm[1]}-chat`]) fs.rmSync(path.join(WORK, d), { recursive: true, force: true });
      fs.rmSync(path.join(META, `${rm[1]}.json`), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === '/console/start' && req.method === 'POST') { const b = await body(req); startConsole(String(b.preset || 'bash'), String(b.command), b.env || {}, validAccount(b.account) ? b.account : ''); return send(res, 200, { ok: true }); }
    if (p === '/console' && req.method === 'GET') {
      if (!con) return send(res, 200, { running: false, out: '', next: 0, links: [] });
      const since = Number(url.searchParams.get('since') || 0);
      const start = Math.max(0, since - con.offset);
      return send(res, 200, { running: con.running, command: con.command, out: con.out.slice(start), next: con.offset + con.out.length, links: con.links });
    }
    if (p === '/console/input' && req.method === 'POST') {
      const b = await body(req);
      if (!con?.proc) return send(res, 400, { error: 'console not running' });
      con.proc.stdin.write(b.raw ?? `${b.text ?? ''}\r`);
      return send(res, 200, { ok: true });
    }
    if (p === '/console/stop' && req.method === 'POST') { if (con?.proc) killTree(con.proc, 'SIGTERM'); return send(res, 200, { ok: true }); }
    if (p === '/usage' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, { usage: await readUsage(b.kinds || {}, b.env || {}), credsHash: credsHash() });
    }
    if (p === '/models' && req.method === 'POST') {
      const b = await body(req);
      return send(res, 200, await listModels(String(b.command || ''), b.env || {}));
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});
server.requestTimeout = 0; // approval requests wait for you (up to 15 minutes)
server.listen(PORT, HOST, () => console.log(`runner listening on ${HOST}:${PORT} (${ISOLATED ? 'isolated users' : LOCAL ? `local${SANDBOX ? ', sandboxed' : ''}` : 'single user'})`));
// The password store is started again after logins are restored, so it loads the saved keyring.
startKeyring(userFor('agy')).then((ok) => console.log(ok ? 'keyring ready' : 'no keyring available')).catch(() => {});
