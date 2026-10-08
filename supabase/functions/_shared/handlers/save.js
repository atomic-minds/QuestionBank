// POST /save-questions  { mode: "dry_run" | "save", items: [QuestionInput...], confirm_near_duplicates?: boolean }
//
// The ONLY path by which questions reach the database. Each item is validated, checked for
// duplicates, and saved on its own, so one bad question never blocks the rest. The result lists
// what happened to every item.
import { AppError } from '../core/errors.js';
import { LIMITS } from '../core/constants.js';
import { buildTaxonomyIndex } from '../core/taxonomy.js';
import { validateQuestionInput } from '../core/validate.js';
import { requireAdmin } from './auth.js';
import { readJson } from './http.js';

const MAX_BODY = 2 * 1024 * 1024;

export function softLimitBytes(env) {
  const mb = Number.parseFloat(env('DB_SOFT_LIMIT_MB') ?? '');
  return (Number.isFinite(mb) && mb > 0 ? mb : 450) * 1024 * 1024;
}

const pickDup = (d) => ({ id: d.id, public_id: d.public_id, status: d.status, type_code: d.type_code, question_text: d.question_text, exact: d.exact, similarity: d.similarity });

export async function handleSave(req, { env, fetchImpl }) {
  const { db } = await requireAdmin(req, env, fetchImpl);
  const body = await readJson(req, MAX_BODY);

  const mode = body?.mode;
  if (mode !== 'dry_run' && mode !== 'save') throw new AppError('BAD_REQUEST', 'mode must be "dry_run" or "save".');
  if (!Array.isArray(body.items) || body.items.length === 0) throw new AppError('BAD_REQUEST', 'Send at least one question.');
  if (body.items.length > LIMITS.saveItemsMax) {
    throw new AppError('BAD_REQUEST', `Save at most ${LIMITS.saveItemsMax} questions at a time (you sent ${body.items.length}).`);
  }
  const confirmNear = body.confirm_near_duplicates === true;

  const [tree, exams] = await Promise.all([
    db.rpc('qb_taxonomy_tree'),
    db.select('exams', { select: 'id,code,name', is_active: 'eq.true' }),
  ]);
  const taxonomy = buildTaxonomyIndex(tree, exams);
  const examIds = new Set(exams.map((e) => e.id));

  // Database size guard: stop CREATING questions near the free-tier ceiling (editing is still allowed).
  let creationBlocked = false;
  if (mode === 'save' && body.items.some((i) => !i?.id)) {
    const stats = await db.rpc('qb_admin_stats');
    creationBlocked = Number(stats?.db_bytes) > softLimitBytes(env);
  }

  const results = [];
  for (let index = 0; index < body.items.length; index++) {
    const v = validateQuestionInput(body.items[index], { taxonomy: taxonomy.tree, examIds });
    if (!v.ok) { results.push({ index, ok: false, code: 'VALIDATION', errors: v.errors, duplicates: [] }); continue; }

    let dups = [];
    try {
      dups = await db.rpc('qb_find_duplicates', {
        p_type: v.value.type_code, p_question: v.value.question_text, p_context: v.value.context,
        p_options: v.value.options, p_match: v.value.match_items, p_exclude: v.value.id ?? null,
        p_threshold: 0.8, p_limit: 5,
      });
    } catch (e) { if (e instanceof AppError) { results.push({ index, ok: false, code: e.code, message: e.message, errors: [], duplicates: [] }); continue; } throw e; }
    const duplicates = dups.map(pickDup);
    const exact = duplicates.some((d) => d.exact);

    if (mode === 'dry_run') { results.push({ index, ok: true, duplicates, exact_duplicate: exact }); continue; }

    if (exact) { results.push({ index, ok: false, code: 'DUPLICATE_EXACT', message: 'This exact question already exists in the bank.', errors: [], duplicates }); continue; }
    if (duplicates.length && !confirmNear) { results.push({ index, ok: false, code: 'NEAR_DUPLICATE', message: 'A very similar question already exists. Review it, then save anyway if this is a different question.', errors: [], duplicates }); continue; }
    if (creationBlocked && !v.value.id) {
      results.push({ index, ok: false, code: 'STORAGE_LIMIT', message: 'The database is close to its free-tier size limit, so new questions are paused. Export a backup and free space (see the README).', errors: [], duplicates });
      continue;
    }

    try {
      const saved = await db.rpc('qb_save_question', { p: v.value });
      results.push({ index, ok: true, id: saved.id, public_id: saved.public_id, version: saved.version, status: saved.status, duplicates });
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      if (e.code === 'UNAUTHENTICATED' || e.code === 'UNAVAILABLE') throw e;       // whole request is doomed
      results.push({ index, ok: false, code: e.code, message: e.message, errors: [], duplicates });
    }
  }

  const saved = results.filter((r) => r.ok).length;
  return { mode, results, summary: { total: results.length, ok: saved, failed: results.length - saved, saved: mode === 'save' ? saved : 0 } };
}
