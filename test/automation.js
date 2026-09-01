// Tests for the two zero-typing modes: the Stop hook's wait window, and the
// bridge waking an idle session. The tmux half is a real tmux session with a
// real process in it — the whole point is that the poke actually lands.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../bridge/server.js';
import { extractInto } from '../src/extract.js';
import { readQueue, writeQueue } from '../src/queue.js';
import { confidence, prune } from '../src/resolve.js';
import { confirm, lookup, loadMap, mapKey } from '../src/map.js';
import { record, applyResults, readSent } from '../src/verify.js';
import { snapshot, revert, isRepo } from '../src/snapshot.js';
import { ingest } from '../src/ingest.js';
import { drainPayload, clearQueue, render } from '../src/drain.js';
import { createHandlers } from '../src/next.js';
import { normalize, loadConfig, saveConfig } from '../src/config.js';
import { liveSessions, paneFor, projectSlug, wake, resumeArgs } from '../src/wake.js';
import { resolveCandidates, resolveBatch } from '../src/resolve.js';
import { fromLocalPage } from '../src/queue.js';
import { emit, readActivity, since as sinceEvents, createHub, closeHubs } from '../src/activity.js';
import { readAnswers, writeAnswer, isAsk } from '../src/answers.js';
import { drainPrompt } from '../src/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-grab-auto-'));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? '\n       ' + extra : ''}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (bin) => { try { execFileSync('which', [bin], { stdio: 'ignore' }); return true; } catch { return false; } };

console.log('\nui-grab automation tests\n');

// ---- 1. config ---------------------------------------------------------------
console.log('config');
ok('defaults to both/20s', normalize({}).mode === 'both' && normalize({}).waitSeconds === 20);
ok('rejects an unknown mode', normalize({ mode: 'sideways' }).mode === 'both');
ok('clamps a silly wait', normalize({ waitSeconds: 99999 }).waitSeconds === 300);
ok('wake.tmux defaults on, resume off',
  normalize({}).wake.tmux === true && normalize({}).wake.resume === false);

const cfgRoot = path.join(TMP, 'cfg');
fs.mkdirSync(cfgRoot, { recursive: true });
saveConfig(cfgRoot, { mode: 'wake', waitSeconds: 5 });
ok('round-trips through disk', loadConfig(cfgRoot).mode === 'wake' && loadConfig(cfgRoot).waitSeconds === 5);
saveConfig(cfgRoot, { mode: 'off' });
ok('a partial patch keeps the rest', loadConfig(cfgRoot).waitSeconds === 5 && loadConfig(cfgRoot).mode === 'off');

// ---- 2. the wait window ------------------------------------------------------
console.log('\nwait mode');
const hookRoot = path.join(TMP, 'hook');
fs.mkdirSync(path.join(hookRoot, '.ui-grab'), { recursive: true });
const hookQueue = path.join(hookRoot, '.ui-grab/queue.json');

