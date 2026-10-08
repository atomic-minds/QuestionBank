// JSON import: turns whatever the admin pastes (or an AI returned) into reviewable drafts.
//
//   text --parseJsonLoose--> value --detectShape--> items --normalizeImportItem--> drafts
//
// Every item is judged on its own, so one bad question never blocks the others. Nothing here
// touches the database; the result is a list of editable drafts with field-level errors.
import {
  ASSERTION_REASON_OPTIONS, EXPORT_FORMATS, LIMITS, OPTION_LETTERS, PUBLIC_ID_PATTERN, QUESTION_TYPES, TYPE_CODES,
} from './constants.js';
import {
  cleanText, isInt, isPlainObject, leadingLabels, matchKey, normalizeTags, parseOptionLetter, resolveDifficulty,
  resolveTypeCode, stripOptionLabels,
} from './text.js';
import { resolveClassification, resolveExamRef } from './taxonomy.js';
import { validateQuestionInput } from './validate.js';

// ---------------------------------------------------------------------------------------------
// 1. Parsing
// ---------------------------------------------------------------------------------------------

/** Drop commas that directly precede } or ], without touching anything inside strings. */
function stripTrailingCommas(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function locate(text, error) {
  const msg = String(error?.message ?? error);
  let line = null;
  let column = null;
  const lc = msg.match(/line (\d+) column (\d+)/i);
  if (lc) { line = Number(lc[1]); column = Number(lc[2]); }
  else {
    const pos = msg.match(/position (\d+)/i);
    if (pos) {
      const before = text.slice(0, Number(pos[1]));
      line = before.split('\n').length;
      column = before.length - before.lastIndexOf('\n');
    }
  }
  if (line === null) {
    // Some engines name the bad token but not its position: find the first occurrence that follows
    // a valid-so-far prefix (best effort; the message is still shown either way).
    const tok = msg.match(/Unexpected token '(.)'/)?.[1];
    if (tok) {
      for (let at = text.indexOf(tok); at >= 0; at = text.indexOf(tok, at + 1)) {
        try { JSON.parse(text.slice(0, at)); } catch (e) {
          if (/end of JSON|Unexpected end/i.test(String(e.message))) {
            const before = text.slice(0, at);
            line = before.split('\n').length;
            column = before.length - before.lastIndexOf('\n');
            break;
          }
        }
      }
    }
  }
  return { message: msg.replace(/\s+\(line \d+ column \d+\)/, ''), line, column };
}

/**
 * Parse JSON, tolerating what chat tools typically add: a ```json fence, text before/after the
 * JSON, and trailing commas. Every repair applied is reported in `notes` so nothing is silent.
 * @returns {{ok:true, value:any, notes:string[]} | {ok:false, error:{message:string,line:number|null,column:number|null}}}
 */
export function parseJsonLoose(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: { message: 'Paste some JSON first.', line: null, column: null } };
  }
  const original = input.replace(/^﻿/, '');
  let first;
  try { return { ok: true, value: JSON.parse(original), notes: [] }; } catch (e) { first = e; }

  const notes = [];
  let s = original.trim();
  const attempt = () => { try { return { ok: true, value: JSON.parse(s), notes }; } catch { return null; } };

  const fence = s.match(/```[a-zA-Z]*\s*\n?([\s\S]*?)```/);
  if (fence) {
    s = fence[1].trim();
    notes.push('Removed the ``` code fence around the JSON.');
    const r = attempt();
    if (r) return r;
  }
  const open = s.search(/[{[]/);
  const close = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (open > 0 || (close >= 0 && close < s.length - 1)) {
    if (open >= 0 && close > open) {
      s = s.slice(open, close + 1);
      notes.push('Ignored text before/after the JSON.');
      const r = attempt();
      if (r) return r;
    }
  }
  const noCommas = stripTrailingCommas(s);
  if (noCommas !== s) {
    s = noCommas;
    notes.push('Removed trailing commas.');
    const r = attempt();
    if (r) return r;
  }
  return { ok: false, error: locate(original, first) };
}

// ---------------------------------------------------------------------------------------------
// 2. Shape detection
// ---------------------------------------------------------------------------------------------

const SUPPORTED = {
  [EXPORT_FORMATS.atomicMinds.format]: EXPORT_FORMATS.atomicMinds.version,
  [EXPORT_FORMATS.backup.format]: EXPORT_FORMATS.backup.version,
  [EXPORT_FORMATS.import.format]: EXPORT_FORMATS.import.version,
};

const looksLikeQuestion = (o) => isPlainObject(o) && ('question' in o || 'question_text' in o);

/**
 * @returns {{items:any[], format:string, error?:undefined} | {error:string}}
 */
export function detectShape(value) {
  if (Array.isArray(value)) return { items: value, format: 'array' };
  if (!isPlainObject(value)) return { error: 'The JSON must be a question, a list of questions, or {"questions": [...]}.' };

  let format = 'questions';
  if (value.format !== undefined) {
    if (typeof value.format !== 'string' || !(value.format in SUPPORTED)) {
      return { error: `Unknown format "${String(value.format).slice(0, 60)}". Expected one of: ${Object.keys(SUPPORTED).join(', ')} — or leave "format" out.` };
    }
    format = value.format;
    if (value.version !== undefined && (!isInt(value.version) || value.version > SUPPORTED[format])) {
      return { error: `This file uses ${format} version ${String(value.version).slice(0, 10)}, but this app understands up to version ${SUPPORTED[format]}. Update the app first.` };
    }
  }
  if (Array.isArray(value.questions)) return { items: value.questions, format };
  if (looksLikeQuestion(value)) return { items: [value], format: 'single' };
  return { error: 'Could not find any questions. Expected a "questions" array, a list, or a single question object.' };
}

// ---------------------------------------------------------------------------------------------
// 3. One item
// ---------------------------------------------------------------------------------------------

const KNOWN_KEYS = new Set([
  'id', 'public_id', 'question', 'question_text', 'text', 'statement', 'type', 'question_type', 'type_code',
  'context', 'passage', 'case', 'options', 'choices', 'match', 'match_items', 'left', 'right', 'answer',
  'correct_answer', 'correct', 'explanation', 'solution', 'rationale', 'subject', 'chapter', 'topic', 'category',
  'classification', 'exam', 'exams', 'sources', 'year', 'paper', 'difficulty', 'level', 'marks', 'points', 'tags',
  'metadata', 'source', 'source_ref', 'status', 'origin',
]);
// Export bookkeeping that is harmless to see on a re-imported file.
const IGNORED_KEYS = new Set(['revision', 'version', 'created_at', 'updated_at', 'published_at', 'exported_at', 'category_label']);

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
const ROMAN_LABEL = /^\s*\(?(i{1,3}|iv|vi{0,3}|ix|x)[.)]\s+/i;

const pick = (...vals) => vals.find((v) => v !== undefined);
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const asName = (v) => (isPlainObject(v) ? (v.name ?? v.title ?? null) : v);

function optionTexts(list) {
  return list.map((o) => (isPlainObject(o) ? (o.text ?? o.value ?? o.option ?? o.label ?? '') : o));
}

/** Accept ids on options only when they make sense; map supplied ids (A, b, 1...) to our A, B, C. */
function buildOptions(rawList, err, strip = true) {
  const supplied = rawList.map((o) => (isPlainObject(o) && !blank(o.id) ? String(o.id).trim().toUpperCase() : null));
  const plain = optionTexts(rawList).map((t) => (typeof t === 'string' || typeof t === 'number' ? String(t) : ''));
  const texts = strip ? stripOptionLabels(plain) : plain;
  const labels = strip ? leadingLabels(plain) : null;
  const idMap = new Map();
  let order = rawList.map((_, i) => i);
  const allLetters = supplied.every((id) => id && /^[A-F]$/.test(id));
  if (allLetters && new Set(supplied).size === supplied.length) {
    order = rawList.map((_, i) => i).sort((a, b) => supplied[a].localeCompare(supplied[b]));
    if (supplied.slice().sort().every((id, i) => id === OPTION_LETTERS[i])) {
      supplied.forEach((id) => idMap.set(id, id));            // permuted A..n: ids already match after sorting
    } else {
      order = rawList.map((_, i) => i);                         // gaps (A, C, D): keep order, map by position
      supplied.forEach((id, i) => idMap.set(id, OPTION_LETTERS[i]));
    }
  } else {
    supplied.forEach((id, i) => { if (id) idMap.set(id, OPTION_LETTERS[i]); });
  }
  if (labels) labels.forEach((l, i) => { if (!idMap.has(l)) idMap.set(l, OPTION_LETTERS[i]); });
  if (rawList.some((o) => !(typeof o === 'string' || typeof o === 'number' || isPlainObject(o)))) err('options', 'Each option must be text.');
  return { options: order.map((src, pos) => ({ id: OPTION_LETTERS[pos], text: texts[src] ?? '' })), idMap };
}

/** Map one source value to the option letter it refers to; returns {id}|{error}|{id, warning}. */
function resolveChoiceAnswer(a, typeCode, options, idMap, ctx) {
  let v = a;
  if (isPlainObject(v)) v = pick(v.value, v.id, v.option, v.label, v.text, v.index);
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) return { error: 'Choose the correct answer.' };

  const byIndex = (n, base) => {
    const i = n - base;
    return Number.isInteger(i) && i >= 0 && i < options.length ? { id: OPTION_LETTERS[i] } : { error: `Answer ${n} is outside the ${options.length} options.` };
  };
  if (typeof v === 'boolean') {
    const target = options.find((o) => matchKey(o.text) === (v ? 'true' : 'false'));
    return target ? { id: target.id } : { error: 'A true/false answer needs options labelled True and False.' };
  }
  if (typeof v === 'number') {
    if (ctx.answerIndexBase === 0 || ctx.answerIndexBase === 1) return byIndex(v, ctx.answerIndexBase);
    return { error: `The answer ${v} is ambiguous (is it option number ${v} counting from 0 or from 1?). Use the option letter, e.g. "B".` };
  }
  const s = String(v).trim();
  if (/^[A-Fa-f](\s*(,|&|\/|\band\b|\bor\b)\s*[A-Fa-f])+$/i.test(s)) {
    return { error: 'Several correct options are not supported; each question has exactly one correct answer.' };
  }
  const key = s.toUpperCase();
  if (idMap.has(key)) return { id: idMap.get(key) };

  if (typeCode === 'true_false') {
    const k = matchKey(s);
    const want = ['t', 'true', 'yes', 'correct'].includes(k) ? 'true' : ['f', 'false', 'no', 'incorrect'].includes(k) ? 'false' : null;
    const hit = want && options.find((o) => matchKey(o.text) === want);
    if (hit) return { id: hit.id };
  }
  const letter = parseOptionLetter(s);
  if (letter && OPTION_LETTERS.indexOf(letter) < options.length) return { id: letter };

  const same = options.filter((o) => matchKey(o.text) === matchKey(s));
  if (same.length === 1) return { id: same[0].id, warning: `Answer "${s.slice(0, 40)}" was matched to option ${same[0].id} by its text.` };
  return { error: `The answer "${s.slice(0, 40)}" does not match any option (use ${OPTION_LETTERS[0]}–${OPTION_LETTERS[options.length - 1]}).` };
}

