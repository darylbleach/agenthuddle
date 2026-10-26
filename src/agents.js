// Default agents. Editable at runtime from Accounts → Advanced (stored in the Durable Object).
// Placeholders: {prompt} {model} are filled by the Worker; {outfile} {workspace} by the container runner.
// If an agent's args contain no {prompt}, the prompt is sent on stdin.
export const DEFAULT_SETTINGS = {
  userName: '', // asked for by the first-run setup
  defaultAgent: 'claude',
  maxHops: 3,
  maxRunsPerTurn: 8,
  timeoutSec: 1200,
  historyChars: 40000,
};

export const DEFAULT_AGENTS = [
  {
    id: 'claude', name: 'Claude', color: '#d97757', enabled: true, mode: 'cli',
    login: { command: 'claude auth login', secret: 'CLAUDE_CODE_OAUTH_TOKEN', files: ['.claude/.credentials.json'] },
    cli: {
      command: 'claude', args: ['-p', '--output-format', 'text'], modelFlag: '--model', model: '',
      readArgs: ['--permission-mode', 'plan'], editArgs: ['--permission-mode', 'bypassPermissions'],
    },
    api: { provider: 'anthropic', model: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY' },
  },
  {
    id: 'codex', name: 'Codex', color: '#10a37f', enabled: true, mode: 'cli',
    login: { command: 'codex login --device-auth', files: ['.codex/auth.json'] },
    cli: {
      command: 'codex', args: ['exec', '--skip-git-repo-check', '--color', 'never', '--output-last-message', '{outfile}'], modelFlag: '-m', model: '',
      readArgs: ['--sandbox', 'read-only', '-'], editArgs: ['--dangerously-bypass-approvals-and-sandbox', '-'],
    },
    api: { provider: 'openai', model: 'gpt-5', keyEnv: 'OPENAI_API_KEY' },
  },
  {
    id: 'antigravity', name: 'Antigravity', aliases: ['agy', 'gemini', 'ag'], color: '#4285f4', enabled: true, mode: 'cli',
    note: 'Google Antigravity CLI (agy), signed in with your Google account.',
    login: { command: 'agy', dirs: ['.gemini/antigravity-cli', '.antigravitycli', '.antigravity', '.config/antigravity', '.config/antigravity-cli', '.local/share/antigravity-cli'] },
    cli: {
      command: 'agy', args: ['-p', '{prompt}', '--add-dir', '{workspace}'], modelFlag: '--model', model: '',
      // Read-only rooms still auto-approve so it can run commands; the runner discards any file changes.
      readArgs: ['--dangerously-skip-permissions'], editArgs: ['--dangerously-skip-permissions'],
    },
    api: { provider: 'gemini', model: 'gemini-2.5-pro', keyEnv: 'GEMINI_API_KEY' },
  },
  {
    id: 'cursor', name: 'Cursor', color: '#8b8b8b', enabled: true, mode: 'cli',
    login: { command: 'cursor-agent login', secret: 'CURSOR_API_KEY', dirs: ['.cursor', '.config/cursor'] },
    cli: {
      command: 'cursor-agent', args: ['-p', '{prompt}', '--output-format', 'text', '--trust'], modelFlag: '--model', model: '',
      readArgs: ['--force'], editArgs: ['--force'],
    },
    api: null,
  },
  {
    id: 'grok', name: 'Grok', color: '#c084fc', enabled: true, mode: 'cli',
    note: "xAI's Grok CLI (grok), signed in with your Grok / SuperGrok account.",
    login: { command: 'grok login --device-auth', files: ['.grok/auth.json'] },
    cli: {
      command: 'grok', args: ['-p', '{prompt}'], modelFlag: '--model', model: '',
      readArgs: ['--always-approve'], editArgs: ['--permission-mode', 'bypassPermissions'],
    },
    api: { provider: 'openai', baseUrl: 'https://api.x.ai/v1', model: 'grok-4', keyEnv: 'XAI_API_KEY' },
  },
];

// Secrets the UI may set. CLI_ENV are passed to CLI jobs; API keys only to API jobs
// (an ANTHROPIC_API_KEY in Claude Code's env would switch it to pay-per-token billing).
export const CLI_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'CURSOR_API_KEY', 'GITHUB_TOKEN'];
export const API_ENV = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY'];
export const SECRET_NAMES = [...CLI_ENV, ...API_ENV];

