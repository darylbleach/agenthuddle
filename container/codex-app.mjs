// Runs one Codex turn through `codex app-server` (JSON-RPC over stdio) instead of `codex exec`, so the
// approval requests Codex makes (running a command, changing files) can be answered in the chat.
// Used for "Ask in chat" rooms; other rooms keep using `codex exec`.
//
// Protocol (codex app-server v2): initialize → initialized → thread/start → turn/start, then the server
// sends notifications (item/started, item/completed, turn/completed, …) and requests that need an answer
// (item/commandExecution/requestApproval, item/fileChange/requestApproval, …).

/**
 * proc: a spawned `codex app-server` process (stdio pipes).
 * opts: { prompt, cwd, model, sandbox, approvalPolicy, images: [paths], onApproval({ tool, summary }) -> Promise<{ allow }>, log(text) }
 * Resolves with Codex's final message; rejects on failure.
 */
export function runCodexTurn(proc, opts) {
  const { prompt, cwd, model, sandbox = 'read-only', approvalPolicy = 'untrusted', images = [], instructions = null, onApproval, log = () => {} } = opts;
  let nextId = 1, buf = '', done = false;
  const pending = new Map(); // our request id -> { resolve, reject }
  const fileChanges = new Map(); // item id -> paths
  let lastMessage = '', threadId = null;

  // Friendlier text for the chat: no shell wrapper, paths relative to the room.
  const rel = (f) => (cwd && String(f).startsWith(cwd + '/') ? String(f).slice(cwd.length + 1) : String(f));
  const unwrap = (c) => { const m = /^(?:\/bin\/|\/usr\/bin\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(c); return m ? m[1].replace(/'\\''/g, "'") : c; };
  const send = (obj) => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} };
  const request = (method, params) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); send({ id, method, params }); });
  const reply = (id, result) => send({ id, result });
  const replyError = (id, message) => send({ id, error: { code: -32601, message } });

  return new Promise((resolve, reject) => {
    const finish = (err, value) => { if (done) return; done = true; for (const p of pending.values()) p.reject(new Error('Codex stopped')); pending.clear(); err ? reject(err) : resolve(value); };

    async function onServerRequest(msg) {
      const p = msg.params || {};
      try {
        if (msg.method === 'item/commandExecution/requestApproval' || msg.method === 'execCommandApproval') {
          const cmd = unwrap(Array.isArray(p.command) ? p.command.join(' ') : p.command || (p.commandActions || []).map((a) => a.command).filter(Boolean).join(' && ') || '(a command)');
          const summary = `${cmd}${p.reason ? ` — ${p.reason}` : ''}`;
          log(`\n[waiting for approval] run: ${summary}\n`);
          const { allow } = await onApproval({ tool: 'Bash', summary });
          log(`[${allow ? 'approved' : 'denied'} in chat]\n`);
          return reply(msg.id, { decision: msg.method === 'execCommandApproval' ? (allow ? 'approved' : 'denied') : allow ? 'accept' : 'decline' });
        }
        if (msg.method === 'item/fileChange/requestApproval' || msg.method === 'applyPatchApproval') {
          const paths = (fileChanges.get(p.itemId) || Object.keys(p.fileChanges || {})).map(rel);
          const summary = `${paths.length ? paths.join(', ') : 'files in this room'}${p.reason ? ` — ${p.reason}` : ''}`;
          log(`\n[waiting for approval] change: ${summary}\n`);
          const { allow } = await onApproval({ tool: 'Edit', summary });
          log(`[${allow ? 'approved' : 'denied'} in chat]\n`);
          return reply(msg.id, { decision: msg.method === 'applyPatchApproval' ? (allow ? 'approved' : 'denied') : allow ? 'accept' : 'decline' });
        }
        // Anything else that would need a person (extra permissions, questions, MCP prompts) is declined.
        log(`\n[declined: ${msg.method}]\n`);
        return replyError(msg.id, 'Not supported in Agent Huddle');
      } catch (e) { replyError(msg.id, e.message); }
    }

    function onNotification(msg) {
      const p = msg.params || {};
      switch (msg.method) {
        case 'item/started': {
          const it = p.item || {};
          if (it.type === 'commandExecution') log(`\n$ ${unwrap(it.command)}\n`);
          if (it.type === 'fileChange') { const paths = (it.changes || []).map((c) => c.path); fileChanges.set(it.id, paths); log(`\n[edit] ${paths.join(', ')}\n`); }
          break;
        }
        case 'item/commandExecution/outputDelta': if (p.delta) log(String(p.delta)); break;
        case 'item/completed': {
          const it = p.item || {};
          if (it.type === 'agentMessage' && it.text) { lastMessage = it.text; log(`\n${it.text}\n`); }
          if (it.type === 'commandExecution' && it.exitCode != null) log(`(exit ${it.exitCode})\n`);
          break;
        }
        case 'error': if (p.error?.message) log(`\n[codex error${p.willRetry ? ', retrying' : ''}] ${p.error.message}\n`); break;
        case 'turn/completed': {
          const t = p.turn || {};
          if (t.status === 'failed' || (t.error && !lastMessage)) finish(new Error(t.error?.message || 'Codex could not finish.'));
          else finish(null, lastMessage || (t.status === 'interrupted' ? '(stopped)' : '(no reply)'));
          break;
        }
      }
    }

    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { log(line + '\n'); continue; }
        if (msg.id != null && msg.method) onServerRequest(msg);
        else if (msg.id != null) { const w = pending.get(msg.id); if (w) { pending.delete(msg.id); msg.error ? w.reject(new Error(msg.error.message || 'Codex error')) : w.resolve(msg.result); } }
        else if (msg.method) onNotification(msg);
      }
    });
    proc.on('close', (code) => finish(new Error(lastMessage ? 'Codex exited early.' : `Codex exited (code ${code}). See the activity log.`)));
    proc.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? 'codex is not installed in the container.' : e.message)));

    (async () => {
      await request('initialize', { clientInfo: { name: 'agent_huddle', title: 'Agent Huddle', version: '1.0' }, capabilities: null });
      send({ method: 'initialized' });
      const th = await request('thread/start', { cwd, model: model || null, sandbox, approvalPolicy, ephemeral: true, ...(instructions ? { developerInstructions: instructions } : {}) });
      threadId = th?.thread?.id;
      if (!threadId) throw new Error('Codex did not start a conversation.');
      const input = [{ type: 'text', text: prompt, text_elements: [] }, ...images.map((p) => ({ type: 'localImage', path: p }))];
      await request('turn/start', { threadId, input });
    })().catch((e) => finish(e));
  });
}
