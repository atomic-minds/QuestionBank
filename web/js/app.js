// Entry point: shell, routes, start-up.
import { html } from './dom.js';
import { interceptLinks, navigate, notFound, render, route } from './router.js';
import * as api from './api.js';
import { bindReveal } from './views/question-view.js';
import { browse, home, questionPage, setTitle } from './views/public.js';

function shell() {
  const year = new Date().getFullYear();
  document.getElementById('shell').innerHTML = html`
    <header class="site-header"><div class="container">
      <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">Q</span><span>${api.settings.siteName}</span></a>
      <form class="header-search" action="/search" role="search"><label class="sr" for="hq">Search questions</label><input id="hq" type="search" name="q" placeholder="Search questions" autocomplete="off"></form>
      <nav class="site-nav" aria-label="Main"><a href="/">Subjects</a><a href="/search">All questions</a><a class="admin-link" href="/admin" data-nav-admin>Admin</a></nav>
    </div></header>
    <main id="app" tabindex="-1"></main>
    <footer class="site-footer"><div class="container">© ${year} ${api.settings.copyright}. Questions are reviewed before they are published.</div></footer>`.toString();
  document.querySelector('.header-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.currentTarget).get('q').toString().trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  });
}

const view = (fn) => (ctx) => {
  const app = document.getElementById('app');
  document.querySelectorAll('.site-nav a').forEach((a) => a.toggleAttribute('aria-current', a.getAttribute('href') === ctx.path));
  return fn(ctx, app);
};

shell();
bindReveal(document.getElementById('app'));
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
  const mod = await import('./views/admin.js');
  return mod.adminRoute(name, ctx, app);
};
for (const [pattern, name] of [['/admin', 'dashboard'], ['/admin/add', 'add'], ['/admin/review', 'review'], ['/admin/questions', 'questions'],
  ['/admin/edit/:id', 'edit'], ['/admin/taxonomy', 'taxonomy'], ['/admin/export', 'export']]) route(pattern, admin(name));

notFound((ctx) => {
  setTitle('Not found');
  document.getElementById('app').innerHTML = html`<div class="container narrow"><div class="empty-state"><h2>That page does not exist.</h2><p><a href="/">Go to the question bank</a></p></div></div>`.toString();
});

interceptLinks();
render();
