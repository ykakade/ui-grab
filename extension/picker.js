// ui-grab picker — overlay, dock, element capture.
//
// Host-agnostic: everything that touches the outside world goes through
// window.__UI_GRAB_HOST__, which the chrome extension and the dev-server plugin
// each provide in their own way. This file is identical in both, so the picker
// can never drift between them.
//
//   HOST = {
//     cfg:    { hotkey, badge, shots, verify },
//     send:   (items)   => Promise<{ ok, added?, pending?, batch?, error? }>,
//     verify: (results) => Promise<{ ok }>,          // optional
//     revert: (batch)   => Promise<{ ok, files }>,   // optional
//     shot:   (rect)    => Promise<string|null>,     // optional, data: url
//     events: (onEvent) => () => void,               // optional, returns close
//     load:   ()        => Promise<item[]>,
//     save:   (items)   => void,
//     loadState / saveState: (key[, value]) => any,  // optional
//   }
(() => {
  if (window.__uiGrab) return;

  const HOST = window.__UI_GRAB_HOST__;
  if (!HOST) { console.error('[ui-grab] no transport installed'); return; }
  const CFG = Object.assign({ hotkey: 'Alt+Shift+G', badge: true, shots: false, verify: true },
    HOST.cfg || {});

  const STYLE_KEYS = [
    'display', 'position', 'font-size', 'font-weight', 'line-height', 'letter-spacing',
    'color', 'background-color', 'padding', 'margin', 'border', 'border-radius',
    'box-shadow', 'width', 'height', 'gap', 'flex-direction', 'align-items',
    'justify-content', 'text-align', 'opacity', 'overflow',
  ];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)', 'static', '1', 'visible', '']);
  const ATTRS = ['data-testid', 'data-test-id', 'aria-label', 'role', 'name', 'type',
    'placeholder', 'alt', 'href', 'title'];

  const SPEECH = window.SpeechRecognition || window.webkitSpeechRecognition;
  const VERIFY_EVERY = 1500;
  const VERIFY_WINDOW = 180_000;   // give up watching an element after 3 minutes
  const MAX_ASKED = 12;            // answered questions kept on screen
  const STATUS_WINDOW = 180_000;   // stop listening for a batch's fate after 3 minutes
  const STATUS_LINGER = 6000;      // how long "Applied 3 items" stays up afterwards

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

  const route = () => location.pathname + location.search + location.hash;

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
      route: route(),
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

  // The extra elements of a multi-element pick carry only what the source
  // lookup needs. The comment is about the group; the parent layout and the
  // computed style of the first one already say what kind of thing it is.
  const describeExtra = (el) => {
    const d = describe(el);
    return {
      tag: d.tag, elementId: d.elementId, classes: d.classes, selector: d.selector,
      text: d.text, attrs: d.attrs, route: d.route, rect: d.rect,
    };
  };

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
      .extra { position: fixed; border: 2px dashed #7c9cff; border-radius: 3px;
               background: rgba(124,156,255,.07); }
      .tag { position: fixed; display: none; padding: 2px 6px; border-radius: 4px;
             background: #7c9cff; color: #0b1020; font-size: 11px; font-weight: 600;
             white-space: nowrap; font-variant-numeric: tabular-nums; }
      .dock { position: fixed; right: 16px; bottom: 16px; width: 330px; z-index: 2147483647;
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
      .tog { cursor: pointer; border: 1px solid #333a49; border-radius: 5px; padding: 1px 5px;
             font-size: 10px; color: #8b93a7; }
      .tog.on { color: #cbd3e6; border-color: #4f6bff; background: #1b2233; }
      .sec { padding: 9px 11px; border-bottom: 1px solid #2b303c; }
      .muted { color: #8b93a7; }
      .sel { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
             color: #7c9cff; word-break: break-all; }
      .ta-wrap { position: relative; }
      textarea { width: 100%; min-height: 54px; margin-top: 7px; padding: 6px 26px 6px 7px; resize: vertical;
                 background: #0e1015; color: #e8eaf0; border: 1px solid #333a49;
                 border-radius: 6px; font-size: 12px; line-height: 1.45; outline: none; }
      textarea:focus { border-color: #7c9cff; }
      .mic { position: absolute; right: 6px; top: 13px; cursor: pointer; opacity: .5;
             font-size: 12px; line-height: 1; user-select: none; }
      .mic:hover { opacity: .9; }
      .mic.on { opacity: 1; color: #fca5a5; }
      .row { display: flex; gap: 6px; justify-content: flex-end; margin-top: 7px; align-items: center; }
      .row .grow { text-align: left; font-size: 10.5px; color: #6b7386; }
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
      .body .c { margin-top: 1px; line-height: 1.4; cursor: text; }
      .acts { display: flex; gap: 2px; align-items: flex-start; }
      .acts span { cursor: pointer; opacity: .45; padding: 0 2px; font-size: 11px; line-height: 1.3; }
      .acts span:hover { opacity: 1; }
      .ft { padding: 9px 11px; }
      .ft button { width: 100%; padding: 7px; font-size: 12px; }
      .hint { padding: 8px 11px; color: #8b93a7; line-height: 1.5; }
      .status { display: none; align-items: center; gap: 7px; padding: 7px 11px;
                border-bottom: 1px solid #2b303c; color: #8b93a7; font-size: 11px; }
      .status.show { display: flex; }
      .pip { width: 6px; height: 6px; border-radius: 50%; background: #6b7386; flex: none; }
      .pip.work { background: #7c9cff; animation: pulse 1.1s ease-in-out infinite; }
      .pip.good { background: #4ade80; }
      .pip.warn { background: #f0b849; }
      @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: .3 } }
      .status .txt { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
                     white-space: nowrap; }
      .asked { max-height: 190px; overflow-y: auto; }
      .qa { padding: 8px 11px; border-bottom: 1px solid #2b303c; }
      .qa .q { display: flex; gap: 6px; align-items: flex-start; }
      .qa .q .mark { color: #c4b5fd; font-weight: 700; line-height: 1.4; }
      .qa .q .txt { flex: 1; line-height: 1.4; }
      .qa .el { color: #7c9cff; font-family: ui-monospace, Menlo, monospace; font-size: 10px;
                margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .qa .a { margin-top: 5px; padding: 6px 8px; background: #0e1015; border-radius: 6px;
               border: 1px solid #2b303c; line-height: 1.5; white-space: pre-wrap;
               word-break: break-word; color: #cbd3e6; }
      .qa .waiting { margin-top: 4px; color: #6b7386; font-style: italic; }
      .verify { padding: 8px 11px; border-top: 1px solid #2b303c; display: none;
                align-items: center; gap: 8px; }
      .verify.show { display: flex; }
      .verify .grow { color: #8b93a7; }
      .verify b { color: #86efac; }
      .verify b.miss { color: #fca5a5; }
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
    <div class="layer"><div class="box"></div><div class="tag"></div><div class="extras"></div></div>
    <div class="badge"></div>
    <div class="toast"></div>
    <div class="dock">
      <div class="hd"><span class="dot"></span><b>UI Grab</b><span class="grow"></span>
        <span class="tog ask" data-act="ask" title="ask about this element instead of changing it">ask</span>
        <span class="tog shot" data-act="shots" title="attach a crop of each element">shot</span>
        <span class="muted count"></span><span class="x" data-act="close">×</span></div>
      <div class="compose" style="display:none">
        <div class="sec"><div class="sel"></div>
          <div class="ta-wrap">
            <textarea placeholder="What should change?"></textarea>
            <span class="mic" data-act="mic" title="dictate">●</span>
          </div>
          <div class="row"><span class="grow nav"></span>
            <button data-act="cancel">Cancel</button>
            <button class="primary" data-act="add">Add</button></div></div>
      </div>
      <div class="hint idle"></div>
      <div class="status"><span class="pip"></span><span class="txt"></span>
        <span class="x" data-act="dismiss-status">×</span></div>
      <div class="asked"></div>
      <div class="list"></div>
      <div class="verify"><span class="grow vtext"></span>
        <button data-act="revert">Revert</button></div>
      <div class="ft" style="display:none"><button class="primary" data-act="send"></button></div>
    </div>`;
  (document.body || document.documentElement).appendChild(host);

  const $ = (s) => root.querySelector(s);
  const el = {
    box: $('.box'), tag: $('.tag'), extras: $('.extras'), dock: $('.dock'), dot: $('.dot'),
    count: $('.count'), compose: $('.compose'), sel: $('.sel'), ta: $('textarea'),
    hint: $('.hint'), list: $('.list'), ft: $('.ft'), send: $('[data-act="send"]'),
    badge: $('.badge'), toast: $('.toast'), mic: $('.mic'), nav: $('.nav'),
    shot: $('.shot'), verify: $('.verify'), vtext: $('.vtext'),
    ask: $('.ask'), status: $('.status'), pip: $('.pip'), stext: $('.status .txt'),
    asked: $('.asked'),
  };

  /* --------------------------------- state --------------------------------- */

  const S = {
    picking: false, open: false, target: null, pending: null, pendingReact: null,
    extra: [], extraEls: [],          // the rest of a multi-element pick
    editing: null,                    // index of the queued item being reworded
    items: [], busy: false, enriching: [],
    shots: !!CFG.shots,
    ask: false,                       // is the next comment a question?
    watch: [], batch: null, verdict: null,
    asked: [], status: null,          // questions in flight, and what the agent is doing
    inflight: 0, settled: 0,          // when the last batch went out, and when it landed
  };

  const save = () => HOST.save(S.items);
  const putState = (k, v) => { try { HOST.saveState && HOST.saveState(k, v); } catch {} };
  const getState = (k) => { try { return Promise.resolve(HOST.loadState ? HOST.loadState(k) : null); }
    catch { return Promise.resolve(null); } };

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
    el.extras.innerHTML = S.extraEls
      .filter((n) => n && n.isConnected)
      .map((n) => {
        const r = n.getBoundingClientRect();
        return `<div class="extra" style="left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px"></div>`;
      }).join('');

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
    // The dock closes on Send, which is exactly when there is something to
    // report — so the badge carries the status until the batch is done with.
    const badgeStatus = !S.items.length && S.status && watching();
    el.badge.classList.toggle('show', !S.open && (S.items.length > 0 || !!badgeStatus));
    el.badge.innerHTML = badgeStatus
      ? `<b>●</b> ${esc(S.status.text)}`
      : `UI Grab <b>${S.items.length}</b> queued`;
    el.dot.classList.toggle('on', S.picking);
    el.count.textContent = S.items.length ? `${S.items.length} queued` : '';
    el.shot.style.display = HOST.shot ? '' : 'none';
    el.shot.classList.toggle('on', S.shots);
    el.ask.classList.toggle('on', S.ask);
    el.mic.style.display = SPEECH ? '' : 'none';

    const composing = !!S.pending || S.editing !== null;
    el.compose.style.display = composing ? 'block' : 'none';
    el.hint.style.display = composing ? 'none' : 'block';
    el.hint.innerHTML = S.picking
      ? 'Hover an element and click it. <kbd>Shift</kbd>-click adds more to one comment. <kbd>Esc</kbd> to stop.'
      : `Picking off. <kbd>${CFG.hotkey}</kbd> to resume.`;
    el.nav.innerHTML = S.editing !== null ? 'Editing'
      : S.ask ? 'Asking — nothing will be edited'
      : '<kbd>Alt</kbd>+arrows to walk the tree';
    el.ta.placeholder = S.ask ? 'What do you want to know?' : 'What should change?';
    root.querySelector('[data-act="add"]').textContent = S.editing !== null ? 'Save' : 'Add';

    el.list.innerHTML = S.items
      .map((it, i) => `<div class="item"><span class="n">${it.kind === 'ask' ? '?' : i + 1}</span><div class="body">
          <div class="t">${esc(label2(it))}${it.also?.length ? ` +${it.also.length}` : ''}</div>
          <div class="c" data-edit="${i}">${esc(it.comment)}</div></div>
          <span class="acts"><span data-mv="${i}:-1">↑</span><span data-mv="${i}:1">↓</span>
          <span data-edit="${i}">✎</span><span data-rm="${i}">×</span></span></div>`)
      .join('');

    el.status.classList.toggle('show', !!S.status);
    if (S.status) {
      el.pip.className = 'pip ' + (S.status.tone || '');
      el.stext.textContent = S.status.text;
    }

    el.asked.innerHTML = S.asked.map((q, i) => `<div class="qa">
        <div class="q"><span class="mark">?</span><span class="txt">${esc(q.comment)}</span>
          <span class="acts"><span data-dq="${i}">×</span></span></div>
        <div class="el">${esc(q.label)}</div>
        ${q.answer ? `<div class="a">${esc(q.answer)}</div>`
                   : '<div class="waiting">waiting for an answer…</div>'}
      </div>`).join('');

    const v = S.verdict;
    el.verify.classList.toggle('show', !!v);
    if (v) {
      el.vtext.innerHTML = v.pending
        ? `Watching ${v.total} element${v.total === 1 ? '' : 's'} for the edit…`
        : `<b>${v.changed} changed</b>` +
          (v.unchanged ? ` · <b class="miss">${v.unchanged} unchanged</b>` : '');
      root.querySelector('[data-act="revert"]').style.display = S.batch && HOST.revert ? '' : 'none';
    }

    el.ft.style.display = S.items.length ? 'block' : 'none';
    el.send.disabled = S.busy;
    el.send.textContent = S.busy ? 'Sending…' : `Send ${S.items.length} to Claude Code`;

    // Nothing to hear about once the dock is shut and nothing is outstanding.
    if (S.open || watching()) listen();
    else unlisten();
  }

  /**
   * Is a batch still out there? Verification is the obvious answer but not a
   * sufficient one: `verify: false`, a host with no verify at all, or a pick
   * whose selector no longer resolves all leave the watch list empty, and a
   * batch of plain changes closes the dock the moment it is sent. Without the
   * window below, that is a stream dropped before the first event arrives —
   * the exact case the status line exists for.
   */
  const watching = () =>
    S.watch.length ||
    S.asked.some((q) => !q.answer) ||
    (S.inflight && Date.now() - S.inflight < STATUS_WINDOW) ||
    // "Applied 3 items" is the line worth waiting for; hiding it the instant it
    // arrives means the only one you never get to read.
    (S.settled && Date.now() - S.settled < STATUS_LINGER);

  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

  /** "2 changes and 1 question", for a batch that can be either or both. */
  const describeBatch = (edits, asks) =>
    [edits ? plural(edits, 'change') : '', asks ? plural(asks, 'question') : '']
      .filter(Boolean).join(' and ');

  const ENT = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ENT[c]);
  const label2 = (it) => it.tag + (it.elementId ? '#' + it.elementId : '') +
    (it.classes ? '.' + it.classes.trim().split(/\s+/).slice(0, 2).join('.') : '');

  /* --------------------------------- actions -------------------------------- */

  function setPicking(on) {
    S.picking = on;
    document.documentElement.style.cursor = on ? 'crosshair' : '';
    // A pick that is being commented on keeps its target: it is what the arrow
    // keys walk from, and what a screenshot is cropped to.
    if (!on && !S.pending) { S.target = null; highlight(null); }
    render();
  }

  function open(on = true) {
    S.open = on;
    if (!on) { setPicking(false); clearPending(); }
    render();
  }

  function toggle() {
    if (S.open && S.picking) { open(false); } else { open(true); setPicking(true); }
  }

  function clearPending() {
    S.pending = null;
    S.pendingReact = null;
    S.extra = [];
    S.extraEls = [];
    S.editing = null;
  }

  // react-grab, when the host has loaded it, knows the exact component and
  // source line behind an element — ground truth instead of the server's grep
  // guess. It is async and optional, so it rides alongside the snapshot rather
  // than blocking the pick.
  async function reactGrab() {
    const deadline = Date.now() + 3000;
    for (;;) {
      if (window.__UI_GRAB_RG__) return window.__UI_GRAB_RG__;
      if (window.__UI_GRAB_RG_READY__) return await window.__UI_GRAB_RG_READY__;
      if (!CFG.react || Date.now() > deadline) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async function reactContext(node) {
    try {
      const rg = await reactGrab();
      if (!rg || typeof rg.getElementContext !== 'function') return null;
      const c = await rg.getElementContext(node);
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

  /** Start a new comment about `target`. */
  function pick(target, { keepText = false } = {}) {
    if (!target) return;
    const text = keepText ? el.ta.value : '';
    S.editing = null;
    S.pending = describe(target);
    S.pendingReact = reactContext(target);
    setPicking(false);
    S.target = target;
    highlight(target);
    showSelector();
    el.ta.value = text;
    render();
    el.ta.focus();
  }

  /** Add another element to the comment being written. */
  function pickAlso(target) {
    if (!target || !S.pending) return pick(target);
    if (target === S.target || S.extraEls.includes(target)) return;
    S.extra.push(describeExtra(target));
    S.extraEls.push(target);
    highlight(S.target);
    showSelector();
    el.ta.focus();
  }

  function showSelector() {
    el.sel.textContent = S.pending
      ? S.pending.selector + (S.extra.length ? `  +${S.extra.length} more` : '')
      : '';
  }

  // Half of "make this bigger" turns out to be about the parent, and a parent
  // is often impossible to hover: its children cover it. Walking the tree from
  // the keyboard is the only way to reach one.
  function navigate(dir) {
    if (!S.target) return;
    const next = dir === 'up' ? S.target.parentElement
      : dir === 'down' ? S.target.firstElementChild
      : dir === 'left' ? S.target.previousElementSibling
      : S.target.nextElementSibling;
    if (!next || next === document.documentElement || host.contains(next)) return;
    pick(next, { keepText: true });
  }

  async function add() {
    if (S.editing !== null) {
      const text = el.ta.value.trim();
      if (!text) { el.ta.focus(); return; }
      S.items[S.editing].comment = text;
      clearPending();
      save();
      render();
      return;
    }
    if (!S.pending) return;
    const c = el.ta.value.trim();
    if (!c) { el.ta.focus(); return; }

    const item = { ...S.pending, comment: c };
    if (S.ask) item.kind = 'ask';
    if (S.extra.length) item.also = S.extra.slice();
    const rect = item.rect;
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
    clearPending();
    save();
    setPicking(true);
    render();

    // Screenshot last: it needs the overlay gone, and it must never block the
    // queue if the host can't take one.
    if (HOST.shot && S.shots) {
      host.style.display = 'none'; // our own dock must not end up in the crop
      try {
        const dataUrl = await HOST.shot(rect);
        if (dataUrl) { item.screenshot = dataUrl; save(); }
      } catch (e) {
        console.warn('[ui-grab] screenshot failed:', e.message);
        toast('Screenshot failed — the pick is still queued', true);
      }
      host.style.display = '';
      if (S.picking && S.target) highlight(S.target);
    }
  }

  function cancel() {
    clearPending();
    highlight(null);
    setPicking(true);
    render();
  }

  function remove(i) {
    S.items.splice(i, 1);
    if (S.editing === i) clearPending();
    save();
    render();
  }

  function edit(i, text) {
    const item = S.items[i];
    if (!item) return;
    if (typeof text === 'string') {           // programmatic
      item.comment = text; save(); render(); return;
    }
    clearPending();
    S.editing = i;
    setPicking(false);
    el.sel.textContent = label2(item);
    el.ta.value = item.comment;
    render();
    el.ta.focus();
  }

  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= S.items.length) return;
    [S.items[i], S.items[j]] = [S.items[j], S.items[i]];
    save();
    render();
  }

  function setShots(on) {
    S.shots = !!on;
    putState('shots', S.shots);
    render();
  }

  // A question rather than an instruction. Sticky, because you are usually
  // asking about two or three things at once, and per-item because a batch of
  // "make this bigger" and "why is this 4px off" is a normal thing to send.
  function setAsk(on) {
    S.ask = !!on;
    putState('ask', S.ask);
    render();
    if (S.pending) el.ta.focus();
  }

  /* --------------------------------- status --------------------------------- */
  //
  // Between Send and the edit, everything interesting happens outside the
  // browser: a session is found or it is not, it starts working or it was
  // already busy, something reads the queue or nothing ever does. The server
  // knows all of that; this is the half that shows it.

  // How each event reads in one line. `null` means it is not worth a row.
  const STATUS = {
    queued: (e) => ({ tone: 'work', text: e.n && e.asks === e.n
      ? `Asked ${plural(e.n, 'question')} — waiting for an answer`
      : `Queued ${e.n} — waiting for Claude Code` }),
    woke: (e) => (e.woke
      ? { tone: 'work', text: `Woke Claude Code via ${e.via}` }
      : e.via === 'busy'
        ? { tone: 'work', text: 'Claude Code is mid-turn — it will pick this up' }
        : { tone: 'warn', text: e.via === 'none'
            ? 'No Claude Code session open in this project — run /grab'
            : `Could not wake anything (${e.via}) — run /grab` }),
    session: (e) => (e.status === 'busy'
      ? { tone: 'work', text: 'Claude Code is working…' }
      // Absence is only news when a batch is waiting on it, and `woke` has
      // already said so by then.
      : e.status === 'none' ? null
      : { tone: '', text: 'Claude Code is idle' }),
    holding: () => ({ tone: 'work', text: 'Holding the turn open — keep clicking' }),
    draining: (e) => ({ tone: 'work', text: `Reading ${plural(e.pending, 'item')}…` }),
    applied: (e) => ({ tone: 'good', text: `Applied ${plural(e.n, 'item')}` }),
    answer: () => null,              // the answer itself is the status
  };

  function onEvent(e) {
    if (e.kind === 'answer') {
      const q = S.asked.find((x) => x.id === e.id);
      if (q) { q.answer = e.text; putState('asked', S.asked); render(); }
      return;
    }
    // The batch has landed; nothing further is coming for it.
    if (e.kind === 'applied') {
      S.inflight = 0;
      S.settled = Date.now();
      setTimeout(() => { S.settled = 0; render(); }, STATUS_LINGER + 50);
    }
    const line = STATUS[e.kind] && STATUS[e.kind](e);
    if (!line) return;
    S.status = line;
    render();
  }

  let closeEvents = null;

  function listen() {
    if (closeEvents || !HOST.events) return;
    try { closeEvents = HOST.events(onEvent); } catch { closeEvents = null; }
  }

  // Worth having as an API and not only an internal: this holds a connection
  // open for as long as the dock is, and a script driving the picker wants a
  // way to put it down when it is finished.
  function unlisten() {
    if (!closeEvents) return;
    const close = closeEvents;
    closeEvents = null;
    try { close(); } catch {}
  }

  /* -------------------------------- dictation ------------------------------- */

  let rec = null;

  function dictate() {
    if (!SPEECH) return;
    if (rec) { rec.stop(); return; }
    rec = new SPEECH();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = document.documentElement.lang || 'en-US';
    rec.onresult = (e) => {
      let said = '';
      for (let i = e.resultIndex; i < e.results.length; i++) said += e.results[i][0].transcript;
      said = said.trim();
      if (!said) return;
      el.ta.value = (el.ta.value ? el.ta.value.replace(/\s*$/, ' ') : '') + said;
    };
    rec.onerror = (e) => { toast(`Dictation: ${e.error}`, true); stopDictating(); };
    rec.onend = stopDictating;
    try { rec.start(); el.mic.classList.add('on'); } catch { stopDictating(); }
  }

  function stopDictating() {
    rec = null;
    el.mic.classList.remove('on');
  }

  /* ------------------------------ verification ------------------------------ */
  //
  // What the picked elements looked like when they were sent. When the agent
  // finishes, they are measured again: one that changed says the pointer we
  // shipped was right, one that did not says the edit landed elsewhere. It runs
  // in the browser on data already captured, so it costs the agent nothing.

  const sig = (node) => {
    const r = node.getBoundingClientRect();
    return JSON.stringify(styles(node)) + `|${Math.round(r.width)}x${Math.round(r.height)}`;
  };

  let watchTimer = 0;

  function watchAfterSend(items, batch) {
    if (!CFG.verify || !HOST.verify) return;
    S.batch = batch || null;
    // A question is answered, not applied, so nothing about the element should
    // move. Watching one would report "unchanged", and an element that did not
    // change is how the map decides it had pointed at the wrong place.
    S.watch = items.filter((it) => it.kind !== 'ask').map((it) => {
      const node = it.selector && document.querySelector(it.selector);
      return {
        id: it.id, selector: it.selector, route: it.route,
        before: node ? sig(node) : null, at: Date.now(), changed: false,
      };
    }).filter((w) => w.before !== null);
    putState('watch', S.watch);
    putState('batch', S.batch);
    S.verdict = S.watch.length ? { total: S.watch.length, changed: 0, unchanged: 0, pending: true } : null;
    startWatching();
    render();
  }

  function startWatching() {
    clearInterval(watchTimer);
    if (!S.watch.length) return;
    watchTimer = setInterval(tick, VERIFY_EVERY);
  }

  function tick() {
    if (!S.watch.length) { clearInterval(watchTimer); return; }
    const done = [];
    const now = Date.now();

    for (const w of S.watch) {
      if (w.changed) continue;
      if (w.route && w.route !== route()) continue;   // not on that page right now
      const node = document.querySelector(w.selector);
      // A node that has gone away is a change too: something replaced it.
      if (!node || sig(node) !== w.before) { w.changed = true; done.push(w); continue; }
      if (now - w.at > VERIFY_WINDOW) done.push(w);
    }
    if (!done.length) return;

    const results = done.map((w) => ({ id: w.id, changed: !!w.changed }));
    S.watch = S.watch.filter((w) => !done.includes(w));
    putState('watch', S.watch);

    S.verdict = S.verdict || { total: results.length, changed: 0, unchanged: 0 };
    S.verdict.changed += results.filter((r) => r.changed).length;
    S.verdict.unchanged += results.filter((r) => !r.changed).length;
    S.verdict.pending = S.watch.length > 0;
    render();

    Promise.resolve(HOST.verify(results)).catch(() => {});
    if (!S.watch.length) clearInterval(watchTimer);
  }

  async function revert() {
    if (!HOST.revert || !S.batch) return;
    const r = await Promise.resolve(HOST.revert(S.batch)).catch((e) => ({ ok: false, error: e.message }));
    if (r && r.ok) {
      toast(`Reverted ${r.files.length} file${r.files.length === 1 ? '' : 's'}`);
      S.batch = null; S.verdict = null; putState('batch', null);
      render();
    } else {
      toast(`Revert failed: ${(r && r.error) || 'unknown'}`, true);
    }
  }

  /* ---------------------------------- send ---------------------------------- */

  async function send() {
    if (!S.items.length || S.busy) return { ok: false };
    S.busy = true; render();
    const sent = S.items.slice();
    try {
      if (S.enriching.length) {
        await Promise.all(S.enriching.splice(0));
      }
      const body = await HOST.send(S.items);
      if (!body || !body.ok) throw new Error((body && body.error) || 'send failed');
      const n = S.items.length;
      S.items = []; save();
      S.inflight = Date.now();
      S.settled = 0;

      // Questions outlive the batch: the whole point of one is to still be on
      // screen when the answer lands, beside the element it was asked about.
      const asks = sent.filter((it) => it.kind === 'ask');
      if (asks.length) {
        S.asked = asks
          .map((it) => ({ id: it.id, comment: it.comment, label: label2(it), answer: null }))
          .concat(S.asked)
          .slice(0, MAX_ASKED);
        putState('asked', S.asked);
      }

      open(asks.length > 0);   // an answer is coming back here, so stay open for it
      watchAfterSend(sent, body.batch);
      toast(`Sent ${describeBatch(n - asks.length, asks.length)}` +
        `${body.target ? ' → ' + body.target : ''}${asks.length ? '' : ' — run /grab'}`);
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
    if (e.shiftKey && S.pending) pickAlso(e.target);
    else pick(e.target);
  }, true);

  const ARROWS = { arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right' };

  addEventListener('keydown', (e) => {
    const k = (e.key || '').toLowerCase();
    if (k === HK.key && e.altKey === HK.alt && e.shiftKey === HK.shift &&
        e.metaKey === HK.meta && e.ctrlKey === HK.ctrl) {
      e.preventDefault(); toggle(); return;
    }
    if (S.pending && e.altKey && ARROWS[k]) {
      e.preventDefault(); e.stopPropagation();
      navigate(ARROWS[k]);
      return;
    }
    if (k === 'escape' && S.open) {
      if (S.pending || S.editing !== null) cancel();
      else if (S.picking) setPicking(false);
      else open(false);
      e.preventDefault();
    }
  }, true);

  el.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
    if (e.altKey && ARROWS[(e.key || '').toLowerCase()]) return; // handled above
    e.stopPropagation();
  });

  root.addEventListener('click', (e) => {
    const t = e.target;
    const attr = (n) => (t.getAttribute ? t.getAttribute(n) : null);
    const rm = attr('data-rm');
    if (rm !== null) return remove(Number(rm));
    const ed = attr('data-edit');
    if (ed !== null) return edit(Number(ed));
    const mv = attr('data-mv');
    if (mv !== null) { const [i, d] = mv.split(':').map(Number); return move(i, d); }
    const dq = attr('data-dq');
    if (dq !== null) {
      S.asked.splice(Number(dq), 1);
      putState('asked', S.asked);
      return render();
    }
    switch (attr('data-act')) {
      case 'close': return open(false);
      case 'ask': return setAsk(!S.ask);
      case 'dismiss-status': S.status = null; return render();
      case 'add': return add();
      case 'cancel': return cancel();
      case 'send': return send();
      case 'mic': return dictate();
      case 'shots': return setShots(!S.shots);
      case 'revert': return revert();
    }
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
    toggle, open, setPicking, pick, pickAlso, add, cancel, remove, edit, move, send,
    navigate, setShots, setAsk, revert, listen, unlisten,
    comment: (t) => { el.ta.value = t; },
    items: () => S.items.slice(),
    watching: () => S.watch.slice(),
    asked: () => S.asked.slice(),
    status: () => (S.status ? { ...S.status } : null),
    state: () => ({
      picking: S.picking, open: S.open, pending: !!S.pending, editing: S.editing,
      count: S.items.length, extra: S.extra.length, shots: S.shots, ask: S.ask,
      batch: S.batch, asked: S.asked.length, inflight: !!S.inflight,
    }),
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

  // A reload in the middle of an edit landing must not lose the watch: that is
  // exactly when the page is most likely to reload.
  if (CFG.verify && HOST.verify) {
    getState('watch').then((w) => {
      if (!Array.isArray(w) || !w.length) return;
      S.watch = w.filter((x) => Date.now() - x.at < VERIFY_WINDOW);
      if (!S.watch.length) return;
      S.verdict = { total: S.watch.length, changed: 0, unchanged: 0, pending: true };
      startWatching();
      render();
    });
    getState('batch').then((b) => { if (b) { S.batch = b; render(); } });
  }
  getState('shots').then((v) => { if (typeof v === 'boolean') { S.shots = v; render(); } });
  getState('ask').then((v) => { if (typeof v === 'boolean') { S.ask = v; render(); } });
  getState('asked').then((v) => { if (Array.isArray(v) && v.length) { S.asked = v; render(); } });

  render();
  console.info(`[ui-grab] ready — press ${CFG.hotkey} to pick elements`);
})();
