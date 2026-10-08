#!/usr/bin/env node
// The browser cannot import files from supabase/functions (and Supabase only bundles files inside
// supabase/functions), so the shared "core" modules live in supabase/functions/_shared/core and are
// COPIED to web/js/core. One source of truth, no build tools.
//
//   node scripts/sync-core.mjs          copy (run after editing core files)
//   node scripts/sync-core.mjs --check  fail if the copy is stale (used by the tests)
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'supabase/functions/_shared/core');
const DEST = join(root, 'web/js/core');

function list(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? list(join(dir, e.name)) : [join(dir, e.name)]);
}

export function diffCore() {
  const src = list(SRC).map((f) => relative(SRC, f)).sort();
  const dest = existsSync(DEST) ? list(DEST).map((f) => relative(DEST, f)).sort() : [];
  const problems = [];
  for (const f of src) {
    if (!dest.includes(f)) problems.push(`missing in web/js/core: ${f}`);
    else if (!readFileSync(join(SRC, f)).equals(readFileSync(join(DEST, f)))) problems.push(`out of date: ${f}`);
  }
  for (const f of dest) if (!src.includes(f)) problems.push(`stale extra file in web/js/core: ${f}`);
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    const problems = diffCore();
    if (problems.length) { console.error(`web/js/core is not in sync:\n  ${problems.join('\n  ')}\nRun: node scripts/sync-core.mjs`); process.exit(1); }
    console.log('web/js/core is in sync.');
  } else {
    rmSync(DEST, { recursive: true, force: true });
    mkdirSync(DEST, { recursive: true });
    cpSync(SRC, DEST, { recursive: true });
    console.log(`Copied ${list(SRC).length} files to web/js/core`);
  }
}
