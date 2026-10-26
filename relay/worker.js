// Agent Huddle relay (app.agenthuddle.net): lets people reach the agents on their own Mac from any browser.
//
//  - Accounts: email + password (PBKDF2), sessions in an HttpOnly cookie. One Durable Object per account.
//  - The Mac app signs in once, registers itself, and keeps a WebSocket open to /link/mac.
//  - A signed-in browser opens /link/phone?mac=<id>; the account's Durable Object passes frames between
//    the two sockets. Everything inside those frames is end-to-end encrypted between the paired phone and
//    the Mac (keys from a QR code shown on the Mac), so the relay can't read or change it.
//
//  - Email: new accounts confirm their address by a link before they can link a Mac; a forgotten
//    password is reset by an emailed link (Cloudflare Email Service, from noreply@agenthuddle.net).
//  - Notifications: phones subscribe to Web Push; the Mac sends notifications already encrypted for each
//    paired phone, and the relay only forwards them (relay/push.js).
//
// Pages (the phone web app, terms, privacy) are bundled into this file by relay/build.mjs.
import { DurableObject } from 'cloudflare:workers';
import { PAGES } from './pages.js';
import { sendPush, validEndpoint, vapidFromEnv } from './push.js';

const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) => b64u(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const cookieOf = (req, name) => (req.headers.get('cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] || null;
const sessionCookie = (v, days) => `ahs=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.round(days * 86400)}`;
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e);
const SECURITY = {
  'x-frame-options': 'SAMEORIGIN', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000', 'permissions-policy': 'camera=(self), microphone=(), geolocation=()',
};

async function hashPassword(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return b64u(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 }, key, 256));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const ip = req.headers.get('cf-connecting-ip') || 'local';

    // ---------- pages ----------
    if (req.method === 'GET' && PAGES[p]) {
      const pg = PAGES[p];
      const body = pg.b64 ? Uint8Array.from(atob(pg.body), (c) => c.charCodeAt(0)) : pg.body;
      return new Response(body, { headers: { 'content-type': pg.type, 'cache-control': pg.cache || 'no-cache', ...SECURITY } });
    }

    // ---------- account API (JSON, custom header against CSRF) ----------
    if (p.startsWith('/api/')) {
      if (req.method !== 'GET' && req.headers.get('x-ah') !== '1') return json({ error: 'Missing header' }, 403);
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return json({ error: 'Bad origin' }, 403);
      const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));

      const ua = (req.headers.get('user-agent') || '').slice(0, 200);
      if (p === '/api/push/key') return json({ key: vapidFromEnv(env)?.publicKey || null });
      // By email address: one Durable Object per address.
      if (['/api/signup', '/api/login', '/api/mac/register', '/api/resend', '/api/reset-request'].includes(p)) {
        const mail = p === '/api/resend' || p === '/api/reset-request';
        if (!(await limit(env, `ip:${ip}`, 20, 15 * 60))) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
        if (mail && !(await limit(env, `mail:${ip}`, 6, 60 * 60))) return json({ error: 'Too many emails asked for. Try again in an hour.' }, 429);
        const email = String(body.email || '').trim().toLowerCase();
        if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
        const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(email));
        return stub.fetch('https://acct/' + p.slice(5), { method: 'POST', body: JSON.stringify({ ...body, email, ip, ua, origin: url.origin }) });
      }
      // Links from an email: /#verify=<account>.<token> and /#reset=<account>.<token>.
      if (p === '/api/verify' || p === '/api/reset') {
        if (!(await limit(env, `ip:${ip}`, 20, 15 * 60))) return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429);
        const aid = String(body.account || '');
        if (!/^[0-9a-f]{64}$/.test(aid) || typeof body.token !== 'string') return json({ error: 'That link isn’t valid.' }, 400);
        let id; try { id = env.ACCOUNT.idFromString(aid); } catch { return json({ error: 'That link isn’t valid.' }, 400); }
        return env.ACCOUNT.get(id).fetch('https://acct/' + p.slice(5), { method: 'POST', body: JSON.stringify({ ...body, ua }) });
      }
      // Everything else needs a session.
      const acct = sessionStub(env, cookieOf(req, 'ahs'));
      if (!acct) return json({ error: 'Not signed in' }, 401);
      return acct.stub.fetch('https://acct/' + p.slice(5), { method: req.method, headers: { 'x-session': acct.secret }, body: req.method === 'GET' ? undefined : JSON.stringify({ ...body, origin: url.origin }) });
    }

    // ---------- WebSockets ----------
    if (p === '/link/mac') {
      // Authorization: Bearer <accountId>.<macId>.<token>
      const [aid, macId, token] = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').split('.');
      if (!/^[0-9a-f]{64}$/.test(aid || '') || !macId || !token) return new Response('Unauthorized', { status: 401 });
      let id; try { id = env.ACCOUNT.idFromString(aid); } catch { return new Response('Unauthorized', { status: 401 }); }
      return env.ACCOUNT.get(id).fetch(new Request(`https://acct/link-mac?mac=${encodeURIComponent(macId)}&token=${encodeURIComponent(token)}`, req));
    }
    if (p === '/link/phone') {
      const origin = req.headers.get('origin');
      if (!origin || new URL(origin).host !== url.host) return new Response('Bad origin', { status: 403 });
      const acct = sessionStub(env, cookieOf(req, 'ahs'));
      if (!acct) return new Response('Unauthorized', { status: 401 });
      const h = new Headers(req.headers); h.set('x-session', acct.secret);
      return acct.stub.fetch(new Request(`https://acct/link-phone?mac=${encodeURIComponent(url.searchParams.get('mac') || '')}`, { headers: h }));
    }
    return new Response('Not found', { status: 404, headers: SECURITY });
  },
};

