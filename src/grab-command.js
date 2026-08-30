export const GRAB_COMMAND = `---
description: Apply the UI changes queued from the browser by ui-grab
---

Read \`.ui-grab/queue.json\` in the project root.

For each entry in \`items\`, apply the change described in its \`comment\` to the
element it points at. When you are done, overwrite the file with
\`{"version":1,"items":[]}\`.

Notes:
- \`source\` carries the enclosing declaration for the best one or two
  candidates, each with \`file\`, \`lines\`, \`hitLine\` and a \`sha\` of the file as
  it was **when the item was queued**. That may be minutes or hours before you
  read it. Treat it as orientation: it tells you what the code looked like and
  where to go. Re-read the file before editing — never patch against the
  embedded snapshot.
- \`candidates\` are grep hits for the element's own text / id / class names,
  ranked best-first. They are a starting point, not gospel — the styling often
  lives one or two hops away (a shared component, a design token, a stylesheet).
  The best hit is frequently the JSX call site while the real change belongs in
  a data file or a shared component — check every block in \`source\` before
  deciding where to edit.
- Prefer coherent edits over one patch per item. If four items all say "tighter",
  change the spacing scale once rather than four times.
- \`styles\` is the computed style at pick time, so it tells you what the element
  actually rendered as, not what the source asked for.
- \`ancestors\` and \`children\` are there because half of "make this bigger" is
  really a question about the parent layout.
- If the queue is empty, say so and stop.
`;
