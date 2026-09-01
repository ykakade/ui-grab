const PORTS = [7317, 7318, 7319, 7320];
let bridge = null; // { base, name, root, port }

async function probe(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 600);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: ctl.signal, cache: 'no-store' });
    const b = await r.json();
    if (b && b.service === 'ui-grab') return { base: `http://127.0.0.1:${port}`, port, ...b };
  } catch {} finally { clearTimeout(t); }
  return null;
}

async function findBridge(force = false) {
  if (bridge && !force) {
    const still = await probe(bridge.port);
    if (still) return (bridge = still);
  }
  for (const p of PORTS) {
    const found = await probe(p);
    if (found) return (bridge = found);
  }
  bridge = null;
  return null;
}

async function inject(tabId) {
  const { settings } = await chrome.storage.local.get('settings');
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (cfg) => { window.__UI_GRAB_CFG = cfg; },
    args: [{ hotkey: 'Alt+Shift+G', badge: true, shots: false, verify: true, ...(settings || {}) }],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['transport.js', 'picker.js'],
  });
}

export async function toggleOn(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'toggle' });
  } catch {
    await inject(tabId); // first time on this page
  }
}

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-picker') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) toggleOn(tab.id);
});

// Crop the visible tab down to the picked element.
async function shot(tabId, rect, dpr) {
  const tab = await chrome.tabs.get(tabId);
  const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const bmp = await createImageBitmap(await (await fetch(url)).blob());
  const pad = 10;
  const x = Math.max(0, (rect.x - pad) * dpr);
  const y = Math.max(0, (rect.y - pad) * dpr);
  const w = Math.min(bmp.width - x, (rect.width + pad * 2) * dpr);
  const h = Math.min(bmp.height - y, (rect.height + pad * 2) * dpr);
  if (w < 2 || h < 2) return null;
  const scale = Math.min(1, 1000 / w);
  const cv = new OffscreenCanvas(Math.round(w * scale), Math.round(h * scale));
  cv.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, cv.width, cv.height);
  const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/png' })).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return 'data:image/png;base64,' + btoa(s);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'send': {
          const b = await findBridge();
          if (!b) {
            return reply({ ok: false, error: 'no bridge — run `npx ui-grab-bridge` in your project' });
          }
          const r = await fetch(`${b.base}/queue`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ items: msg.items }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
          return reply(body);
        }
        case 'setConfig': {
          const b = await findBridge();
          if (!b) return reply({ ok: false, error: 'bridge not running' });
          const r = await fetch(`${b.base}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(msg.config || {}),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
          bridge = { ...bridge, config: body.config }; // keep the cached health fresh
          return reply(body);
        }
        case 'verify':
        case 'revert': {
          const b = await findBridge();
          if (!b) return reply({ ok: false, error: 'bridge not running' });
          const r = await fetch(`${b.base}/${msg.type}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(msg.type === 'verify' ? { results: msg.results } : { batch: msg.batch }),
          });
          const body = await r.json().catch(() => ({}));
          if (!r.ok || !body.ok) throw new Error(body.error || `HTTP ${r.status}`);
          return reply(body);
        }
        // Polled rather than streamed, and quiet about a missing bridge: this
        // runs every couple of seconds, so a bridge that is not up yet must not
        // fill the page's console with failures.
        case 'events': {
          const b = await findBridge();
          if (!b) return reply({ ok: true, events: [], seq: msg.since || 0 });
          const r = await fetch(`${b.base}/events?since=${msg.since || 0}`, { cache: 'no-store' });
          const body = await r.json().catch(() => ({}));
          return reply(r.ok && body.ok ? body : { ok: true, events: [], seq: msg.since || 0 });
        }
        case 'shot':
          return reply({ ok: true, dataUrl: await shot(sender.tab.id, msg.rect, msg.dpr) });
        case 'status':
          return reply({ ok: true, bridge: await findBridge(msg.force) });
        case 'toggle': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab?.id) await toggleOn(tab.id);
          return reply({ ok: true });
        }
        default:
          return reply({ ok: false, error: 'unknown message ' + msg.type });
      }
    } catch (e) {
      reply({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

// Self-test hook: only fires for a localhost page carrying the marker hash.
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(tab.url)) return;
  if (!tab.url.includes('uigrab-selftest')) return;
  await inject(tabId);
  await chrome.scripting.executeScript({ target: { tabId }, files: ['selftest.js'] });
});
