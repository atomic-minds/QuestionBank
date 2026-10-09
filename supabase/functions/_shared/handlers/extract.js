// POST /extract-question  (multipart: image, optional subject_id, optional note)
//
//   admin check -> AI configured? -> validate the upload -> spend one unit of today's AI budget
//   -> ask the AI -> strict validation -> return DRAFTS (nothing is written to the database)
//
// The image lives only in this request's memory. It is never written to disk, storage or logs.
import { AppError } from '../core/errors.js';
import { LIMITS } from '../core/constants.js';
import { verifyImage } from '../core/image.js';
import { buildTaxonomyIndex } from '../core/taxonomy.js';
import { getProvider } from '../core/ai/registry.js';
import { buildPrompt } from '../core/ai/prompt.js';
import { buildResponseSchema } from '../core/ai/schema.js';
import { adaptAiOutput } from '../core/ai/adapt.js';
import { requireAdmin } from './auth.js';

const REFUNDABLE = new Set(['AI_UNAVAILABLE', 'AI_NOT_CONFIGURED', 'AI_QUOTA_EXHAUSTED']);

export function dailyLimit(env) {
  const n = Number.parseInt(env('AI_DAILY_LIMIT') ?? '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 1000) : 20;
}

export async function handleExtract(req, { env, fetchImpl }) {
  const { db } = await requireAdmin(req, env, fetchImpl);

  // Fail cheaply and clearly BEFORE any quota is spent.
  const provider = getProvider(env, fetchImpl);

  const type = req.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('multipart/form-data')) throw new AppError('UNSUPPORTED_MEDIA', 'Upload the image as a form file.');
  const declaredLength = Number(req.headers.get('content-length') ?? '0');
  if (declaredLength > LIMITS.imageBytesMax + 64 * 1024) {
    throw new AppError('PAYLOAD_TOO_LARGE', `The image is larger than ${Math.round(LIMITS.imageBytesMax / 1024 / 1024)} MB. Use a smaller photo or crop it.`);
  }

  let form;
  try { form = await req.formData(); } catch { throw new AppError('BAD_REQUEST', 'Could not read the upload.'); }
  const file = form.get('image');
  if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') throw new AppError('BAD_REQUEST', 'Attach an image.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = verifyImage(bytes, file.type);

  const subjectRaw = form.get('subject_id');
  const subjectId = typeof subjectRaw === 'string' && /^\d{1,5}$/.test(subjectRaw) ? Number(subjectRaw) : null;
  const note = typeof form.get('note') === 'string' ? form.get('note') : null;

  const [tree, exams] = await Promise.all([
    db.rpc('qb_taxonomy_tree'),
    db.select('exams', { select: 'id,code,name', is_active: 'eq.true', order: 'sort_order,name' }),
  ]);
  const taxonomy = buildTaxonomyIndex(tree, exams);
  if (taxonomy.tree.length === 0) throw new AppError('VALIDATION', 'Add at least one subject and chapter in Taxonomy before importing from images.');

  // One unit of today's budget per image, counted whether or not the AI succeeds (a failed call can
  // still use Google's quota). The counter lives in the database, so it survives restarts.
  const limit = dailyLimit(env);
  const quota = await db.rpc('qb_consume_ai_quota', { p_limit: limit });
  if (!quota?.allowed) {
    throw new AppError('AI_DAILY_LIMIT',
      `Today's limit of ${limit} AI image reads has been used. It resets at midnight India time (12:00 am IST). Use Import JSON in the meantime. On the free tier nothing is charged; keep billing switched off.`,
      { details: { used: quota?.used, limit } });
  }

  const { system, userText } = buildPrompt(taxonomy, { subjectId, note });
  let json; let usage;
  try {
    ({ json, usage } = await provider.extract({ image: { mimeType, bytes }, system, userText, schema: buildResponseSchema() }));
  } catch (e) {
    // Google refused or failed the request, so it did no useful work: give the read back.
    // (Timeouts, blocked images and unreadable answers still count: Google may have processed them.)
    if (REFUNDABLE.has(e?.code)) { try { await db.rpc('qb_refund_ai_quota', { p_day: quota.day }); } catch { /* best effort */ } }
    throw e;
  }
  const result = adaptAiOutput(json, { taxonomy });

  return {
    ...result,
    ai: { provider: provider.id, model: provider.model, usage: usage ?? null, quota: { used: quota.used, limit } },
  };
}
