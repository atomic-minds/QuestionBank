// The ONLY module that talks to the backend. Views never call fetch directly.
//
//   public reads  -> database functions (RPC) that return PUBLISHED questions only
//   admin reads   -> same functions; the database widens the result for signed-in admins
//   admin writes  -> the save-questions / extract-question Edge Functions (validation, duplicate check)
//                    and, for master data (subjects, chapters, topics, exams), the tables directly,
//                    protected by row-level security.
import { createRest } from './core/rest.js';
import { AppError } from './core/errors.js';
import { buildTaxonomyIndex } from './core/taxonomy.js';
import { slugify } from './core/text.js';

const cfg = window.QB_CONFIG ?? {};
export const settings = {
  siteName: cfg.siteName || 'Question Bank',
  copyright: cfg.copyright || 'AyanP_Chem',
};
const publicKey = cfg.supabasePublishableKey || cfg.supabaseAnonKey;   // the second name is the older spelling
export const isConfigured = () => Boolean(cfg.supabaseUrl && publicKey);

const rest = isConfigured() ? createRest({ url: cfg.supabaseUrl, key: publicKey }) : null;
const need = () => {
  if (!rest) throw new AppError('NOT_CONFIGURED', 'This site is not connected to its database yet. Fill in web/config.js (see the setup guide).');
  return rest;
};

// ------------------------------------------------------------------ session (per browser)
const KEY = 'qb.session';
let memory = null;
const store = {
  get() { try { return JSON.parse(localStorage.getItem(KEY)) ?? memory; } catch { return memory; } },
  set(s) { memory = s; try { s ? localStorage.setItem(KEY, JSON.stringify(s)) : localStorage.removeItem(KEY); } catch { /* private mode */ } },
};
const toSession = (r) => ({
  access_token: r.access_token, refresh_token: r.refresh_token,
  expires_at: r.expires_at ?? Math.floor(Date.now() / 1000) + (r.expires_in ?? 3600),
  email: r.user?.email ?? null,
});

export const getSession = () => store.get();
export const signedIn = () => Boolean(store.get()?.access_token);

export async function signIn(email, password) {
  const r = await need().auth.signIn(String(email).trim(), password);
  store.set(toSession(r));
  if (!(await checkAdmin())) { await signOut(); throw new AppError('FORBIDDEN', 'This account is not an admin. Ask the owner to add it (see the setup guide).'); }
  return getSession();
}
export async function signOut() {
  const s = store.get();
  store.set(null);
  if (s?.access_token && rest) { try { await rest.auth.signOut(s.access_token); } catch { /* already gone */ } }
}
async function token() {
  let s = store.get();
  if (!s?.access_token) throw new AppError('UNAUTHENTICATED', 'Please sign in.');
  if (s.expires_at - 60 < Date.now() / 1000) {
    try { s = toSession(await need().auth.refresh(s.refresh_token)); store.set(s); } catch (e) {
      if (e instanceof AppError && e.code === 'UNAVAILABLE') throw e;
      store.set(null); throw new AppError('UNAUTHENTICATED', 'Your session has expired. Please sign in again.');
    }
  }
  return s.access_token;
}
async function authed() { return need().withToken(await token()); }
async function guard(fn) {
  try { return await fn(); } catch (e) { if (e instanceof AppError && e.code === 'UNAUTHENTICATED') store.set(null); throw e; }
}
export async function checkAdmin() {
  if (!signedIn()) return false;
  try { return (await (await authed()).rpc('is_admin')) === true; } catch { return false; }
}

// ------------------------------------------------------------------ public reads
let taxCache = null;
export async function getTaxonomy({ force = false } = {}) {
  if (!force && taxCache && Date.now() - taxCache.at < 5 * 60_000) return taxCache.value;
  const db = signedIn() ? await authed() : need();
  const [tree, exams] = await Promise.all([
    db.rpc('qb_taxonomy_tree'),
    db.select('exams', { select: 'id,code,name', is_active: 'eq.true', order: 'sort_order,name' }),
  ]);
  const value = { tree, exams, index: buildTaxonomyIndex(tree, exams) };
  taxCache = { at: Date.now(), value };
  return value;
}
export const clearTaxonomyCache = () => { taxCache = null; };

