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
