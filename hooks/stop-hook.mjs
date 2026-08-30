#!/usr/bin/env node
// Claude Code Stop hook: keep the turn alive while the browser queue has
// unread items, so clicking in the browser feeds a live session with no typing.
//
// In `wait`/`both` mode it also lingers for a few seconds on an empty queue,
// so a click that lands just after Claude finishes still catches the same turn
// and nothing has to be woken at all.
//
// Wire it up in .claude/settings.json:
//   { "hooks": { "Stop": [ { "hooks": [
//       { "type": "command", "command": "node ./node_modules/vite-plugin-ui-grab/hooks/stop-hook.mjs",
//         "timeout": 30 }
//   ] } ] } }
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, waits, drainPrompt } from '../src/config.js';

const MAX_BLOCKS = Number(process.env.UI_GRAB_MAX_BLOCKS || 20);
const POLL_MS = 250;

const read = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => main().catch(() => process.exit(0)));

async function main() {
  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch {}

  const cwd = input.cwd || process.cwd();
  const session = input.session_id || 'default';
  const cfg = loadConfig(cwd);
  const queueFile = process.env.UI_GRAB_QUEUE || path.resolve(cwd, '.ui-grab/queue.json');
  const rel = path.relative(cwd, queueFile);
  const peek = () => read(queueFile, { items: [] }).items || [];

  let items = peek();

  // Nothing queued yet — hold the turn open for a moment rather than letting
  // the session go idle, where only an external poke could reach it.
  const waitSec = Number(process.env.UI_GRAB_WAIT ?? cfg.waitSeconds) || 0;
  if (!items.length && waits(cfg) && waitSec > 0) {
    const until = Date.now() + waitSec * 1000;
    while (Date.now() < until) {
      await sleep(POLL_MS);
      items = peek();
      if (items.length) break;
    }
  }

  if (!items.length) process.exit(0);

  // A fresh batch gets a fresh block budget; an unchanging queue eventually
  // gives up so a wedged item cannot spin the session forever.
  const stateFile = queueFile.replace(/\.json$/, '.blocks.json');
  const state = read(stateFile, {});
  const sig = items.map((i) => i.id).join(',');
  const prev = state[session];
  const count = prev && prev.sig === sig ? prev.count + 1 : 1;

  // Session ids are never reused, so without a sweep this file accumulates one
  // dead entry per session for the life of the project.
  const DAY = 24 * 60 * 60 * 1000;
  for (const [id, v] of Object.entries(state)) {
    if (id !== session && (!v?.at || Date.now() - v.at > DAY)) delete state[id];
  }

  if (count > MAX_BLOCKS) {
    console.error(`[ui-grab] block budget spent (${MAX_BLOCKS}); letting the turn end.`);
    process.exit(0);
  }

  state[session] = { sig, count, at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state));
  } catch {}

  console.log(JSON.stringify({ decision: 'block', reason: drainPrompt(items.length, rel) }));
  process.exit(0);
}
