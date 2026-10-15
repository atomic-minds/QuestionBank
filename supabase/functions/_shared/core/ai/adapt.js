// Turns the AI's JSON into reviewable drafts using the SAME importer as pasted JSON.
// The AI never gets to write to the database: everything it says is checked here first, and a
// human approves the result in the review screen.
import { isPlainObject } from '../text.js';
import { finalizeBatch, normalizeImportItem } from '../importer.js';
import { AI_MAX_QUESTIONS, AI_QUESTION_KEYS } from './schema.js';
import { AiError } from './provider.js';
import { repairTex } from '../chem.js';
import { QUESTION_TYPES } from '../constants.js';
import { SOLVE_KEYS, SOLVE_MAX_ITEMS } from './schema.js';

const ALLOWED_TOP = new Set(['questions', 'image_issues']);
const ALLOWED_Q = new Set(AI_QUESTION_KEYS);
const SOURCES_ANSWER = new Set(['extracted', 'inferred', 'none']);
const SOURCES_EXPLANATION = new Set(['extracted', 'generated', 'none']);

const orUndef = (v) => (v === null || v === undefined ? undefined : v);
const fixText = (v) => (typeof v === 'string' ? repairTex(v) : v);
/** A short or long answer IS its own explanation, so an explanation the AI adds there is only noise (a topic name, a repeat). */
const NO_EXPLANATION_TYPES = new Set(['short_answer', 'long_answer']);

/**
 * The number printed beside a question on paper ("19.", "Q.5", "3)", "Question 2:") is not part of the question,
 * and the app numbers questions itself. Part labels such as "(a)" or "(i)" are kept.
 */
const DIGIT = '[0-9\\u09E6-\\u09EF\\u0966-\\u096F]';
const LEAD_NO = new RegExp(`^\\s*(?:(?:Q(?:uestion|ns?)?|Ques)\\.?\\s*${DIGIT}{1,3}\\s*[.):\\-]?|${DIGIT}{1,3}\\s*[.):])[ \\t]+(?=\\S)`, 'i');
export const stripQuestionNumber = (t) => (typeof t === 'string' ? t.replace(LEAD_NO, '') : t);

const fixList = (v) => (Array.isArray(v) ? v.map(fixText) : v);

/**
 * @param {any} json  parsed model output
 * @param {{taxonomy: any, defaults?: any}} ctx
 */
export function adaptAiOutput(json, ctx) {
  if (!isPlainObject(json) || !Array.isArray(json.questions)) {
    throw new AiError('AI_BAD_OUTPUT', 'The AI answered in an unexpected format. Try again, or use Import JSON.');
  }
  const stray = Object.keys(json).filter((k) => !ALLOWED_TOP.has(k));
  if (stray.length) throw new AiError('AI_BAD_OUTPUT', 'The AI answered with unexpected fields. Try again, or use Import JSON.');

  const idx = ctx.taxonomy;
  const notes = [];
  if (typeof json.image_issues === 'string' && json.image_issues.trim()) notes.push(json.image_issues.trim().slice(0, 500));
  let list = json.questions;
  if (list.length > AI_MAX_QUESTIONS) {
    list = list.slice(0, AI_MAX_QUESTIONS);
    notes.push(`The AI returned more than ${AI_MAX_QUESTIONS} questions; only the first ${AI_MAX_QUESTIONS} were kept.`);
  }

  const items = list.map((q, i) => {
    if (!isPlainObject(q)) {
      return { index: i, ok: false, draft: null, errors: [{ path: '', message: 'The AI returned something that is not a question.' }], warnings: [], unresolved: {}, meta: null };
    }
    const extra = Object.keys(q).filter((k) => !ALLOWED_Q.has(k));

    const chapter = q.chapter_id ? idx.chapterById.get(q.chapter_id) : null;
    const subject = q.subject_id ? idx.subjectById.get(q.subject_id) : chapter?._subject;
    const topic = q.topic_id ? idx.topicById.get(q.topic_id) : null;
    const nameOf = (id, node) => (id === null || id === undefined ? undefined : (node?.name ?? `#${id}`));

    const raw = {
      type: q.type,
      question: orUndef(stripQuestionNumber(fixText(q.question))),
      context: orUndef(fixText(q.context)),
      options: Array.isArray(q.options) && q.options.length ? fixList(q.options) : undefined,
      match: Array.isArray(q.match_left) && Array.isArray(q.match_right) && q.match_left.length ? { left: fixList(q.match_left), right: fixList(q.match_right) } : undefined,
      answer: orUndef(fixText(q.answer)),
      explanation: NO_EXPLANATION_TYPES.has(q.type) && q.explanation_source !== 'extracted' ? undefined : orUndef(fixText(q.explanation)),
      subject: nameOf(q.subject_id ?? (chapter ? subject?.id : undefined), subject),
      chapter: nameOf(q.chapter_id, chapter),
      topic: nameOf(q.topic_id, topic),
      difficulty: q.difficulty === 'unknown' ? undefined : orUndef(q.difficulty),
      marks: orUndef(q.marks),
      tags: Array.isArray(q.tags) ? q.tags : [],
      exams: Array.isArray(q.exams)
        ? q.exams.filter(isPlainObject).map((e) => ({ exam: idx.examById.get(e.exam_id)?.name ?? `#${e.exam_id}`, year: orUndef(e.year), paper: orUndef(e.paper) }))
        : [],
    };

    const item = normalizeImportItem(raw, i, {
      taxonomy: idx, strict: true, origin: 'ai_image', status: 'draft', defaults: ctx.defaults,
    });
    for (const k of extra) item.errors.push({ path: k, message: `Unexpected field "${k}" from the AI.` });
    if (extra.length) item.ok = false;

    const aSrc = SOURCES_ANSWER.has(q.answer_source) ? q.answer_source : 'none';
    const eSrc = SOURCES_EXPLANATION.has(q.explanation_source) ? q.explanation_source : 'none';
    item.meta = {
      answer_source: q.answer === null || q.answer === undefined ? 'none' : aSrc,
      explanation_source: item.draft?.explanation ? eSrc : 'none',
      has_figure: q.has_figure === true,
      notes: typeof q.notes === 'string' && q.notes.trim() ? q.notes.trim().slice(0, 500) : null,
    };
    return item;
  });

  return { ok: true, fatal: null, notes, format: 'ai', ...finalizeBatch(items) };
}


