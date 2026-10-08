import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanText, matchKey, normalizeTags, parseOptionLetter, resolveDifficulty, resolveTypeCode, similarity, stripOptionLabels,
} from '../../supabase/functions/_shared/core/text.js';

test('cleanText trims, unifies newlines, removes control characters, empty -> null', () => {
  assert.equal(cleanText('  hi\r\nthere \n\n\n\nx  '), 'hi\nthere\n\nx');
  assert.equal(cleanText('a\u0007b'), 'ab');
  assert.equal(cleanText('   '), null);
  assert.equal(cleanText(null), null);
  assert.equal(cleanText(0), '0');
});

test('every spelling of a type collapses to one controlled code', () => {
  for (const v of ['MCQ', 'mcq', 'Multiple Choice', 'multiple_choice', 'Multiple Choice Question', ' mcq ']) {
    assert.equal(resolveTypeCode(v), 'mcq', v);
  }
  assert.equal(resolveTypeCode('True/False'), 'true_false');
  assert.equal(resolveTypeCode('Assertion-Reason'), 'assertion_reason');
  assert.equal(resolveTypeCode('Fill in the Blanks'), 'fill_blank');
  assert.equal(resolveTypeCode('Match the Following'), 'match_following');
  assert.equal(resolveTypeCode('Case Study'), 'case_based');
  assert.equal(resolveTypeCode('Numerical'), 'numerical');
  assert.equal(resolveTypeCode('essay'), 'long_answer');
  assert.equal(resolveTypeCode('banana'), null);
  assert.equal(resolveTypeCode(null), null);
});

test('difficulty aliases; unknown is undefined, blank is null', () => {
  assert.equal(resolveDifficulty('Moderate'), 'medium');
  assert.equal(resolveDifficulty('TOUGH'), 'hard');
  assert.equal(resolveDifficulty(''), null);
  assert.equal(resolveDifficulty('level 3'), undefined);
});

test('tags are lower-case kebab, de-duplicated, limited in length', () => {
  assert.deepEqual(normalizeTags(['Crystal Lattice', 'crystal_lattice', ' NaCl ', '', 'x'.repeat(100)]), ['crystal-lattice', 'nacl', 'x'.repeat(40)]);
  assert.deepEqual(normalizeTags('a, b; c\nd'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(normalizeTags(undefined), []);
});

test('option labels are stripped only when every option is labelled in order', () => {
  assert.deepEqual(stripOptionLabels(['A. 4', 'B. 6', 'C. 8', 'D. 12']), ['4', '6', '8', '12']);
  assert.deepEqual(stripOptionLabels(['(a) x', '(b) y']), ['x', 'y']);
  assert.deepEqual(stripOptionLabels(['1) one', '2) two', '3) three']), ['one', 'two', 'three']);
  assert.deepEqual(stripOptionLabels(['A. Smith', 'Jones']), ['A. Smith', 'Jones']);
  assert.deepEqual(stripOptionLabels(['B. x', 'A. y']), ['B. x', 'A. y']);
  assert.deepEqual(stripOptionLabels(['4', '6']), ['4', '6']);
});

test('parseOptionLetter understands common spellings and rejects words', () => {
  assert.equal(parseOptionLetter('b'), 'B');
  assert.equal(parseOptionLetter('(c)'), 'C');
  assert.equal(parseOptionLetter('Option D'), 'D');
  assert.equal(parseOptionLetter('B) 6'), 'B');
  assert.equal(parseOptionLetter('Answer: A'), 'A');
  assert.equal(parseOptionLetter('Benzene'), null);
  assert.equal(parseOptionLetter('False'), null);
});

test('matchKey ignores case, punctuation and & vs and', () => {
  assert.equal(matchKey('Alcohols, Phenols & Ethers'), matchKey('alcohols phenols and ethers'));
  assert.equal(matchKey('  S-Block  Elements '), 's block elements');
});

test('similarity is 1 for equal keys and low for unrelated words', () => {
  assert.equal(similarity('Solid State', 'solid-state'), 1);
  assert.ok(similarity('Solid Stat', 'Solid State') > 0.8);
  assert.ok(similarity('Optics', 'Thermodynamics') < 0.3);
});
