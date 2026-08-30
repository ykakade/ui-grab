// Find where in the source a picked element probably lives.
//
// Two sources, best first. When the page had react-grab loaded, the item
// arrives carrying the component and source line straight off the fiber — that
// is ground truth, not a guess, so it goes first.
//
// Everything else falls back to grep: the element's own distinguishing strings
// searched across the project. That works in React, Vue, Svelte and plain HTML
// alike, and covers the elements react-grab cannot place (no fiber, production
// React, or a non-React page). Worst case it finds nothing and the agent
// searches itself.

import fs from 'node:fs';
import path from 'node:path';

const EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro', '.html', '.htm',
]);
const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.svelte-kit', 'coverage', '.cache', '.vite', '.claude', 'vendor',
]);

const MAX_FILES = 2000;
const MAX_BYTES = 400 * 1024;
const MAX_HITS = 4;

function walk(dir, acc, depth = 0) {
  if (acc.length >= MAX_FILES || depth > 10) return acc;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Dot-directories are build output, caches and VCS metadata, never
      // somewhere you would edit a component.
      if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
      walk(full, acc, depth + 1);
    } else if (EXT.has(path.extname(e.name))) {
      acc.push(full);
    }
  }
  return acc;
}

let cache = { root: null, at: 0, files: [] };

