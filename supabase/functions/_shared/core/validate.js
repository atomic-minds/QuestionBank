// Validation of a question in its internal (id-based) form, called a "QuestionInput".
//
// This mirrors the rules enforced by the database trigger (supabase/migrations/0001_schema.sql)
// so that mistakes are caught early with friendly, field-level messages. The database remains
// the last line of defence: nothing here is trusted for security.
import {
  ASSERTION_REASON_OPTIONS, DIFFICULTIES, LIMITS, OPTION_LETTERS, ORIGINS, PUBLIC_ID_PATTERN,
  QUESTION_TYPES, STATUSES, UUID_PATTERN,
} from './constants.js';
import { cleanText, exactKey, isInt, isPlainObject, normalizeTags } from './text.js';

/** @typedef {{path:string, message:string}} FieldError */

const ALLOWED_KEYS = new Set([
  'id', 'public_id', 'expected_version', 'subject_id', 'chapter_id', 'topic_id', 'type_code', 'context',
  'question_text', 'options', 'match_items', 'answer', 'explanation', 'difficulty', 'marks', 'tags', 'status',
  'origin', 'source_ref', 'exams',
]);

/** A blank, structurally valid draft for the manual entry form. */
export function emptyQuestionInput() {
  return {
    subject_id: null, chapter_id: null, topic_id: null, type_code: 'mcq', context: null, question_text: '',
    options: ['', '', '', ''].map((text, i) => ({ id: OPTION_LETTERS[i], text })),
    match_items: null, answer: { value: 'A' }, explanation: null, difficulty: null, marks: null, tags: [],
    status: 'draft', origin: 'manual', source_ref: null, exams: [],
  };
}

/** Default option list for a type when switching the type in the editor. */
export function defaultOptionsFor(typeCode) {
  if (typeCode === 'true_false') return [{ id: 'A', text: 'True' }, { id: 'B', text: 'False' }];
  if (typeCode === 'assertion_reason') return ASSERTION_REASON_OPTIONS.map((text, i) => ({ id: OPTION_LETTERS[i], text }));
  if (typeCode === 'mcq') return ['', '', '', ''].map((text, i) => ({ id: OPTION_LETTERS[i], text }));
  return null;
}

function findInTree(tree, subjectId, chapterId, topicId) {
  const subject = (tree ?? []).find((s) => s.id === subjectId);
  const chapter = subject?.chapters?.find((c) => c.id === chapterId);
  const topic = chapter?.topics?.find((t) => t.id === topicId);
  return { subject, chapter, topic };
}

function letterRange(n) {
  return n <= 1 ? 'A' : `${OPTION_LETTERS[0]}–${OPTION_LETTERS[n - 1]}`;
}

/**
 * Validate and normalise a QuestionInput.
 * @param {any} input
 * @param {{taxonomy?: any[]|null, examIds?: Set<number>|null}} [ctx]
 * @returns {{ok: boolean, errors: FieldError[], value: any}}
 */