function parseNumberWithUnit(s) {
  const m = String(s).replace(/[−–]/g, '-').replace(/\s*[×x]\s*10\s*\^?\s*(-?\d+)/, 'e$1').trim()
    .match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/);
  if (!m) return null;
  const number = Number(m[1]);
  return Number.isFinite(number) ? { number, unit: m[2].trim() || null } : null;
}

function resolveNumericAnswer(a) {
  let v = a;
  let unit = null;
  let tolerance;
  if (isPlainObject(v)) {
    unit = pick(v.unit, null);
    tolerance = v.tolerance;
    v = pick(v.number, v.value, v.answer);
  }
  if (typeof v === 'number') return Number.isFinite(v) ? { number: v, unit, tolerance } : null;
  if (typeof v === 'string') {
    const p = parseNumberWithUnit(v);
    if (!p) return null;
    return { number: p.number, unit: unit ?? p.unit, tolerance };
  }
  return null;
}

function romanOrNumber(label) {
  const k = String(label).trim().toUpperCase().replace(/[().]/g, '');
  if (/^\d+$/.test(k)) return Number(k);
  return ROMAN[k] ?? null;
}

function buildMatchSide(list, strip = true) {
  const texts = optionTexts(list).map((t) => String(t ?? ''));
  if (!strip) return { texts, labels: null, supplied: list.map(() => null) };
  const letterLabels = leadingLabels(texts);
  let labels = letterLabels;
  let cleaned = stripOptionLabels(texts);
  if (!letterLabels && texts.length >= 2 && texts.every((t) => ROMAN_LABEL.test(t))) {
    const nums = texts.map((t) => romanOrNumber(t.match(ROMAN_LABEL)[1]));
    if (nums.every((n, i) => n === i + 1)) {
      labels = nums.map(String);
      cleaned = texts.map((t) => t.replace(ROMAN_LABEL, '').trim());
    }
  }
  const supplied = list.map((o) => (isPlainObject(o) && !blank(o.id) ? String(o.id).trim().toUpperCase() : null));
  return { texts: cleaned, labels, supplied };
}

