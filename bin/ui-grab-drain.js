#!/usr/bin/env node
// Print the queued changes for any agent to act on.
//
// /grab is the Claude Code path and needs none of this. This is for everything
// else: pipe it into Cursor, Codex, Aider, or read it yourself.
import path from 'node:path';
import { drainPayload, clearQueue, render, queuePath } from '../src/drain.js';
import { writeAnswer } from '../src/answers.js';

const argv = process.argv.slice(2);
const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };

if (argv.includes('-h') || argv.includes('--help')) {
  console.log(`ui-grab-drain — print the queued UI changes

usage: ui-grab-drain [options]

  --root <dir>   project to read from     (default: cwd)
  --json         print the payload as JSON instead of text
  --fresh        re-resolve every item against the files as they are now
  --no-source    pointers only, no embedded code
  --clear        empty the queue and print nothing else
  --count        print the number of pending items and exit

  --answer <id> <text>
                 reply to an item queued with kind "ask", so the answer shows
                 up in the browser beside the element that was picked
`);
  process.exit(0);
}

const root = path.resolve(get('--root') || process.cwd());
const queueFile = queuePath(root);
const rel = path.relative(root, queueFile);

// An `ask` item wants a reply rather than an edit. The agent has already said
// its piece in the terminal; this puts a short version back on screen, next to
// the element that was asked about.
const answerAt = argv.indexOf('--answer');
if (answerAt >= 0) {
  const id = argv[answerAt + 1];
  // Everything after the id up to the next flag, so a shell that dropped the
  // quotes still works and a trailing --root is not swallowed into the answer.
  const rest = argv.slice(answerAt + 2);
  const stop = rest.findIndex((a) => a.startsWith('--'));
  const text = (stop === -1 ? rest : rest.slice(0, stop)).join(' ').trim();
  if (!id || !text) {
    console.error('usage: ui-grab-drain --answer <id> "your answer"');
    process.exit(1);
  }
  writeAnswer(root, id, text);
  console.log(`answered ${id}`);
  process.exit(0);
}

if (argv.includes('--clear')) {
  clearQueue(queueFile);
  console.log(`cleared ${rel}`);
  process.exit(0);
}

const payload = drainPayload(root, queueFile, {
  fresh: argv.includes('--fresh'),
  source: !argv.includes('--no-source'),
});

if (argv.includes('--count')) {
  console.log(String(payload.pending));
  process.exit(0);
}

console.log(argv.includes('--json')
  ? JSON.stringify(payload, null, 2)
  : render(payload, { rel }));