export function validateQuestionInput(input, ctx = {}) {
  /** @type {FieldError[]} */
  const errors = [];
  const err = (path, message) => errors.push({ path, message });

  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'A question must be a JSON object.' }], value: null };
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) err(key, `Unknown field "${key}".`);
  }

  const value = {};

  // ---- identity (optional) --------------------------------------------------
  if (input.id !== undefined && input.id !== null) {
    if (typeof input.id !== 'string' || !UUID_PATTERN.test(input.id)) err('id', 'id must be a UUID.');
    else value.id = input.id.toLowerCase();
  }
  if (input.expected_version !== undefined && input.expected_version !== null) {
    if (!isInt(input.expected_version) || input.expected_version < 1) err('expected_version', 'expected_version must be a positive integer.');
    else value.expected_version = input.expected_version;
  }
  if (input.public_id !== undefined && input.public_id !== null && input.public_id !== '') {
    if (typeof input.public_id !== 'string' || !PUBLIC_ID_PATTERN.test(input.public_id)) err('public_id', 'public_id must look like QB-CHEM-000123.');
    else value.public_id = input.public_id;
  }

  // ---- classification ---------------------------------------------------------
  for (const key of ['subject_id', 'chapter_id']) {
    if (!isInt(input[key]) || input[key] < 1) err(key, key === 'subject_id' ? 'Choose a subject.' : 'Choose a chapter.');
    else value[key] = input[key];
  }
  if (input.topic_id === null || input.topic_id === undefined || input.topic_id === '') value.topic_id = null;
  else if (!isInt(input.topic_id) || input.topic_id < 1) err('topic_id', 'Topic is invalid.');
  else value.topic_id = input.topic_id;

  if (ctx.taxonomy && value.subject_id && value.chapter_id) {
    const { subject, chapter, topic } = findInTree(ctx.taxonomy, value.subject_id, value.chapter_id, value.topic_id);
    if (!subject) err('subject_id', 'This subject does not exist or is inactive.');
    else if (!chapter) err('chapter_id', 'This chapter does not belong to the chosen subject (or is inactive).');
    else if (value.topic_id && !topic) err('topic_id', 'This topic does not belong to the chosen chapter (or is inactive).');
  }

  // ---- type ----------------------------------------------------------------------
  const typeDef = QUESTION_TYPES[input.type_code];
  if (!typeDef) err('type_code', `Question type must be one of: ${Object.keys(QUESTION_TYPES).join(', ')}.`);
  else value.type_code = input.type_code;

  // ---- text fields -----------------------------------------------------------------
  const text = cleanText(input.question_text);
  if (!text) err('question_text', 'The question text cannot be empty.');
  else if (text.length > LIMITS.questionText) err('question_text', `The question is too long (max ${LIMITS.questionText} characters).`);
  else value.question_text = text;

  const context = cleanText(input.context);
  if (context && context.length > LIMITS.context) err('context', `Context is too long (max ${LIMITS.context} characters).`);
  value.context = context;
  if (typeDef?.requiresContext && !context) err('context', 'Case-based questions need the passage/case text.');

  const explanation = cleanText(input.explanation);
  if (explanation && explanation.length > LIMITS.explanation) err('explanation', `Explanation is too long (max ${LIMITS.explanation} characters).`);
  value.explanation = explanation;

  const sourceRef = cleanText(input.source_ref);
  if (sourceRef && sourceRef.length > LIMITS.sourceRef) err('source_ref', `Source is too long (max ${LIMITS.sourceRef} characters).`);
  value.source_ref = sourceRef;

  // ---- options / match items / answer, by answer kind --------------------------------
  value.options = null;
  value.match_items = null;
  const rawOptions = Array.isArray(input.options) && input.options.length > 0 ? input.options : null;
  const usesChoice = typeDef && (typeDef.kind === 'choice' || (typeDef.kind === 'any' && rawOptions !== null));

  if (typeDef && !usesChoice && rawOptions) err('options', `${typeDef.label} questions do not use options.`);
  if (typeDef && typeDef.kind !== 'match' && input.match_items) err('match_items', `${typeDef.label} questions do not use match lists.`);
  if (input.options !== null && input.options !== undefined && !Array.isArray(input.options)) err('options', 'Options must be a list.');

  if (usesChoice) {
    const options = [];
    const seen = new Set();
    if (!rawOptions) err('options', 'Add the answer options.');
    else {
      const n = rawOptions.length;
      if (n < Math.max(typeDef.minOptions, 2) || n > typeDef.maxOptions) {
        err('options', `${typeDef.label} needs ${Math.max(typeDef.minOptions, 2) === typeDef.maxOptions ? typeDef.maxOptions : `${Math.max(typeDef.minOptions, 2)} to ${typeDef.maxOptions}`} options (you have ${n}).`);
      }
      rawOptions.forEach((opt, i) => {
        const id = OPTION_LETTERS[i];
        const t = cleanText(isPlainObject(opt) ? opt.text : opt);
        if (isPlainObject(opt) && opt.id !== undefined && opt.id !== id) err(`options[${i}].id`, `Option ${i + 1} must be labelled ${id}.`);
        if (!t) err(`options[${i}].text`, `Option ${id ?? i + 1} is empty.`);
        else if (t.length > LIMITS.optionText) err(`options[${i}].text`, `Option ${id} is too long (max ${LIMITS.optionText} characters).`);
        else if (seen.has(exactKey(t))) err(`options[${i}].text`, `Option ${id} repeats another option.`);
        else seen.add(exactKey(t));
        options.push({ id: id ?? String(i + 1), text: t ?? '' });
      });
      value.options = options;
    }

    const answerValue = isPlainObject(input.answer) ? input.answer.value : undefined;
    const keys = isPlainObject(input.answer) ? Object.keys(input.answer) : [];
    if (typeof answerValue !== 'string' || keys.length !== 1 || !(value.options ?? []).some((o) => o.id === answerValue)) {
      err('answer', `Choose the correct answer (${letterRange((value.options ?? []).length || 4)}).`);
    } else value.answer = { value: answerValue };
  } else if (typeDef?.kind === 'text' || typeDef?.kind === 'any') {
    const a = isPlainObject(input.answer) ? cleanText(input.answer.text) : null;
    if (!a) err('answer', 'Write the answer.');
    else if (a.length > LIMITS.textAnswer) err('answer', `The answer is too long (max ${LIMITS.textAnswer} characters).`);
    else value.answer = { text: a };
  } else if (typeDef?.kind === 'numeric') {
    const a = input.answer;
    const num = isPlainObject(a) ? a.number : undefined;
    if (typeof num !== 'number' || !Number.isFinite(num)) err('answer', 'The numerical answer must be a number.');
    else {
      const out = { number: num };
      if (isPlainObject(a) && a.unit !== undefined && a.unit !== null && String(a.unit).trim() !== '') {
        const unit = String(a.unit).trim();
        if (unit.length > 20) err('answer.unit', 'The unit is too long (max 20 characters).');
        else out.unit = unit;
      }
      if (isPlainObject(a) && a.tolerance !== undefined && a.tolerance !== null && a.tolerance !== '') {
        if (typeof a.tolerance !== 'number' || !(a.tolerance >= 0)) err('answer.tolerance', 'Tolerance must be a number that is 0 or more.');
        else out.tolerance = a.tolerance;
      }
      value.answer = out;
    }
  } else if (typeDef?.kind === 'match') {
    validateMatch(input, value, err);
  } else if (!typeDef) {
    value.answer = input.answer ?? null;
  }

  // ---- metadata ---------------------------------------------------------------------------
  if (input.difficulty === null || input.difficulty === undefined || input.difficulty === '') value.difficulty = null;
  else if (!DIFFICULTIES.includes(input.difficulty)) err('difficulty', `Difficulty must be ${DIFFICULTIES.join(', ')}.`);
  else value.difficulty = input.difficulty;

  if (input.marks === null || input.marks === undefined || input.marks === '') value.marks = null;
  else {
    const m = typeof input.marks === 'string' ? Number(input.marks) : input.marks;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > LIMITS.marksMax) err('marks', `Marks must be more than 0 and at most ${LIMITS.marksMax}.`);
    else if (Math.abs(m * 100 - Math.round(m * 100)) > 1e-9) err('marks', 'Marks can have at most 2 decimal places.');
    else value.marks = m;
  }

  const tags = normalizeTags(input.tags ?? []);
  if (tags.length > LIMITS.maxTags) err('tags', `Use at most ${LIMITS.maxTags} tags (you have ${tags.length}).`);
  value.tags = tags.slice(0, LIMITS.maxTags);

  value.status = input.status ?? 'draft';
  if (!STATUSES.includes(value.status)) err('status', `Status must be ${STATUSES.join(', ')}.`);
  value.origin = input.origin ?? 'manual';
  if (!ORIGINS.includes(value.origin)) err('origin', `Origin must be ${ORIGINS.join(', ')}.`);

  // ---- exam appearances ----------------------------------------------------------------------
  value.exams = [];
  const rawExams = input.exams ?? [];
  if (!Array.isArray(rawExams)) err('exams', 'Exams must be a list.');
  else {
    if (rawExams.length > LIMITS.maxExamsPerQuestion) err('exams', `At most ${LIMITS.maxExamsPerQuestion} exam appearances per question.`);
    const seen = new Set();
    rawExams.forEach((e, i) => {
      if (!isPlainObject(e) || !isInt(e.exam_id) || e.exam_id < 1) { err(`exams[${i}].exam_id`, 'Choose an exam.'); return; }
      if (ctx.examIds && !ctx.examIds.has(e.exam_id)) err(`exams[${i}].exam_id`, 'This exam does not exist or is inactive.');
      let year = null;
      if (e.year !== null && e.year !== undefined && e.year !== '') {
        year = typeof e.year === 'string' ? Number(e.year) : e.year;
        if (!isInt(year) || year < LIMITS.yearMin || year > LIMITS.yearMax) { err(`exams[${i}].year`, `Year must be between ${LIMITS.yearMin} and ${LIMITS.yearMax}.`); year = null; }
      }
      const paper = cleanText(e.paper);
      if (paper && paper.length > LIMITS.paper) err(`exams[${i}].paper`, `Paper/shift is too long (max ${LIMITS.paper} characters).`);
      const key = `${e.exam_id}|${year ?? ''}|${paper ?? ''}`;
      if (seen.has(key)) err(`exams[${i}]`, 'This exam, year and paper is listed twice.');
      seen.add(key);
      value.exams.push({ exam_id: e.exam_id, year, paper: paper ?? null });
    });
  }

  // Omitted entirely = "leave the existing appearances alone" (the database honours the same rule).
  if (input.exams === undefined) delete value.exams;

  return { ok: errors.length === 0, errors, value };
}

