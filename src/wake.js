// Waking an idle session.
//
// The Stop hook can only hold open a turn that is still running. Once Claude
// Code is sitting at the prompt there is no turn left to block, so something
// outside has to poke it. Two ways, tried in order:
//
//   tmux    type the prompt into the real pane — you watch it happen
//   resume  `claude --resume --fork-session -p` — works headless, but the
//           work lands in a forked session you are not looking at
//
// Session discovery reads ~/.claude/sessions/<pid>.json, which every running
// Claude Code writes for itself. That file is internal and undocumented, so
// everything here degrades to "could not wake" rather than throwing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { drainPrompt } from './config.js';

export { drainPrompt };

const SESSIONS_DIR = path.join(os.homedir(), '.claude/sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude/projects');

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/**
 * Running Claude Code sessions whose cwd is this project, freshest first.
 * `dir` is a seam for tests; nothing else should pass it.
 */
export function liveSessions(root, dir = SESSIONS_DIR) {
  const want = path.resolve(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }

  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue; // the .key siblings are not registries
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!s?.pid || !s.sessionId) continue;
    if (path.resolve(s.cwd || '') !== want) continue;
    if (!alive(s.pid)) continue; // stale file from a session that died
    out.push(s);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

const parentOf = (pid) => {
  try {
    const n = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    return Number.isFinite(n) && n > 1 ? n : null;
  } catch { return null; }
};

/** The tmux pane whose process tree contains `pid`, if there is one. */
export function paneFor(pid) {
  let listing;
  try {
    listing = execFileSync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch { return null; } // no tmux, or no server running

  const paneByPid = new Map();
  for (const line of listing.split('\n')) {
    const [id, p] = line.trim().split(' ');
    if (id && p) paneByPid.set(Number(p), id);
  }
  // claude is a child of the pane's shell, so walk up until we hit a pane pid.
  for (let cur = pid, hops = 0; cur && hops < 12; hops++) {
    if (paneByPid.has(cur)) return paneByPid.get(cur);
    cur = parentOf(cur);
  }
  return null;
}

export function typeInto(pane, text) {
  execFileSync('tmux', ['send-keys', '-t', pane, '-l', '--', text], { stdio: 'ignore' });
  execFileSync('tmux', ['send-keys', '-t', pane, 'Enter'], { stdio: 'ignore' });
}

/** Claude Code slugifies the cwd to name a project's transcript directory. */
export const projectSlug = (root) => path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');

/** Most recently touched transcript for this project, live or not. */
export function lastTranscript(root) {
  const dir = path.join(PROJECTS_DIR, projectSlug(root));
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const { mtimeMs } = fs.statSync(path.join(dir, f));
      if (!best || mtimeMs > best.mtimeMs) best = { sessionId: f.slice(0, -'.jsonl'.length), mtimeMs };
    }
  } catch {}
  return best;
}

export function resumeArgs(sessionId, text, cfg) {
  // --fork-session: resuming a transcript another process may still have open
  // would have both of them appending to the same file.
  const args = ['--resume', sessionId, '--fork-session'];
  const pm = cfg?.wake?.permissionMode;
  // 'default' means "leave it alone" — in print mode that denies every edit,
  // which is a legitimate choice if you would rather review first.
  if (pm && pm !== 'default') args.push('--permission-mode', pm);
  return [...args, '-p', text];
}

function resumeDetached(root, sessionId, text, cfg) {
  const child = spawn('claude', resumeArgs(sessionId, text, cfg), {
    cwd: root, detached: true, stdio: 'ignore',
  });
  child.unref();
}

/**
 * Try to get a session working on the queue.
 * @returns {{woke: boolean, via: string, detail: string}}
 */
export function wake(root, cfg, pending, rel, { sessionsDir } = {}) {
  const text = drainPrompt(pending, rel);
  const sessions = liveSessions(root, sessionsDir || SESSIONS_DIR);

  // A session mid-turn needs no waking — its Stop hook will see the queue.
  const busy = sessions.find((s) => s.status === 'busy');
  if (busy) return { woke: false, via: 'busy', detail: busy.name || String(busy.pid) };

  const idle = sessions[0] || null;

  if (cfg.wake.tmux && idle) {
    const pane = paneFor(idle.pid);
    if (pane) {
      try {
        typeInto(pane, text);
        return { woke: true, via: 'tmux', detail: `${idle.name || idle.pid} in ${pane}` };
      } catch (e) {
        // fall through to resume rather than giving up
      }
    }
  }

  if (cfg.wake.resume) {
    const target = idle?.sessionId || lastTranscript(root)?.sessionId;
    if (target) {
      try {
        resumeDetached(root, target, text, cfg);
        return { woke: true, via: 'resume', detail: `forked ${target.slice(0, 8)}` };
      } catch (e) {
        return { woke: false, via: 'error', detail: e.message };
      }
    }
  }

  if (idle) return { woke: false, via: 'unreachable', detail: `${idle.name || idle.pid} is idle but not in tmux` };
  return { woke: false, via: 'none', detail: 'no session open in this project' };
}
