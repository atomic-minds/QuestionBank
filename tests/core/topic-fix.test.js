// Review screen: topics that a file names but the Taxonomy does not have yet (the "Create these topics" button).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importQuestions } from '../../supabase/functions/_shared/core/importer.js';
import { buildTaxonomyIndex } from '../../supabase/functions/_shared/core/taxonomy.js';
import { attachCreated, forgetTopicIfChapterChanged, linkKnownTopics, pendingTopics } from '../../web/js/views/topic-fix.js';
import { EXAMS, TREE } from './fixtures.js';

const q = (n, topic, chapter = 'Solid State') => ({ type: 'short_answer', question: `Question number ${n}`, answer: 'x', subject: 'Chemistry', chapter, topic });
const read = (list, tree = TREE) => {
  const index = buildTaxonomyIndex(tree, EXAMS);
  const r = importQuestions(JSON.stringify({ questions: list }), { taxonomy: index });
  return { index, items: r.items.map((it, i) => ({ key: String(i), draft: it.draft, warnings: it.warnings, unresolved: it.unresolved, ok: it.ok, saved: null })) };
};
const grow = (tree, chapterId, topics) => tree.map((s) => ({ ...s, chapters: s.chapters.map((c) => (c.id === chapterId ? { ...c, topics: [...c.topics, ...topics] } : c)) }));

test('unknown topics are listed once per chapter and name, with how many questions use them', () => {
  const { index, items } = read([q(1, 'Atomic Models'), q(2, 'atomic  models'), q(3, 'Quantum Numbers'), q(4, 'Defects'), q(5, null)]);
  const list = pendingTopics(items, index);
  assert.deepEqual(list.map((g) => [g.name, g.chapter, g.count]), [['Atomic Models', 'Solid State', 2], ['Quantum Numbers', 'Solid State', 1]]);
  assert.equal(items[3].draft.topic_id, 101, 'a topic that exists was matched by the importer already');
});

test('the same topic name in two chapters is two topics', () => {
  const { index, items } = read([q(1, 'Basics'), q(2, 'Basics', 'Thermodynamics')]);
  const list = pendingTopics(items, index);
  assert.deepEqual(list.map((g) => g.chapter).sort(), ['Solid State', 'Thermodynamics']);
});

test('nothing is listed when the chapter itself is unknown (chapters are never created for you)', () => {
  const { index, items } = read([q(1, 'Atomic Models', 'No Such Chapter')]);
  assert.deepEqual(pendingTopics(items, index), []);
});

test('created topics are attached to every question that asked for them, and the warning goes away', () => {
  const { index, items } = read([q(1, 'Atomic Models'), q(2, 'Atomic Models'), q(3, 'Quantum Numbers')]);
  assert.ok(items[0].warnings.some((w) => w.path === 'topic_id'));
  const list = pendingTopics(items, index);
  const ids = new Map(list.map((g, i) => [g.key, 500 + i]));
  const after = buildTaxonomyIndex(grow(TREE, 10, [{ id: 500, name: 'Atomic Models', slug: 'atomic-models' }, { id: 501, name: 'Quantum Numbers', slug: 'quantum-numbers' }]), EXAMS);
  assert.equal(attachCreated(items, after, ids), 3);
  assert.deepEqual(items.map((i) => i.draft.topic_id), [500, 500, 501]);
  assert.ok(items.every((i) => !i.warnings.some((w) => w.path === 'topic_id')));
  assert.deepEqual(pendingTopics(items, after), [], 'nothing is left to create');
});

test('a topic already added in the Taxonomy is linked, never created twice', () => {
  const { items } = read([q(1, 'Atomic Models')]);
  const later = buildTaxonomyIndex(grow(TREE, 10, [{ id: 700, name: 'Atomic models', slug: 'atomic-models' }]), EXAMS);
  assert.deepEqual(pendingTopics(items, later), []);
  assert.equal(linkKnownTopics(items, later), 1);
  assert.equal(items[0].draft.topic_id, 700);
  assert.equal(linkKnownTopics(items, later), 0, 'second run changes nothing');
});

test('two existing topics with the same normalised name are ambiguous: nothing is linked or created', () => {
  const { items } = read([q(1, 'Atomic Models')]);
  const amb = buildTaxonomyIndex(grow(TREE, 10, [{ id: 800, name: 'Atomic-Models', slug: 'a1' }, { id: 801, name: 'Atomic Models!', slug: 'a2' }]), EXAMS);
  assert.deepEqual(pendingTopics(items, amb), []);
  assert.equal(linkKnownTopics(items, amb), 0);
  assert.equal(items[0].draft.topic_id, null);
});

test('a topic the admin picked by hand is never replaced, and saved or discarded questions are ignored', () => {
  const { index, items } = read([q(1, 'Atomic Models'), q(2, 'Atomic Models'), q(3, 'Atomic Models')]);
  items[0].draft = { ...items[0].draft, topic_id: 100 };
  items[1].saved = { public_id: 'QB-X-1' };
  const list = pendingTopics(items, index);
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 1, 'only the untouched question is counted');
  attachCreated(items, index, new Map([[list[0].key, 900]]));
  assert.deepEqual(items.map((i) => i.draft.topic_id), [100, null, 900]);
});

test('changing the chapter by hand forgets the topic name that was read from the file', () => {
  const { index, items } = read([q(1, 'Atomic Models')]);
  const it = items[0];
  const before = it.draft.chapter_id;
  it.draft = { ...it.draft, chapter_id: 12, topic_id: null };
  forgetTopicIfChapterChanged(it, before);
  assert.deepEqual(pendingTopics(items, index), []);
});

test('names longer than the database allows are not offered', () => {
  const { index, items } = read([q(1, 'x'.repeat(121))]);
  assert.deepEqual(pendingTopics(items, index), []);
});
