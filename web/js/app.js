// Entry point: shell, routes, start-up.
import { html } from './dom.js';
import { interceptLinks, navigate, notFound, render, route } from './router.js';
import * as api from './api.js';
import { bindReveal } from './views/question-view.js';
import { watchImages } from './views/images.js';
import { browse, home, questionPage, setTitle } from './views/public.js';

function shell() {
  const year = new Date().getFullYear();
  document.getElementById('shell').innerHTML = html`
    <header class="site-header"><div class="container">
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">Q</span><span>${api.settings.siteName}</span></a>
      <button type="button" class="menu-btn" id="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button>
      <form class="header-search" action="/search" role="search"><label class="sr" for="hq">Search questions</label><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><input id="hq" type="search" name="q" placeholder="Search questions" autocomplete="off"></form>
      <nav class="site-nav" aria-label="Main"><a href="/"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/></svg><span>Subjects</span></a><a href="/search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r=".8"/><circle cx="4" cy="12" r=".8"/><circle cx="4" cy="18" r=".8"/></svg><span>All questions</span></a><a class="admin-link" href="/admin" data-nav-admin><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.4 3.1 7.6 7.5 9 4.4-1.4 7.5-4.6 7.5-9V6L12 3z"/></svg><span>Admin</span></a></nav>
    </div></header>
    <div class="menu-scrim" id="menu-scrim" hidden></div>
    <nav class="menu" id="menu" aria-label="Menu" hidden></nav>
    <main id="app" tabindex="-1"></main>
    <footer class="site-footer"><div class="container">© ${year} ${api.settings.copyright}. Questions are reviewed before they are published.</div></footer>`.toString();
  document.querySelector('.header-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q').toString().trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  });
}

// ---- install to the home screen ----
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });
addEventListener('appinstalled', () => { installEvent = null; });
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if ('serviceWorker' in navigator) addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* the site works fine without it */ }); });

const ADMIN_LINKS = [['/admin', 'Dashboard'], ['/admin/add', 'Add questions'], ['/admin/review', 'Review drafts'], ['/admin/questions', 'All questions'], ['/admin/worksheet', 'Print worksheet'], ['/admin/taxonomy', 'Taxonomy'], ['/admin/export', 'Export & backup']];

/** The hamburger menu: every place in the site in one list (phones; hidden on wide screens, which have a full nav bar). */
function setupMenu() {
  const btn = document.getElementById('menu-btn');
  const menu = document.getElementById('menu');
  const scrim = document.getElementById('menu-scrim');
  const here = () => location.pathname;
  const link = (href, label, extra = '') => html`<a href="${href}" ${here() === href ? 'aria-current=page' : ''}><span>${label}</span>${extra}</a>`;

  async function fill() {
    let subjects = [];
    try { subjects = (await api.getTaxonomy()).tree; } catch { /* the menu still works without subjects */ }
    menu.innerHTML = html`<div class="menu-head"><b>Menu</b><button type="button" class="btn-quiet btn-sm" data-menu-close aria-label="Close menu">✕</button></div>
      <div class="menu-section">${link('/', 'Subjects')}${link('/search', 'All questions')}</div>
      ${subjects.length ? html`<p class="menu-label">Browse by subject</p><div class="menu-section">${subjects.map((s) => html`<a href="/browse/${s.slug}" ${here() === `/browse/${s.slug}` ? 'aria-current=page' : ''}><span>${s.name}</span><span class="n">${s.count}</span></a>`)}</div>` : ''}
      <p class="menu-label">Admin</p>
      <div class="menu-section">${api.signedIn() ? ADMIN_LINKS.map(([h, l]) => link(h, l)) : link('/admin', 'Admin sign-in')}</div>
      ${api.signedIn() ? html`<div class="menu-section"><button type="button" class="btn-quiet menu-out" data-menu-signout>Sign out</button></div>` : ''}
      ${isStandalone() ? '' : html`<p class="menu-label">App</p><div class="menu-section">${installEvent
        ? html`<button type="button" class="btn-quiet menu-out" data-install>Install on this device</button>`
        : html`<p class="menu-note">${isIos() ? 'To install: tap the Share button, then “Add to Home Screen”.' : 'To install: open your browser menu and choose “Install app” or “Add to Home screen”.'}</p>`}</div>`}`.toString();
  }
  const isOpen = () => !menu.hidden;
  function close(returnFocus = true) {
    if (!isOpen()) return;
    menu.hidden = true; scrim.hidden = true;
    btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-label', 'Open menu');
    if (returnFocus) btn.focus();
  }
  async function open() {
    await fill();
    menu.hidden = false; scrim.hidden = false;
    btn.setAttribute('aria-expanded', 'true'); btn.setAttribute('aria-label', 'Close menu');
    menu.querySelector('a, button')?.focus();
  }
  btn.addEventListener('click', () => (isOpen() ? close() : open()));
  scrim.addEventListener('click', () => close(false));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  menu.addEventListener('click', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    if (t.closest('[data-menu-close]')) { close(); return; }
    if (t.closest('[data-install]') && installEvent) {
      const ev = installEvent; installEvent = null;
      close(false);
      ev.prompt?.();
      return;
    }
    if (t.closest('[data-menu-signout]')) {
      close(false);
      const nav = document.querySelector('[data-act=sign-out]');
      if (nav) nav.click(); else api.signOut().then(() => navigate('/admin'));
      return;
    }
    if (t.closest('a')) close(false);
  });
  addEventListener('popstate', () => close(false));
  matchMedia('(min-width: 760px)').addEventListener?.('change', (e) => { if (e.matches) close(false); });
}

const view = (fn) => (ctx) => {
  const app = document.getElementById('app');
  document.body.dataset.area = 'public';
  document.querySelectorAll('.site-nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === ctx.path));
  return fn(ctx, app);
};

document.body.dataset.area = location.pathname.startsWith('/admin') ? 'admin' : 'public';
shell();
setupMenu();
bindReveal(document.getElementById('app'));
watchImages(document.getElementById('app'));
route('/', view(home));
route('/browse', view((ctx, app) => browse({ ...ctx, params: {} }, app)));
route('/browse/:subject', view(browse));
route('/browse/:subject/:chapter', view(browse));
route('/browse/:subject/:chapter/:topic', view(browse));
route('/search', view(browse));
route('/q/:id', view(questionPage));

// Admin pages are loaded on demand so public visitors never download them.
const admin = (name) => async (ctx) => {
  const app = document.getElementById('app');
  document.body.dataset.area = 'admin';
  const mod = await import('./views/admin.js');
  return mod.adminRoute(name, ctx, app);
};
for (const [pattern, name] of [['/admin', 'dashboard'], ['/admin/add', 'add'], ['/admin/review', 'review'], ['/admin/questions', 'questions'],
  ['/admin/edit/:id', 'edit'], ['/admin/worksheet', 'worksheet'], ['/admin/taxonomy', 'taxonomy'], ['/admin/export', 'export']]) route(pattern, admin(name));

notFound((ctx) => {
  setTitle('Not found');
  document.getElementById('app').innerHTML = html`<div class="container narrow"><div class="empty-state"><h2>That page does not exist.</h2><p><a href="/">Go to the question bank</a></p></div></div>`.toString();
});

interceptLinks();
render();
