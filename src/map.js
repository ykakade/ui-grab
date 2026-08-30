// What we have learned about where an element lives.
//
// Grep is a guess made fresh every time. Once a pick has been confirmed — the
// browser saw the element actually change after the agent edited a file — that
// mapping is worth keeping, because the second pick of an element is the common
// case when you are iterating on it. A confirmed entry ships one exact pointer
// and skips the scan entirely, so the payload gets smaller the more you use it.
//
// Entries self-heal rather than rot: the line is re-checked against the file on
// every lookup, and an entry whose anchor has moved is either re-found nearby
// or dropped.
import fs from 'node:fs';
import path from 'node:path';
import { corroborates } from './resolve.js';

const MAX_ENTRIES = 400;
const SEARCH_RADIUS = 60;   // how far to chase an anchor that has drifted

export const mapPath = (root) => path.join(root, '.ui-grab/map.json');

export function loadMap(root) {
  try {
    const d = JSON.parse(fs.readFileSync(mapPath(root), 'utf8'));
    return { version: 1, entries: d.entries && typeof d.entries === 'object' ? d.entries : {} };
  } catch {
    return { version: 1, entries: {} };
  }
}

export function saveMap(root, map) {
  const entries = Object.entries(map.entries || {});
  // Oldest first out, so a long-lived project keeps what it actually uses.
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    map = { version: 1, entries: Object.fromEntries(entries.slice(0, MAX_ENTRIES)) };
  }
  const file = mapPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/**
 * The identity of a picked element across sessions. The route matters: the same
 * selector on two pages is two different elements.
 */
export function mapKey(item) {
  if (!item) return null;
  const route = (item.route || '/').split('?')[0];
  const what = item.selector || item.elementId || item.classes;
  if (!what) return null;
  return `${route}|${what}`;
}

/** Where the anchor line sits now, or -1 if it is gone. */
function relocate(lines, entry, item) {
  const at = entry.line - 1;
  if (lines[at] !== undefined && corroborates(lines[at], item)) return entry.line;

  const anchor = (entry.anchor || '').trim();
  if (!anchor) return -1;
  for (let d = 1; d <= SEARCH_RADIUS; d++) {
    for (const i of [at - d, at + d]) {
      if (i < 0 || i >= lines.length) continue;
      if (lines[i].trim() === anchor) return i + 1;
    }
  }
  return -1;
}

/**
 * A confirmed pointer for this element, if we have one that still holds.
 * Returns null when there is nothing, or when the entry has gone stale — in
 * which case it is deleted, so a bad mapping cannot keep misleading the agent.
 */
export function lookup(root, item, map = loadMap(root)) {
  const key = mapKey(item);
  if (!key) return null;
  const entry = map.entries[key];
  if (!entry) return null;

  let lines;
  try {
    lines = fs.readFileSync(path.join(root, entry.file), 'utf8').split('\n');
  } catch {
    delete map.entries[key];
    saveMap(root, map);
    return null;
  }

  const line = relocate(lines, entry, item);
  if (line < 0) {
    delete map.entries[key];
    saveMap(root, map);
    return null;
  }
  if (line !== entry.line) {
    entry.line = line;
    entry.anchor = lines[line - 1].trim().slice(0, 200);
    saveMap(root, map);
  }

  return {
    file: entry.file,
    line,
    matchedBy: 'map',
    snippet: lines[line - 1].trim().slice(0, 160),
    confirmed: entry.hits || 1,
  };
}

/** Record that this element really did live where we said it did. */
export function confirm(root, key, file, line) {
  if (!key || !file || !line) return;
  const map = loadMap(root);
  let anchor = '';
  try {
    anchor = (fs.readFileSync(path.join(root, file), 'utf8').split('\n')[line - 1] || '').trim().slice(0, 200);
  } catch { return; }
  if (!anchor) return;
  const prev = map.entries[key];
  map.entries[key] = {
    file, line, anchor,
    hits: prev && prev.file === file ? (prev.hits || 1) + 1 : 1,
    at: Date.now(),
  };
  saveMap(root, map);
}

/** Drop what we thought we knew — the element did not change, so we were wrong. */
export function forget(root, key) {
  if (!key) return;
  const map = loadMap(root);
  if (!map.entries[key]) return;
  delete map.entries[key];
  saveMap(root, map);
}
