// ui-grab picker — overlay, dock, element capture.
//
// Host-agnostic: everything that touches the outside world goes through
// window.__UI_GRAB_HOST__, which the chrome extension and the vite plugin each
// provide in their own way. This file is identical in both, so the picker can
// never drift between them.
//
//   HOST = {
//     cfg:   { hotkey, badge },
//     send:  (items) => Promise<{ ok, added?, pending?, error?, target? }>,
//     shot:  (rect)  => Promise<string|null>,   // optional, data: url
//     load:  ()      => Promise<item[]>,
//     save:  (items) => void,
//   }
(() => {
  if (window.__uiGrab) return;

  const HOST = window.__UI_GRAB_HOST__;
  if (!HOST) { console.error('[ui-grab] no transport installed'); return; }
  const CFG = Object.assign({ hotkey: 'Alt+Shift+G', badge: true }, HOST.cfg || {});

  const STYLE_KEYS = [
    'display', 'position', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'color', 'background-color', 'padding', 'margin', 'border', 'border-radius',
    'box-shadow', 'width', 'height', 'gap', 'flex-direction', 'align-items',
    'justify-content', 'text-align', 'opacity', 'overflow',
  ];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', '1', 'visible', '']);
  const ATTRS = ['data-testid', 'data-test-id', 'aria-label', 'role', 'name', 'type',
    'placeholder', 'alt', 'href', 'title'];

  /* ------------------------------- extraction ------------------------------ */

  const label = (el) => {
    const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls.length ? '.' + cls.join('.') : '');
  };

  function selector(el) {
    const parts = [];
    let e = el;
    while (e && e.nodeType === 1 && parts.length < 6 && e !== document.documentElement) {
      if (e.id) { parts.unshift('#' + CSS.escape(e.id)); break; }
      let s = e.tagName.toLowerCase();
      const p = e.parentElement;
      if (p) {
        const sibs = [...p.children].filter((c) => c.tagName === e.tagName);
        if (sibs.length > 1) s += `:nth-of-type(${sibs.indexOf(e) + 1})`;
      }
      parts.unshift(s);
      e = p;
    }
    return parts.join(' > ');
  }

  function styles(el) {
    const cs = getComputedStyle(el);
    const flex = /flex|grid/.test(cs.display);
    const out = {};
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k).trim();
      if (BORING.has(v)) continue;
      // A fully transparent border reads as a real one in the payload but isn't.
      if (k === 'border' && v.includes('rgba(0, 0, 0, 0)')) continue;
      // Layout props only mean something on a flex/grid container.
      if (!flex && ['flex-direction', 'align-items', 'justify-content', 'gap'].includes(k)) continue;
      out[k] = v;
    }
    return out;
  }

  function textOf(el) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el.value || el.placeholder || '').slice(0, 160);
    }
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs[a] = v.slice(0, 120);
    }
    const ancestors = [];
    let p = el.parentElement;
    while (p && ancestors.length < 3 && p !== document.documentElement) {
      ancestors.push({ tag: p.tagName.toLowerCase(), classes: p.getAttribute('class') || '' });
      p = p.parentElement;
    }
    const children = [...el.children].slice(0, 4).map((c) => ({
      tag: c.tagName.toLowerCase(),
      classes: c.getAttribute('class') || '',
    }));

    return {
      id: 'g' + Math.random().toString(36).slice(2, 9),
      url: location.href,
      route: location.pathname + location.search + location.hash,
      title: document.title,
      tag: el.tagName.toLowerCase(),
      elementId: el.id || '',
      classes: el.getAttribute('class') || '',
      selector: selector(el),
      text: textOf(el),
      attrs,
      styles: styles(el),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      ancestors,
      children,
      viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
      pickedAt: new Date().toISOString(),
    };
  }

  /* ----------------------------------- UI ---------------------------------- */

  const host = document.createElement('div');
  host.setAttribute('data-ui-grab', 'host');
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; }
      .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
      .box { position: fixed; border: 2px solid #7c9cff; background: rgba(124,156,255,.12);
             border-radius: 3px; display: none; transition: all .04s linear; }
      .tag { position: fixed; display: none; padding: 2px 6px; border-radius: 4px;
             background: #7c9cff; color: #0b1020; font-size: 11px; font-weight: 600;
             white-space: nowrap; font-variant-numeric: tabular-nums; }
      .dock { position: fixed; right: 16px; bottom: 16px; width: 320px; z-index: 2147483647;
              background: #14161c; color: #e8eaf0; border: 1px solid #2b303c;
              border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.5);
              font-size: 12px; overflow: hidden; display: none; }
      .dock.open { display: block; }
      .hd { display: flex; align-items: center; gap: 8px; padding: 9px 11px;
            border-bottom: 1px solid #2b303c; }
      .hd b { font-size: 12px; font-weight: 650; letter-spacing: .01em; }
      .dot { width: 6px; height: 6px; border-radius: 50%; background: #f0b849; }
      .dot.on { background: #4ade80; }
      .grow { flex: 1; }
      .x { cursor: pointer; opacity: .55; padding: 0 3px; font-size: 14px; line-height: 1; }
      .x:hover { opacity: 1; }
      .sec { padding: 9px 11px; border-bottom: 1px solid #2b303c; }
      .muted { color: #8b93a7; }
      .sel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
             color: #7c9cff; word-break: break-all; }
      textarea { width: 100%; min-height: 54px; margin-top: 7px; padding: 6px 7px; resize: vertical;
                 background: #0e1015; color: #e8eaf0; border: 1px solid #333a49;
                 border-radius: 6px; font-size: 12px; line-height: 1.45; outline: none; }
      textarea:focus { border-color: #7c9cff; }
      .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 7px; }
      button { font: inherit; font-size: 11px; font-weight: 600; padding: 5px 10px;
               border-radius: 6px; border: 1px solid #333a49; background: #1c2029;
               color: #e8eaf0; cursor: pointer; }
      button:hover { background: #252a35; }
      button.primary { background: #4f6bff; border-color: #4f6bff; color: #fff; }
      button.primary:hover { background: #6079ff; }
      button:disabled { opacity: .45; cursor: default; }
      .list { max-height: 208px; overflow-y: auto; }
      .item { display: flex; gap: 8px; padding: 7px 11px; border-bottom: 1px solid #22262f; }
      .item:last-child { border-bottom: 0; }
      .n { color: #6b7386; font-variant-numeric: tabular-nums; }
      .body { flex: 1; min-width: 0; }
      .body .t { color: #7c9cff; font-family: ui-monospace, Menlo, monospace; font-size: 10.5px;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .body .c { margin-top: 1px; line-height: 1.4; }
      .ft { padding: 9px 11px; }
      .ft button { width: 100%; padding: 7px; font-size: 12px; }
      .hint { padding: 8px 11px; color: #8b93a7; line-height: 1.5; }
      kbd { background: #22262f; border: 1px solid #333a49; border-bottom-width: 2px;
            border-radius: 4px; padding: 0 4px; font-family: inherit; font-size: 10px; }
      .badge { position: fixed; right: 16px; bottom: 16px; z-index: 2147483645;
               background: #14161c; color: #8b93a7; border: 1px solid #2b303c;
               border-radius: 20px; padding: 5px 11px; font-size: 11px; cursor: pointer;
               box-shadow: 0 4px 14px rgba(0,0,0,.35); display: none; }
      .badge.show { display: block; }
      .badge:hover { color: #e8eaf0; border-color: #4f6bff; }
      .badge b { color: #4f6bff; }
      .toast { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
               background: #16351f; color: #86efac; border: 1px solid #2f6b41;
               border-radius: 8px; padding: 9px 13px; font-size: 12px; display: none; }
      .toast.err { background: #3a1a1a; color: #fca5a5; border-color: #7a3030; }
      .toast.show { display: block; }
    </style>
    <div class="layer"><div class="box"></div><div class="tag"></div></div>
    <div class="badge"></div>
    <div class="toast"></div>
    <div class="dock">
      <div class="hd"><span class="dot"></span><b>UI Grab</b><span class="grow"></span>
        <span class="muted count"></span><span class="x" data-act="close">×</span></div>
      <div class="compose" style="display:none">
        <div class="sec"><div class="sel"></div>
          <textarea placeholder="What should change?"></textarea>
          <div class="row"><button data-act="cancel">Cancel</button>
            <button class="primary" data-act="add">Add</button></div></div>
      </div>
      <div class="hint idle"></div>
      <div class="list"></div>
      <div class="ft" style="display:none"><button class="primary" data-act="send"></button></div>
    </div>`;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const el = {
    box: $('.box'), tag: $('.tag'), dock: $('.dock'), dot: $('.dot'), count: $('.count'),
    compose: $('.compose'), sel: $('.sel'), ta: $('textarea'), hint: $('.hint'),
    list: $('.list'), ft: $('.ft'), send: $('[data-act="send"]'), badge: $('.badge'),
    toast: $('.toast'),
  };

  /* --------------------------------- state --------------------------------- */

  const S = { picking: false, open: false, target: null, pending: null, pendingReact: null,
    items: [], busy: false, enriching: [] };

  const save = () => HOST.save(S.items);

  const HK = (() => {
    const p = CFG.hotkey.split('+').map((s) => s.trim().toLowerCase());
    return { alt: p.includes('alt'), shift: p.includes('shift'), meta: p.includes('meta') || p.includes('cmd'), ctrl: p.includes('ctrl'), key: p[p.length - 1] };
  })();

  let toastTimer;
  function toast(msg, isErr) {
    el.toast.textContent = msg;
    el.toast.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.toast.className = 'toast'), 2600);
  }

  /* -------------------------------- rendering ------------------------------- */

  function highlight(target) {
    if (!target) { el.box.style.display = el.tag.style.display = 'none'; return; }
    const r = target.getBoundingClientRect();
    Object.assign(el.box.style, {
      display: 'block', left: r.x + 'px', top: r.y + 'px',
      width: r.width + 'px', height: r.height + 'px',
    });
    el.tag.textContent = `${label(target)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
    el.tag.style.display = 'block';
    const th = el.tag.getBoundingClientRect().height || 17;
    const above = r.y - th - 3 >= 0;
    el.tag.style.left = Math.max(2, Math.min(r.x, innerWidth - el.tag.offsetWidth - 4)) + 'px';
    el.tag.style.top = (above ? r.y - th - 3 : Math.min(r.bottom + 3, innerHeight - th - 2)) + 'px';
  }

  function render() {
    el.dock.classList.toggle('open', S.open);
    el.badge.classList.toggle('show', !S.open && S.items.length > 0);
    el.badge.innerHTML = `UI Grab <b>${S.items.length}</b> queued`;
    el.dot.classList.toggle('on', S.picking);
    el.count.textContent = S.items.length ? `${S.items.length} queued` : '';

    const composing = !!S.pending;
    el.compose.style.display = composing ? 'block' : 'none';
    el.hint.style.display = composing ? 'none' : 'block';
    el.hint.innerHTML = S.picking
      ? 'Hover an element and click it. <kbd>Esc</kbd> to stop.'
      : `Picking off. <kbd>${CFG.hotkey}</kbd> to resume.`;

    el.list.innerHTML = S.items
      .map((it, i) => `<div class="item"><span class="n">${i + 1}</span><div class="body">
          <div class="t">${esc(label2(it))}</div><div class="c">${esc(it.comment)}</div></div>
          <span class="x" data-rm="${i}">×</span></div>`)
      .join('');

    el.ft.style.display = S.items.length ? 'block' : 'none';
    el.send.disabled = S.busy;
    el.send.textContent = S.busy
      ? 'Sending…'
      : `Send ${S.items.length} to Claude Code`;
  }

  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ENT[c]);
  const label2 = (it) => it.tag + (it.elementId ? '#' + it.elementId : '') +
    (it.classes ? '.' + it.classes.trim().split(/\s+/).slice(0, 2).join('.') : '');

  /* --------------------------------- actions -------------------------------- */

  function setPicking(on) {
    S.picking = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    if (!on) { S.target = null; highlight(null); }
    render();
  }

  function open(on = true) {
    S.open = on;
    if (!on) { setPicking(false); S.pending = null; S.pendingReact = null; }
    render();
  }

  function toggle() {
    if (S.open && S.picking) { open(false); } else { open(true); setPicking(true); }
  }

  // react-grab, when the host has loaded it, knows the exact component and
  // source line behind an element — ground truth instead of the server's grep
  // guess. It is async and optional, so it rides alongside the snapshot rather
  // than blocking the pick.
  //
  // Its module and this one are separate script tags with no ordering
  // guarantee worth relying on, so wait for it rather than assume it is there.
  async function reactGrab() {
    const deadline = Date.now() + 3000;
    for (;;) {
      if (window.__UI_GRAB_RG__) return window.__UI_GRAB_RG__;
      if (window.__UI_GRAB_RG_READY__) return await window.__UI_GRAB_RG_READY__;
      // Only the hosts that actually installed react-grab are worth waiting for.
      if (!CFG.react || Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function reactContext(el) {
    try {
      const rg = await reactGrab();
      if (!rg || typeof rg.getElementContext !== 'function') return null;
      const c = await rg.getElementContext(el);
      if (!c || !c.filePath) return null;
      return {
        componentName: c.componentName || null,
        file: c.filePath,
        line: c.lineNumber || null,
        column: c.columnNumber || null,
        // The stack is how you tell "the div in Button" from "the Button in
        // Home" — the styling often lives a frame or two up.
        stack: (c.stack || []).slice(0, 6).map((f) => ({
          component: f.functionName || null,
          file: f.fileName || null,
          line: f.lineNumber ?? null,
        })).filter((f) => f.file || f.component),
      };
    } catch {
      return null;
    }
  }

  function pick(target) {
    if (!target) return;
    S.pending = describe(target);
    S.pendingReact = reactContext(target);
    S.target = target;
    setPicking(false);
    highlight(target);
    el.sel.textContent = S.pending.selector;
    el.ta.value = '';
    render();
    el.ta.focus();
  }

  async function add() {
    if (!S.pending) return;
    const c = el.ta.value.trim();
    if (!c) { el.ta.focus(); return; }
    const item = { ...S.pending, comment: c };
    const rect = item.rect;
    const target = S.target;
    S.items.push(item);

    // The item is queued now, not when react-grab answers — a Send that lands
    // in between must not miss it. The context is attached in place, and send()
    // waits for anything still outstanding.
    if (S.pendingReact) {
      S.enriching.push(
        S.pendingReact
          .then((react) => { if (react) { item.react = react; save(); } })
          .catch(() => {}),
      );
    }
    S.pending = null;
    S.pendingReact = null;
    save();
    setPicking(true);
    render();

    // Screenshot last: it needs the overlay gone, and it must never block the
    // queue if the host can't take one.
    if (HOST.shot) {
      host.style.display = 'none'; // our own dock must not end up in the crop
      try {
        const dataUrl = await HOST.shot(rect, target);
        if (dataUrl) { item.screenshot = dataUrl; save(); }
      } catch (e) {
        console.warn('[ui-grab] screenshot failed:', e.message);
      }
      host.style.display = '';
      if (S.picking && S.target) highlight(S.target);
    }
  }

  function cancel() {
    S.pending = null;
    S.pendingReact = null;
    highlight(null);
    setPicking(true);
    render();
  }

  function remove(i) {
    S.items.splice(i, 1);
    save();
    render();
  }

  async function send() {
    if (!S.items.length || S.busy) return { ok: false };
    S.busy = true; render();
    try {
      if (S.enriching.length) {
        await Promise.all(S.enriching.splice(0));
      }
      const body = await HOST.send(S.items);
      if (!body || !body.ok) throw new Error((body && body.error) || 'send failed');
      const n = S.items.length;
      S.items = []; save();
      open(false);
      toast(`Sent ${n} change${n === 1 ? '' : 's'}${body.target ? ' → ' + body.target : ''} — run /grab`);
      return { ok: true, ...body };
    } catch (e) {
      toast(`Send failed: ${e.message}`, true);
      return { ok: false, error: e.message };
    } finally {
      S.busy = false; render();
    }
  }

  /* -------------------------------- listeners ------------------------------- */

  const mine = (t) => t === host || host.contains(t);

  // highlight() measures the element, which forces a layout — so it runs at
  // most once a frame rather than once per mousemove event.
  let hoverRaf = 0;
  addEventListener('mousemove', (e) => {
    if (!S.picking) return;
    const t = e.target;
    if (!t || mine(t) || t.nodeType !== 1 || t === S.target) return;
    S.target = t;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; highlight(S.target); });
  }, true);

  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) {
    addEventListener(type, (e) => {
      if (S.picking && !mine(e.target)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  addEventListener('click', (e) => {
    if (!S.picking || mine(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    pick(e.target);
  }, true);

  addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if (k === HK.key && e.altKey === HK.alt && e.shiftKey === HK.shift &&
        e.metaKey === HK.meta && e.ctrlKey === HK.ctrl) {
      e.preventDefault(); toggle(); return;
    }
    if (k === 'escape' && S.open) {
      if (S.pending) cancel();
      else if (S.picking) setPicking(false);
      else open(false);
      e.preventDefault();
    }
  }, true);

  el.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
    e.stopPropagation();
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    const rm = t.getAttribute && t.getAttribute('data-rm');
    if (rm !== null && rm !== undefined) return remove(Number(rm));
    const act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'close') open(false);
    if (act === 'add') add();
    if (act === 'cancel') cancel();
    if (act === 'send') send();
  });

  el.badge.addEventListener('click', () => open(true));

  let raf = 0;
  const reflow = () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => highlight(S.pending || S.picking ? S.target : null));
  };
  addEventListener('scroll', reflow, true);
  addEventListener('resize', reflow);

  /* ---------------------------------- API ---------------------------------- */

  window.__uiGrab = {
    toggle, open, setPicking, pick, add, cancel, remove, send,
    comment: (t) => { el.ta.value = t; },
    items: () => S.items.slice(),
    state: () => ({ picking: S.picking, open: S.open, pending: !!S.pending, count: S.items.length }),
    version: CFG.version || 'dev',
  };

  // The stored batch arrives a microtask (or a round trip) after the picker is
  // ready, and window.__uiGrab is callable the moment this file runs — so an
  // item added in between has to survive the load rather than be assigned over.
  Promise.resolve(HOST.load()).then((stored) => {
    const queued = new Set(S.items.map((i) => i.id));
    S.items = (Array.isArray(stored) ? stored : [])
      .filter((i) => !queued.has(i.id))
      .concat(S.items);
    render();
  });

  render();
  console.info(`[ui-grab] ready — press ${CFG.hotkey} to pick elements`);
})();
