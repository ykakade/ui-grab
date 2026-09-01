// The bridge: a tiny local HTTP server the Chrome extension posts batches to.
// One bridge per project — it writes into that project's .claude/ directory.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ingest } from '../src/ingest.js';
import { applyResults } from '../src/verify.js';
import { revert } from '../src/snapshot.js';
import { GRAB_COMMAND } from '../src/grab-command.js';
import { loadConfig, saveConfig, wakes } from '../src/config.js';
import { readQueue, writeQueue, fromLocalPage } from '../src/queue.js';
import { emit, hubFor } from '../src/activity.js';
import { VERSION } from '../src/version.js';
import { wake } from '../src/wake.js';

export const DEFAULT_PORTS = [7317, 7318, 7319, 7320];
const MAX_BODY = 48 * 1024 * 1024; // screenshots are base64, so allow room

/** Read a JSON body, then hand it to `then` — or answer 400 and stop. */
function readBody(req, res, limit, then) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > limit) req.destroy(); });
  req.on('end', () => {
    const fail = (msg) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: msg }));
    };
    let parsed;
    try { parsed = JSON.parse(raw || '{}'); } catch (e) { return fail(e.message); }
    then(parsed, fail);
  });
}

export function createBridge({ root, quiet = false, resolve = true, source = true, adaptive = true, screenshots = false } = {}) {
  root = path.resolve(root || process.cwd());
  const name = path.basename(root);
  const queueFile = path.join(root, '.ui-grab/queue.json');
  const log = (...a) => !quiet && console.log(...a);

  function ensureCommand() {
    const cmd = path.join(root, '.claude/commands/grab.md');
    if (fs.existsSync(cmd)) return;
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    fs.writeFileSync(cmd, GRAB_COMMAND);
    log(`  created ${path.relative(root, cmd)}`);
  }

  const hub = hubFor(root);

  const server = http.createServer((req, res) => {
    // The extension and local dev pages, and nobody else — `*` here would let
    // any site you have open read the project path out of /health and post
    // instructions to /queue.
    const origin = req.headers.origin;
    const allowed = fromLocalPage(req, { extensions: true });
    if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const [url, search] = (req.url || '/').split('?');
    const query = Object.fromEntries(new URLSearchParams(search || ''));

    if (req.method === 'OPTIONS') return res.writeHead(allowed ? 204 : 403).end();
    if (!allowed) return json(403, { ok: false, error: 'ui-grab only accepts picks from a local page' });

    if (url === '/health' || url === '/') {
      return json(200, {
        ok: true, service: 'ui-grab', version: VERSION,
        name, root, pending: readQueue(queueFile).items.length,
        config: loadConfig(root),
      });
    }

    // The status stream, polled rather than streamed: the extension's page is
    // on someone else's origin, so its EventSource could never reach us here.
    // Same log, same events, one fetch every couple of seconds.
    if (url === '/events' && req.method === 'GET') {
      return json(200, { ok: true, ...hub.poll(Number(query.since) || 0) });
    }

    if (url === '/config') {
      if (req.method === 'GET') return json(200, { ok: true, config: loadConfig(root) });
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 8192) req.destroy(); });
        req.on('end', () => {
          try {
            const cfg = saveConfig(root, JSON.parse(body || '{}'));
            log(`  mode → ${cfg.mode}` + (cfg.mode === 'off' ? '' : `  (wait ${cfg.waitSeconds}s)`));
            json(200, { ok: true, config: cfg });
          } catch (e) {
            json(400, { ok: false, error: e.message });
          }
        });
        return;
      }
      return json(405, { ok: false, error: 'use GET or POST' });
    }

    if (url === '/queue' && req.method === 'POST') {
      return readBody(req, res, MAX_BODY, (parsed, fail) => {
        const incoming = Array.isArray(parsed) ? parsed : parsed.items;
        if (!Array.isArray(incoming)) return fail('expected { items: [...] }');

        const out = ingest(root, queueFile, incoming, {
          resolve, source, adaptive, screenshots, log,
        });

        for (const it of out.items) {
          const where = (it.candidates || [])[0];
          log(`  + <${it.tag}> ${JSON.stringify((it.comment || '').slice(0, 52))}` +
              (where ? `  → ${where.file}:${where.line} [${where.matchedBy}]` : '') +
              (it.sourceRefs?.length ? `  [${it.sourceRefs.join(', ')}]` : ''));
        }
        log(`  ${out.pending} pending in ${path.relative(root, queueFile)}`);

        emit(root, 'queued', {
          n: out.items.length,
          pending: out.pending,
          batch: out.batch,
          asks: out.items.filter((i) => i.kind === 'ask').length,
        });

        // The queue is only useful once something reads it. A busy session
        // will via its Stop hook; an idle one has to be poked.
        let woke = null;
        const cfg = loadConfig(root);
        if (wakes(cfg)) {
          try {
            woke = wake(root, cfg, out.pending, path.relative(root, queueFile));
            log(woke.woke ? `  woke via ${woke.via}: ${woke.detail}`
              : woke.via === 'busy' ? `  ${woke.detail} is mid-turn — its Stop hook will drain this`
              : `  nothing woken: ${woke.detail}`);
            emit(root, 'woke', woke);
          } catch (e) {
            log(`  wake failed: ${e.message}`);
            emit(root, 'woke', { woke: false, via: 'error', detail: e.message });
          }
        }

        json(200, { ok: true, added: out.items.length, pending: out.pending,
                    batch: out.batch, target: name, woke });
      });
    }

    // The browser re-measures what it picked once the agent has been through,
    // and says which elements actually moved. That is the only signal here that
    // knows whether the pointer we shipped was right.
    if (url === '/verify' && req.method === 'POST') {
      return readBody(req, res, 256 * 1024, (parsed, fail) => {
        if (!Array.isArray(parsed.results)) return fail('expected { results: [...] }');
        json(200, { ok: true, ...applyResults(root, parsed.results) });
      });
    }

    if (url === '/revert' && req.method === 'POST') {
      return readBody(req, res, 8192, (parsed) => {
        const out = revert(root, parsed.batch);
        log(out.ok ? `  reverted ${out.files.length} file(s)` : `  revert failed: ${out.error}`);
        json(out.ok ? 200 : 400, out);
      });
    }

    json(404, { ok: false, error: 'not found' });
  });

  async function listen(ports = DEFAULT_PORTS) {
    for (const port of ports) {
      const got = await new Promise((done) => {
        const onErr = (e) => done(e.code === 'EADDRINUSE' ? false : Promise.reject(e));
        server.once('error', onErr);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onErr);
          done(true);
        });
      });
      if (got) return port;
    }
    throw new Error(`no free port in ${ports.join(', ')} — is a bridge already running?`);
  }

  return {
    server, listen, ensureCommand, root, name, queueFile, hub,
    readQueue: () => readQueue(queueFile),
    writeQueue: (q) => writeQueue(queueFile, q),
  };
}
