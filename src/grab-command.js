export const GRAB_COMMAND = `---
description: Apply the UI changes queued from the browser by ui-grab
---

Read \`.ui-grab/queue.json\` in the project root.

For each entry in \`items\`, apply the change described in its \`comment\` to the
element it points at. When you are done, overwrite the file with
\`{"version":2,"items":[],"sources":{}}\`.

Notes:
- \`candidates\` are ranked pointers at where the element is written, best first.
  \`matchedBy\` says how each was found. \`map\` and \`react\` are confirmed
  readings rather than guesses; \`text\`, \`id\` and the class matches are grep
  hits. A single confident candidate means the lookup was sure — open the file
  and work from there.
- \`sourceRefs\` are keys into the top-level \`sources\` map, which holds the
  enclosing declaration for the candidates that were *not* confident. Each block
  records \`lines\`, \`hitLine\` and a \`sha\` of the file as it was **when the item
  was queued** — possibly hours ago. Treat it as orientation, not as something
  to patch against. Re-read the file before editing.
- The best hit is frequently the JSX call site while the real change belongs in
  a shared component, a stylesheet or a token file. Check before editing.
- \`also\` means the comment is about several elements at once ("these should
  line up"). Apply it to the group.
- Prefer coherent edits over one patch per item. If four items all say "tighter",
  change the spacing scale once rather than four times.
- \`styles\` is the computed style at pick time, so it tells you what the element
  actually rendered as, not what the source asked for.
- \`ancestors\` and \`children\` are there because half of "make this bigger" is
  really a question about the parent layout.
- \`screenshot\`, when present, is a cropped image of the element on disk. Open
  it if the comment is about how something looks.
- If the queue is empty, say so and stop.

The browser is watching. After you edit, it re-measures every element it sent
and reports which ones actually changed, so an edit in the wrong place shows up
as "unchanged" rather than passing silently.
`;

/** Same instructions, for an agent that has no slash commands. */
export const AGENTS_SECTION = `## ui-grab

UI changes picked in the browser land in \`.ui-grab/queue.json\`.

Run \`npx ui-grab-drain\` to print them, apply each one, then run
\`npx ui-grab-drain --clear\`. \`--fresh\` re-resolves every pointer against the
files as they are right now, which is worth doing if the queue has been sitting.

Candidates are ranked guesses at where an element is written, which is often not
where its styling lives. Read the file before editing.
`;
