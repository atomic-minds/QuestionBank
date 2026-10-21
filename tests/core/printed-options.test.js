// A question that prints options is multiple choice, even if it was called "numerical".
// The calculation nature is kept as the tag "numerical".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeImportItem } from '../../supabase/functions/_shared/core/importer.js';
import { adaptAiOutput } from '../../supabase/functions/_shared/core/ai/adapt.js';
import { buildPrompt } from '../../supabase/functions/_shared/core/ai/prompt.js';
import { index } from './fixtures.js';

const idx = index();
const OPTS = ['0.10 g/mol', '100 g/mol', '7.3 g/mol', '130 g/mol'];
const item = (over = {}, ctx = {}) => normalizeImportItem(
  { type: 'numerical', question: 'Find the molar mass of the solute.', options: OPTS, answer: '100 g/mol', subject: 'Chemistry', chapter: 'Solid State', ...over },
  0, { taxonomy: idx, ...ctx });

test('a numerical question with options becomes MCQ and the answer finds its option', () => {
  const r = item();
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.draft.type_code, 'mcq');
  assert.deepEqual(r.draft.answer, { value: 'B' });
  assert.deepEqual(r.draft.options.map((o) => o.text), OPTS);
  assert.ok(r.draft.tags.includes('numerical'), 'kept as a tag');
  assert.ok(r.warnings.some((w) => w.path === 'type_code' && /multiple-choice/.test(w.message)), 'the admin is told');
});

test('the answer can be a number, a number with a unit object, or a letter', () => {
  assert.deepEqual(item({ answer: 100 }).draft.answer, { value: 'B' });
  assert.deepEqual(item({ answer: { number: 130, unit: 'g/mol' } }).draft.answer, { value: 'D' });
  assert.deepEqual(item({ answer: 'C' }).draft.answer, { value: 'C' });
  assert.deepEqual(item({ answer: '(b)' }).draft.answer, { value: 'B' });
});

test('options written as maths still match', () => {
  const r = item({ options: ['$0.10\\ \\text{g/mol}$', '$100\\,\\mathrm{g/mol}$', '$7.3\\ \\text{g/mol}$', '$130\\ \\text{g/mol}$'], answer: '100 g/mol' });
  assert.deepEqual(r.draft.answer, { value: 'B' });
});

test('an answer that is not one of the options, or fits two of them, is left for a person to fix', () => {
  const none = item({ answer: '55 g/mol' });
  assert.equal(none.ok, false);
  assert.match(none.errors.map((e) => e.message).join(' '), /does not match|ambiguous/);
  const two = item({ options: ['100 g', '100 kg', '7 g', '9 g'], answer: 100 });
  assert.equal(two.ok, false, 'two options hold the value 100: do not guess');
});

test('short answers with options are multiple choice too, but are not tagged numerical', () => {
  const r = item({ type: 'short_answer', options: ['Ag', 'Au', 'Cu', 'Fe'], answer: 'B' });
  assert.equal(r.draft.type_code, 'mcq');
  assert.ok(!r.draft.tags.includes('numerical'));
});

test('a numerical question without options stays numerical, and existing tags are kept once', () => {
  const plain = item({ options: undefined, answer: { number: 100, unit: 'g/mol' } });
  assert.equal(plain.draft.type_code, 'numerical');
  assert.deepEqual(plain.draft.answer, { number: 100, unit: 'g/mol' });
  assert.ok(!plain.draft.tags.includes('numerical'));
  const tagged = item({ tags: ['Numerical', 'solutions'] });
  assert.deepEqual(tagged.draft.tags.filter((t) => t === 'numerical').length, 1);
  assert.ok(tagged.draft.tags.includes('solutions'));
});

test('one lonely option is not a choice question, and restoring a backup never rewrites types', () => {
  const one = item({ options: ['100 g/mol'] });
  assert.notEqual(one.draft.type_code, 'mcq');
  const restore = item({}, { restore: true });
  assert.equal(restore.ok, false);
  assert.match(restore.errors.map((e) => e.message).join(' '), /do not use options/);
});

test('the photo reader gets the same rule, and is told about it', () => {
  const r = adaptAiOutput({ image_issues: null, questions: [{
    type: 'numerical', question: 'If 0.40 g of a solute lowers the freezing point of 10 g benzene by 2 K, the molar mass is', context: null,
    options: ['0.10 g/mol', '100 g/mol', '7.3 g/mol', '130 g/mol'], match_left: null, match_right: null,
    answer: '100 g/mol', answer_source: 'inferred', explanation: 'Given: ...', explanation_source: 'generated',
    subject_id: 1, chapter_id: 10, topic_id: null, difficulty: 'medium', marks: null, tags: [], exams: [], notes: null, has_figure: false,
  }] }, { taxonomy: idx });
  const it = r.items[0];
  assert.equal(it.ok, true, JSON.stringify(it.errors));
  assert.equal(it.draft.type_code, 'mcq');
  assert.deepEqual(it.draft.answer, { value: 'B' });
  assert.ok(it.draft.tags.includes('numerical'));
  assert.equal(it.meta.answer_source, 'inferred', 'still marked as worked out by the AI');
  const { system } = buildPrompt(idx);
  assert.match(system, /PRINTED OPTIONS decide the type/);
  assert.match(system, /ONLY when no options are printed/);
});
