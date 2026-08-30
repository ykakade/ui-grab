// The HTTP surface, once, for every host that has one.
//
// Only src/index.js knows about Vite. This file knows about the four things the
// picker asks a server to do: take a batch, take a verdict on a batch, put a
// batch back, and hand over its own source.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest } from './ingest.js';
import { applyResults } from './verify.js';
import { revert } from './snapshot.js';
import { loadConfig, wakes } from './config.js';
import { readQueue, fromLocalPage } from './queue.js';
import { wake } from './wake.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOUNT = '/__ui-grab';
const ROUTES = new Set(['', '/queue', '/verify', '/revert', '/client.js']);
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
  screenshots = false, log = () => {},
} = {}) {
  return async function handle({ method, route, headers = {}, body }) {
    // Everything below writes work for an agent to carry out, so it is gated on
    // the request having come from a page served locally.
    if (!fromLocalPage({ headers })) {
      return { status: 403, json: { ok: false, error: 'ui-grab only accepts picks from a local page' } };
    }

    if (route === '/client.js' && method === 'GET') {
      return { status: 200, text: clientSource(), type: 'text/javascript' };
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

      // A queue nobody reads is a queue that did nothing. A busy session will
      // see it via the Stop hook; an idle one has to be poked.
      let woke = null;
      const cfg = loadConfig(root);
      if (wakes(cfg)) {
        try {
          woke = wake(root, cfg, out.pending, path.relative(root, queueFile));
          if (woke.woke) log(`  woke via ${woke.via}: ${woke.detail}`);
        } catch (e) {
          log(`  wake failed: ${e.message}`);
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
    const url = (req.url || '/').split('?')[0];
    let route = url;
    if (route === mount || route.startsWith(mount + '/')) route = route.slice(mount.length);
    if (route === '/') route = '';
    // Connect strips the mount before calling; a bare `http` server does not.
    // Either way, anything that is not ours goes back to the host.
    if (!ROUTES.has(route) && typeof next === 'function') return next();

    const send = ({ status, json, text, type }) => {
      res.statusCode = status;
      res.setHeader('content-type', type || 'application/json');
      res.end(text !== undefined ? text : JSON.stringify(json));
    };

    if (req.method === 'GET' || req.method === 'HEAD') {
      core({ method: 'GET', route, headers: req.headers }).then(send, (e) =>
        send({ status: 500, json: { ok: false, error: e.message } }));
      return;
    }

    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let body;
      try { body = JSON.parse(raw || '{}'); }
      catch (e) { return send({ status: 400, json: { ok: false, error: e.message } }); }
      core({ method: req.method, route, headers: req.headers, body }).then(send, (e) =>
        send({ status: 500, json: { ok: false, error: e.message } }));
    });
  };
}

/** The two script tags a host has to put in the page. */
export function clientTags(cfg = {}, mount = MOUNT) {
  return {
    config: `window.__UI_GRAB_CFG=${JSON.stringify({ endpoint: mount + '/queue', ...cfg })};`,
    src: `${mount}/client.js`,
  };
}
