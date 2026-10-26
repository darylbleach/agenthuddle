#!/usr/bin/env node
// A tiny MCP server (stdio) that Claude Code calls before it runs a command or edits a file
// (`--permission-prompt-tool mcp__agenthuddle__approve`). It asks the Agent Huddle runner, which shows
// Approve / Deny in the chat and waits for you. It can only *ask* about its own job: the runner
// gives it a one-job token, and deciding needs the runner's secret, which agents never see.
import http from 'node:http';

const URL_ = process.env.AR_APPROVAL_URL || '';     // http://127.0.0.1:<port>/approval/<token>
const TIMEOUT_MS = Number(process.env.AR_APPROVAL_TIMEOUT_MS || 15 * 60e3);

function ask(tool, input) {
  return new Promise((resolve) => {
    if (!URL_) return resolve({ allow: false, message: 'Approvals are not set up.' });
    const body = JSON.stringify({ tool, input });
    const req = http.request(URL_, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: TIMEOUT_MS + 5000 }, (res) => {
      let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({ allow: false, message: 'No answer from Agent Huddle.' }); } });
    });
    req.on('error', () => resolve({ allow: false, message: 'Could not reach Agent Huddle to ask for approval.' }));
    req.on('timeout', () => { req.destroy(); resolve({ allow: false, message: 'Nobody approved this in time.' }); });
    req.end(body);
  });
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) handle(line).catch(() => {});
  }
});

async function handle(line) {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id == null) return; // notifications
  if (m.method === 'initialize') {
    return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agenthuddle', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') {
    return send({ id: m.id, result: { tools: [{
      name: 'approve',
      description: 'Asks the person in Agent Huddle to approve or deny a tool use.',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
    }] } });
  }
  if (m.method === 'tools/call') {
    const a = m.params?.arguments || {};
    const r = await ask(String(a.tool_name || ''), a.input || {});
    const decision = r.allow ? { behavior: 'allow', updatedInput: a.input || {} } : { behavior: 'deny', message: r.message || 'Denied in Agent Huddle.' };
    return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  }
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
}
