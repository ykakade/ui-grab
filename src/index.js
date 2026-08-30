import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolveBatch } from './resolve.js';
import { extractSource } from './extract.js';
import { GRAB_COMMAND } from './grab-command.js';
import { loadConfig, wakes } from './config.js';
import { readQueue, writeQueue, fromLocalPage } from './queue.js';
import { VERSION } from './version.js';
import { wake } from './wake.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_URL = '/__ui-grab/client.js';
const QUEUE_URL = '/__ui-grab/queue';

/**
 * @param {object} [opts]
 * @param {string}  [opts.queueFile]   Where the queue lives. Default `<root>/.ui-grab/queue.json`.
 * @param {boolean} [opts.enabled]     Turn the whole thing off. Default true.
 * @param {string}  [opts.hotkey]      Toggle combo. Default 'Alt+Shift+G'.
 * @param {boolean} [opts.badge]       Show the small launcher badge. Default true.
 * @param {boolean} [opts.resolve]     Attach grep candidates server-side. Default true.
 * @param {boolean} [opts.source]      Embed the enclosing source for each candidate. Default true.
 * @param {boolean} [opts.installCommand] Create `.claude/commands/grab.md` if absent. Default true.
 * @param {boolean} [opts.react]       Use react-grab for exact component/source
 *                                     resolution when the project has it installed.
 *                                     Default true (a no-op if it isn't).
 */
export default function uiGrab(opts = {}) {
  const {
    enabled = true,
    hotkey = 'Alt+Shift+G',
    badge = true,
    resolve = true,
    source = true,
    installCommand = true,
    react = true,
  } = opts;

  let root = process.cwd();
  let queueFile;
  let logger = console;
  // Resolved from the *project*, not from ui-grab — react-grab has to be the
  // same copy that instrumented the app's own React.
  let hasReactGrab = false;
  const findReactGrab = (from) => {
    try {
      createRequire(path.join(path.resolve(from), 'package.json')).resolve('react-grab/primitives');
      return true;
    } catch {
      return false; // not installed — grep resolution still works
    }
  };

  return {
    name: 'ui-grab',
    apply: 'serve',

    // Runs before configResolved, so it does its own lookup. Including a
    // package that is not installed makes the optimizer fail the whole dev
    // server, so this must stay guarded.
    resolveId(id) {
      return id === CLIENT_URL ? CLIENT_URL : null;
    },

    // The picker itself lives in the extension directory — one source of truth
    // for both hosts, so they can never drift.
    load(id) {
      if (id !== CLIENT_URL) return null;
      return (
        fs.readFileSync(path.join(HERE, 'vite-transport.js'), 'utf8') + '\n' +
        fs.readFileSync(path.join(HERE, '../extension/picker.js'), 'utf8')
      );
    },

    config(userConfig) {
      if (!enabled || !react) return;
      if (!findReactGrab(userConfig.root || process.cwd())) return;
      return { optimizeDeps: { include: ['react-grab/primitives'] } };
    },

    configResolved(config) {
      root = config.root;
      logger = config.logger || console;
      queueFile = opts.queueFile
        ? path.resolve(root, opts.queueFile)
        : path.resolve(root, '.ui-grab/queue.json');

      hasReactGrab = react && findReactGrab(root);
    },

    configureServer(server) {
      if (!enabled) return;

      if (installCommand) {
        const cmd = path.resolve(root, '.claude/commands/grab.md');
        if (!fs.existsSync(cmd)) {
          fs.mkdirSync(path.dirname(cmd), { recursive: true });
          fs.writeFileSync(cmd, GRAB_COMMAND);
          logger.info?.(`  ui-grab  created ${path.relative(root, cmd)}`);
        }
      }

      server.middlewares.use(QUEUE_URL, (req, res) => {
        const json = (code, body) => {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
        };

        // Everything below writes work for an agent to carry out, so it is
        // gated on the request having come from a page served locally.
        if (!fromLocalPage(req)) {
          return json(403, { ok: false, error: 'ui-grab only accepts picks from a local page' });
        }
        if (req.method === 'GET') {
          return json(200, { ok: true, pending: readQueue(queueFile).items.length });
        }
        if (req.method !== 'POST') return json(405, { ok: false, error: 'use POST' });

        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 8 * 1024 * 1024) req.destroy();
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
          const resolved = resolve ? safeResolve(incoming) : incoming.map(() => []);
          const queuedAt = new Date().toISOString();
          const stamped = incoming.map((item, i) => {
            const candidates = resolved[i];
            const out = { ...item, queuedAt, candidates };
            if (source) {
              try { out.source = extractSource(root, candidates); }
              catch (e) { out.source = []; logger.warn?.(`  ui-grab  extract failed: ${e.message}`); }
            }
            return out;
          });

          const q = readQueue(queueFile);
          q.items.push(...stamped);
          writeQueue(queueFile, q);

          // Same as the bridge: a batch nobody reads is a batch that did
          // nothing. Busy sessions self-serve via the Stop hook.
          const cfg = loadConfig(root);
          if (wakes(cfg)) {
            try {
              const woke = wake(root, cfg, q.items.length, path.relative(root, queueFile));
              if (woke.woke) logger.info?.(`  ui-grab  woke via ${woke.via}: ${woke.detail}`);
            } catch (e) {
              logger.warn?.(`  ui-grab  wake failed: ${e.message}`);
            }
          }

          const n = stamped.length;
          logger.info?.(
            `  ui-grab  queued ${n} change${n === 1 ? '' : 's'} ` +
              `(${q.items.length} pending) → ${path.relative(root, queueFile)}`
          );
          json(200, { ok: true, added: n, pending: q.items.length });
        });
      });

      function safeResolve(items) {
        try {
          return resolveBatch(root, items);
        } catch (e) {
          logger.warn?.(`  ui-grab  resolve failed: ${e.message}`);
          return items.map(() => []);
        }
      }
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
      if (!enabled) return;
      const tags = [
        {
          tag: 'script',
          attrs: { type: 'module' },
          injectTo: 'body',
          children:
            `window.__UI_GRAB_CFG=${JSON.stringify({
              endpoint: QUEUE_URL, hotkey, badge, react: hasReactGrab, version: VERSION,
            })};`,
        },
      ];
      // An inline module *is* run through Vite's import analysis, unlike the
      // raw client script below — which is why the bare specifier resolves.
      if (hasReactGrab) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          injectTo: 'body',
          children:
            `window.__UI_GRAB_RG_READY__ = import('react-grab/primitives')\n` +
            `  .then((m) => (window.__UI_GRAB_RG__ = m))\n` +
            `  .catch((e) => { console.warn('[ui-grab] react-grab unavailable:', e?.message); return null; });`,
        });
      }
      tags.push({ tag: 'script', attrs: { type: 'module', src: CLIENT_URL }, injectTo: 'body' });
      return tags;
      },
    },
  };
}
