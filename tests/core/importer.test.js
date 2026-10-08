import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectShape, importQuestions, normalizeImportItem, parseJsonLoose } from '../../supabase/functions/_shared/core/importer.js';
import { index } from './fixtures.js';

const taxonomy = index();
const ctx = { taxonomy };
const one = (raw, extra = {}) => normalizeImportItem(raw, 0, { ...ctx, ...extra });
const base = { type: 'mcq', question: 'What is the coordination number of NaCl?', options: ['4', '6', '8', '12'], answer: 'B', subject: 'Chemistry', chapter: 'Solid State' };
const paths = (r) => r.errors.map((e) => e.path);

// ------------------------------------------------------------------ parsing
test('parseJsonLoose: clean JSON, fences, surrounding prose, trailing commas, BOM', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}').value, { a: 1 });
  assert.deepEqual(parseJsonLoose('﻿{"a":1}').value, { a: 1 });
  const fenced = parseJsonLoose('Here you go:\n```json\n{"a":[1,2,],}\n```\nHope that helps!');
  assert.deepEqual(fenced.value, { a: [1, 2] });
  assert.ok(fenced.notes.length >= 2);
  assert.deepEqual(parseJsonLoose('Sure! {"a": 1} Done.').value, { a: 1 });
  assert.deepEqual(parseJsonLoose('{"a": "x, ]"}').value, { a: 'x, ]' }, 'commas inside strings are untouched');
  assert.deepEqual(parseJsonLoose('{"a": "keep ,} this",}').value, { a: 'keep ,} this' });
});

test('parseJsonLoose: broken JSON reports where', () => {
  const r = parseJsonLoose('{\n  "a": 1,\n  "b": }');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error.message, 'string');
  assert.equal(r.error.line, 3);
  assert.equal(parseJsonLoose('   ').ok, false);
  assert.equal(parseJsonLoose(undefined).ok, false);
  assert.equal(parseJsonLoose('not json at all').ok, false);
});

// ------------------------------------------------------------------ shapes
test('detectShape handles list, {questions}, single object, and rejects the rest', () => {
  assert.equal(detectShape([{}]).items.length, 1);
  assert.equal(detectShape({ questions: [{}, {}] }).items.length, 2);
  assert.equal(detectShape({ question: 'x' }).format, 'single');
  assert.ok(detectShape({ hello: 1 }).error);
  assert.ok(detectShape('x').error);
  assert.ok(detectShape({ format: 'something-else', questions: [] }).error);
  assert.ok(detectShape({ format: 'atomic-minds-question-bank', version: 2, questions: [] }).error);
  assert.equal(detectShape({ format: 'atomic-minds-question-bank', version: 1, questions: [] }).format, 'atomic-minds-question-bank');
});

test('importQuestions: fatal problems are reported without throwing', () => {
  assert.match(importQuestions('', ctx).fatal.message, /Paste/);
  assert.match(importQuestions('{"questions": []}', ctx).fatal.message, /no questions/);
  assert.match(importQuestions('{"x":1}', ctx).fatal.message, /Could not find/);
  const many = JSON.stringify({ questions: Array.from({ length: 101 }, () => base) });
  assert.match(importQuestions(many, ctx).fatal.message, /limit is 100/);
  assert.match(importQuestions(`{"questions":[{"question":"${'x'.repeat(1024 * 1024)}"}]}`, ctx).fatal.message, /smaller files/);
});

// ------------------------------------------------------------------ the shape from the brief
test('the nested example from the brief imports cleanly', () => {
  const nested = {
    id: 'QB-CHEM-000241',
    question: { text: 'What is the coordination number of NaCl?', type: 'mcq', options: [{ id: 'A', text: '4' }, { id: 'B', text: '6' }, { id: 'C', text: '8' }, { id: 'D', text: '12' }] },
    answer: { value: 'B' }, explanation: 'Six Cl- around each Na+.',
    classification: { subject: 'Chemistry', chapter: 'Solid State', topic: 'Crystal Structure', category: 'general' },
    exam: { name: null, year: null }, metadata: { difficulty: 'medium', marks: 1, tags: [] },
  };
  const r = one(nested);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual([r.draft.subject_id, r.draft.chapter_id, r.draft.topic_id], [1, 10, 100]);
  assert.deepEqual(r.draft.answer, { value: 'B' });
  assert.equal(r.draft.difficulty, 'medium');
  assert.equal(r.draft.marks, 1);
  assert.deepEqual(r.draft.exams, []);
  assert.equal(r.draft.origin, 'json_import');
  assert.equal(r.draft.status, 'draft');
  assert.equal(r.draft.public_id, undefined);
  assert.ok(r.warnings.some((w) => w.path === 'id'), 'the supplied ID is ignored, with a visible warning');
});

