// Answers to the questions in the queue.
//
// An `ask` item is a pick whose comment is a question rather than an
// instruction: "why is this 4px off?" The agent answers it in the terminal like
// any other question — and writes the answer here as well, so the picker can
// show it next to the element you asked about without you leaving the browser.
//
// The queue is instructions in; this is the reply out. Kept apart because the
// two have opposite lifetimes: the queue is emptied every drain, an answer is
// worth reading after it.
import fs from 'node:fs';
import path from 'node:path';

export const ANSWERS_VERSION = 1;
const MAX_ANSWERS = 50;
const MAX_TEXT = 4000;

export const answersPath = (root) => path.join(root, '.ui-grab/answers.json');

export function readAnswers(root) {
  try {
    const d = JSON.parse(fs.readFileSync(answersPath(root), 'utf8'));
    return { answers: Array.isArray(d.answers) ? d.answers : [] };
  } catch {
    return { answers: [] };
  }
}

let seq = 0;

/**
 * Record one answer. Answering the same id twice replaces the first, so an
 * agent that revises itself does not leave both versions on screen.
 */
export function writeAnswer(root, id, text) {
  if (!id || !text) return null;
  const answer = { id: String(id), text: String(text).slice(0, MAX_TEXT), at: Date.now() };
  const kept = readAnswers(root).answers.filter((a) => a.id !== answer.id);
  const answers = kept.concat(answer).slice(-MAX_ANSWERS);

  const file = answersPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${seq++}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: ANSWERS_VERSION, answers }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return answer;
}

export const isAsk = (item) => item && item.kind === 'ask';
