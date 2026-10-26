// End-to-end encryption between a paired phone (browser) and the Mac, used through the relay.
// Plain Web Crypto, so the same code runs in Node (the Mac) and in the browser (relay/build.mjs inlines it).
//
// Pairing: the Mac shows a QR code with its public key and a one-time secret. The phone makes its own
// key pair and proves it saw the QR code (HMAC with the secret), so the relay can't pair itself.
// Each session: ECDH(P-256) between the two long-term keys + fresh nonces from both sides -> HKDF ->
// one AES-256-GCM key per direction. Frames carry a counter that must go up by one, so the relay can't
// replay, drop silently or reorder anything; messages over ~180 KB are split into several frames.
const te = new TextEncoder(), td = new TextDecoder();
export const b64u = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
export const randomB64u = (n) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export const genKeyPair = (extractable = false) => crypto.subtle.generateKey(ECDH, extractable, ['deriveBits']);
export const exportPub = async (pub) => b64u(await crypto.subtle.exportKey('raw', pub));
export const importPub = (b64) => crypto.subtle.importKey('raw', unb64u(b64), ECDH, true, []);

export async function pairProof(secretB64, macId, phonePub, name) {
  const key = await crypto.subtle.importKey('raw', unb64u(secretB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, te.encode(`agenthuddle-pair|${macId}|${phonePub}|${name}`)));
}

/** role: 'phone' or 'mac'. nP / nM: base64url nonces (16 bytes) from the phone and the Mac. */
export async function sessionKeys(myPriv, theirPubB64, nP, nM, role) {
  const theirPub = await importPub(theirPubB64);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: theirPub }, myPriv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  const salt = new Uint8Array([...unb64u(nP), ...unb64u(nM)]);
  const derive = (info) => crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const p2m = await derive('agenthuddle v1 phone-to-mac'), m2p = await derive('agenthuddle v1 mac-to-phone');
  return role === 'phone' ? { send: p2m, recv: m2p } : { send: m2p, recv: p2m };
}

// ---------- notifications: the Mac encrypts each one for one paired phone ----------
// Same long-term keys as pairing, so ECDH(phone, Mac) gives both ends the same key. The relay only
// forwards the sealed text inside a Web Push message; the phone's service worker opens it.
export async function notifyKey(myPriv, theirPubB64) {
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: await importPub(theirPubB64) }, myPriv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: te.encode('agenthuddle v1 notify') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealNotify(key, macId, obj) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: te.encode(`ah-notify|${macId}`) }, key, te.encode(JSON.stringify(obj)));
  return `${b64u(nonce)}.${b64u(ct)}`;
}
export async function openNotify(key, macId, sealed) {
  const [n, c] = String(sealed).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(n), additionalData: te.encode(`ah-notify|${macId}`) }, key, unb64u(c));
  return JSON.parse(td.decode(pt));
}
/** A short tag for a phone's public key, so the relay can route a notification without knowing more. */
export const phoneTag = async (pubB64) => b64u(await crypto.subtle.digest('SHA-256', unb64u(pubB64))).slice(0, 22);

const iv = (n) => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, BigInt(n)); return b; };
const CHUNK = 180000;

/** An encrypted, ordered message channel over any string transport (sendRaw). */
export class Channel {
  constructor(keys, sendRaw) {
    this.keys = keys; this.sendRaw = sendRaw;
    this.out = 0; this.in = 0; this.msg = 0; this.parts = new Map();
    this.sendQ = Promise.resolve(); this.recvQ = Promise.resolve();
  }
  /** Encrypt and send one JSON message (split into frames if large). Frames go out in order. */
  send(obj) {
    const text = JSON.stringify(obj);
    const m = ++this.msg, n = Math.max(1, Math.ceil(text.length / CHUNK));
    this.sendQ = this.sendQ.then(async () => {
      for (let j = 0; j < n; j++) {
        const i = this.out++;
        const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv(i), additionalData: te.encode(`ah1|${i}|${m}|${j}|${n}`) }, this.keys.send, te.encode(text.slice(j * CHUNK, (j + 1) * CHUNK)));
        this.sendRaw(JSON.stringify({ t: 'x', i, m, j, n, ct: b64u(ct) }));
      }
    });
    return this.sendQ;
  }
  /** Feed one received frame (already JSON-parsed). Resolves with the message once complete, else null. Throws on tampering. */
  receive(f) {
    const p = this.recvQ.then(async () => {
      if (f.t !== 'x' || f.i !== this.in) throw new Error('Out-of-order or unexpected frame');
      if (!(Number.isInteger(f.n) && f.n >= 1 && f.n <= 200 && Number.isInteger(f.j) && f.j >= 0 && f.j < f.n)) throw new Error('Bad frame');
      this.in++;
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv(f.i), additionalData: te.encode(`ah1|${f.i}|${f.m}|${f.j}|${f.n}`) }, this.keys.recv, unb64u(f.ct));
      const text = td.decode(pt);
      if (f.n === 1) return JSON.parse(text);
      const got = this.parts.get(f.m) || [];
      got[f.j] = text; this.parts.set(f.m, got);
      if (got.filter((x) => x != null).length < f.n) return null;
      this.parts.delete(f.m);
      return JSON.parse(got.join(''));
    });
    this.recvQ = p.catch(() => {});
    return p;
  }
}
