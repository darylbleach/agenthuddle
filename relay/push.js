// Web Push from the relay (RFC 8291 message encryption + RFC 8292 VAPID), with plain Web Crypto.
// The relay only ever pushes a payload the Mac already encrypted for one paired phone (see tunnel.mjs
// sealNotify), so neither the relay nor the push service (Apple, Google, Mozilla) can read it.
const enc = new TextEncoder();
const b64u = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const concat = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

async function hkdf(salt, ikm, info, bytes) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, bytes * 8));
}

// Push services that browsers use. Anything else is refused, so the relay can't be pointed at other hosts.
export function validEndpoint(endpoint, devOrigin) {
  try {
    const u = new URL(endpoint);
    if (devOrigin && u.origin === devOrigin) return true; // local testing only (DEV_PUSH_ORIGIN in .dev.vars)
    return u.protocol === 'https:' && /^(fcm\.googleapis\.com|android\.googleapis\.com|([\w-]+\.)*push\.apple\.com|([\w-]+\.)*push\.services\.mozilla\.com|([\w-]+\.)*notify\.windows\.com)$/.test(u.hostname);
  } catch { return false; }
}

/** RFC 8291 aes128gcm body for one subscription ({ p256dh, auth } base64url). */
export async function encryptPayload(sub, plaintext) {
  const uaPub = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, ECDH, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(86);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = 65; header.set(asPub, 21);
  return concat(header, ct);
}

/** VAPID Authorization header (ES256 JWT signed with the relay's key). */
export async function vapidHeader(endpoint, vapid) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** Sends one push. Resolves with the push service's status (404/410 = the subscription is gone). */
export async function sendPush(sub, payload, vapid) {
  const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
  const r = await fetch(sub.endpoint, {
    method: 'POST', body,
    headers: { 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: 'high', authorization: await vapidHeader(sub.endpoint, vapid) },
  });
  return r.status;
}

export function vapidFromEnv(env) {
  if (!env.VAPID_PRIVATE || !env.VAPID_PUBLIC) return null;
  try { return { privateJwk: JSON.parse(env.VAPID_PRIVATE), publicKey: env.VAPID_PUBLIC, subject: env.VAPID_SUBJECT || 'https://app.agenthuddle.net' }; } catch { return null; }
}
