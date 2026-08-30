// The bridge: a tiny local HTTP server the Chrome extension posts batches to.
// One bridge per project — it writes into that project's .claude/ directory.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { resolveBatch } from '../src/resolve.js';
import { extractSource } from '../src/extract.js';
import { GRAB_COMMAND } from '../src/grab-command.js';
import { loadConfig, saveConfig, wakes } from '../src/config.js';
import { readQueue, writeQueue, fromLocalPage } from '../src/queue.js';
import { VERSION } from '../src/version.js';
import { wake } from '../src/wake.js';

export const DEFAULT_PORTS = [7317, 7318, 7319, 7320];
const MAX_BODY = 48 * 1024 * 1024; // screenshots are base64, so allow room

export function createBridge({ root, quiet = false, resolve = true, source = true, screenshots = false } = {}) {
  root = path.resolve(root || process.cwd());
  const name = path.basename(root);
  const queueFile = path.join(root, '.ui-grab/queue.json');
  const shotDir = path.join(root, '.ui-grab/shots');
  const log = (...a) => !quiet && console.log(...a);

  function ensureCommand() {
    const cmd = path.join(root, '.claude/commands/grab.md');
    if (fs.existsSync(cmd)) return;
    fs.mkdirSync(path.dirname(cmd), { recursive: true });
    fs.writeFileSync(cmd, GRAB_COMMAND);
    log(`  created ${path.relative(root, cmd)}`);
  }

  // A screenshot is far more useful to an agent as a file it can open than as
  // a megabyte of base64 sitting in the queue JSON.
  function saveShot(id, dataUrl) {
    const m = /^data:image\/(png|jpeg);base64,(.+)$/s.exec(dataUrl || '');
    if (!m) return null;
    fs.mkdirSync(shotDir, { recursive: true });
    const rel = path.join('.ui-grab/shots', `${id}.${m[1] === 'jpeg' ? 'jpg' : 'png'}`);
    fs.writeFileSync(path.join(root, rel), Buffer.from(m[2], 'base64'));
    return rel;
  }

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
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'OPTIONS') return res.writeHead(allowed ? 204 : 403).end();
    if (!allowed) return json(403, { ok: false, error: 'ui-grab only accepts picks from a local page' });

    if (url === '/health' || url === '/') {
      return json(200, {
        ok: true, service: 'ui-grab', version: VERSION,
        name, root, pending: readQueue(queueFile).items.length,
        config: loadConfig(root),
      });
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
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > MAX_BODY) { req.destroy(); }
      });
      req.on('end', () => {
        let incoming;
        try {
          const parsed = JSON.parse(body || '{}');
          incoming = Array.isArray(parsed) ? parsed : parsed.items;
          if (!Array.isArray(incoming)) throw new Error('expected { items: [...] }');
        } catch (e) {
          return json(400, { ok: false, error: e.message });
        }

        // One pass over the project for the whole batch, not one per item.
        let resolved = incoming.map(() => []);
        if (resolve) {
          try { resolved = resolveBatch(root, incoming); }
          catch (e) { log(`  resolve failed: ${e.message}`); }
        }

        const queuedAt = new Date().toISOString();
        const stamped = incoming.map((item, i) => {
          const { screenshot, ...rest } = item;
          const out = { ...rest, queuedAt };
          if (screenshots && screenshot) {
            try {
              const rel = saveShot(item.id, screenshot);
              if (rel) out.screenshot = rel;
            } catch (e) {
              log(`  screenshot save failed: ${e.message}`);
            }
          }
          if (resolve) out.candidates = resolved[i];
          if (source) {
            try { out.source = extractSource(root, out.candidates || []); }
            catch (e) { out.source = []; log(`  extract failed: ${e.message}`); }
          }
          return out;
        });

        const q = readQueue(queueFile);
        q.items.push(...stamped);
        writeQueue(queueFile, q);

        for (const it of stamped) {
          const where = it.candidates?.[0];
          const src = it.source?.length
            ? `  [${it.source.map((b) => `${b.file}:${b.lines}`).join(', ')}]` : '';
          log(`  + <${it.tag}> ${JSON.stringify((it.comment || '').slice(0, 52))}` +
              (where ? `  → ${where.file}:${where.line}` : '') + src);
        }
        log(`  ${q.items.length} pending in ${path.relative(root, queueFile)}`);

        // The queue is only useful once something reads it. A busy session
        // will via its Stop hook; an idle one has to be poked.
        let woke = null;
        const cfg = loadConfig(root);
        if (wakes(cfg)) {
          try {
            woke = wake(root, cfg, q.items.length, path.relative(root, queueFile));
            log(woke.woke ? `  woke via ${woke.via}: ${woke.detail}`
              : woke.via === 'busy' ? `  ${woke.detail} is mid-turn — its Stop hook will drain this`
              : `  nothing woken: ${woke.detail}`);
          } catch (e) {
            log(`  wake failed: ${e.message}`);
          }
        }

        json(200, { ok: true, added: stamped.length, pending: q.items.length, target: name, woke });
      });
      return;
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
    server, listen, ensureCommand, root, name, queueFile,
    readQueue: () => readQueue(queueFile),
    writeQueue: (q) => writeQueue(queueFile, q),
  };
}
