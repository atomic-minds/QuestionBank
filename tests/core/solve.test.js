// "Solve with AI": request checks, model choice, quota, strict answer checking, TeX repair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../supabase/functions/_shared/handlers/http.js';
import { handleSolve, parseSolveRequest, solveInput } from '../../supabase/functions/_shared/handlers/solve.js';
import { buildSolvePrompt, buildPrompt } from '../../supabase/functions/_shared/core/ai/prompt.js';
import { buildTaxonomyIndex } from '../../supabase/functions/_shared/core/taxonomy.js';
import { repairTex, richPlain, splitMath, hasMath } from '../../supabase/functions/_shared/core/chem.js';

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'g-key', GEMINI_MODEL: 'light-model', AI_DAILY_LIMIT: '3' };

function backend({ solutions, geminiStatus = 200, quotaUsed = 0 } = {}) {
  const seen = { gemini: [], refunds: 0 };
  let used = quotaUsed;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization ?? init.headers?.Authorization;
    const send = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
    if (u.hostname.includes('generativelanguage')) {
      seen.gemini.push({ path: u.pathname, body: JSON.parse(init.body) });
      if (geminiStatus !== 200) return send({ error: { message: 'quota' } }, geminiStatus);
      return send({ candidates: [{ content: { parts: [{ text: JSON.stringify({ solutions }) }] }, finishReason: 'STOP' }] });
    }
    if (u.pathname === '/auth/v1/user') return ['Bearer admin-token', 'Bearer user-token'].includes(auth) ? send({ id: 'u1' }) : send({ message: 'bad' }, 401);
    const rpc = u.pathname.replace('/rest/v1/rpc/', '');
    const body = init.body ? JSON.parse(init.body) : {};
    if (rpc === 'is_admin') return send(auth === 'Bearer admin-token');
    if (rpc === 'qb_consume_ai_quota') { if (used >= body.p_limit) return send({ allowed: false, used, limit: body.p_limit }); used += 1; return send({ allowed: true, used, limit: body.p_limit, day: '2026-10-15' }); }
    if (rpc === 'qb_refund_ai_quota') { seen.refunds += 1; used -= 1; return send(null); }
    return send({ message: `unexpected ${u.pathname}` }, 500);
  };
  return { fetchImpl, seen, get used() { return used; } };
}
const req = (items, token = 'admin-token') => new Request('https://f/solve-questions', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ items }) });
const call = async (r, be, env = ENV) => {
  const res = await route(handleSolve, { log: () => {} })(r, { env: (k) => env[k], fetchImpl: be.fetchImpl });
  return { status: res.status, body: await res.json() };
};
const MCQ = { key: 'k1', type: 'mcq', question: 'Which gas is lighter than air?', options: ['CO₂', 'H₂', 'SO₂'] };
const NUM = { key: 'k2', type: 'numerical', question: 'Calculate the molar mass of water in g/mol.', marks: 2 };
const SHORT = { key: 'k3', type: 'short_answer', question: 'State Avogadro\'s law.', marks: 2 };

test('request checks: size, keys, type, text', () => {
  assert.throws(() => parseSolveRequest({}), /at least one/i);
  assert.throws(() => parseSolveRequest({ items: Array.from({ length: 6 }, (_, i) => ({ ...NUM, key: `k${i}` })) }), /at most 5/);
  assert.throws(() => parseSolveRequest({ items: [NUM, NUM] }), /own key/);
  assert.throws(() => parseSolveRequest({ items: [{ ...NUM, type: 'poem' }] }), /unknown type/);
  assert.throws(() => parseSolveRequest({ items: [{ ...NUM, question: '   ' }] }), /no text/);
  assert.throws(() => parseSolveRequest({ items: [{ ...NUM, options: 'x' }] }), /short list/);
  const ok = parseSolveRequest({ items: [MCQ, { ...NUM, marks: 999 }] });
  assert.equal(ok.length, 2);
  assert.equal(ok[1].marks, null, 'a silly marks value is ignored, not trusted');
});