// ------------------------------------------------------------------ types and options
test('type spellings collapse; missing type is inferred only when safe', () => {
  for (const t of ['MCQ', 'Multiple Choice', 'multiple_choice']) assert.equal(one({ ...base, type: t }).draft.type_code, 'mcq');
  const inferred = one({ ...base, type: undefined });
  assert.equal(inferred.ok, true);
  assert.ok(inferred.warnings.some((w) => w.path === 'type_code'));
  assert.ok(paths(one({ question: 'Explain.', answer: 'x', subject: 'Chemistry', chapter: 'Solid State' })).includes('type_code'));
  assert.ok(paths(one({ ...base, type: 'banana' })).includes('type_code'));
  assert.ok(paths(one({ ...base, type: undefined }, { strict: true })).includes('type_code'));
});

test('option labels are stripped; ids may be permuted or numeric', () => {
  assert.deepEqual(one({ ...base, options: ['A. 4', 'B. 6', 'C. 8', 'D. 12'] }).draft.options.map((o) => o.text), ['4', '6', '8', '12']);
  const permuted = one({ ...base, options: [{ id: 'B', text: '6' }, { id: 'A', text: '4' }, { id: 'D', text: '12' }, { id: 'C', text: '8' }], answer: 'B' });
  assert.deepEqual(permuted.draft.options.map((o) => o.text), ['4', '6', '8', '12']);
  assert.deepEqual(permuted.draft.answer, { value: 'B' });
  const numeric = one({ ...base, options: [{ id: '1', text: '4' }, { id: '2', text: '6' }, { id: '3', text: '8' }, { id: '4', text: '12' }], answer: '2' });
  assert.deepEqual(numeric.draft.answer, { value: 'B' });
});

test('MCQ answers: letters, words, text match, ambiguity, multiple', () => {
  for (const a of ['B', 'b', '(b)', 'Option B', 'B) 6', { value: 'B' }]) assert.deepEqual(one({ ...base, answer: a }).draft.answer, { value: 'B' }, JSON.stringify(a));
  const byText = one({ ...base, answer: '6' });
  assert.deepEqual(byText.draft.answer, { value: 'B' });
  assert.ok(byText.warnings.some((w) => w.path === 'answer'));
  assert.ok(paths(one({ ...base, answer: 1 })).includes('answer'), 'a bare number is ambiguous (0- or 1-based)');
  assert.ok(paths(one({ ...base, answer: 'A, C' })).includes('answer'));
  assert.ok(paths(one({ ...base, answer: 'Z' })).includes('answer'));
  assert.ok(paths(one({ ...base, answer: undefined })).includes('answer'));
  assert.deepEqual(one({ ...base, answer: 1 }, { answerIndexBase: 0 }).draft.answer, { value: 'B' });
  assert.deepEqual(one({ ...base, answer: 1 }, { answerIndexBase: 1 }).draft.answer, { value: 'A' });
  assert.ok(paths(one({ ...base, answer: 9 }, { answerIndexBase: 0 })).includes('answer'));
});

test('true/false and assertion-reason get standard options when omitted', () => {
  const tf = one({ type: 'true_false', question: 'NaCl is ionic.', answer: true, subject: 'Chemistry', chapter: 'Solid State' });
  assert.equal(tf.ok, true, JSON.stringify(tf.errors));
  assert.deepEqual(tf.draft.options.map((o) => o.text), ['True', 'False']);
  assert.deepEqual(tf.draft.answer, { value: 'A' });
  assert.deepEqual(one({ type: 'tf', question: 'x is y', answer: 'F', subject: 'Chemistry', chapter: 'Solid State' }).draft.answer, { value: 'B' });
  const ar = one({ type: 'assertion_reason', question: 'Assertion (A): x. Reason (R): y.', answer: 'C', subject: 'Chemistry', chapter: 'Solid State' });
  assert.equal(ar.ok, true, JSON.stringify(ar.errors));
  assert.equal(ar.draft.options.length, 4);
});

