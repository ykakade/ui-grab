#!/usr/bin/env node
// Run this in the project you want the Chrome extension to send changes to.
import { createBridge, DEFAULT_PORTS } from '../bridge/server.js';
import { loadConfig, saveConfig, MODES } from '../src/config.js';

const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ui-grab-bridge — receives element picks from the Chrome extension

usage: ui-grab-bridge [options]

  --root <dir>    project to write into        (default: cwd)
  --port <n>      port to bind                (default: first free of ${DEFAULT_PORTS.join(', ')})
  --no-resolve    skip grep source resolution
  --no-source     send only file:line pointers, not the enclosing code
  --shots         also attach a cropped screenshot of each element

  --mode <m>      ${MODES.join(' | ')}          (persists to .ui-grab/config.json)
                    off   you type /grab yourself
                    wait  the Stop hook holds each turn open a little longer
                    wake  poke an idle session when a batch lands
                    both  wait first, wake if the window expires
  --wait <sec>    how long 'wait' holds a turn open      (default 20)
  --no-tmux       do not type into the session's tmux pane
  --resume        allow 'claude --resume --fork-session -p' as a fallback
  --perm <mode>   permission mode for that headless session
                    (default acceptEdits; 'default' denies edits in print mode)
`);
  process.exit(0);
}

// CLI flags are a persisted override — the extension and the Stop hook read
// the same file, so a mode set here survives a restart and applies to both.
const patch = {};
if (get('--mode')) {
  if (!MODES.includes(get('--mode'))) {
    console.error(`--mode must be one of ${MODES.join(', ')}`);
    process.exit(1);
  }
  patch.mode = get('--mode');
}
if (get('--wait')) patch.waitSeconds = Number(get('--wait'));
if (argv.includes('--no-tmux')) patch.wake = { ...patch.wake, tmux: false };
if (argv.includes('--resume')) patch.wake = { ...patch.wake, resume: true };
if (get('--perm')) patch.wake = { ...patch.wake, permissionMode: get('--perm') };

const root = get('--root') || process.cwd();
const cfg = Object.keys(patch).length ? saveConfig(root, patch) : loadConfig(root);

const bridge = createBridge({
  root,
  resolve: !argv.includes('--no-resolve'),
  source: !argv.includes('--no-source'),
  screenshots: argv.includes('--shots'),
});

const port = await bridge.listen(get('--port') ? [Number(get('--port'))] : DEFAULT_PORTS);
bridge.ensureCommand();

console.log(`
  ui-grab bridge listening on http://127.0.0.1:${port}
  project : ${bridge.name}  (${bridge.root})
  queue   : .ui-grab/queue.json
  sending : ${argv.includes('--no-source') ? 'pointers only' : 'enclosing source'}${argv.includes('--shots') ? ' + screenshots' : ''}
  mode    : ${cfg.mode}${cfg.mode === 'off' ? '  (you run /grab yourself)' :
             `  (${[cfg.mode !== 'wake' && `hold turns ${cfg.waitSeconds}s`,
                    cfg.mode !== 'wait' && `wake via ${[cfg.wake.tmux && 'tmux', cfg.wake.resume && 'resume'].filter(Boolean).join(' → ') || 'nothing enabled'}`]
                   .filter(Boolean).join(', ')})`}

  Open the extension in Chrome, pick elements, hit Send.${cfg.mode === 'off' ? '\n  Then run /grab in Claude Code.' : ''}
`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\n  bridge stopped'); process.exit(0); });
}
