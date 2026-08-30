// The queue file, and who is allowed to write to it. Shared by the Vite plugin
// and the bridge so the two hosts can never disagree about either.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = { version: 1, items: [] };

export function readQueue(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, items: Array.isArray(d.items) ? d.items : [] };
  } catch {
    return { ...EMPTY, items: [] };
  }
}

let seq = 0;

export function writeQueue(file, q) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written aside and renamed: a reader that catches the file mid-write would
  // parse a truncated queue as an empty one and drop everything in it. The
  // counter keeps two writes from the same process off the same temp path.
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(q, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const EXTENSION = /^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i;

/**
 * May this request write to the queue?
 *
 * Whatever lands in the queue is what Claude Code goes on to apply — in `wake`
 * mode into a headless session running with `acceptEdits`. And a POST sent as
 * `content-type: text/plain` is a CORS-*simple* request: no preflight, so the
 * browser fires it and only blocks the reply. Without a check here, any page
 * you happen to have open in another tab could quietly queue instructions into
 * your dev server and have an agent carry them out.
 *
 * Browsers label the requests they send, and a page on someone else's domain
 * cannot forge either header. A request carrying neither came from a local
 * client — curl, node, the extension's own worker — which already has the
 * machine and needs no gate.
 */
export function fromLocalPage(req, { extensions = false } = {}) {
  const origin = req.headers.origin || '';
  const site = req.headers['sec-fetch-site'];
  const allowed = LOOPBACK.test(origin) || (extensions && EXTENSION.test(origin));

  if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return allowed;
  if (!origin) return true;
  return allowed;
}
