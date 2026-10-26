// Plan-usage readers for each CLI (5-hour and weekly limits, model lists).
// Each one asks the vendor's own CLI/login for your subscription limits — none of them
// sends a prompt or spends model usage.
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

// The runner tells us how to run each CLI as its own user (see users.mjs); by default, as ourselves.
let runAs = (cmd, env) => ({ opts: { env }, home: os.homedir(), readFile: (rel) => { try { return fs.readFileSync(path.join(os.homedir(), rel), 'utf8'); } catch { return null; } } });
export function configureUsage(fn) { runAs = fn; }

// ---------- helpers ----------
function runCmd(cmd, args, { env, timeoutMs = 40000, cwd } = {}) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    let p;
    try { const o = runAs(cmd, env).opts; p = spawn(cmd, args, { ...o, cwd: cwd || o.cwd || os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const t = setTimeout(() => { if (!done) { done = true; p.kill('SIGKILL'); resolve({ code: -1, out, err: err + '\ntimed out' }); } }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ code: -1, out, err: e.code === 'ENOENT' ? 'not installed' : e.message }); } });
    p.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ code, out, err }); } });
  });
}
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
function toDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) { const n = Number(v); return new Date(n > 1e12 ? n : n * 1000).toISOString(); }
  const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
// One run at a time per CLI: two Codex processes starting together corrupt its local state db.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
const NAMES = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity', grok: 'Grok', 'cursor-agent': 'Cursor' };
const signedOut = (s) => /not logged in|log ?in|sign ?in|unauthori[sz]ed|authenticat|\b401\b|expired/i.test(s || '');
const minutesLabel = (m) => m == null ? 'Limit' : (m >= 290 && m <= 310) ? '5-hour' : (m >= 10000 && m <= 10100) ? 'Weekly' : m >= 1440 ? `${Math.round(m / 1440)}-day` : `${Math.round(m / 60)}-hour`;

// ---------- Claude: claude -p /usage ----------
async function claudeUsage(env) {
  const r = await runCmd('claude', ['-p', '/usage', '--output-format', 'json', '--max-turns', '1', '--no-session-persistence'], { env, timeoutMs: 45000 });
  let text = '';
  try { text = JSON.parse(r.out).result || ''; } catch { text = r.out; }
  if (!text.trim() || (signedOut(text) && !/% used/.test(text))) {
    return { status: 'needs-login', error: signedOut(r.err + text) || !text.trim() ? 'Claude Code is not signed in, or this login can’t read plan usage.' : (r.err || 'No answer from Claude Code').slice(-300) };
  }
  if (/Total cost:/.test(text) && !/% used/.test(text)) return { status: 'unavailable', error: 'Claude Code is using an API key here, which has no plan limits to show.' };
  const windows = [];
  const line = (title, label) => {
    const re = new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`:\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+([^(\n]+?)\s*\(([^)]+)\))?`);
    const m = text.match(re);
    if (m) windows.push({ label, usedPercent: Number(m[1]), resetsText: m[2] ? `${m[2].trim()} (${m[3]})` : null });
  };
  line('Current session', '5-hour');
  line('Current week (all models)', 'Weekly');
  for (const m of text.matchAll(/Current week \(([^)]+)\)/g)) if (m[1] !== 'all models') line(`Current week (${m[1]})`, `Weekly ${m[1]}`);
  if (!windows.length) return { status: 'error', error: 'No plan limits in Claude Code’s /usage output.', raw: text.slice(0, 400) };
  return { status: 'ok', windows, note: 'From Claude Code /usage' };
}

