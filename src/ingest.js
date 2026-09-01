// Everything that happens between the browser hitting Send and the queue file
// on disk. One implementation, three hosts: the Vite plugin, the bridge, and
// the Next.js adapter all call this so they cannot drift.
//
// The order matters. A confirmed map entry means we already know where this
// element lives, so it skips the project scan entirely; a confident pointer
// means the agent does not need the source embedded, because it opens the file
// anyway. Both of those make the payload smaller, which is the whole game: the
// queue is a pointer, not a snapshot.
import fs from 'node:fs';
import path from 'node:path';
import { resolveBatch, prune } from './resolve.js';
import { extractInto } from './extract.js';
import { lookup as mapLookup, mapKey } from './map.js';
import { record as recordSent } from './verify.js';
import { snapshot } from './snapshot.js';
import { readQueue, writeQueue } from './queue.js';
import { isAsk } from './answers.js';

const MAX_MERGED = 6;

/** A screenshot is worth more to an agent as a file it can open than as a
 *  megabyte of base64 sitting in the queue. */
export function saveShot(root, id, dataUrl) {
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return null;
  const dir = path.join(root, '.ui-grab/shots');
  fs.mkdirSync(dir, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const rel = path.join('.ui-grab/shots', `${id}.${ext}`);
  fs.writeFileSync(path.join(root, rel), Buffer.from(m[2], 'base64'));
  return rel;
}

/**
 * Resolve a batch and append it to the queue.
 *
 * @param {string} root       project root
 * @param {string} queueFile  absolute path to queue.json
 * @param {object[]} incoming items straight off the wire
 */
/**
 * Point a batch of items at the source. Pure: it reads the project and returns
 * what it found, without touching the queue — so the same pass serves both a
 * pick being queued and a queue being drained hours later.
 *
 * @returns {{enriched: object[], sources: object, ledger: object[]}}
 */
export function resolveItems(root, items, { resolve = true, source = true, adaptive = true } = {}) {
  // An item is one comment, but it can point at several elements ("these three
  // should line up"). Flatten so the project is scanned once for all of them.
  const parts = [];
  const ownerOf = [];
  const slotOf = [];
  items.forEach((item, i) => {
    const also = Array.isArray(item.also) ? item.also : [];
    [item, ...also].forEach((p, j) => { parts.push(p); ownerOf.push(i); slotOf.push(j); });
  });

  // 1. what we already know
  const mapped = parts.map((p) => (resolve ? safe(() => mapLookup(root, p), null) : null));

  // 2. grep, for everything we do not
  const perPart = parts.map(() => []);
  const toScan = [];
  parts.forEach((p, k) => { if (resolve && !mapped[k]) toScan.push(k); });
  if (toScan.length) {
    const got = safe(() => resolveBatch(root, toScan.map((k) => parts[k])), toScan.map(() => []));
    toScan.forEach((k, n) => { perPart[k] = got[n] || []; });
  }
  mapped.forEach((m, k) => { if (m) perPart[k] = [m]; });

  // 3. how much of it is worth sending
  const trimmed = perPart.map((c) => (adaptive ? prune(c) : { candidates: c, confident: false }));

  const sources = {};
  const ledger = [];

  const enriched = items.map((item, i) => {
    const mine = parts.map((_, k) => k).filter((k) => ownerOf[k] === i);
    const out = {};

    if (resolve) {
      const merged = [];
      const seen = new Set();
      for (const k of mine) {
        for (const c of trimmed[k].candidates) {
          const key = `${c.file}:${c.line}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(slotOf[k] ? { ...c, el: slotOf[k] } : c);
        }
      }
      out.candidates = merged.slice(0, MAX_MERGED);
    }

    // Source only where the pointer is not already sure of itself. A confident
    // hit gets a file and a line; the agent reads it fresh, which the /grab
    // instructions tell it to do with an embedded block anyway.
    if (source) {
      const refs = [];
      for (const k of mine) {
        if (trimmed[k].confident) continue;
        refs.push(...safe(() => extractInto(root, trimmed[k].candidates, sources), []));
      }
      if (refs.length) out.sourceRefs = [...new Set(refs)];
    }

    const top = (out.candidates || [])[0];
    // A question changes nothing, so there is no verdict coming for it. Left in
    // the ledger it would sit unresolved forever, and an element that "did not
    // change" is how the map decides it was wrong about one.
    if (top && !isAsk(item)) {
      ledger.push({
        id: item.id, key: mapKey(item), file: top.file, line: top.line,
        mapped: top.matchedBy === 'map',
      });
    }
    return out;
  });

  return { enriched, sources, ledger };
}

/**
 * Resolve a batch and append it to the queue.
 *
 * @param {string} root       project root
 * @param {string} queueFile  absolute path to queue.json
 * @param {object[]} incoming items straight off the wire
 */
export function ingest(root, queueFile, incoming, {
  resolve = true, source = true, adaptive = true, screenshots = false, log = () => {},
} = {}) {
  const { enriched, sources, ledger } = resolveItems(root, incoming, { resolve, source, adaptive });
  const queuedAt = new Date().toISOString();

  const stamped = incoming.map((item, i) => {
    const { screenshot, ...rest } = item;
    const out = { ...rest, queuedAt, ...enriched[i] };
    if (screenshots && screenshot) {
      const rel = safe(() => saveShot(root, item.id, screenshot), null);
      if (rel) out.screenshot = rel;
      else log(`  screenshot not saved for ${item.id}`);
    }
    return out;
  });

  const q = readQueue(queueFile);
  q.items.push(...stamped);
  Object.assign(q.sources, sources);
  writeQueue(queueFile, q);

  // A restore point for the batch, taken before the agent touches anything.
  const batch = safe(() => snapshot(root, { items: stamped.length }), null);
  safe(() => recordSent(root, ledger.map((e) => ({ ...e, batch: batch && batch.id }))), null);

  return { items: stamped, pending: q.items.length, batch: batch && batch.id, sources };
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
