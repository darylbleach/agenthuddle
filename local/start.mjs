#!/usr/bin/env node
// Agent Huddle on your Mac: starts the chat server (local/server.mjs, the same code as the Cloudflare
// Worker, with an encrypted database) and the agent runner, both on 127.0.0.1 only, plus the optional
// phone relay and keep-awake. The Mac app runs this, sends the secrets it keeps in the Keychain as
// the first line on stdin, and reads one line back: `READY {"url": …}`. Closing stdin stops everything.
//
//   node local/start.mjs     # by hand: secrets are then kept in a 0600 file instead (development only)
//   AGENT_HUDDLE_HOME=/tmp/ar node local/start.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MAC = process.platform === 'darwin';
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); // the app's files (inside the .app)
const HOME = process.env.AGENT_HUDDLE_HOME || (MAC ? path.join(os.homedir(), 'Library/Application Support/Agent Huddle') : path.join(os.homedir(), '.agenthuddle-local'));
// Two free ports next to each other, starting at 18787. Another copy of Agent Huddle (or an older build
// still running in the background) may hold them; connecting to it would fail to sign in.
const portFree = (port) => new Promise((res) => {
  const srv = net.createServer().once('error', () => res(false)).once('listening', () => srv.close(() => res(true)));
  srv.listen(port, '127.0.0.1');
});
let WEB_PORT = Number(process.env.AGENT_HUDDLE_PORT || 18787);
for (let i = 0; i < 20 && !((await portFree(WEB_PORT)) && (await portFree(WEB_PORT + 1))); i++) WEB_PORT += 2;
const RUNNER_PORT = WEB_PORT + 1;
const STATE = path.join(HOME, 'state'), WORK = path.join(HOME, 'work'), APP = path.join(HOME, 'app'), LOGS = path.join(HOME, 'logs');
const CONFIG = path.join(HOME, 'config.json');

const log = (...a) => console.error('[agent-huddle]', ...a);
for (const d of [HOME, STATE, WORK, LOGS]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
for (const d of [HOME, STATE]) fs.chmodSync(d, 0o700);

// ---------- settings (no secrets in here: those live in the Keychain) ----------
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch {}
if (cfg.keepAwake == null) cfg.keepAwake = true;
if (cfg.sandbox == null) cfg.sandbox = true;

// ---------- secrets: from the app (Keychain) on stdin, or a dev file when run by hand ----------
function firstLine(timeoutMs) {
  return new Promise((resolve) => {
    let buf = '';
    const done = (v) => { clearTimeout(t); process.stdin.off('data', onData); resolve(v); };
    const onData = (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) done(buf.slice(0, i)); };
    const t = setTimeout(() => done(null), timeoutMs);
    process.stdin.setEncoding('utf8'); process.stdin.on('data', onData);
  });
}
const tok = (n) => crypto.randomBytes(n).toString('base64url');
let secrets = null;
const line = process.stdin.isTTY ? null : await firstLine(3000);
if (line) { try { secrets = JSON.parse(line); } catch { log('could not read secrets from the app'); } }
if (!secrets) {
  const devFile = path.join(STATE, 'dev-secrets.json');
  try { secrets = JSON.parse(fs.readFileSync(devFile, 'utf8')); } catch {
    secrets = { password: tok(18), runnerSecret: tok(32), dbKey: crypto.randomBytes(32).toString('hex') };
    fs.writeFileSync(devFile, JSON.stringify(secrets), { mode: 0o600 });
  }
  log(`running without the app: secrets are in ${devFile} (not Keychain-protected)`);
}
if (!secrets.password || !secrets.runnerSecret || !/^[0-9a-f]{64}$/.test(secrets.dbKey || '')) { console.log('FAILED missing secrets'); process.exit(2); }

// ---------- the app's files: copied out of the .app so the app's signature stays intact ----------
const version = (dir) => { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { return ''; } };
if (SRC !== APP && (version(SRC) !== version(APP) || !version(SRC) || !fs.existsSync(path.join(APP, 'node_modules')))) {
  log('updating app files…');
  fs.rmSync(APP, { recursive: true, force: true });
  fs.cpSync(SRC, APP, { recursive: true, verbatimSymlinks: true, filter: (p) => !/(^|\/)(\.git|\.wrangler|macos\/build)(\/|$)/.test(p.slice(SRC.length)) });
}

