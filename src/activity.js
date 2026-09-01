// What happened to a batch after you hit Send.
//
// Between the click and the edit there is a gap the browser knows nothing
// about: was a session found, is it working, did anything read the queue. The
// server knows all of it and, until now, only said so in the terminal. This is
// that record, in the shape the rest of the project already uses — a file.
//
// A file rather than an emitter because the writers are separate processes. The
// dev server ingests the batch, the Stop hook runs inside Claude Code, `/grab`
// is Claude editing the queue directly, and `ui-grab-drain` is its own command.
// None of them can call into each other; all of them can append a line.
//
//   .ui-grab/activity.json    ring buffer, newest last, monotonic seq
//
// The hub is the reader: one per project inside whichever host is serving the
// page, watching that file plus the two others whose *contents* are events in
// their own right, and fanning the result out to every connected picker.
import fs from 'node:fs';
import path from 'node:path';
import { readQueue } from './queue.js';
import { readAnswers } from './answers.js';
import { liveSessions } from './wake.js';

export const ACTIVITY_VERSION = 1;

// Enough to explain the last few minutes to a picker that just connected, and
// small enough that the rewrite below stays cheap.
const MAX_EVENTS = 60;
const POLL_MS = 1000;
const SESSION_POLL_MS = 2000;

export const activityPath = (root) => path.join(root, '.ui-grab/activity.json');

export function readActivity(root) {
  try {
    const d = JSON.parse(fs.readFileSync(activityPath(root), 'utf8'));
    const events = Array.isArray(d.events) ? d.events : [];
    return { events, seq: events.length ? events[events.length - 1].seq : 0 };
  } catch {
    return { events: [], seq: 0 };
  }
}

/** Events after `since`, for a picker catching up on what it missed. */
export function since(root, seq = 0) {
  const { events } = readActivity(root);
  const after = events.filter((e) => e.seq > seq);
  return { events: after, seq: after.length ? after[after.length - 1].seq : seq };
}

let writeSeq = 0;

/**
 * Append one event.
 *
 * Read-modify-write, so two processes appending in the same millisecond can
 * cost one of the events. That is the right trade here: this log is a status
 * display, never an instruction, and nothing downstream reads it back to decide
 * anything. The queue, which is an instruction, gets the careful treatment.
 */
export function emit(root, kind, detail = {}) {
  const event = { seq: 0, at: Date.now(), kind, ...detail };
  try {
    const { events } = readActivity(root);
    event.seq = (events.length ? events[events.length - 1].seq : 0) + 1;
    const next = events.concat(event).slice(-MAX_EVENTS);

    const file = activityPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${writeSeq++}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: ACTIVITY_VERSION, events: next }, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch {
    // A status line is never worth failing a pick over.
  }
  return event;
}

/**
 * One reader per project, shared by every picker connected to this host.
 *
 * Lazy on purpose: the watcher and the session poll only run while something is
 * listening, so a project nobody has the dock open on costs nothing. `hub.close()`
 * is for tests and for a dev server shutting down; ordinary use just
 * unsubscribes and lets the last one out turn off the lights.
 */
export function createHub(root, { sessionsDir, pollMs = POLL_MS, sessionPollMs = SESSION_POLL_MS } = {}) {
  const subscribers = new Set();
  let seq = readActivity(root).seq;
  let watcher = null;
  let poll = null;
  let sessionTimer = null;
  let lastSession = null;
  let lastPending = readQueue(path.join(root, '.ui-grab/queue.json')).items.length;
  let lastAnswer = readAnswers(root).answers.length;

  const fan = (events) => {
    for (const e of events) for (const fn of subscribers) { try { fn(e); } catch {} }
  };

  /** New rows in the log since we last looked. */
  const drainLog = () => {
    const out = since(root, seq);
    if (!out.events.length) return;
    seq = out.seq;
    fan(out.events);
  };

  // The queue emptying is the one honest "the agent has been through this"
  // signal available: /grab is Claude editing the file directly, so there is no
  // command to instrument. Nobody writes an event for it, so the hub does.
  const checkQueue = () => {
    const pending = readQueue(path.join(root, '.ui-grab/queue.json')).items.length;
    if (pending === lastPending) return;
    const before = lastPending;
    lastPending = pending;
    if (pending === 0 && before > 0) emit(root, 'applied', { n: before });
  };

  const checkAnswers = () => {
    const { answers } = readAnswers(root);
    if (answers.length <= lastAnswer) {
      lastAnswer = answers.length;   // the file was cleared
      return;
    }
    const fresh = answers.slice(lastAnswer);
    lastAnswer = answers.length;
    for (const a of fresh) emit(root, 'answer', { id: a.id, text: a.text });
  };

  const sweep = () => { checkQueue(); checkAnswers(); drainLog(); };

  // Is a session in this project busy, idle, or absent? Read off the same
  // registry `wake` uses, which is undocumented — so a change in its shape
  // shows up as a status line that says nothing, never as a throw.
  const checkSession = () => {
    let status = 'none';
    let name = '';
    try {
      const sessions = liveSessions(root, sessionsDir);
      const busy = sessions.find((s) => s.status === 'busy');
      const one = busy || sessions[0];
      if (one) { status = busy ? 'busy' : 'idle'; name = one.name || String(one.pid); }
    } catch { return; }
    if (status === lastSession) return;   // only transitions are worth a row
    lastSession = status;
    emit(root, 'session', { status, name });
  };

  function start() {
    if (poll) return;
    const dir = path.join(root, '.ui-grab');
    try {
      fs.mkdirSync(dir, { recursive: true });
      // fs.watch is the fast path and is unreliable on some platforms and
      // filesystems, so the interval below runs either way rather than being a
      // fallback we have to detect our way into.
      watcher = fs.watch(dir, () => sweep());
      watcher.on('error', () => {});
    } catch {}
    poll = setInterval(sweep, pollMs);
    poll.unref?.();
    sessionTimer = setInterval(checkSession, sessionPollMs);
    sessionTimer.unref?.();
    checkSession();
  }

  function stop() {
    try { watcher && watcher.close(); } catch {}
    watcher = null;
    clearInterval(poll); poll = null;
    clearInterval(sessionTimer); sessionTimer = null;
    lastSession = null;
  }

  return {
    /** @returns {() => void} unsubscribe */
    subscribe(fn) {
      subscribers.add(fn);
      start();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        subscribers.delete(fn);
        if (!subscribers.size) stop();
      };
    },
    /** Backlog for a picker that just connected, or is polling. */
    since: (from) => since(root, from),

    /**
     * One sweep, on demand. The stream path has a watcher running because
     * something is subscribed to it; the poll path has nobody, so a caller that
     * only ever asks for the backlog has to turn the crank itself or the
     * derived events — queue emptied, answer written — never get written at all.
     */
    poll(from) {
      checkQueue();
      checkAnswers();
      checkSession();
      return since(root, from);
    },
    count: () => subscribers.size,
    close() { subscribers.clear(); stop(); },
  };
}

// One hub per project, so several Next.js route invocations — or a Vite server
// and a bridge in the same process during tests — share one watcher.
const hubs = new Map();

export function hubFor(root, opts) {
  const key = path.resolve(root);
  if (!hubs.has(key)) hubs.set(key, createHub(key, opts));
  return hubs.get(key);
}

export function closeHubs() {
  for (const h of hubs.values()) h.close();
  hubs.clear();
}

/** One event as an SSE frame. */
export const frame = (e) => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;