function files(root) {
  const now = Date.now();
  if (cache.root === root && now - cache.at < 10_000) return cache.files;
  cache = { root, at: now, files: walk(root, []) };
  return cache.files;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build search keys for an element, most-distinguishing first. Each key is
 * `{ re, needle, why, weight }` — lower weight is a stronger signal.
 *
 * `needle` is the plain literal the regex is built around. `text.includes()` on
 * it rejects a file (or a whole key) far cheaper than running the regex, which
 * matters because the scan is O(files × keys × lines).
 */
function keys(item) {
  const out = [];
  const add = (needle, re, why, weight) => out.push({ needle, re, why, weight });

  const text = (item.text || '').trim();
  if (text.length >= 3 && text.length <= 80 && !text.includes('\n')) {
    add(text, new RegExp(esc(text)), 'text', 0);
  }
  // `elementId`, not `id` — the picker fills `id` with a random per-pick token,
  // so searching it found nothing and cost the second-strongest signal there is.
  if (item.elementId) add(item.elementId, new RegExp(`\\b${esc(item.elementId)}\\b`), 'id', 1);

  const testid = item.attrs && (item.attrs['data-testid'] || item.attrs['data-test-id']);
  if (testid) add(testid, new RegExp(esc(testid)), 'data-testid', 1);

  const aria = item.attrs && item.attrs['aria-label'];
  if (aria && aria.length >= 3) add(aria, new RegExp(esc(aria)), 'aria-label', 2);

  const cls = (item.classes || '').split(/\s+/).filter((c) => c.length > 3);
  // Whole class attribute first — an exact match is a near-certain hit.
  if (item.classes && item.classes.length > 6) {
    add(item.classes, new RegExp(esc(item.classes)), 'class list', 2);
  }
  for (const c of cls.sort((a, b) => b.length - a.length).slice(0, 3)) {
    add(c, new RegExp(`\\b${esc(c)}\\b`), `class .${c}`, 3);
  }
  return out;
}

/**
 * Does the line react-grab named actually look like the element that was
 * picked? Observed in practice: the file is right but the line is off, and a
 * confidently wrong line is worse than an honest grep hit — so every fiber
 * reading gets checked against the source before it is allowed to outrank one.
 */
function corroborates(line, item) {
  const src = (line || '').toLowerCase();
  if (!src) return false;
  if (item.tag && src.includes('<' + String(item.tag).toLowerCase())) return true;
  const classes = String(item.classes || '').split(/\s+/).filter((c) => c.length > 2);
  if (classes.some((c) => src.includes(c.toLowerCase()))) return true;
  if (item.elementId && src.includes(String(item.elementId).toLowerCase())) return true;
  const text = String(item.text || '').trim().toLowerCase();
  return text.length >= 8 && src.includes(text.slice(0, 24));
}

/**
 * Turn react-grab's fiber reading into candidates. The element's own frame
 * comes first, then the enclosing components — "make this bigger" is often
 * really about the parent, and the stack is the only thing that knows who the
 * parent component is.
 */
function reactCandidates(root, item) {
  const rg = item.react;
  if (!rg) return [];

  const out = [];
  const seen = new Set();
  const frames = [
    { file: rg.file, line: rg.line, component: rg.componentName },
    ...(Array.isArray(rg.stack) ? rg.stack : []),
  ];

  for (const f of frames) {
    if (!f || !f.file) continue;
    const rel = toRelative(root, f.file);
    // Skip anything outside the project — node_modules frames and React's own
    // internals are noise, not somewhere you would edit.
    if (!rel || rel.startsWith('..') || rel.includes('node_modules')) continue;
    const line = Number(f.line) || 1;
    const key = `${rel}:${line}`;
    if (seen.has(key)) continue;
    if (!fs.existsSync(path.join(root, rel))) continue;
    seen.add(key);
    const snippet = lineAt(root, rel, line);
    out.push({
      file: rel,
      line,
      matchedBy: out.length === 0 ? 'react' : 'react stack',
      component: f.component || null,
      snippet,
      weak: !corroborates(snippet, item),
    });
    if (out.length >= 3) break;
  }
  return out;
}

function toRelative(root, file) {
  let f = String(file).replace(/^file:\/\//, '');
  // Vite serves fibers with root-relative or absolute paths depending on the
  // React version and whether the file went through the dep optimizer.
  if (path.isAbsolute(f)) return path.relative(root, f);
  return f.replace(/^\.?\//, '');
}

function lineAt(root, rel, line) {
  try {
    const src = fs.readFileSync(path.join(root, rel), 'utf8').split(/\r?\n/);
    return (src[line - 1] || '').trim().slice(0, 200);
  } catch {
    return '';
  }
}

/** Rank one element's grep hits and fold in its fiber readings. */
function finish(hits, fromReact) {
  // Hits cluster: if one line in a file is a strong match, that file's other
  // lines are likelier to be the same element than a same-strength hit in an
  // unrelated file. So rank by the file's best hit first, then within the file.
  const best = new Map();
  for (const h of hits) {
    if (!best.has(h.file) || h.weight < best.get(h.file)) best.set(h.file, h.weight);
  }

  // The grep hits get ranked among themselves; the react ones are not guesses
  // and skip the ranking entirely, sitting in front of it.
  const ranked = hits
    .sort((a, b) =>
      best.get(a.file) - best.get(b.file) ||
      a.weight - b.weight ||
      a.line - b.line)
    .map(({ weight, ...rest }) => rest)
    .filter((h) => !fromReact.some((r) => r.file === h.file && r.line === h.line));

  // A corroborated fiber reading is the best thing available. One that does not
  // match the source still names the right file often enough to keep, but it
  // goes behind the grep hits and says so.
  const strong = fromReact.filter((c) => !c.weak).map(({ weak, ...r }) => r);
  const weak = fromReact.filter((c) => c.weak)
    .map(({ weak, ...r }) => ({ ...r, matchedBy: r.matchedBy + ' (line unverified)' }));

  return strong.concat(ranked, weak).slice(0, MAX_HITS);
}

/**
 * Resolve a whole batch in one pass over the project.
 *
 * A batch is the unit that arrives from the browser, and resolving it item by
 * item re-read every file once per item — ten picks meant ten full scans of the
 * source tree, synchronously, inside the request. One pass reads each file once
 * and tests every item's keys against it while it is already in hand.
 */
export function resolveBatch(root, items) {
  const work = items.map((item) => ({
    fromReact: reactCandidates(root, item),
    ks: keys(item),
    // A line that actually opens this tag is a better hit than one that merely
    // contains the same string — otherwise `<title>Foo</title>` in index.html
    // outranks the real `<h1>Foo</h1>` in the component.
    tagRe: item.tag ? new RegExp(`<\\s*${esc(String(item.tag).toLowerCase())}[\\s/>]`, 'i') : null,
    hits: [],
    seen: new Set(),
  }));

  const searching = work.filter((w) => w.ks.length);
  if (searching.length) {
    for (const file of files(root)) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.size > MAX_BYTES) continue;

      let src;
      try {
        src = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }

      // Cheap literal reject before splitting into lines, then again per key —
      // a key whose literal is absent cannot match any line in this file.
      const live = [];
      for (const w of searching) {
        const ks = w.ks.filter((k) => src.includes(k.needle));
        if (ks.length) live.push({ w, ks });
      }
      if (!live.length) continue;

      const lines = src.split('\n');
      const rel = path.relative(root, file) || path.basename(file);

      for (const { w, ks } of live) {
        for (const k of ks) {
          for (let i = 0; i < lines.length; i++) {
            if (!k.re.test(lines[i])) continue;
            const id = `${rel}:${i + 1}`;
            if (w.seen.has(id)) continue; // claimed by a stronger key; keep looking
            w.seen.add(id);
            w.hits.push({
              file: rel,
              line: i + 1,
              matchedBy: k.why,
              weight: k.weight - (w.tagRe && w.tagRe.test(lines[i]) ? 0.5 : 0),
              snippet: lines[i].trim().slice(0, 160),
            });
            break; // one hit per key per file keeps the list readable
          }
        }
      }
    }
  }

  return work.map((w) => finish(w.hits, w.fromReact));
}

export function resolveCandidates(root, item) {
  return resolveBatch(root, [item])[0];
}