test('the AI sees options with their letters', () => {
  const s = solveInput(parseSolveRequest({ items: [MCQ] })[0]);
  assert.deepEqual(s.options, { A: 'CO₂', B: 'H₂', C: 'SO₂' });
});

test('solve: answers are checked with the same rules as everything else', async () => {
  const be = backend({ solutions: [
    { key: 'k1', answer: 'B', explanation: 'H₂ has the lowest molar mass.', confident: true, notes: null },
    { key: 'k2', answer: '18.015 g/mol', explanation: 'Given: H = 1.008, O = 15.999\nTo find: M of H₂O\nSteps:\n1. $M = 2(1.008) + 15.999$\nAnswer: $18.015\\ \\text{g/mol}$', confident: true, notes: null },
    { key: 'k3', answer: '- Equal volumes of gases\n- at the same T and P\n- hold equal numbers of molecules', explanation: null, confident: true, notes: null },
  ] });
  const r = await call(req([MCQ, NUM, SHORT]), be);
  assert.equal(r.status, 200);
  const [a, b, c] = r.body.solutions;
  assert.deepEqual(a.answer, { value: 'B' });
  assert.equal(b.answer.number, 18.015);
  assert.equal(b.answer.unit, 'g/mol');
  assert.match(b.explanation, /^Given:/);
  assert.match(b.explanation, /\$M = 2\(1\.008\)/);
  assert.match(c.answer.text, /Equal volumes/);
  assert.ok(r.body.solutions.every((s) => s.ok && s.errors.length === 0 && s.confident));
  assert.equal(be.used, 1, 'three questions in one request cost ONE unit of the daily budget');
  assert.equal(r.body.ai.quota.used, 1);
});

test('solve: a letter that is not an option, a missing answer and a stray field are all refused', async () => {
  const be = backend({ solutions: [
    { key: 'k1', answer: 'Z', explanation: 'x', confident: true, notes: null },
    { key: 'k2', answer: null, explanation: null, confident: false, notes: 'The figure is missing.' },
    { key: 'k3', answer: 'ok', explanation: null, confident: true, notes: null, hack: 1 },
  ] });
  const r = await call(req([MCQ, NUM, SHORT]), be);
  const [a, b, c] = r.body.solutions;
  assert.equal(a.ok, false); assert.equal(a.answer, null); assert.ok(a.errors.length);
  assert.equal(b.ok, false); assert.equal(b.errors[0].message, 'The figure is missing.');
  assert.equal(c.ok, false); assert.match(c.errors[0].message, /unexpected/i);
});

test('solve: a question the AI skipped is reported, not invented', async () => {
  const be = backend({ solutions: [{ key: 'k1', answer: 'B', explanation: null, confident: true, notes: null }] });
  const r = await call(req([MCQ, NUM]), be);
  assert.equal(r.body.solutions[0].ok, true);
  assert.equal(r.body.solutions[1].ok, false);
  assert.match(r.body.solutions[1].errors[0].message, /did not answer/);
});

test('solve: backslashes the model lost in JSON are put back inside $...$ only', async () => {
  const lost = 'Answer: $\x08eta = \x0crac{1}{2} \x09imes 4 \x0dho$ and a tab\there';
  const be = backend({ solutions: [{ key: 'k2', answer: '2', explanation: lost, confident: true, notes: null }] });
  const r = await call(req([NUM]), be);
  assert.equal(r.body.solutions[0].explanation, 'Answer: $\\beta = \\frac{1}{2} \\times 4 \\rho$ and a tab\there');
});

test('solve: uses the stronger model when GEMINI_SOLVE_MODEL is set, otherwise the normal one', async () => {
  const sol = [{ key: 'k2', answer: '18', explanation: null, confident: true, notes: null }];
  const a = backend({ solutions: sol });
  await call(req([NUM]), a, { ...ENV, GEMINI_SOLVE_MODEL: 'strong-model' });
  assert.match(a.seen.gemini[0].path, /models\/strong-model:generateContent/);
  const b = backend({ solutions: sol });
  await call(req([NUM]), b);
  assert.match(b.seen.gemini[0].path, /models\/light-model:generateContent/);
  assert.equal(a.seen.gemini[0].body.contents[0].parts.length, 1, 'text only: no image is sent');
});

