// End-to-end test harness. Test-only; never deployed.
//
// Stands in for Supabase on one local origin so the REAL website, REAL Edge Function handlers and
// REAL database migrations can be driven by a browser without any account or network:
//
//   /rest/v1/*       a small PostgREST look-alike that runs each request in Postgres with the same
//                    role + JWT claims PostgREST would set (so row-level security is really tested)
//   /auth/v1/*       a minimal GoTrue look-alike (password sign-in, refresh, user, logout)
//   /functions/v1/*  the real save-questions / extract-question handlers
//   generativelanguage.googleapis.com  replaced by a canned "Gemini" (never the real service)
//   everything else  the static site in web/, with the same response headers as web/_headers
//
// Run:  node tests/e2e/harness.mjs      (as a non-root user: Postgres refuses to run as root)
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { handleSave } from '../../supabase/functions/_shared/handlers/save.js';
import { handleExtract } from '../../supabase/functions/_shared/handlers/extract.js';
import { route } from '../../supabase/functions/_shared/handlers/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT ?? 8787);
const PGPORT = Number(process.env.PGPORT ?? 54330);
const ORIGIN = `http://localhost:${PORT}`;
const ANON = 'sb_publishable_test0123456789';   // new-style key: NOT a JWT, so it is only valid in the `apikey` header

