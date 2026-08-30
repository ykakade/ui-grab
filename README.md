# ui-grab

[![test](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml/badge.svg)](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vite-plugin-ui-grab.svg)](https://www.npmjs.com/package/vite-plugin-ui-grab)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Select elements in your running app, say what should change, batch them up, and
send the batch to Claude Code.

**[Try the picker in your browser →](https://ykakade.github.io/ui-grab/)** — the
real thing, running on a throwaway page, showing you the payload it produces.

Instead of switching to your terminal and typing *"make the primary button on
the checkout screen a bit bigger, and tighten the heading leading, and…"*, you
click the button, type "bigger", click the heading, type "tighter leading", and
hit **Send**. Then run `/grab` in Claude Code — or turn on automatic mode and
skip even that.

It's a Vite dev plugin. No browser extension, no separate daemon, no MCP server.

```
  browser (dev only)                          your repo
┌────────────────────────┐              ┌───────────────────────────┐
│ picker overlay         │  POST        │ vite dev server           │
│  hover → highlight     │ ───────────▶ │  /__ui-grab/queue         │
│  click → comment       │  same-origin │    ├─ grep for the source │
│  batch in localStorage │              │    └─ append to queue     │
└────────────────────────┘              └────────────┬──────────────┘
                                                     ▼
                                        .ui-grab/queue.json
                                                     ▲
                                        ┌────────────┴──────────────┐
                                        │ Claude Code               │
                                        │  /grab     → read & apply │
                                        │  wait mode → hold the turn│
                                        │  wake mode → poke if idle │
                                        └───────────────────────────┘
```

## Install

```bash
npm i -D vite-plugin-ui-grab
```

```js
// vite.config.js
import uiGrab from 'vite-plugin-ui-grab';

export default {
  plugins: [uiGrab()],
};
```

That's the whole setup. The plugin only runs under `vite dev` (`apply: 'serve'`),
so nothing reaches production. On first start it creates `.claude/commands/grab.md`
for you if it doesn't already exist.

## Use it

1. `npm run dev`, open the app.
2. Press **Alt+Shift+G**. The cursor becomes a crosshair.
3. Hover — you get a highlight and a `tag.class  132×35` label. Click to select.
4. Type what should change. **Enter** adds it, **Shift+Enter** for a newline.
5. Keep going. Navigate to other routes if you want; the queue survives reloads
   and HMR because it lives in `localStorage`.
6. Hit **Send N to Claude Code**.
7. In Claude Code: `/grab` — or nothing at all, in `wait`/`wake` mode.

**Esc** backs out one level at a time: cancel the current comment → stop picking
→ close the dock. When the dock is closed but items are queued, a small badge
sits in the corner so you don't forget them.

### Zero-typing mode

The queue is written asynchronously and MCP-style tools are pull-only, so
something has to start a turn. `/grab` is one command per batch, which is
usually fine. If you want none at all:

```bash
npx ui-grab-install --with-hook --mode both
```

There are two ways to get a batch read without typing, and `--mode` picks which
you use. They solve different halves of the same problem.

| mode | what happens when you hit Send | good for |
|------|-------------------------------|----------|
| `off` | nothing — you run `/grab` | full control |
| `wait` | the Stop hook holds each turn open a few seconds longer, so clicks made just after Claude finishes land in the same turn | the common case |
| `wake` | an idle session gets poked the moment a batch arrives | long gaps between clicks |
| `both` | wait first; wake if that window passes | **default** |

Settings live in `.ui-grab/config.json`, and the extension popup flips between
them without a restart.

#### wait — keep the turn alive

At the end of every turn the Stop hook checks the queue, and if you've queued
something while Claude was working, it keeps going instead of stopping:

```
you type /grab once
  → drain, edit, try to finish
  → hook sees 3 new items you clicked in the meantime
  → blocked, keeps going
  → drain, edit, …
```

On top of that, `wait` mode lingers for `waitSeconds` (default 20) on an *empty*
queue before letting the turn end — so a click that lands two seconds after
Claude stops still catches the same turn. To you it looks like Claude simply
never stops while you're working.

It gives up after 20 consecutive blocks on an *unchanged* queue, so a wedged
item can't spin forever — and a new batch resets that budget.

The catch: a Stop hook can only hold open a turn that is still running. Once
Claude Code is sitting at the prompt, there's no turn left to block.

#### wake — poke an idle session

For that case, something outside has to start the turn. Every running Claude
Code writes `~/.claude/sessions/<pid>.json` describing itself — project, name,
and whether it's busy or idle — so the bridge can find the session belonging to
this project and reach it two ways, in order:

1. **tmux** — types the prompt straight into the session's pane. You watch it
   happen in the terminal you were already looking at. Default on.
2. **`claude --resume --fork-session -p`** — works with no tmux, but it runs
   headless: the edits land in your repo, in a forked session you aren't
   watching. Off by default; `--resume` turns it on.

A session that's already mid-turn is left alone — its Stop hook will pick the
batch up on its own.

```bash
npx ui-grab-install --with-hook --mode wake --resume   # both wake paths
npx ui-grab-install --with-hook --mode wait --wait 45  # no waking, longer window
npx ui-grab-bridge --mode both                         # or change it later
```

Two things worth knowing. Session discovery reads files Claude Code writes for
its own use, which aren't a documented interface — if the format changes, waking
degrades to "couldn't wake anything" and the queue still drains on your next
`/grab`. And in `wait`/`both` the session stays busy for the length of the
window after each turn; drop `--wait` if you'd rather have the prompt back
sooner.

Run `npx ui-grab-install` without `--with-hook` to just get `/grab` and print
the hook snippet for you to paste yourself.

### Where things live

```
your-project/
  .claude/
    commands/grab.md     # the /grab command
    settings.json        # the Stop hook
  .ui-grab/
    config.json          # mode, wait window, wake methods — commit this
    queue.json           # pending picks — gitignored
    shots/               # cropped screenshots, with --shots — gitignored
```

The queue deliberately sits *outside* `.claude/`. Claude Code treats that
directory as sensitive and asks before writing to it, and the last step of every
drain is Claude clearing the queue — which would mean a permission prompt on
every single batch, and an outright failure in the headless session `wake` mode
starts, where there is nobody to approve it.

## What actually gets sent

One real entry, verbatim from the test suite:

```json
{
  "route": "/checkout",
  "tag": "button",
  "elementId": "place-order",
  "classes": "btn btn-primary",
  "selector": "#place-order",
  "text": "Place order",
  "styles": {
    "display": "inline-block", "font-size": "14px", "font-weight": "600",
    "color": "rgb(255, 255, 255)", "background-color": "rgb(79, 107, 255)",
    "padding": "8px 16px", "border-radius": "8px",
    "width": "330px", "height": "35px", "text-align": "center"
  },
  "rect": { "x": 213, "y": 319, "width": 330, "height": 35 },
  "ancestors": [{ "tag": "main", "classes": "checkout" }, { "tag": "body", "classes": "" }],
  "children": [],
  "comment": "make this button 1.25x larger, keep the proportions",
  "candidates": [
    {
      "file": "index.html",
      "line": 25,
      "matchedBy": "text",
      "snippet": "<button id=\"place-order\" class=\"btn btn-primary\">Place order</button>"
    }
  ]
}
```

Note what's **not** in there: source code. The payload is a *pointer*, not a
snapshot. You might click at 2pm and drain at 4pm, after the file has already
been edited twice — a snapshot would be a lie by then, whereas a file/line plus
a class list and some text still finds the right place. Claude reads the file
itself, fresh.

Three fields earn their keep more than you'd expect:

- **the full `class` attribute**, untruncated. In a utility-CSS codebase the
  class list *is* the styling, so this plus a line number is often the complete
  answer with nothing left to look up.
- **`styles`** is the *computed* style, so it says what the element actually
  rendered as, not what the source asked for.
- **`ancestors`** because half of "make this bigger" turns out to be a question
  about the parent's layout.

## How the source lookup works

Two sources, and the ordering between them is the interesting part.

### react-grab, when you have it

If the project has [`react-grab`](https://react-grab.com) installed, the plugin
loads its `primitives` in dev and asks it for the component and source line
behind each pick, straight off the React fiber:

```bash
npm i -D react-grab
```

Nothing else to configure — the plugin detects it and stays quiet if it isn't
there. Each item then carries a `react` block with the component name, file,
line, and the enclosing component stack.

**It is checked, not trusted.** On a real page this returned the right *file*
and the wrong *line* — it named `Home.tsx:99` (`<h2>Experience</h2>`) for an
`<h1 className="headline">` that lives at line 80, and most stack frames came
back unsymbolicated. So every fiber reading is compared against the source line
it names: if that line doesn't mention the element's tag, one of its classes,
its id, or its text, the candidate is demoted below the grep hits and labelled
`react (line unverified)` rather than being dropped. A confidently wrong line is
worse than an honest guess.

When it does corroborate, it leads — it's the only signal here that isn't
guessing.

### grep, always

`ui-grab` greps as well, and that is the whole story for non-React pages,
production React, and any element react-grab can't place. When an item arrives, the plugin searches your project
for the element's own distinguishing strings — exact text content, then `id`,
`data-testid`, `aria-label`, the whole class attribute, then individual class
names — and attaches up to 4 ranked hits. That works in React, Vue, Svelte,
Astro and plain HTML alike, and it degrades gracefully: worst case it finds
nothing and Claude searches the way it would have anyway.

Ranking, strongest signal first: exact text, then `id` / `data-testid`, then
`aria-label` and the full class attribute, then single class names. Two
tiebreakers matter more than they sound: a line that actually *opens* the
element's tag beats one that merely contains the same string (otherwise
`<title>Save changes</title>` outranks the real `<button>Save changes</button>`),
and a file with one strong hit pulls its other hits up with it, because elements
cluster in a single file rather than scattering across the codebase.

It handles dynamically rendered text. Picking a button that rendered
`"Set ANTHROPIC_API_KEY to begin"` resolves to the ternary that produced it:

```
src/components/Lobby.tsx:139  [text]  {ready ? "Join the call" : "Set ANTHROPIC_API_KEY to begin"}
src/components/Lobby.tsx:134  [class list]  className="primary"
```

It caches the file list for 10 seconds, skips `node_modules`/`dist`/`.git` and
friends, and ignores files over 400 KB.

**These are candidates, not answers.** A hit points at where the element is
*written*, which is frequently not where its styling *lives*:

```tsx
<Button size="sm" variant="primary">Place order</Button>   // ← the hit
```

…while the padding is in `Button.tsx`, or a token file. That's a head start, not
a substitute for reading the code, and `.claude/commands/grab.md` says so
explicitly.

## Options

```js
uiGrab({
  queueFile: '.ui-grab/queue.json', // relative to vite root
  hotkey: 'Alt+Shift+G',            // e.g. 'Meta+Shift+E'
  badge: true,                      // corner badge when items are queued
  resolve: true,                    // attach grep candidates server-side
  source: true,                     // embed the enclosing declaration for the top candidates
  react: true,                      // use react-grab when the project has it (no-op if not)
  installCommand: true,             // create .claude/commands/grab.md if absent
  enabled: true,                    // kill switch
})
```

## Programmatic API

`window.__uiGrab` is exposed in dev — handy for scripting or your own tests:

```js
const g = window.__uiGrab;
g.open(true); g.setPicking(true);
g.pick(document.querySelector('#place-order'));
g.comment('make this 1.25x larger');
g.add();
await g.send();          // → { ok: true, added: 1, pending: 1 }
g.items();               // queued items
g.state();               // { picking, open, pending, count }
```

## Why not a Chrome extension

That was the first design, and it was worse. An extension can't read framework
internals from its own isolated world, so it needs a MAIN-world script plus a
relay; it can't `fetch` `http://localhost` from an `https` page, so it needs a
service worker; it can't talk stdio, so it needs a local HTTP server *and* an
MCP server to translate; and because Claude Code spawns one MCP process per
session, that server needs port-contention handling. About 700 lines across six
files and two protocols.

A dev plugin already runs in Node with same-origin access to the page, so all of
that collapses into a file write. The extension is only the better call if you
need to mark up sites you don't control — a deployed staging URL, someone
else's page. For your own app on your own dev server, none of its advantages
apply.

## What the queue actually is

A list of instructions an agent will carry out — in `wake` mode, into a headless
session running with `acceptEdits`. So the endpoint that fills it accepts
requests only from a page served locally.

That check is load-bearing rather than decorative. A POST sent as
`content-type: text/plain` is a CORS-*simple* request: the browser fires it with
no preflight and blocks only the reply. Without the check, any page you happened
to have open in another tab could quietly queue work into your dev server and
have Claude Code carry it out. Browsers label the requests they send (`Origin`,
`Sec-Fetch-Site`) and a page on someone else's domain cannot forge either; a
request carrying neither came from a local process, which already has the
machine and needs no gate.

Beyond that: the plugin's endpoint exists only under `vite dev`, and the bridge
binds `127.0.0.1`. Neither reaches production.

## Tradeoffs

- **Dev server only.** It's a dev plugin; it can't touch a deployed URL.
- **No screenshots.** In-page JS can't screenshot itself, and
  `getDisplayMedia` prompts every time. If a change is visually ambiguous, ask
  Claude Code to look at the page itself with the built-in Chrome integration
  (`claude --chrome`).
- **Vite only.** The core idea ports to any dev server with middleware; only
  `src/index.js` is Vite-specific.

## Layout

```
src/index.js          the Vite plugin: middleware, queue file, html injection
src/queue.js          the queue file, and who is allowed to write to it
src/resolve.js        element → source candidates, a batch per pass
src/extract.js        the enclosing declaration for a resolved candidate
src/config.js         the shared mode file both hosts read
src/wake.js           finding a live session and poking it
src/vite-transport.js the plugin's half of the picker's HOST interface
src/grab-command.js   text of the /grab slash command

extension/picker.js   the picker — overlay, dock, capture, send (no deps).
                      One file, served by both hosts, so it cannot drift.
extension/transport.js  the extension's half of the same HOST interface
bridge/server.js      local HTTP server the extension posts batches to
hooks/stop-hook.mjs   Stop hook for zero-typing mode
bin/install-claude.js writes /grab, optionally wires the hook
bin/ui-grab-bridge.js runs the bridge
examples/demo         a small checkout page to try it on
test/run.js           end-to-end: real vite server, real chrome, real files
test/automation.js    config, wait window, waking, resolution, the bridge
```

## Tests

```bash
npm install
npm test
```

Boots a real Vite dev server, drives the picker in real headless Chrome, opens
a real tmux pane to wake a session in, and asserts on what lands in the queue
file — 105 checks covering the middleware, the origin gate, source resolution,
the browser round trip, both zero-typing modes and the Stop hook's block budget.

The browser section needs Chrome; it looks in `$CHROME_PATH` and the usual
places, and skips itself rather than failing if there isn't one.

```bash
npm run demo   # try it by hand at localhost:5173
npm run site   # rebuild site/index.html (the landing page) from the real picker
```

`site/` is the landing page. It is generated: `site/template.html` holds the
page and `npm run site` drops the real `extension/picker.js` into it, so the demo
can never be running a stale copy of the picker. `.github/workflows/pages.yml`
rebuilds and publishes it on every push to `main` — set **Settings → Pages →
Source** to *GitHub Actions* once, and that's it.

## License

MIT