// ---------- Codex: codex app-server → account/rateLimits/read ----------
function codexRpc(env, method, params = {}, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let p;
    try { const o = runAs('codex', env).opts; p = spawn('codex', ['app-server'], { ...o, cwd: o.cwd || os.tmpdir(), stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: e.message }); }
    let buf = '', err = '', finished = false;
    const finish = (v) => { if (finished) return; finished = true; clearTimeout(t); try { p.kill('SIGKILL'); } catch {} resolve(v); };
    const t = setTimeout(() => finish({ error: 'Codex app server timed out' }), timeoutMs);
    p.stdin.on('error', () => {});
    const send = (o) => { try { p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n'); } catch {} };
    p.on('error', (e) => finish({ error: e.code === 'ENOENT' ? 'Codex CLI not installed' : e.message }));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => finish({ error: (err || 'Codex app server exited').slice(-300) }));
    p.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const lineStr = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!lineStr) continue;
        let o; try { o = JSON.parse(lineStr); } catch { continue; }
        if (o.id === 1) {
          if (!o.result) return finish({ error: o.error?.message || 'Codex app server refused to start' });
          send({ method: 'initialized', params: {} });
          send({ id: 2, method, params });
        } else if (o.id === 2) {
          finish(o.result ? { result: o.result } : { error: o.error?.message || 'No answer' });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agenthuddle', version: '1' } } });
  });
}
async function codexCall(env, method, params) {
  let r = await codexRpc(env, method, params);
  if (r.error && /sqlite|state runtime|database is locked/i.test(r.error)) { await new Promise((ok) => setTimeout(ok, 2000)); r = await codexRpc(env, method, params); }
  return r;
}
async function codexUsage(env) {
  const r = await codexCall(env, 'account/rateLimits/read');
  if (r.error) return { status: signedOut(r.error) ? 'needs-login' : 'error', error: r.error };
  const limits = r.result.rateLimits || {};
  const windows = ['primary', 'secondary'].map((k) => limits[k]).filter((w) => w && num(w.usedPercent) != null)
    .map((w) => ({ label: minutesLabel(num(w.windowDurationMins)), usedPercent: num(w.usedPercent), resetsAt: toDate(w.resetsAt) }));
  if (!windows.length) return { status: 'error', error: 'Codex returned no limits.' };
  const credits = (r.result.rateLimitResetCredits?.credits || []).filter((c) => c.status === 'available');
  return {
    status: 'ok', windows,
    plan: limits.planType ? `ChatGPT ${limits.planType[0].toUpperCase()}${limits.planType.slice(1)}` : null,
    note: credits.length ? `${credits.length} free full reset${credits.length === 1 ? '' : 's'} available` : 'From the Codex app server',
  };
}

// ---------- Antigravity: agy -p /quota ----------
async function antigravityUsage(env) {
  const r = await runCmd('agy', ['-p', '/quota', '--output-format', 'json', '--print-timeout', '30s'], { env, timeoutMs: 45000 });
  let obj; try { obj = JSON.parse(r.out); } catch {}
  const groups = obj?.command?.data?.groups;
  if (!Array.isArray(groups)) {
    const msg = (r.err || r.out || 'No answer from agy');
    if (signedOut(msg) || /oauth2|Waiting for authentication/i.test(msg)) return { status: 'needs-login', error: 'Antigravity isn’t signed in on the agent computer.' };
    return { status: 'error', error: msg.slice(-300) };
  }
  const windows = [];
  for (const g of groups) {
    const name = g.name || 'Model';
    for (const b of g.buckets || []) {
      const rem = num(b.remaining_fraction);
      if (rem == null || rem < 0 || rem > 1) continue;
      const label = `${b.window === '5h' ? '5-hour' : 'Weekly'} ${name}`;
      if (!windows.some((w) => w.label === label)) windows.push({ label, usedPercent: Math.round((1 - rem) * 1000) / 10, resetsAt: toDate(b.reset_time) });
    }
  }
  if (!windows.length) return { status: 'error', error: 'Antigravity reported no quota buckets.' };
  return { status: 'ok', windows, note: 'From the Antigravity CLI' };
}