function matchLists(m) {
  if (!isPlainObject(m)) return null;
  const norm = (k) => k.toLowerCase().replace(/[^a-z0-9]/g, '');
  const find = (names) => Object.keys(m).find((k) => names.includes(norm(k)));
  const lk = find(['left', 'list1', 'listi', 'columna', 'columni', 'a']);
  const rk = find(['right', 'list2', 'listii', 'columnb', 'columnii', 'b']);
  return lk && rk && Array.isArray(m[lk]) && Array.isArray(m[rk]) ? { left: m[lk], right: m[rk] } : null;
}

function parsePairs(a) {
  let v = a;
  if (isPlainObject(v)) v = pick(v.pairs, v.value, v);
  const out = [];
  const fromString = (s) => {
    const m = String(s).trim().match(/^\(?([A-Za-z0-9]+)\)?\s*(?:[-–—:=]+>?|→|->|=>)\s*\(?([A-Za-z0-9]+)\)?$/);
    if (m) out.push([m[1], m[2]]);
    else out.push(null);
  };
  if (typeof v === 'string') v.split(/[,;\n]+/).filter((x) => x.trim()).forEach(fromString);
  else if (Array.isArray(v)) {
    for (const e of v) {
      if (typeof e === 'string') fromString(e);
      else if (isPlainObject(e)) {
        const l = pick(e.left, e.from, e.a, e.item);
        const r = pick(e.right, e.to, e.b, e.match);
        out.push(l !== undefined && r !== undefined ? [String(l), String(r)] : null);
      } else out.push(null);
    }
  } else if (isPlainObject(v)) {
    for (const [k, val] of Object.entries(v)) out.push(typeof val === 'string' || typeof val === 'number' ? [k, String(val)] : null);
  } else return null;
  return out.includes(null) || out.length === 0 ? null : out;
}