export async function getTypes() {
  return need().select('question_types', { select: 'code,label,kind,sort_order', order: 'sort_order' });
}

/** @param {{q?,subject?,chapter?,topic?,type?,category?,exam?,year?,difficulty?,marks?,tag?,status?,publicId?,limit?,offset?}} f */
export async function search(f = {}) {
  const args = {
    p_q: f.q || null, p_subject: f.subject || null, p_chapter: f.chapter || null, p_topic: f.topic || null,
    p_type: f.type || null, p_category: f.category || null, p_exam: f.exam || null, p_year: f.year || null,
    p_difficulty: f.difficulty || null, p_marks: f.marks || null, p_tag: f.tag || null, p_status: f.status || null,
    p_public_id: f.publicId || null, p_limit: f.limit ?? 20, p_offset: f.offset ?? 0,
  };
  const db = signedIn() ? await authed() : need();
  return guard(() => db.rpc('qb_search_questions', args));
}
export async function getQuestion(publicId) {
  const db = signedIn() ? await authed() : need();
  return guard(() => db.rpc('qb_get_question', { p_public_id: publicId }));
}
export const getFacets = ({ subject, chapter, topic } = {}) =>
  need().rpc('qb_facets', { p_subject: subject || null, p_chapter: chapter || null, p_topic: topic || null });
export const searchTaxonomy = (q) => need().rpc('qb_search_taxonomy', { p_q: q });

// ------------------------------------------------------------------ pictures
const seenImages = new Map();      // question id -> {mime,data} | null (kept for the session so lists do not refetch)
/** @returns {Promise<Record<string,{mime:string,data:string}>>} only the ids that have a picture */
export async function getImages(ids, { fresh = false } = {}) {
  const want = [...new Set(ids.filter(Boolean))];
  const out = {};
  const missing = [];
  for (const id of want) {
    if (!fresh && seenImages.has(id)) { const v = seenImages.get(id); if (v) out[id] = v; } else missing.push(id);
  }
  for (let at = 0; at < missing.length; at += 40) {
    const chunk = missing.slice(at, at + 40);
    const db = signedIn() ? await authed() : need();
    const got = await guard(() => db.rpc('qb_get_images', { p_ids: chunk }));
    for (const id of chunk) { const v = got?.[id] ?? null; seenImages.set(id, v); if (v) out[id] = v; }
  }
  return out;
}
export async function setQuestionImage(id, img) {
  const r = await guard(async () => (await authed()).rpc('qb_set_question_image', { p_question: id, p_mime: img.mime, p_data: img.data }));
  seenImages.set(id, { mime: img.mime, data: img.data });
  return r;
}
export async function clearQuestionImage(id) {
  const r = await guard(async () => (await authed()).rpc('qb_clear_question_image', { p_question: id }));
  seenImages.set(id, null);
  return r;
}

// ------------------------------------------------------------------ edge functions
async function callFunction(name, { json, form } = {}) {
  const t = await token();
  let res;
  try {
    res = await fetch(`${cfg.supabaseUrl.replace(/\/+$/, '')}/functions/v1/${name}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${t}`, apikey: publicKey, ...(json ? { 'content-type': 'application/json' } : {}) },
      body: json ? JSON.stringify(json) : form,
    });
  } catch {
    throw new AppError('UNAVAILABLE', 'Could not reach the server function. Check your connection, and that the functions are deployed (setup guide, "Deploy the two functions").');
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const e = body?.error;
    if (e?.code === 'UNAUTHENTICATED') store.set(null);
    throw new AppError(e?.code ?? 'INTERNAL', e?.message ?? `The server returned an error (${res.status}).`, { status: res.status, details: e?.details });
  }
  return body;
}

