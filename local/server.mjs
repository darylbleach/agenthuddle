// Agent Huddle's chat server for the Mac app: runs the same code as the Cloudflare Worker and its
// Durable Object (src/index.js) in plain Node.js, without Cloudflare's tools. The Durable Object
// APIs it uses are provided here: SQL storage (an encrypted SQLite file), alarms, WebSockets and
// static files. Started by local/start.mjs, which hands over the secrets on file descriptor 3.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createLink } from './link.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3-multiple-ciphers');
const { WebSocketServer } = require('ws');

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.AR_PORT || 18787);
const STATE = process.env.AR_STATE || path.join(APP, '.state');
const PUBLIC = path.join(APP, 'public');

// ---------- secrets (never in env or argv, where other processes could read them) ----------
let secrets = {};
try { secrets = JSON.parse(fs.readFileSync(3, 'utf8') || '{}'); } catch { console.error('server: no secrets on fd 3'); process.exit(2); }
if (!secrets.password || !secrets.runnerSecret || !/^[0-9a-f]{64}$/.test(secrets.dbKey || '')) { console.error('server: missing secrets'); process.exit(2); }

// ---------- storage: an encrypted SQLite database (SQLCipher, 256-bit key from the Keychain) ----------
fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
const db = new Database(path.join(STATE, 'agenthuddle.db'));
db.pragma(`cipher='sqlcipher'`);
db.pragma(`key="x'${secrets.dbKey}'"`);
db.prepare('SELECT count(*) FROM sqlite_master').get(); // fails here if the key is wrong
db.pragma('journal_mode = WAL');
db.pragma('secure_delete = ON');
delete secrets.dbKey;

