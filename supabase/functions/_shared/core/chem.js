// Chemistry-friendly display of plain text. The stored text is NEVER changed: this only decides how
// it is shown. Everything here is pure (no DOM), so it runs in the browser and in tests.
//
// What it understands
//   explicit markup   H_2O  H_{2}O  Fe^{3+}  SO4^2-  x^2  10^-3  (use _{ } / ^{ } for anything longer)
//   arrows            ->  -->  <->  <=>      become  →  ⟶  ↔  ⇌
//   formulas          H2SO4  Ca(OH)2  CuSO4·5H2O  CH3COOH   digits after an element become subscripts
//   ions              Fe3+  Al3+  SO42-  NH4+  Cl-  OH-     the charge becomes a superscript
//
// Words that are not valid formulas (Q1, Paper2, JEE2019, Class12, B12, C2 as a carbon locant) are
// left exactly as typed. Text that already uses Unicode ₂ or ³⁺ is untouched.

const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr '
  + 'Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu '
  + 'Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr '
  + 'R X D').split(' '));            // R and X: "RCOOH", "X2" (halogen); D: deuterium

const MINUS = '−';
const isDigit = (c) => c >= '0' && c <= '9';
const isUpper = (c) => c >= 'A' && c <= 'Z';
const isLower = (c) => c >= 'a' && c <= 'z';

/** Parse a formula body (no coefficient). Returns {parts, subs} or null when it is not a formula. */
function parseBody(s, from = 0, closer = null) {
  const parts = [];
  let i = from;
  let elements = 0;
  let subs = 0;
  const text = (t) => { if (parts.length && parts[parts.length - 1].k === 't') parts[parts.length - 1].s += t; else parts.push({ k: 't', s: t }); };
  while (i < s.length) {
    const c = s[i];
    if (c === closer) return { parts, end: i, elements, subs };
    if (c === '(' || c === '[') {
      const inner = parseBody(s, i + 1, c === '(' ? ')' : ']');
      if (!inner || inner.end === undefined || s[inner.end] !== (c === '(' ? ')' : ']')) return null;
      text(c); for (const p of inner.parts) { if (p.k === 't') text(p.s); else parts.push(p); }
      text(s[inner.end]);
      elements += inner.elements; subs += inner.subs;
      i = inner.end + 1;
      let n = '';
      while (i < s.length && isDigit(s[i])) n += s[i++];
      if (n) { parts.push({ k: 'sub', s: n }); subs += 1; }
      continue;
    }
    if (c === '·') {                       // hydrate dot: CuSO4·5H2O
      text(c); i += 1;
      while (i < s.length && isDigit(s[i])) text(s[i++]);
      continue;
    }
    if (!isUpper(c)) return null;
    let sym = c;
    if (isLower(s[i + 1] ?? '')) {
      if (!ELEMENTS.has(c + s[i + 1])) return null;
      sym = c + s[i + 1];
    } else if (!ELEMENTS.has(c)) return null;
    text(sym); elements += 1; i += sym.length;
    let n = '';
    while (i < s.length && isDigit(s[i])) n += s[i++];
    if (n) { parts.push({ k: 'sub', s: n }); subs += 1; }
  }
  if (closer) return null;                      // opened a bracket and never closed it
  return { parts, end: s.length, elements, subs };
}

/** "2H2O" -> coefficient 2 + formula H2O. Returns segments, or null when the word is not a formula. */
function formulaSegments(word, charge) {
  let lead = 0;
  while (lead < word.length && isDigit(word[lead])) lead += 1;
  const body = word.slice(lead);
  if (!body) return null;
  let parsed = parseBody(body);
  let chargeText = null;

  // A trailing digit before the sign is a charge when what precedes it is a single element or already ends in a count:
  // Fe3+ -> Fe³⁺, SO42- -> SO₄²⁻   but   NO2- stays NO₂⁻ (two elements, so the digit is a count).
  if (charge && /\d$/.test(body)) {
    const head = parseBody(body.slice(0, -1));
    if (head && (head.elements === 1 && head.subs === 0 || /\d$/.test(body.slice(0, -1)))) {
      parsed = head; chargeText = body.slice(-1) + charge;
    }
  }
  if (!parsed) return null;
  if (chargeText === null && charge) chargeText = charge === '-' ? MINUS : charge;
  else if (chargeText) chargeText = chargeText.replace('-', MINUS);
  if (parsed.subs === 0 && !chargeText) return null;                 // nothing to improve
  const out = [];
  if (lead) out.push({ k: 't', s: word.slice(0, lead) });
  out.push(...parsed.parts);
  if (chargeText) out.push({ k: 'sup', s: chargeText });
  return out;
}

const LONE_LOCANT = /^(?:C\d{1,2}|B\d{1,2})$/;                // C2 (carbon 2), vitamin B12 ... stay as typed

function trimWrap(run) {
  let lead = ''; let tail = ''; let body = run;
  const count = (s, ch) => s.split(ch).length - 1;
  const state = body.match(/\((?:aq|s|l|g)\)$/);            // state symbols: CH3COOH(aq)
  if (state && body.length > state[0].length) { tail = state[0]; body = body.slice(0, -state[0].length); }
  while (body.endsWith(')') && count(body, ')') > count(body, '(')) { tail = `)${tail}`; body = body.slice(0, -1); }
  while (body.endsWith(']') && count(body, ']') > count(body, '[')) { tail = `]${tail}`; body = body.slice(0, -1); }
  while (body.startsWith('(') && count(body, '(') > count(body, ')')) { lead += '('; body = body.slice(1); }
  while (body.startsWith('[') && count(body, '[') > count(body, ']')) { lead += '['; body = body.slice(1); }
  return { lead, body, tail };
}