/**
 * Convert one raw item into a QuestionInput draft and validate it.
 *
 * @param {any} raw
 * @param {number} index
 * @param {{
 *   taxonomy: ReturnType<typeof import('./taxonomy.js').buildTaxonomyIndex>,
 *   strict?: boolean, restore?: boolean, origin?: string, status?: string,
 *   defaults?: {subject_id?:number|null, chapter_id?:number|null, topic_id?:number|null},
 *   defaultExams?: {exam_id:number, year?:number|null, paper?:string|null}[],
 *   answerIndexBase?: 0|1|null,
 * }} ctx
 */
export function normalizeImportItem(raw, index, ctx) {
  const errors = [];
  const warnings = [];
  const unresolved = {};
  const err = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  const fail = (message) => ({ index, ok: false, draft: null, errors: [{ path: '', message }], warnings, unresolved });

  if (!isPlainObject(raw)) return fail('Each question must be a JSON object.');

  for (const key of Object.keys(raw)) {
    if (KNOWN_KEYS.has(key) || IGNORED_KEYS.has(key)) continue;
    if (ctx.strict) err(key, `Unexpected field "${key}".`); else warn(key, `Unknown field "${key}" was ignored.`);
  }

  const q = raw.question;
  const qObj = isPlainObject(q);
  if (q !== undefined && !qObj && typeof q !== 'string') err('question_text', 'The question must be text.');
  const questionText = qObj ? pick(q.text, q.question, q.question_text) : pick(typeof q === 'string' ? q : undefined, raw.question_text, raw.text, raw.statement);

  // ---- type ---------------------------------------------------------------------------------------
  const rawType = pick(raw.type, raw.question_type, raw.type_code, qObj ? q.type : undefined);
  const rawOptions = pick(raw.options, raw.choices, qObj ? (q.options ?? q.choices) : undefined);
  const rawMatchSrc = pick(raw.match_items, raw.match, qObj ? (q.match_items ?? q.match) : undefined,
    raw.left !== undefined && raw.right !== undefined ? { left: raw.left, right: raw.right } : undefined);
  let typeCode = blank(rawType) ? null : resolveTypeCode(rawType);
  if (!blank(rawType) && !typeCode) {
    err('type_code', `Unknown question type "${String(rawType).slice(0, 40)}". Use one of: ${TYPE_CODES.join(', ')}.`);
  } else if (!typeCode) {
    if (ctx.strict) err('type_code', 'The question type is missing.');
    else if (rawMatchSrc) { typeCode = 'match_following'; warn('type_code', 'Type was missing; "match_following" was inferred from the two lists.'); }
    else if (Array.isArray(rawOptions) && rawOptions.length >= 2) { typeCode = 'mcq'; warn('type_code', 'Type was missing; "mcq" was inferred from the options.'); }
    else err('type_code', 'The question type is missing (for example "mcq", "short_answer").');
  }
  const typeDef = typeCode ? QUESTION_TYPES[typeCode] : null;

  // ---- text ----------------------------------------------------------------------------------------
  const context = cleanText(pick(raw.context, raw.passage, raw.case, qObj ? q.context : undefined));

  // ---- options / match lists / answer --------------------------------------------------------------
  const rawAnswer = pick(raw.answer, raw.correct_answer, raw.correct, undefined);
  let options = null;
  let match_items = null;
  let answer = null;

  const wantsChoice = typeDef && (typeDef.kind === 'choice' || (typeDef.kind === 'any' && Array.isArray(rawOptions) && rawOptions.length > 0));
  if (wantsChoice) {
    let list = Array.isArray(rawOptions) ? rawOptions : null;
    if (!list || list.length === 0) {
      if (typeCode === 'true_false') list = ['True', 'False'];
      else if (typeCode === 'assertion_reason') list = [...ASSERTION_REASON_OPTIONS];
      else err('options', 'Add the answer options.');
    }
    if (rawOptions !== undefined && rawOptions !== null && !Array.isArray(rawOptions)) err('options', 'Options must be a list.');
    if (list) {
      const built = buildOptions(list, err, !ctx.restore);
      options = built.options;
      const r = resolveChoiceAnswer(rawAnswer, typeCode, options, built.idMap, ctx);
      if (r.error) err('answer', r.error);
      else { answer = { value: r.id }; if (r.warning) warn('answer', r.warning); }
    }
  } else if (typeDef) {
    if (Array.isArray(rawOptions) && rawOptions.length > 0) err('options', `${typeDef.label} questions do not use options.`);
    if (typeDef.kind === 'text' || typeDef.kind === 'any') {
      let a = isPlainObject(rawAnswer) ? pick(rawAnswer.text, rawAnswer.value, rawAnswer.answer) : rawAnswer;
      if (Array.isArray(a) && typeCode === 'fill_blank') {
        a = a.map((x) => String(x ?? '').trim()).filter(Boolean).join('; ');
        warn('answer', 'Several blanks were joined with "; ".');
      }
      if (typeof a === 'number') a = String(a);
      const t = typeof a === 'string' ? cleanText(a) : null;
      if (t) answer = { text: t }; else err('answer', 'Write the answer.');
    } else if (typeDef.kind === 'numeric') {
      const n = resolveNumericAnswer(rawAnswer);
      if (!n) err('answer', 'The numerical answer must be a number (units can go in "unit").');
      else {
        answer = { number: n.number };
        if (n.unit) answer.unit = String(n.unit);
        if (n.tolerance !== undefined && n.tolerance !== null && n.tolerance !== '') answer.tolerance = n.tolerance;
      }
    } else if (typeDef.kind === 'match') {
      const lists = matchLists(rawMatchSrc);
      if (!lists) err('match_items', 'Add both lists (List I and List II).');
      else {
        const L = buildMatchSide(lists.left, !ctx.restore);
        const R = buildMatchSide(lists.right, !ctx.restore);
        match_items = {
          left: L.texts.map((text, i) => ({ id: OPTION_LETTERS[i] ?? String.fromCharCode(65 + i), text })),
          right: R.texts.map((text, i) => ({ id: String(i + 1), text })),
        };
        const pairs = parsePairs(rawAnswer);
        if (!pairs) err('answer', 'Match every item in List I to List II, e.g. {"A": "2", "B": "1"} or "A-2, B-1".');
        else {
          const leftId = (label) => {
            const k = String(label).trim().toUpperCase();
            const bySupplied = L.supplied.indexOf(k);
            if (bySupplied >= 0) return String.fromCharCode(65 + bySupplied);
            if (L.labels?.includes(k)) return String.fromCharCode(65 + L.labels.indexOf(k));
            if (/^[A-J]$/.test(k) && k.charCodeAt(0) - 65 < match_items.left.length) return k;
            const n = romanOrNumber(k);
            return n && n <= match_items.left.length ? String.fromCharCode(64 + n) : null;
          };
          const rightId = (label) => {
            const k = String(label).trim().toUpperCase();
            const bySupplied = R.supplied.indexOf(k);
            if (bySupplied >= 0) return String(bySupplied + 1);
            if (R.labels?.includes(k)) return String(R.labels.indexOf(k) + 1);
            const n = romanOrNumber(k);
            if (n && n <= match_items.right.length) return String(n);
            if (/^[A-J]$/.test(k) && k.charCodeAt(0) - 64 <= match_items.right.length) return String(k.charCodeAt(0) - 64);
            return null;
          };
          const out = {};
          let bad = false;
          for (const [l, r] of pairs) {
            const li = leftId(l);
            const ri = rightId(r);
            if (!li || !ri || out[li]) bad = true; else out[li] = ri;
          }
          if (bad) err('answer', 'Some pairs refer to items that do not exist (or an item is matched twice).');
          else answer = { pairs: out };
        }
      }
    }
  }

  // ---- classification ----------------------------------------------------------------------------------
  const cls = isPlainObject(raw.classification) ? raw.classification : {};
  const given = {
    subject: asName(pick(cls.subject, raw.subject)),
    chapter: asName(pick(cls.chapter, raw.chapter)),
    topic: asName(pick(cls.topic, raw.topic)),
  };
  const category = pick(cls.category, raw.category);
  const classification = resolveClassification(ctx.taxonomy, given, ctx.defaults ?? {});
  errors.push(...classification.errors);
  warnings.push(...classification.warnings);
  Object.assign(unresolved, classification.unresolved);

  // ---- exams -------------------------------------------------------------------------------------------------
  const refs = [];
  const addRef = (r) => { if (r !== null && r !== undefined && !(typeof r === 'string' && r.trim() === '')) refs.push(r); };
  const meta = isPlainObject(raw.metadata) ? raw.metadata : {};
  if (Array.isArray(raw.exams)) raw.exams.forEach(addRef);
  if (Array.isArray(raw.sources)) raw.sources.forEach(addRef);
  const examField = raw.exam;
  if (Array.isArray(examField)) examField.forEach(addRef);
  else if (isPlainObject(examField)) { if (!blank(asName(examField.name ?? examField.exam ?? examField.code))) addRef({ ...examField, year: pick(examField.year, raw.year), paper: pick(examField.paper, raw.paper) }); }
  else if (!blank(examField)) addRef(blank(raw.year) && blank(raw.paper) ? String(examField) : { exam: String(examField), year: raw.year, paper: raw.paper });

  const exams = [];
  const unresolvedExams = [];
  refs.forEach((ref, i) => {
    const r = resolveExamRef(ctx.taxonomy, ref);
    if (r.exam_id) exams.push({ exam_id: r.exam_id, year: r.year, paper: r.paper });
    else {
      err(`exams[${i}].exam_id`, r.errors[0]);
      unresolvedExams.push({ given: typeof ref === 'string' ? ref : (ref.exam ?? ref.name ?? ref.code), suggestions: r.suggestions });
    }
  });
  if (unresolvedExams.length) unresolved.exams = unresolvedExams;
  if (!refs.length && ctx.defaultExams?.length && String(category ?? '').toLowerCase() !== 'general') {
    exams.push(...ctx.defaultExams.map((e) => ({ exam_id: e.exam_id, year: e.year ?? null, paper: e.paper ?? null })));
  }
  if (category !== undefined && category !== null) {
    const c = String(category).toLowerCase().trim();
    if (c !== 'general' && c !== 'exam') warn('category', `Category "${String(category).slice(0, 30)}" is not "general" or "exam"; it was ignored.`);
    else if (c === 'general' && exams.length) warn('category', 'Marked "general" but exam appearances are listed; it will be shown as an exam question.');
    else if (c === 'exam' && !exams.length && !unresolvedExams.length) warn('category', 'Marked "exam" but no exam is named, so it will be shown as a general question.');
  }

  // ---- metadata --------------------------------------------------------------------------------------------------
  let difficulty = null;
  const rawDiff = pick(raw.difficulty, meta.difficulty, raw.level);
  if (!blank(rawDiff)) {
    difficulty = resolveDifficulty(rawDiff);
    if (difficulty === undefined) { difficulty = null; warn('difficulty', `Difficulty "${String(rawDiff).slice(0, 30)}" is not easy, medium or hard; it was left blank.`); }
  }
  let tags = normalizeTags(pick(raw.tags, meta.tags, []));
  if (tags.length > LIMITS.maxTags) { warn('tags', `Only the first ${LIMITS.maxTags} tags were kept.`); tags = tags.slice(0, LIMITS.maxTags); }
  const marksRaw = pick(raw.marks, meta.marks, raw.points);

  // ---- identity / status ----------------------------------------------------------------------------------
  const rawId = pick(raw.public_id, raw.id);
  let public_id;
  if (typeof rawId === 'string' && PUBLIC_ID_PATTERN.test(rawId)) {
    if (ctx.restore) public_id = rawId;
    else warn('id', `The ID ${rawId} was ignored; a new ID is assigned when the question is saved.`);
  }
  let status = ctx.status ?? 'draft';
  let origin = ctx.origin ?? 'json_import';
  if (ctx.restore) { status = pick(raw.status, status); origin = pick(raw.origin, origin); }
  else if (raw.status !== undefined) warn('status', 'The status in the file was ignored; imported questions start as drafts.');

  const sourceRaw = pick(raw.source_ref, raw.source);
  const draft = {
    ...(public_id ? { public_id } : {}),
    subject_id: classification.subject_id, chapter_id: classification.chapter_id, topic_id: classification.topic_id,
    type_code: typeCode, context, question_text: questionText === undefined || questionText === null ? '' : String(questionText),
    options, match_items, answer, explanation: cleanText(pick(raw.explanation, raw.solution, raw.rationale)),
    difficulty, marks: blank(marksRaw) ? null : marksRaw, tags, status, origin,
    source_ref: typeof sourceRaw === 'string' || typeof sourceRaw === 'number' ? String(sourceRaw) : null, exams,
  };
  if (sourceRaw !== undefined && sourceRaw !== null && draft.source_ref === null) warn('source_ref', 'The source must be text; it was ignored.');

  // ---- final validation (the same rules the database enforces) ----------------------------------------------
  const v = validateQuestionInput(draft, {
    taxonomy: ctx.taxonomy.tree,
    examIds: new Set(ctx.taxonomy.exams.map((e) => e.id)),
  });
  const seenPaths = new Set(errors.map((e) => e.path));
  for (const e of v.errors) if (!seenPaths.has(e.path)) errors.push(e);

  return {
    index, ok: errors.length === 0, draft: errors.length === 0 ? v.value : draft,
    errors, warnings, unresolved,
  };
}

