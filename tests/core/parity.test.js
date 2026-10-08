// Guards against the JavaScript copy of a rule drifting away from the database's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { QUESTION_TYPES } from '../../supabase/functions/_shared/core/constants.js';
import { diffCore } from '../../scripts/sync-core.mjs';

test('question types in JavaScript match migration 0004 exactly', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/0004_reference_data.sql', import.meta.url), 'utf8');
  const rows = [...sql.matchAll(/\('(\w+)',\s*'([^']+)',\s*'(\w+)',\s*(\d+),\s*(\d+),\s*(true|false),\s*(\d+)\)/g)];
  assert.equal(rows.length, Object.keys(QUESTION_TYPES).length);
  for (const [, code, label, kind, min, max, ctx, order] of rows) {
    assert.deepEqual(QUESTION_TYPES[code], { label, kind, minOptions: +min, maxOptions: +max, requiresContext: ctx === 'true', sortOrder: +order }, code);
  }
});

test('the browser copy of the core modules is in sync', () => {
  assert.deepEqual(diffCore(), [], 'run: node scripts/sync-core.mjs');
});

test('no secret-looking values are committed in source files', () => {
  const files = ['supabase/functions/_shared/core/ai/gemini.js', 'supabase/functions/_shared/handlers/extract.js'];
  for (const f of files) assert.doesNotMatch(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'), /AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}/);
});