const runHook = (env = {}) => new Promise((res) => {
  const started = Date.now();
  const p = spawn('node', [path.join(ROOT, 'hooks/stop-hook.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stdin.end(JSON.stringify({ cwd: hookRoot, session_id: 'wait-test' }));
  p.on('close', (code) => res({ code, out: out.trim(), ms: Date.now() - started }));
});

saveConfig(hookRoot, { mode: 'wait', waitSeconds: 2 });
const held = await runHook();
ok('holds the turn open on an empty queue', held.ms >= 1900 && held.out === '', `${held.ms}ms ${held.out}`);

// a click landing mid-window should cut the wait short and block
const late = runHook();
await sleep(600);
fs.writeFileSync(hookQueue, JSON.stringify({ version: 1, items: [{ id: 'late', comment: 'x' }] }));
const caught = await late;
ok('catches a click made during the window',
  JSON.parse(caught.out || '{}').decision === 'block', caught.out);
ok('and stops waiting as soon as it lands', caught.ms < 1800, `${caught.ms}ms`);

fs.rmSync(hookQueue, { force: true });
fs.rmSync(hookQueue.replace(/\.json$/, '.blocks.json'), { force: true });
saveConfig(hookRoot, { mode: 'off' });
const offRun = await runHook();
ok('mode off never waits', offRun.ms < 1500 && offRun.out === '', `${offRun.ms}ms`);

saveConfig(hookRoot, { mode: 'wake' });
const wakeRun = await runHook();
ok('mode wake never waits either', wakeRun.ms < 1500 && wakeRun.out === '', `${wakeRun.ms}ms`);

// ---- 3. session discovery ----------------------------------------------------
console.log('\nsession discovery');
ok('slugifies a cwd the way Claude Code does',
  projectSlug('/Users/x/Downloads/src/ui-grab') === '-Users-x-Downloads-src-ui-grab');
ok('no sessions for a directory nobody is in', liveSessions(path.join(TMP, 'nowhere')).length === 0);

const fakeDir = path.join(TMP, 'sessions');
fs.mkdirSync(fakeDir, { recursive: true });
const writeSession = (pid, extra = {}) => fs.writeFileSync(
  path.join(fakeDir, `${pid}.json`),
  JSON.stringify({ pid, sessionId: `sess-${pid}`, cwd: hookRoot, name: `fake-${pid}`,
    kind: 'interactive', status: 'idle', updatedAt: Date.now(), ...extra }),
);

writeSession(999999); // a pid that cannot be running
ok('skips sessions whose process is gone', liveSessions(hookRoot, fakeDir).length === 0);

writeSession(process.pid);
ok('finds a live session in this project', liveSessions(hookRoot, fakeDir).length === 1);
ok('ignores other projects',
  liveSessions(path.join(TMP, 'elsewhere'), fakeDir).length === 0);

// ---- 4. waking ---------------------------------------------------------------
console.log('\nwaking');
const wakeCfg = normalize({ mode: 'wake' });

writeSession(process.pid, { status: 'busy' });
const busy = wake(hookRoot, wakeCfg, 1, '.ui-grab/queue.json', { sessionsDir: fakeDir });
ok('leaves a busy session alone', !busy.woke && busy.via === 'busy', JSON.stringify(busy));

fs.rmSync(path.join(fakeDir, `${process.pid}.json`));
const nobody = wake(hookRoot, wakeCfg, 1, '.ui-grab/queue.json', { sessionsDir: fakeDir });
ok('reports when there is nothing to wake', !nobody.woke && nobody.via === 'none', JSON.stringify(nobody));

if (!has('tmux')) {
  console.log('  skip tmux wake (tmux not installed)');
} else {
  const SESSION = 'ui-grab-test-pane';
  try { execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' }); } catch {}
  execFileSync('tmux', ['new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50'], { stdio: 'ignore' });
  try {
    // A child of the pane's shell, standing in for the claude process.
    execFileSync('tmux', ['send-keys', '-t', SESSION, 'sleep 120', 'Enter'], { stdio: 'ignore' });
    await sleep(700);
    const panePid = Number(execFileSync('tmux',
      ['list-panes', '-t', SESSION, '-F', '#{pane_pid}'], { encoding: 'utf8' }).trim());
    const childPid = Number(execFileSync('pgrep', ['-P', String(panePid)], { encoding: 'utf8' })
      .trim().split('\n')[0]);

    ok('finds the pane a session is running in', paneFor(childPid) !== null, `child ${childPid}`);
    ok('does not claim a pane for an unrelated process', paneFor(1) === null);

    writeSession(childPid, { status: 'idle', pid: childPid });
    const woke = wake(hookRoot, wakeCfg, 3, '.ui-grab/queue.json', { sessionsDir: fakeDir });
    ok('wakes an idle session through tmux', woke.woke && woke.via === 'tmux', JSON.stringify(woke));

    await sleep(400);
    const pane = execFileSync('tmux', ['capture-pane', '-t', SESSION, '-p'], { encoding: 'utf8' });
    ok('the prompt actually lands in the pane',
      pane.includes('3 UI items are queued'), pane.trim().split('\n').slice(-3).join(' | '));
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', SESSION], { stdio: 'ignore' }); } catch {}
  }
}

// ---- 4b. waking without tmux -------------------------------------------------
// The resume path is the one that works on a plain terminal. A stub `claude`
// on PATH lets us prove it fires with the right argv without starting a real
// session.
console.log('\nwaking without tmux');

ok('permission mode rides along by default',
  resumeArgs('abc', 'go', normalize({})).join(' ') ===
  '--resume abc --fork-session --permission-mode acceptEdits -p go');
ok('and can be turned off',
  !resumeArgs('abc', 'go', normalize({ wake: { permissionMode: 'default' } })).includes('--permission-mode'));

const binDir = path.join(TMP, 'stubbin');
const argvLog = path.join(TMP, 'claude-argv.txt');
fs.mkdirSync(binDir, { recursive: true });
// Written to a temp path and moved into place, so the poll below can never
// catch a half-written log.
fs.writeFileSync(path.join(binDir, 'claude'),
  `#!/bin/sh\n` +
  `printf '%s\\n' "$PWD" > ${JSON.stringify(argvLog + '.tmp')}\n` +
  `for a in "$@"; do printf '%s\\n' "$a" >> ${JSON.stringify(argvLog + '.tmp')}; done\n` +
  `mv ${JSON.stringify(argvLog + '.tmp')} ${JSON.stringify(argvLog)}\n`);
fs.chmodSync(path.join(binDir, 'claude'), 0o755);

const realPath = process.env.PATH;
process.env.PATH = `${binDir}:${realPath}`;

// no tmux, resume on — exactly a plain-terminal setup
const noTmux = normalize({ mode: 'wake', wake: { tmux: false, resume: true } });
writeSession(process.pid, { status: 'idle' });
const viaResume = wake(hookRoot, noTmux, 2, '.ui-grab/queue.json', { sessionsDir: fakeDir });
ok('falls back to resume when tmux is off', viaResume.woke && viaResume.via === 'resume',
  JSON.stringify(viaResume));

for (let i = 0; i < 40 && !fs.existsSync(argvLog); i++) await sleep(50);
const logged = fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n') : [];
process.env.PATH = realPath;

ok('actually spawned claude', logged.length > 0, 'stub never ran');
ok('in the project directory', logged[0] === fs.realpathSync(hookRoot), logged[0]);
ok('resuming the live session, forked',
  logged.includes('--resume') && logged.includes(`sess-${process.pid}`) && logged.includes('--fork-session'),
  logged.join(' '));
ok('with a prompt that names the queue',
  logged.some((a) => a.includes('2 UI items are queued')), logged.slice(-1)[0]);

// with resume off and tmux off there is nothing left to try
const noWay = normalize({ mode: 'wake', wake: { tmux: false, resume: false } });
const stuck = wake(hookRoot, noWay, 1, '.ui-grab/queue.json', { sessionsDir: fakeDir });
ok('says so when no wake method is enabled', !stuck.woke && stuck.via === 'unreachable',
  JSON.stringify(stuck));

fs.rmSync(path.join(fakeDir, `${process.pid}.json`), { force: true });

// ---- 4c. react-grab resolution -----------------------------------------------
// When the page had react-grab loaded, the item arrives with the fiber's own
// file and line. That is ground truth and must outrank every grep guess.
console.log('\nreact-grab resolution');

const rgRoot = path.join(TMP, 'rgproj');
fs.mkdirSync(path.join(rgRoot, 'src/pages'), { recursive: true });
fs.mkdirSync(path.join(rgRoot, 'src/data'), { recursive: true });
fs.writeFileSync(path.join(rgRoot, 'src/pages/Home.tsx'),
  ['export default function Home() {', '  return (', '    <div>',
   '      <h1 className="headline">{rich(site.headline)}</h1>', '    </div>', '  )', '}'].join('\n'));
fs.writeFileSync(path.join(rgRoot, 'src/data/content.ts'),
  ['export const site = {', "  headline: 'I like the software nobody notices.',", '}'].join('\n'));

const pick = {
  tag: 'h1', classes: 'headline', text: 'I like the software nobody notices.', attrs: {},
};

const grepOnly = resolveCandidates(rgRoot, pick);
ok('grep alone still resolves', grepOnly.length > 0, JSON.stringify(grepOnly.map((c) => c.file)));

const withReact = resolveCandidates(rgRoot, {
  ...pick,
  react: {
    componentName: 'Home',
    file: path.join(rgRoot, 'src/pages/Home.tsx'),
    line: 4,
    column: 7,
    stack: [{ component: 'App', file: path.join(rgRoot, 'src/data/content.ts'), line: 2 }],
  },
});
ok('the fiber location comes first',
  withReact[0].file === 'src/pages/Home.tsx' && withReact[0].line === 4 &&
  withReact[0].matchedBy === 'react', JSON.stringify(withReact[0]));
ok('it carries the component name', withReact[0].component === 'Home', withReact[0].component);
ok('it quotes the real line',
  withReact[0].snippet.includes('className="headline"'), withReact[0].snippet);
ok('the enclosing stack follows',
  withReact.some((c) => c.matchedBy === 'react stack' && c.file === 'src/data/content.ts'),
  JSON.stringify(withReact.map((c) => `${c.file}:${c.line}:${c.matchedBy}`)));
ok('no duplicate of the grep hit at the same spot',
  withReact.filter((c) => c.file === 'src/pages/Home.tsx' && c.line === 4).length === 1,
  JSON.stringify(withReact.map((c) => `${c.file}:${c.line}`)));

// A fiber reading whose line does not match the element must not outrank a
// grep hit that does — observed on a real page: right file, wrong line.
const wrongLine = resolveCandidates(rgRoot, {
  ...pick,
  react: { componentName: 'Home', file: path.join(rgRoot, 'src/pages/Home.tsx'), line: 1, stack: [] },
});
ok('an uncorroborated line does not come first',
  wrongLine[0].matchedBy !== 'react', JSON.stringify(wrongLine[0]));
ok('it is kept, and says the line is unverified',
  wrongLine.some((c) => c.matchedBy.includes('unverified')),
  JSON.stringify(wrongLine.map((c) => c.matchedBy)));
ok('a grep hit leads instead',
  ['text', 'class list'].some((m) => wrongLine[0].matchedBy.startsWith(m)),
  JSON.stringify(wrongLine[0]));
ok('no candidate still carries the internal weak flag',
  wrongLine.every((c) => !('weak' in c)), JSON.stringify(wrongLine));

// paths that are not somewhere you could edit must be dropped
const noisy = resolveCandidates(rgRoot, {
  ...pick,
  react: { componentName: 'X', file: '/somewhere/else/node_modules/react-dom/index.js', line: 9, stack: [] },
});
ok('node_modules frames are dropped',
  !noisy.some((c) => c.file.includes('node_modules')), JSON.stringify(noisy.map((c) => c.file)));

const gone = resolveCandidates(rgRoot, {
  ...pick,
  react: { componentName: 'X', file: path.join(rgRoot, 'src/Deleted.tsx'), line: 3, stack: [] },
});
ok('a file that no longer exists is dropped',
  !gone.some((c) => c.file.includes('Deleted')), JSON.stringify(gone.map((c) => c.file)));

// ---- 4d. resolving a whole batch ---------------------------------------------
// A batch is what actually arrives from the browser, and resolving it item by
// item re-scanned the project once per pick. One pass has to give byte-identical
// results or the optimisation is not one.
console.log('\nbatch resolution');
{
  const picks = [
    { tag: 'h1', classes: 'headline', text: 'I like the software nobody notices.', attrs: {} },
    { tag: 'div', classes: '', text: '', attrs: {} },
    { tag: 'h1', classes: 'headline', text: '', attrs: {} },
  ];
  const batched = resolveBatch(rgRoot, picks);
  ok('every item in the batch gets an entry', batched.length === picks.length);
  ok('identical to resolving them one at a time',
    JSON.stringify(batched) === JSON.stringify(picks.map((p) => resolveCandidates(rgRoot, p))),
    JSON.stringify(batched));
  ok('an item with nothing to match on gets an empty list, not a hole',
    Array.isArray(batched[1]) && batched[1].length === 0, JSON.stringify(batched[1]));
  ok('an empty batch is fine', resolveBatch(rgRoot, []).length === 0);
}

// ---- 4d-ii. the element's id -------------------------------------------------
// The picker sends two ids: `id` is a random token it assigns each pick, and
// `elementId` is the DOM one. Searching the wrong one costs the second-strongest
// signal there is, and does so silently — every hit still comes back, just from
// weaker keys.
console.log('\nelement id as a search key');
{
  const idRoot = path.join(TMP, 'idproj');
  fs.mkdirSync(idRoot, { recursive: true });
  fs.writeFileSync(path.join(idRoot, 'index.html'),
    '<main>\n  <div class="wrap">\n    <button id="place-order">Go</button>\n  </div>\n</main>\n');

  // Text too short to key on and no classes: the id is all there is to go on.
  const pick = { id: 'g7k2x9p', elementId: 'place-order', tag: 'button', text: 'Go', classes: '', attrs: {} };
  const got = resolveCandidates(idRoot, pick);
  ok('an element found by its id alone', got.length === 1 && got[0].line === 3, JSON.stringify(got));
  ok('and it says that is how it was found', got[0]?.matchedBy === 'id', got[0]?.matchedBy);
  ok('the random pick id is never searched for',
    resolveCandidates(idRoot, { ...pick, elementId: '' }).length === 0,
    JSON.stringify(resolveCandidates(idRoot, { ...pick, elementId: '' })));
}

// ---- 4e. who may write to the queue ------------------------------------------
// The queue is instructions an agent carries out, so the endpoint that fills it
// has to know the request came from a page served locally.
console.log('\nqueue origin gate');
{
  const req = (headers) => ({ headers });
  ok('a local client sending no browser headers is allowed', fromLocalPage(req({})));
  ok('the dev page itself is allowed',
    fromLocalPage(req({ origin: 'http://localhost:5173', 'sec-fetch-site': 'same-origin' })));
  ok('another local dev server is allowed',
    fromLocalPage(req({ origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' })));
  ok('a cross-site page is refused',
    !fromLocalPage(req({ origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' })));
  ok('refused even with the sec-fetch label stripped',
    !fromLocalPage(req({ origin: 'https://evil.example' })));
  ok('a host that merely starts with localhost is refused',
    !fromLocalPage(req({ origin: 'https://localhost.evil.example' })));
  ok('the extension is allowed only where extensions are',
    fromLocalPage(req({ origin: 'chrome-extension://abc' }), { extensions: true }) &&
    !fromLocalPage(req({ origin: 'chrome-extension://abc' })));
}

// ---- 4f. one copy of the source per batch ------------------------------------
// Four picks in one component used to ship that component four times. The
// blocks live in a store the items point into, so they cannot duplicate.
console.log('\nsource blocks');
{
  const sRoot = path.join(TMP, 'srcproj');
  fs.mkdirSync(sRoot, { recursive: true });
  fs.writeFileSync(path.join(sRoot, 'Card.tsx'),
    ['export function Card() {', '  return (', '    <div className="card">',
     '      <h2>Title</h2>', '      <p>Body</p>', '    </div>', '  );', '}'].join('\n'));

  const store = {};
  const a = extractInto(sRoot, [{ file: 'Card.tsx', line: 4 }], store);
  const b = extractInto(sRoot, [{ file: 'Card.tsx', line: 5 }], store);
  ok('two picks in one declaration share one block',
    Object.keys(store).length === 1, JSON.stringify(Object.keys(store)));
  ok('and both point at it', a[0] === b[0], `${a[0]} vs ${b[0]}`);
  ok('the block knows where it came from',
    store[a[0]].file === 'Card.tsx' && store[a[0]].kind === 'declaration' && !!store[a[0]].sha,
    JSON.stringify(store[a[0]]).slice(0, 120));
  ok('a candidate outside the file is skipped, not thrown',
    extractInto(sRoot, [{ file: 'Nope.tsx', line: 1 }], store).length === 0);
}

// ---- 4g. the queue file shape ------------------------------------------------
console.log('\nqueue file');
{
  const qDir = path.join(TMP, 'queue');
  fs.mkdirSync(qDir, { recursive: true });
  const qf = path.join(qDir, 'queue.json');

  // a v1 file, with the source copied onto each item
  fs.writeFileSync(qf, JSON.stringify({ version: 1, items: [
    { id: 'a', source: [{ file: 'x.tsx', lines: '1-9', code: 'A' }] },
    { id: 'b', source: [{ file: 'x.tsx', lines: '1-9', code: 'A' }] },
  ] }));
  const hoisted = readQueue(qf);
  ok('v1 items are read and their blocks hoisted',
    Object.keys(hoisted.sources).length === 1 && hoisted.items.every((i) => !i.source),
    JSON.stringify(Object.keys(hoisted.sources)));
  ok('both items reference the one block',
    hoisted.items.every((i) => i.sourceRefs[0] === 'x.tsx:1-9'),
    JSON.stringify(hoisted.items.map((i) => i.sourceRefs)));

  writeQueue(qf, { items: [hoisted.items[0]], sources: { ...hoisted.sources, 'dead.tsx:1-2': { code: 'x' } } });
  const gc = readQueue(qf);
  ok('a block nobody points at is dropped on write',
    Object.keys(gc.sources).length === 1 && !gc.sources['dead.tsx:1-2'],
    JSON.stringify(Object.keys(gc.sources)));
  ok('an unreadable queue reads as empty rather than throwing',
    readQueue(path.join(qDir, 'nope.json')).items.length === 0);
}

// ---- 4h. how much is worth sending -------------------------------------------
// A pointer that is certain does not need three alternatives and a copy of the
// file attached to it.
console.log('\ncandidate pruning');
{
  const one = [{ file: 'a.tsx', line: 3, matchedBy: 'text' }];
  ok('a lone exact-text hit is confident', prune(one).confident, String(confidence(one)));
  const rivals = [...one, { file: 'b.tsx', line: 9, matchedBy: 'text' },
    { file: 'c.tsx', line: 2, matchedBy: 'class .x' }];
  ok('rivals in other files make it a guess again', !prune(rivals).confident, String(confidence(rivals)));
  ok('and then everything is sent', prune(rivals).candidates.length === 3);
  const fiber = [{ file: 'a.tsx', line: 3, matchedBy: 'react' }, { file: 'b.tsx', line: 1, matchedBy: 'text' }];
  ok('a corroborated fiber reading stays confident', prune(fiber).confident);
  ok('and drops the rival', prune(fiber).candidates.length === 1, JSON.stringify(prune(fiber).candidates));
  ok('a weak class hit is never confident',
    !prune([{ file: 'a.tsx', line: 1, matchedBy: 'class .btn' }]).confident);
  ok('nothing found is not confidence', confidence([]) === 0);
}

// ---- 4i. what we have learned ------------------------------------------------
// A confirmed element skips the scan entirely next time, and a mapping that has
// gone stale deletes itself rather than misleading the agent.
console.log('\nlearned map');
{
  const mRoot = path.join(TMP, 'mapproj');
  fs.mkdirSync(mRoot, { recursive: true });
  const file = path.join(mRoot, 'Page.tsx');
  fs.writeFileSync(file, ['const a = 1;', '<button className="buy">Buy</button>', 'const b = 2;'].join('\n'));

  const item = { route: '/shop', selector: '#buy', tag: 'button', classes: 'buy', text: 'Buy' };
  ok('an unknown element has no entry', lookup(mRoot, item) === null);

  confirm(mRoot, mapKey(item), 'Page.tsx', 2);
  const hit = lookup(mRoot, item);
  ok('a confirmed element comes back exact',
    hit && hit.file === 'Page.tsx' && hit.line === 2 && hit.matchedBy === 'map', JSON.stringify(hit));
  ok('the same element on another route is a different entry',
    lookup(mRoot, { ...item, route: '/cart' }) === null);

  // the file grows two lines above the element
  fs.writeFileSync(file, ['x', 'y', 'const a = 1;', '<button className="buy">Buy</button>', 'const b = 2;'].join('\n'));
  const moved = lookup(mRoot, item);
  ok('a line that drifted is chased down', moved && moved.line === 4, JSON.stringify(moved));
  ok('and the entry is updated in place', loadMap(mRoot).entries[mapKey(item)].line === 4);

  fs.writeFileSync(file, 'nothing like it here\n');
  ok('an element that is gone returns nothing', lookup(mRoot, item) === null);
  ok('and stops being remembered', !loadMap(mRoot).entries[mapKey(item)]);

  confirm(mRoot, mapKey(item), 'Missing.tsx', 1);
  ok('a confirm against a file that cannot be read is ignored',
    !loadMap(mRoot).entries[mapKey(item)]);
  ok('an element with nothing to key on has no key', mapKey({ route: '/x' }) === null);
}

// ---- 4j. the browser's verdict -----------------------------------------------
console.log('\nverification');
{
  const vRoot = path.join(TMP, 'verifyproj');
  fs.mkdirSync(vRoot, { recursive: true });
  fs.writeFileSync(path.join(vRoot, 'App.tsx'), 'const x = 1;\n<h1 className="hero">Hi</h1>\n');
  const item = { route: '/', selector: '.hero', tag: 'h1', classes: 'hero', text: 'Hi' };

  record(vRoot, [{ id: 'i1', key: mapKey(item), file: 'App.tsx', line: 2 }]);
  ok('what was sent is remembered', readSent(vRoot).length === 1);

  const good = applyResults(vRoot, [{ id: 'i1', changed: true }]);
  ok('an element that changed confirms the pointer', good.confirmed === 1, JSON.stringify(good));
  ok('and it is in the map now', !!lookup(vRoot, item));
  ok('the ledger entry is spent', readSent(vRoot).length === 0);

  record(vRoot, [{ id: 'i2', key: mapKey(item), file: 'App.tsx', line: 2, mapped: true }]);
  const bad = applyResults(vRoot, [{ id: 'i2', changed: false }]);
  ok('an element that did not move unlearns the mapping', bad.forgotten === 1, JSON.stringify(bad));
  ok('and the map is empty again', lookup(vRoot, item) === null);
  ok('a verdict for something we never sent is counted, not thrown',
    applyResults(vRoot, [{ id: 'ghost', changed: true }]).unknown === 1);
}

// ---- 4k. restore points ------------------------------------------------------
console.log('\nrevert');
{
  const gRoot = path.join(TMP, 'gitproj');
  fs.mkdirSync(gRoot, { recursive: true });
  const run = (...args) => execFileSync('git', args, { cwd: gRoot, stdio: 'ignore' });
  const target = path.join(gRoot, 'style.css');

  ok('a directory that is not a repo has no restore points', !isRepo(path.join(TMP, 'nowhere')));

  run('init', '-q');
  run('config', 'user.email', 't@t.t');
  run('config', 'user.name', 'test');
  fs.writeFileSync(target, '.btn { padding: 8px; }\n');
  run('add', '-A');
  run('commit', '-qm', 'first');

  const snap = snapshot(gRoot, { items: 1 });
  ok('a batch takes a restore point', !!snap && !!snap.commit, JSON.stringify(snap));

  fs.writeFileSync(target, '.btn { padding: 40px; }\n');
  const dry = revert(gRoot, snap.id, { dryRun: true });
  ok('it knows which files changed since', dry.files.includes('style.css'), JSON.stringify(dry));
  ok('and a dry run changes nothing', fs.readFileSync(target, 'utf8').includes('40px'));

  const done = revert(gRoot, snap.id);
  ok('reverting puts the file back',
    done.ok && fs.readFileSync(target, 'utf8').includes('8px'), JSON.stringify(done));
  ok('and the revert is itself undoable', !!done.undo, JSON.stringify(done));

  ok('and nothing is left staged behind it',
    execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: gRoot, encoding: 'utf8' }).trim() === '',
    execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: gRoot, encoding: 'utf8' }));

  const back = revert(gRoot, done.undo);
  ok('so the change can be brought back',
    back.ok && fs.readFileSync(target, 'utf8').includes('40px'), JSON.stringify(back));
  ok('an unknown batch is refused', !revert(gRoot, 'nope').ok);
}

// ---- 4l. taking a batch in ---------------------------------------------------
console.log('\ningest');
{
  const iRoot = path.join(TMP, 'ingestproj');
  fs.mkdirSync(path.join(iRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(iRoot, 'src/Panel.tsx'),
    ['export function Panel() {', '  return (', '    <aside className="panel">',
     '      <h3 className="panel-title">Details</h3>',
     '      <p className="panel-body">More</p>', '    </aside>', '  );', '}'].join('\n'));
  const qf = path.join(iRoot, '.ui-grab/queue.json');

  const out = ingest(iRoot, qf, [{
    id: 'm1', tag: 'h3', classes: 'panel-title', text: 'Details', attrs: {},
    selector: '.panel-title', route: '/', comment: 'these two should line up',
    also: [{ tag: 'p', classes: 'panel-body', text: 'More', attrs: {}, selector: '.panel-body', route: '/' }],
  }], {});

  ok('the batch lands in the queue', out.pending === 1 && out.items.length === 1);
  const item = readQueue(qf).items[0];
  ok('both elements were looked up',
    item.candidates.some((c) => c.el === 1) && item.candidates.some((c) => !c.el),
    JSON.stringify(item.candidates.map((c) => `${c.file}:${c.line}:${c.el || 0}`)));
  ok('the extra element survives the round trip', item.also.length === 1);
  ok('one block covers both, not two',
    Object.keys(readQueue(qf).sources).length <= 1, JSON.stringify(Object.keys(readQueue(qf).sources)));
  ok('nothing carries an inline source copy any more', !item.source);
  ok('what went out is on the ledger', readSent(iRoot).some((s) => s.id === 'm1'));

  // resolveAt: 'drain' — queue the pick bare, look it up when it is read
  clearQueue(qf);
  ingest(iRoot, qf, [{ id: 'd1', tag: 'h3', classes: 'panel-title', text: 'Details',
    attrs: {}, selector: '.panel-title', route: '/', comment: 'tighter' }],
    { resolve: false, source: false });
  ok('a bare pick queues with no candidates', !readQueue(qf).items[0].candidates);

  const payload = drainPayload(iRoot, qf, {});
  ok('draining resolves it against the files as they are now',
    payload.items[0].candidates.length > 0, JSON.stringify(payload.items[0].candidates));
  ok('and writes that back to the queue', !!readQueue(qf).items[0].candidates);

  const text = render(payload, { rel: '.ui-grab/queue.json' });
  ok('it renders for an agent with no slash commands',
    text.includes('1 UI item') && text.includes('panel-title') && text.includes('tighter'),
    text.split('\n')[0]);
  ok('and says how to finish', text.includes('empty the queue'));

  clearQueue(qf);
  ok('clearing empties it', readQueue(qf).items.length === 0);
  ok('an empty queue renders as a sentence, not a crash',
    render(drainPayload(iRoot, qf, {}), {}).includes('Nothing queued'));
}


// ---- 4n. the status stream ---------------------------------------------------
//
// Between Send and the edit, the browser is blind: it cannot see whether a
// session was found, whether it is working, or whether anything ever read the
// queue. The server can, and this is how it says so.
console.log('\nactivity log');
{
  const aRoot = path.join(TMP, 'activity');
  fs.mkdirSync(aRoot, { recursive: true });

  ok('an empty log reads as empty, not as a crash', readActivity(aRoot).events.length === 0);

  const first = emit(aRoot, 'queued', { n: 2, pending: 2 });
  const second = emit(aRoot, 'woke', { woke: true, via: 'tmux' });
  ok('events get monotonic sequence numbers', first.seq === 1 && second.seq === 2,
    `${first.seq}, ${second.seq}`);
  ok('and survive the round trip to disk',
    readActivity(aRoot).events.map((e) => e.kind).join(',') === 'queued,woke');

  const caught = sinceEvents(aRoot, 1);
  ok('a picker catching up gets only what it missed',
    caught.events.length === 1 && caught.events[0].kind === 'woke', JSON.stringify(caught));

  // 60 is the cap. A dev session left running all afternoon must not grow this
  // file without bound.
  for (let i = 0; i < 70; i++) emit(aRoot, 'session', { status: i % 2 ? 'busy' : 'idle' });
  const capped = readActivity(aRoot);
  ok('the log is a ring buffer, not a diary', capped.events.length === 60, String(capped.events.length));
  ok('and the sequence keeps counting past the cap', capped.seq === 72, String(capped.seq));
}

console.log('\nstatus hub');
{
  const hRoot = path.join(TMP, 'hub');
  fs.mkdirSync(path.join(hRoot, '.ui-grab'), { recursive: true });
  // No sessions to find: point discovery at a directory that does not exist, so
  // the poll is deterministic instead of depending on this machine.
  const hub = createHub(hRoot, { pollMs: 60, sessionPollMs: 60,
    sessionsDir: path.join(hRoot, 'no-sessions') });

  const seen = [];
  const off = hub.subscribe((e) => seen.push(e));
  emit(hRoot, 'holding', { seconds: 20 });
  await sleep(300);
  ok('a subscriber is handed events written by another process',
    seen.some((e) => e.kind === 'holding'), JSON.stringify(seen.map((e) => e.kind)));

  // The queue emptying is the only honest "the agent has been through this"
  // signal: /grab is Claude editing the file directly, so there is no command
  // anywhere to instrument.
  const hQueue = path.join(hRoot, '.ui-grab/queue.json');
  writeQueue(hQueue, { items: [{ id: 'h1', tag: 'button', comment: 'bigger' }], sources: {} });
  await sleep(200);
  writeQueue(hQueue, { items: [], sources: {} });
  await sleep(300);
  const applied = seen.find((e) => e.kind === 'applied');
  ok('the queue emptying is reported as the batch being applied', !!applied && applied.n === 1,
    JSON.stringify(seen.map((e) => e.kind)));

  writeAnswer(hRoot, 'h1', 'because the container is flex-start');
  await sleep(300);
  const answered = seen.find((e) => e.kind === 'answer');
  ok('an answer written by the agent reaches the browser',
    !!answered && answered.id === 'h1' && /flex-start/.test(answered.text),
    JSON.stringify(seen.map((e) => e.kind)));

  off();
  const quiet = seen.length;
  emit(hRoot, 'holding', { seconds: 5 });
  await sleep(250);
  ok('unsubscribing actually stops the watcher', seen.length === quiet,
    `${quiet} -> ${seen.length}`);
  hub.close();
}

// ---- 4o. questions instead of instructions -----------------------------------
console.log('\nask mode');
{
  const qRoot = path.join(TMP, 'ask');
  fs.mkdirSync(qRoot, { recursive: true });
  fs.writeFileSync(path.join(qRoot, 'index.html'),
    '<html><body>\n<h1 class="headline">Checkout</h1>\n</body></html>\n');
  const qQueue = path.join(qRoot, '.ui-grab/queue.json');

  const out = ingest(qRoot, qQueue, [
    { id: 'a1', tag: 'h1', classes: 'headline', text: 'Checkout', attrs: {},
      comment: 'make this bigger' },
    { id: 'a2', tag: 'h1', classes: 'headline', text: 'Checkout', attrs: {},
      kind: 'ask', comment: 'why is this not centred?' },
  ]);
  ok('a question is queued like anything else', out.pending === 2);
  ok('and keeps its kind through the queue file',
    readQueue(qQueue).items.filter(isAsk).length === 1);
  ok('a question still gets source candidates — it has to be answered from somewhere',
    (readQueue(qQueue).items.find(isAsk).candidates || []).length > 0);

  // Nothing about the element changes, so no verdict is ever coming. Scoring it
  // would leave the entry unresolved, and "unchanged" is how the map decides it
  // had been wrong about an element.
  const ids = readSent(qRoot).map((s) => s.id);
  ok('but it is kept out of the scoring ledger',
    ids.includes('a1') && !ids.includes('a2'), JSON.stringify(ids));

  const text = render(drainPayload(qRoot, qQueue), { rel: '.ui-grab/queue.json' });
  ok('the drain output marks it ASK', /ASK/.test(text));
  ok('and tells an agent how to answer it', text.includes('--answer a2'));

  ok('the wake prompt says a batch of questions is not a batch of edits',
    /answer every one of them without editing/.test(
      drainPrompt(1, '.ui-grab/queue.json', [{ kind: 'ask' }])));
  ok('and a mixed batch names both halves',
    /apply the changes and answer the 1 item/.test(
      drainPrompt(2, '.ui-grab/queue.json', [{ kind: 'ask' }, {}])));
  ok('a batch with no questions reads as it always did',
    /apply every item/.test(drainPrompt(2, '.ui-grab/queue.json', [{}, {}])));
  // The old text told the agent to reset the file to a v1 shape, which the
  // reader then hoisted back into v2 on the next read.
  ok('and the reset it asks for matches the file format we actually write',
    drainPrompt(1).includes('"version":2'));

  writeAnswer(qRoot, 'a2', 'The container is flex-start; use justify-content: center.');
  ok('an answer round-trips through disk',
    readAnswers(qRoot).answers[0].text.includes('justify-content'));
  writeAnswer(qRoot, 'a2', 'On reflection: text-align: center on the h1.');
  ok('answering twice replaces rather than stacks',
    readAnswers(qRoot).answers.length === 1 && /On reflection/.test(readAnswers(qRoot).answers[0].text));
}

// ---- 4m. the next.js adapter -------------------------------------------------
console.log('\nnext adapter');
{
  const nRoot = path.join(TMP, 'nextproj');
  fs.mkdirSync(nRoot, { recursive: true });
  const { GET, POST } = createHandlers({ root: nRoot, dev: true });
  const req = (url, init) => new Request('http://localhost:3000' + url, init);

  const pending = await (await GET(req('/__ui-grab/queue'))).json();
  ok('it answers the queue check', pending.ok && pending.pending === 0, JSON.stringify(pending));

  const posted = await POST(req('/__ui-grab/queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://localhost:3000',
               'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ items: [{ id: 'n1', tag: 'button', comment: 'bigger', attrs: {} }] }),
  }));
  ok('and takes a batch', (await posted.json()).added === 1);

  const evil = await POST(req('/__ui-grab/queue', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example',
               'sec-fetch-site': 'cross-site' },
    body: JSON.stringify({ items: [{ id: 'evil', comment: 'delete everything' }] }),
  }));
  ok('a cross-site POST is refused there too', evil.status === 403);

  const polled = await (await GET(req('/__ui-grab/events?since=0'))).json();
  ok('it serves the status log as a poll',
    polled.ok && polled.events.some((e) => e.kind === 'queued'),
    JSON.stringify(polled.events?.map((e) => e.kind)));

  // EventSource reconnects by re-requesting the URL it was opened with, so the
  // `since` on it is stale by then; Last-Event-ID is the current one.
  const resumed = await (await GET(req('/__ui-grab/events?since=0',
    { headers: { 'last-event-id': String(polled.seq) } }))).json();
  ok('a reconnect resumes from Last-Event-ID, not the stale URL',
    resumed.events.length === 0, JSON.stringify(resumed.events.map((e) => e.kind)));

  const streamed = await GET(req('/__ui-grab/events', { headers: { accept: 'text/event-stream' } }));
  ok('and as a stream when the browser asks for one',
    streamed.headers.get('content-type') === 'text/event-stream');
  {
    const reader = streamed.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value || new Uint8Array());
    ok('whose backlog replays what already happened', first.includes('retry:'), first.slice(0, 60));
    await reader.cancel();
  }

  const client = await GET(req('/__ui-grab/client.js'));
  ok('it serves the picker', (await client.text()).includes('window.__uiGrab'));

  const prod = createHandlers({ root: nRoot, dev: false });
  ok('and refuses to exist in a production build',
    (await prod.GET(req('/__ui-grab/queue'))).status === 404);
}

// ---- 5. bridge wiring --------------------------------------------------------
console.log('\nbridge');
const bridgeRoot = path.join(TMP, 'bridge');
fs.mkdirSync(bridgeRoot, { recursive: true });
saveConfig(bridgeRoot, { mode: 'off' });

const bridge = createBridge({ root: bridgeRoot, quiet: true, resolve: false, source: false });
const port = await bridge.listen([7391, 7392, 7393]);
const base = `http://127.0.0.1:${port}`;

const health = await (await fetch(`${base}/health`)).json();
ok('health reports the mode', health.config?.mode === 'off', JSON.stringify(health.config));

const set = await (await fetch(`${base}/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'wait', waitSeconds: 7 }),
})).json();
ok('POST /config changes the mode', set.ok && set.config.mode === 'wait' && set.config.waitSeconds === 7);
ok('and persists it for the hook to read', loadConfig(bridgeRoot).mode === 'wait');

const bad = await fetch(`${base}/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops',
});
ok('rejects malformed config', bad.status === 400);

const queued = await (await fetch(`${base}/queue`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 'q1', tag: 'button', comment: 'bigger' }] }),
})).json();
ok('queueing still works', queued.ok && queued.pending === 1);
ok('wait mode does not try to wake', queued.woke === null, JSON.stringify(queued.woke));

