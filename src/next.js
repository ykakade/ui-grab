// Next.js adapter.
//
// The plugin half of ui-grab is Vite-specific; nothing else is. A Next app gets
// the same picker by mounting one dev-only route handler and two script tags.
//
//   // app/__ui-grab/[...path]/route.js
//   import { createHandlers } from 'vite-plugin-ui-grab/next';
//   export const { GET, POST } = createHandlers();
//
//   // app/layout.js, inside <body>
//   import { uiGrabScripts } from 'vite-plugin-ui-grab/next';
//   const g = uiGrabScripts();
//   {process.env.NODE_ENV === 'development' && (
//     <>
//       <script dangerouslySetInnerHTML={{ __html: g.config }} />
//       <script type="module" src={g.src} />
//     </>
//   )}
import path from 'node:path';
import { createCore, clientTags, MOUNT } from './middleware.js';
import { frame } from './activity.js';
import { VERSION } from './version.js';

/**
 * Route handlers for `app/__ui-grab/[...path]/route.js`.
 *
 * Refuses to run in a production build. This endpoint queues instructions for
 * an agent; it belongs to `next dev` and nowhere else.
 */
export function createHandlers({
  root = process.cwd(), mount = MOUNT, queueFile, dev = process.env.NODE_ENV !== 'production',
  ...opts
} = {}) {
  const core = createCore({
    root,
    queueFile: queueFile || path.join(root, '.ui-grab/queue.json'),
    log: (line) => console.log(line),
    ...opts,
  });

  const handler = async (request) => {
    if (!dev) return json(404, { ok: false, error: 'ui-grab is dev-only' });

    const url = new URL(request.url);
    let route = url.pathname.startsWith(mount) ? url.pathname.slice(mount.length) : url.pathname;
    if (route === '/') route = '';

    const headers = Object.fromEntries(request.headers.entries());
    const query = Object.fromEntries(url.searchParams);
    let body;
    if (request.method !== 'GET') {
      try { body = await request.json(); } catch { body = {}; }
    }

    const out = await core({ method: request.method, route, headers, body, query });
    if (out.sse) return sse(out.sse, out.since, request.signal);
    if (out.text !== undefined) {
      return new Response(out.text, {
        status: out.status,
        headers: { 'content-type': out.type || 'text/plain', 'cache-control': 'no-store' },
      });
    }
    return json(out.status, out.json);
  };

  return { GET: handler, POST: handler };
}

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

const SSE_PING_MS = 25_000;

/**
 * The status stream, as a web Response. Same hub and same frames as the Connect
 * middleware — only the plumbing differs, because Next hands you a stream to
 * fill rather than a socket to write to.
 */
function sse(hub, from = 0, signal) {
  const enc = new TextEncoder();
  let off = () => {};
  let ping = null;

  const body = new ReadableStream({
    start(controller) {
      const push = (s) => { try { controller.enqueue(enc.encode(s)); } catch {} };
      push('retry: 2000\n\n');
      for (const e of hub.since(from).events) push(frame(e));
      off = hub.subscribe((e) => push(frame(e)));
      ping = setInterval(() => push(': ping\n\n'), SSE_PING_MS);
      ping.unref?.();
      // A client that navigates away leaves the hub subscribed otherwise, and
      // the watcher it started never stops.
      signal?.addEventListener('abort', () => { try { controller.close(); } catch {} });
    },
    cancel() { clearInterval(ping); off(); },
  });

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}

/** The inline config and the script URL to put in the layout, dev only. */
export function uiGrabScripts(cfg = {}, mount = MOUNT) {
  return clientTags({ version: VERSION, badge: true, hotkey: 'Alt+Shift+G', ...cfg }, mount);
}

export { MOUNT };