// Terminal commands offered in the browser console.
export const CONSOLE_COMMANDS = {
  'claude-login': 'claude auth login',
  'claude-status': 'claude auth status --text',
  'codex-login': 'codex login --device-auth',
  'codex-status': 'codex login status',
  'agy': 'agy',
  'grok-login': 'grok login --device-auth',
  'cursor-login': 'cursor-agent login',
  'cursor-status': 'cursor-agent status',
  'bash': 'bash',
  // Installers for the Mac app (local mode): the same official installers the cloud image uses.
  'check-clis': 'for c in claude codex agy grok cursor-agent git; do printf "%-14s" "$c"; command -v "$c" || echo "not installed"; done',
  'install-claude': 'curl -fsSL https://claude.ai/install.sh | bash',
  'install-codex': 'npm install -g --prefix "$HOME/.agenthuddle/npm" @openai/codex',
  'install-agy': 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  'install-grok': 'curl -fsSL https://x.ai/cli/install.sh | bash',
  'install-cursor': 'curl -fsS https://cursor.com/install | bash',
};
// On your own Mac the CLIs can open your browser and catch the sign-in themselves, which is simpler than
// device codes (Codex's device-code login also has to be switched on in ChatGPT's security settings).
export const LOCAL_CONSOLE_COMMANDS = { 'codex-login': 'codex login' };
export const LOCAL_ONLY_COMMANDS = ['check-clis', 'install-claude', 'install-codex', 'install-agy', 'install-grok', 'install-cursor'];

// Flag each CLI uses to pick a model (used to upgrade agent lists saved before model switching existed).
export const MODEL_FLAGS = { claude: '--model', codex: '-m', agy: '--model', 'cursor-agent': '--model', grok: '--model', gemini: '--model' };

// Saved login files: only token files, never CLI config (which could carry hooks or commands).
// Must match CRED_ALLOW in container/runner.mjs.
const CRED_ALLOW = [
  /^(\.agenthuddle\/accounts\/[a-z0-9-]{1,30}\/)?\.claude\/\.credentials\.json$/,
  /^(\.agenthuddle\/accounts\/[a-z0-9-]{1,30}\/)?\.codex\/auth\.json$/,
  /^(\.agenthuddle\/accounts\/[a-z0-9-]{1,30}\/)?\.grok\/auth\.json$/,
  /^\.config\/cursor\/[\w.-]+\.json$/, /^\.cursor\/[\w.-]+\.json$/,
  /^\.local\/share\/keyrings\/[\w.-]+$/,
  /^\.gemini\/(oauth_creds|google_accounts)\.json$/, /^\.gemini\/installation_id$/,
  /^\.gemini\/antigravity-cli\/(?!(log|logs|plugins|skills|hooks|mcp|conversations|brain|presence|updater)\/)[\w./-]+$/,
];
export const credAllowed = (rel) => typeof rel === 'string' && !rel.includes('..') && !rel.startsWith('/') && CRED_ALLOW.some((r) => r.test(rel)) && !/\.(log|db|sqlite|jsonl|lock)$/.test(rel);

