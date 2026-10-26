import { DurableObject } from 'cloudflare:workers';
import { DEFAULT_AGENTS, DEFAULT_SETTINGS, CLI_ENV, API_ENV, SECRET_NAMES, CONSOLE_COMMANDS, LOCAL_CONSOLE_COMMANDS, LOCAL_ONLY_COMMANDS, MODEL_FLAGS, credAllowed, validateAgent, validBranch, validRepo, MODEL_RE, ACCOUNT_CLIS, APPROVAL_MODES, approvalArgs } from './agents.js';

const INACTIVITY_MS = 15 * 60 * 1000; // container sleeps after 15 min with nothing to do
const POLL_MS = 1500;
const INSTANCE = 'standard-2';
const CRED_PASTE_PATHS = ['.codex/auth.json', '.grok/auth.json', '.claude/.credentials.json'];

// ---------------------------------------------------------------- auth
const enc = new TextEncoder();
async function hmacHex(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const SESSION_DAYS = 30; // renewed while in use
async function sha256Hex(text) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sessionCookie = (sid, days) => `ar=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.round(days * 86400)}`;
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.APP_PASSWORD) return new Response('Agent Huddle is not set up yet: set the APP_PASSWORD secret (npx wrangler secret put APP_PASSWORD).', { status: 500 });
    const hub = env.HUB.getByName('main');
    // Sessions live in the Durable Object: random ids, stored hashed, revocable, renewed while used.
    const internal = (path, data) => hub.fetch(new Request(`https://hub/__auth/${path}`, { method: 'POST', body: JSON.stringify(data) }));

    // The Mac app talks to its own server over plain http on 127.0.0.1, where a Secure cookie
    // wouldn't be kept; everywhere else (Cloudflare, the relay) is https.
    const host = req.headers.get('host') || url.host;
    const loopback = url.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host);
    const plainCookie = (res) => {
      if (!loopback) return res;
      const h = new Headers(res.headers); const c = h.get('set-cookie');
      if (c) h.set('set-cookie', c.replace(/; Secure/i, ''));
      return new Response(res.body, { status: res.status, headers: h });
    };
    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      return plainCookie(await internal('login', { password: String(body.password || '').slice(0, 500), ip: req.headers.get('cf-connecting-ip') || 'unknown', ua: (req.headers.get('user-agent') || '').slice(0, 200) }));
    }
    const sid = cookie(req, 'ar');
    if (url.pathname === '/logout') {
      if (sid) await internal('logout', { sid }).catch(() => {});
      return plainCookie(new Response(null, { status: 302, headers: { location: '/', 'set-cookie': sessionCookie('', 0) } }));
    }
    if (url.pathname.startsWith('/api/')) {
      if (!sid) return json({ error: 'Not signed in' }, 401);
      const origin = req.headers.get('origin');
      if (origin && ![url.host, host].includes(new URL(origin).host)) return json({ error: 'Bad origin' }, 403);
      if (req.method !== 'GET' && req.headers.get('x-ar') !== '1') return json({ error: 'Missing header' }, 403);
      const headers = new Headers(req.headers);
      headers.set('x-ar-session', sid); // the Durable Object checks it
      return hub.fetch(new Request(req, { headers }));
    }
    // App-install files must load before sign-in (phones fetch them without the session cookie).
    if (url.pathname === '/manifest.webmanifest' || url.pathname === '/sw.js' || url.pathname.startsWith('/icons/') || /^\/(terms|privacy)(\.html)?$/.test(url.pathname)) return env.ASSETS.fetch(req);
    const authed = sid ? !!(await internal('check', { sid }).then((r) => r.json()).catch(() => null))?.ok : false;
    if (!authed) {
      // Serve the sign-in page for every unauthenticated page request (assets map /login to login.html).
      return env.ASSETS.fetch(new Request(new URL('/login', url), { headers: req.headers }));
    }
    const res = await env.ASSETS.fetch(req);
    // Security headers on pages.
    const h = new Headers(res.headers);
    h.set('x-frame-options', 'DENY'); h.set('x-content-type-options', 'nosniff'); h.set('referrer-policy', 'no-referrer');
    h.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return new Response(res.body, { status: res.status, headers: h });
  },
};

