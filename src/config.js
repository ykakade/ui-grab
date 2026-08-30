// Shared settings for the two zero-typing modes. One file, read by both the
// Stop hook and the bridge, so the extension can flip modes without anyone
// restarting anything.
//
//   off   — nothing automatic; you type /grab
//   wait  — the Stop hook holds the turn open briefly after each one
//   wake  — the bridge pokes an idle session when a batch lands
//   both  — wait first, wake if the window expires
import fs from 'node:fs';
import path from 'node:path';

export const MODES = ['off', 'wait', 'wake', 'both'];

export const DEFAULTS = {
  mode: 'both',
  waitSeconds: 20,
  // permissionMode rides along with resume: a headless `-p` session cannot
  // show a prompt, so without this it reads the queue and then cannot act.
  wake: { tmux: true, resume: false, permissionMode: 'acceptEdits' },
};

export const configPath = (root) => path.join(root, '.ui-grab/config.json');

export function normalize(raw = {}) {
  const n = Number(raw.waitSeconds);
  return {
    mode: MODES.includes(raw.mode) ? raw.mode : DEFAULTS.mode,
    // Capped: the hook runs inside Claude Code's hook timeout, and a wait
    // longer than that is just a hook that gets killed mid-sleep.
    waitSeconds: Number.isFinite(n) ? Math.max(0, Math.min(300, Math.round(n))) : DEFAULTS.waitSeconds,
    wake: {
      tmux: raw.wake?.tmux !== false,
      resume: raw.wake?.resume === true,
      permissionMode: typeof raw.wake?.permissionMode === 'string'
        ? raw.wake.permissionMode
        : DEFAULTS.wake.permissionMode,
    },
  };
}

export function loadConfig(root) {
  try {
    return normalize(JSON.parse(fs.readFileSync(configPath(root), 'utf8')));
  } catch {
    return normalize({});
  }
}

export function saveConfig(root, patch) {
  const current = loadConfig(root);
  const merged = normalize({ ...current, ...patch, wake: { ...current.wake, ...(patch.wake || {}) } });
  const file = configPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n');
  return merged;
}

export const waits = (cfg) => cfg.mode === 'wait' || cfg.mode === 'both';
export const wakes = (cfg) => cfg.mode === 'wake' || cfg.mode === 'both';

/** The one sentence that tells Claude Code to drain the queue. */
export function drainPrompt(n, rel = '.ui-grab/queue.json') {
  return (
    `${n} UI change${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} queued in ${rel} ` +
    `from the browser. Read that file, apply every item, then reset it to ` +
    `{"version":1,"items":[]} before finishing.`
  );
}
