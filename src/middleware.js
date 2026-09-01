// The HTTP surface, once, for every host that has one.
//
// Only src/index.js knows about Vite. This file knows about the five things the
// picker asks a server to do: take a batch, take a verdict on a batch, put a
// batch back, say what has happened since, and hand over its own source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from './ingest.js';
import { applyResults } from './verify.js';
import { revert } from './snapshot.js';
import { loadConfig, wakes } from './config.js';
import { readQueue, fromLocalPage } from './queue.js';
import { wake } from './wake.js';
import { emit, hubFor, frame } from './activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOUNT = '/__ui-grab';
const ROUTES = new Set(['', '/queue', '/verify', '/revert', '/events', '/client.js']);
const MAX_BODY = 48 * 1024 * 1024; // a screenshot is base64, so leave room

let clientCache = null;

/** The picker and its transport, as one script. */
export function clientSource() {
  if (clientCache) return clientCache;
  clientCache =
    fs.readFileSync(path.join(HERE, 'browser-transport.js'), 'utf8') + '\n' +
    fs.readFileSync(path.join(HERE, '../extension/picker.js'), 'utf8');
  return clientCache;
}

/**
 * Host-agnostic request handling.
 * @returns {(req: {method: string, route: string, headers: object, body: any})
 *   => Promise<{status: number, json?: object, text?: string}>}
 */
export function createCore({
  root, queueFile, resolve = true, source = true, adaptive = true,
  screenshots = false, log = () => {}, hub,
} = {}) {
  const events = () => hub || hubFor(root);

  return async function handle({ method, route, headers = {}, body, query }) {
    // Everything below writes work for an agent to carry out, so it is gated on
    // the request having come from a page served locally.
    if (!fromLocalPage({ headers })) {
      return { status: 403, json: { ok: false, error: 'ui-grab only accepts picks from a local page' } };
    }

    if (route === '/client.js' && method === 'GET') {
      return { status: 200, text: clientSource(), type: 'text/javascript' };
    }

    // What the browser cannot see for itself: whether a session was found,
    // whether it is working, whether anything has read the queue yet. Two ways
    // to read it, because the extension cannot hold an EventSource open to a
    // bridge on another origin — one stream, one poll, one log behind both.
    if (route === '/events' && method === 'GET') {
      // EventSource reconnects on its own and re-sends the URL it was given, so
      // `since` there is as stale as the moment the stream opened. Its
      // Last-Event-ID header is the current one, and wins where both exist.
      const from = Number(headers['last-event-id']) || Number(query && query.since) || 0;
      if (String(headers.accept || '').includes('text/event-stream')) {
        return { status: 200, sse: events(), since: from };
      }
      return { status: 200, json: { ok: true, ...events().poll(from) } };
    }

    if (route === '' || route === '/' || route === '/queue') {
      if (method === 'GET') {
        return { status: 200, json: { ok: true, pending: readQueue(queueFile).items.length } };
      }
      if (method !== 'POST') return { status: 405, json: { ok: false, error: 'use POST' } };

      const items = Array.isArray(body) ? body : body && body.items;
      if (!Array.isArray(items)) {
        return { status: 400, json: { ok: false, error: 'expected { items: [...] }' } };
      }

      const out = ingest(root, queueFile, items, { resolve, source, adaptive, screenshots, log });
      for (const it of out.items) {
        const where = (it.candidates || [])[0];
        log(`  + <${it.tag}> ${JSON.stringify((it.comment || '').slice(0, 52))}` +
          (where ? `  → ${where.file}:${where.line} [${where.matchedBy}]` : ''));
      }

      emit(root, 'queued', {
        n: out.items.length,
        pending: out.pending,
        batch: out.batch,
        asks: out.items.filter((i) => i.kind === 'ask').length,
      });

      // A queue nobody reads is a queue that did nothing. A busy session will
      // see it via the Stop hook; an idle one has to be poked.
      let woke = null;
      const cfg = loadConfig(root);
      if (wakes(cfg)) {
        try {
          woke = wake(root, cfg, out.pending, path.relative(root, queueFile));
          if (woke.woke) log(`  woke via ${woke.via}: ${woke.detail}`);
          emit(root, 'woke', woke);
        } catch (e) {
          log(`  wake failed: ${e.message}`);
          emit(root, 'woke', { woke: false, via: 'error', detail: e.message });
        }
      }

      return {
        status: 200,
        json: { ok: true, added: out.items.length, pending: out.pending, batch: out.batch, woke },
      };
    }

    if (route === '/verify' && method === 'POST') {
      const results = (body && body.results) || [];
      if (!Array.isArray(results)) return { status: 400, json: { ok: false, error: 'expected { results: [...] }' } };
      const out = applyResults(root, results);
      if (out.confirmed || out.forgotten) {
        log(`  verified ${out.confirmed} confirmed, ${out.forgotten} unlearned`);
      }
      return { status: 200, json: { ok: true, ...out } };
    }

    if (route === '/revert' && method === 'POST') {
      const out = revert(root, body && body.batch);
      log(out.ok ? `  reverted ${out.files.length} file(s)` : `  revert failed: ${out.error}`);
      return { status: out.ok ? 200 : 400, json: out };
    }

    return { status: 404, json: { ok: false, error: 'not found' } };
  };
}