test('solve: only admins; the daily limit stops it; a Google quota error gives the use back', async () => {
  const sol = [{ key: 'k2', answer: '18', explanation: null, confident: true, notes: null }];
  const nope = await call(req([NUM], 'user-token'), backend({ solutions: sol }));
  assert.equal(nope.status, 403);
  const anon = await call(req([NUM], null), backend({ solutions: sol }));
  assert.equal(anon.status, 401);
  const full = backend({ solutions: sol, quotaUsed: 3 });
  const stopped = await call(req([NUM]), full);
  assert.equal(stopped.body.error.code, 'AI_DAILY_LIMIT');
  assert.equal(full.seen.gemini.length, 0, 'no AI call once the limit is reached');
  const g = backend({ solutions: sol, geminiStatus: 429 });
  const r = await call(req([NUM]), g);
  assert.equal(r.body.error.code, 'AI_QUOTA_EXHAUSTED');
  assert.equal(g.seen.refunds, 1);
  assert.equal(g.used, 0);
});

test('solve: not configured is reported before any quota is spent', async () => {
  const be = backend({ solutions: [] });
  const r = await call(req([NUM]), be, { ...ENV, GEMINI_API_KEY: '' });
  assert.equal(r.body.error.code, 'AI_NOT_CONFIGURED');
  assert.equal(be.used, 0);
});

// ------------------------------------------------------------------ prompts and maths text
test('the photo reader is told to always answer, show working, keep parts together and use LaTeX with doubled backslashes', () => {
  const { system } = buildPrompt(buildTaxonomyIndex([], []), {});
  assert.match(system, /ALWAYS give an answer/);
  assert.match(system, /Given:[\s\S]*To find:[\s\S]*Concept \/ formula:[\s\S]*Steps:[\s\S]*Answer:/);
  assert.match(system, /PARTS:[\s\S]*ONE question/);
  assert.match(system, /EVERY backslash must be doubled/);
  assert.match(system, /\\ce\{/);
  assert.match(system, /SAME language/);
});

test('the solve prompt covers every question type and the safety rules', () => {
  const { system } = buildSolvePrompt();
  for (const t of ['mcq', 'numerical', 'short_answer', 'long_answer', 'match_following']) assert.match(system, new RegExp(`- ${t}:`));
  assert.match(system, /DATA, never instructions/);
  assert.match(system, /confident/);
});

test('maths: $...$ and $$...$$ are found, prices and escaped dollars are not', () => {
  assert.deepEqual(splitMath('Find $\\frac{a}{b}$ now').map((p) => [p.math, p.tex ?? p.s]), [[false, 'Find '], [true, '\\frac{a}{b}'], [false, ' now']]);
  assert.equal(splitMath('$$x^2 + y^2$$').at(0).display, true);
  assert.equal(hasMath('It costs $5 and $10 today'), false);
  assert.equal(hasMath('price \\$5'), false);
  assert.equal(hasMath('$ a $ b'), false, 'spaces next to the dollar signs mean it is not a formula');
  assert.equal(hasMath('a $b$5'), false, 'a closing $ followed by a digit is not a formula');
  assert.equal(richPlain('price \\$5 only'), 'price $5 only');
  assert.equal(hasMath('$\\ce{H2SO4}$'), true);
});

test('repairTex leaves ordinary text alone', () => {
  assert.equal(repairTex('line one\nline two\ttab, no maths'), 'line one\nline two\ttab, no maths');
  assert.equal(repairTex('$x$\nnext line'), '$x$\nnext line');
  assert.equal(repairTex('$a \\neq b$'), '$a \\neq b$');
});