/** @param {'dry_run'|'save'} mode */
export function saveQuestions(mode, items, { confirmNear = false } = {}) {
  need();
  return callFunction('save-questions', { json: { mode, items, confirm_near_duplicates: confirmNear } });
}
export function extractFromImage(blob, { subjectId = null, note = '' } = {}) {
  need();
  const form = new FormData();
  form.append('image', blob, 'question.jpg');
  if (subjectId) form.append('subject_id', String(subjectId));
  if (note) form.append('note', note);
  return callFunction('extract-question', { form });
}

// ------------------------------------------------------------------ admin data
export async function adminStats() { return guard(async () => (await authed()).rpc('qb_admin_stats')); }

/** A saved question -> the editable QuestionInput the save function expects. */
export function toInput(q) {
  return {
    id: q.id, expected_version: q.version, subject_id: q.subject_id, chapter_id: q.chapter_id, topic_id: q.topic_id,
    type_code: q.type_code, context: q.context, question_text: q.question_text, options: q.options, match_items: q.match_items,
    answer: q.answer, explanation: q.explanation, difficulty: q.difficulty, marks: q.marks === null ? null : Number(q.marks),
    tags: q.tags ?? [], status: q.status, origin: q.origin, source_ref: q.source_ref,
    exams: (q.exams ?? []).map((e) => ({ exam_id: e.exam_id, year: e.year, paper: e.paper })),
  };
}

export async function deleteQuestion(id) {
  const r = await deleteQuestions([id]);
  return r;
}

/** Delete questions for good (their pictures and exam tags go with them). Returns how many were removed. */
export async function deleteQuestions(ids) {
  let removed = 0;
  for (let at = 0; at < ids.length; at += 40) {
    const chunk = ids.slice(at, at + 40);
    const rows = await guard(async () => (await authed()).remove('questions', { id: `in.(${chunk.join(',')})` }));
    removed += Array.isArray(rows) ? rows.length : 0;
    for (const id of chunk) seenImages.set(id, null);
  }
  return removed;
}

/**
 * Everything matching the filters, 500 rows per request. If more than `max` match, the result is
 * cut at `max` and `.truncated` is true, so callers can refuse or warn instead of silently
 * exporting part of the bank.
 */
export async function fetchAll(filters, { onProgress, max = 20000 } = {}) {
  const out = [];
  let more = false;
  for (let offset = 0; offset < max; offset += 500) {
    const page = await search({ ...filters, limit: 500, offset });
    out.push(...page.items);
    onProgress?.(out.length);
    more = page.has_more;
    if (!more) break;
  }
  out.truncated = more;
  return out;
}

// ---- master data (admin) ----
const listAll = async (table, select, order) => guard(async () => (await authed()).select(table, { select, order }));
export const adminTaxonomy = async () => {
  const [subjects, chapters, topics, exams] = await Promise.all([
    listAll('subjects', '*', 'sort_order,name'), listAll('chapters', '*', 'sort_order,name'),
    listAll('topics', '*', 'sort_order,name'), listAll('exams', '*', 'sort_order,name'),
  ]);
  return { subjects, chapters, topics, exams };
};
const slugOf = (name) => slugify(name) || `item-${Date.now().toString(36)}`;
const write = (fn) => guard(async () => { const r = await fn(await authed()); clearTaxonomyCache(); return r; });
export const createSubject = ({ code, name, sort_order = 0 }) => write((db) => db.insert('subjects', { code: code.trim().toUpperCase(), name: name.trim(), slug: slugOf(name), sort_order }));
export const createChapter = ({ subject_id, name, sort_order = 0 }) => write((db) => db.insert('chapters', { subject_id, name: name.trim(), slug: slugOf(name), sort_order }));
export const createTopic = ({ chapter_id, name, sort_order = 0 }) => write((db) => db.insert('topics', { chapter_id, name: name.trim(), slug: slugOf(name), sort_order }));
export const createExam = ({ code, name, sort_order = 0 }) => write((db) => db.insert('exams', { code: code.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_'), name: name.trim(), sort_order }));
export const updateRow = (table, id, fields) => write((db) => db.update(table, { id: `eq.${id}` }, fields));
export const deleteRow = (table, id) => write((db) => db.remove(table, { id: `eq.${id}` }));