// ---------------------------------------------------------------- Hub
// Where an attached image is written inside an agent's workspace (never committed: see runner).
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
function attachmentPath(f) { return `.agenthuddle/attachments/${f.id}.${EXT[f.mime] || 'img'}`; }
function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.activity = new Map(); // jobId -> last activity text
    this.approvals = new Map(); // jobId -> approval requests waiting in the chat
    this.decided = new Set(); // approval request ids you allowed or denied (the rest expired)
    this.starting = null;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if (ctx.container?.running) await ctx.container.setInactivityTimeout(INACTIVITY_MS).catch(() => {});
    });
  }

  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT, repo TEXT DEFAULT '', branch TEXT DEFAULT '', allow_edits INTEGER DEFAULT 0, created INTEGER, turn_runs INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, room_id TEXT, role TEXT, agent_id TEXT, mode TEXT, text TEXT, status TEXT, depth INTEGER, ts INTEGER, elapsed INTEGER, activity TEXT);
      CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, ts);
      CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, room_id TEXT, agent_id TEXT, depth INTEGER, route INTEGER, chain TEXT, status TEXT, started INTEGER);
      CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, room_id TEXT, msg_id TEXT, name TEXT, mime TEXT, size INTEGER, data BLOB, ts INTEGER);
      CREATE INDEX IF NOT EXISTS files_room ON files(room_id, ts);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created INTEGER, expires INTEGER, seen INTEGER, ua TEXT, ip TEXT);
      CREATE TABLE IF NOT EXISTS login_fail (ip TEXT, ts INTEGER);
      CREATE TABLE IF NOT EXISTS record (seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT, ts INTEGER, kind TEXT, actor TEXT, target TEXT, msg_id TEXT, ref_id TEXT, detail TEXT);
      CREATE INDEX IF NOT EXISTS record_room ON record(room_id, seq);
      CREATE INDEX IF NOT EXISTS record_ref ON record(ref_id);
      CREATE INDEX IF NOT EXISTS record_msg ON record(msg_id);
    `);
    // Columns added after launch (replies and attachments).
    for (const col of ['reply_to TEXT', 'files TEXT', 'started INTEGER']) { try { this.sql.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch {} }
    try { this.sql.exec(`ALTER TABLE rooms ADD COLUMN approvals TEXT DEFAULT 'ask'`); } catch {}
    try { this.sql.exec(`ALTER TABLE rooms ADD COLUMN rules TEXT DEFAULT '[]'`); } catch {}
    if (!this.sql.exec('SELECT id FROM rooms LIMIT 1').toArray().length) this.createRoom('General');
  }

  // ---------- kv / config ----------
  kvGet(k, def) { const r = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0]; return r ? JSON.parse(r.v) : def; }
  kvSet(k, v) { this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v)); }
  get settings() { return { ...DEFAULT_SETTINGS, ...this.kvGet('settings', {}) }; }
  get agents() {
    const list = this.kvGet('agents', null) || structuredClone(DEFAULT_AGENTS);
    // Fixes for agent lists saved before a default changed.
    for (const a of list) {
      if (a.cli?.command === 'cursor-agent' && !(a.cli.args || []).includes('--trust')) a.cli.args = [...(a.cli.args || []), '--trust'];
      if (a.cli && !a.cli.modelFlag && MODEL_FLAGS[a.cli.command]) a.cli.modelFlag = MODEL_FLAGS[a.cli.command];
      if (a.cli) {
        // Older lists put "--model {model}" in args; the model is now added separately.
        const i = (a.cli.args || []).indexOf('{model}');
        if (i > 0 && a.cli.args[i - 1] === a.cli.modelFlag) { a.cli.args = a.cli.args.filter((_, j) => j !== i && j !== i - 1); if (a.cli.model === 'grok') a.cli.model = ''; }
        if (a.cli.model == null) a.cli.model = '';
        // Headless CLIs can't ask for approval: give read-only rooms the auto-approve flag (the runner
        // discards file changes and withholds the GitHub token in those rooms).
        if (!a.cli.readArgsV && !(a.cli.readArgs || []).length) { a.cli.readArgsV = 1; const d = DEFAULT_AGENTS.find((x) => x.cli?.command === a.cli.command); if (d?.cli?.readArgs?.length) a.cli.readArgs = [...d.cli.readArgs]; }
      }
    }
    return list;
  }
  agent(id) { return this.agents.find((a) => a.id === id); }
  enabledAgents() { return this.agents.filter((a) => a.enabled); }
  get secrets() { return this.kvGet('secrets', {}); }
  get credFiles() { return Object.fromEntries(Object.entries(this.kvGet('credFiles', {})).filter(([k]) => credAllowed(k))); }

  publicAgents() {
    const secrets = this.secrets, files = this.credFiles, usage = this.kvGet('usage', {});
    return this.agents.map((a) => {
      const l = a.login || {};
      const account = a.cli?.account || '';
      const pre = account ? `.agenthuddle/accounts/${account}/` : ''; // an extra account's saved login files
      const hasLogin = (!account && !!(l.secret && secrets[l.secret])) || (l.files || []).some((f) => files[pre + f]) || (l.dirs || []).some((d) => Object.keys(files).some((k) => k.startsWith(pre + d + '/')));
      // A saved login file isn't proof: if the CLI itself last said it's signed out, show that.
      // On the Mac (local mode) logins live in the CLIs themselves, so go by what each CLI last reported.
      // A usage read that failed for another reason (e.g. the CLI's quota command changed) isn't a sign-out.
      const u = usage[a.id];
      const signedIn = this.local
        ? ['ok', 'unavailable'].includes(u?.status) || (u?.status === 'error' && !/not installed|isn’t installed/i.test(u.error || ''))
        : hasLogin && u?.status !== 'needs-login';
      return {
        id: a.id, name: a.name, color: a.color, enabled: a.enabled, mode: a.mode, note: a.note || '', aliases: a.aliases || [],
        cliCommand: a.cli?.command || null, account, cliModel: a.cli ? (a.cli.model || '') : null, canPickModel: !!a.cli?.modelFlag, signedIn,
        apiAvailable: !!a.api, apiModel: a.api?.model || null, apiKeyEnv: a.api?.keyEnv || null, apiKeySet: !!(a.api && secrets[a.api.keyEnv]),
      };
    });
  }

  // ---------- rooms & messages ----------
  createRoom(name, repo = '', branch = '') {
    const id = crypto.randomUUID().slice(0, 8);
    this.sql.exec('INSERT INTO rooms (id, name, repo, branch, created) VALUES (?, ?, ?, ?, ?)', id, name, repo, branch, Date.now());
    return id;
  }
  room(id) { return this.sql.exec('SELECT * FROM rooms WHERE id = ?', id).toArray()[0]; }
  roomSummary(r) {
    const busy = this.sql.exec('SELECT COUNT(*) AS n FROM jobs WHERE room_id = ?', r.id).one().n > 0;
    return { id: r.id, name: r.name, repo: r.repo, branch: r.branch, allowEdits: !!r.allow_edits, approvals: APPROVAL_MODES.includes(r.approvals) ? r.approvals : 'ask', rules: this.roomRules(r).length, busy };
  }
  roomList() { return this.sql.exec('SELECT * FROM rooms ORDER BY created').toArray().map((r) => this.roomSummary(r)); }
  msgObj(m) {
    let files = []; try { files = m.files ? JSON.parse(m.files) : []; } catch {}
    return { id: m.id, roomId: m.room_id, role: m.role, agentId: m.agent_id, mode: m.mode, text: m.text, status: m.status, depth: m.depth, ts: m.ts, elapsed: m.elapsed, activity: m.activity || this.activity.get(m.id) || '', replyTo: m.reply_to || null, started: m.started || null, approvals: this.approvals?.get(m.id) || [], files, ...(m.role === 'agent' ? this.provenance(m.id) : {}) };
  }
  msg(id) { const m = this.sql.exec('SELECT * FROM messages WHERE id = ?', id).toArray()[0]; return m && this.msgObj(m); }
  addMessage(m) {
    this.sql.exec('INSERT INTO messages (id, room_id, role, agent_id, mode, text, status, depth, ts, elapsed, activity, reply_to, files) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      m.id, m.roomId, m.role, m.agentId || null, m.mode || null, m.text || '', m.status || null, m.depth || 0, m.ts || Date.now(), null, null, m.replyTo || null, m.files?.length ? JSON.stringify(m.files) : null);
    this.broadcast('message', this.msg(m.id));
  }
  updateMessage(id, fields) {
    const cols = Object.keys(fields);
    this.sql.exec(`UPDATE messages SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...cols.map((c) => fields[c]), id);
    const m = this.msg(id); if (m) this.broadcast('update', m);
  }
  system(roomId, text) { this.addMessage({ id: crypto.randomUUID(), roomId, role: 'system', text }); }

  // ---------- websockets ----------
  broadcast(type, data) {
    const s = JSON.stringify({ type, data });
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch {} }
  }
  webSocketMessage(ws, msg) { if (msg === 'ping') ws.send('{"type":"pong"}'); }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch {} }
  pushRooms() { this.broadcast('rooms', this.roomList()); }

  // ---------- container ----------
  // DEV_RUNNER_URL (local testing only) points at a runner started with `node container/runner.mjs`.
  get local() { return this.env.LOCAL_MODE === '1'; }
  isRunning() { return this.env.DEV_RUNNER_URL ? true : !!this.ctx.container?.running; }
  async cfetch(path, init = {}) {
    const target = this.env.DEV_RUNNER_URL ? { fetch: (u, i) => fetch(u.replace('http://container', this.env.DEV_RUNNER_URL), i) } : this.ctx.container.getTcpPort(8080);
    const res = await target.fetch(`http://container${path}`, {
      ...init, headers: { 'content-type': 'application/json', 'x-runner-secret': this.runnerSecret }, body: init.body && typeof init.body !== 'string' ? JSON.stringify(init.body) : init.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `container ${res.status}`), { status: res.status });
    return data;
  }
  // A random secret given to the container at start; the runner refuses requests without it.
  get runnerSecret() {
    if (this.env.DEV_RUNNER_URL) return this.env.DEV_RUNNER_SECRET || '';
    let s = this.kvGet('runnerSecret', null);
    if (!s) { s = randomToken(); this.kvSet('runnerSecret', s); }
    return s;
  }
  ensureContainer() {
    if (this.ready && this.isRunning() && !this.starting) return Promise.resolve();
    this.starting ??= this.startContainer().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startContainer() {
    const c = this.ctx.container;
    if (!c && !this.env.DEV_RUNNER_URL) throw new Error('No container configured');
    // Every step has a time limit: a container start that silently fails must not leave
    // "starting…" hanging forever (it blocks every later request that needs the container).
    const limit = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} timed out`)), ms))]);
    let startErr = null;
    const kick = () => {
      if (!c || c.running) return;
      this.ready = false;
      try { const p = c.start({ image: c.images.base, instance: INSTANCE, enableInternet: true, env: { RUNNER_SECRET: this.runnerSecret } }); p?.catch?.((e) => { startErr = e; }); }
      catch (e) { startErr = e; }
      this.broadcast('container', { running: true, starting: true });
    };
    kick();
    if (c) await limit(c.setInactivityTimeout(INACTIVITY_MS), 10000, 'Setting the sleep timer').catch(() => {});
    let health, lastErr;
    const deadline = Date.now() + 6 * 60e3;
    for (let i = 0; Date.now() < deadline; i++) {
      try { health = await limit(this.cfetch('/health', { signal: AbortSignal.timeout(3000) }), 4000, 'Health check'); break; }
      catch (e) { lastErr = startErr || e; }
      if (c && !c.running && i % 8 === 7) kick(); // the start didn't take — ask again
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!health) {
      this.broadcast('container', { running: !!c?.running });
      throw new Error(`Container did not start: ${lastErr?.message || 'no answer'}`);
    }
    if (!health.restored) {
      const r = await limit(this.cfetch('/restore', { method: 'POST', body: { files: this.credFiles } }), 60000, 'Restoring logins');
      this.kvSet('credsHash', r.hash);
    }
    this.broadcast('container', { running: true, clis: health.clis });
    if (!this.ready) { this.ready = true; setTimeout(() => this.afterStart(), 0); }
    return health;
  }
  async syncCreds() {
    if (!this.isRunning()) return;
    const r = await this.cfetch('/creds');
    const hash = r.hash, files = Object.fromEntries(Object.entries(r.files || {}).filter(([k]) => credAllowed(k)));
    if (hash !== this.kvGet('credsHash', null)) {
      this.kvSet('credFiles', files); this.kvSet('credsHash', hash);
      this.broadcast('agents', this.publicAgents());
      // A login just changed: re-check anyone who was signed out, and reload their model lists.
      const u = this.kvGet('usage', {});
      const out = this.agents.filter((a) => a.cli && u[a.id]?.status === 'needs-login').map((a) => a.id);
      if (out.length) { this.refreshUsage(out); this.refreshModels(out, true); }
    }
  }

  // ---------- usage & models ----------
  usageKinds(ids) {
    const kinds = {};
    for (const a of this.agents) if (a.cli && (!ids || ids.includes(a.id))) kinds[a.id] = a.cli.account ? `${a.cli.command}@${a.cli.account}` : a.cli.command;
    return kinds;
  }
  cliEnv() { const s = this.secrets; return Object.fromEntries(CLI_ENV.filter((n) => s[n] && n !== 'GITHUB_TOKEN').map((n) => [n, s[n]])); }
  // Usage reads run in the background: the page gets 'usageStatus' while they run and a 'usage'
  // broadcast as each agent's numbers arrive, so a slow container start never leaves it hanging.
  usageState() { return { reading: [...(this.usageReading ??= new Set())], phase: this.usagePhase || null }; }
  refreshUsage(ids) {
    const targets = Object.keys(this.usageKinds(ids)).filter((id) => !(this.usageReading ??= new Set()).has(id));
    if (!targets.length) return this.usageState();
    for (const id of targets) this.usageReading.add(id);
    this.usagePhase = this.isRunning() && !this.starting ? 'reading' : 'starting';
    this.broadcast('usageStatus', this.usageState());
    this.ctx.waitUntil(this.runUsage(targets));
    return this.usageState();
  }
  async runUsage(targets) {
    try {
      await this.ensureContainer();
      this.usagePhase = 'reading'; this.broadcast('usageStatus', this.usageState());
      await Promise.all(targets.map(async (id) => {
        let snap;
        try {
          const r = await this.cfetch('/usage', { method: 'POST', body: { kinds: this.usageKinds([id]), env: this.cliEnv() }, signal: AbortSignal.timeout(120000) });
          snap = r.usage?.[id];
          if (r.credsHash && r.credsHash !== this.kvGet('credsHash', null)) await this.syncCreds().catch(() => {});
        } catch (e) { snap = { status: 'error', error: e.name === 'TimeoutError' ? 'Timed out reading usage.' : e.message, at: new Date().toISOString() }; }
        if (snap) { const all = { ...this.kvGet('usage', {}), [id]: snap }; this.kvSet('usage', all); this.broadcast('usage', all); }
        this.usageReading.delete(id); this.broadcast('usageStatus', this.usageState());
      }));
    } catch (e) {
      const all = this.kvGet('usage', {}), at = new Date().toISOString();
      for (const id of targets) all[id] = { ...(all[id] || {}), status: all[id]?.status === 'needs-login' || all[id]?.windows ? all[id].status : 'error', error: all[id]?.status === 'needs-login' ? all[id].error : `Agent computer didn’t start: ${e.message}`, at: all[id]?.at || at };
      this.kvSet('usage', all); this.broadcast('usage', all);
    } finally {
      for (const id of targets) this.usageReading.delete(id);
      if (!this.usageReading.size) this.usagePhase = null;
      this.broadcast('usageStatus', this.usageState());
      this.broadcast('agents', this.publicAgents());
    }
  }
  maybeRefreshUsage(agentId) {
    const u = this.kvGet('usage', {})[agentId];
    if (u?.at && Date.now() - Date.parse(u.at) < 5 * 60e3) return;
    this.refreshUsage([agentId]);
  }

  // ---------- GitHub (for the repo picker) ----------
  async gh(path) {
    const tok = this.secrets.GITHUB_TOKEN;
    if (!tok) throw Object.assign(new Error('Add a GitHub token in Accounts → API keys to list your repos.'), { status: 400 });
    const r = await fetch(`https://api.github.com${path}`, { headers: { authorization: `Bearer ${tok}`, accept: 'application/vnd.github+json', 'user-agent': 'agent-huddle', 'x-github-api-version': '2022-11-28' } });
    if (r.status === 401) throw Object.assign(new Error('GitHub rejected the saved token — replace it in Accounts → API keys.'), { status: 400 });
    if (!r.ok) throw Object.assign(new Error(`GitHub said ${r.status}`), { status: 502 });
    return { data: await r.json(), next: /rel="next"/.test(r.headers.get('link') || '') };
  }
  async githubRepos(refresh) {
    const c = this.ghRepoCache;
    if (!refresh && c && Date.now() - c.at < 10 * 60e3) return c;
    const repos = [];
    for (let page = 1; page <= 10; page++) {
      const { data, next } = await this.gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      for (const r of data) repos.push({ name: r.full_name, private: r.private, branch: r.default_branch, pushed: r.pushed_at, description: (r.description || '').slice(0, 120), archived: r.archived });
      if (!next) break;
    }
    this.ghRepoCache = { repos, at: Date.now() };
    return this.ghRepoCache;
  }
  async githubBranches(repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return { branches: [] };
    const branches = [];
    for (let page = 1; page <= 3; page++) {
      const { data, next } = await this.gh(`/repos/${repo}/branches?per_page=100&page=${page}`);
      branches.push(...data.map((b) => b.name));
      if (!next) break;
    }
    const def = this.ghRepoCache?.repos.find((r) => r.name === repo)?.branch;
    if (def && branches.includes(def)) branches.sort((a, b) => (a === def ? -1 : b === def ? 1 : 0));
    return { branches, default: def || null };
  }

  // Model lists: [{id,label}] per CLI, cached for 12h, refreshed in the background.
  modelsByAgent() {
    const out = {};
    for (const a of this.agents) if (a.cli) out[a.id] = { ...(this.kvGet(`models:${a.cli.command}`, null) || { models: [] }), loading: !!this.modelsLoading?.has(a.cli.command) };
    return out;
  }
  refreshModels(ids, force) {
    const cmds = new Set();
    for (const a of this.agents) {
      if (!a.cli || (ids && !ids.includes(a.id))) continue;
      const c = this.kvGet(`models:${a.cli.command}`, null);
      const fresh = c?.models?.length ? (c.models[0]?.label && Date.now() - c.at < 12 * 3600e3) : (c && Date.now() - c.at < 10 * 60e3);
      if (force || !fresh) cmds.add(a.cli.command);
    }
    this.modelsLoading ??= new Set();
    const todo = [...cmds].filter((c) => !this.modelsLoading.has(c));
    if (!todo.length) return this.modelsByAgent();
    for (const c of todo) this.modelsLoading.add(c);
    this.broadcast('models', this.modelsByAgent());
    this.ctx.waitUntil((async () => {
      try { await this.ensureContainer(); } catch (e) { for (const c of todo) this.modelsLoading.delete(c); this.broadcast('models', this.modelsByAgent()); return; }
      await Promise.all(todo.map(async (cmd) => {
        try {
          const r = await this.cfetch('/models', { method: 'POST', body: { command: cmd, env: { ...this.cliEnv(), ...(cmd === 'claude' && this.secrets.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: this.secrets.ANTHROPIC_API_KEY } : {}) } }, signal: AbortSignal.timeout(90000) });
          const prev = this.kvGet(`models:${cmd}`, null);
          const entry = { models: r.models?.length ? r.models : (prev?.models || []), source: r.source || prev?.source || null, error: r.error || null, at: Date.now() };
          this.kvSet(`models:${cmd}`, entry);
        } catch (e) {
          const prev = this.kvGet(`models:${cmd}`, null) || { models: [] };
          this.kvSet(`models:${cmd}`, { ...prev, error: e.message, at: prev.at || 0 });
        }
        this.modelsLoading.delete(cmd);
        this.broadcast('models', this.modelsByAgent());
      }));
    })());
    return this.modelsByAgent();
  }
  // Once the container is up, top up anything stale so the pickers and usage are ready.
  afterStart() {
    try { this.refreshModels(null, false); } catch {}
    const u = this.kvGet('usage', {});
    const stale = this.agents.filter((a) => a.cli && a.mode === 'cli' && (!u[a.id]?.at || Date.now() - Date.parse(u[a.id].at) > 10 * 60e3)).map((a) => a.id);
    if (stale.length) this.refreshUsage(stale);
  }

  // ---------- prompt ----------
  // ---------- rules: everywhere (settings) and per room; each for all agents or one agent ----------
  globalRules() { const r = this.kvGet('rules', []); return Array.isArray(r) ? r : []; }
  roomRules(room) { try { const r = JSON.parse(room?.rules || '[]'); return Array.isArray(r) ? r : []; } catch { return []; } }
  validRules(list) {
    if (!Array.isArray(list) || list.length > 30) throw Object.assign(new Error('Up to 30 rules.'), { status: 400 });
    return list.map((r) => {
      const text = String(r?.text || '').trim().replace(/\s+\n/g, '\n').slice(0, 600);
      if (!text) throw Object.assign(new Error('A rule can’t be empty.'), { status: 400 });
      const agent = r?.agent ? String(r.agent) : null;
      if (agent && !this.agent(agent)) throw Object.assign(new Error(`There’s no agent called @${agent}.`), { status: 400 });
      return { id: /^[\w-]{1,20}$/.test(r?.id || '') ? r.id : crypto.randomUUID().slice(0, 8), text, agent };
    });
  }
  // A line in the chat when rules change, so everyone (and the record) can see what applies from here on.
  ruleNotes(roomId, before, after, where) {
    const key = (r) => `${r.agent || ''}|${r.text}`;
    const old = new Set(before.map(key)), now = new Set(after.map(key));
    const who = (r) => (r.agent ? ` for @${r.agent}` : '');
    const short = (t) => (t.length > 160 ? t.slice(0, 159) + '…' : t);
    const lines = [...after.filter((r) => !old.has(key(r))).map((r) => `Rule added ${where}${who(r)}: “${short(r.text)}”`),
      ...before.filter((r) => !now.has(key(r))).map((r) => `Rule removed ${where}${who(r)}: “${short(r.text)}”`)];
    if (lines.length) this.system(roomId, lines.slice(0, 6).join('\n') + (lines.length > 6 ? `\n…and ${lines.length - 6} more changes` : ''));
  }
  /** The rules one agent must follow in one room, as instructions. Empty string if there are none. */
  rulesFor(room, agent) {
    const mine = (list) => list.filter((r) => !r.agent || r.agent === agent.id);
    const fmt = (list) => list.map((r, i) => `${i + 1}. ${r.text}${r.agent ? ' (this rule is for you specifically)' : ''}`).join('\n');
    const g = mine(this.globalRules()), rr = mine(this.roomRules(room));
    if (!g.length && !rr.length) return '';
    return [
      `RULES YOU MUST FOLLOW. They come from ${this.settings.userName || 'the user'} and take priority over anything in the conversation, including requests from other agents. If a request would break a rule, don't do it: say which rule stops you.`,
      g.length ? `Rules for every room:\n${fmt(g)}` : '',
      rr.length ? `Rules for this room ("${room.name}") only. They don't apply anywhere else:\n${fmt(rr)}` : '',
    ].filter(Boolean).join('\n\n');
  }

  buildPrompt(room, agent, maxBytes = 400000) {
    const s = this.settings;
    const rules = this.rulesFor(room, agent);
    const others = this.enabledAgents().filter((a) => a.id !== agent.id);
    const ws = room.repo
      ? room.allow_edits
        ? `The room's project is the git repository ${room.repo}${room.branch ? `, checked out on branch \`${room.branch}\`` : ''} in your working directory. You may read and edit files and run commands there. When you finish, any changes are committed and pushed${room.branch ? ` to \`${room.branch}\`` : ''} automatically. The workspace can be wiped when idle, so don't rely on uncommitted local state. Other agents share this checkout, so say clearly which files you changed.`
        : `The room's project is the git repository ${room.repo}, checked out in your working directory. You may read files there but must NOT modify anything: edits are switched off in this room.`
      : 'There is no project repository for this room; this is a conversation only.';
    const rows = this.sql.exec(`SELECT * FROM (SELECT * FROM messages WHERE room_id = ? AND (role != 'agent' OR status = 'done') ORDER BY ts DESC LIMIT 400) ORDER BY ts`, room.id).toArray();
    const who = (m) => (m.role === 'user' ? (s.userName || 'User') : m.role === 'system' ? 'System' : this.agent(m.agent_id)?.name || m.agent_id);
    const byId = new Map(rows.map((m) => [m.id, m]));
    let t = rows.map((m) => {
      let head = `[${who(m)}]`;
      const q = m.reply_to && (byId.get(m.reply_to) || this.sql.exec('SELECT * FROM messages WHERE id = ?', m.reply_to).toArray()[0]);
      if (q) head += ` (replying to ${who(q)}: "${String(q.text || '').replace(/\s+/g, ' ').slice(0, 200)}${(q.text || '').length > 200 ? '…' : ''}")`;
      let files = []; try { files = m.files ? JSON.parse(m.files) : []; } catch {}
      const att = files.map((f) => `\n[attached image "${f.name}": ${attachmentPath(f)}]`).join('');
      return `${head}: ${m.text}${att}`;
    }).join('\n\n');
    if (t.length > s.historyChars) t = '…(earlier messages trimmed)…\n\n' + t.slice(-s.historyChars);
    // Prompts passed as a command-line argument must stay well under the OS limit (~128 KB).
    while (enc.encode(t).length > maxBytes - 6000 && t.length > 1000) t = '…(earlier messages trimmed)…\n\n' + t.slice(Math.floor(t.length * 0.15));
    return `You are ${agent.name}, one of several AI agents in a shared group chat room called "${room.name}" with the human user ${s.userName || '(name not set)'}.
Other agents in the room: ${others.map((a) => `${a.name} (@${a.id})`).join(', ') || 'none'}.
${ws}

${rules ? `${rules}\n\n` : ''}How this chat works:
- Reply only as yourself, in plain Markdown. Do not prefix your reply with your name.
- Be concise; this is a chat, not a report. Everyone can see everything you write.
- To hand work to, or ask something of, another agent, @mention them (for example @${others[0]?.id || 'claude'}). Only @mention an agent when you want them to respond now — every mention triggers them.
- If you are reviewing or building on another agent's work, refer to it specifically.
- When a message is "replying to" an earlier one, answer in that context.
- Attached images are saved as files at the paths shown (relative to your working directory). Open and look at them when they're relevant.

--- Conversation so far ---
${t}
--- End of conversation ---

Now write ${agent.name}'s reply to the latest message(s) addressed to you.${rules ? ' Follow the rules at the top.' : ''}`;
  }

  // Images from recent messages, sent with each job so the agent can open them (newest first, ~12 MB cap).
  recentAttachments(roomId) {
    const out = []; let total = 0;
    for (const f of this.sql.exec('SELECT id, name, mime, size, data FROM files WHERE room_id = ? AND msg_id IS NOT NULL ORDER BY ts DESC LIMIT 8', roomId).toArray()) {
      if (total + f.size > 12 * 1024 * 1024) break;
      total += f.size;
      out.push({ id: f.id, name: f.name, mime: f.mime, path: attachmentPath(f), b64: toBase64(f.data) });
    }
    return out.reverse();
  }

  // ---------- provenance: who asked whom, and what was approved (shown on each agent message) ----------
  // kinds: ask (you or an agent -> agent; detail.how = mention | reply | default | everyone | handoff),
  // blocked (a hand-off that a limit stopped), reply (agent finished; detail.status, elapsed),
  // approval-ask (agent wants to use a tool), approval (you allowed / denied), approval-expired, stop.
  log(roomId, kind, actor, target = null, msgId = null, refId = null, detail = null) {
    const ts = Date.now();
    this.sql.exec('INSERT INTO record (room_id, ts, kind, actor, target, msg_id, ref_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      roomId, ts, kind, actor, target, msgId, refId, detail ? JSON.stringify(detail) : null);
  }
  // Who asked for this agent message, and what happened to its approval requests (shown in the chat).
  provenance(id) {
    const ask = this.sql.exec(`SELECT actor, msg_id, detail FROM record WHERE ref_id = ? AND kind = 'ask' LIMIT 1`, id).toArray()[0];
    let how = null; try { how = JSON.parse(ask?.detail || '{}').how || null; } catch {}
    const approvalLog = this.sql.exec(`SELECT ts, kind, actor, detail FROM record WHERE msg_id = ? AND kind IN ('approval', 'approval-expired') ORDER BY seq`, id).toArray().map((r) => {
      let d = {}; try { d = JSON.parse(r.detail || '{}'); } catch {}
      return { ts: r.ts, tool: d.tool, summary: d.summary, result: r.kind === 'approval' ? (d.allow ? 'allowed' : 'denied') : 'unanswered', why: d.why || null };
    });
    return { askedBy: ask ? { actor: ask.actor, msgId: ask.msg_id, how } : null, approvalLog };
  }
  // Phone notifications (Mac app only): the link encrypts them for each paired phone.
  notifyPhones(kind, roomId, title, body, tag) { try { this.env.NOTIFY?.({ kind, roomId, title, body, tag }); } catch {} }
  // The latest message you sent in a room (what an "Ask everyone" round answers).
  turnMsg(roomId) { return this.sql.exec(`SELECT id FROM messages WHERE room_id = ? AND role = 'user' ORDER BY ts DESC LIMIT 1`, roomId).toArray()[0]?.id || null; }
  // Approval requests the runner reports: log new ones, and ones that vanished without an answer.
  trackApprovals(job, list, why = 'timed out') {
    const before = this.approvals.get(job.id) || [];
    const now = new Set((list || []).map((a) => a.id));
    for (const a of list || []) if (!before.some((b) => b.id === a.id)) {
      this.log(job.room_id, 'approval-ask', job.agent_id, null, job.id, a.id, { tool: a.tool, summary: String(a.summary || '').slice(0, 500) });
      const verb = a.tool === 'Bash' || a.tool === 'command' ? 'run a command' : /^(Edit|Write|MultiEdit|NotebookEdit|patch)$/.test(a.tool) ? 'change files' : `use ${a.tool}`;
      this.notifyPhones('approval', job.room_id, `${this.agent(job.agent_id)?.name || job.agent_id} needs your approval`, `Wants to ${verb}: ${String(a.summary || '').slice(0, 200)}`, `ap-${a.id}`);
    }
    for (const b of before) if (!now.has(b.id)) {
      if (this.decided.has(b.id)) this.decided.delete(b.id);
      else this.log(job.room_id, 'approval-expired', job.agent_id, null, job.id, b.id, { tool: b.tool, summary: String(b.summary || '').slice(0, 500), why });
    }
  }

  // ---------- orchestration ----------
  mentions(text) {
    const ids = new Set();
    for (const [, word] of text.matchAll(/(?:^|[^\w@])@([a-z][\w-]*)/gi)) {
      const w = word.toLowerCase();
      if (w === 'all' || w === 'everyone') this.enabledAgents().forEach((a) => ids.add(a.id));
      const a = this.enabledAgents().find((x) => x.id === w || (x.aliases || []).includes(w));
      if (a) ids.add(a.id);
    }
    return [...ids];
  }

  // by: { actor: 'you' | agent id, msgId: the message that asked, how } — written to the record.
  enqueue(roomId, agentId, depth, route, chain = [], counted = true, by = null) {
    const s = this.settings;
    const room = this.room(roomId);
    if (!room || !this.agent(agentId)?.enabled) return;
    if (counted) {
      if (room.turn_runs >= s.maxRunsPerTurn) {
        if (by) this.log(roomId, 'blocked', by.actor, agentId, by.msgId, null, { reason: `reply limit (${s.maxRunsPerTurn} per message)` });
        this.system(roomId, `Stopped: reached the limit of ${s.maxRunsPerTurn} agent replies for one message. Send another message to continue.`); return;
      }
      this.sql.exec('UPDATE rooms SET turn_runs = turn_runs + 1 WHERE id = ?', roomId);
    }
    const id = crypto.randomUUID();
    if (by) this.log(roomId, 'ask', by.actor, agentId, by.msgId, id, { how: by.how, mode: APPROVAL_MODES.includes(room.approvals) ? room.approvals : 'ask' });
    this.addMessage({ id, roomId, role: 'agent', agentId, mode: this.agent(agentId).mode, status: 'queued', depth });
    this.sql.exec('INSERT INTO jobs (id, room_id, agent_id, depth, route, chain, status) VALUES (?, ?, ?, ?, ?, ?, ?)', id, roomId, agentId, depth, route ? 1 : 0, JSON.stringify(chain), 'queued');
    return id;
  }

  async schedule() {
    const now = Date.now();
    const active = this.sql.exec(`SELECT j.agent_id, j.room_id, r.allow_edits, r.repo FROM jobs j LEFT JOIN rooms r ON r.id = j.room_id WHERE j.status IN ('starting', 'running', 'stopping')`).toArray();
    const busyAgents = new Set(active.map((r) => r.agent_id));
    // In a room where agents edit the repo, one agent works at a time (they share one checkout).
    const busyRooms = new Set(active.filter((r) => r.allow_edits && r.repo).map((r) => r.room_id));
    for (const j of this.sql.exec(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY seq`).toArray()) {
      if (busyAgents.has(j.agent_id)) continue;
      const room = this.room(j.room_id);
      if (!room) { this.sql.exec('DELETE FROM jobs WHERE id = ?', j.id); continue; }
      const editRoom = !!(room.allow_edits && room.repo);
      if (editRoom && busyRooms.has(room.id)) continue;
      // Claim the job atomically: Stop/Clear may have removed it while we were awaiting.
      const claim = this.sql.exec(`UPDATE jobs SET status = 'starting', started = ? WHERE id = ? AND status = 'queued'`, now, j.id);
      if (!claim.rowsWritten) continue;
      busyAgents.add(j.agent_id); if (editRoom) busyRooms.add(room.id);
      await this.startJob({ ...j, status: 'starting', started: now });
    }
    const left = this.sql.exec('SELECT COUNT(*) AS n FROM jobs').one().n;
    if (left) await this.ctx.storage.setAlarm(Date.now() + POLL_MS); // also re-arms from inside alarm()
    // Housekeeping: uploads never attached to a message, expired sessions, old failed-login records.
    this.sql.exec('DELETE FROM files WHERE msg_id IS NULL AND ts < ?', now - 3600e3);
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', now);
    this.sql.exec('DELETE FROM login_fail WHERE ts < ?', now - 3600e3);
    this.pushRooms();
  }

  async startJob(j) {
    const agent = this.agent(j.agent_id);
    const room = this.room(j.room_id);
    const fail = (error) => this.finalize(j, { status: 'error', error });
    if (!room) { this.sql.exec('DELETE FROM jobs WHERE id = ?', j.id); return; }
    if (!agent) return fail(`Agent "${j.agent_id}" no longer exists.`);
    if (!agent.enabled) return fail(`${agent.name} is switched off in this room.`);
    if (agent.mode === 'cli' && !agent.cli) return fail(`${agent.name} has no CLI set up.`);
    if (agent.mode === 'api' && !agent.api) return fail(`${agent.name} has no API set up.`);
    // A container that just failed to start isn't retried for every queued job: fail fast for a minute.
    if (this.startFailed && Date.now() - this.startFailed.at < 60e3) return fail(`Couldn't start the agent computer: ${this.startFailed.error}`);
    const s = this.settings, secrets = this.secrets;
    this.updateMessage(j.id, { status: 'running', started: Date.now(), mode: agent.mode === 'api' ? `api · ${agent.api?.model || ''}` : (agent.cli?.model ? `cli · ${agent.cli.model}` : 'cli') });
    const spec = {
      id: j.id, agentName: agent.name, timeoutSec: s.timeoutSec,
      // Read-only rooms never commit, whatever "Allow edits" says.
      room: { id: room.id, repo: room.repo, branch: room.branch, allowEdits: !!room.allow_edits && room.approvals !== 'readonly', gitName: s.gitName, gitEmail: s.gitEmail },
    };
    spec.attachments = this.recentAttachments(room.id);
    if (agent.mode === 'api') {
      // API agents get their own provider key and nothing else.
      const k = agent.api.keyEnv;
      Object.assign(spec, { kind: 'api', api: agent.api, prompt: this.buildPrompt(room, agent), env: secrets[k] ? { [k]: secrets[k] } : {} });
    } else {
      const c = agent.cli;
      const modelArgs = c.model && c.modelFlag ? [c.modelFlag, c.model] : [];
      const mode = APPROVAL_MODES.includes(room.approvals) ? room.approvals : 'ask';
      const edit = !!(room.repo && room.allow_edits && mode !== 'readonly');
      const permArgs = mode === 'auto' ? ((edit ? c.editArgs : c.readArgs) || []) : approvalArgs(c.command, mode, edit);
      const rules = this.rulesFor(room, agent);
      // Rules also go in as system instructions where the CLI has a place for them (stronger than the prompt).
      const ruleArgs = rules && c.command === 'claude' ? ['--append-system-prompt', rules] : [];
      const raw = [...(c.args || []), ...modelArgs, ...permArgs, ...ruleArgs];
      const inline = raw.some((a) => a.includes('{prompt}'));
      const prompt = this.buildPrompt(room, agent, inline ? 100000 : 400000);
      // Each CLI sees only its own login token; the GitHub token goes to the runner's git, never to agents.
      const own = c.account ? null : agent.login?.secret; // an extra account uses only its own login
      Object.assign(spec, {
        kind: 'cli', command: c.command, account: c.account || '', approval: mode, env: own && secrets[own] ? { [own]: secrets[own] } : {},
        gitToken: room.repo ? secrets.GITHUB_TOKEN || '' : '',
        args: raw.map((a) => a.replaceAll('{prompt}', prompt).replaceAll('{model}', c.model ?? '')),
        stdin: inline ? null : prompt,
        // Codex asks in the chat through its app-server; the sandbox stays read-only so every change is asked for.
        codexApp: c.command === 'codex' && mode === 'ask' ? { model: c.model || null, sandbox: 'read-only', instructions: rules || null } : null,
      });
    }
    try {
      await this.ensureContainer();
      this.startFailed = null;
    } catch (e) {
      this.startFailed = { at: Date.now(), error: e.message };
      return fail(`Couldn't start the agent computer: ${e.message}`);
    }
    // Stopped while the container was starting? Then don't run it.
    const row = this.sql.exec('SELECT status FROM jobs WHERE id = ?', j.id).toArray()[0];
    if (!row || row.status !== 'starting') {
      if (row) await this.finalize(j, { status: 'stopped' });
      return;
    }
    try {
      await this.cfetch('/jobs', { method: 'POST', body: spec });
      this.sql.exec(`UPDATE jobs SET status = 'running' WHERE id = ? AND status = 'starting'`, j.id);
    } catch (e) {
      await fail(`Couldn't start the agent: ${e.message}`);
    }
  }

  async finalize(j, r) {
    const job = this.sql.exec('SELECT * FROM jobs WHERE id = ?', j.id).toArray()[0] || j;
    if (this.approvals.has(j.id)) this.trackApprovals(job, [], r.status === 'done' ? 'the agent finished first' : r.status === 'stopped' ? 'the agent was stopped' : 'the agent hit an error');
    this.approvals.delete(j.id);
    const status = r.status === 'done' ? 'done' : r.status === 'stopped' ? 'stopped' : 'error';
    let text = status === 'done' ? (r.result || '').trim() || '(no reply)' : (r.result || '').trim() || r.error || '(stopped)';
    if (status === 'error' && !/^git clone failed/.test(text) && /authenticat|unauthori[sz]ed|\b401\b|not logged in|log ?in required|run '?\w+'? to log ?in|sign ?in/i.test(text)) {
      text = `${this.agent(job.agent_id)?.name || 'This agent'} isn't signed in yet. Open Accounts → Sign in to connect it.\n\n${text}`;
    }
    const started = job.started || Date.now();
    this.sql.exec('DELETE FROM jobs WHERE id = ?', j.id);
    this.updateMessage(j.id, { status, text, elapsed: r.elapsed ?? Date.now() - started, activity: (r.activity || this.activity.get(j.id) || '').slice(-4000) });
    this.activity.delete(j.id);
    this.log(job.room_id, 'reply', job.agent_id, null, j.id, null, { status, elapsed: r.elapsed ?? Date.now() - started });
    if (status !== 'stopped') this.notifyPhones('reply', job.room_id, `${this.agent(job.agent_id)?.name || job.agent_id} ${status === 'done' ? 'replied' : 'hit a problem'} in #${this.room(job.room_id)?.name || 'room'}`, text.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').slice(0, 200), `re-${j.id}`);
    if (status !== 'stopped' && this.agent(job.agent_id)?.mode === 'cli') this.maybeRefreshUsage(job.agent_id);
    const s = this.settings;
    if (status === 'done' && job.route) {
      const next = this.mentions(text).filter((id) => id !== job.agent_id);
      if (next.length && job.depth + 1 > s.maxHops) {
        next.forEach((id) => this.log(job.room_id, 'blocked', job.agent_id, id, j.id, null, { reason: `hand-off limit (${s.maxHops})` }));
        this.system(job.room_id, `Hand-off limit (${s.maxHops}) reached — not triggering ${next.map((i) => '@' + i).join(', ')}.`);
      }
      else next.forEach((id) => this.enqueue(job.room_id, id, job.depth + 1, true, [], true, { actor: job.agent_id, msgId: j.id, how: 'handoff' }));
    }
    // "Ask everyone": hand over to the next agent in the chain that is still switched on.
    let chain = []; try { chain = JSON.parse(job.chain || '[]'); } catch {}
    while (chain.length && !this.agent(chain[0])?.enabled) chain = chain.slice(1);
    if (chain.length && status !== 'stopped') this.enqueue(job.room_id, chain[0], 0, false, chain.slice(1), false, { actor: 'you', msgId: this.turnMsg(job.room_id), how: 'everyone' });
  }

  async alarm() {
    try {
      const running = this.sql.exec(`SELECT * FROM jobs WHERE status = 'running'`).toArray();
      let credsChanged = false;
      const known = this.kvGet('credsHash', null);
      const maxAge = (this.settings.timeoutSec + 300) * 1000;
      for (const j of running) {
        if (!this.isRunning()) { await this.finalize(j, { status: 'error', error: 'The agent container stopped while this agent was working. Try again.' }); continue; }
        if (Date.now() - (j.started || Date.now()) > maxAge) {
          await this.cfetch(`/jobs/${j.id}/stop`, { method: 'POST' }).catch(() => {});
          await this.finalize(j, { status: 'error', error: `Timed out after ${Math.round(maxAge / 60000)} minutes.` });
          continue;
        }
        let r;
        try { r = await this.cfetch(`/jobs/${j.id}`); }
        catch (e) {
          if (e.status === 404) await this.finalize(j, { status: 'error', error: 'The agent container restarted while this agent was working. Try again.' });
          continue;
        }
        if (r.status === 'running') {
          if (r.activity !== this.activity.get(j.id)) { this.activity.set(j.id, r.activity); this.broadcast('activity', { id: j.id, activity: r.activity }); }
          // Approval requests waiting in the chat (Approve / Deny on the agent's message).
          const ap = JSON.stringify(r.approvals || []);
          if (ap !== JSON.stringify(this.approvals.get(j.id) || [])) {
            this.trackApprovals(j, r.approvals || []);
            if ((r.approvals || []).length) this.approvals.set(j.id, r.approvals); else this.approvals.delete(j.id);
            const m = this.sql.exec('SELECT * FROM messages WHERE id = ?', j.id).toArray()[0];
            if (m) this.broadcast('update', this.msgObj(m));
          }
        } else {
          if (r.credsHash && r.credsHash !== known) credsChanged = true;
          await this.finalize(j, r);
        }
      }
      if (credsChanged) await this.syncCreds().catch(() => {});
    } catch (e) { console.error('alarm', e); }
    await this.schedule();
  }

  async stopRoom(roomId) {
    for (const j of this.sql.exec(`SELECT * FROM jobs WHERE room_id = ? AND status = 'queued'`, roomId).toArray()) {
      this.sql.exec('DELETE FROM jobs WHERE id = ?', j.id);
      this.updateMessage(j.id, { status: 'stopped', text: '(cancelled)' });
    }
    // Jobs still waiting for the container: startJob sees 'stopping' and won't run them.
    this.sql.exec(`UPDATE jobs SET status = 'stopping', chain = '[]' WHERE room_id = ? AND status = 'starting'`, roomId);
    for (const j of this.sql.exec(`SELECT * FROM jobs WHERE room_id = ? AND status = 'running'`, roomId).toArray()) {
      this.sql.exec(`UPDATE jobs SET chain = '[]' WHERE id = ?`, j.id);
      if (this.isRunning()) await this.cfetch(`/jobs/${j.id}/stop`, { method: 'POST' }).catch(() => {});
    }
  }

  // ---------- sessions (called by the Worker) ----------
  async auth(path, data) {
    const now = Date.now();
    if (path === 'login') {
      const ip = String(data.ip || 'unknown').slice(0, 64);
      const perIp = this.sql.exec('SELECT COUNT(*) AS n FROM login_fail WHERE ip = ? AND ts > ?', ip, now - 15 * 60e3).one().n;
      const all = this.sql.exec('SELECT COUNT(*) AS n FROM login_fail WHERE ts > ?', now - 15 * 60e3).one().n;
      if (perIp >= 8 || all >= 100) return json({ error: 'Too many wrong passwords. Try again in 15 minutes.' }, 429);
      const want = await hmacHex('cmp', this.env.APP_PASSWORD || '');
      const got = await hmacHex('cmp', String(data.password || ''));
      if (!this.env.APP_PASSWORD || !safeEqual(want, got)) {
        this.sql.exec('INSERT INTO login_fail (ip, ts) VALUES (?, ?)', ip, now);
        await new Promise((r) => setTimeout(r, 600));
        return json({ error: 'Wrong password' }, 401);
      }
      this.sql.exec('DELETE FROM login_fail WHERE ip = ?', ip);
      const sid = randomToken();
      this.sql.exec('INSERT INTO sessions (hash, created, expires, seen, ua, ip) VALUES (?, ?, ?, ?, ?, ?)', await sha256Hex(sid), now, now + SESSION_DAYS * 86400e3, now, String(data.ua || '').slice(0, 200), ip);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(sid, SESSION_DAYS) });
    }
    if (path === 'check') return json({ ok: !!(await this.session(data.sid)) });
    if (path === 'logout') {
      const hash = await sha256Hex(String(data.sid || ''));
      this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash);
      for (const ws of this.ctx.getWebSockets(hash)) { try { ws.close(4001, 'signed out'); } catch {} }
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }
  async session(sid) {
    if (typeof sid !== 'string' || !/^[\w-]{30,100}$/.test(sid)) return null;
    const hash = await sha256Hex(sid);
    const row = this.sql.exec('SELECT * FROM sessions WHERE hash = ?', hash).toArray()[0];
    const now = Date.now();
    if (!row || row.expires < now) { if (row) this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash); return null; }
    if (now - row.seen > 3600e3) this.sql.exec('UPDATE sessions SET seen = ?, expires = ? WHERE hash = ?', now, now + SESSION_DAYS * 86400e3, hash);
    return row;
  }

  // ---------- HTTP API ----------
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__auth/')) return this.auth(url.pathname.slice(8), await req.json().catch(() => ({})));
    const sess = await this.session(req.headers.get('x-ar-session'));
    if (!sess) return json({ error: 'Not signed in' }, 401);
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    // Image uploads arrive as raw bytes, so handle them before the JSON body is read.
    if (parts[0] === 'rooms' && parts[2] === 'files' && req.method === 'POST') {
      if (!this.room(parts[1])) return json({ error: 'no such room' }, 404);
      const mime = (req.headers.get('content-type') || '').split(';')[0].trim();
      if (!/^image\/(png|jpe?g|gif|webp)$/.test(mime)) return json({ error: 'Only PNG, JPEG, GIF or WebP images.' }, 415);
      const data = await req.arrayBuffer();
      if (!data.byteLength) return json({ error: 'empty file' }, 400);
      if (data.byteLength > 1900 * 1024) return json({ error: 'Image too large (max about 1.9 MB after compression).' }, 413);
      const used = this.sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM files').one().n;
      if (used + data.byteLength > 500 * 1024 * 1024) return json({ error: 'Image storage is full (500 MB). Clear old rooms to make space.' }, 413);
      const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
      const name = String(url.searchParams.get('name') || 'image').replace(/[^\w. -]/g, '_').slice(0, 80) || 'image';
      this.sql.exec('INSERT INTO files (id, room_id, msg_id, name, mime, size, data, ts) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)', id, parts[1], name, mime, data.byteLength, data, Date.now());
      return json({ id, name, mime, size: data.byteLength });
    }
    if (parts[0] === 'files' && parts[1] && req.method === 'GET') {
      const f = this.sql.exec('SELECT mime, data, name FROM files WHERE id = ?', parts[1]).toArray()[0];
      if (!f) return new Response('not found', { status: 404 });
      return new Response(f.data, { headers: { 'content-type': f.mime, 'cache-control': 'private, max-age=86400', 'content-disposition': `inline; filename="${f.name}"`, 'x-content-type-options': 'nosniff' } });
    }
    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
    try {
      if (parts[0] === 'ws') {
        if (req.headers.get('upgrade') !== 'websocket') return json({ error: 'expected websocket' }, 400);
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1], [sess.hash]); // tagged so signing out closes it
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (parts[0] === 'state') {
        return json({ settings: this.settings, globalRules: this.globalRules().length, agents: this.publicAgents(), rooms: this.roomList(), container: { running: !!this.isRunning(), starting: !!this.starting }, local: this.local, usage: this.kvGet('usage', {}), usageStatus: this.usageState(), models: this.modelsByAgent() });
      }
      // Rules: GET /api/rules?room=<id>, PUT /api/rules { rules } (every room), PUT /api/rooms/<id>/rules { rules }.
      if (parts[0] === 'rules') {
        if (req.method === 'GET') { const r = this.room(url.searchParams.get('room') || ''); return json({ global: this.globalRules(), room: r ? this.roomRules(r) : [] }); }
        if (req.method === 'PUT') {
          const before = this.globalRules(), rules = this.validRules(body.rules);
          this.kvSet('rules', rules);
          for (const r of this.roomList()) this.ruleNotes(r.id, before, rules, 'for every room');
          return json({ ok: true, rules });
        }
      }
      if (parts[0] === 'settings' && req.method === 'PATCH') {
        const cur = this.kvGet('settings', {});
        for (const k of ['userName', 'defaultAgent', 'gitName', 'gitEmail']) if (typeof body[k] === 'string') cur[k] = body[k].trim().slice(0, 100);
        const LIMITS = { maxHops: [1, 20], maxRunsPerTurn: [1, 50], timeoutSec: [60, 3600], historyChars: [2000, 200000] };
        for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (Number.isFinite(body[k]) && body[k] > 0) cur[k] = Math.min(hi, Math.max(lo, Math.round(body[k])));
        if (cur.userName != null) cur.userName = cur.userName.replace(/[<>"'`]/g, '');
        // When the person agreed to the Terms in the first-run setup (kept as a record).
        if (typeof body.termsAccepted === 'string' && !Number.isNaN(Date.parse(body.termsAccepted))) cur.termsAccepted = new Date(body.termsAccepted).toISOString();
        this.kvSet('settings', cur);
        return json({ ok: true, settings: this.settings });
      }

      // agents
      if (parts[0] === 'agents') {
        if (!parts[1] && req.method === 'GET') return json(this.agents);
        if (!parts[1] && req.method === 'PUT') {
          if (body.reset) this.sql.exec(`DELETE FROM kv WHERE k = 'agents'`);
          else {
            if (!Array.isArray(body.agents) || !body.agents.length || body.agents.length > 20) return json({ error: 'Send a list of 1 to 20 agents.' }, 400);
            for (const a of body.agents) { const err = validateAgent(a); if (err) return json({ error: err }, 400); }
            if (new Set(body.agents.map((a) => a.id)).size !== body.agents.length) return json({ error: 'Agent ids must be unique.' }, 400);
            this.kvSet('agents', body.agents);
          }
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true });
        }
        // Extra accounts: another login for Claude, Codex or Grok, added as its own agent (@claude-work).
        if (parts[1] === 'accounts' && req.method === 'POST') {
          const cmd = String(body.command || ''), label = String(body.label || '').trim().replace(/[<>"'`]/g, '').slice(0, 24);
          const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
          if (!ACCOUNT_CLIS.includes(cmd)) return json({ error: 'Extra accounts work for Claude, Codex and Grok.' }, 400);
          if (!slug) return json({ error: 'Give the account a name, like “work”.' }, 400);
          const agents = this.agents;
          const base = DEFAULT_AGENTS.find((d) => d.cli?.command === cmd);
          const id = `${base.id}-${slug}`;
          if (agents.some((x) => x.id === id || (x.cli?.command === cmd && x.cli?.account === slug))) return json({ error: `There’s already an account called ${label}.` }, 400);
          if (agents.length >= 20) return json({ error: 'You can have up to 20 agents.' }, 400);
          const a = structuredClone(base);
          Object.assign(a, { id, name: `${base.name} (${label})`, aliases: [], enabled: true, mode: 'cli', note: `${base.name} signed in to your “${label}” account.` });
          a.cli.account = slug; a.cli.model = '';
          const err = validateAgent(a); if (err) return json({ error: err }, 400);
          agents.push(a); this.kvSet('agents', agents);
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true, agent: { id, name: a.name } });
        }
        if (parts[1] && req.method === 'DELETE') {
          const agents = this.agents; const a = agents.find((x) => x.id === parts[1]);
          if (!a) return json({ error: 'no agent' }, 404);
          if (!a.cli?.account) return json({ error: 'Only extra accounts can be removed here.' }, 400);
          this.kvSet('agents', agents.filter((x) => x.id !== a.id));
          // Forget its saved login files (cloud). On the Mac its folder stays in ~/.agenthuddle/accounts.
          const files = this.kvGet('credFiles', {}), pre = `.agenthuddle/accounts/${a.cli.account}/`;
          for (const k of Object.keys(files)) if (k.startsWith(pre)) delete files[k];
          this.kvSet('credFiles', files);
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true });
        }
        if (parts[1] && req.method === 'PATCH') {
          const agents = this.agents; const a = agents.find((x) => x.id === parts[1]);
          if (!a) return json({ error: 'no agent' }, 404);
          if (typeof body.enabled === 'boolean') a.enabled = body.enabled;
          if ((body.mode === 'cli' && a.cli) || (body.mode === 'api' && a.api)) a.mode = body.mode;
          for (const [k, part] of [['apiModel', 'api'], ['cliModel', 'cli']]) {
            if (typeof body[k] !== 'string' || !a[part]) continue;
            const v = body[k].trim();
            if (!MODEL_RE.test(v)) return json({ error: 'Model names can only use letters, digits and . : / @ - _ [ ]' }, 400);
            a[part].model = v;
          }
          this.kvSet('agents', agents);
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true });
        }
      }

      // secrets & credential files (values are write-only)
      if (parts[0] === 'secrets') {
        if (req.method === 'GET') return json(Object.fromEntries(SECRET_NAMES.map((n) => [n, !!this.secrets[n]])));
        if (req.method === 'PUT') {
          const sec = this.secrets;
          for (const [k, v] of Object.entries(body)) {
            if (!SECRET_NAMES.includes(k)) continue;
            if (v) sec[k] = String(v).trim(); else delete sec[k];
          }
          this.kvSet('secrets', sec);
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true });
        }
      }
      if (parts[0] === 'credfiles') {
        if (req.method === 'GET') return json(Object.keys(this.credFiles));
        if (req.method === 'PUT') {
          if (!CRED_PASTE_PATHS.includes(body.path)) return json({ error: 'Unsupported file' }, 400);
          const content = String(body.content || '').trim();
          if (content) { try { JSON.parse(content); } catch { return json({ error: "That doesn't look like the right file — it should be JSON." }, 400); } }
          const files = this.credFiles;
          const b64 = content ? btoa(String.fromCharCode(...enc.encode(content))) : null;
          if (b64) files[body.path] = b64; else delete files[body.path];
          this.kvSet('credFiles', files);
          if (this.isRunning()) await this.cfetch('/restore', { method: 'POST', body: { files: { [body.path]: b64 } } }).catch(() => {});
          this.broadcast('agents', this.publicAgents());
          return json({ ok: true });
        }
      }

      // container + login console
      if (parts[0] === 'container') {
        if (req.method === 'GET') {
          const running = !!this.isRunning();
          return json({ running, health: running ? await this.cfetch('/health').catch((e) => ({ error: e.message })) : null });
        }
        if (parts[1] === 'start' && req.method === 'POST') return json(await this.ensureContainer());
        if (parts[1] === 'stop' && req.method === 'POST') {
          if (this.local) return json({ ok: true, local: true }); // the Mac app runs the agents; nothing to stop
          await this.syncCreds().catch(() => {});
          await this.ctx.container?.destroy?.();
          this.ready = false; this.starting = null;
          this.broadcast('container', { running: false });
          return json({ ok: true });
        }
      }
      if (parts[0] === 'console') {
        if (parts[1] === 'start' && req.method === 'POST') {
          const command = (this.local && LOCAL_CONSOLE_COMMANDS[body.preset]) || CONSOLE_COMMANDS[body.preset];
          if (!command || (!this.local && LOCAL_ONLY_COMMANDS.includes(body.preset))) return json({ error: 'Unknown command' }, 400);
          await this.ensureContainer();
          const sec = this.secrets, env = {};
          if (body.preset === 'cursor-status' && sec.CURSOR_API_KEY) env.CURSOR_API_KEY = sec.CURSOR_API_KEY;
          if (body.preset === 'claude-status' && sec.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = sec.CLAUDE_CODE_OAUTH_TOKEN;
          // Signing in an extra account: the CLI writes its login into that account's own folder.
          const target = body.agentId ? this.agent(String(body.agentId)) : null;
          const account = target?.cli?.account && body.preset.startsWith((target.cli.command === 'claude' ? 'claude' : target.cli.command) + '-') ? target.cli.account : '';
          return json(await this.cfetch('/console/start', { method: 'POST', body: { preset: body.preset, command, env: account ? {} : env, account } }));
        }
        if (!this.isRunning()) return json({ running: false, out: '\n[container is asleep]\n', next: 0 });
        if (!parts[1] && req.method === 'GET') {
          const r = await this.cfetch(`/console?since=${Number(url.searchParams.get('since') || 0)}`);
          if (!r.running) await this.syncCreds().catch(() => {});
          return json(r);
        }
        if (parts[1] === 'input' && req.method === 'POST') return json(await this.cfetch('/console/input', { method: 'POST', body }));
        if (parts[1] === 'stop' && req.method === 'POST') { const r = await this.cfetch('/console/stop', { method: 'POST' }); await this.syncCreds().catch(() => {}); return json(r); }
      }
      if (parts[0] === 'usage') {
        if (req.method === 'GET') return json(url.searchParams.get('full') ? { usage: this.kvGet('usage', {}), ...this.usageState() } : this.kvGet('usage', {}));
        if (parts[1] === 'refresh' && req.method === 'POST') return json({ usage: this.kvGet('usage', {}), ...this.refreshUsage(Array.isArray(body.agents) ? body.agents : null) });
      }
      if (parts[0] === 'github' && req.method === 'GET') {
        if (parts[1] === 'repos') return json(await this.githubRepos(!!url.searchParams.get('refresh')));
        if (parts[1] === 'branches') return json(await this.githubBranches(String(url.searchParams.get('repo') || '')));
      }
      if (parts[0] === 'models') {
        if (req.method === 'GET') return json(this.modelsByAgent());
        if (req.method === 'POST') return json(this.refreshModels(body.agentId ? [body.agentId] : null, !!body.refresh));
      }
      if (parts[0] === 'creds' && parts[1] === 'sync' && req.method === 'POST') { await this.syncCreds(); return json({ ok: true, agents: this.publicAgents() }); }

      // rooms
      if (parts[0] === 'rooms') {
        if (!parts[1] && req.method === 'POST') {
          const repo = String(body.repo || '').trim(), branch = String(body.branch || '').trim();
          if (!validRepo(repo)) return json({ error: 'Use owner/repo or an https git URL.' }, 400);
          if (!validBranch(branch)) return json({ error: 'That branch name isn’t allowed.' }, 400);
          const id = this.createRoom(String(body.name || 'New room').trim().slice(0, 60) || 'New room', repo, branch);
          this.pushRooms();
          return json(this.roomSummary(this.room(id)));
        }
        const room = this.room(parts[1]);
        if (!room) return json({ error: 'no room' }, 404);
        if (!parts[2] && req.method === 'GET') {
          const msgs = this.sql.exec('SELECT * FROM (SELECT * FROM messages WHERE room_id = ? ORDER BY ts DESC LIMIT 300) ORDER BY ts', room.id).toArray().map((m) => this.msgObj(m));
          return json({ ...this.roomSummary(room), messages: msgs });
        }
        if (parts[2] === 'rules' && req.method === 'PUT') {
          const before = this.roomRules(room), rules = this.validRules(body.rules);
          this.sql.exec('UPDATE rooms SET rules = ? WHERE id = ?', JSON.stringify(rules), room.id);
          this.ruleNotes(room.id, before, rules, 'for this room');
          this.pushRooms();
          return json({ ok: true, rules });
        }
        // Approve / Deny an agent's request from the chat.
        if (parts[2] === 'approve' && req.method === 'POST') {
          const job = this.sql.exec(`SELECT * FROM jobs WHERE id = ? AND room_id = ? AND status = 'running'`, String(body.msgId || ''), room.id).toArray()[0];
          if (!job) return json({ error: 'That agent has finished.' }, 404);
          const r = await this.cfetch(`/jobs/${job.id}/approve`, { method: 'POST', body: { reqId: String(body.reqId || ''), allow: !!body.allow } }).catch((e) => ({ error: e.message }));
          if (r.error) return json({ error: r.error }, 400);
          const req0 = (this.approvals.get(job.id) || []).find((a) => a.id === body.reqId);
          if (req0) { this.decided.add(req0.id); this.log(room.id, 'approval', 'you', job.agent_id, job.id, req0.id, { allow: !!body.allow, tool: req0.tool, summary: String(req0.summary || '').slice(0, 500) }); }
          const left = (this.approvals.get(job.id) || []).filter((a) => a.id !== body.reqId);
          if (left.length) this.approvals.set(job.id, left); else this.approvals.delete(job.id);
          const m = this.sql.exec('SELECT * FROM messages WHERE id = ?', job.id).toArray()[0];
          if (m) this.broadcast('update', this.msgObj(m));
          return json({ ok: true });
        }
        if (!parts[2] && req.method === 'PATCH') {
          if (typeof body.name === 'string' && body.name.trim()) this.sql.exec('UPDATE rooms SET name = ? WHERE id = ?', body.name.trim().slice(0, 60), room.id);
          if (typeof body.repo === 'string') {
            const repo = body.repo.trim();
            if (!validRepo(repo)) return json({ error: 'Use owner/repo or an https git URL.' }, 400);
            this.sql.exec('UPDATE rooms SET repo = ? WHERE id = ?', repo, room.id);
            if (!repo) this.sql.exec('UPDATE rooms SET allow_edits = 0 WHERE id = ?', room.id);
          }
          if (typeof body.branch === 'string') {
            const branch = body.branch.trim().replace(/[^\w./-]/g, '-');
            if (!validBranch(branch)) return json({ error: 'That branch name isn’t allowed.' }, 400);
            this.sql.exec('UPDATE rooms SET branch = ? WHERE id = ?', branch, room.id);
          }
          if (typeof body.allowEdits === 'boolean') this.sql.exec('UPDATE rooms SET allow_edits = ? WHERE id = ?', body.allowEdits ? 1 : 0, room.id);
          if (APPROVAL_MODES.includes(body.approvals)) this.sql.exec('UPDATE rooms SET approvals = ? WHERE id = ?', body.approvals, room.id);
          this.pushRooms();
          return json(this.roomSummary(this.room(room.id)));
        }
        if (!parts[2] && req.method === 'DELETE') {
          await this.stopRoom(room.id);
          this.sql.exec('DELETE FROM jobs WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM messages WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM record WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM files WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM rooms WHERE id = ?', room.id);
          if (this.isRunning()) await this.cfetch(`/rooms/${room.id}`, { method: 'DELETE' }).catch(() => {});
          if (!this.sql.exec('SELECT id FROM rooms LIMIT 1').toArray().length) this.createRoom('General');
          this.pushRooms();
          return json({ ok: true });
        }
        if (parts[2] === 'messages' && req.method === 'POST') {
          const text = String(body.text || '').trim();
          const fileIds = Array.isArray(body.files) ? body.files.map(String).slice(0, 8) : [];
          const files = fileIds.map((fid) => this.sql.exec('SELECT id, name, mime, size FROM files WHERE id = ? AND room_id = ? AND msg_id IS NULL', fid, room.id).toArray()[0]).filter(Boolean);
          if (!text && !files.length) return json({ error: 'empty' }, 400);
          const replied = body.replyTo ? this.sql.exec('SELECT * FROM messages WHERE id = ? AND room_id = ?', String(body.replyTo), room.id).toArray()[0] : null;
          this.sql.exec('UPDATE rooms SET turn_runs = 0 WHERE id = ?', room.id);
          const mid = crypto.randomUUID();
          for (const f of files) this.sql.exec('UPDATE files SET msg_id = ? WHERE id = ?', mid, f.id);
          this.addMessage({ id: mid, roomId: room.id, role: 'user', text, replyTo: replied?.id, files: files.map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size })) });
          if (body.mode === 'all') {
            const [first, ...rest] = this.enabledAgents().map((a) => a.id);
            if (first) this.enqueue(room.id, first, 0, false, rest, false, { actor: 'you', msgId: mid, how: 'everyone' });
          } else {
            let targets = this.mentions(text), how = 'mention';
            const s = this.settings;
            // Replying to an agent's message goes to that agent unless you @mention someone else.
            if (!targets.length && replied?.role === 'agent' && this.agent(replied.agent_id)?.enabled) { targets = [replied.agent_id]; how = 'reply'; }
            if (!targets.length) { targets = [this.agent(s.defaultAgent)?.enabled ? s.defaultAgent : this.enabledAgents()[0]?.id].filter(Boolean); how = 'default'; }
            targets.forEach((id) => this.enqueue(room.id, id, 0, true, [], true, { actor: 'you', msgId: mid, how }));
          }
          // Let the alarm handler start jobs, so a slow container cold start doesn't hold this request open.
          await this.ctx.storage.setAlarm(Date.now() + 10);
          this.pushRooms();
          return json({ ok: true });
        }
        if (parts[2] === 'stop' && req.method === 'POST') { this.log(room.id, 'stop', 'you'); await this.stopRoom(room.id); this.system(room.id, 'Stopped all agents in this room.'); return json({ ok: true }); }
        if (parts[2] === 'clear' && req.method === 'POST') {
          await this.stopRoom(room.id);
          this.sql.exec('DELETE FROM jobs WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM messages WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM record WHERE room_id = ?', room.id);
          this.sql.exec('DELETE FROM files WHERE room_id = ?', room.id);
          this.broadcast('reset', { roomId: room.id });
          return json({ ok: true });
        }
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: e.message }, e.status && e.status < 600 ? e.status : 500);
    }
  }
}
