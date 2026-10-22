import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkEdit, describeBulkEdit, hasBulkChanges } from '../../web/js/views/bulk-edit.js';

const base = { id: 'u1', subject_id: 1, chapter_id: 2, topic_id: 3, difficulty: 'easy', marks: 2, tags: ['units', 'si'], status: 'published', question_text: 'Q' };
const tax = { tree: [{ id: 1, name: 'Chemistry', chapters: [{ id: 2, name: 'Basic', topics: [{ id: 3, name: 'Units' }] }, { id: 5, name: 'Solid State', topics: [] }] }] };

test('nothing changes when no field is filled in', () => {
  assert.equal(hasBulkChanges({}), false);
  assert.deepEqual(applyBulkEdit(base, {}), base);
});

test('difficulty and marks are set or cleared', () => {
  assert.equal(applyBulkEdit(base, { difficulty: 'hard' }).difficulty, 'hard');
  assert.equal(applyBulkEdit(base, { difficulty: null }).difficulty, null);
  assert.equal(applyBulkEdit(base, { marks: 4 }).marks, 4);
  assert.equal(applyBulkEdit(base, { marks: 0 }).marks, 0);
});

test('tags are added and removed without duplicates or case problems', () => {
  const r = applyBulkEdit(base, { addTags: 'Numerical, SI , board 2024', removeTags: 'units' });
  assert.deepEqual(r.tags, ['si', 'numerical', 'board-2024']);
  assert.equal(hasBulkChanges({ addTags: ' , ' }), false);
  assert.equal(hasBulkChanges({ removeTags: 'x' }), true);
});

test('moving sets subject, chapter and topic together and keeps everything else', () => {
  const r = applyBulkEdit(base, { move: { subject_id: 1, chapter_id: 5, topic_id: null } });
  assert.equal(r.chapter_id, 5); assert.equal(r.topic_id, null); assert.equal(r.status, 'published');
  assert.equal(base.chapter_id, 2, 'the original is not changed');
});

test('describeBulkEdit lists every change in plain words', () => {
  const lines = describeBulkEdit({ difficulty: 'easy', marks: 2, addTags: 'a', removeTags: 'b', move: { subject_id: 1, chapter_id: 2, topic_id: 3 } }, tax);
  assert.deepEqual(lines, ['Difficulty: easy', 'Marks: 2', 'Add tags: a', 'Remove tags: b', 'Move to: Chemistry › Basic › Units']);
});
