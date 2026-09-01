// Chrome transport for shared/picker.js. Content scripts share one isolated
// world, so this and the picker see the same `window` — and the host page
// cannot see either of them.
window.__UI_GRAB_HOST__ = {
  cfg: window.__UI_GRAB_CFG || {},

  send: (items) =>
    chrome.runtime.sendMessage({ type: 'send', items }).catch((e) => ({ ok: false, error: e.message })),

  shot: (rect) =>
    chrome.runtime
      .sendMessage({ type: 'shot', rect, dpr: devicePixelRatio })
      .then((r) => (r && r.ok ? r.dataUrl : null))
      .catch(() => null),

  verify: (results) =>
    chrome.runtime.sendMessage({ type: 'verify', results }).catch((e) => ({ ok: false, error: e.message })),

  revert: (batch) =>
    chrome.runtime.sendMessage({ type: 'revert', batch }).catch((e) => ({ ok: false, error: e.message })),

  // The page is on someone else's origin and the bridge is on 127.0.0.1, so an
  // EventSource from here would never connect. The worker can reach the bridge,
  // so the same log arrives a poll at a time instead of a frame at a time.
  events: (onEvent) => {
    const EVERY = 2000;
    let since = 0;
    let stopped = false;
    let timer = null;

    const tick = async () => {
      if (stopped) return;
      try {
        const r = await chrome.runtime.sendMessage({ type: 'events', since });
        if (r && r.ok) {
          for (const e of r.events || []) {
            since = Math.max(since, e.seq || 0);
            onEvent(e);
          }
        }
      } catch {}
      if (!stopped) timer = setTimeout(tick, EVERY);
    };

    tick();
    return () => { stopped = true; clearTimeout(timer); };
  },

  load: () =>
    chrome.storage.local.get('items').then((d) => d.items || []).catch(() => []),

  // Screenshots stay in memory only. They are large, chrome.storage.local has a
  // quota, and losing a crop on reload costs nothing — the comment and every
  // piece of metadata still survive.
  save: (items) => {
    const lean = items.map(({ screenshot, ...rest }) => rest);
    chrome.storage.local.set({ items: lean }).catch(() => {});
  },

  loadState: (k) => chrome.storage.local.get('st:' + k).then((d) => d['st:' + k] ?? null).catch(() => null),
  saveState: (k, v) => { chrome.storage.local.set({ ['st:' + k]: v }).catch(() => {}); },
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'toggle' && window.__uiGrab) window.__uiGrab.toggle();
});
