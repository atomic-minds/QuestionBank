// "Copy instructions for another AI": the text must lead another AI to a reply that imports cleanly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildExternalInstructions, taxonomyText, PER_REPLY } from '../../web/js/views/ai-instructions.js';
import { importQuestions } from '../../supabase/functions/_shared/core/importer.js';
import { TYPE_CODES } from '../../supabase/functions/_shared/core/constants.js';
import { EXAMS, TREE, index } from './fixtures.js';

const tax = { tree: TREE, exams: EXAMS };
const idx = index();
const text = buildExternalInstructions(tax);

test('it tells the AI how to reply: JSON only, no fence, valid, complete, doubled backslashes', () => {
  assert.match(text, /JSON object ONLY/);
  assert.match(text, /no markdown code fence/);
  assert.match(text, /Every backslash inside a text is doubled/);
  assert.match(text, /EVERY backslash must be doubled/, 'the shared formula rule is included');
  assert.match(text, new RegExp(`at most ${PER_REPLY} questions`));
  assert.match(text, /"continue"/);
});

test('it explains every question type and the answer format of each', () => {
  for (const code of TYPE_CODES) assert.ok(text.includes(`"${code}"`), `type ${code} is explained`);
  assert.match(text, /answer = the option LETTER only/);
  assert.match(text, /printed options.*mcq|prints options.*"mcq"/is, 'printed options mean mcq, even for calculations');
  assert.match(text, /explanation = null/, 'short and long answers have no separate explanation');
  assert.match(text, /Given: .*\nTo find:/s, 'numerical working layout');
  assert.match(text, /Do NOT copy the question number/);
  assert.match(text, /ONE question/, 'parts stay together');
});

test('it lists the real subject, chapter, topic and exam names of this bank', () => {
  for (const name of ['Chemistry', 'Physics', 'Solid State', 'Crystal Structure', 'Defects', 'Thermodynamics', 'JEE Main', 'NEET']) assert.ok(text.includes(name), name);
  assert.match(taxonomyText(tax), /SUBJECT: Chemistry\n {2}CHAPTER: Solid State\n {4}TOPIC: Crystal Structure/);
  assert.match(buildExternalInstructions({ tree: [], exams: [] }), /no subjects yet/);
});

test('a very large taxonomy falls back to chapters only, so the text stays pasteable', () => {
  const big = [{ id: 1, name: 'Big', chapters: Array.from({ length: 300 }, (_, c) => ({ id: c, name: `Chapter ${c}`, topics: Array.from({ length: 20 }, (_, t) => ({ id: t, name: `A fairly long topic name number ${t} of chapter ${c}` })) })) }];
  const t = taxonomyText({ tree: big });
  assert.doesNotMatch(t, /TOPIC:/);
  assert.match(t, /CHAPTER: Chapter 299/);
  assert.ok(buildExternalInstructions({ tree: big, exams: [] }).length < 30000);
});

// A reply written exactly as the instructions ask, one question of every type.
const REPLY = {
  format: 'qb-import', version: 1, questions: [
    { type: 'mcq', question: 'Coordination number of NaCl is', context: null, options: ['4', '6', '8', '12'], answer: 'B', explanation: 'Six Cl⁻ around each Na⁺.', subject: 'Chemistry', chapter: 'Solid State', topic: 'Crystal Structure', difficulty: 'easy', marks: 1, tags: ['nacl'], exams: [{ exam: 'JEE Main', year: 2019 }] },
    { type: 'true_false', question: 'An electron is negatively charged.', context: null, options: null, answer: 'True', explanation: null, subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: null, marks: null, tags: [], exams: [] },
    { type: 'assertion_reason', question: 'Assertion (A): Ice floats.\nReason (R): Ice is less dense than water.', context: null, options: null, answer: 'A', explanation: 'R explains A.', subject: 'Physics', chapter: 'Thermodynamics', topic: null, difficulty: 'medium', marks: null, tags: [], exams: [] },
    { type: 'numerical', question: 'Molar mass of water in g/mol?', context: null, options: null, answer: '18.015 g/mol', explanation: 'Given: H = 1.008, O = 16.00\nTo find: M\nConcept / formula: $M = 2 \\times 1.008 + 16.00$\nSteps: 1. ...\nAnswer: 18.015 g/mol', subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: 'easy', marks: 2, tags: [], exams: [] },
    { type: 'short_answer', question: 'State Boyle\'s law.', context: null, options: null, answer: '- At constant T\n- $PV$ is constant', explanation: null, subject: 'Physics', chapter: 'Thermodynamics', topic: null, difficulty: null, marks: 2, tags: [], exams: [] },
    { type: 'long_answer', question: 'Explain Schottky defect.', context: null, options: null, answer: '- Ions missing in pairs\n- Density decreases', explanation: null, subject: 'Chemistry', chapter: 'Solid State', topic: 'Defects', difficulty: 'hard', marks: 5, tags: [], exams: [] },
    { type: 'fill_blank', question: '____ is ionic and ____ is covalent.', context: null, options: null, answer: 'NaCl; HCl', explanation: null, subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: null, marks: null, tags: [], exams: [] },
    { type: 'case_based', question: 'Why does it conduct?', context: 'A crystal has free ions.', options: null, answer: 'Ions move.', explanation: null, subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: null, marks: null, tags: [], exams: [] },
    { type: 'match_following', question: 'Match the scientist with the model.', context: null, match: { left: ['Thomson', 'Rutherford'], right: ['Nuclear model', 'Plum pudding'] }, answer: 'A-2, B-1', explanation: null, subject: 'Chemistry', chapter: 'Solid State', topic: null, difficulty: null, marks: null, tags: [], exams: [] },
  ],
};