// ---------------------------------------------------------------------------------------------
// 4. A whole payload
// ---------------------------------------------------------------------------------------------

const dupKey = (d) => matchKey([d.type_code, d.question_text, ...(d.options ?? []).map((o) => o.text)].join(' | '));

/** Summarise unresolved names across the batch so the admin can create them once. */
function summariseMissing(items) {
  const subjects = new Set();
  const chapters = new Map();
  const topics = new Map();
  for (const it of items) {
    const u = it.unresolved ?? {};
    if (u.subject) subjects.add(u.subject.given);
    if (u.chapter && !u.subject && it.draft?.subject_id) chapters.set(`${it.draft?.subject_id ?? ''}|${u.chapter.given}`, { subject_id: it.draft?.subject_id ?? null, name: u.chapter.given });
    if (u.topic && it.draft?.chapter_id) topics.set(`${it.draft.chapter_id}|${u.topic.given}`, { chapter_id: it.draft.chapter_id, name: u.topic.given });
  }
  return { subjects: [...subjects], chapters: [...chapters.values()], topics: [...topics.values()] };
}

/**
 * Parse, detect and normalise a whole payload.
 * @param {string} text
 * @param {Parameters<typeof normalizeImportItem>[2]} ctx
 */
export function importQuestions(text, ctx) {
  const empty = { ok: false, fatal: null, notes: [], format: null, items: [], summary: { total: 0, valid: 0, invalid: 0, warned: 0 }, missing: { subjects: [], chapters: [], topics: [] } };
  const maxBytes = ctx.restore ? LIMITS.restoreBytesMax : LIMITS.importBytesMax;
  const maxItems = ctx.restore ? LIMITS.restoreItemsMax : LIMITS.importItemsMax;
  if (typeof text === 'string' && new TextEncoder().encode(text).length > maxBytes) {
    return { ...empty, fatal: { message: `That is more than ${Math.round(maxBytes / 1024)} KB. Split it into smaller files${ctx.restore ? ' (export one backup per subject)' : ''}.`, line: null, column: null } };
  }
  const parsed = parseJsonLoose(text);
  if (!parsed.ok) return { ...empty, fatal: parsed.error };
  const shape = detectShape(parsed.value);
  if (shape.error) return { ...empty, notes: parsed.notes, fatal: { message: shape.error, line: null, column: null } };
  if (shape.items.length === 0) return { ...empty, notes: parsed.notes, format: shape.format, fatal: { message: 'The file contains no questions.', line: null, column: null } };
  if (shape.items.length > maxItems) {
    return { ...empty, notes: parsed.notes, format: shape.format, fatal: { message: `That file has ${shape.items.length} questions; the limit is ${maxItems} at a time. Split it${ctx.restore ? ' (export one backup per subject or status)' : ''}.`, line: null, column: null } };
  }

  const answerIndexBase = ctx.answerIndexBase ?? (shape.format === EXPORT_FORMATS.atomicMinds.format ? 0 : null);
  const items = shape.items.map((raw, i) => normalizeImportItem(raw, i, { ...ctx, answerIndexBase }));

  const done = finalizeBatch(items);
  return { ok: true, fatal: null, notes: parsed.notes, format: shape.format, ...done };
}

/**
 * Batch-level checks shared by JSON import and AI extraction: warn about repeats inside the batch,
 * count results and collect unresolved names.
 */
export function finalizeBatch(items) {
  // Same question twice inside one batch: warn on the later copy (the database would reject it on save).
  const seen = new Map();
  for (const it of items) {
    if (!it.draft?.question_text) continue;
    const k = dupKey(it.draft);
    if (seen.has(k)) it.warnings.push({ path: 'question_text', message: `Same as question ${seen.get(k) + 1} in this batch.` });
    else seen.set(k, it.index);
  }
  const valid = items.filter((i) => i.ok).length;
  return {
    items,
    summary: { total: items.length, valid, invalid: items.length - valid, warned: items.filter((i) => i.warnings.length).length },
    missing: summariseMissing(items),
  };
}
