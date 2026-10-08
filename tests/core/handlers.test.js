// The two Edge Function handlers, run against a fake Supabase + fake Gemini (no network).
// This checks OUR logic (auth order, quota order, limits, partial success); the database rules
// themselves are tested against real Postgres in tests/sql.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../supabase/functions/_shared/handlers/http.js';
import { handleExtract } from '../../supabase/functions/_shared/handlers/extract.js';
import { handleSave } from '../../supabase/functions/_shared/handlers/save.js';
import { EXAMS, TREE } from './fixtures.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'g-key', GEMINI_MODEL: 'test-model', AI_DAILY_LIMIT: '2' };

function backend({ aiJson, dups = [], saveFail = {}, dbBytes = 1000, quotaUsed = 0 } = {}) {
  const calls = [];
  let used = quotaUsed;
  let n = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization ?? init.headers?.Authorization;
    const body = init.body && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const send = (data, status = 200) => new Response(JSON.stringify(data), { status });
    calls.push(u.pathname);
    if (u.hostname.includes('generativelanguage')) return send({ candidates: [{ content: { parts: [{ text: JSON.stringify(aiJson) }] }, finishReason: 'STOP' }] });
    if (u.pathname === '/auth/v1/user') {
      return ['Bearer admin-token', 'Bearer user-token'].includes(auth) ? send({ id: 'u1', email: 'a@b.c' }) : send({ message: 'bad jwt' }, 401);
    }
    const rpc = u.pathname.replace('/rest/v1/rpc/', '');
    switch (rpc) {
      case 'is_admin': return send(auth === 'Bearer admin-token');
      case 'qb_taxonomy_tree': return send(TREE);
      case 'qb_consume_ai_quota': {
        if (used >= body.p_limit) return send({ allowed: false, used, limit: body.p_limit });
        used += 1; return send({ allowed: true, used, limit: body.p_limit });
      }
      case 'qb_find_duplicates': return send(dups.filter((d) => d.when === body.p_question).map(({ when, ...d }) => d));
      case 'qb_admin_stats': return send({ db_bytes: dbBytes });
      case 'qb_save_question': {
        const fail = saveFail[body.p.question_text];
        if (fail) return send(fail, 400);
        n += 1; return send({ id: `id-${n}`, public_id: `QB-CHEM-00000${n}`, version: 1, status: body.p.status });
      }
      default:
        if (u.pathname === '/rest/v1/exams') return send(EXAMS);
        return send({ message: `unexpected ${u.pathname}` }, 500);
    }
  };
  return { fetchImpl, calls, get used() { return used; } };
}

