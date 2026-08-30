// Vite transport for extension/picker.js — same picker, different plumbing.
// Served by the plugin ahead of the picker itself.
window.__UI_GRAB_HOST__ = {
  cfg: window.__UI_GRAB_CFG || {},

  send: async (items) => {
    const endpoint = (window.__UI_GRAB_CFG || {}).endpoint || '/__ui-grab/queue';
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return body;
  },

  // No screenshots here: in-page JS cannot capture its own tab, and
  // getDisplayMedia would prompt on every pick.
  shot: null,

  load: () => {
    try { return JSON.parse(localStorage.getItem('ui-grab:items')) || []; } catch { return []; }
  },
  save: (items) => {
    try { localStorage.setItem('ui-grab:items', JSON.stringify(items)); } catch {}
  },
};