// Validation for anything that ends up in a CLI argument, a git command or the page.
export const CLI_COMMANDS = ['claude', 'codex', 'agy', 'grok', 'cursor-agent'];
export const API_PROVIDERS = ['anthropic', 'gemini', 'openai'];
// Approval modes per room (agents' own flags replace readArgs/editArgs unless the room auto-approves):
//  ask      — Claude asks in the chat before running commands or editing (Approve / Deny);
//             Codex works inside its own sandbox (edits only in the room's folder, no network);
//             Grok, Antigravity and Cursor get no auto-approve flag, so they can read and answer
//             but anything that needs permission is refused.
//  readonly — every agent is read-only/planning; nothing is committed.
//  auto     — the agents' auto-approve flags (readArgs/editArgs), as before.
export const APPROVAL_MODES = ['ask', 'auto', 'readonly'];
export function approvalArgs(command, mode, edit) {
  if (mode === 'ask') {
    if (command === 'claude') return ['--permission-mode', 'manual', '--permission-prompt-tool', 'mcp__agenthuddle__approve', '--strict-mcp-config', '--setting-sources', ''];
    // Codex runs through `codex app-server` in these rooms (see container/codex-app.mjs); these args are
    // only used if that path isn't available.
    if (command === 'codex') return ['--sandbox', 'read-only', '-'];
    return [];
  }
  if (command === 'claude') return ['--permission-mode', 'plan'];
  if (command === 'codex') return ['--sandbox', 'read-only', '-'];
  return [];
}

// Extra accounts: several logins for the same CLI, each its own agent in the chat (e.g. @claude-work).
export const ACCOUNT_CLIS = ['claude', 'codex', 'grok'];
export const ACCOUNT_RE = /^[a-z0-9-]{1,30}$/;
export const MODEL_RE = /^[\w.:/@\[\]-]{0,80}$/;
export const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,30}$/;
export const COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;
export const REPO_RE = /^([\w.-]+\/[\w.-]+|https:\/\/[\w.-]+(:\d+)?\/[\w./-]+)$/;
export const validBranch = (b) => !b || (/^[\w./-]{1,100}$/.test(b) && !b.startsWith('-') && !b.includes('..') && !b.endsWith('/') && !b.endsWith('.lock'));
export const validRepo = (r) => !r || (REPO_RE.test(r) && !r.startsWith('-'));
export function validateAgent(a) {
  const str = (v, max) => typeof v === 'string' && v.length <= max && !/[<>"'`]/.test(v);
  if (!a || typeof a !== 'object') return 'Each agent must be an object.';
  if (!AGENT_ID_RE.test(a.id || '')) return `Agent id "${a.id}" must be lowercase letters, digits, - or _.`;
  if (!str(a.name, 40) || !a.name.trim()) return `Agent ${a.id}: name is required (no < > quotes).`;
  if (a.color != null && !COLOR_RE.test(a.color)) return `Agent ${a.id}: color must be a hex colour like #c084fc.`;
  if (!a.cli && !a.api) return `Agent ${a.id}: needs cli or api.`;
  if (a.cli) {
    if (!CLI_COMMANDS.includes(a.cli.command)) return `Agent ${a.id}: cli.command must be one of ${CLI_COMMANDS.join(', ')}.`;
    for (const k of ['args', 'readArgs', 'editArgs']) if (a.cli[k] != null && !(Array.isArray(a.cli[k]) && a.cli[k].every((x) => typeof x === 'string' && x.length <= 200))) return `Agent ${a.id}: cli.${k} must be a list of strings.`;
    if (a.cli.model != null && !MODEL_RE.test(a.cli.model)) return `Agent ${a.id}: invalid model name.`;
    if (a.cli.account != null && a.cli.account !== '' && !(ACCOUNT_RE.test(a.cli.account) && ACCOUNT_CLIS.includes(a.cli.command)))
      return `Agent ${a.id}: cli.account must be lowercase letters, digits or -, and only Claude, Codex and Grok support extra accounts.`;
  }
  if (a.api) {
    if (!API_PROVIDERS.includes(a.api.provider)) return `Agent ${a.id}: api.provider must be one of ${API_PROVIDERS.join(', ')}.`;
    if (a.api.baseUrl != null && !/^https:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(a.api.baseUrl)) return `Agent ${a.id}: api.baseUrl must be an https URL.`;
    if (!MODEL_RE.test(a.api.model || '')) return `Agent ${a.id}: invalid API model name.`;
    if (!SECRET_NAMES.includes(a.api.keyEnv)) return `Agent ${a.id}: api.keyEnv must be one of ${API_ENV.join(', ')}.`;
  }
  return null;
}
