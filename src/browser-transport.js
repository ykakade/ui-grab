// Browser transport for extension/picker.js — same picker, different plumbing.
// Served ahead of the picker itself by any host that speaks the HTTP endpoints:
// the Vite plugin, or a Next.js route.
window.__UI_GRAB_HOST__ = (() => {
  const cfg = window.__UI_GRAB_CFG || {};
  const base = cfg.endpoint || '/__ui-grab/queue';
  const at = (name) => base.replace(/\/queue$/, '') + '/' + name;

  const post = async (url, payload) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return body;
  };

  // Screenshots are off unless you ask for them, and they cost one browser
  // permission prompt for the whole session rather than one per pick: the
  // display stream is opened once and every crop is taken from it.
  let stream = null;
  let video = null;

  async function surface() {
    if (stream && stream.active) return stream;
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser' },
      preferCurrentTab: true,
      audio: false,
    });
    stream.getVideoTracks()[0].addEventListener('ended', () => { stream = null; });
    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    return stream;
  }

  return {
    cfg,

    send: (items) => post(base, { items }),
    verify: (results) => post(at('verify'), { results }),
    revert: (batch) => post(at('revert'), { batch }),

    shot: async (rect) => {
      if (!navigator.mediaDevices?.getDisplayMedia) return null;
      await surface();
      // The dock is already hidden by the caller; give the compositor a frame
      // to catch up or the crop still has it in.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const sx = vw / innerWidth, sy = vh / innerHeight;
      const pad = 6;
      const x = Math.max(0, (rect.x - pad) * sx);
      const y = Math.max(0, (rect.y - pad) * sy);
      const w = Math.min(vw - x, (rect.width + pad * 2) * sx);
      const h = Math.min(vh - y, (rect.height + pad * 2) * sy);
      if (w < 1 || h < 1) return null;

      const scale = Math.min(1, 1200 / w);
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round(h * scale);
      c.getContext('2d').drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
      return c.toDataURL('image/png');
    },

    load: () => {
      try { return JSON.parse(localStorage.getItem('ui-grab:items')) || []; } catch { return []; }
    },
    save: (items) => {
      // Crops are large and localStorage is small. Losing one on reload costs
      // nothing; the comment and every pointer still survive.
      try {
        localStorage.setItem('ui-grab:items',
          JSON.stringify(items.map(({ screenshot, ...rest }) => rest)));
      } catch {}
    },
    loadState: (k) => { try { return JSON.parse(localStorage.getItem('ui-grab:' + k)); } catch { return null; } },
    saveState: (k, v) => { try { localStorage.setItem('ui-grab:' + k, JSON.stringify(v)); } catch {} },
  };
})();
