// Export adapters: the Question Bank is the master; consumers get a stable, versioned contract.
//
//   atomic-minds-question-bank v1   what Atomic Minds TMS imports (objective questions by default)
//   plain text                      human-readable, copy/paste friendly
//   qb-backup v1                    everything needed to restore this bank into another one
//
// Inputs are question objects exactly as returned by the qb_search_questions() RPC.
import { EXPORT_FORMATS, OPTION_LETTERS, QUESTION_TYPES } from './constants.js';

export const GENERATOR = Object.freeze({ name: 'question-bank', version: '1.0.0' });

const names = (idx, q) => {
  const subject = idx?.subjectById?.get(q.subject_id);
  const chapter = idx?.chapterById?.get(q.chapter_id);
  const topic = q.topic_id ? idx?.topicById?.get(q.topic_id) : null;
  return { subject: subject?.name ?? null, chapter: chapter?.name ?? null, topic: topic?.name ?? null, subjectCode: subject?.code ?? null };
};

const sourcesOf = (q) => (q.exams ?? []).map((e) => ({ exam: e.name ?? e.code, year: e.year ?? null, paper: e.paper ?? null }));
const isObjective = (q) => Array.isArray(q.options) && q.options.length > 0;

/** @returns {number} 0-based index of the correct option */
const answerIndex = (q) => q.options.findIndex((o) => o.id === q.answer?.value);

/** One question in the Atomic Minds v1 shape. Every key is always present (null/[] when not applicable). */
export function toAtomicMinds(q, idx) {
  const n = names(idx, q);
  const objective = isObjective(q);
  const kind = QUESTION_TYPES[q.type_code]?.kind;
  return {
    id: q.public_id,
    revision: q.version,
    type: q.type_code,
    question: q.question_text,
    context: q.context ?? null,
    options: objective ? q.options.map((o) => o.text) : [],
    answer: objective ? answerIndex(q) : null,
    answer_text: !objective && (kind === 'text' || kind === 'any') ? (q.answer?.text ?? null) : null,
    answer_numeric: kind === 'numeric'
      ? { value: q.answer?.number ?? null, unit: q.answer?.unit ?? null, tolerance: q.answer?.tolerance ?? null }
      : null,
    match: kind === 'match' ? { left: q.match_items.left.map((m) => m.text), right: q.match_items.right.map((m) => m.text) } : null,
    answer_pairs: kind === 'match'
      ? q.match_items.left.map((l, i) => [i, q.match_items.right.findIndex((r) => r.id === q.answer?.pairs?.[l.id])])
      : null,
    explanation: q.explanation ?? null,
    subject: n.subject,
    chapter: n.chapter,
    topic: n.topic,
    category: (q.exams ?? []).length ? 'exam' : 'general',
    difficulty: q.difficulty ?? null,
    marks: q.marks === null || q.marks === undefined ? null : Number(q.marks),
    tags: q.tags ?? [],
    sources: sourcesOf(q),
  };
}

/**
 * @param {any[]} questions
 * @param {any} idx taxonomy index (for names)
 * @param {{includeSubjective?: boolean, now?: Date, filters?: any}} [opts]
 * @returns {{document: any, skipped: {id:string, reason:string}[]}}
 */
