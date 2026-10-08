import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAtomicMindsExport, buildBackup, buildPlainText, exportFilename } from '../../supabase/functions/_shared/core/export.js';
import { importQuestions } from '../../supabase/functions/_shared/core/importer.js';
import { dbQuestion, index } from './fixtures.js';

const idx = index();
const NOW = new Date('2026-10-06T00:00:00Z');
const numeric = dbQuestion({ public_id: 'QB-CHEM-000002', type_code: 'numerical', options: null, question_text: 'Avogadro number?', answer: { number: 6.02e23, unit: '1/mol', tolerance: 0.01 }, explanation: null });
const short = dbQuestion({ public_id: 'QB-CHEM-000003', type_code: 'short_answer', options: null, question_text: 'Define a unit cell.', answer: { text: 'Smallest repeating unit.' }, explanation: null });
const match = dbQuestion({
  public_id: 'QB-CHEM-000004', type_code: 'match_following', options: null, question_text: 'Match.',
  match_items: { left: [{ id: 'A', text: 'NaCl' }, { id: 'B', text: 'CsCl' }], right: [{ id: '1', text: '8:8' }, { id: '2', text: '6:6' }] },
  answer: { pairs: { A: '2', B: '1' } }, explanation: null, exams: [{ exam_id: 1, code: 'CBSE', name: 'CBSE', year: 2025, paper: 'Set 1' }],
});

test('Atomic Minds JSON: versioned, keeps the Question Bank ID, 0-based answer index', () => {
  const { document, skipped } = buildAtomicMindsExport([dbQuestion(), numeric], idx, { now: NOW });
  assert.equal(document.format, 'atomic-minds-question-bank');
  assert.equal(document.version, 1);
  assert.equal(document.exported_at, '2026-10-06T00:00:00.000Z');
  assert.equal(document.count, 1);
  assert.deepEqual(skipped, [{ id: 'QB-CHEM-000002', reason: 'Numerical has no fixed options' }]);
  const q = document.questions[0];
  assert.equal(q.id, 'QB-CHEM-000241');
  assert.equal(q.revision, 3);
  assert.deepEqual(q.options, ['4', '6', '8', '12']);
  assert.equal(q.answer, 1);
  assert.equal(q.explanation.startsWith('In the NaCl'), true);
  assert.deepEqual([q.subject, q.chapter, q.topic, q.category], ['Chemistry', 'Solid State', 'Crystal Structure', 'general']);
  assert.equal(q.marks, 1);
  assert.deepEqual(q.sources, []);
});

test('Atomic Minds JSON: every question has the same keys; subjective types opt in', () => {
  const { document } = buildAtomicMindsExport([dbQuestion(), numeric, short, match], idx, { now: NOW, includeSubjective: true });
  const keys = Object.keys(document.questions[0]).sort();
  for (const q of document.questions) assert.deepEqual(Object.keys(q).sort(), keys);
  assert.deepEqual(document.questions[1].answer_numeric, { value: 6.02e23, unit: '1/mol', tolerance: 0.01 });
  assert.equal(document.questions[1].answer, null);
  assert.equal(document.questions[2].answer_text, 'Smallest repeating unit.');
  assert.deepEqual(document.questions[3].match, { left: ['NaCl', 'CsCl'], right: ['8:8', '6:6'] });
  assert.deepEqual(document.questions[3].answer_pairs, [[0, 1], [1, 0]]);
  assert.deepEqual(document.questions[3].sources, [{ exam: 'CBSE', year: 2025, paper: 'Set 1' }]);
  assert.equal(document.questions[3].category, 'exam');
});

test('plain text follows the layout from the brief exactly', () => {
  const text = buildPlainText([dbQuestion()]);
  assert.equal(text, [
    'Q1. What is the coordination number of NaCl?',
    '',
    'A. 4',
    'B. 6',
    'C. 8',
    'D. 12',
    '',
    'Ans: B',
    '',
    'Exp: In the NaCl crystal structure, each Na+ ion is surrounded by six Cl- ions.',
    '',
  ].join('\n'));
});

test('plain text: numbering, options to hide things, other types', () => {
  const two = buildPlainText([dbQuestion(), dbQuestion({ question_text: 'Second?' })]);
  assert.match(two, /\n\n\nQ2\. Second\?/);
  const bare = buildPlainText([dbQuestion()], { includeAnswers: false, includeExplanations: false });
  assert.doesNotMatch(bare, /Ans:|Exp:/);
  assert.match(buildPlainText([dbQuestion()], { includeIds: true }), /ID: QB-CHEM-000241/);
  assert.match(buildPlainText([numeric]), /Ans: 6.02e\+23 1\/mol \(±0.01\)/);
  assert.match(buildPlainText([short]), /Ans: Smallest repeating unit\./);
  const m = buildPlainText([match]);
  assert.match(m, /List I\nA\. NaCl\nB\. CsCl/);
  assert.match(m, /List II\n1\. 8:8\n2\. 6:6/);
  assert.match(m, /Ans: A-2, B-1/);
  assert.match(buildPlainText([dbQuestion({ context: 'A passage.' })]), /^A passage\.\n\nQ1\./);
  assert.equal(buildPlainText([]), '');
});

test('filenames sort by date', () => {
  assert.equal(exportFilename('json', NOW), 'atomic-minds-questions-2026-10-06.json');
  assert.equal(exportFilename('text', NOW), 'question-bank-2026-10-06.txt');
  assert.equal(exportFilename('backup', NOW), 'question-bank-backup-2026-10-06.json');
});

test('a backup restores to the same questions, IDs and status (round trip)', () => {
  const originals = [
    dbQuestion({ options: [{ id: 'A', text: 'A. odd label' }, { id: 'B', text: 'B. also' }], answer: { value: 'B' }, exams: [{ exam_id: 2, code: 'JEE_MAIN', name: 'JEE Main', year: 2019, paper: null }] }),
    numeric, short, match,
  ];
  const backup = buildBackup(originals, idx, { now: NOW });
  assert.equal(backup.format, 'qb-backup');
  assert.equal(backup.count, 4);
  assert.equal(backup.taxonomy[0].chapters[0].topics[0], 'Crystal Structure');
  const result = importQuestions(JSON.stringify(backup), { taxonomy: idx, restore: true });
  assert.deepEqual(result.items.filter((i) => !i.ok).map((i) => i.errors), []);
  result.items.forEach((it, i) => {
    const o = originals[i];
    assert.equal(it.draft.public_id, o.public_id);
    assert.equal(it.draft.status, o.status);
    assert.equal(it.draft.type_code, o.type_code);
    assert.equal(it.draft.question_text, o.question_text);
    assert.deepEqual(it.draft.answer, o.answer);
    assert.deepEqual(it.draft.options, o.options);
    assert.deepEqual(it.draft.match_items, o.match_items);
    assert.deepEqual(it.draft.exams.map((e) => [e.exam_id, e.year, e.paper]), o.exams.map((e) => [e.exam_id, e.year, e.paper]));
    assert.deepEqual([it.draft.subject_id, it.draft.chapter_id, it.draft.topic_id], [o.subject_id, o.chapter_id, o.topic_id]);
  });
});

test('Atomic Minds export imports back with the same answers', () => {
  const { document } = buildAtomicMindsExport([dbQuestion(), match], idx, { now: NOW, includeSubjective: false });
  const r = importQuestions(JSON.stringify(document), { taxonomy: idx });
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].draft.answer, { value: 'B' });
});
