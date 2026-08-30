// Did the edit land on the right element?
//
// The picker knows what every picked element looked like when it was sent. When
// the agent finishes and the page reloads, it measures them again: an element
// that changed confirms the pointer we shipped, one that did not says the agent
// edited somewhere else. That check costs nothing to run — it happens in the
// browser, on data already captured — and it is the only feedback in the system
// that says whether the source lookup was actually right.
//
// Confirmations feed the map, so the next pick of that element is exact.
import fs from 'node:fs';
import path from 'node:path';
import { confirm, forget } from './map.js';

const MAX_SENT = 200;
const sentPath = (root) => path.join(root, '.ui-grab/sent.json');

export function readSent(root) {
  try {
    const d = JSON.parse(fs.readFileSync(sentPath(root), 'utf8'));
    return Array.isArray(d.sent) ? d.sent : [];
  } catch { return []; }
}

function writeSent(root, sent) {
  const file = sentPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, sent: sent.slice(-MAX_SENT) }, null, 2) + '\n');
}

/** Remember what pointer each item went out with, so a verdict can be scored. */
export function record(root, entries) {
  if (!entries.length) return;
  const keep = readSent(root).filter((s) => !entries.some((e) => e.id === s.id));
  writeSent(root, keep.concat(entries.map((e) => ({ ...e, at: Date.now() }))));
}

/**
 * Apply the browser's verdicts.
 * @param {{id: string, changed: boolean}[]} results
 */
export function applyResults(root, results = []) {
  const sent = readSent(root);
  const out = { confirmed: 0, forgotten: 0, unknown: 0 };

  for (const r of results) {
    const entry = sent.find((s) => s.id === r.id);
    if (!entry) { out.unknown++; continue; }
    if (r.changed) {
      if (entry.key && entry.file) { confirm(root, entry.key, entry.file, entry.line); out.confirmed++; }
    } else {
      // We pointed the agent somewhere and nothing moved. Whatever we thought
      // we knew about this element was wrong, so stop repeating it.
      if (entry.key && entry.mapped) { forget(root, entry.key); out.forgotten++; }
    }
  }

  const done = new Set(results.map((r) => r.id));
  writeSent(root, sent.filter((s) => !done.has(s.id)));
  return out;
}
