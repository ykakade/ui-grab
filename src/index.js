import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { GRAB_COMMAND } from './grab-command.js';
import { createMiddleware, clientSource, clientTags, MOUNT } from './middleware.js';
import { hubFor } from './activity.js';
import { VERSION } from './version.js';

/**
 * @param {object} [opts]
 * @param {string}  [opts.queueFile]   Where the queue lives. Default `<root>/.ui-grab/queue.json`.
 * @param {boolean} [opts.enabled]     Turn the whole thing off. Default true.
 * @param {string}  [opts.hotkey]      Toggle combo. Default 'Alt+Shift+G'.
 * @param {boolean} [opts.badge]       Show the small launcher badge. Default true.
 * @param {boolean} [opts.resolve]     Attach source candidates. Default true.
 * @param {boolean} [opts.source]      Embed the enclosing declaration when the
 *                                     pointer is not already confident. Default true.
 * @param {boolean} [opts.adaptive]    Send one pointer instead of four when the
 *                                     match is certain. Default true.
 * @param {'queue'|'drain'} [opts.resolveAt]
 *                                     When to look the source up. 'drain' waits
 *                                     until `ui-grab-drain` reads the queue, so
 *                                     the pointer is always current. Default 'queue'.
 * @param {boolean} [opts.shots]       Offer screenshot capture in the picker.
 *                                     Costs one browser permission prompt per
 *                                     session. Default false.
 * @param {boolean} [opts.verify]      Re-measure picked elements after an edit
 *                                     lands, to learn where they really live.
 *                                     Default true.
 * @param {boolean} [opts.installCommand] Create `.claude/commands/grab.md` if absent. Default true.
 * @param {boolean} [opts.react]       Use react-grab when the project has it. Default true.
 */
const CLIENT_URL = MOUNT + '/client.js';

export default function uiGrab(opts = {}) {
  const {
    enabled = true,
    hotkey = 'Alt+Shift+G',
    badge = true,
    resolve = true,
    source = true,
    adaptive = true,
    resolveAt = 'queue',
    shots = false,
    verify = true,
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

    // The client is served as a module id rather than off the middleware, so
    // Vite's import analysis can resolve it instead of warning that a script
    // tag points at a file it cannot pre-transform.
    resolveId(id) {
      return id === CLIENT_URL ? CLIENT_URL : null;
    },

    load(id) {
      return id === CLIENT_URL ? clientSource() : null;
    },

    // Runs before configResolved, so it does its own lookup. Including a
    // package that is not installed makes the optimizer fail the whole dev
    // server, so this must stay guarded.
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

      const atQueue = resolveAt !== 'drain';
      const hub = hubFor(root);
      server.middlewares.use(MOUNT, createMiddleware({
        root,
        queueFile,
        resolve: resolve && atQueue,
        source: source && atQueue,
        adaptive,
        screenshots: shots,
        hub,
        log: (line) => logger.info?.(line),
      }));

      // The hub's timers are unref'd, so a forgotten one cannot hold the
      // process open — but a restarted dev server should not leave a watcher
      // behind on the old root either.
      server.httpServer?.on('close', () => hub.close());
    },

    transformIndexHtml: {
      order: 'pre',
      handler() {
        if (!enabled) return;
        const { config, src } = clientTags({
          hotkey, badge, react: hasReactGrab, version: VERSION, shots, verify,
        });
        const tags = [
          { tag: 'script', attrs: { type: 'module' }, injectTo: 'body', children: config },
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
        tags.push({ tag: 'script', attrs: { type: 'module', src }, injectTo: 'body' });
        return tags;
      },
    },
  };
}
