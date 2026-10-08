// Turns the AI's JSON into reviewable drafts using the SAME importer as pasted JSON.
// The AI never gets to write to the database: everything it says is checked here first, and a
// human approves the result in the review screen.
import { isPlainObject } from '../text.js';
import { finalizeBatch, normalizeImportItem } from '../importer.js';
import { AI_MAX_QUESTIONS, AI_QUESTION_KEYS } from './schema.js';
import { AiError } from './provider.js';

const ALLOWED_TOP = new Set(['questions', 'image_issues']);
const ALLOWED_Q = new Set(AI_QUESTION_KEYS);
const SOURCES_ANSWER = new Set(['extracted', 'inferred', 'none']);
const SOURCES_EXPLANATION = new Set(['extracted', 'generated', 'none']);

const orUndef = (v) => (v === null || v === undefined ? undefined : v);

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
      question: orUndef(q.question),
      context: orUndef(q.context),
      options: Array.isArray(q.options) && q.options.length ? q.options : undefined,
      match: Array.isArray(q.match_left) && Array.isArray(q.match_right) && q.match_left.length ? { left: q.match_left, right: q.match_right } : undefined,
      answer: orUndef(q.answer),
      explanation: orUndef(q.explanation),
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
      explanation_source: q.explanation === null || q.explanation === undefined ? 'none' : eSrc,
      notes: typeof q.notes === 'string' && q.notes.trim() ? q.notes.trim().slice(0, 500) : null,
    };
    return item;
  });

  return { ok: true, fatal: null, notes, format: 'ai', ...finalizeBatch(items) };
}
