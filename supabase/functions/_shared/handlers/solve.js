// POST /solve-questions  (JSON: {items: [{key, type, question, context?, options?, match_left?, match_right?, marks?}]})
//
//   admin check -> AI configured? -> validate the request -> spend one unit of today's AI budget
//   -> ask the (stronger) AI to solve them -> strict validation -> return answers + worked solutions
//
// Nothing is written to the database here: the browser shows the result, and the admin saves it.
// Several questions (up to 5) share one request, so they cost one unit of the free daily budget.
import { AppError } from '../core/errors.js';
import { LIMITS, OPTION_LETTERS, TYPE_CODES } from '../core/constants.js';
import { isPlainObject } from '../core/text.js';
import { buildTaxonomyIndex } from '../core/taxonomy.js';
import { getProvider } from '../core/ai/registry.js';
import { buildSolvePrompt } from '../core/ai/prompt.js';
import { buildSolveSchema, SOLVE_MAX_ITEMS } from '../core/ai/schema.js';
import { adaptSolveOutput } from '../core/ai/adapt.js';
import { dailyLimit } from './extract.js';
import { readJson } from './http.js';
import { requireAdmin } from './auth.js';

const REFUNDABLE = new Set(['AI_UNAVAILABLE', 'AI_NOT_CONFIGURED', 'AI_QUOTA_EXHAUSTED']);
const MAX_BODY = 256 * 1024;

const text = (v, max, path) => {
  if (typeof v !== 'string') throw new AppError('VALIDATION', `${path} must be text.`);
  if (v.length > max) throw new AppError('VALIDATION', `${path} is too long.`);
  return v;
};
const list = (v, maxItems, maxChars, path) => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > maxItems) throw new AppError('VALIDATION', `${path} must be a short list.`);
  return v.map((x, i) => text(x, maxChars, `${path}[${i}]`));
};

/** @returns {{key:string,type:string,question:string,context:string|null,options:string[]|null,match_left:string[]|null,match_right:string[]|null,marks:number|null}[]} */
export function parseSolveRequest(body) {
  if (!isPlainObject(body) || !Array.isArray(body.items) || body.items.length === 0) throw new AppError('VALIDATION', 'Send at least one question to solve.');
  if (body.items.length > SOLVE_MAX_ITEMS) throw new AppError('VALIDATION', `Send at most ${SOLVE_MAX_ITEMS} questions at a time.`);
  const seen = new Set();
  return body.items.map((it, i) => {
    if (!isPlainObject(it)) throw new AppError('VALIDATION', `Question ${i + 1} is not valid.`);
    const key = text(it.key, 60, `key ${i + 1}`);
    if (!key || seen.has(key)) throw new AppError('VALIDATION', 'Each question needs its own key.');
    seen.add(key);
    if (typeof it.type !== 'string' || !TYPE_CODES.includes(it.type)) throw new AppError('VALIDATION', `Question ${i + 1} has an unknown type.`);
    const question = text(it.question, LIMITS.questionText, `Question ${i + 1}`).trim();
    if (!question) throw new AppError('VALIDATION', `Question ${i + 1} has no text.`);
    const marks = it.marks === null || it.marks === undefined ? null : Number(it.marks);
    return {
      key, type: it.type, question,
      context: it.context ? text(it.context, LIMITS.context, `Context ${i + 1}`) : null,
      options: list(it.options, 6, LIMITS.optionText, `options ${i + 1}`),
      match_left: list(it.match_left, LIMITS.matchItemsMax, LIMITS.matchItemText, `match_left ${i + 1}`),
      match_right: list(it.match_right, LIMITS.matchItemsMax, LIMITS.matchItemText, `match_right ${i + 1}`),
      marks: Number.isFinite(marks) && marks >= 0 && marks <= LIMITS.marksMax ? marks : null,
    };
  });
}

/** The question as the AI sees it: options carry their letters so it can answer with one. */
export function solveInput(q) {
  return {
    key: q.key, type: q.type, marks: q.marks ?? undefined, context: q.context ?? undefined, question: q.question,
    options: q.options ? Object.fromEntries(q.options.map((t, i) => [OPTION_LETTERS[i], t])) : undefined,
    list_I: q.match_left ? Object.fromEntries(q.match_left.map((t, i) => [OPTION_LETTERS[i], t])) : undefined,
    list_II: q.match_right ? Object.fromEntries(q.match_right.map((t, i) => [String(i + 1), t])) : undefined,
  };
}

export async function handleSolve(req, { env, fetchImpl }) {
  const { db } = await requireAdmin(req, env, fetchImpl);
  const provider = getProvider(env, fetchImpl, 'solve');           // fails cheaply, before any quota is spent
  const asked = parseSolveRequest(await readJson(req, MAX_BODY));

  const limit = dailyLimit(env);
  const quota = await db.rpc('qb_consume_ai_quota', { p_limit: limit });
  if (!quota?.allowed) {
    throw new AppError('AI_DAILY_LIMIT',
      `Today's limit of ${limit} AI uses has been reached. It resets at midnight India time (12:00 am IST). You can still write answers by hand. On the free tier nothing is charged; keep billing switched off.`,
      { details: { used: quota?.used, limit } });
  }

  const { system, userText } = buildSolvePrompt();
  let json; let usage;
  try {
    ({ json, usage } = await provider.solve({ system, userText: `${userText}\n\n${JSON.stringify(asked.map(solveInput))}`, schema: buildSolveSchema() }));
  } catch (e) {
    if (REFUNDABLE.has(e?.code)) { try { await db.rpc('qb_refund_ai_quota', { p_day: quota.day }); } catch { /* best effort */ } }
    throw e;
  }
  const result = adaptSolveOutput(json, asked, { taxonomy: buildTaxonomyIndex([], []) });
  return { ...result, ai: { provider: provider.id, model: provider.model, usage: usage ?? null, quota: { used: quota.used, limit } } };
}
