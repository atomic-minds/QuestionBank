import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveClassification, resolveExamRef, suggest } from '../../supabase/functions/_shared/core/taxonomy.js';
import { index } from './fixtures.js';

const idx = index();

test('exact names resolve regardless of case, punctuation, slug or code', () => {
  for (const given of [
    { subject: 'Chemistry', chapter: 'Solid State', topic: 'Crystal Structure' },
    { subject: 'chemistry', chapter: 'solid  state', topic: 'crystal-structure' },
    { subject: 'CHEM', chapter: 'solid-state', topic: 'CRYSTAL STRUCTURE' },
  ]) {
    const r = resolveClassification(idx, given);
    assert.deepEqual([r.subject_id, r.chapter_id, r.topic_id, r.errors.length], [1, 10, 100, 0], JSON.stringify(given));
  }
  assert.equal(resolveClassification(idx, { subject: 'Chemistry', chapter: 'Alcohols & Phenols and Ethers' }).errors.length, 1, '& vs "," differ here: names must match exactly after normalisation');
  assert.equal(resolveClassification(idx, { subject: 'Chemistry', chapter: 'alcohols phenols and ethers' }).chapter_id, 11);
});

test('near misses are never assigned, only suggested', () => {
  const r = resolveClassification(idx, { subject: 'Chemistry', chapter: 'Solid Stat' });
  assert.equal(r.chapter_id, null);
  assert.equal(r.errors[0].path, 'chapter_id');
  assert.deepEqual(r.unresolved.chapter.suggestions.map((s) => s.name), ['Solid State']);
  assert.match(r.errors[0].message, /Did you mean: "Solid State"/);
});

test('a chapter must belong to the stated subject', () => {
  const r = resolveClassification(idx, { subject: 'Physics', chapter: 'Solid State' });
  assert.equal(r.chapter_id, null);
  assert.ok(r.errors.some((e) => e.path === 'chapter_id'));
});

test('without a subject, a chapter is inferred only when unambiguous', () => {
  const ok = resolveClassification(idx, { chapter: 'Solid State' });
  assert.deepEqual([ok.subject_id, ok.chapter_id], [1, 10]);
  assert.equal(ok.warnings.length, 1);
  const ambiguous = resolveClassification(idx, { chapter: 'Thermodynamics' });
  assert.equal(ambiguous.chapter_id, null);
  assert.ok(ambiguous.errors.length >= 1);
});

test('an unknown topic is a warning (topic is optional) and leaves the topic empty', () => {
  const r = resolveClassification(idx, { subject: 'Chemistry', chapter: 'Solid State', topic: 'Crystal Struct' });
  assert.equal(r.topic_id, null);
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.equal(r.unresolved.topic.suggestions[0].name, 'Crystal Structure');
});

test('defaults only fill what the source did not mention', () => {
  const d = { subject_id: 1, chapter_id: 10, topic_id: 101 };
  const r = resolveClassification(idx, {}, d);
  assert.deepEqual([r.subject_id, r.chapter_id, r.topic_id, r.errors.length], [1, 10, 101, 0]);
  const over = resolveClassification(idx, { subject: 'Physics', chapter: 'Optics' }, d);
  assert.deepEqual([over.subject_id, over.chapter_id, over.topic_id], [2, 21, null]);
  assert.ok(resolveClassification(idx, {}).errors.length >= 1);
});

test('suggest ranks close names and ignores unrelated ones', () => {
  const s = suggest(index().tree[0].chapters, 'Thermodynamic');
  assert.equal(s[0].name, 'Thermodynamics');
  assert.deepEqual(suggest(index().tree[0].chapters, 'zzzz qqq'), []);
});

test('exam references: names, codes, objects, trailing year, unknown', () => {
  assert.equal(resolveExamRef(idx, 'JEE Main').exam_id, 2);
  assert.equal(resolveExamRef(idx, 'jee_main').exam_id, 2);
  const withYear = resolveExamRef(idx, 'JEE Main 2019');
  assert.deepEqual([withYear.exam_id, withYear.year], [2, 2019]);
  const obj = resolveExamRef(idx, { exam: 'CBSE', year: '2025', paper: 'Set 1' });
  assert.deepEqual([obj.exam_id, obj.year, obj.paper], [1, 2025, 'Set 1']);
  const bad = resolveExamRef(idx, 'JEE Mains');
  assert.equal(bad.exam_id, null);
  assert.equal(bad.suggestions[0].name, 'JEE Main');
  assert.equal(resolveExamRef(idx, {}).exam_id, null);
});
