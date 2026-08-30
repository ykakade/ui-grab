// Pull the enclosing declaration for a resolved candidate.
//
// Blocks are written into a store shared by the whole queue, not copied onto
// each item. Pick four elements in one component and the old shape shipped that
// component's source four times; now they all point at one key.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BLOCK_LINES = 160;   // beyond this, a declaration is too coarse to help
const WINDOW = 20;             // fallback context on either side of the hit
const MARKUP_WINDOW = 12;      // markup has no declarations to find, so aim smaller
const MAX_CHARS = 8000;
const MAX_FILES = 2;

// Counting brackets is how the enclosing declaration is found, and in markup
// that counts nothing: every hit ran to the end of the file and came back as a
// near-copy of the last one.
const MARKUP = /\.(html?|css|scss|less|vue|svelte|astro)$/i;

const DECL = /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\s|^export\s+default\b/;

// Approximate: drop line comments and string bodies so their braces don't count.
const strip = (line) =>
  line
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')
    .replace(/\/\/.*$/, '');

function window(lines, hit, radius) {
  return {
    start: Math.max(0, hit - radius),
    end: Math.min(lines.length - 1, hit + radius),
    windowed: true,
  };
}

function enclosing(lines, hit, file) {
  if (MARKUP.test(file)) return window(lines, hit, MARKUP_WINDOW);

  let start = hit;
  for (let i = hit; i >= 0; i--) {
    if (DECL.test(lines[i]) && !/^\s/.test(lines[i])) { start = i; break; }
  }

  let depth = 0, opened = false, end = -1;
  for (let j = start; j < lines.length; j++) {
    for (const ch of strip(lines[j])) {
      if (ch === '{' || ch === '(' || ch === '[') { depth++; opened = true; }
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    if (opened && depth <= 0) { end = j; break; }
    if (j - start > MAX_BLOCK_LINES * 2) break;
  }
  if (end < 0) end = Math.min(lines.length - 1, start + WINDOW);

  // A whole `export const site = { ...200 lines... }` is worse than a window
  // around the line that actually matched.
  if (end - start + 1 > MAX_BLOCK_LINES) return window(lines, hit, WINDOW);
  return { start, end, windowed: false };
}

/**
 * Add the blocks for one item's candidates to `store` and return their keys.
 * A key is `file:start-end`, so two items landing in the same declaration
 * share one block instead of carrying a copy each.
 */
export function extractInto(root, candidates = [], store = {}, { maxFiles = MAX_FILES } = {}) {
  const refs = [];
  const seenFiles = new Set();

  for (const c of candidates) {
    if (refs.length >= maxFiles) break;
    if (!c || !c.file || seenFiles.has(c.file)) continue;

    // Another item may already have pulled a block that covers this line. Two
    // picks a few lines apart in the same file should not carry two overlapping
    // copies of it.
    const covering = Object.keys(store).find((ref) => {
      const b = store[ref];
      if (b.file !== c.file) return false;
      const [from, to] = b.lines.split('-').map(Number);
      return c.line >= from && c.line <= to;
    });
    if (covering) { seenFiles.add(c.file); refs.push(covering); continue; }

    let lines;
    try {
      lines = fs.readFileSync(path.join(root, c.file), 'utf8').split('\n');
    } catch { continue; }
    if (c.line < 1 || c.line > lines.length) continue;
    seenFiles.add(c.file);

    const { start, end, windowed } = enclosing(lines, c.line - 1, c.file);
    const ref = `${c.file}:${start + 1}-${end + 1}`;
    refs.push(ref);
    if (store[ref]) continue; // another item in this batch already carried it

    let code = lines.slice(start, end + 1).join('\n');
    let truncated = false;
    if (code.length > MAX_CHARS) { code = code.slice(0, MAX_CHARS); truncated = true; }

    store[ref] = {
      file: c.file,
      lines: `${start + 1}-${end + 1}`,
      hitLine: c.line,
      kind: windowed ? 'window' : 'declaration',
      sha: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12),
      truncated,
      code,
    };
  }
  return refs;
}

/** The old per-item shape. Kept for callers that want blocks, not keys. */
export function extractSource(root, candidates = []) {
  const store = {};
  return extractInto(root, candidates, store).map((ref) => store[ref]);
}