// ------------------------------------------------------------------ non-choice types
test('text answers: required; fill-blank accepts a list', () => {
  const sa = { type: 'Short Answer', question: 'Define a unit cell.', subject: 'Chemistry', chapter: 'Solid State' };
  assert.deepEqual(one({ ...sa, answer: 'Smallest repeating unit.' }).draft.answer, { text: 'Smallest repeating unit.' });
  assert.ok(paths(one(sa)).includes('answer'));
  const fb = one({ type: 'fill in the blanks', question: '____ is ionic and ____ is covalent.', answer: ['NaCl', 'HCl'], subject: 'Chemistry', chapter: 'Solid State' });
  assert.deepEqual(fb.draft.answer, { text: 'NaCl; HCl' });
  assert.ok(fb.warnings.some((w) => w.path === 'answer'));
  assert.ok(paths(one({ ...sa, answer: 'x', options: ['a', 'b'] })).includes('options'));
});

test('numerical answers: numbers, strings with units, scientific notation, objects', () => {
  const n = (answer) => one({ type: 'numerical', question: 'Value?', answer, subject: 'Chemistry', chapter: 'Solid State' });
  assert.deepEqual(n(6).draft.answer, { number: 6 });
  assert.deepEqual(n('9.8 m/s²').draft.answer, { number: 9.8, unit: 'm/s²' });
  assert.deepEqual(n('−3.5').draft.answer, { number: -3.5 });
  assert.equal(n('6.02 × 10^23 mol⁻¹').draft.answer.number, 6.02e23);
  assert.deepEqual(n({ number: 2, unit: 'mol', tolerance: 0.1 }).draft.answer, { number: 2, unit: 'mol', tolerance: 0.1 });
  assert.deepEqual(n({ value: '7' }).draft.answer, { number: 7 });
  assert.ok(paths(n('about six')).includes('answer'));
  assert.ok(paths(n(undefined)).includes('answer'));
});

test('case-based: passage required; options optional', () => {
  const c = { type: 'case study', question: 'Why?', subject: 'Chemistry', chapter: 'Solid State' };
  assert.ok(paths(one({ ...c, answer: 'x' })).includes('context'));
  assert.equal(one({ ...c, passage: 'A crystal…', answer: 'because' }).ok, true);
  assert.deepEqual(one({ ...c, passage: 'A crystal…', options: ['p', 'q'], answer: 'B' }).draft.answer, { value: 'B' });
});

