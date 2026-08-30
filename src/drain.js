// Reading the queue out, for whoever is going to act on it.
//
// Resolution can happen here rather than at pick time. A pointer worked out the
// moment you clicked is a pointer to a file as it was then; you might click at
// 2pm and drain at 4pm, two edits later. Resolving at drain time costs one scan
// and is always current, which is also why nothing has to be embedded.
import path from 'node:path';
import { readQueue, writeQueue } from './queue.js';
import { resolveItems } from './ingest.js';
import { record as recordSent } from './verify.js';

/**
 * The queue, resolved and written back.
 * @param {object} [opts]
 * @param {boolean} [opts.fresh] re-resolve items that already carry candidates
 */
export function drainPayload(root, queueFile, { fresh = false, source = true, adaptive = true } = {}) {
  const q = readQueue(queueFile);
  const todo = q.items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => fresh || !item.candidates);

  if (todo.length) {
    const { enriched, sources, ledger } = resolveItems(root, todo.map((t) => t.item),
      { resolve: true, source, adaptive });
    todo.forEach(({ i }, n) => { q.items[i] = { ...q.items[i], ...enriched[n] }; });
    Object.assign(q.sources, sources);
    writeQueue(queueFile, q);
    try { recordSent(root, ledger); } catch {}
  }

  return { items: q.items, sources: q.sources, pending: q.items.length };
}

export function clearQueue(queueFile) {
  writeQueue(queueFile, { items: [], sources: {} });
}

const el = (it) => '<' + it.tag + (it.elementId ? '#' + it.elementId : '') +
  (it.classes ? '.' + it.classes.trim().split(/\s+/).slice(0, 3).join('.') : '') + '>';

/** The batch as text an agent can act on, whichever agent it is. */
export function render(payload, { rel = '.ui-grab/queue.json' } = {}) {
  const { items, sources } = payload;
  if (!items.length) return `Nothing queued in ${rel}.`;

  const out = [];
  out.push(`${items.length} UI change${items.length === 1 ? '' : 's'} queued from the browser.`);
  out.push('');
  out.push('Apply each one to the element it points at. Candidates are ranked guesses at');
  out.push('where the element is written, which is often not where its styling lives — read');
  out.push('the file before editing, and prefer one coherent change over one patch per item.');
  out.push('');

  items.forEach((it, n) => {
    out.push(`${n + 1}. ${el(it)}  ${it.route || ''}`.trimEnd());
    out.push(`   "${(it.comment || '').replace(/\s+/g, ' ')}"`);
    for (const also of it.also || []) out.push(`   + also ${el(also)}  ${also.selector || ''}`.trimEnd());
    for (const c of it.candidates || []) {
      out.push(`   → ${c.file}:${c.line}  [${c.matchedBy}${c.el ? ` for #${c.el + 1}` : ''}]` +
        (c.snippet ? `  ${c.snippet.slice(0, 90)}` : ''));
    }
    if (it.sourceRefs?.length) out.push(`   source: ${it.sourceRefs.join(', ')}`);
    if (it.screenshot) out.push(`   screenshot: ${it.screenshot}`);
    const st = it.styles || {};
    const shown = Object.keys(st).slice(0, 6).map((k) => `${k} ${st[k]}`).join('; ');
    if (shown) out.push(`   computed: ${shown}`);
    out.push('');
  });

  const refs = Object.keys(sources || {});
  if (refs.length) {
    out.push('--- source, as it was when the pick was queued. Re-read before editing. ---');
    for (const ref of refs) {
      const b = sources[ref];
      out.push('');
      out.push(`${ref}  (${b.kind}, sha ${b.sha}${b.truncated ? ', truncated' : ''})`);
      out.push(b.code);
    }
    out.push('');
  }

  out.push(`When you are done, empty the queue: write {"version":2,"items":[],"sources":{}} to ${rel}`);
  return out.join('\n');
}

export const queuePath = (root) => path.join(root, '.ui-grab/queue.json');