// ---------- Grok: CLI login → billing endpoint ----------
function readGrokAuth(env = {}) {
  const data = JSON.parse(runAs('grok', env).readFile('.grok/auth.json') || 'null');
  const key = Object.keys(data).find((k) => k.startsWith('https://auth.x.ai::')) || Object.keys(data)[0];
  const rec = data[key];
  if (!rec?.key) throw new Error('no session');
  return rec;
}
async function grokUsage(env) {
  let auth;
  try { auth = readGrokAuth(env); } catch { return { status: 'needs-login', error: 'Grok isn’t signed in. Use Sign in with device code in Accounts.' }; }
  const call = async (a) => {
    const headers = { Authorization: `Bearer ${a.key}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-mode': 'headless' };
    if (a.user_id) headers['x-userid'] = a.user_id;
    try { const v = JSON.parse(runAs('grok', env).readFile('.grok/version.json') || 'null')?.version; if (v) headers['x-grok-client-version'] = v; } catch {}
    return fetch('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers, signal: AbortSignal.timeout(20000) });
  };
  let res = await call(auth).catch((e) => ({ ok: false, status: 0, e }));
  if (res.status === 401) { await runCmd('grok', ['models'], { env, timeoutMs: 15000 }); try { auth = readGrokAuth(env); } catch {} res = await call(auth).catch(() => ({ ok: false, status: 0 })); }
  if (res.status === 401) return { status: 'needs-login', error: 'Grok session expired. Sign in again from Accounts.' };
  if (!res.ok) return { status: 'error', error: `Grok billing returned HTTP ${res.status}` };
  const c = (await res.json()).config || {};
  let used = num(c.creditUsagePercent);
  if (used == null && num(c.used?.val) != null && num(c.monthlyLimit?.val) > 0) used = Math.round(c.used.val / c.monthlyLimit.val * 1000) / 10;
  if (used == null && c.currentPeriod) used = 0;
  const period = (c.currentPeriod?.type || '').replace(/^USAGE_PERIOD_TYPE_/, '').toLowerCase();
  const label = period ? period[0].toUpperCase() + period.slice(1) : 'Plan';
  const resetsAt = toDate(c.currentPeriod?.end || c.billingPeriodEnd);
  const windows = used == null ? [] : [{ label, usedPercent: used, resetsAt }];
  for (const p of c.productUsage || []) {
    if (p.product) windows.push({ label: `${label} · ${String(p.product).replace(/^PRODUCT_/, '').replace(/_/g, ' ').toLowerCase()}`, usedPercent: num(p.usagePercent) ?? 0, resetsAt });
  }
  if (!windows.length) return { status: 'error', error: 'Grok returned no usage.' };
  const extra = num(c.onDemandUsed?.val);
  return { status: 'ok', windows, note: extra > 0 ? `Extra usage: $${(extra / 100).toFixed(2)}` : 'Shared across Grok apps' };
}

// ---------- Cursor ----------
async function cursorUsage(env) {
  const r = await runCmd('cursor-agent', ['status'], { env, timeoutMs: 20000 });
  if (r.err === 'not installed') return { status: 'error', error: 'Cursor Agent isn’t installed in the container.' };
  const text = (r.out + r.err).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
  if (signedOut(text) && !/logged in as|signed in/i.test(text)) return { status: 'needs-login', error: 'Cursor isn’t signed in.' };
  return { status: 'unavailable', note: (text.split('\n').find((l) => /logged in|signed in|plan|account/i.test(l)) || 'Signed in').trim(), error: 'Cursor’s CLI doesn’t report plan usage.' };
}

const READERS = { claude: claudeUsage, codex: codexUsage, agy: antigravityUsage, grok: grokUsage, 'cursor-agent': cursorUsage };

/** kinds: { agentId: cliCommand } → { agentId: snapshot } */
export async function readUsage(kinds, env) {
  const out = {};
  await Promise.all(Object.entries(kinds).map(async ([id, kind]) => {
    // "claude@work" = the Claude CLI signed in to the extra account "work".
    const [cmd, account] = String(kind).split('@');
    const reader = READERS[cmd];
    if (!reader) { out[id] = { status: 'unavailable', error: 'No usage reader for this CLI.' }; return; }
    // An extra account uses only its own login, never the main account's saved tokens.
    const e = account ? { AR_ACCOUNT: account } : env;
    try {
      const r = await withLock(kind, () => reader(e));
      if (r.error === 'not installed') r.error = `${cmd} isn’t installed in the container.`;
      if (r.status === 'needs-login' && (!r.error || r.error.length > 120)) r.error = `${NAMES[cmd] || cmd} isn’t signed in on the agent computer.`;
      out[id] = { ...r, at: new Date().toISOString() };
    }
    catch (e) { out[id] = { status: 'error', error: e.message, at: new Date().toISOString() }; }
  }));
  return out;
}

// ---------- Model lists ----------
// Every list is [{ id, label }]: id is what goes to the CLI's model flag, label is the full name shown in the picker.
const WORD = { gpt: 'GPT', ai: 'AI', xl: 'XL', 'o1': 'o1', 'o3': 'o3', 'o4': 'o4' };
export function prettyModel(id) {
  return String(id).replace(/^models\//, '').split(/[-_\s]+/).filter(Boolean)
    .map((w) => WORD[w.toLowerCase()] || (/^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1))).join(' ')
    .replace(/(\d) (\d)(?!\.)/g, '$1.$2'); // claude-opus-5-5 → Opus 5.5
}
// Claude models for Claude Code's --model. We never read the Claude.ai login token for this (Anthropic's
// terms don't allow third-party apps to use it), so: the live list from the Models API when an Anthropic
// API key is set, otherwise this list from Anthropic's models and deprecations pages (October 2026).
// Update it when Anthropic releases or retires a model; "Other model…" in the picker takes any ID.
const CLAUDE_MODELS = [
  { id: 'best', label: 'Best available (Fable, else Opus)', group: 'Shortcuts' },
  { id: 'opus', label: 'Opus (latest)', group: 'Shortcuts' },
  { id: 'sonnet', label: 'Sonnet (latest)', group: 'Shortcuts' },
  { id: 'haiku', label: 'Haiku (latest)', group: 'Shortcuts' },
  { id: 'fable', label: 'Fable (latest)', group: 'Shortcuts' },
  { id: 'opusplan', label: 'Opus to plan, Sonnet to build', group: 'Shortcuts' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', group: 'Current' },
  { id: 'claude-mythos-5-1', label: 'Claude Mythos 5.1', group: 'Current' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', group: 'Current' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', group: 'Current' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', group: 'Current' },
  { id: 'claude-fable-5', label: 'Claude Fable 5', group: 'Earlier' },
  { id: 'claude-mythos-5', label: 'Claude Mythos 5', group: 'Earlier' },
  { id: 'claude-opus-5', label: 'Claude Opus 5', group: 'Earlier' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', group: 'Earlier' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', group: 'Earlier' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', group: 'Earlier' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', group: 'Earlier' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', group: 'Earlier' },
  { id: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5', group: 'Earlier' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', group: 'Earlier' },
  { id: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5 (retiring 30 Nov 2026)', group: 'Earlier' },
];
async function claudeModels(env) {
  const key = env.ANTHROPIC_API_KEY;
  if (key) {
    const out = []; let after = null;
    try {
      for (let page = 0; page < 5; page++) {
        const u = new URL('https://api.anthropic.com/v1/models'); u.searchParams.set('limit', '100'); if (after) u.searchParams.set('after_id', after);
        const r = await fetch(u, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) break;
        const j = await r.json();
        for (const m of j.data || []) if (m.id) out.push({ id: m.id, label: m.display_name || prettyModel(m.id), group: 'Your API key' });
        if (!j.has_more) break; after = j.last_id;
      }
    } catch {}
    if (out.length) return { models: [...CLAUDE_MODELS.filter((m) => m.group === 'Shortcuts'), ...out], source: 'Anthropic models API' };
  }
  return { models: CLAUDE_MODELS, source: 'built-in list' };
}
function parseModelList(text) {
  const seen = new Map();
  for (const raw of text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n')) {
    const line = raw.replace(/^[\s*•\-–>|✓✔]+/, '').trim();
    const m = line.match(/^([a-z][a-z0-9._:/-]*[a-z0-9])(?:\s*(?:[-–—:|│(]\s*|\s{2,})(.+?))?\)?\s*(?:\((?:current|default)\))?$/i);
    if (!m) continue;
    const id = m[1];
    if (!/[-.\d]/.test(id) || id.length > 60 || /^https?:/.test(id)) continue;
    let label = (m[2] || '').replace(/\s*\((current|default)\)\s*$/i, '').trim();
    if (!label || label.length > 60 || label === id || /^(current|default|selected|active)$/i.test(label)) label = prettyModel(id);
    if (!seen.has(id)) seen.set(id, { id, label });
  }
  return [...seen.values()];
}
export function listModels(cmd, env) { return withLock(cmd, () => listModelsNow(cmd, env)); }
async function listModelsNow(cmd, env) {
  if (cmd === 'claude') return claudeModels(env);
  if (cmd === 'codex') {
    const r = await codexCall(env, 'model/list', {});
    const list = r.result?.data || r.result?.models || [];
    const models = list.map((m) => ({ id: m.id || m.model || m.slug, label: m.displayName || m.display_name || m.name || null }))
      .filter((m) => m.id).map((m) => ({ id: m.id, label: m.label && m.label !== m.id ? m.label : prettyModel(m.id) }));
    return { models, source: models.length ? 'codex app-server' : null, error: models.length ? null : (signedOut(r.error) ? 'Codex isn’t signed in on the agent computer.' : r.error) };
  }
  const tries = { agy: [['models']], grok: [['models']], 'cursor-agent': [['models'], ['--list-models']] }[cmd] || [];
  let lastText = '';
  for (const args of tries) {
    const r = await runCmd(cmd, args, { env, timeoutMs: 30000 });
    lastText = r.out + r.err;
    if (signedOut(lastText) && !/^\s*[a-z][\w.-]+\s/im.test(r.out)) break;
    const models = parseModelList(r.out || r.err);
    if (models.length) return { models, source: `${cmd} ${args.join(' ')}` };
  }
  if (signedOut(lastText)) return { models: [], error: `${NAMES[cmd] || cmd} isn’t signed in on the agent computer — sign in to load its models.` };
  return { models: [], error: 'Couldn’t list this CLI’s models.' };
}