export function buildAtomicMindsExport(questions, idx, opts = {}) {
  const skipped = [];
  const out = [];
  for (const q of questions) {
    if (!isObjective(q) && !opts.includeSubjective) {
      skipped.push({ id: q.public_id, reason: `${QUESTION_TYPES[q.type_code]?.label ?? q.type_code} has no fixed options` });
      continue;
    }
    out.push(toAtomicMinds(q, idx));
  }
  return {
    document: {
      format: EXPORT_FORMATS.atomicMinds.format,
      version: EXPORT_FORMATS.atomicMinds.version,
      exported_at: (opts.now ?? new Date()).toISOString(),
      generator: GENERATOR,
      count: out.length,
      questions: out,
    },
    skipped,
  };
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

function formatNumber(a) {
  const base = `${a.number}${a.unit ? ` ${a.unit}` : ''}`;
  return a.tolerance !== undefined && a.tolerance !== null ? `${base} (±${a.tolerance})` : base;
}

/**
 * Human-readable export, following the layout:
 *
 *   Q1. Question
 *
 *   A. option
 *   B. option
 *
 *   Ans: B
 *
 *   Exp: explanation
 *
 * @param {{includeAnswers?:boolean, includeExplanations?:boolean, includeIds?:boolean}} [opts]
 */
export function buildPlainText(questions, opts = {}) {
  const { includeAnswers = true, includeExplanations = true, includeIds = false } = opts;
  const blocks = questions.map((q, i) => {
    const parts = [];
    if (q.context) parts.push(q.context);
    parts.push(`Q${i + 1}. ${q.question_text}`);

    if (isObjective(q)) {
      parts.push(q.options.map((o) => `${o.id}. ${o.text}`).join('\n'));
    } else if (q.match_items) {
      parts.push(['List I', ...q.match_items.left.map((m) => `${m.id}. ${m.text}`)].join('\n'));
      parts.push(['List II', ...q.match_items.right.map((m) => `${m.id}. ${m.text}`)].join('\n'));
    }

    if (includeAnswers) {
      const a = q.answer ?? {};
      let line;
      if (a.value !== undefined) line = a.value;
      else if (a.number !== undefined) line = formatNumber(a);
      else if (a.pairs) line = q.match_items.left.map((l) => `${l.id}-${a.pairs[l.id]}`).join(', ');
      else line = a.text ?? '';
      parts.push(`Ans: ${line}`);
    }
    if (includeExplanations && q.explanation) parts.push(`Exp: ${q.explanation}`);
    if (includeIds) parts.push(`ID: ${q.public_id}`);
    return parts.join('\n\n');
  });
  return blocks.length ? `${blocks.join('\n\n\n')}\n` : '';
}

// ---------------------------------------------------------------------------------------------
// Backup (re-importable)
// ---------------------------------------------------------------------------------------------

/** One question in the flat shape the importer reads back in restore mode. */
export function toBackupItem(q, idx) {
  const n = names(idx, q);
  const kind = QUESTION_TYPES[q.type_code]?.kind;
  let answer = null;
  if (q.answer?.value !== undefined) answer = q.answer.value;
  else if (q.answer?.text !== undefined) answer = q.answer.text;
  else if (q.answer?.number !== undefined) answer = { number: q.answer.number, unit: q.answer.unit ?? null, tolerance: q.answer.tolerance ?? null };
  else if (q.answer?.pairs) answer = q.answer.pairs;
  return {
    id: q.public_id,
    status: q.status,
    origin: q.origin,
    type: q.type_code,
    question: q.question_text,
    context: q.context ?? null,
    options: isObjective(q) ? q.options.map((o) => o.text) : null,
    match: kind === 'match' ? { left: q.match_items.left.map((m) => m.text), right: q.match_items.right.map((m) => m.text) } : null,
    answer,
    explanation: q.explanation ?? null,
    subject: n.subject,
    chapter: n.chapter,
    topic: n.topic,
    difficulty: q.difficulty ?? null,
    marks: q.marks === null || q.marks === undefined ? null : Number(q.marks),
    tags: q.tags ?? [],
    exams: (q.exams ?? []).map((e) => ({ exam: e.code, year: e.year ?? null, paper: e.paper ?? null })),
    source_ref: q.source_ref ?? null,
    created_at: q.created_at ?? null,
    updated_at: q.updated_at ?? null,
  };
}

export function buildBackup(questions, idx, opts = {}) {
  return {
    format: EXPORT_FORMATS.backup.format,
    version: EXPORT_FORMATS.backup.version,
    exported_at: (opts.now ?? new Date()).toISOString(),
    generator: GENERATOR,
    count: questions.length,
    exams: (idx?.exams ?? []).map((e) => ({ code: e.code, name: e.name })),
    taxonomy: (idx?.tree ?? []).map((s) => ({
      subject: s.name, code: s.code,
      chapters: s.chapters.map((c) => ({ name: c.name, topics: c.topics.map((t) => t.name) })),
    })),
    questions: questions.map((q) => toBackupItem(q, idx)),
  };
}

/** Filename that sorts by date and says what is inside. */
export function exportFilename(kind, now = new Date()) {
  const stamp = now.toISOString().slice(0, 10);
  if (kind === 'text') return `question-bank-${stamp}.txt`;
  if (kind === 'backup') return `question-bank-backup-${stamp}.json`;
  if (kind === 'pictures') return `question-bank-pictures-${stamp}.json`;
  return `atomic-minds-questions-${stamp}.json`;
}

export { OPTION_LETTERS };
