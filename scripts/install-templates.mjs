// Install the InDesign templates that the IDML export needs.
// They are ~57 MB of Adobe assets and are deliberately not committed.
//
// Sources, first match wins:
//   1. $TEMPLATES_SRC            (explicit path)
//   2. ../templates              (sibling Streamlit checkout)
//   3. ./templates               (already installed)
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname.replace(/[\\/]scripts$/, '');
const DEST = path.join(HERE, 'templates');

const candidates = [
  process.env.TEMPLATES_SRC,
  path.resolve(HERE, '..', 'templates'),
  DEST,
].filter(Boolean);

const looksValid = (dir) =>
  fs.existsSync(path.join(dir, 'BRS_Transportasi_Template Folder')) ||
  fs.existsSync(path.join(dir, 'BRS PARIWISATA PAPUA SELATAN Template'));

let source = null;
for (const dir of candidates) {
  if (fs.existsSync(dir) && looksValid(dir)) { source = dir; break; }
}

if (!source) {
  console.error('Templates not found. Looked in:');
  for (const dir of candidates) console.error('  -', dir);
  console.error('\nSet TEMPLATES_SRC to the folder that contains:');
  console.error('  BRS_Transportasi_Template Folder/');
  console.error('  BRS PARIWISATA PAPUA SELATAN Template/');
  process.exit(1);
}

if (path.resolve(source) === path.resolve(DEST)) {
  console.log('Templates already installed at', DEST);
  process.exit(0);
}

console.log(`Copying templates\n  from ${source}\n  to   ${DEST}`);
fs.cpSync(source, DEST, { recursive: true });

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full); else files.push(full);
  }
})(DEST);

const bytes = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
console.log(`Installed ${files.length} files (${(bytes / 1e6).toFixed(1)} MB)`);