const call = async (handler, req, be, env = ENV) => {
  const res = await route(handler, { log: () => {} })(req, { env: (k) => env[k], fetchImpl: be.fetchImpl });
  return { status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers };
};
const jsonReq = (body, token = 'admin-token') => new Request('https://f/save-questions', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const imageReq = (bytes = PNG, { type = 'image/png', token = 'admin-token', extra = {} } = {}) => {
  const fd = new FormData();
  fd.append('image', new Blob([bytes], { type }), 'q.png');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return new Request('https://f/extract-question', { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body: fd });
};
const mcq = (over = {}) => ({ subject_id: 1, chapter_id: 10, type_code: 'mcq', question_text: 'What is the coordination number of NaCl?', options: [{ id: 'A', text: '4' }, { id: 'B', text: '6' }], answer: { value: 'B' }, ...over });
const aiOut = (over = {}) => ({ questions: [{ type: 'mcq', question: 'Q one?', options: ['4', '6'], answer: 'B', answer_source: 'inferred', explanation: null, explanation_source: 'none', subject_id: 1, chapter_id: 10, topic_id: null, difficulty: 'unknown', marks: null, tags: [], exams: [], ...over }] });

// ------------------------------------------------------------------ shared plumbing
test('CORS: preflight answered, origin allow-list honoured, non-POST refused', async () => {
  const be = backend();
  const pre = await call(handleSave, new Request('https://f/x', { method: 'OPTIONS', headers: { origin: 'https://a.example' } }), be);
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  const strict = { ...ENV, ALLOWED_ORIGINS: 'https://mine.example' };
  const bad = await call(handleSave, new Request('https://f/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), be, strict);
  assert.equal(bad.headers.get('access-control-allow-origin'), null);
  const good = await call(handleSave, new Request('https://f/x', { method: 'OPTIONS', headers: { origin: 'https://mine.example' } }), be, strict);
  assert.equal(good.headers.get('access-control-allow-origin'), 'https://mine.example');
  const get = await call(handleSave, new Request('https://f/x', { method: 'GET' }), be);
  assert.equal(get.status, 405);
});

test('authentication: no token, bad token, non-admin are all refused before any work', async () => {
  const be = backend();
  assert.equal((await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }, null), be)).status, 401);
  assert.equal((await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }, 'forged'), be)).body.error.code, 'UNAUTHENTICATED');
  const user = await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }, 'user-token'), be);
  assert.equal(user.status, 403);
  assert.equal(user.body.error.code, 'FORBIDDEN');
  assert.ok(!be.calls.includes('/rest/v1/rpc/qb_save_question'));
  const img = await call(handleExtract, imageReq(PNG, { token: 'user-token' }), be);
  assert.equal(img.status, 403);
  assert.equal(be.used, 0, 'a non-admin cannot spend AI budget');
});

test('server errors never leak internals', async () => {
  const be = backend();
  const bad = { ...be, fetchImpl: async () => { throw new Error('secret stack detail'); } };
  const r = await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }), bad);
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r.body), /secret stack/);
});

