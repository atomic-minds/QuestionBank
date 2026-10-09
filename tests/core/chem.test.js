import test from 'node:test';
import assert from 'node:assert/strict';
import { isStructureText, parseRich, richHtml, richPlain } from '../../supabase/functions/_shared/core/chem.js';

test('formulas get subscripts and ions get superscripts', () => {
  assert.equal(richPlain('H2SO4 is an acid'), 'H₂SO₄ is an acid');
  assert.equal(richPlain('Ca(OH)2 and CuSO4·5H2O'), 'Ca(OH)₂ and CuSO₄·5H₂O');
  assert.equal(richPlain('Fe3+, Al3+, Cu2+'), 'Fe³⁺, Al³⁺, Cu²⁺');
  assert.equal(richPlain('SO42- , NH4+, NO2-, Cl- , OH-'), 'SO₄²⁻ , NH₄⁺, NO₂⁻, Cl⁻ , OH⁻');
  assert.equal(richPlain('KMnO4 and K2Cr2O7'), 'KMnO₄ and K₂Cr₂O₇');
  assert.equal(richPlain('CH3COOH(aq)'), 'CH₃COOH(aq)');
  assert.equal(richPlain('(see H2O)'), '(see H₂O)');
});

test('explicit markup and arrows', () => {
  assert.equal(richPlain('H_2O, Fe^{3+}, SO4^2-, x^2, 10^-3'), 'H₂O, Fe³⁺, SO₄²⁻, x², 10⁻³');
  assert.equal(richPlain('2H2 + O2 -> 2H2O'), '2H₂ + O₂ → 2H₂O');
  assert.equal(richPlain('N2 + 3H2 <=> 2NH3'), 'N₂ + 3H₂ ⇌ 2NH₃');
  assert.equal(richPlain('a^2-b^2'), 'a²-b²', 'a sign followed by a letter is not a charge');
});

test('ordinary words and labels are left exactly as typed', () => {
  for (const t of ['Q1 JEE2019 Paper2 Class12 B12', 'the C2 carbon', 'Table 3', 'pH 7', 'No. 5', '_____ is the answer', 'already ₂ and ³⁺']) assert.equal(richPlain(t), t);
});

test('output is escaped: only sub and sup tags can appear', () => {
  assert.equal(richHtml('<b>H2O</b> & "x"^2'), '&lt;b&gt;H<sub>2</sub>O&lt;/b&gt; &amp; &quot;x&quot;<sup>2</sup>');
  assert.ok(!/<script/i.test(richHtml('<script>alert(1)</script>')));
  assert.deepEqual(parseRich('').length, 0);
});

test('drawn structures are recognised', () => {
  assert.equal(isStructureText('H3C — CH — OCH3 নাম\n     |\n    CH3'), true);
  assert.equal(isStructureText('Line one\n   indented line'), true);
  assert.equal(isStructureText('a normal question\nsecond line'), false);
  assert.equal(isStructureText('single line'), false);
});