// Session cookie = <account DO id>.<secret>; the account looks up sha256(secret).
function sessionStub(env, cookie) {
  if (!cookie) return null;
  const [aid, secret] = decodeURIComponent(cookie).split('.');
  if (!/^[0-9a-f]{64}$/.test(aid || '') || !secret || secret.length < 20) return null;
  try { return { stub: env.ACCOUNT.get(env.ACCOUNT.idFromString(aid)), secret }; } catch { return null; }
}

// Fixed-window rate limit in a small Durable Object per key.
async function limit(env, key, max, windowSec) {
  if (env.RATE_LIMIT_OFF === '1') return true; // local testing only (.dev.vars)
  const r = await env.LIMIT.get(env.LIMIT.idFromName(key)).fetch('https://limit/hit', { method: 'POST', body: JSON.stringify({ max, windowSec }) });
  return (await r.json()).ok;
}
export class Limiter extends DurableObject {
  async fetch(req) {
    const { max, windowSec } = await req.json();
    const now = Date.now();
    let w = (await this.ctx.storage.get('w')) || { start: now, n: 0 };
    if (now - w.start > windowSec * 1000) w = { start: now, n: 0 };
    w.n++;
    await this.ctx.storage.put('w', w);
    await this.ctx.storage.setAlarm(w.start + windowSec * 1000 + 1000);
    return json({ ok: w.n <= max });
  }
  async alarm() { await this.ctx.storage.deleteAll(); }
}