// ------------------------------------------------------------------ save-questions
test('save: validates the request itself', async () => {
  const be = backend();
  assert.equal((await call(handleSave, jsonReq({ mode: 'nope', items: [mcq()] }), be)).status, 400);
  assert.equal((await call(handleSave, jsonReq({ mode: 'save', items: [] }), be)).status, 400);
  assert.equal((await call(handleSave, jsonReq({ mode: 'save', items: Array(51).fill(mcq()) }), be)).status, 400);
  const notJson = new Request('https://f/x', { method: 'POST', headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' }, body: '{oops' });
  assert.equal((await call(handleSave, notJson, be)).body.error.code, 'BAD_REQUEST');
  const wrongType = new Request('https://f/x', { method: 'POST', headers: { authorization: 'Bearer admin-token', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal((await call(handleSave, wrongType, be)).status, 415);
});

test('save: per-item results, invalid items skipped, valid ones saved', async () => {
  const be = backend();
  const r = await call(handleSave, jsonReq({ mode: 'save', items: [mcq(), mcq({ question_text: '' }), mcq({ question_text: 'Second?', status: 'published' })] }), be);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.results.map((x) => x.ok), [true, false, true]);
  assert.equal(r.body.results[1].code, 'VALIDATION');
  assert.equal(r.body.results[1].errors[0].path, 'question_text');
  assert.equal(r.body.results[0].public_id, 'QB-CHEM-000001');
  assert.deepEqual(r.body.summary, { total: 3, ok: 2, failed: 1, saved: 2 });
});

test('save: dry run checks everything but writes nothing', async () => {
  const be = backend({ dups: [{ when: mcq().question_text, id: 'old', public_id: 'QB-CHEM-000009', exact: false, similarity: 0.9, status: 'published', type_code: 'mcq', question_text: 'near' }] });
  const r = await call(handleSave, jsonReq({ mode: 'dry_run', items: [mcq()] }), be);
  assert.equal(r.body.results[0].duplicates[0].public_id, 'QB-CHEM-000009');
  assert.equal(r.body.summary.saved, 0);
  assert.ok(!be.calls.includes('/rest/v1/rpc/qb_save_question'));
});

test('save: exact duplicates are blocked; near duplicates need confirmation', async () => {
  const exact = { when: 'Dup?', id: 'a', public_id: 'QB-CHEM-000001', exact: true, similarity: 1, status: 'published', type_code: 'mcq', question_text: 'Dup?' };
  const near = { when: 'Near?', id: 'b', public_id: 'QB-CHEM-000002', exact: false, similarity: 0.85, status: 'draft', type_code: 'mcq', question_text: 'Nearly?' };
  const be = backend({ dups: [exact, near] });
  const items = [mcq({ question_text: 'Dup?' }), mcq({ question_text: 'Near?' })];
  const first = await call(handleSave, jsonReq({ mode: 'save', items, confirm_near_duplicates: true }), be);
  assert.deepEqual(first.body.results.map((x) => x.code ?? 'saved'), ['DUPLICATE_EXACT', 'saved'], 'confirmation never overrides an exact duplicate');
  const unconfirmed = await call(handleSave, jsonReq({ mode: 'save', items }), backend({ dups: [exact, near] }));
  assert.deepEqual(unconfirmed.body.results.map((x) => x.code), ['DUPLICATE_EXACT', 'NEAR_DUPLICATE']);
});

test('save: a database rejection affects only that item', async () => {
  const be = backend({ saveFail: { 'Boom?': { message: 'QB_CONFLICT: question was changed by someone else', code: '40001' } } });
  const r = await call(handleSave, jsonReq({ mode: 'save', items: [mcq({ question_text: 'Boom?' }), mcq({ question_text: 'Fine?' })] }), be);
  assert.deepEqual(r.body.results.map((x) => x.ok), [false, true]);
  assert.equal(r.body.results[0].code, 'CONFLICT');
});

test('save: near the free-tier size limit, creating is paused but editing still works', async () => {
  const be = backend({ dbBytes: 460 * 1024 * 1024 });
  const r = await call(handleSave, jsonReq({ mode: 'save', items: [mcq(), mcq({ id: '123e4567-e89b-12d3-a456-426614174000', expected_version: 1, question_text: 'Edited?' })] }), be);
  assert.deepEqual(r.body.results.map((x) => x.code ?? 'saved'), ['STORAGE_LIMIT', 'saved']);
  const roomy = await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }), backend({ dbBytes: 100 * 1024 * 1024 }));
  assert.equal(roomy.body.results[0].ok, true);
  const custom = await call(handleSave, jsonReq({ mode: 'save', items: [mcq()] }), backend({ dbBytes: 60 * 1024 * 1024 }), { ...ENV, DB_SOFT_LIMIT_MB: '50' });
  assert.equal(custom.body.results[0].code, 'STORAGE_LIMIT');
});

// ------------------------------------------------------------------ extract-question
test('extract: image in, drafts out, nothing written to the database', async () => {
  const be = backend({ aiJson: aiOut() });
  const r = await call(handleExtract, imageReq(PNG, { extra: { subject_id: '1', note: 'page 2' } }), be);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items[0].ok, true);
  assert.equal(r.body.items[0].meta.answer_source, 'inferred');
  assert.equal(r.body.ai.quota.used, 1);
  assert.equal(r.body.ai.model, 'test-model');
  assert.ok(!be.calls.includes('/rest/v1/rpc/qb_save_question'));
});

test('extract: upload rules are enforced before any quota is spent', async () => {
  const be = backend({ aiJson: aiOut() });
  const gif = await call(handleExtract, imageReq(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0, 0, 0, 0, 0, 0, 0, 0]), { type: 'image/gif' }), be);
  assert.equal(gif.body.error.code, 'UNSUPPORTED_MEDIA');
  const disguised = await call(handleExtract, imageReq(new Uint8Array([0x3c, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74, 0, 0, 0, 0, 0]), { type: 'image/png' }), be);
  assert.equal(disguised.body.error.code, 'UNSUPPORTED_MEDIA');
  const lying = await call(handleExtract, imageReq(PNG, { type: 'image/jpeg' }), be);
  assert.equal(lying.body.error.code, 'UNSUPPORTED_MEDIA');
  const big = new Uint8Array(3 * 1024 * 1024 + 1); big.set(PNG);
  assert.equal((await call(handleExtract, imageReq(big), be)).body.error.code, 'PAYLOAD_TOO_LARGE');
  const empty = new Request('https://f/x', { method: 'POST', headers: { authorization: 'Bearer admin-token' }, body: new FormData() });
  assert.equal((await call(handleExtract, empty, be)).body.error.code, 'BAD_REQUEST');
  assert.equal(be.used, 0);
});

