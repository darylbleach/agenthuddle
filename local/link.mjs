// The Mac's side of phone access: signs the Mac in to an Agent Huddle account, keeps a connection
// open to the relay (app.agenthuddle.net), pairs phones from a QR code, and serves each paired phone
// through an end-to-end encrypted channel (see tunnel.mjs). Requests from a phone are handled in this
// process exactly like the Mac app's own requests, using a sign-in the link keeps for itself.
// Everything it stores (account token, keys, paired phones) goes in the encrypted database.
import os from 'node:os';
import { createRequire } from 'node:module';
import { genKeyPair, exportPub, importPub, sessionKeys, pairProof, Channel, randomB64u, b64u, unb64u, notifyKey, sealNotify, phoneTag } from './tunnel.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

/**
 * kv: { get(k), set(k, v) } in the encrypted database.
 * local: { fetch(Request) -> Response, openSocket(path, cookie, real) -> side, socketMessage(side, data), closeSocket(side) }
 * login(): a fresh local session id (cookie value) for the link's own requests.
 */
export function createLink({ kv, relayUrl, local, login, port }) {
  let st = kv.get('link') || {};
  const save = () => kv.set('link', st);
  let ws = null, online = false, retry = 0, stopped = false, pingTimer = null, sid = null, lastError = '';
  const conns = new Map();
  const notifyKeys = new Map(); // phone pub -> { key, tag }

  async function macKeys() {
    if (!st.keyJwk) {
      const kp = await genKeyPair(true);
      st.keyJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
      st.pub = await exportPub(kp.publicKey);
      save();
    }
    return crypto.subtle.importKey('jwk', st.keyJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  }

  // ---------- relay connection ----------
  function connect() {
    if (stopped || !st.token || ws) return;
    const u = relayUrl.replace(/^http/, 'ws') + '/link/mac';
    const sock = new WebSocket(u, { headers: { authorization: `Bearer ${st.accountId}.${st.macId}.${st.token}` }, handshakeTimeout: 15000 });
    ws = sock;
    sock.on('open', () => { online = true; retry = 0; lastError = ''; clearInterval(pingTimer); pingTimer = setInterval(() => { try { sock.send('ping'); } catch {} }, 25000); });
    sock.on('message', (data) => {
      const text = data.toString();
      if (text === 'pong') return;
      let m; try { m = JSON.parse(text); } catch { return; }
      if (!m.c) return;
      if (m.open) { conns.get(m.c)?.end(); conns.set(m.c, newConn(m.c)); return; }
      if (m.close) { conns.get(m.c)?.end(); conns.delete(m.c); return; }
      let c = conns.get(m.c);
      if (!c) { c = newConn(m.c); conns.set(m.c, c); }
      if (typeof m.d === 'string') c.frame(m.d);
    });
    sock.on('unexpected-response', (_req, res) => { lastError = res.statusCode === 401 ? 'This Mac was removed from your account. Sign in again.' : `Relay answered ${res.statusCode}`; if (res.statusCode === 401) { st.token = null; save(); } });
    sock.on('error', (e) => { lastError = lastError || e.message; });
    sock.on('close', () => {
      online = false; ws = null; clearInterval(pingTimer);
      for (const c of conns.values()) c.end();
      conns.clear();
      if (!stopped && st.token) { const wait = Math.min(60e3, 1000 * 2 ** retry++); setTimeout(connect, wait); }
    });
  }
  const toRelay = (c, d) => { try { ws?.send(JSON.stringify({ c, d })); } catch {} };

  // ---------- one phone connection ----------
  function newConn(id) {
    let chan = null, ended = false, phonePub = null;
    const sockets = new Map(); // ws id -> local side
    const plain = (obj) => toRelay(id, JSON.stringify(obj));
    const fail = (e) => { plain({ t: 'err', e }); end(); try { ws?.send(JSON.stringify({ c: id, close: true })); } catch {} };
    function end() {
      if (ended) return; ended = true;
      for (const side of sockets.values()) local.closeSocket(side);
      sockets.clear();
    }
    async function hello(f, pub) {
      phonePub = pub;
      const nM = randomB64u(16);
      const keys = await sessionKeys(await macKeys(), pub, f.n, nM, 'mac');
      chan = new Channel(keys, (frame) => toRelay(id, frame));
      plain({ t: 'hello-ok', n: nM, v: 1 });
      const ph = st.phones.find((p) => p.pub === pub);
      if (ph) { ph.lastSeen = Date.now(); save(); }
    }
    async function frame(text) {
      if (ended) return;
      let f; try { f = JSON.parse(text); } catch { return; }
      try {
        if (!chan) {
          st.phones ||= [];
          if (f.t === 'pair') {
            const p = st.pair;
            if (!p || p.expires < Date.now()) return fail('pair-expired');
            const name = String(f.name || 'Phone').replace(/[<>"'`]/g, '').slice(0, 40) || 'Phone';
            const want = await pairProof(p.secret, st.macId, f.pub, name);
            if (typeof f.proof !== 'string' || want.length !== f.proof.length || want !== f.proof) return fail('pair-bad');
            await importPub(f.pub); // must be a valid key
            st.pair = null;
            if (!st.phones.some((x) => x.pub === f.pub)) st.phones.push({ id: randomB64u(6), name, pub: f.pub, added: Date.now() });
            save();
            return hello(f, f.pub);
          }
          if (f.t === 'hello') {
            if (!st.phones.some((x) => x.pub === f.pub)) return fail('not-paired');
            return hello(f, f.pub);
          }
          return fail('expected-hello');
        }
        const msg = await chan.receive(f);
        if (msg) await handle(msg);
      } catch (e) { fail('bad-frame'); }
    }
    async function handle(msg) {
      if (msg.k === 'req') {
        const res = await request(msg).catch((e) => ({ s: 502, h: { 'content-type': 'application/json' }, b: b64u(new TextEncoder().encode(JSON.stringify({ error: e.message }))) }));
        return chan.send({ k: 'res', id: msg.id, ...res });
      }
      if (msg.k === 'ws-open') {
        if (sockets.size >= 4) return chan.send({ k: 'ws-closed', id: msg.id, code: 1013 });
        const real = { send: (d) => chan?.send({ k: 'ws-msg', id: msg.id, d: String(d) }), close: (code) => { sockets.delete(msg.id); chan?.send({ k: 'ws-closed', id: msg.id, code: code || 1000 }); } };
        const side = await local.openSocket(String(msg.p || '/api/ws'), await cookie(), real);
        if (!side) return chan.send({ k: 'ws-closed', id: msg.id, code: 4001 });
        sockets.set(msg.id, side);
        return chan.send({ k: 'ws-open-ok', id: msg.id });
      }
      if (msg.k === 'ws-send') { const s = sockets.get(msg.id); if (s) local.socketMessage(s, String(msg.d)); return; }
      if (msg.k === 'ws-close') { const s = sockets.get(msg.id); if (s) { sockets.delete(msg.id); local.closeSocket(s); } }
    }
    return { frame, end, get phonePub() { return phonePub; } };
  }

  // ---------- requests from a phone, run like the Mac app's own ----------
  async function cookie() { if (!sid) sid = await login(); return `ar=${sid}`; }
  async function request(msg, again = false) {
    const p = String(msg.p || '/');
    if (!p.startsWith('/') || p.startsWith('//') || /^\/api\/phone(\/|$)/.test(p) || p === '/logout') return { s: 403, h: { 'content-type': 'application/json' }, b: b64u(new TextEncoder().encode('{"error":"Not available from a phone"}')) };
    const method = String(msg.m || 'GET').toUpperCase();
    const headers = new Headers({ host: `127.0.0.1:${port}`, cookie: await cookie() });
    for (const k of ['content-type', 'x-ar', 'accept']) if (msg.h?.[k]) headers.set(k, String(msg.h[k]));
    const body = msg.b && method !== 'GET' && method !== 'HEAD' ? unb64u(msg.b) : undefined;
    const r = await local.fetch(new Request(`http://127.0.0.1:${port}${p}`, { method, headers, body }));
    if (r.status === 401 && !again) { sid = null; return request(msg, true); }
    const h = {};
    for (const k of ['content-type', 'cache-control', 'content-disposition']) { const v = r.headers.get(k); if (v) h[k] = v; }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > 30 * 1024 * 1024) return { s: 413, h: {}, b: '' };
    return { s: r.status, h, b: b64u(buf) };
  }

  // ---------- the Mac app's Phone settings ----------
  const api = {
    status() {
      return {
        linked: !!st.token, email: st.email || null, macName: st.macName || null, online, error: lastError || null, notify: st.notify || 'approvals',
        relay: relayUrl, phones: (st.phones || []).map(({ id, name, added, lastSeen }) => ({ id, name, added, lastSeen: lastSeen || null })),
        pairing: st.pair && st.pair.expires > Date.now() ? { expires: st.pair.expires } : null,
      };
    },
    async link({ email, password, create, name }) {
      await macKeys();
      const r = await fetch(`${relayUrl}/api/mac/register`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ah': '1' }, body: JSON.stringify({ email, password, create: !!create, name: name || os.hostname().replace(/\.local$/, '') }) });
      const j = await r.json().catch(() => ({}));
      // A new account confirms its email first; the person signs in again after clicking the link.
      if (!r.ok) throw Object.assign(new Error(j.error || `The relay answered ${r.status}`), { unverified: !!j.unverified });
      // Phones are paired per account: signing in to a different account starts with none.
      if (st.accountId && st.accountId !== j.accountId) { st.phones = []; st.pair = null; notifyKeys.clear(); }
      Object.assign(st, { email: j.email, accountId: j.accountId, macId: j.macId, token: j.token, macName: name || os.hostname().replace(/\.local$/, '') });
      save(); try { ws?.close(); } catch {} ws = null; connect();
      return api.status();
    },
    unlink() {
      st.token = null; st.accountId = null; st.macId = null; st.phones = []; st.pair = null; save();
      try { ws?.close(); } catch {}
      return api.status();
    },
    async startPairing() {
      if (!st.token) throw new Error('Sign in first.');
      await macKeys();
      st.pair = { secret: randomB64u(32), expires: Date.now() + 10 * 60e3 }; save();
      // Everything after # stays in the browser: the relay never sees the secret or the key.
      return { url: `${relayUrl}/#pair=${st.macId}.${st.pair.secret}.${st.pub}`, expires: st.pair.expires };
    },
    setNotify(mode) {
      if (!['approvals', 'all', 'off'].includes(mode)) throw new Error('Unknown setting');
      st.notify = mode; save();
      return api.status();
    },
    /** A notification for paired phones (only those that turned notifications on get it; the relay routes by tag). */
    async notify({ kind, title, body, roomId, tag }) {
      const mode = st.notify || 'approvals';
      const dbg = (...a) => process.env.AH_DEBUG && console.error('[notify]', ...a);
      dbg(kind, 'online', online, 'mode', mode, 'phones', (st.phones || []).length, 'conns', conns.size);
      if (!online || !ws || mode === 'off' || (kind !== 'approval' && mode !== 'all')) return 0;
      const live = new Set([...conns.values()].map((c) => c.phonePub).filter(Boolean)); // phones open right now see it already
      const priv = await macKeys();
      const list = [];
      for (const ph of st.phones || []) {
        if (live.has(ph.pub)) continue;
        let k = notifyKeys.get(ph.pub);
        if (!k) { k = { key: await notifyKey(priv, ph.pub), tag: await phoneTag(ph.pub) }; notifyKeys.set(ph.pub, k); }
        list.push({ t: k.tag, n: await sealNotify(k.key, st.macId, { title: String(title).slice(0, 120), body: String(body || '').slice(0, 400), roomId: roomId || null, tag: tag || null, kind }) });
      }
      dbg('sending', list.length, 'live', live.size);
      if (list.length) { try { ws.send(JSON.stringify({ notify: list.slice(0, 10) })); } catch (e) { dbg('send failed', e.message); } }
      return list.length;
    },
    removePhone(phoneId) {
      const gone = (st.phones || []).find((p) => p.id === phoneId);
      st.phones = (st.phones || []).filter((p) => p.id !== phoneId); save();
      if (gone) notifyKeys.delete(gone.pub);
      // Cut off that phone straight away if it's connected.
      for (const [cid, c] of conns) if (gone && c.phonePub === gone.pub) { c.end(); conns.delete(cid); try { ws?.send(JSON.stringify({ c: cid, close: true })); } catch {} }
      return api.status();
    },
  };
  connect();
  return { api, stop() { stopped = true; try { ws?.close(); } catch {} } };
}
