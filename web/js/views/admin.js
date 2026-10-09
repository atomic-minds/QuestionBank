// Admin shell: sign-in, navigation, dashboard. Other admin screens are separate modules.
import { html } from '../dom.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { errorBox, setTitle } from './public.js';

let verified = false;

const NAV = [['/admin', 'Dashboard'], ['/admin/add', 'Add questions'], ['/admin/review', 'Review drafts'], ['/admin/questions', 'All questions'], ['/admin/taxonomy', 'Taxonomy'], ['/admin/export', 'Export & backup']];

export const adminNav = (path) => html`<nav class="admin-nav" aria-label="Admin"><div class="container">
  ${NAV.map(([href, label]) => html`<a href="${href}" ${path === href ? 'aria-current=page' : ''}>${label}</a>`)}
  <button type="button" data-act="sign-out">Sign out</button></div></nav>`;

export function loginView(app, onDone) {
  setTitle('Admin sign-in');
  app.innerHTML = html`<div class="container narrow"><div class="page-head"><h1>Admin sign-in</h1></div>
    <form class="panel" id="login" novalidate>
      <div class="field"><label for="em">Email</label><input id="em" type="email" name="email" autocomplete="username" required></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" name="password" autocomplete="current-password" required></div>
      <div id="login-err"></div>
      <button class="btn-primary" type="submit">Sign in</button>
      <p class="hint">Only accounts an owner has added as admins can sign in. There is no public sign-up.</p>
    </form></div>`.toString();
  app.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const btn = e.currentTarget.querySelector('button'); btn.disabled = true; btn.textContent = 'Signing in…';
    try { await api.signIn(f.get('email'), f.get('password')); verified = true; onDone(); } catch (err) {
      app.querySelector('#login-err').innerHTML = html`<div class="notice bad" role="alert">${err.message}</div>`.toString();
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  });
}

/** Entry for every /admin/* route. */
export async function adminRoute(name, ctx, app) {
  if (!api.isConfigured()) { app.innerHTML = html`<div class="container">${errorBox({ code: 'NOT_CONFIGURED', message: 'This site is not connected to its database yet.' })}</div>`.toString(); return; }
  if (!api.signedIn()) { loginView(app, () => navigate(ctx.path + location.search, { replace: true })); return; }
  if (!verified) {
    if (!(await api.checkAdmin())) { await api.signOut(); loginView(app, () => navigate(ctx.path, { replace: true })); return; }
    verified = true;
  }
  if (ctx.stale()) return;
  app.innerHTML = html`${adminNav(ctx.path)}<div class="container" id="admin-body"><p class="loading">Loading…</p></div>`.toString();
  app.querySelector('[data-act=sign-out]').addEventListener('click', async () => { await api.signOut(); verified = false; navigate('/admin'); });
  const body = app.querySelector('#admin-body');
  try {
    const mod = await ({
      dashboard: () => Promise.resolve({ default: dashboard }),
      add: () => import('./admin-add.js'),
      review: () => import('./admin-review.js'),
      questions: () => import('./admin-questions.js'),
      edit: () => import('./admin-questions.js').then((m) => ({ default: m.editPage })),
      taxonomy: () => import('./admin-taxonomy.js'),
      export: () => import('./admin-export.js'),
    }[name])();
    await mod.default(ctx, body);
  } catch (e) {
    if (e.code === 'UNAUTHENTICATED') { verified = false; navigate('/admin', { replace: true }); return; }
    if (!ctx.stale()) body.innerHTML = errorBox(e).toString();
  }
}

async function dashboard(ctx, body) {
  setTitle('Admin');
  const stats = await api.adminStats();
  if (ctx.stale()) return;
  const by = stats.by_status ?? {};
  const total = Object.values(by).reduce((a, b) => a + b, 0);
  const mb = stats.db_bytes / 1024 / 1024;
  const pct = Math.min(100, (mb / 500) * 100);
  const cls = pct <= 0 ? 'w0' : `w${Math.min(100, Math.ceil(pct / 10) * 10)}`;
  body.innerHTML = html`<div class="page-head"><h1>Dashboard</h1><a class="btn btn-primary" href="/admin/add">Add questions</a></div>
    <div class="stats">
      <div class="stat"><b>${total}</b>questions in total</div>
      <div class="stat"><b>${by.published ?? 0}</b><a href="/admin/questions?status=published">published</a></div>
      <div class="stat"><b>${(by.draft ?? 0) + (by.review ?? 0)}</b><a href="/admin/questions?status=draft">waiting for review</a> <span class="muted small">(${by.draft ?? 0} draft, ${by.review ?? 0} in review)</span></div>
      <div class="stat"><b>${by.archived ?? 0}</b><a href="/admin/questions?status=archived">archived</a></div>
    </div>
    <div class="stats">
      <div class="stat"><b>${stats.ai_used_today}</b>AI image reads today<div class="hint">The count restarts at 12:00 am India time. Reads that Google rejects or fails are not counted. Your daily cap is set by the AI_DAILY_LIMIT secret. Google has its own free limit, which resets at about 12:30 pm IST.</div></div>
      <div class="stat"><b>${mb.toFixed(1)} MB</b>database size, of 500 MB free<div class="meter" role="img" aria-label="${pct.toFixed(0)} percent of the free database used"><i class="${cls}"></i></div>
        <div class="hint">Adding new questions pauses automatically before the free limit (450 MB unless you changed DB_SOFT_LIMIT_MB). Editing still works.</div></div>
    </div>
    <div class="panel"><h2>Keep a copy</h2><p>The free Supabase plan has no automatic backups. Download a full backup now and then.</p>
      <a class="btn" href="/admin/export">Export & backup</a></div>`.toString();
}
