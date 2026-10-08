import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultOptionsFor, emptyQuestionInput, validateQuestionInput } from '../../supabase/functions/_shared/core/validate.js';
import { TREE } from './fixtures.js';

const ctx = { taxonomy: TREE, examIds: new Set([1, 2]) };
const mcq = (over = {}) => ({
  subject_id: 1, chapter_id: 10, topic_id: 100, type_code: 'mcq', question_text: 'What is the coordination number of NaCl?',
  options: [{ id: 'A', text: '4' }, { id: 'B', text: '6' }, { id: 'C', text: '8' }, { id: 'D', text: '12' }],
  answer: { value: 'B' }, explanation: 'Six Cl- around each Na+.', difficulty: 'medium', marks: 1, tags: ['NaCl'], ...over,
});
const paths = (r) => r.errors.map((e) => e.path);

test('a complete MCQ is valid and normalised', () => {
  const r = validateQuestionInput(mcq(), ctx);
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.tags, ['nacl']);
  assert.equal('exams' in r.value, false, 'omitted exams stay omitted so an update keeps existing appearances');
  assert.equal(r.value.status, 'draft');
  assert.equal(r.value.origin, 'manual');
});

test('empty question text, missing answer and bad type are all reported together', () => {
  const r = validateQuestionInput(mcq({ question_text: '  ', answer: { value: 'Z' }, type_code: 'nope' }), ctx);
  assert.ok(paths(r).includes('question_text'));
  assert.ok(paths(r).includes('type_code'));
  assert.equal(r.ok, false);
  const r2 = validateQuestionInput(mcq({ answer: { value: 'Z' } }), ctx);
  assert.ok(paths(r2).includes('answer'));
});

test('MCQ options: count, duplicates, empties, wrong ids', () => {
  assert.ok(paths(validateQuestionInput(mcq({ options: [{ id: 'A', text: 'x' }], answer: { value: 'A' } }), ctx)).includes('options'));
  assert.ok(paths(validateQuestionInput(mcq({ options: ['a', 'a  ', 'c', 'd'].map((text, i) => ({ id: 'ABCD'[i], text })) }), ctx)).some((p) => p.startsWith('options[')));
  assert.ok(paths(validateQuestionInput(mcq({ options: ['a', '', 'c', 'd'].map((text, i) => ({ id: 'ABCD'[i], text })) }), ctx)).includes('options[1].text'));
  assert.ok(paths(validateQuestionInput(mcq({ options: ['a', 'b', 'c', 'd'].map((text, i) => ({ id: 'BACD'[i], text })) }), ctx)).includes('options[0].id'));
  assert.ok(paths(validateQuestionInput(mcq({ options: Array.from({ length: 7 }, (_, i) => ({ id: 'ABCDEFG'[i], text: `o${i}` })) }), ctx)).includes('options'));
});

