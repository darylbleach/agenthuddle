// agenthuddle.net: the website and its waitlist.
//
//  - Pages (index, terms, privacy, icons, social image) are bundled into pages.js by site/build.mjs.
//  - LAUNCHED = "1" switches the page from "Join the waitlist" to Download + Buy (wrangler.jsonc vars).
//  - POST /api/waitlist stores an email in D1 (WAITLIST) and sends one confirmation email with an
//    unsubscribe link (signed with WAITLIST_SECRET). Same answer whether or not the email was already there.
//  - www.agenthuddle.net redirects to agenthuddle.net.
import { PAGES } from './pages.js';

const enc = new TextEncoder();
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const validEmail = (e) => typeof e === 'string' && e.length <= 254 && /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(e);
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const SECURITY = {
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', 'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};

async function sign(env, text) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.WAITLIST_SECRET || 'dev-only-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(text))).slice(0, 32);
}
const hashIp = async (env, ip) => (await sign(env, `ip|${ip}|${new Date().toISOString().slice(0, 10)}`)).slice(0, 16);

function page(env, path) {
  const pg = PAGES[path];
  if (!pg) return null;
  let body = pg.b64 ? Uint8Array.from(atob(pg.body), (c) => c.charCodeAt(0)) : pg.body;
  if (path === '/') body = body.replace('__LAUNCHED__', env.LAUNCHED === '1' ? '1' : '0').replaceAll('__CHECKOUT__', env.CHECKOUT_URL || '#join').replaceAll('__FOUNDING__', env.FOUNDING_URL || '#join');
  return new Response(body, { headers: { 'content-type': pg.type, 'cache-control': pg.cache || 'public, max-age=300', ...SECURITY } });
}

function simple(title, text) {
  const html = `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Agent Huddle</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f2;color:#1f1e1c;font:16px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:20px}@media (prefers-color-scheme:dark){body{background:#191918;color:#ecebe8}}main{max-width:420px;text-align:center}a{color:#2f6fde}</style></head>
<body><main><h1 style="font-size:22px">${title}</h1><p>${text}</p><p><a href="/">agenthuddle.net</a></p></main></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } });
}

async function joinWaitlist(req, env) {
  const body = await req.json().catch(() => ({}));
  if (body.company) return json({ ok: true }); // honeypot: bots fill every field
  const email = String(body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
  const ip = req.headers.get('cf-connecting-ip') || 'local';
  const ipKey = await hashIp(env, ip);
  const now = Date.now();
  await env.WAITLIST.prepare('DELETE FROM hits WHERE ts < ?').bind(now - 3600e3).run();
  const { n } = await env.WAITLIST.prepare('SELECT COUNT(*) AS n FROM hits WHERE ip = ?').bind(ipKey).first();
  if (n >= 5 && env.RATE_LIMIT_OFF !== '1') return json({ error: 'Too many sign-ups from here. Try again in an hour.' }, 429);
  await env.WAITLIST.prepare('INSERT INTO hits (ip, ts) VALUES (?, ?)').bind(ipKey, now).run();
  const r = await env.WAITLIST.prepare('INSERT OR IGNORE INTO waitlist (email, created, country, source) VALUES (?, ?, ?, ?)')
    .bind(email, now, String(req.cf?.country || ''), String(body.source || '').slice(0, 200)).run();
  if (r.meta.changes) await confirm(env, email, new URL(req.url).origin);
  return json({ ok: true });
}

async function confirm(env, email, origin) {
  const link = `${origin}/unsubscribe?e=${encodeURIComponent(email)}&t=${await sign(env, `unsub|${email}`)}`;
  const text = `Thanks for joining the Agent Huddle waitlist.\n\nAgent Huddle puts Claude Code, Codex, Grok, Cursor and Antigravity in one chat on your Mac. They hand work to each other, and you approve what matters, from your Mac or your phone.\n\nWe'll email you once, when it launches, with first access to the founding lifetime price. Questions? Just reply.\n\nDaryl, Agent Huddle\nhttps://agenthuddle.net\n\nDidn't sign up, or changed your mind? Leave the list: ${link}`;
  const html = `<div style="font:15px/1.6 -apple-system,Segoe UI,sans-serif;color:#1f1e1c;max-width:520px">
<p>Thanks for joining the Agent Huddle waitlist.</p>
<p>Agent Huddle puts Claude Code, Codex, Grok, Cursor and Antigravity in one chat on your Mac. They hand work to each other, and you approve what matters, from your Mac or your phone.</p>
<p>We'll email you once, when it launches, with first access to the <b>founding lifetime price</b>. Questions? Just reply.</p>
<p>Daryl, Agent Huddle<br><a href="https://agenthuddle.net" style="color:#2f6fde">agenthuddle.net</a></p>
<p style="color:#6b6862;font-size:13px">Didn't sign up, or changed your mind? <a href="${link}" style="color:#6b6862">Leave the list</a>.</p></div>`;
  if (!env.EMAIL) { console.log(`[dev] waitlist email for ${email}: ${link}`); return; }
  try {
    await env.EMAIL.send({ from: { email: 'hello@agenthuddle.net', name: 'Agent Huddle' }, to: email, replyTo: 'hello@agenthuddle.net', subject: 'You’re on the Agent Huddle waitlist', text, html,
      headers: { 'List-Unsubscribe': `<${link}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  } catch (e) { console.error('waitlist email', e.message); }
}

async function unsubscribe(req, env) {
  const url = new URL(req.url);
  const email = String(url.searchParams.get('e') || '').toLowerCase();
  const ok = email && url.searchParams.get('t') === (await sign(env, `unsub|${email}`));
  if (!ok) return simple('That link didn’t work', 'Email <a href="mailto:hello@agenthuddle.net">hello@agenthuddle.net</a> and we’ll take you off the list.');
  if (req.method === 'GET' && !url.searchParams.has('confirm')) {
    // A button, so email scanners that open links don't unsubscribe people by accident.
    return simple('Leave the waitlist?', `<form method="post" action="/unsubscribe?${url.searchParams}"><button style="font:inherit;font-weight:600;padding:10px 18px;border-radius:10px;border:0;background:#2f6fde;color:#fff;cursor:pointer">Remove ${email.replace(/[<>&"]/g, '')}</button></form>`);
  }
  await env.WAITLIST.prepare('DELETE FROM waitlist WHERE email = ?').bind(email).run();
  return simple('You’ve left the waitlist', 'We’ve deleted your email address. Sorry to see you go.');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.hostname.startsWith('www.')) return Response.redirect(`https://${url.hostname.slice(4)}${url.pathname}${url.search}`, 301);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p === '/api/waitlist' && req.method === 'POST') {
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) return json({ error: 'Bad origin' }, 403);
      return joinWaitlist(req, env);
    }
    if (p === '/unsubscribe' && (req.method === 'GET' || req.method === 'POST')) return unsubscribe(req, env);
    if (p === '/download') return Response.redirect('https://updates.agenthuddle.net/AgentHuddle.dmg', 302);
    if (p === '/buy') return Response.redirect(env.CHECKOUT_URL || 'https://agenthuddle.net/#pricing', 302);
    if (req.method === 'GET' || req.method === 'HEAD') {
      const res = page(env, p === '/terms' ? '/terms.html' : p === '/privacy' ? '/privacy.html' : p);
      if (res) return res;
    }
    return new Response('Not found', { status: 404, headers: SECURITY });
  },
};