await fetch(`${base}/config`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ mode: 'wake' }),
});
const queued2 = await (await fetch(`${base}/queue`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items: [{ id: 'q2', tag: 'h1', comment: 'tighter' }] }),
})).json();
ok('wake mode reports what it tried', queued2.woke !== null && queued2.woke.via === 'none',
  JSON.stringify(queued2.woke));

// The extension cannot hold an EventSource open to a bridge on another origin,
// so it polls the same log instead.
const events = await (await fetch(`${base}/events?since=0`)).json();
ok('the bridge serves the status log too',
  events.ok && events.events.some((e) => e.kind === 'queued'),
  JSON.stringify(events.events?.map((e) => e.kind)));
ok('and a poll from where we left off returns nothing new',
  (await (await fetch(`${base}/events?since=${events.seq}`)).json()).events.length === 0);

const evilEvents = await fetch(`${base}/events`, {
  headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' },
});
ok('the origin gate covers the status log as well', evilEvents.status === 403,
  String(evilEvents.status));

const evilPost = await fetch(`${base}/queue`, {
  method: 'POST',
  headers: { 'content-type': 'text/plain', origin: 'https://evil.example',
             'sec-fetch-site': 'cross-site' },
  body: JSON.stringify({ items: [{ id: 'evil', tag: 'button', comment: 'delete everything' }] }),
});
ok('the bridge refuses a cross-site POST too', evilPost.status === 403, String(evilPost.status));
ok('and it never reached the queue',
  !bridge.readQueue().items.some((i) => i.id === 'evil'));

const evilHealth = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
ok('and cannot read the project path out of /health', evilHealth.status === 403);
ok('no wildcard CORS header is handed out',
  evilHealth.headers.get('access-control-allow-origin') === null,
  String(evilHealth.headers.get('access-control-allow-origin')));

const extHealth = await fetch(`${base}/health`, { headers: { origin: 'chrome-extension://abc' } });
ok('but the extension still can',
  extHealth.status === 200 &&
  extHealth.headers.get('access-control-allow-origin') === 'chrome-extension://abc',
  String(extHealth.headers.get('access-control-allow-origin')));

bridge.server.close();
closeHubs();
fs.rmSync(TMP, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
