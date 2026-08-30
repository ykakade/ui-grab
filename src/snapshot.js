// A restore point per batch, so "that made it worse" is one click.
//
// `git stash create` writes a commit object for the current working tree
// without touching the tree or the stash list, which is exactly what a restore
// point wants to be: free to take, invisible until used. On a clean tree it
// returns nothing and HEAD is already the restore point.
//
// Untracked files are not in it. A revert therefore restores files that existed
// when the batch was sent and leaves brand-new ones alone, which is the safer
// half of the tradeoff.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_BATCHES = 40;
const ledgerPath = (root) => path.join(root, '.ui-grab/batches.json');

const git = (root, args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

export function isRepo(root) {
  try { return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; }
}

export function readBatches(root) {
  try {
    const d = JSON.parse(fs.readFileSync(ledgerPath(root), 'utf8'));
    return Array.isArray(d.batches) ? d.batches : [];
  } catch { return []; }
}

function writeBatches(root, batches) {
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, batches: batches.slice(-MAX_BATCHES) }, null, 2) + '\n');
}

/**
 * Take a restore point for a batch about to be queued.
 * @returns {{id: string, commit: string|null}|null}
 */
export function snapshot(root, { items = 0, label = '' } = {}) {
  if (!isRepo(root)) return null;
  let commit = null;
  try {
    commit = git(root, ['stash', 'create']) || git(root, ['rev-parse', 'HEAD']);
  } catch {
    return null; // a repo with no commits yet has nothing to restore to
  }
  if (!commit) return null;

  const id = 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const batches = readBatches(root);
  batches.push({ id, commit, at: new Date().toISOString(), items, label });
  writeBatches(root, batches);
  return { id, commit };
}

/** Files that changed since a restore point was taken. */
export function changedSince(root, commit) {
  try {
    return git(root, ['diff', '--name-only', commit, '--']).split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * Put the files a batch touched back the way they were.
 *
 * This overwrites current file contents, so it takes its own restore point
 * first — reverting a revert is the one thing you should never have to do by
 * hand. Files created since the batch are left alone; git has no record of what
 * they were, and deleting them is not this tool's call.
 */
export function revert(root, batchId, { dryRun = false } = {}) {
  if (!isRepo(root)) return { ok: false, error: 'not a git repository' };
  const batches = readBatches(root);
  const batch = batchId ? batches.find((b) => b.id === batchId) : batches[batches.length - 1];
  if (!batch) return { ok: false, error: batchId ? `no batch ${batchId}` : 'no batch to revert' };

  const files = changedSince(root, batch.commit);
  if (!files.length) return { ok: true, batch: batch.id, files: [], undo: null, note: 'nothing changed since that batch' };
  if (dryRun) return { ok: true, batch: batch.id, files, undo: null, dryRun: true };

  const undo = snapshot(root, { label: `undo of ${batch.id}` });
  try {
    // `restore` touches the working tree and leaves the index alone. Older git
    // has only `checkout`, which also stages what it restores.
    try { git(root, ['restore', '--source', batch.commit, '--worktree', '--', ...files]); }
    catch { git(root, ['checkout', batch.commit, '--', ...files]); }
  } catch (e) {
    return { ok: false, error: `restore failed: ${e.message}` };
  }
  return { ok: true, batch: batch.id, files, undo: undo && undo.id };
}
