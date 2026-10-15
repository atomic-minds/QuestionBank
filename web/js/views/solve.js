// "Solve with AI": turns drafts or saved questions into solve requests, runs them in groups of five,
// and puts the AI's answer and worked solution back into a draft. Nothing is saved here.
import * as api from '../api.js';
import { QUESTION_TYPES } from '../core/constants.js';

export const SOLVE_BATCH = 5;

const kindOf = (d) => {
  const k = QUESTION_TYPES[d.type_code]?.kind ?? 'text';
  return k === 'any' ? (d.options ? 'choice' : 'text') : k;
};

/** A draft (or a saved question turned into an input) as the solve function wants it. */
export function toSolveItem(d, key) {
  return {
    key, type: d.type_code, question: String(d.question_text ?? ''), context: d.context || undefined,
    options: d.options?.length ? d.options.map((o) => String(o.text ?? '')) : undefined,
    match_left: d.match_items?.left?.length ? d.match_items.left.map((x) => String(x.text ?? '')) : undefined,
    match_right: d.match_items?.right?.length ? d.match_items.right.map((x) => String(x.text ?? '')) : undefined,
    marks: d.marks === '' || d.marks === null || d.marks === undefined ? undefined : Number(d.marks),
  };
}

/** True when the draft already has an answer typed in (so replacing it deserves a question). */
export function hasAnswer(d) {
  const a = d.answer ?? {};
  if (kindOf(d) === 'choice') return Boolean(a.value) && (d.options ?? []).some((o) => String(o.text ?? '').trim());
  return Boolean(String(a.text ?? '').trim() || String(a.number ?? '').trim() || Object.keys(a.pairs ?? {}).length);
}

/** Can this draft be sent at all? (It needs question text; choice and match questions also need their lists.) */
export function solvable(d) {
  if (!String(d.question_text ?? '').trim()) return 'Write the question first.';
  if (kindOf(d) === 'choice' && !(d.options ?? []).some((o) => String(o.text ?? '').trim())) return 'Add the options first.';
  if (kindOf(d) === 'match' && !((d.match_items?.left ?? []).length && (d.match_items?.right ?? []).length)) return 'Fill in both lists first.';
  return null;
}

/** A copy of the draft with the AI's answer and solution in it. */
export function applySolution(d, sol, { keepExplanation = false } = {}) {
  const next = structuredClone(d);
  const a = sol.answer;
  next.answer = kindOf(next) === 'numeric' ? { number: a.number, unit: a.unit ?? '', tolerance: a.tolerance ?? '' } : a;
  if (sol.explanation && !(keepExplanation && String(d.explanation ?? '').trim())) next.explanation = sol.explanation;
  return next;
}

/** The meta flags the editor and review page use to show "AI worked this out". */
export const solvedMeta = (meta, sol) => ({
  ...(meta ?? {}), answer_source: 'inferred', explanation_source: sol.explanation ? 'generated' : (meta?.explanation_source ?? 'none'),
  notes: sol.confident ? (meta?.notes ?? null) : (sol.notes || 'The AI is not sure about this one. Check it carefully.'),
});

/**
 * Solve many entries ({key, draft}) five at a time. Stops at the first server error (daily limit,
 * Google quota, AI off) and says why; what was solved before that is kept.
 * @returns {Promise<{solved: Map<string, any>, failed: Map<string, string>, stopped: Error|null}>}
 */
export async function solveMany(entries, { onProgress } = {}) {
  const solved = new Map(); const failed = new Map();
  let stopped = null;
  for (let at = 0; at < entries.length; at += SOLVE_BATCH) {
    const chunk = entries.slice(at, at + SOLVE_BATCH);
    try {
      const r = await api.solveQuestions(chunk.map((e) => toSolveItem(e.draft, e.key)));
      for (const s of r.solutions) {
        if (s.ok) solved.set(s.key, s); else failed.set(s.key, s.errors?.[0]?.message ?? 'The AI could not solve it.');
      }
    } catch (e) { stopped = e; break; }
    onProgress?.(Math.min(at + SOLVE_BATCH, entries.length), entries.length);
  }
  return { solved, failed, stopped };
}

/** One-line plain summary for a toast. */
export function summarize({ solved, failed, stopped }) {
  const parts = [`${solved.size} solved`];
  if (failed.size) parts.push(`${failed.size} could not be solved`);
  if (stopped) parts.push(stopped.message);
  return parts.join('. ');
}