test('extract: not configured is reported before spending quota', async () => {
  const be = backend({ aiJson: aiOut() });
  const r = await call(handleExtract, imageReq(), be, { ...ENV, GEMINI_API_KEY: '' });
  assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED');
  assert.equal(be.used, 0);
});

test('extract: the daily cap stops requests, with a clear no-charge message', async () => {
  const be = backend({ aiJson: aiOut() });
  assert.equal((await call(handleExtract, imageReq(), be)).status, 200);
  assert.equal((await call(handleExtract, imageReq(), be)).status, 200);
  const third = await call(handleExtract, imageReq(), be);
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'AI_DAILY_LIMIT');
  assert.match(third.body.error.message, /Import JSON/);
  assert.match(third.body.error.message, /nothing is charged; keep billing switched off/);
  assert.equal(be.used, 2);
});

test('extract: AI trouble is mapped, not thrown', async () => {
  const be = backend({ aiJson: { not: 'questions' } });
  const r = await call(handleExtract, imageReq(), be);
  assert.equal(r.body.error.code, 'AI_BAD_OUTPUT');
  assert.equal(r.status, 422);
});

// ---- which public key the functions use (Supabase is retiring the legacy "anon" key) ----
import { publicKey } from '../../supabase/functions/_shared/handlers/auth.js';
import { createRest } from '../../supabase/functions/_shared/core/rest.js';

test('public key: own secret, then new publishable keys, then legacy anon; never a secret key', () => {
  const env = (o) => (n) => o[n];
  assert.equal(publicKey(env({ QB_PUBLISHABLE_KEY: ' sb_publishable_own ', SUPABASE_PUBLISHABLE_KEYS: '{"default":"x"}', SUPABASE_ANON_KEY: 'legacy' })), 'sb_publishable_own');
  assert.equal(publicKey(env({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_a","other":"sb_publishable_b"}', SUPABASE_ANON_KEY: 'legacy' })), 'sb_publishable_a');
  assert.equal(publicKey(env({ SUPABASE_PUBLISHABLE_KEYS: '{"web":"sb_publishable_w"}' })), 'sb_publishable_w');
  assert.equal(publicKey(env({ SUPABASE_PUBLISHABLE_KEYS: 'not json', SUPABASE_ANON_KEY: 'legacy' })), 'legacy');
  assert.equal(publicKey(env({ SUPABASE_ANON_KEY: 'legacy' })), 'legacy');
  assert.equal(publicKey(env({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_nope"}', SUPABASE_SERVICE_ROLE_KEY: 'nope' })), null);
});

test('rest client: the project key goes in `apikey` only; a bearer token is sent only for a signed-in person', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(init.headers); return new Response('[]', { status: 200 }); };
  const anon = createRest({ url: 'https://x.supabase.co', key: 'sb_publishable_k', fetchImpl });
  await anon.select('subjects', {});
  await anon.withToken('user-jwt').select('subjects', {});
  assert.equal(seen[0].apikey, 'sb_publishable_k');
  assert.equal(seen[0].authorization, undefined, 'a non-JWT key must never be sent as a bearer token');
  assert.equal(seen[1].authorization, 'Bearer user-jwt');
  assert.equal(seen[1].apikey, 'sb_publishable_k');
});