const conv = (v) => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0)
  : v instanceof ArrayBuffer ? Buffer.from(v) : ArrayBuffer.isView(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v;
const cursor = (rows, written) => ({
  toArray: () => rows,
  one: () => { if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`); return rows[0]; },
  rowsWritten: written,
  [Symbol.iterator]: () => rows[Symbol.iterator](),
});
const stmts = new Map();
const sql = {
  exec(query, ...binds) {
    let st = stmts.get(query);
    if (!st) {
      try { st = db.prepare(query); }
      catch (e) {
        if (/more than one statement/i.test(e.message) && !binds.length) { db.exec(query); return cursor([], 0); }
        throw e;
      }
      if (stmts.size > 500) stmts.clear();
      stmts.set(query, st);
    }
    const b = binds.map(conv);
    if (st.reader) return cursor(st.all(...b), 0);
    return cursor([], st.run(...b).changes);
  },
};

// ---------- WebSockets: the Durable Object "hibernation" API on top of `ws` ----------
const sockets = new Set();
class SideSocket {
  constructor() { this.readyState = 1; this._tags = []; this._real = null; }
  send(data) { try { this._real?.send(data); } catch {} }
  close(code, reason) {
    this.readyState = 3; sockets.delete(this);
    try { if (code >= 3000 || code === 1000) this._real?.close(code, reason); else this._real?.close(); } catch {}
  }
}
globalThis.WebSocketPair = class { constructor() { const client = new SideSocket(), server = new SideSocket(); client._server = server; this[0] = client; this[1] = server; } };
// Workers return 101 responses carrying the socket; Node's Response can't have status 101.
const NodeResponse = globalThis.Response;
globalThis.Response = class extends NodeResponse {
  constructor(body, init) {
    if (init?.status === 101) { super(null, { status: 200 }); this._upgrade = init.webSocket; return; }
    super(body, init);
  }
};

// ---------- the Durable Object context ----------
let hub;
let alarmAt = null, alarmTimer = null, alarmRunning = false, alarmAgain = false;
async function runAlarm() {
  if (alarmRunning) { alarmAgain = true; return; }
  alarmRunning = true; alarmAt = null;
  try { await hub.alarm?.(); } catch (e) { console.error('alarm', e); }
  alarmRunning = false;
  if (alarmAgain) { alarmAgain = false; setTimeout(runAlarm, 0); }
}
const ctx = {
  id: { toString: () => 'main', name: 'main' },
  storage: {
    sql,
    setAlarm(t) { const when = Number(t instanceof Date ? t.getTime() : t); clearTimeout(alarmTimer); alarmAt = when; alarmTimer = setTimeout(runAlarm, Math.max(0, when - Date.now())); },
    getAlarm() { return alarmAt; },
    deleteAlarm() { clearTimeout(alarmTimer); alarmAt = null; },
  },
  blockConcurrencyWhile: async (fn) => fn(),
  waitUntil: (p) => { Promise.resolve(p).catch((e) => console.error('waitUntil', e)); },
  acceptWebSocket(ws, tags = []) { ws._tags = tags; sockets.add(ws); },
  getWebSockets(tag) { return [...sockets].filter((w) => !tag || w._tags.includes(tag)); },
  container: undefined,
};

// ---------- static files (the Worker's ASSETS binding) ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
const isFile = (f) => { try { return fs.statSync(f).isFile(); } catch { return false; } };
const ASSETS = {
  async fetch(req) {
    let p; try { p = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response('Bad path', { status: 400 }); }
    if (p.endsWith('/')) p += 'index.html';
    let f = path.join(PUBLIC, p);
    if (!f.startsWith(PUBLIC + path.sep)) return new Response('Not found', { status: 404 });
    if (!isFile(f) && isFile(f + '.html')) f += '.html';
    if (!isFile(f)) return new Response('Not found', { status: 404 });
    return new Response(fs.readFileSync(f), { headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' } });
  },
};

// ---------- load the Worker code with the shims in place ----------
globalThis.__agenthuddleShim = { DurableObject: class { constructor(c, e) { this.ctx = c; this.env = e; } } };
const src = fs.readFileSync(path.join(APP, 'src/index.js'), 'utf8')
  .replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*['"]cloudflare:workers['"];?/, 'const { DurableObject } = globalThis.__agenthuddleShim;');
const shimmed = path.join(APP, 'src', '.index.node.js');
fs.writeFileSync(shimmed, src);
const mod = await import(pathToFileURL(shimmed).href + `?v=${Date.now()}`);

const env = {
  APP_PASSWORD: secrets.password,
  DEV_RUNNER_URL: process.env.AR_RUNNER_URL || 'http://127.0.0.1:18788',
  DEV_RUNNER_SECRET: secrets.runnerSecret,
  LOCAL_MODE: '1',
  ASSETS,
  HUB: { getByName: () => ({ fetch: (req) => hub.fetch(req) }) },
};
hub = new mod.Hub(ctx, env);
setTimeout(runAlarm, 1000); // pick up jobs that were running before a restart

// ---------- phone access through the relay (local/link.mjs) ----------
db.exec('CREATE TABLE IF NOT EXISTS link_kv (k TEXT PRIMARY KEY, v TEXT)');
const kv = {
  get: (k) => { const r = db.prepare('SELECT v FROM link_kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : null; },
  set: (k, v) => db.prepare('INSERT INTO link_kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)),
};
const link = createLink({
  kv, port: PORT, relayUrl: (process.env.AH_RELAY_URL || 'https://app.agenthuddle.net').replace(/\/$/, ''),
  // The link's own sign-in to this server, used for requests that come from a paired phone.
  login: async () => {
    const r = await mod.default.fetch(new Request(`http://127.0.0.1:${PORT}/login`, { method: 'POST', headers: { host: `127.0.0.1:${PORT}`, 'user-agent': 'Agent Huddle phone link' }, body: JSON.stringify({ password: env.APP_PASSWORD }) }), env);
    const c = (r.headers.getSetCookie?.() || []).map((x) => /^ar=([^;]+)/.exec(x)?.[1]).find(Boolean);
    if (!c) throw new Error('local sign-in failed');
    return c;
  },
  local: {
    fetch: (req) => mod.default.fetch(req, env),
    async openSocket(p, cookie, real) {
      const r = await mod.default.fetch(new Request(`http://127.0.0.1:${PORT}${p}`, { headers: { host: `127.0.0.1:${PORT}`, cookie, upgrade: 'websocket', connection: 'Upgrade' } }), env);
      const side = r._upgrade?._server;
      if (!side) return null;
      side._real = real;
      return side;
    },
    socketMessage(side, d) { try { hub.webSocketMessage?.(side, d); } catch (e) { console.error('phone ws', e); } },
    closeSocket(side) { side.readyState = 3; sockets.delete(side); side._real = null; try { hub.webSocketClose?.(side, 1000, 'bye', true); } catch {} },
  },
});

// Notifications for paired phones (approvals, and replies if the person chose that).
env.NOTIFY = (n) => { link.api.notify(n).catch((e) => console.error('notify', e.message)); };

// The Mac app's "Phone" settings: only from this Mac (never through the relay), signed in, with the app's header.
async function phoneApi(req, res, body) {
  const sid = /(?:^|;\s*)ar=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const origin = req.headers.origin;
  if (!sid || !(await hub.session(decodeURIComponent(sid)))) return send(res, 401, { error: 'Not signed in' });
  if (req.method !== 'GET' && (req.headers['x-ar'] !== '1' || (origin && new URL(origin).host !== req.headers.host))) return send(res, 403, { error: 'Forbidden' });
  const p = req.url.split('?')[0];
  let b = {}; try { b = body?.length ? JSON.parse(body) : {}; } catch {}
  try {
    if (p === '/api/phone/status') return send(res, 200, link.api.status());
    if (p === '/api/phone/link' && req.method === 'POST') {
      try { return send(res, 200, await link.api.link({ email: String(b.email || ''), password: String(b.password || ''), create: !!b.create, name: String(b.name || '').slice(0, 60) })); }
      catch (e) { return send(res, 400, { error: e.message, unverified: !!e.unverified }); }
    }
    if (p === '/api/phone/notify' && req.method === 'POST') return send(res, 200, link.api.setNotify(String(b.mode || '')));
    if (p === '/api/phone/unlink' && req.method === 'POST') return send(res, 200, link.api.unlink());
    if (p === '/api/phone/pair' && req.method === 'POST') return send(res, 200, await link.api.startPairing());
    const m = p.match(/^\/api\/phone\/phones\/([\w-]+)$/);
    if (m && req.method === 'DELETE') return send(res, 200, link.api.removePhone(m[1]));
    return send(res, 404, { error: 'Not found' });
  } catch (e) { return send(res, 400, { error: e.message }); }
}
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

// ---------- HTTP ----------
function toRequest(req, body) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x)); else headers.set(k, v);
  }
  const url = `http://${req.headers.host || `127.0.0.1:${PORT}`}${req.url}`;
  return new Request(url, { method: req.method, headers, body: body && body.length ? body : undefined });
}
async function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > 25 * 1024 * 1024) throw Object.assign(new Error('Too large'), { status: 413 }); chunks.push(c); }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  try {
    const body = await readBody(req);
    if (/^\/api\/phone(\/|$)/.test(req.url)) return await phoneApi(req, res, body);
    const r = await mod.default.fetch(toRequest(req, body), env);
    const headers = {};
    r.headers.forEach((v, k) => { if (k !== 'set-cookie') headers[k] = v; });
    const cookies = r.headers.getSetCookie?.() || [];
    if (cookies.length) headers['set-cookie'] = cookies;
    const buf = r.body ? Buffer.from(await r.arrayBuffer()) : null;
    res.writeHead(r.status, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (e) {
    console.error('request', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(e.status || 500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.status ? e.message : 'Internal error' }));
  }
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  try {
    const r = await mod.default.fetch(toRequest(req, null), env);
    const side = r._upgrade?._server;
    if (!side) { socket.end(`HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] || ''}\r\nconnection: close\r\n\r\n`); return; }
    wss.handleUpgrade(req, socket, head, (real) => {
      side._real = real;
      real.on('message', (data, binary) => { try { hub.webSocketMessage?.(side, binary ? data : data.toString()); } catch (e) { console.error('ws message', e); } });
      real.on('close', (code, reason) => { side.readyState = 3; sockets.delete(side); try { hub.webSocketClose?.(side, code, reason.toString(), true); } catch {} });
      real.on('error', () => {});
    });
  } catch (e) { console.error('upgrade', e); socket.destroy(); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`server listening on 127.0.0.1:${PORT}`));

const stop = () => { link.stop(); server.close(); for (const s of sockets) s.close(1001, 'shutting down'); try { db.close(); } catch {} process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