// ------------------------------------------------------------------ Postgres
const PGBIN = process.env.PGBIN || readdirSync('/usr/lib/postgresql').sort().map((v) => `/usr/lib/postgresql/${v}/bin`).pop();
const DATA = mkdtempSync(join(tmpdir(), 'qb-e2e-'));
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stderr || r.stdout}`);
  return r.stdout;
};
const PSQL = ['-h', DATA, '-p', String(PGPORT), '-U', 'postgres', '-X', '-q'];

run(`${PGBIN}/initdb`, ['-D', `${DATA}/db`, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C.UTF-8']);
run(`${PGBIN}/pg_ctl`, ['-D', `${DATA}/db`, '-o', `-p ${PGPORT} -k ${DATA} -c listen_addresses=''`, '-l', `${DATA}/server.log`, '-w', 'start']);
run(`${PGBIN}/psql`, [...PSQL, '-d', 'postgres', '-c', "create database qb encoding 'UTF8' template template0 lc_collate 'C.UTF-8' lc_ctype 'C.UTF-8'"]);
const migrate = (f) => run(`${PGBIN}/psql`, [...PSQL, '-d', 'qb', '-v', 'ON_ERROR_STOP=1', '-f', f]);
migrate(`${ROOT}/tests/sql/00_stub.sql`);
for (const f of readdirSync(`${ROOT}/supabase/migrations`).sort()) migrate(`${ROOT}/supabase/migrations/${f}`);

const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };

/** Run SQL as a Supabase API role with JWT claims, the way PostgREST does. Returns the printed text. */
function sql(role, claims, statement) {
  return new Promise((resolveP, rejectP) => {
    const p = spawn(`${PGBIN}/psql`, [...PSQL, '-d', 'qb', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      if (code === 0) return resolveP(out.trim());
      const m = err.match(/ERROR:\s+([0-9A-Z]{5}):\s+([^\n]*)/);
      const detail = err.match(/DETAIL:\s+([^\n]*)/);
      const e = new Error(m ? m[2] : err.slice(0, 300));
      e.pg = { code: m?.[1] ?? 'XX000', message: m?.[2] ?? err.slice(0, 300), details: detail?.[1] ?? null };
      return rejectP(e);
    });
    p.stdin.end(`begin;\nset local role ${role};\n\\o /dev/null\nselect set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true);\n\\o\n${statement};\ncommit;\n`);
  });
}
const superSql = (statement) => run(`${PGBIN}/psql`, [...PSQL, '-d', 'qb', '-t', '-A', '-v', 'ON_ERROR_STOP=1', '-c', statement]).trim();

// ------------------------------------------------------------------ users + sessions
const users = new Map();      // email -> {id, email, password}
const sessions = new Map();   // access token -> user
const refreshTokens = new Map();
function addUser(email, password, { admin }) {
  const id = randomUUID();
  superSql(`insert into auth.users (id, email) values (${lit(id)}, ${lit(email)})`);
  if (admin) superSql(`insert into public.admin_users (user_id) values (${lit(id)})`);
  users.set(email, { id, email, password });
}
addUser('admin@example.com', 'correct-horse-battery', { admin: true });
addUser('reader@example.com', 'just-a-reader-1', { admin: false });

function issue(user) {
  const access_token = `at_${randomBytes(12).toString('hex')}`;
  const refresh_token = `rt_${randomBytes(12).toString('hex')}`;
  sessions.set(access_token, user);
  refreshTokens.set(refresh_token, user);
  const ttl = control.tokenTtl;
  return { access_token, refresh_token, token_type: 'bearer', expires_in: ttl, expires_at: Math.floor(Date.now() / 1000) + ttl, user: { id: user.id, email: user.email } };
}

// ------------------------------------------------------------------ test controls + logs
const control = { gemini: 'ok', tokenTtl: 3600 };
const log = { gemini: [], functions: [] };

// ------------------------------------------------------------------ taxonomy ids for the canned AI answer
const chemId = () => JSON.parse(superSql(`select json_build_object('subject', (select id from subjects where code = 'CHEM'), 'chapter', (select id from chapters where subject_id = (select id from subjects where code = 'CHEM') order by sort_order, id limit 1))`));

function geminiReply(mode) {
  const { subject, chapter } = chemId();
  const q = (over) => ({
    type: 'mcq', question: null, context: null, options: null, match_left: null, match_right: null, answer: null, answer_source: 'none',
    explanation: null, explanation_source: 'none', subject_id: subject, chapter_id: chapter, topic_id: null, difficulty: 'medium', marks: null, tags: [], exams: [], notes: null, ...over,
  });
  if (mode === 'quota') return { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for this model' } } };
  if (mode === 'garbage') return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'this is not json {' }] }, finishReason: 'STOP' }] } };
  if (mode === 'blocked') return { status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } };
  const questions = [
    q({ question: 'Name the process in which a solid changes directly into a gas.', options: ['Evaporation', 'Sublimation', 'Condensation', 'Deposition'], answer: 'B', answer_source: 'extracted', explanation: 'Dry ice does this at room pressure.', explanation_source: 'extracted', tags: ['phases'] }),
    q({ question: 'Which gas is evolved when zinc reacts with dilute sulphuric acid?', options: ['Oxygen', 'Hydrogen', 'Sulphur dioxide', 'Chlorine'], answer: null, answer_source: 'none', notes: 'Answer key not visible in the image.' }),
  ];
  return { status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify({ image_issues: 'Bottom edge slightly cropped.', questions }) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 80 } } };
}

const fakeFetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('generativelanguage.googleapis.com')) {
    const headers = new Headers(init?.headers);
    log.gemini.push({ url: url.replace(/key=[^&]*/, 'key=…'), keyInUrl: /[?&]key=/.test(url), keyHeader: Boolean(headers.get('x-goog-api-key')), bytes: String(init?.body ?? '').length });
    const r = geminiReply(control.gemini);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }
  return fetch(input, init);
};

const functionEnv = {
  SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: ANON }), GEMINI_API_KEY: 'test-gemini-key', GEMINI_MODEL: 'test-model',
  AI_DAILY_LIMIT: '20', ALLOWED_ORIGINS: '*',
};
const handlers = {
  'save-questions': route(handleSave, { log: () => {} }),
  'extract-question': route(handleExtract, { log: () => {} }),
};

// ------------------------------------------------------------------ HTTP plumbing
const readBody = (req) => new Promise((res) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
const send = (res, status, body, headers = {}) => {
  const isObj = body !== null && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { ...(isObj ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
function roleFor(req) {
  const t = bearer(req);
  if (req.headers.apikey !== ANON) return null;                 // the gateway requires the project key
  if (t.startsWith('sb_')) return null;                          // ...and refuses a non-JWT key sent as a bearer token
  if (!t) return { role: 'anon', claims: { role: 'anon' } };
  const u = sessions.get(t);
  if (!u) return null;
  return { role: 'authenticated', claims: { sub: u.id, role: 'authenticated', email: u.email } };
}

async function restApi(req, res, url) {
  const who = roleFor(req);
  if (!who) return send(res, 401, { code: 'PGRST301', message: 'JWT expired' });
  try {
    const path = url.pathname.replace('/rest/v1/', '');
    const bodyBuf = await readBody(req);
    const body = bodyBuf.length ? JSON.parse(bodyBuf.toString('utf8')) : undefined;
    let statement;
    if (path.startsWith('rpc/')) {
      const fn = path.slice(4);
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const val = (v) => {
        if (v === null || v === undefined) return 'null';
        if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string' && UUID.test(x))) return lit(`{${v.join(',')}}`);   // uuid[] parameter
        return lit(typeof v === 'object' ? JSON.stringify(v) : v);
      };
      const args = Object.entries(body ?? {}).map(([k, v]) => `${ident(k)} => ${val(v)}`).join(', ');
      statement = `select coalesce(to_json(public.${ident(fn)}(${args}))::text, 'null')`;
    } else {
      const table = `public.${ident(path)}`;
      const where = [];
      let select = '*'; let order = '';
      for (const [k, v] of url.searchParams) {
        if (k === 'select') select = /^[\w,*]+$/.test(v) ? v : '*';
        else if (k === 'order') order = ` order by ${v.split(',').map((o) => { const [c, d] = o.split('.'); return `${ident(c)}${d === 'desc' ? ' desc' : ''}`; }).join(', ')}`;
        else if (v.startsWith('eq.')) where.push(`${ident(k)} = ${lit(v.slice(3))}`);
        else throw Object.assign(new Error('unsupported filter'), { pg: { code: 'PGRST100', message: `unsupported filter ${k}=${v}` } });
      }
      const w = where.length ? ` where ${where.join(' and ')}` : '';
      if (req.method === 'GET') statement = `select coalesce(json_agg(t), '[]') from (select ${select} from ${table}${w}${order}) t`;
      else if (req.method === 'POST') {
        const rows = Array.isArray(body) ? body : [body];
        const cols = Object.keys(rows[0]).map(ident).join(', ');
        statement = `with r as (insert into ${table} (${cols}) select ${cols} from json_populate_recordset(null::${table}, ${lit(JSON.stringify(rows))}::json) returning *) select coalesce(json_agg(r), '[]') from r`;
      } else if (req.method === 'PATCH') {
        if (!where.length) throw Object.assign(new Error('refusing to update without a filter'), { pg: { code: 'PGRST100', message: 'update needs a filter' } });
        const sets = Object.keys(body).map((k) => `${ident(k)} = n.${ident(k)}`).join(', ');
        statement = `with u as (update ${table} t set ${sets} from json_populate_record(null::${table}, ${lit(JSON.stringify(body))}::json) n${w.replace(/"(\w+)" =/g, 't."$1" =')} returning t.*) select coalesce(json_agg(u), '[]') from u`;
      } else if (req.method === 'DELETE') {
        if (!where.length) throw Object.assign(new Error('refusing to delete without a filter'), { pg: { code: 'PGRST100', message: 'delete needs a filter' } });
        statement = `with d as (delete from ${table}${w} returning *) select coalesce(json_agg(d), '[]') from d`;
      } else return send(res, 405, { message: 'method not allowed' });
    }
    const out = await sql(who.role, who.claims, statement);
    return send(res, req.method === 'POST' && !path.startsWith('rpc/') ? 201 : 200, out || 'null', { 'content-type': 'application/json' });
  } catch (e) {
    const pg = e.pg ?? { code: 'XX000', message: String(e.message).slice(0, 200) };
    const status = pg.code === '42501' ? (who.role === 'anon' ? 401 : 403) : /^(23|P0|22)/.test(pg.code) ? (pg.code.startsWith('23') ? 409 : 400) : pg.code.startsWith('PGRST') ? 400 : 400;
    return send(res, status, pg);
  }
}

async function authApi(req, res, url) {
  const op = url.pathname.replace('/auth/v1/', '');
  if (op === 'token') {
    const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (url.searchParams.get('grant_type') === 'password') {
      const u = users.get(String(b.email).toLowerCase());
      if (!u || u.password !== b.password) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
      return send(res, 200, issue(u));
    }
    const u = refreshTokens.get(b.refresh_token);
    if (!u) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' });
    refreshTokens.delete(b.refresh_token);
    return send(res, 200, issue(u));
  }
  if (op === 'user') {
    const u = sessions.get(bearer(req));
    return u ? send(res, 200, { id: u.id, email: u.email, role: 'authenticated' }) : send(res, 401, { message: 'invalid JWT' });
  }
  if (op === 'logout') { sessions.delete(bearer(req)); return send(res, 204, ''); }
  return send(res, 404, { message: 'not found' });
}

async function functionsApi(req, res, url) {
  const name = url.pathname.replace('/functions/v1/', '');
  const h = handlers[name];
  if (!h) return send(res, 404, { error: { code: 'NOT_FOUND', message: 'no such function' } });
  const body = await readBody(req);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(',') : v);
  const request = new Request(`${ORIGIN}${url.pathname}`, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  log.functions.push({ name, method: req.method, bytes: body.length });
  const r = await h(request, { env: (n) => functionEnv[n], fetchImpl: fakeFetch });
  const buf = Buffer.from(await r.arrayBuffer());
  const out = {}; r.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(r.status, out); res.end(buf);
}

// ------------------------------------------------------------------ static site (+ web/_headers)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const WEB = join(ROOT, 'web');
const globalHeaders = {};
{
  // Apply only the "/*" block of _headers, exactly like Cloudflare would.
  let inGlobal = false;
  for (const line of readFileSync(join(WEB, '_headers'), 'utf8').split('\n')) {
    if (/^\S/.test(line)) inGlobal = line.trim() === '/*';
    else if (inGlobal && line.trim()) { const i = line.indexOf(':'); globalHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
}
function staticFile(res, url) {
  if (url.pathname === '/config.js') {
    return send(res, 200, `window.QB_CONFIG = ${JSON.stringify({ supabaseUrl: ORIGIN, supabasePublishableKey: ANON, siteName: 'Question Bank', copyright: 'AyanP_Chem' })};`, { 'content-type': MIME['.js'], ...globalHeaders });
  }
  let file = join(WEB, decodeURIComponent(url.pathname));
  if (!file.startsWith(WEB)) return send(res, 403, 'forbidden');
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(url.pathname)) return send(res, 404, 'not found', globalHeaders);
    file = join(WEB, 'index.html');             // single-page-app fallback
  }
  return send(res, 200, readFileSync(file), { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', ...globalHeaders });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  res.setHeader('access-control-allow-origin', '*');
  try {
    if (url.pathname === '/__ctl') {
      const b = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      if (b.reset) { log.gemini.length = 0; log.functions.length = 0; superSql('truncate public.ai_usage'); }
      if (b.gemini) control.gemini = b.gemini;
      if (b.tokenTtl) control.tokenTtl = b.tokenTtl;
      if (b.sql) return send(res, 200, { out: superSql(b.sql) });
      return send(res, 200, { control, log });
    }
    if (url.pathname.startsWith('/rest/v1/')) return await restApi(req, res, url);
    if (url.pathname.startsWith('/auth/v1/')) return await authApi(req, res, url);
    if (url.pathname.startsWith('/functions/v1/')) return await functionsApi(req, res, url);
    return staticFile(res, url);
  } catch (e) { console.error('harness error', e); send(res, 500, { message: 'harness error' }); }
});

const stop = () => {
  try { run(`${PGBIN}/pg_ctl`, ['-D', `${DATA}/db`, '-m', 'immediate', 'stop']); } catch { /* already stopped */ }
  rmSync(DATA, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
server.listen(PORT, '127.0.0.1', () => console.log(`READY ${ORIGIN}`));
