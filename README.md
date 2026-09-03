# ui-grab

[![test](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml/badge.svg)](https://github.com/ykakade/ui-grab/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vite-plugin-ui-grab.svg)](https://www.npmjs.com/package/vite-plugin-ui-grab)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Point at what's wrong. Claude Code fixes it.

Click elements in your running app, say what should change, batch them up, hit
Send. Claude Code picks the batch up with the file and line already attached.

**[Try the picker →](https://ykakade.github.io/ui-grab/)** — the real thing, on a
throwaway page, showing you the payload it produces.

A dev-server plugin. No extension, no daemon, no MCP server.

## Quick start

```bash
npm i -D vite-plugin-ui-grab
```

```js
// vite.config.js
import uiGrab from 'vite-plugin-ui-grab';

export default { plugins: [uiGrab()] };
```

That is the whole setup. It runs only under `vite dev`, so nothing reaches
production, and it writes `.claude/commands/grab.md` on first start if you do
not already have one. Not on Vite? See [Next.js](#nextjs).

## How it works

1. `npm run dev`, then press **Alt+Shift+G**. The cursor becomes a crosshair.
2. Hover to highlight, click to select.
3. Type what should change. **Enter** adds it to the batch.
4. Repeat. Other routes are fine — the queue lives in `localStorage`.
5. Hit **Send N to Claude Code**, then run `/grab`. Or [neither](#zero-typing-modes).

**Esc** backs out one level at a time: cancel the comment, stop picking, close
the dock. A corner badge remembers items queued behind a closed dock.

### Picking

- **Alt + arrows** walk the DOM — parent, first child, siblings. Half of "make
  this bigger" is about a parent you cannot hover, because its children cover it.
- **Shift-click** adds another element to the same comment, for "these should
  line up".
- **Click a queued comment** to reword it; the arrows beside it reorder the batch.
- **The mic button** dictates instead of typing, where the browser supports it.
- **The `shot` toggle** attaches a cropped screenshot per element. Off by
  default — it costs one screen-capture prompt per session. Crops land in
  `.ui-grab/shots/`; the queue carries the path, not the image.

### After the edit

The picker remembers what each element looked like when it went out, measures
them again once the agent is done, and reports which ones actually moved:

```
2 changed · 1 unchanged        [Revert]
```

`unchanged` means the edit landed somewhere else — the only signal here that
knows whether the source lookup was right, and it costs the agent nothing.

**Revert** restores every file the batch touched, from a `git stash create`
taken when the batch was queued. Reverting takes its own restore point first.
Files created after the batch are left alone.

### Asking instead of changing

The **`ask` toggle** turns the comment box into a question box. Same pick, same
payload, but the item goes out marked `"kind": "ask"` and the agent answers it
instead of editing:

```
? why is this heading not centred?
  h1.checkout-title
  ┌────────────────────────────────────────────┐
  │ The .checkout wrapper is `align-items:      │
  │ flex-start`. Setting `text-align: center`   │
  │ on the h1 alone will not move it.           │
  └────────────────────────────────────────────┘
```

The answer arrives in Claude Code at whatever length it deserves, and in the
dock as a couple of sentences beside the element. Questions and changes mix
freely in one batch. Questions skip the verification pass on purpose: nothing
should move, and "unchanged" is how the learned map decides it was wrong.

### Watching it happen

Everything between Send and the edit happens outside the browser. The dock shows
a line of it:

```
● Woke Claude Code via tmux
● Claude Code is working…
● Applied 3 items
⚠ No Claude Code session open in this project — run /grab
```

That last one is why this exists: a batch sent into a project with no session
open used to look exactly like a batch being worked on.

The server appends to `.ui-grab/activity.json`, a 60-entry ring buffer, and the
dock reads it over `GET /__ui-grab/events` as an `EventSource`. A file rather
than an emitter because the writers are separate processes — the dev server, the
Stop hook inside Claude Code, and `/grab` itself. None can call each other; all
can append a line. The extension polls the same log instead, since its page is
on another origin.

## Zero-typing modes

`/grab` is one command per batch. If you want none:

```bash
npx ui-grab-install --with-hook --mode both
```

| mode | what happens when you hit Send | good for |
|------|-------------------------------|----------|
| `off` | nothing, you run `/grab` | full control |
| `wait` | the Stop hook holds each turn open a few seconds longer, so clicks made just after Claude finishes land in the same turn | the common case |
| `wake` | an idle session gets poked the moment a batch arrives | long gaps between clicks |
| `both` | wait first, wake if that window passes | **default** |

Settings live in `.ui-grab/config.json`; the extension popup flips between them
without a restart.

**wait** — at the end of every turn the Stop hook checks the queue and keeps
going if you queued something while Claude was working. It also lingers for
`waitSeconds` (default 20) on an empty queue, so a click two seconds after
Claude stops still catches the turn. It gives up after 20 consecutive blocks on
an unchanged queue. The catch: a Stop hook can only hold open a turn that is
still running.

**wake** — every running Claude Code writes `~/.claude/sessions/<pid>.json`, so
an idle session in this project can be found and reached two ways, in order:
**tmux**, typing into its pane so you watch it happen (on by default), then
`claude --resume --fork-session -p`, which needs no tmux but runs headless
(off by default, `--resume` turns it on). A session mid-turn is left alone.

```bash
npx ui-grab-install --with-hook --mode wake --resume   # both wake paths
npx ui-grab-install --with-hook --mode wait --wait 45  # no waking, longer window
npx ui-grab-bridge --mode both                         # or change it later
```

Session discovery reads files Claude Code writes for its own use, which are not
a documented interface. If the format changes, waking degrades to "could not
wake anything" and the queue still drains on your next `/grab`. Run
`npx ui-grab-install` without `--with-hook` for `/grab` alone.

## Other agents

The queue is a JSON file, so nothing about it is Claude-specific:

```bash
npx ui-grab-drain            # print the batch as text, for any agent
npx ui-grab-drain --json     # or as JSON
npx ui-grab-drain --fresh    # re-resolve every pointer against the files as they are now
npx ui-grab-drain --clear    # empty the queue when you are done

npx ui-grab-drain --answer <id> "..."   # reply to an item marked ask
```

`npx ui-grab-install --agents` adds a short section to `AGENTS.md` telling an
agent to do exactly that. Cursor, Codex, Aider and anything else that reads a
project file can drain a batch this way.

## Next.js

Only the Vite plugin is Vite-specific. Everything else is a middleware and two
script tags:

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

The handler 404s in a production build, so the route cannot ship.
`vite-plugin-ui-grab/middleware` exports the same thing as a Connect middleware
for any other Node dev server.

## What gets sent

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
edited twice — a snapshot would be a lie by then. Claude reads the file fresh.

Three fields earn their keep. The full, untruncated `class` attribute, because
in a utility-CSS codebase the class list *is* the styling. `styles` is the
*computed* style, so it says what rendered rather than what the source asked
for. And `ancestors`, because half of "make this bigger" is about the parent.

`sourceRefs` key into a `sources` map shared by the whole batch, so four picks
inside one component ship that component once. `also` shows up when one comment
covers several elements.

## How the source lookup works

Three sources, ranked.

**The map, when we already know.** A pick the browser confirms — the element
really did move after the edit — goes into `.ui-grab/map.json` under its route
and selector, and the next pick ships one exact pointer and skips the scan.
Entries do not rot: every lookup re-checks the line, chases the anchor if it
drifted, and deletes the entry if the element is gone or went unchanged after an
edit. This is the only part that gets better with use.

**react-grab, when you have it.** With [`react-grab`](https://react-grab.com)
installed, the plugin reads the component and source line straight off the React
fiber — and then checks it. On a real page it returned the right file and the
wrong line. So every fiber reading is compared against the line it names; if
that line does not mention the element's tag, a class, its id, or its text, the
candidate drops below the grep hits and is labelled `react (line unverified)`.
A confidently wrong line is worse than an honest guess. When it corroborates, it
leads.

**Grep, always.** The whole story for non-React pages, production React, and
anything react-grab cannot place. It searches for the element's distinguishing
strings, strongest first: exact text, then `id` and `data-testid`, then
`aria-label` and the full class attribute, then single class names. Up to four
hits. Two tiebreakers matter: a line that *opens* the element's tag beats one
that merely contains the string, so `<title>Save changes</title>` cannot outrank
the real button; and a file with one strong hit pulls its other hits up, because
elements cluster. Dynamic text resolves to the expression that produced it:

```
src/components/Lobby.tsx:139  [text]  {ready ? "Join the call" : "Set ANTHROPIC_API_KEY to begin"}
src/components/Lobby.tsx:134  [class list]  className="primary"
```

**These are candidates, not answers.** A hit points at where the element is
*written*, often not where its styling *lives* — the hit is
`<Button size="sm">Place order</Button>` and the padding is in `Button.tsx`.
`.claude/commands/grab.md` says so. A certain pointer travels alone, with no
source block; anything less certain gets the full spread.

By default the lookup runs at Send, when the file list is warm. Set
`resolveAt: 'drain'` to store bare picks and resolve them at read time instead.

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

`window.__uiGrab` is exposed in dev, for scripting or your own tests:

```js
const g = window.__uiGrab;
g.open(true); g.setPicking(true);
g.pick(document.querySelector('#place-order'));
g.pickAlso(document.querySelector('.btn-ghost'));  // one comment, two elements
g.navigate('up');                                  // walk to the parent
g.comment('make this 1.25x larger');
g.add();
g.setAsk(true); g.comment('why is this centred?'); g.add();   // a question
g.edit(0, 'on second thought, 1.5x');
g.move(0, 1);                                      // reorder
await g.send();          // -> { ok: true, added: 1, pending: 1, batch: 'b...' }
g.items();               // queued items
g.watching();            // elements being checked after the edit
g.asked();               // questions sent, with their answers once they land
g.status();              // what the agent is doing, as shown in the dock
g.unlisten();            // put down the status stream
g.state();               // { picking, open, pending, count, extra, shots, ask,
                         //   batch, asked, inflight }
```

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
    activity.json        # what has happened since, for the dock's status line
    answers.json         # replies to ask items, on their way back to the browser
    shots/               # crops, with the shot toggle on
```

The queue sits outside `.claude/` on purpose: Claude Code treats that directory
as sensitive and asks before writing to it, and every drain ends by clearing the
queue — a permission prompt per batch, and an outright failure in the headless
session `wake` starts.

## Security

The queue is a list of instructions an agent will carry out, in `wake` mode into
a headless session running with `acceptEdits`. So the endpoints that fill,
score and revert it accept requests only from a page served locally.

That check is load-bearing. A POST sent as `content-type: text/plain` is a
CORS-*simple* request: the browser fires it with no preflight and blocks only
the reply. Without the check, any page open in another tab could queue work into
your dev server and have Claude Code carry it out. Browsers label what they send
(`Origin`, `Sec-Fetch-Site`) and a page on someone else's domain cannot forge
either; a request carrying neither came from a local process, which already has
the machine.

Beyond that: the plugin's endpoints exist only under `vite dev`, the Next
handler 404s outside `next dev`, and the bridge binds `127.0.0.1`.

## Tradeoffs

- **Dev server only.** It cannot touch a deployed URL. The extension in
  `extension/` can — it talks to `npx ui-grab-bridge`. That was the first
  design, and it needed a MAIN-world script, a relay, a service worker, a local
  HTTP server and an MCP server to do what a dev plugin does with a file write.
- **Screenshots cost a prompt.** In-page JS cannot capture its own tab, so the
  toggle uses `getDisplayMedia` — one approval per session, which is why it is
  off by default. The extension path uses `captureVisibleTab` and needs none.
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
src/activity.js       the status log, and the hub that fans it out
src/answers.js        replies to the questions in a batch
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
bin/ui-grab-drain.js  prints a batch for any agent, and takes answers back
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

221 checks against a real Vite dev server, real headless Chrome, a real tmux
pane and a real git repo: the middleware and origin gate, source resolution and
ranking, the shared source store, the learned map, verification, revert, both
zero-typing modes, the Stop hook's block budget, the status log, ask items and
their answers, and the Next.js adapter.

---

MIT. Built for [Claude Code](https://claude.com/claude-code).