// ---------- environment ----------
const nodeBin = path.dirname(process.execPath);
const H = os.homedir();
const PATH = [nodeBin, `${H}/.local/bin`, `${H}/.agenthuddle/npm/bin`, `${H}/.grok/bin`, `${H}/.antigravity/bin`, `${H}/.cursor/bin`,
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
const baseEnv = { PATH, HOME: H, USER: os.userInfo().username, LANG: process.env.LANG || 'en_GB.UTF-8', TMPDIR: process.env.TMPDIR || os.tmpdir() };

// ---------- child processes, restarted if they crash ----------
// Secrets go to children on file descriptor 3 (a pipe), never in their environment or arguments,
// because agents run as the same macOS user and could read those.
const kids = new Map();
let stopping = false;
function keep(name, cmd, args, opts, secret) {
  const logFile = fs.openSync(path.join(LOGS, `${name}.log`), 'a', 0o600);
  let fails = 0;
  const startOne = () => {
    if (stopping) return;
    const started = Date.now();
    const p = spawn(cmd, args, { ...opts, stdio: ['ignore', logFile, logFile, ...(secret ? ['pipe'] : [])], detached: true });
    if (secret) { p.stdio[3].on('error', () => {}); p.stdio[3].end(JSON.stringify(secret)); }
    kids.set(name, p);
    p.on('error', (e) => log(name, 'failed to start:', e.message));
    p.on('exit', (code, sig) => {
      kids.delete(name);
      if (stopping) return;
      fails = Date.now() - started > 60e3 ? 0 : fails + 1;
      const wait = Math.min(30e3, 1000 * 2 ** fails);
      log(`${name} stopped (${sig || code}); restarting in ${wait / 1000}s — see logs/${name}.log`);
      setTimeout(startOne, wait);
    });
  };
  startOne();
}

keep('runner', process.execPath, [path.join(APP, 'container/runner.mjs')], {
  cwd: WORK,
  env: { ...baseEnv, AGENT_HUDDLE_SECRET_FD: '3', PORT: String(RUNNER_PORT), AGENT_HUDDLE_LOCAL: '1', AGENT_HUDDLE_HOST: '127.0.0.1',
    AGENT_HUDDLE_WORK: WORK, AGENT_HUDDLE_SANDBOX: cfg.sandbox ? '1' : '0', AGENT_HUDDLE_PTY: path.join(SRC, 'bin/ahpty'), AGENT_HUDDLE_PRIVATE: [STATE, CONFIG, LOGS, APP + '/src'].join(':') },
}, { runnerSecret: secrets.runnerSecret });

keep('server', process.execPath, ['--no-warnings', path.join(APP, 'local/server.mjs')], {
  cwd: APP,
  env: { ...baseEnv, AR_PORT: String(WEB_PORT), AR_STATE: STATE, AR_RUNNER_URL: `http://127.0.0.1:${RUNNER_PORT}`, ...(process.env.AH_RELAY_URL ? { AH_RELAY_URL: process.env.AH_RELAY_URL } : {}), ...(process.env.AH_DEBUG ? { AH_DEBUG: "1" } : {}) },
}, { password: secrets.password, runnerSecret: secrets.runnerSecret, dbKey: secrets.dbKey });

// Phone relay: a Cloudflare Tunnel from your own address to this Mac. The token is written to a
// private file for cloudflared (agents can't read Agent Huddle's state folder).
if (secrets.relayToken) {
  const bin = [process.env.CLOUDFLARED, path.join(SRC, 'bin/cloudflared'), '/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((b) => b && fs.existsSync(b));
  const tokenFile = path.join(STATE, 'relay.token');
  fs.writeFileSync(tokenFile, secrets.relayToken, { mode: 0o600 });
  if (bin) keep('relay', bin, ['tunnel', '--no-autoupdate', 'run', '--token-file', tokenFile], { env: baseEnv });
  else log('relay: cloudflared not found');
} else { try { fs.unlinkSync(path.join(STATE, 'relay.token')); } catch {} }

// Keep the Mac awake while plugged in (caffeinate -s), for as long as Agent Huddle runs.
if (MAC && cfg.keepAwake) keep('awake', '/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { env: baseEnv });
secrets = null;

// ---------- ready / shutdown ----------
async function up(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); return r.status < 500; } catch { return false; } }
(async () => {
  const t0 = Date.now();
  while (!stopping) {
    if (await up(`http://127.0.0.1:${RUNNER_PORT}/health`) && await up(`http://127.0.0.1:${WEB_PORT}/manifest.webmanifest`)) {
      console.log(`READY ${JSON.stringify({ url: `http://127.0.0.1:${WEB_PORT}/`, relayHost: cfg.relayHost || null, home: HOME })}`);
      return;
    }
    if (Date.now() - t0 > 120e3) { console.log('FAILED the server did not start in 2 minutes — see the logs folder'); return; }
    await new Promise((r) => setTimeout(r, 300));
  }
})();

function shutdown() {
  if (stopping) return; stopping = true;
  for (const p of kids.values()) { try { process.kill(-p.pid, 'SIGTERM'); } catch {} }
  setTimeout(() => { for (const p of kids.values()) { try { process.kill(-p.pid, 'SIGKILL'); } catch {} } process.exit(0); }, 3000).unref();
  if (!kids.size) process.exit(0);
  const check = setInterval(() => { if (![...kids.values()].some((p) => p.exitCode == null && p.signalCode == null)) { clearInterval(check); process.exit(0); } }, 100);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown); process.on('SIGHUP', shutdown);
process.stdin.on('end', shutdown); process.stdin.on('error', shutdown); process.stdin.resume(); // the app quit