test('a reply written exactly as instructed imports cleanly, for every type', () => {
  const r = importQuestions(JSON.stringify(REPLY), { taxonomy: idx });
  assert.equal(r.fatal, null);
  assert.deepEqual(r.items.map((i) => [i.ok, i.errors.map((e) => e.message)]), r.items.map(() => [true, []]), JSON.stringify(r.items.map((i) => i.errors)));
  assert.deepEqual(r.items.map((i) => i.draft.type_code), ['mcq', 'true_false', 'assertion_reason', 'numerical', 'short_answer', 'long_answer', 'fill_blank', 'case_based', 'match_following']);
  assert.deepEqual(r.items[0].draft.answer, { value: 'B' });
  assert.deepEqual(r.items[3].draft.answer, { number: 18.015, unit: 'g/mol' });
  assert.deepEqual(r.items[8].draft.answer, { pairs: { A: '2', B: '1' } });
  assert.equal(r.items[0].draft.topic_id, 100);
  assert.equal(r.items[0].draft.exams.length, 1);
});

test('the same reply wrapped in a code fence with a trailing comma still imports', () => {
  const fenced = '```json\n' + JSON.stringify(REPLY, null, 2).replace(/\n\s*\]\s*\}$/, ',\n  ]\n}') + '\n```';
  const r = importQuestions(fenced, { taxonomy: idx });
  assert.equal(r.fatal, null, JSON.stringify(r.fatal));
  assert.equal(r.items.length, 9);
});

test('an AI that forgets to double a backslash does not break the formulas', () => {
  // "\t" and "\f" are read by JSON as a tab and a form feed; inside $...$ they are turned back into \times and \frac.
  const sloppy = '{"questions":[{"type":"short_answer","question":"Find $x = 3 \\times 4$ and $\\frac{1}{2}$","answer":"- $12$","subject":"Chemistry","chapter":"Solid State"}]}'.replace(/\\\\/g, '\\');
  const r = importQuestions(sloppy, { taxonomy: idx });
  assert.equal(r.fatal, null, JSON.stringify(r.fatal));
  assert.equal(r.items[0].draft.question_text, 'Find $x = 3 \\times 4$ and $\\frac{1}{2}$');
});

test('a missing closing dollar sign is closed, and backups are never rewritten', () => {
  const open = importQuestions(JSON.stringify({ questions: [{ type: 'short_answer', question: '(a) $\\ce{A + B ->}', answer: '- x', subject: 'Chemistry', chapter: 'Solid State' }] }), { taxonomy: idx });
  assert.equal(open.items[0].draft.question_text, '(a) $\\ce{A + B ->}$');
  const money = importQuestions(JSON.stringify({ questions: [{ type: 'short_answer', question: 'It costs $5 or $10 in total', answer: '- x', subject: 'Chemistry', chapter: 'Solid State' }] }), { taxonomy: idx });
  assert.equal(money.items[0].draft.question_text, 'It costs $5 or $10 in total', 'ordinary dollar amounts are left alone');
});