/**
 * Turns the AI's solutions into checked answers. Each question is run through the SAME importer as everything else,
 * so a letter must be one of the real options, a numerical answer must be a number, and so on.
 * @param {any} json    parsed model output ({solutions: [...]})
 * @param {{key:string, type:string, question:string, context?:string|null, options?:string[]|null, match_left?:string[]|null, match_right?:string[]|null}[]} asked
 * @param {{taxonomy: any}} ctx   an (empty is fine) taxonomy index, only needed by the importer
 */
export function adaptSolveOutput(json, asked, ctx) {
  if (!isPlainObject(json) || !Array.isArray(json.solutions)) {
    throw new AiError('AI_BAD_OUTPUT', 'The AI answered in an unexpected format. Try again.');
  }
  const byKey = new Map();
  for (const s of json.solutions.slice(0, SOLVE_MAX_ITEMS * 2)) if (isPlainObject(s) && typeof s.key === 'string') byKey.set(s.key, s);

  const solutions = asked.map((a, i) => {
    const s = byKey.get(a.key);
    if (!s) return { key: a.key, ok: false, answer: null, explanation: null, confident: false, notes: null, errors: [{ path: 'answer', message: 'The AI did not answer this question.' }] };
    const extra = Object.keys(s).filter((k) => !SOLVE_KEYS.includes(k));
    const notes = typeof s.notes === 'string' && s.notes.trim() ? s.notes.trim().slice(0, 500) : null;
    const base = { key: a.key, confident: s.confident === true, notes };
    if (extra.length) return { ...base, ok: false, answer: null, explanation: null, errors: [{ path: 'answer', message: 'The AI answered with unexpected fields. Try again.' }] };
    if (s.answer === null || s.answer === undefined || String(s.answer).trim() === '') {
      return { ...base, ok: false, answer: null, explanation: typeof s.explanation === 'string' ? repairTex(s.explanation) : null, confident: false,
        errors: [{ path: 'answer', message: notes ?? 'The AI could not solve this question from what is given.' }] };
    }
    const raw = {
      type: a.type,
      question: a.question,
      context: a.context ?? undefined,
      options: Array.isArray(a.options) && a.options.length ? a.options : undefined,
      match: Array.isArray(a.match_left) && Array.isArray(a.match_right) && a.match_left.length ? { left: a.match_left, right: a.match_right } : undefined,
      answer: fixText(s.answer),
      explanation: typeof s.explanation === 'string' && s.explanation.trim() && !NO_EXPLANATION_TYPES.has(a.type) ? fixText(s.explanation) : undefined,
    };
    const item = normalizeImportItem(raw, i, { taxonomy: ctx.taxonomy, strict: false, origin: 'ai_image', status: 'draft' });
    const answerErrors = item.errors.filter((e) => /^(answer|options|match)/.test(e.path));
    if (answerErrors.length || !item.draft) {
      return { ...base, ok: false, answer: null, explanation: raw.explanation ?? null, confident: false, errors: answerErrors.length ? answerErrors : [{ path: 'answer', message: 'The AI answer could not be used.' }] };
    }
    return { ...base, ok: true, answer: item.draft.answer, explanation: item.draft.explanation ?? null, errors: [] };
  });
  return { ok: true, solutions };
}

export const SOLVE_TYPES = new Set(Object.keys(QUESTION_TYPES));
