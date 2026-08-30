#!/usr/bin/env node
// Set up the Claude Code side: the /grab command, the Stop hook, and the mode
// that decides how much of this happens without you typing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GRAB_COMMAND, AGENTS_SECTION } from '../src/grab-command.js';
import { loadConfig, saveConfig, MODES, DEFAULTS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = process.cwd();
const argv = process.argv.slice(2);
const get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ui-grab-install — set up /grab, the Stop hook, and the automation mode

usage: ui-grab-install [options]

  --with-hook     write the Stop hook into .claude/settings.json
  --agents        add a ui-grab section to AGENTS.md, for agents without
                  slash commands (Cursor, Codex, Aider, and friends)
  --mode <m>      ${MODES.join(' | ')}     (default ${DEFAULTS.mode})
                    off   nothing automatic; you run /grab
                    wait  the Stop hook holds each turn open a little longer,
                          so clicks made just after Claude finishes still land
                    wake  when a batch arrives and the session is idle, poke it
                          (types into its tmux pane; --resume as a fallback)
                    both  wait first, wake if the window expires
  --wait <sec>    how long 'wait' holds a turn open   (default ${DEFAULTS.waitSeconds})
  --no-tmux       never type into a tmux pane
  --resume        allow 'claude --resume --fork-session -p' to wake headlessly
  --perm <mode>   permission mode for that headless session
                    (default acceptEdits; 'default' denies edits in print mode)
`);
  process.exit(0);
}

const withHook = argv.includes('--with-hook');

const cmd = path.resolve(root, '.claude/commands/grab.md');
fs.mkdirSync(path.dirname(cmd), { recursive: true });
fs.writeFileSync(cmd, GRAB_COMMAND);
console.log(`wrote ${path.relative(root, cmd)}`);

// ---- AGENTS.md --------------------------------------------------------------
// /grab is the Claude Code path. Everything else reads AGENTS.md and runs the
// drain command itself.
if (argv.includes('--agents')) {
  const af = path.resolve(root, 'AGENTS.md');
  let existing = '';
  try { existing = fs.readFileSync(af, 'utf8'); } catch {}
  if (existing.includes('## ui-grab')) {
    console.log('AGENTS.md already has a ui-grab section');
  } else {
    fs.writeFileSync(af, existing ? `${existing.replace(/\s*$/, '')}\n\n${AGENTS_SECTION}` : AGENTS_SECTION);
    console.log(`${existing ? 'appended to' : 'wrote'} AGENTS.md`);
  }
}

// ---- mode -------------------------------------------------------------------
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

// Always write the file on install, so the mode is visible and editable rather
// than an invisible default.
const cfg = saveConfig(root, Object.keys(patch).length ? patch : loadConfig(root));
console.log(`wrote .ui-grab/config.json  (mode: ${cfg.mode})`);

// ---- hook -------------------------------------------------------------------
// Prefer a repo-relative path (portable for everyone on the team), but fall
// back to absolute when the package lives outside the project — e.g. a local
// checkout rather than node_modules.
const hookAbs = path.resolve(HERE, '../hooks/stop-hook.mjs');
const hookRel = path.relative(root, hookAbs);
const hookCmd = `node ${hookRel.startsWith('..') ? hookAbs : hookRel}`;
// The hook sleeps for up to waitSeconds, so it needs headroom above that or
// Claude Code kills it mid-wait.
const timeout = cfg.waitSeconds + 10;

if (!withHook) {
  console.log(`
/grab is ready. To also have Claude Code pick up changes without you typing,
add this Stop hook to .claude/settings.json (or rerun with --with-hook):

  "hooks": { "Stop": [ { "hooks": [
    { "type": "command", "command": "${hookCmd}", "timeout": ${timeout} }
  ] } ] }
`);
  process.exit(0);
}

const sf = path.resolve(root, '.claude/settings.json');
let settings = {};
try { settings = JSON.parse(fs.readFileSync(sf, 'utf8')); } catch {}
settings.hooks ||= {};
settings.hooks.Stop ||= [];

const entry = settings.hooks.Stop
  .flatMap((g) => g.hooks || [])
  .find((h) => typeof h.command === 'string' && h.command.includes('stop-hook.mjs'));

if (entry) {
  entry.command = hookCmd;
  entry.timeout = timeout;
  fs.writeFileSync(sf, JSON.stringify(settings, null, 2) + '\n');
  console.log(`updated Stop hook in ${path.relative(root, sf)}  (timeout ${timeout}s)`);
} else {
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: hookCmd, timeout }] });
  fs.writeFileSync(sf, JSON.stringify(settings, null, 2) + '\n');
  console.log(`added Stop hook to ${path.relative(root, sf)}  (timeout ${timeout}s)`);
}

if (cfg.mode === 'off') {
  console.log(`\nMode is "off" — the hook is installed but will not hold turns.\nRun with --mode both to turn the automation on.`);
} else {
  console.log(`\nMode "${cfg.mode}": ` + [
    cfg.mode !== 'wake' && `turns stay open ${cfg.waitSeconds}s after finishing`,
    cfg.mode !== 'wait' && `idle sessions get woken via ${[cfg.wake.tmux && 'tmux', cfg.wake.resume && 'resume'].filter(Boolean).join(' → ') || '(nothing enabled)'}`,
  ].filter(Boolean).join(', ') + '.');
}
