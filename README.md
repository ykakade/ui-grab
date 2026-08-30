# ui-grab

[![test](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml/badge.svg)](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vite-plugin-ui-grab.svg)](https://www.npmjs.com/package/vite-plugin-ui-grab)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Click an element in your running app, say what should change, batch a few up,
send them to Claude Code.

**[Try the picker in your browser](https://ykakade.github.io/ui-grab/)**. It is
the real thing running on a throwaway page, and it shows you the payload it
produces.

Instead of switching to your terminal and typing *"make the primary button on
the checkout screen a bit bigger, and tighten the heading leading, and..."*, you
click the button, type "bigger", click the heading, type "tighter leading", and
hit **Send**. Then run `/grab`, or turn on automatic mode and skip even that.

It is a dev-server plugin. No browser extension, no daemon, no MCP server.

```
  browser (dev only)                          your repo
┌────────────────────────┐              ┌───────────────────────────┐
│ picker overlay         │  POST        │ dev server middleware     │
│  hover -> highlight    │ ───────────> │  /__ui-grab/queue         │
│  click -> comment      │  same-origin │    ├─ find the source     │
│  batch in localStorage │              │    └─ append to queue     │
└────────────────────────┘              └────────────┬──────────────┘
        ▲  re-measures after the edit                ▼
        │                               .ui-grab/queue.json
        │                                            ▲
        │                               ┌────────────┴──────────────┐
        └─────────── verdict ───────────│ Claude Code               │
                                        │  /grab     -> read, apply │
                                        │  wait mode -> hold a turn │
                                        │  wake mode -> poke if idle│
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

That is the whole setup. The plugin only runs under `vite dev` (`apply: 'serve'`),
so nothing reaches production. On first start it writes `.claude/commands/grab.md`
if you do not already have one.

Using Next.js instead? See [Next.js](#nextjs) below.

## Use it

1. `npm run dev`, open the app.
2. Press **Alt+Shift+G**. The cursor becomes a crosshair.
3. Hover for a highlight and a `tag.class  132×35` label. Click to select.
4. Type what should change. **Enter** adds it, **Shift+Enter** for a newline.
5. Keep going. Other routes are fine; the queue lives in `localStorage` and
   survives reloads and HMR.
6. Hit **Send N to Claude Code**.
7. In Claude Code: `/grab`. Or nothing at all, in `wait`/`wake` mode.

**Esc** backs out one level at a time: cancel the comment, stop picking, close
the dock. When the dock is closed with items queued, a small badge sits in the
corner so you do not forget them.

### Picking

**Alt + arrow keys** walk the DOM from what you have selected: up to the parent,
down to the first child, sideways through siblings. Half of "make this bigger"
turns out to be about the parent, and a parent is usually impossible to hover
because its children cover it. Your comment stays in the box while you move.

**Shift-click** adds another element to the comment you are writing, for when
you mean "these should line up" rather than anything about one of them alone.

**Click a queued comment** to reword it; the arrows beside it reorder the batch.

**The mic button** dictates instead of typing, where the browser supports it.

**The `shot` toggle** attaches a cropped screenshot of each element. Off by
default, and one permission prompt for the session rather than one per pick.
Crops land in `.ui-grab/shots/`; the queue carries the path, not the image.

### After the edit

The picker remembers what every element looked like when it went out. Once the
agent has been through, it measures them again and reports which ones actually
moved:

```
2 changed · 1 unchanged        [Revert]
```

An element that did not change means the edit landed somewhere else. That is the
only signal here that knows whether the source lookup was right. It costs the
agent nothing, since the measuring happens in the browser, and it feeds the map
described below.

**Revert** puts back every file the batch touched. The restore point comes from
`git stash create` when the batch is queued, which is free and invisible until
you use it. Reverting takes its own restore point first, so undoing one is a
click. Files created after the batch are left alone.

## Zero-typing mode

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
| `off` | nothing, you run `/grab` | full control |
| `wait` | the Stop hook holds each turn open a few seconds longer, so clicks made just after Claude finishes land in the same turn | the common case |
| `wake` | an idle session gets poked the moment a batch arrives | long gaps between clicks |
| `both` | wait first, wake if that window passes | **default** |

Settings live in `.ui-grab/config.json`, and the extension popup flips between
them without a restart.

### wait: keep the turn alive

At the end of every turn the Stop hook checks the queue. If you queued something
while Claude was working, it keeps going instead of stopping:

```
you type /grab once
  -> drain, edit, try to finish
  -> hook sees 3 new items you clicked in the meantime
  -> blocked, keeps going
  -> drain, edit, ...
```

It also lingers for `waitSeconds` (default 20) on an *empty* queue before
letting the turn end, so a click two seconds after Claude stops still catches
the same turn. To you it looks like Claude never stops while you are working. It
gives up after 20 consecutive blocks on an *unchanged* queue, and a new batch
resets that budget.

The catch: a Stop hook can only hold open a turn that is still running. Once
Claude Code is sitting at the prompt, there is no turn left to block.

### wake: poke an idle session

Something outside has to start that turn. Every running Claude Code writes
`~/.claude/sessions/<pid>.json` describing itself, so the session belonging to
this project can be found and reached two ways, in order:

1. **tmux**, typing the prompt into the session's pane. You watch it happen in
   the terminal you were already looking at. On by default.
2. **`claude --resume --fork-session -p`**, which needs no tmux but runs
   headless: edits land in your repo, in a forked session you are not watching.
   Off by default, `--resume` turns it on.

A session already mid-turn is left alone; its Stop hook will pick the batch up.

```bash
npx ui-grab-install --with-hook --mode wake --resume   # both wake paths
npx ui-grab-install --with-hook --mode wait --wait 45  # no waking, longer window
npx ui-grab-bridge --mode both                         # or change it later
```

Session discovery reads files Claude Code writes for its own use, which are not
a documented interface. If the format changes, waking degrades to "could not
wake anything" and the queue still drains on your next `/grab`. In `wait`/`both`
the session also stays busy for the length of the window after each turn, so
drop `--wait` if you would rather have the prompt back sooner.

Run `npx ui-grab-install` without `--with-hook` to get `/grab` alone, plus the
hook snippet to paste yourself.

## Other agents

The queue is a JSON file, so nothing about it is specific to Claude Code:

```bash
npx ui-grab-drain            # print the batch as text, for any agent
npx ui-grab-drain --json     # or as JSON
npx ui-grab-drain --fresh    # re-resolve every pointer against the files as they are now
npx ui-grab-drain --clear    # empty the queue when you are done
```

`npx ui-grab-install --agents` adds a short section to `AGENTS.md` telling an
agent to do exactly that. Cursor, Codex, Aider and anything else that reads a
project file can drain a batch this way.

## Next.js

Only the Vite plugin is Vite-specific. Everything else is a middleware and two
script tags, so Next gets the same picker from a dev-only route:

```js
// app/__ui-grab/[...path]/route.js
import { createHandlers } from 'vite-plugin-ui-grab/next';
export const { GET, POST } = createHandlers();
```

```jsx
// app/layout.jsx, inside <body>
import { uiGrabScripts } from 'vite-plugin-ui-grab/next';

const g = uiGrabScripts();
{process.env.NODE_ENV === 'development' && (
  <>
    <script dangerouslySetInnerHTML={{ __html: g.config }} />
    <script type="module" src={g.src} />
  </>
)}
```

The handler returns 404 in a production build, so the route cannot ship.
`vite-plugin-ui-grab/middleware` exports the same thing as a Connect middleware
for any other Node dev server.

## Where things live

```
your-project/
  .claude/
    commands/grab.md     # the /grab command
    settings.json        # the Stop hook
  .ui-grab/
    config.json          # mode and wait window. commit this
    map.json             # confirmed element -> source. worth committing too
    queue.json           # pending picks. gitignored
    sent.json            # what each pick pointed at, pending a verdict
    batches.json         # restore points
    shots/               # crops, with the shot toggle on
```

The queue sits outside `.claude/` on purpose. Claude Code treats that directory
as sensitive and asks before writing to it, and the last step of every drain is
clearing the queue. That would mean a permission prompt on every batch, and an
outright failure in the headless session `wake` mode starts, where nobody is
there to approve it.

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
    "padding": "8px 16px", "border-radius": "8px", "width": "330px"
  },
  "rect": { "x": 213, "y": 305, "width": 330, "height": 35 },
  "ancestors": [{ "tag": "main", "classes": "checkout" }],
  "comment": "make this button 1.25x larger, keep the proportions",
  "candidates": [
    {
      "file": "index.html",
      "line": 25,
      "matchedBy": "text",
      "snippet": "<button id=\"place-order\" class=\"btn btn-primary\">Place order</button>"
    }
  ],
  "sourceRefs": ["index.html:13-31"]
}
```

Note what is **not** in there: source code. The payload is a pointer, not a
snapshot. You might click at 2pm and drain at 4pm, after the file has been
edited twice. A snapshot would be a lie by then; a file and line plus a class
list and some text still finds the right place. Claude reads the file fresh.

Three fields earn their keep more than you would expect. The full `class`
attribute, untruncated, because in a utility-CSS codebase the class list *is*
the styling, so this plus a line number is often the whole answer. `styles` is
the *computed* style, so it says what the element rendered as rather than what
the source asked for. And `ancestors`, because half of "make this bigger" is a
question about the parent's layout.

`sourceRefs` are keys into a `sources` map at the top of the queue file. That
map belongs to the whole queue rather than to any item: four picks inside one
component used to ship that component four times, and a block that already
covers a line is now reused instead of copied. Blocks are attached only where
the pointer is not already certain, since the instructions tell the agent to
re-read the file before editing either way.

`also` shows up when one comment covers several elements. Each is resolved, and
the candidates say which element they belong to.

## How the source lookup works

Three sources, and the ordering between them is the interesting part.

### The map, when we already know

When the browser confirms a pick, meaning that element really did change after
the agent edited a file, the mapping goes into `.ui-grab/map.json` under its
route and selector. The next pick of that element ships one exact pointer and
skips the project scan entirely.

Entries do not rot. Every lookup re-checks the line, chases the anchor if it has
drifted, and deletes the entry if the element is gone. An element that goes
unchanged after an edit deletes its own entry too, on the grounds that we were
evidently wrong about it. This is the only part of the system that gets better
with use, and the payload gets smaller as it does.

### react-grab, when you have it

If the project has [`react-grab`](https://react-grab.com) installed, the plugin
loads its `primitives` in dev and asks it for the component and source line
behind each pick, straight off the React fiber:

```bash
npm i -D react-grab
```

Nothing to configure. The plugin detects it and stays quiet if it is not there.
Each item then carries a `react` block with the component name, file, line, and
the enclosing component stack.

**It is checked, not trusted.** On a real page this returned the right *file*
and the wrong *line*: it named `Home.tsx:99` (`<h2>Experience</h2>`) for an
`<h1 className="headline">` that lives at line 80, and most stack frames came
back unsymbolicated. So every fiber reading is compared against the source line
it names. If that line does not mention the element's tag, one of its classes,
its id, or its text, the candidate drops below the grep hits and is labelled
`react (line unverified)` rather than being dropped. A confidently wrong line is
worse than an honest guess.

When it does corroborate, it leads. It is the only signal here that is not
guessing.

### grep, always

Grep is the whole story for non-React pages, production React, and any element
react-grab cannot place. The plugin searches the project for the element's own
distinguishing strings, ranked strongest first: exact text, then `id` and
`data-testid`, then `aria-label` and the full class attribute, then single class
names. Up to four hits come back. It works in React, Vue, Svelte, Astro and
plain HTML alike, and worst case it finds nothing and Claude searches the way it
would have anyway.

Two tiebreakers matter more than they sound. A line that actually *opens* the
element's tag beats one that merely contains the same string, otherwise
`<title>Save changes</title>` outranks the real `<button>Save changes</button>`.
And a file with one strong hit pulls its other hits up with it, because elements
cluster in one file rather than scattering across a codebase.

It handles dynamically rendered text. Picking a button that rendered
`"Set ANTHROPIC_API_KEY to begin"` resolves to the ternary that produced it:

```
src/components/Lobby.tsx:139  [text]  {ready ? "Join the call" : "Set ANTHROPIC_API_KEY to begin"}
src/components/Lobby.tsx:134  [class list]  className="primary"
```

The file list is cached for 10 seconds, `node_modules`/`dist`/`.git` are
skipped, and files over 400 KB are ignored.

**These are candidates, not answers.** A hit points at where the element is
*written*, which is frequently not where its styling *lives*: the hit is
`<Button size="sm">Place order</Button>` and the padding is in `Button.tsx` or a
token file. A head start, not a substitute for reading the code, and
`.claude/commands/grab.md` says so.

### How much of it gets sent

A pointer that is certain does not need three alternatives and a copy of the
file attached to it. A corroborated fiber reading, a confirmed map entry, or a
lone exact-text hit with no rival in another file is sent on its own, with no
source block. Anything less certain gets the full spread, because the agent is
going to have to choose.

### When the lookup happens

By default it runs when you hit Send, which is when the file list is already
warm. Set `resolveAt: 'drain'` and the queue stores bare picks instead, and
`ui-grab-drain` resolves them against the files as they are at the moment
something reads them. That costs one scan later and is always current, which is
worth it if batches tend to sit for a while before anyone drains them.

## Options

```js
uiGrab({
  queueFile: '.ui-grab/queue.json', // relative to vite root
  hotkey: 'Alt+Shift+G',            // e.g. 'Meta+Shift+E'
  badge: true,                      // corner badge when items are queued
  resolve: true,                    // attach source candidates
  source: true,                     // embed the enclosing declaration where it helps
  adaptive: true,                   // one pointer instead of four when it is certain
  resolveAt: 'queue',               // or 'drain'
  shots: false,                     // start with the screenshot toggle on
  verify: true,                     // re-measure elements after an edit lands
  react: true,                      // use react-grab when the project has it
  installCommand: true,             // create .claude/commands/grab.md if absent
  enabled: true,                    // kill switch
})
```

## Programmatic API

`window.__uiGrab` is exposed in dev, which is handy for scripting or your own
tests:

```js
const g = window.__uiGrab;
g.open(true); g.setPicking(true);
g.pick(document.querySelector('#place-order'));
g.pickAlso(document.querySelector('.btn-ghost'));  // one comment, two elements
g.navigate('up');                                  // walk to the parent
g.comment('make this 1.25x larger');
g.add();
g.edit(0, 'on second thought, 1.5x');
g.move(0, 1);                                      // reorder
await g.send();          // -> { ok: true, added: 1, pending: 1, batch: 'b...' }
g.items();               // queued items
g.watching();            // elements being checked after the edit
g.state();               // { picking, open, pending, count, extra, shots, batch }
```

## Why not a Chrome extension

That was the first design and it was worse. An extension cannot read framework
internals from its own isolated world, so it needs a MAIN-world script plus a
relay; it cannot `fetch` `http://localhost` from an `https` page, so it needs a
service worker; it cannot talk stdio, so it needs a local HTTP server *and* an
MCP server, which needs port-contention handling because Claude Code spawns one
MCP process per session. About 700 lines across six files and two protocols.

A dev plugin already runs in Node with same-origin access to the page, so all of
that collapses into a file write. The extension is still the better call for
sites you do not control, like a deployed staging URL. It ships in `extension/`
and talks to `npx ui-grab-bridge`.

## What the queue actually is

A list of instructions an agent will carry out, in `wake` mode into a headless
session running with `acceptEdits`. So the endpoints that fill it, score it and
revert it accept requests only from a page served locally.

That check is load-bearing rather than decorative. A POST sent as
`content-type: text/plain` is a CORS-*simple* request: the browser fires it with
no preflight and blocks only the reply. Without the check, any page you happened
to have open in another tab could quietly queue work into your dev server and
have Claude Code carry it out. Browsers label what they send (`Origin`,
`Sec-Fetch-Site`) and a page on someone else's domain cannot forge either. A
request carrying neither came from a local process, which already has the
machine.

Beyond that: the plugin's endpoints exist only under `vite dev`, the Next
handler 404s outside `next dev`, and the bridge binds `127.0.0.1`. None of them
reach production.

## Tradeoffs

- **Dev server only.** It is a dev plugin, so it cannot touch a deployed URL.
  The extension can, if you need that.
- **Screenshots cost a prompt.** In-page JS cannot capture its own tab, so the
  toggle uses `getDisplayMedia`. The stream is opened once and reused for every
  crop, but you still approve it once per session, which is why it is off by
  default. The extension path uses `captureVisibleTab` and needs no prompt.
- **Revert is git-shaped.** No repo, no restore points. Untracked files created
  after a batch are not put back.

## Layout

```
src/index.js          the Vite plugin: options, html injection, client module
src/middleware.js     the HTTP surface, shared by every host
src/next.js           Next.js route handlers and script tags
src/ingest.js         a batch from the wire to the queue file
src/resolve.js        element -> source candidates, one pass per batch
src/extract.js        the enclosing declaration, into a store shared by the batch
src/map.js            confirmed element -> source, and how it self-heals
src/verify.js         the browser's verdict, and what it teaches the map
src/snapshot.js       restore points and revert
src/drain.js          reading the queue out, for any agent
src/queue.js          the queue file, and who is allowed to write to it
src/config.js         the shared mode file both hosts read
src/wake.js           finding a live session and poking it
src/browser-transport.js  the plugin's half of the picker's HOST interface

extension/picker.js   the picker: overlay, dock, capture, send. No deps, one
                      file, served by every host so it cannot drift
extension/transport.js  the extension's half of the same HOST interface
bridge/server.js      local HTTP server the extension posts batches to
hooks/stop-hook.mjs   Stop hook for zero-typing mode
bin/install-claude.js writes /grab and AGENTS.md, wires the hook
bin/ui-grab-drain.js  prints a batch for any agent
bin/ui-grab-bridge.js runs the bridge
examples/demo         a small checkout page to try it on
test/run.js           end to end: real vite server, real chrome, real files
test/automation.js    config, resolution, the map, verification, revert, hosts
```

## Tests

```bash
npm install
npm test
```

Boots a real Vite dev server, drives the picker in real headless Chrome, opens a
real tmux pane to wake a session in, makes a real git repo to revert inside, and
asserts on what lands on disk. 187 checks, covering the middleware and the
origin gate, source resolution and ranking, the shared source store, the learned
map, verification, revert, both zero-typing modes, the Stop hook's block budget,
and the Next.js adapter.