const RUN = /[A-Za-z0-9()[\]·]+/g;

/** Auto-format formulas inside a plain stretch of text (no explicit markup in it). */
function autoFormat(text) {
  if (!/\d/.test(text) && !/[A-Za-z][+\-−](?![A-Za-z0-9])/.test(text)) return [{ k: 't', s: text }];
  const out = [];
  let last = 0;
  const push = (seg) => {
    if (seg.k === 't' && out.length && out[out.length - 1].k === 't') out[out.length - 1].s += seg.s; else out.push(seg);
  };
  for (const m of text.matchAll(RUN)) {
    const start = m.index;
    let end = start + m[0].length;
    const { lead, body, tail } = trimWrap(m[0]);
    if (!/^[A-Z0-9]/.test(body) || body.length < 2 && !tail) { continue; }
    // A sign directly after the word, followed by a space, punctuation or the end, is an ion charge (Na+, Cl-, OH-).
    let charge = '';
    const next = text[end];
    const after = text[end + 1];
    if (!tail && (next === '+' || next === '-' || next === MINUS) && (after === undefined || !/[A-Za-z0-9]/.test(after))) charge = next === '+' ? '+' : '-';
    if (LONE_LOCANT.test(body) && !charge) continue;
    const segs = formulaSegments(body, charge);
    if (!segs) continue;
    if (start > last) push({ k: 't', s: text.slice(last, start) });
    if (lead) push({ k: 't', s: lead });
    segs.forEach(push);
    if (tail) push({ k: 't', s: tail });
    if (charge) end += 1;
    last = end;
  }
  if (last < text.length) push({ k: 't', s: text.slice(last) });
  return out.length ? out : [{ k: 't', s: text }];
}

const EXPLICIT = /\^\{([^{}]{1,24})\}|_\{([^{}]{1,24})\}|\^((?:[+\-−]\d{1,3})|(?:\d{1,3}[+\-−](?![A-Za-z0-9]))|(?:\d{1,3})|(?:[+\-−](?![A-Za-z0-9])))|<=>|<->|-->|->/g;
const ARROWS = { '<=>': '⇌', '<->': '↔', '-->': '⟶', '->': '→' };

/**
 * Split text into segments: {k:'t'|'sub'|'sup', s}. Concatenating every `s` gives the displayed text.
 * @returns {{k:'t'|'sub'|'sup', s:string}[]}
 */
export function parseRich(input) {
  const text = String(input ?? '');
  const out = [];
  const push = (seg) => {
    if (!seg.s) return;
    if (seg.k === 't' && out.length && out[out.length - 1].k === 't') out[out.length - 1].s += seg.s; else out.push(seg);
  };
  const plain = (s) => autoFormat(s).forEach(push);
  let last = 0;
  for (const m of text.matchAll(EXPLICIT)) {
    const at = m.index;
    plain(text.slice(last, at));
    last = at + m[0].length;
    if (m[1] !== undefined) push({ k: 'sup', s: m[1].replace(/-/g, MINUS) });
    else if (m[2] !== undefined) push({ k: 'sub', s: m[2] });
    else if (m[3] !== undefined) push({ k: 'sup', s: m[3].replace(/-/g, MINUS) });
    else push({ k: 't', s: ARROWS[m[0]] });
  }
  // `H_2O`: an underscore + digits right after a letter or bracket. Handled on the plain stretches.
  plain(text.slice(last));
  // second pass for _digits (kept separate so ____ blanks are never touched)
  const done = [];
  for (const seg of out) {
    if (seg.k !== 't' || !seg.s.includes('_')) { done.push(seg); continue; }
    let from = 0;
    const re = /_(\d{1,3})/g;
    let mm;
    const s = seg.s;
    while ((mm = re.exec(s)) !== null) {
      const prev = s[mm.index - 1];
      if (!prev || !/[A-Za-z)\]]/.test(prev)) continue;
      if (mm.index > from) done.push({ k: 't', s: s.slice(from, mm.index) });
      done.push({ k: 'sub', s: mm[1] });
      from = mm.index + mm[0].length;
    }
    if (from < s.length) done.push({ k: 't', s: s.slice(from) });
  }
  return done;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ESC[c]);

/** Safe HTML for the text: everything is escaped; only <sub> and <sup> are ever added. */
export function richHtml(text) {
  return parseRich(text).map((s) => (s.k === 'sub' ? `<sub>${esc(s.s)}</sub>` : s.k === 'sup' ? `<sup>${esc(s.s)}</sup>` : esc(s.s))).join('');
}

/** What the text will look like with the markup applied, as plain characters (for tests and previews). */
export function richPlain(text) {
  const SUB = '₀₁₂₃₄₅₆₇₈₉';
  const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', [MINUS]: '⁻', '-': '⁻' };
  return parseRich(text).map((s) => (s.k === 'sub' ? [...s.s].map((c) => (isDigit(c) ? SUB[Number(c)] : c)).join('')
    : s.k === 'sup' ? [...s.s].map((c) => SUP[c] ?? c).join('') : s.s)).join('');
}

/** True when a question holds a drawn structure (lines laid out with spaces and bond characters). */
export function isStructureText(text) {
  const s = String(text ?? '');
  if (!s.includes('\n')) return false;
  const lines = s.split('\n');
  return lines.some((l, i) => i > 0 && (/^ {2,}\S/.test(l) || /^[ \t]*[|/\\_\-–—─│]+[ \t|/\\_\-–—─│]*$/.test(l) && /[|/\\│]/.test(l)));
}