// ---------- one Durable Object per account ----------
export class Account extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.init();
  }
  init() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS user (email TEXT, salt TEXT, hash TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, created INTEGER, expires INTEGER, ua TEXT);
      CREATE TABLE IF NOT EXISTS macs (id TEXT PRIMARY KEY, name TEXT, token_hash TEXT, created INTEGER, last_seen INTEGER);
      CREATE TABLE IF NOT EXISTS fails (ts INTEGER);
      CREATE TABLE IF NOT EXISTS tokens (kind TEXT, hash TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS mails (ts INTEGER);
      CREATE TABLE IF NOT EXISTS push (id TEXT PRIMARY KEY, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, session TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS push_pairs (push_id TEXT, mac_id TEXT, tag TEXT);
      CREATE TABLE IF NOT EXISTS push_log (mac_id TEXT, ts INTEGER);
    `);
    try { this.sql.exec('ALTER TABLE user ADD COLUMN verified INTEGER DEFAULT 0'); } catch {}
  }
  user() { return this.sql.exec('SELECT * FROM user LIMIT 1').toArray()[0]; }

  // ---- email: confirmation and password-reset links ----
  async newToken(kind, ttlMs) {
    const t = rand(32);
    // Earlier links stay valid until they expire (people often click an older email); the oldest go past 5.
    this.sql.exec('DELETE FROM tokens WHERE expires < ?', Date.now());
    this.sql.exec('DELETE FROM tokens WHERE kind = ? AND rowid NOT IN (SELECT rowid FROM tokens WHERE kind = ? ORDER BY expires DESC LIMIT 4)', kind, kind);
    this.sql.exec('INSERT INTO tokens (kind, hash, expires) VALUES (?, ?, ?)', kind, await sha256(t), Date.now() + ttlMs);
    return `${this.ctx.id.toString()}.${t}`;
  }
  async useToken(kind, t) {
    const row = this.sql.exec('SELECT * FROM tokens WHERE kind = ? AND hash = ? AND expires > ?', kind, await sha256(String(t || '')), Date.now()).toArray()[0];
    if (!row) return false;
    this.sql.exec('DELETE FROM tokens WHERE kind = ?', kind);
    return true;
  }
  async mail(origin, kind) {
    // At most 5 emails an hour per account, whatever is asked for.
    const hourAgo = Date.now() - 3600e3;
    this.sql.exec('DELETE FROM mails WHERE ts < ?', hourAgo);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM mails').one().n >= 5) return 'limited';
    this.sql.exec('INSERT INTO mails (ts) VALUES (?)', Date.now());
    const u = this.user();
    const link = kind === 'verify' ? `${origin}/#verify=${await this.newToken('verify', 48 * 3600e3)}` : `${origin}/#reset=${await this.newToken('reset', 30 * 60e3)}`;
    const m = kind === 'verify'
      ? { subject: 'Confirm your email for Agent Huddle', lead: 'Confirm your email address to finish setting up phone access to your Mac.', button: 'Confirm email', after: 'The link works for 48 hours.' }
      : { subject: 'Reset your Agent Huddle password', lead: 'Someone (hopefully you) asked to reset the password for your Agent Huddle account.', button: 'Choose a new password', after: 'The link works for 30 minutes and only once. Your Macs stay linked; other devices are signed out.' };
    const text = `${m.lead}\n\n${m.button}: ${link}\n\n${m.after}\n\nIf you didn't ask for this, you can ignore this email.\n\nAgent Huddle`;
    const html = `<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;color:#1f1e1c;max-width:480px">
      <p>${m.lead}</p><p><a href="${link}" style="display:inline-block;background:#2f6fde;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">${m.button}</a></p>
      <p style="color:#6b6862;font-size:13px">${m.after} If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${link}</span></p>
      <p style="color:#6b6862;font-size:13px">If you didn't ask for this, you can ignore this email.</p><p>Agent Huddle</p></div>`;
    if (!this.env.EMAIL) { console.log(`[dev] ${kind} email for ${u.email}: ${link}`); return true; }
    try { await this.env.EMAIL.send({ from: { email: 'noreply@agenthuddle.net', name: 'Agent Huddle' }, to: u.email, subject: m.subject, text, html }); return true; }
    catch (e) { console.error('email', e.message); return false; }
  }
  async setPassword(pw) {
    const salt = rand(16);
    this.sql.exec('UPDATE user SET salt = ?, hash = ?', salt, await hashPassword(pw, salt));
  }

  async checkPassword(body) {
    const u = this.user();
    const since = Date.now() - 15 * 60e3;
    this.sql.exec('DELETE FROM fails WHERE ts <= ?', since);
    if (this.sql.exec('SELECT COUNT(*) AS n FROM fails WHERE ts > ?', since).one().n >= 10) return { error: 'Too many wrong passwords. Try again in 15 minutes.', status: 429 };
    const ok = u && safeEqual(await hashPassword(String(body.password || ''), u.salt), u.hash);
    if (!ok) { this.sql.exec('INSERT INTO fails (ts) VALUES (?)', Date.now()); return { error: 'Wrong email or password.', status: 401 }; }
    this.sql.exec('DELETE FROM fails');
    return { ok: true };
  }
  async newSession(ua) {
    const secret = rand(32);
    this.sql.exec('INSERT INTO sessions (hash, created, expires, ua) VALUES (?, ?, ?, ?)', await sha256(secret), Date.now(), Date.now() + SESSION_DAYS * 86400e3, String(ua || '').slice(0, 200));
    this.sql.exec('DELETE FROM sessions WHERE expires < ?', Date.now());
    return `${this.ctx.id.toString()}.${secret}`;
  }
  async session(secret) {
    if (!secret) return null;
    const row = this.sql.exec('SELECT * FROM sessions WHERE hash = ?', await sha256(secret)).toArray()[0];
    if (!row || row.expires < Date.now()) return null;
    if (row.expires - Date.now() < (SESSION_DAYS - 1) * 86400e3) this.sql.exec('UPDATE sessions SET expires = ? WHERE hash = ?', Date.now() + SESSION_DAYS * 86400e3, row.hash);
    return row;
  }
  macList() {
    return this.sql.exec('SELECT id, name, created, last_seen FROM macs ORDER BY created').toArray()
      .map((m) => ({ id: m.id, name: m.name, created: m.created, lastSeen: m.last_seen, online: this.ctx.getWebSockets(`mac:${m.id}`).length > 0 }));
  }

  async fetch(req) {
    const url = new URL(req.url);
    const op = url.pathname.slice(1);

    // ---- WebSockets ----
    if (op === 'link-mac') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const macId = url.searchParams.get('mac');
      const mac = this.sql.exec('SELECT * FROM macs WHERE id = ?', macId).toArray()[0];
      if (!mac || !safeEqual(await sha256(url.searchParams.get('token') || ''), mac.token_hash)) return new Response('Unauthorized', { status: 401 });
      for (const old of this.ctx.getWebSockets(`mac:${macId}`)) { try { old.close(4000, 'replaced'); } catch {} }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['mac', `mac:${macId}`]);
      this.sql.exec('UPDATE macs SET last_seen = ? WHERE id = ?', Date.now(), macId);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (op === 'link-phone') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      if (!(await this.session(req.headers.get('x-session')))) return new Response('Unauthorized', { status: 401 });
      const macId = url.searchParams.get('mac');
      if (!this.sql.exec('SELECT id FROM macs WHERE id = ?', macId).toArray().length) return new Response('No such Mac', { status: 404 });
      if (this.ctx.getWebSockets(`pmac:${macId}`).length >= 20) return new Response('Too many connections', { status: 429 });
      const conn = rand(9);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ['phone', `pmac:${macId}`, `conn:${conn}`]);
      const mac = this.ctx.getWebSockets(`mac:${macId}`)[0];
      if (mac) mac.send(JSON.stringify({ c: conn, open: true }));
      else pair[1].send(JSON.stringify({ relay: 'offline' }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));

    // ---- no session needed (the Worker already rate-limited by IP) ----
    const weak = (pw) => (String(pw || '').length < 10 ? 'Use a password of at least 10 characters.' : String(pw).length > 200 ? 'That password is too long.' : null);
    const checkEmail = (email) => `We've emailed a link to ${email}. Open it to confirm your address, then sign in.`;
    if (op === 'signup' || (op === 'mac/register' && body.create && !this.user()?.verified)) {
      // New account, or taking over one whose email was never confirmed (so nobody can squat an address).
      const u = this.user();
      if (u?.verified) return json({ error: 'There’s already an account with that email. Sign in instead.' }, 409);
      const w = weak(body.password); if (w) return json({ error: w }, 400);
      if (!u) this.sql.exec('INSERT INTO user (email, salt, hash, created, verified) VALUES (?, ?, ?, ?, 0)', body.email, '', '', Date.now());
      await this.setPassword(String(body.password));
      this.sql.exec('DELETE FROM fails');
      const sent = await this.mail(body.origin, 'verify');
      if (sent === 'limited') return json({ error: 'We’ve already sent several emails to this address. Check your inbox and spam folder, or try again in an hour.' }, 429);
      if (!sent) return json({ error: 'We couldn’t send the confirmation email just now. Try again in a little while.' }, 503);
      return json({ ok: false, unverified: true, email: body.email, error: checkEmail(body.email) }, op === 'signup' ? 200 : 403);
    }
    if (op === 'login' || op === 'mac/register' || op === 'resend') {
      const c = await this.checkPassword(body);
      if (!c.ok) return json({ error: c.error }, c.status);
      const u = this.user();
      if (!u.verified) {
        // Password is right but the address isn't confirmed yet: send the link again (rate-limited).
        await this.mail(body.origin, 'verify');
        return json({ ok: false, unverified: true, email: u.email, error: checkEmail(u.email) }, 403);
      }
      if (op === 'resend') return json({ ok: true, verified: true });
      if (op === 'login') return json({ ok: true, email: u.email }, 200, { 'set-cookie': sessionCookie(await this.newSession(body.ua), SESSION_DAYS) });
      // The Mac app gets a long-lived token for its relay connection.
      if (this.sql.exec('SELECT COUNT(*) AS n FROM macs').one().n >= 10) return json({ error: 'You can link up to 10 Macs. Remove one first.' }, 400);
      const id = rand(9), token = rand(32);
      const name = String(body.name || 'Mac').replace(/[<>"'`]/g, '').slice(0, 60) || 'Mac';
      this.sql.exec('INSERT INTO macs (id, name, token_hash, created, last_seen) VALUES (?, ?, ?, ?, NULL)', id, name, await sha256(token), Date.now());
      return json({ ok: true, accountId: this.ctx.id.toString(), macId: id, token, email: u.email });
    }
    if (op === 'reset-request') {
      // Same answer whether or not there's an account, so this can't be used to find out who has one.
      const u = this.user();
      if (u?.verified) await this.mail(body.origin, 'reset');
      return json({ ok: true });
    }
    if (op === 'verify') {
      const u = this.user();
      if (!u || !(await this.useToken('verify', body.token))) return json({ error: 'That link has expired or was already used. Sign in to get a new one.' }, 400);
      this.sql.exec('UPDATE user SET verified = 1');
      return json({ ok: true, email: u.email }, 200, { 'set-cookie': sessionCookie(await this.newSession(body.ua), SESSION_DAYS) });
    }
    if (op === 'reset') {
      const u = this.user();
      const w = weak(body.password); if (w) return json({ error: w }, 400);
      if (!u || !(await this.useToken('reset', body.token))) return json({ error: 'That link has expired or was already used. Ask for a new one.' }, 400);
      await this.setPassword(String(body.password));
      // Everything signed in with the old password is signed out; linked Macs keep their own tokens.
      this.sql.exec('DELETE FROM sessions'); this.sql.exec('DELETE FROM fails'); this.sql.exec('DELETE FROM push'); this.sql.exec('DELETE FROM push_pairs');
      this.sql.exec('UPDATE user SET verified = 1');
      for (const ws of this.ctx.getWebSockets('phone')) { try { ws.close(4001, 'password changed'); } catch {} }
      return json({ ok: true, email: u.email }, 200, { 'set-cookie': sessionCookie(await this.newSession(body.ua), SESSION_DAYS) });
    }

    // ---- session needed ----
    const sess = await this.session(req.headers.get('x-session'));
    if (!sess) return json({ error: 'Not signed in' }, 401, { 'set-cookie': sessionCookie('', 0) });
    if (op === 'me') return json({ email: this.user()?.email, macs: this.macList() });
    if (op === 'logout' && req.method === 'POST') {
      this.sql.exec('DELETE FROM sessions WHERE hash = ?', sess.hash);
      this.dropPush(this.sql.exec('SELECT id FROM push WHERE session = ?', sess.hash).toArray().map((r) => r.id));
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    }
    if (op === 'delete-account' && req.method === 'POST') {
      // Needs the password again. Deletes everything this account holds and disconnects its Macs and phones.
      const c = await this.checkPassword(body);
      if (!c.ok) return json({ error: c.error === 'Wrong email or password.' ? 'Wrong password.' : c.error }, c.status);
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(4003, 'account deleted'); } catch {} }
      await this.ctx.storage.deleteAll();
      this.init();
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
    }
    // ---- notifications on this device (Web Push) ----
    if (op === 'push/subscribe' && req.method === 'POST') {
      const sub = body.sub || {};
      if (!validEndpoint(sub.endpoint, this.env.DEV_PUSH_ORIGIN) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.endpoint.length > 1000) return json({ error: 'This browser’s push service isn’t supported.' }, 400);
      const pairs = (Array.isArray(body.pairs) ? body.pairs : []).slice(0, 10).filter((x) => /^[\w-]{1,20}$/.test(x?.mac || '') && /^[\w-]{22}$/.test(x?.tag || ''));
      let row = this.sql.exec('SELECT id FROM push WHERE endpoint = ?', sub.endpoint).toArray()[0];
      if (!row) {
        if (this.sql.exec('SELECT COUNT(*) AS n FROM push').one().n >= 20) return json({ error: 'Too many devices have notifications on. Turn them off on one first.' }, 400);
        row = { id: rand(9) };
        this.sql.exec('INSERT INTO push (id, endpoint, p256dh, auth, session, created) VALUES (?, ?, ?, ?, ?, ?)', row.id, sub.endpoint, sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100), sess.hash, Date.now());
      } else this.sql.exec('UPDATE push SET p256dh = ?, auth = ?, session = ? WHERE id = ?', sub.keys.p256dh.slice(0, 200), sub.keys.auth.slice(0, 100), sess.hash, row.id);
      this.sql.exec('DELETE FROM push_pairs WHERE push_id = ?', row.id);
      for (const x of pairs) this.sql.exec('INSERT INTO push_pairs (push_id, mac_id, tag) VALUES (?, ?, ?)', row.id, x.mac, x.tag);
      return json({ ok: true, macs: pairs.length });
    }
    if (op === 'push/unsubscribe' && req.method === 'POST') {
      this.dropPush(this.sql.exec('SELECT id FROM push WHERE endpoint = ?', String(body.endpoint || '')).toArray().map((r) => r.id));
      return json({ ok: true });
    }
    const rm = op.match(/^macs\/([\w-]+)$/);
    if (rm && req.method === 'DELETE') {
      this.sql.exec('DELETE FROM macs WHERE id = ?', rm[1]);
      this.sql.exec('DELETE FROM push_pairs WHERE mac_id = ?', rm[1]);
      for (const ws of [...this.ctx.getWebSockets(`mac:${rm[1]}`), ...this.ctx.getWebSockets(`pmac:${rm[1]}`)]) { try { ws.close(4003, 'removed'); } catch {} }
      return json({ ok: true });
    }
    return json({ error: 'Not found' }, 404);
  }

  dropPush(ids) {
    for (const id of ids) { this.sql.exec('DELETE FROM push WHERE id = ?', id); this.sql.exec('DELETE FROM push_pairs WHERE push_id = ?', id); }
  }
  // The Mac asks for notifications: [{ t: phone tag, n: text sealed for that phone }]. Up to 60 per 10 minutes per Mac.
  async notify(macId, list) {
    const vapid = vapidFromEnv(this.env);
    if (!vapid || !Array.isArray(list)) return;
    const since = Date.now() - 600e3;
    this.sql.exec('DELETE FROM push_log WHERE ts < ?', since);
    for (const item of list.slice(0, 10)) {
      if (typeof item?.t !== 'string' || typeof item?.n !== 'string' || item.n.length > 2800) continue;
      const subs = this.sql.exec('SELECT p.* FROM push p JOIN push_pairs x ON x.push_id = p.id WHERE x.mac_id = ? AND x.tag = ?', macId, item.t).toArray();
      for (const sub of subs) {
        if (this.sql.exec('SELECT COUNT(*) AS n FROM push_log WHERE mac_id = ?', macId).one().n >= 60) return;
        this.sql.exec('INSERT INTO push_log (mac_id, ts) VALUES (?, ?)', macId, Date.now());
        try {
          const status = await sendPush(sub, { v: 1, m: macId, n: item.n }, vapid);
          if (status === 404 || status === 410) this.dropPush([sub.id]);
        } catch (e) { console.error('push', e.message); }
      }
    }
  }

  // ---- pass frames between a Mac and its phones (opaque, end-to-end encrypted) ----
  async webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 1048576) return;
    const tags = this.ctx.getTags(ws);
    if (tags.includes('mac')) {
      if (msg === 'ping') { ws.send('pong'); return; }
      let m; try { m = JSON.parse(msg); } catch { return; }
      const macId = tags.find((t) => t.startsWith('mac:')).slice(4);
      if (m.notify) return this.notify(macId, m.notify);
      const phone = this.ctx.getWebSockets(`conn:${m.c}`).find((w) => this.ctx.getTags(w).includes(`pmac:${macId}`));
      if (!phone) { if (!m.close) ws.send(JSON.stringify({ c: m.c, close: true })); return; }
      if (m.close) { try { phone.close(4004, 'closed by Mac'); } catch {} return; }
      if (typeof m.d === 'string') phone.send(m.d);
    } else {
      if (msg === 'ping') { ws.send('pong'); return; }
      const macId = tags.find((t) => t.startsWith('pmac:')).slice(5);
      const conn = tags.find((t) => t.startsWith('conn:')).slice(5);
      const mac = this.ctx.getWebSockets(`mac:${macId}`)[0];
      if (!mac) { ws.send(JSON.stringify({ relay: 'offline' })); return; }
      mac.send(JSON.stringify({ c: conn, d: msg }));
    }
  }
  webSocketClose(ws, code) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('mac')) {
      const macId = tags.find((t) => t.startsWith('mac:')).slice(4);
      this.sql.exec('UPDATE macs SET last_seen = ? WHERE id = ?', Date.now(), macId);
      // Only if no newer socket replaced this one.
      if (!this.ctx.getWebSockets(`mac:${macId}`).some((w) => w !== ws)) {
        for (const p of this.ctx.getWebSockets(`pmac:${macId}`)) { try { p.send(JSON.stringify({ relay: 'offline' })); p.close(4002, 'Mac offline'); } catch {} }
      }
    } else {
      const macId = tags.find((t) => t.startsWith('pmac:'))?.slice(5);
      const conn = tags.find((t) => t.startsWith('conn:'))?.slice(5);
      const mac = macId && this.ctx.getWebSockets(`mac:${macId}`)[0];
      if (mac) { try { mac.send(JSON.stringify({ c: conn, close: true })); } catch {} }
    }
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch {}
  }
  webSocketError(ws) { this.webSocketClose(ws, 1011); }
}
