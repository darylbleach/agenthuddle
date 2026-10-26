// A system password store for CLIs that keep their login in the OS keyring (Antigravity does).
// The agent computer has no desktop, so we run a D-Bus session and GNOME Keyring for that agent's
// user, unlocked with a fixed password. The keyring file lives in that user's
// ~/.local/share/keyrings, which is saved and restored with its login, so a sign-in survives restarts.
// The password only protects the file at rest inside the agent's own private home.
import { spawn, spawnSync } from 'node:child_process';
import { asUser, fileOps } from './users.mjs';

const PASSWORD = process.env.AGENT_ROOM_KEYRING_PASSWORD || 'agent-room';
const sessions = new Map(); // user name -> { env }

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

/** Env vars (D-Bus address) a process running as `user` needs to reach its keyring. */
export function keyringEnv(user) { return sessions.get(user.name)?.env || {}; }

/** Start (or restart, after logins are restored) the keyring for `user`. Resolves true when ready. */
export async function startKeyring(user) {
  if (!has('gnome-keyring-daemon') || !has('dbus-launch')) return false;
  const old = sessions.get(user.name);
  if (old?.pids) for (const pid of old.pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  if (!user.self) spawnSync('pkill', ['-u', String(user.uid), '-f', '^(gnome-keyring-daemon|dbus-daemon)']);
  fileOps(user, [{ op: 'mkdir', path: `${user.home}/.local/share/keyrings` }]);
  const opts = asUser(user);
  const bus = spawnSync('dbus-launch', ['--sh-syntax'], { ...opts, encoding: 'utf8', timeout: 5000 });
  const addr = /DBUS_SESSION_BUS_ADDRESS='([^']+)'/.exec(bus.stdout || '')?.[1];
  const busPid = Number(/DBUS_SESSION_BUS_PID=(\d+)/.exec(bus.stdout || '')?.[1]) || null;
  if (!addr) return false;
  const env = { DBUS_SESSION_BUS_ADDRESS: addr };
  return new Promise((resolve) => {
    // --unlock reads the password from stdin; it creates the "login" keyring the first time.
    const p = spawn('gnome-keyring-daemon', ['--replace', '--daemonize', '--unlock', '--components=secrets'], { ...opts, env: { ...opts.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '', done = false;
    const finish = (ok) => {
      if (done) return; done = true;
      const pid = Number(/GNOME_KEYRING_PID=(\d+)/.exec(out)?.[1]) || null;
      const ctl = /GNOME_KEYRING_CONTROL=(\S+)/.exec(out)?.[1];
      if (ctl) env.GNOME_KEYRING_CONTROL = ctl;
      sessions.set(user.name, { env, pids: [pid, busPid].filter(Boolean) });
      resolve(ok);
    };
    p.stdout.on('data', (d) => { out += d; if (/GNOME_KEYRING_PID=\d+/.test(out)) finish(true); });
    p.on('close', () => finish(true));
    p.on('error', () => finish(false));
    p.stdin.on('error', () => {});
    p.stdin.end(PASSWORD);
    setTimeout(() => finish(true), 5000); // --daemonize can keep the pipe open; don't hang the caller
  });
}
