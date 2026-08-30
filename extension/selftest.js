// Loaded only for a localhost page whose URL contains `uigrab-selftest`.
// Drives the real extension end to end and reports via document.title, so a
// headless run can assert on it.
(async () => {
  const until = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    return null;
  };
  try {
    const g = await until(() => window.__uiGrab);
    if (!g) throw new Error('picker never booted');

    const targets = [...document.querySelectorAll('[data-selftest]')];
    if (!targets.length) throw new Error('no [data-selftest] elements on the page');

    g.open(true);
    g.setPicking(true);
    for (const el of targets) {
      g.pick(el);
      g.comment(el.getAttribute('data-selftest'));
      await g.add();
    }
    if (g.items().length !== targets.length) {
      throw new Error(`queued ${g.items().length}, expected ${targets.length}`);
    }
    const shots = g.items().filter((i) => i.screenshot).length;
    const r = await g.send();
    document.title = r.ok ? `OK:${r.added}:shots=${shots}:${r.target || '?'}` : `FAIL:${r.error}`;
  } catch (e) {
    document.title = 'FAIL:' + e.message;
  }
})();