test('case-different options are different options (Co vs CO)', () => {
  const r = validateQuestionInput(mcq({ options: ['Co', 'CO', 'C', 'O'].map((text, i) => ({ id: 'ABCD'[i], text })) }), ctx);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test('subject/chapter/topic must belong together', () => {
  assert.ok(paths(validateQuestionInput(mcq({ chapter_id: 20 }), ctx)).includes('chapter_id'));
  assert.ok(paths(validateQuestionInput(mcq({ topic_id: 999 }), ctx)).includes('topic_id'));
  assert.ok(paths(validateQuestionInput(mcq({ subject_id: null }), ctx)).includes('subject_id'));
  assert.ok(paths(validateQuestionInput(mcq({ subject_id: 9 }), ctx)).includes('subject_id'));
  assert.equal(validateQuestionInput(mcq({ topic_id: null }), ctx).ok, true);
});

test('true/false, assertion-reason shapes', () => {
  const tf = { subject_id: 1, chapter_id: 10, type_code: 'true_false', question_text: 'NaCl is ionic.', options: defaultOptionsFor('true_false'), answer: { value: 'A' } };
  assert.equal(validateQuestionInput(tf, ctx).ok, true);
  assert.ok(paths(validateQuestionInput({ ...tf, options: defaultOptionsFor('mcq') }, ctx)).includes('options'));
  const ar = { ...tf, type_code: 'assertion_reason', options: defaultOptionsFor('assertion_reason'), answer: { value: 'C' } };
  assert.equal(validateQuestionInput(ar, ctx).ok, true);
});

test('text, numerical, case-based and match answers', () => {
  const base = { subject_id: 1, chapter_id: 10, question_text: 'Q?' };
  assert.equal(validateQuestionInput({ ...base, type_code: 'short_answer', answer: { text: 'six' } }, ctx).ok, true);
  assert.ok(paths(validateQuestionInput({ ...base, type_code: 'short_answer', answer: { text: ' ' } }, ctx)).includes('answer'));
  assert.ok(paths(validateQuestionInput({ ...base, type_code: 'short_answer', options: [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }], answer: { text: 'a' } }, ctx)).includes('options'));

  assert.equal(validateQuestionInput({ ...base, type_code: 'numerical', answer: { number: 6.02e23, unit: '1/mol', tolerance: 0.01 } }, ctx).ok, true);
  assert.ok(paths(validateQuestionInput({ ...base, type_code: 'numerical', answer: { number: 'six' } }, ctx)).includes('answer'));
  assert.ok(paths(validateQuestionInput({ ...base, type_code: 'numerical', answer: { number: 1, tolerance: -1 } }, ctx)).includes('answer.tolerance'));

  assert.ok(paths(validateQuestionInput({ ...base, type_code: 'case_based', answer: { text: 'x' } }, ctx)).includes('context'));
  assert.equal(validateQuestionInput({ ...base, type_code: 'case_based', context: 'A passage.', answer: { text: 'x' } }, ctx).ok, true);
  assert.equal(validateQuestionInput({ ...base, type_code: 'case_based', context: 'A passage.', options: [{ id: 'A', text: 'p' }, { id: 'B', text: 'q' }], answer: { value: 'B' } }, ctx).ok, true);

  const match = { ...base, type_code: 'match_following', match_items: { left: ['NaCl', 'CsCl'], right: ['6:6', '8:8'] }, answer: { pairs: { A: '1', B: '2' } } };
  assert.equal(validateQuestionInput(match, ctx).ok, true);
  assert.ok(paths(validateQuestionInput({ ...match, answer: { pairs: { A: '1' } } }, ctx)).includes('answer'));
  assert.ok(paths(validateQuestionInput({ ...match, answer: { pairs: { A: '1', B: '9' } } }, ctx)).includes('answer'));
  assert.ok(paths(validateQuestionInput({ ...match, match_items: { left: ['x'], right: ['y', 'z'] } }, ctx)).includes('match_items.left'));
});

test('marks, difficulty, tags, status, unknown fields', () => {
  assert.ok(paths(validateQuestionInput(mcq({ marks: 0 }), ctx)).includes('marks'));
  assert.ok(paths(validateQuestionInput(mcq({ marks: 101 }), ctx)).includes('marks'));
  assert.ok(paths(validateQuestionInput(mcq({ marks: 1.234 }), ctx)).includes('marks'));
  assert.equal(validateQuestionInput(mcq({ marks: '2.5' }), ctx).value.marks, 2.5);
  assert.ok(paths(validateQuestionInput(mcq({ difficulty: 'impossible' }), ctx)).includes('difficulty'));
  assert.ok(paths(validateQuestionInput(mcq({ tags: Array.from({ length: 13 }, (_, i) => `t${i}`) }), ctx)).includes('tags'));
  assert.ok(paths(validateQuestionInput(mcq({ status: 'live' }), ctx)).includes('status'));
  assert.ok(paths(validateQuestionInput(mcq({ hacker: 1 }), ctx)).includes('hacker'));
  assert.ok(paths(validateQuestionInput(mcq({ question_text: 'x'.repeat(5001) }), ctx)).includes('question_text'));
});

test('exam appearances: valid, unknown exam, bad year, duplicates, omitted = untouched', () => {
  const ok = validateQuestionInput(mcq({ exams: [{ exam_id: 1, year: '2025', paper: ' Set 1 ' }] }), ctx);
  assert.deepEqual(ok.value.exams, [{ exam_id: 1, year: 2025, paper: 'Set 1' }]);
  assert.ok(paths(validateQuestionInput(mcq({ exams: [{ exam_id: 99 }] }), ctx)).includes('exams[0].exam_id'));
  assert.ok(paths(validateQuestionInput(mcq({ exams: [{ exam_id: 1, year: 1800 }] }), ctx)).includes('exams[0].year'));
  assert.ok(paths(validateQuestionInput(mcq({ exams: [{ exam_id: 1, year: 2020 }, { exam_id: 1, year: 2020 }] }), ctx)).includes('exams[1]'));
  assert.equal('exams' in validateQuestionInput(mcq(), ctx).value, false);
});

test('identity fields: uuid / version / public id', () => {
  assert.ok(paths(validateQuestionInput(mcq({ id: 'nope' }), ctx)).includes('id'));
  assert.ok(paths(validateQuestionInput(mcq({ expected_version: 0 }), ctx)).includes('expected_version'));
  assert.ok(paths(validateQuestionInput(mcq({ public_id: 'QB-chem-1' }), ctx)).includes('public_id'));
  const r = validateQuestionInput(mcq({ id: '123E4567-E89B-12D3-A456-426614174000', expected_version: 3, public_id: 'QB-CHEM-000241' }), ctx);
  assert.equal(r.ok, true);
  assert.equal(r.value.id, '123e4567-e89b-12d3-a456-426614174000');
});

test('non-objects are rejected cleanly', () => {
  for (const bad of [null, 'x', 3, [], undefined]) assert.equal(validateQuestionInput(bad, ctx).ok, false);
});

test('the empty form draft is structurally sound but incomplete', () => {
  const r = validateQuestionInput(emptyQuestionInput(), ctx);
  assert.equal(r.ok, false);
  assert.ok(paths(r).includes('subject_id'));
  assert.ok(paths(r).includes('question_text'));
});