function validateMatch(input, value, err) {
  const mi = input.match_items;
  if (!isPlainObject(mi) || !Array.isArray(mi.left) || !Array.isArray(mi.right)) {
    err('match_items', 'Add both lists (List I and List II).');
    return;
  }
  const side = (items, name, idOf) => {
    if (items.length < LIMITS.matchItemsMin || items.length > LIMITS.matchItemsMax) {
      err(`match_items.${name}`, `Each list needs ${LIMITS.matchItemsMin} to ${LIMITS.matchItemsMax} items.`);
    }
    return items.map((item, i) => {
      const t = cleanText(isPlainObject(item) ? item.text : item);
      if (!t) err(`match_items.${name}[${i}]`, `${name === 'left' ? 'List I' : 'List II'} item ${i + 1} is empty.`);
      else if (t.length > LIMITS.matchItemText) err(`match_items.${name}[${i}]`, `Item ${i + 1} is too long.`);
      return { id: idOf(i), text: t ?? '' };
    });
  };
  const left = side(mi.left, 'left', (i) => OPTION_LETTERS[i] ?? String.fromCharCode(65 + i));
  const right = side(mi.right, 'right', (i) => String(i + 1));
  value.match_items = { left, right };

  const pairs = isPlainObject(input.answer) ? input.answer.pairs : undefined;
  if (!isPlainObject(pairs)) { err('answer', 'Match every item in List I to an item in List II.'); return; }
  const rightIds = new Set(right.map((r) => r.id));
  const out = {};
  let bad = Object.keys(pairs).length !== left.length;
  for (const l of left) {
    if (typeof pairs[l.id] !== 'string' || !rightIds.has(pairs[l.id])) bad = true;
    else out[l.id] = pairs[l.id];
  }
  if (bad) err('answer', 'Match every item in List I to an item in List II.');
  else value.answer = { pairs: out };
}

/** Fast structural gate used before spending a database round trip. */
export function summarizeErrors(errors) {
  return errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ');
}
