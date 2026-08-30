#!/usr/bin/env node
// Builds site/index.html by dropping the real picker into site/template.html.
//
// The page demos the picker by running it, so it has to be the same file the
// plugin serves — pasting a copy in would let the two drift, which is the one
// thing extension/picker.js exists to prevent.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const picker = fs.readFileSync(path.join(HERE, '../extension/picker.js'), 'utf8');

if (picker.includes('</script')) {
  throw new Error('picker.js contains a </script — it cannot be inlined as raw text');
}

const template = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
if (!template.includes('__PICKER_SOURCE__')) {
  throw new Error('template.html has no __PICKER_SOURCE__ placeholder');
}

const page = template.replace('__PICKER_SOURCE__', () => picker);

// The template is a document *fragment* — no doctype, no <html> — because that
// is what an Artifact publish wants. A file served from GitHub Pages needs the
// doctype, or the browser parses it in quirks mode.
const out = path.join(HERE, 'index.html');
fs.writeFileSync(out, `<!doctype html>\n<html lang="en">\n${page}\n</html>\n`);
console.log(`site/index.html  ${(fs.statSync(out).size / 1024).toFixed(1)} KB  (picker ${(picker.length / 1024).toFixed(1)} KB)`);

// The fragment, for publishing as an Artifact.
if (process.argv.includes('--fragment')) {
  const frag = process.argv[process.argv.indexOf('--fragment') + 1];
  fs.writeFileSync(frag, page);
  console.log(`${frag}  fragment written`);
}