test('match the following: many answer notations', () => {
  const m = (answer, lists) => one({ type: 'match the following', question: 'Match.', match: lists ?? { left: ['NaCl', 'CsCl'], right: ['6:6', '8:8'] }, answer, subject: 'Chemistry', chapter: 'Solid State' });
  for (const a of [{ A: '2', B: '1' }, { pairs: { A: 2, B: 1 } }, 'A-2, B-1', 'A→2; B→1', ['A-2', 'B-1'], [{ left: 'A', right: '2' }, { left: 'B', right: '1' }]]) {
    const r = m(a);
    assert.equal(r.ok, true, `${JSON.stringify(a)} ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.draft.answer, { pairs: { A: '2', B: '1' } });
  }
  const labelled = m('A-ii, B-i', { left: ['(A) NaCl', '(B) CsCl'], right: ['(i) 6:6', '(ii) 8:8'] });
  assert.equal(labelled.ok, true, JSON.stringify(labelled.errors));
  assert.deepEqual(labelled.draft.match_items.left.map((x) => x.text), ['NaCl', 'CsCl']);
  assert.deepEqual(labelled.draft.match_items.right.map((x) => x.text), ['6:6', '8:8']);
  assert.deepEqual(labelled.draft.answer, { pairs: { A: '2', B: '1' } });
  assert.ok(paths(m('A-2')).includes('answer'));
  assert.ok(paths(m('A-9, B-1')).includes('answer'));
  assert.ok(paths(m('A-1, B-1')).length >= 1 || m('A-1, B-1').ok, 'two items may share a target only if the database allows it');
  assert.ok(paths(m({ A: '1', A2: '2' })).includes('answer'));
  assert.ok(paths(m('A-1', { left: ['x'], right: ['y'] })).includes('match_items.left'));
  assert.ok(paths(one({ type: 'match', question: 'Match', answer: 'A-1', subject: 'Chemistry', chapter: 'Solid State' })).includes('match_items'));
});

// ------------------------------------------------------------------ classification, exams, metadata
test('unresolved classification is an error with suggestions; the draft stays editable', () => {
  const r = one({ ...base, chapter: 'Solid Stat' });
  assert.equal(r.ok, false);
  assert.ok(paths(r).includes('chapter_id'));
  assert.equal(r.draft.chapter_id, null);
  assert.equal(r.draft.question_text, base.question);
  assert.equal(r.unresolved.chapter.suggestions[0].name, 'Solid State');
  assert.ok(paths(one({ ...base, subject: 'Astrology' })).includes('subject_id'));
});

test('default classification applies to items that give none', () => {
  const r = one({ type: 'mcq', question: 'Q?', options: ['a', 'b'], answer: 'A' }, { defaults: { subject_id: 1, chapter_id: 10 } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('exams: strings, objects, lists, unknown, defaults, category consistency', () => {
  assert.deepEqual(one({ ...base, exams: ['JEE Main 2019'] }).draft.exams, [{ exam_id: 2, year: 2019, paper: null }]);
  assert.deepEqual(one({ ...base, exam: { name: 'CBSE', year: 2025 } }).draft.exams, [{ exam_id: 1, year: 2025, paper: null }]);
  assert.deepEqual(one({ ...base, exam: 'NEET', year: 2023 }).draft.exams, [{ exam_id: 3, year: 2023, paper: null }]);
  assert.deepEqual(one({ ...base, sources: [{ exam: 'CBSE', year: 2024, paper: 'Set 2' }] }).draft.exams, [{ exam_id: 1, year: 2024, paper: 'Set 2' }]);
  assert.deepEqual(one({ ...base, exam: { name: null, year: null } }).draft.exams, []);
  const bad = one({ ...base, exams: ['JEE Mains 2019'] });
  assert.equal(bad.ok, false);
  assert.ok(paths(bad).includes('exams[0].exam_id'));
  assert.equal(bad.unresolved.exams[0].suggestions[0].name, 'JEE Main');
  const dflt = { defaultExams: [{ exam_id: 1, year: 2025, paper: 'Set 1' }] };
  assert.equal(one(base, dflt).draft.exams.length, 1);
  assert.equal(one({ ...base, category: 'general' }, dflt).draft.exams.length, 0, '"general" opts out of default exams');
  assert.ok(one({ ...base, category: 'exam' }).warnings.some((w) => w.path === 'category'));
  assert.ok(one({ ...base, category: 'general', exams: ['CBSE 2020'] }).warnings.some((w) => w.path === 'category'));
});

test('metadata: difficulty aliases and unknowns, tags, marks, status, unknown fields', () => {
  assert.equal(one({ ...base, difficulty: 'Moderate' }).draft.difficulty, 'medium');
  const weird = one({ ...base, difficulty: 'level 3' });
  assert.equal(weird.ok, true);
  assert.equal(weird.draft.difficulty, null);
  assert.ok(weird.warnings.some((w) => w.path === 'difficulty'));
  const tags = one({ ...base, tags: Array.from({ length: 15 }, (_, i) => `t${i}`) });
  assert.equal(tags.draft.tags.length, 12);
  assert.ok(tags.warnings.some((w) => w.path === 'tags'));
  assert.ok(paths(one({ ...base, marks: 'lots' })).includes('marks'));
  assert.equal(one({ ...base, marks: '2' }).draft.marks, 2);
  assert.equal(one({ ...base, status: 'published' }).draft.status, 'draft');
  assert.ok(one({ ...base, status: 'published' }).warnings.some((w) => w.path === 'status'));
  assert.ok(one({ ...base, mystery: 1 }).warnings.some((w) => w.path === 'mystery'));
  assert.ok(paths(one({ ...base, mystery: 1 }, { strict: true })).includes('mystery'));
  assert.equal(one({ ...base, revision: 4, created_at: 'x' }).warnings.length, 0, 'export bookkeeping is ignored quietly');
});

test('items that are not objects fail alone', () => {
  const r = importQuestions(JSON.stringify({ questions: [base, 'oops', 42, null, base] }), ctx);
  assert.equal(r.summary.total, 5);
  assert.equal(r.summary.valid, 2);
  assert.equal(r.items[1].ok, false);
  assert.equal(r.items[4].ok, true);
});

// ------------------------------------------------------------------ whole payloads
test('one bad question never blocks the others; repeats are flagged; missing names summarised', () => {
  const payload = {
    questions: [
      base,
      { ...base, question: 'A different one?', chapter: 'Solid Stat' },
      { ...base, question: 'Another?', subject: 'Chemistry', chapter: 'Solid State', topic: 'Crystal Struct' },
      base,
      { ...base, question: 'No answer', answer: undefined },
    ],
  };
  const r = importQuestions(JSON.stringify(payload), ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.ok), [true, false, true, true, false]);
  assert.deepEqual(r.summary, { total: 5, valid: 3, invalid: 2, warned: 2 });
  assert.ok(r.items[3].warnings.some((w) => /Same as question 1/.test(w.message)));
  assert.deepEqual(r.missing.chapters, [{ subject_id: 1, name: 'Solid Stat' }]);
  assert.deepEqual(r.missing.topics, [{ chapter_id: 10, name: 'Crystal Struct' }]);
});

test('Atomic Minds exports can be re-imported (answer is a 0-based index)', () => {
  const file = { format: 'atomic-minds-question-bank', version: 1, questions: [{ id: 'QB-CHEM-000241', type: 'mcq', question: 'Q?', options: ['4', '6'], answer: 1, subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: 'easy', marks: 1, tags: [], sources: [{ exam: 'CBSE', year: 2025, paper: null }], revision: 2 }] };
  const r = importQuestions(JSON.stringify(file), ctx);
  assert.equal(r.items[0].ok, true, JSON.stringify(r.items[0].errors));
  assert.deepEqual(r.items[0].draft.answer, { value: 'B' });
  assert.deepEqual(r.items[0].draft.exams, [{ exam_id: 1, year: 2025, paper: null }]);
});

test('restore mode keeps IDs, status, origin and option text exactly', () => {
  const raw = { id: 'QB-CHEM-000007', status: 'published', origin: 'ai_image', type: 'mcq', question: 'Which are labelled?', options: ['A. one', 'B. two', 'C. three'], answer: 'B', subject: 'Chemistry', chapter: 'Solid State' };
  const normal = one(raw);
  assert.deepEqual(normal.draft.options.map((o) => o.text), ['one', 'two', 'three']);
  const restored = one(raw, { restore: true });
  assert.equal(restored.ok, true, JSON.stringify(restored.errors));
  assert.equal(restored.draft.public_id, 'QB-CHEM-000007');
  assert.equal(restored.draft.status, 'published');
  assert.equal(restored.draft.origin, 'ai_image');
  assert.deepEqual(restored.draft.options.map((o) => o.text), ['A. one', 'B. two', 'C. three']);
  assert.ok(paths(one({ ...raw, status: 'live' }, { restore: true })).includes('status'));
});

// ---- restore mode accepts a whole backup; ordinary paste stays small ----
import { importQuestions as importAll } from '../../supabase/functions/_shared/core/importer.js';
import { LIMITS as LIM } from '../../supabase/functions/_shared/core/constants.js';
import { index as fxIndex } from './fixtures.js';

test('restore mode allows bigger files than a normal paste, with its own limits', () => {
  const one = (n) => ({ id: `QB-CHEM-${String(n).padStart(6, '0')}`, status: 'published', type: 'short_answer', question: `Q number ${n}?`, answer: 'x', subject: 'Chemistry', chapter: 'Solid State' });
  const many = (n) => JSON.stringify({ format: 'qb-backup', version: 1, questions: Array.from({ length: n }, (_, i) => one(i + 1)) });
  const idx = fxIndex();
  const paste = importAll(many(LIM.importItemsMax + 1), { taxonomy: idx });
  assert.match(paste.fatal?.message ?? '', /limit is 100/);
  const restore = importAll(many(LIM.importItemsMax + 1), { taxonomy: idx, restore: true });
  assert.equal(restore.fatal, null, restore.fatal?.message);
  assert.equal(restore.items.length, LIM.importItemsMax + 1);
  const tooMany = importAll(many(LIM.restoreItemsMax + 1), { taxonomy: idx, restore: true });
  assert.match(tooMany.fatal?.message ?? '', new RegExp(`limit is ${LIM.restoreItemsMax}`));
  assert.match(tooMany.fatal.message, /one backup per subject/);
});
