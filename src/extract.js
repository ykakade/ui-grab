// Pull the enclosing component/declaration source for a resolved candidate.
//
// The queue used to carry only a file:line pointer. Carrying the code itself
// removes a hop, at the cost of the snapshot going stale if the file is edited
// between queueing and draining — so every block records the range and a short
// content hash, and the /grab instructions say to re-read before editing.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_BLOCK_LINES = 160;   // beyond this, a declaration is too coarse to help
const WINDOW = 20;             // fallback context on either side of the hit
const MAX_CHARS = 8000;
const MAX_FILES = 2;

const DECL = /^(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|var)\s|^export\s+default\b/;

// Approximate: drop line comments and string bodies so their braces don't count.
const strip = (line) =>
  line
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""')
    .replace(/\/\/.*$/, '');

function enclosing(lines, hit) {
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
  if (end - start + 1 > MAX_BLOCK_LINES) {
    return { start: Math.max(0, hit - WINDOW), end: Math.min(lines.length - 1, hit + WINDOW), windowed: true };
  }
  return { start, end, windowed: false };
}

export function extractSource(root, candidates = []) {
  const out = [];
  const seenFiles = new Set();

  for (const c of candidates) {
    if (out.length >= MAX_FILES) break;
    if (seenFiles.has(c.file)) continue;

    let lines;
    try {
      lines = fs.readFileSync(path.join(root, c.file), 'utf8').split('\n');
    } catch { continue; }
    if (c.line < 1 || c.line > lines.length) continue;
    seenFiles.add(c.file);

    const { start, end, windowed } = enclosing(lines, c.line - 1);
    let code = lines.slice(start, end + 1).join('\n');
    let truncated = false;
    if (code.length > MAX_CHARS) { code = code.slice(0, MAX_CHARS); truncated = true; }

    out.push({
      file: c.file,
      lines: `${start + 1}-${end + 1}`,
      hitLine: c.line,
      kind: windowed ? 'window' : 'declaration',
      sha: crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12),
      truncated,
      code,
    });
  }
  return out;
}