/**
 * Connect/Express-style middleware, for any Node dev server.
 *
 * Mount it at `/__ui-grab`. Connect strips the mount path before calling, which
 * is what Vite does; a bare `http` server does not, so a full URL is accepted
 * too and the prefix trimmed here.
 */
export function createMiddleware(opts = {}) {
  const core = createCore(opts);
  const mount = opts.mount || MOUNT;

  return function uiGrabMiddleware(req, res, next) {
    const [url, search] = (req.url || '/').split('?');
    let route = url;
    if (route === mount || route.startsWith(mount + '/')) route = route.slice(mount.length);
    if (route === '/') route = '';
    // Connect strips the mount before calling; a bare `http` server does not.
    // Either way, anything that is not ours goes back to the host.
    if (!ROUTES.has(route) && typeof next === 'function') return next();

    const query = Object.fromEntries(new URLSearchParams(search || ''));

    const send = (out) => {
      if (out.sse) return stream(res, req, out.sse, out.since);
      const { status, json, text, type } = out;
      res.statusCode = status;
      res.setHeader('content-type', type || 'application/json');
      res.end(text !== undefined ? text : JSON.stringify(json));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      core({ method: 'GET', route, headers: req.headers, query }).then(send, (e) =>
        send({ status: 500, json: { ok: false, error: e.message } }));
      return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch (e) { return send({ status: 400, json: { ok: false, error: e.message } }); }
      core({ method: req.method, route, headers: req.headers, body, query }).then(send, (e) =>
        send({ status: 500, json: { ok: false, error: e.message } }));
    });
  };
}

// Keep-alive comment: an idle stream that writes nothing for minutes is one a
// proxy — or a laptop lid — is entitled to consider dead.
const SSE_PING_MS = 25_000;

/** Hold a Node response open and write events into it until the client leaves. */
function stream(res, req, hub, from = 0) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  for (const e of hub.since(from).events) res.write(frame(e));

  const off = hub.subscribe((e) => { try { res.write(frame(e)); } catch {} });
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, SSE_PING_MS);
  ping.unref?.();

  const done = () => { clearInterval(ping); off(); };
  res.on('close', done);
  res.on('error', done);
  req.on('aborted', done);
}

/** The two script tags a host has to put in the page. */
export function clientTags(cfg = {}, mount = MOUNT) {
  return {
    config: `window.__UI_GRAB_CFG=${JSON.stringify({ endpoint: mount + '/queue', ...cfg })};`,
    src: `${mount}/client.js`,
  };
}
