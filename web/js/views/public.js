// Public pages: home, browse (subject > chapter > topic), search, single question.
import { html, plural } from '../dom.js';
import { navigate, query, withQuery } from '../router.js';
import * as api from '../api.js';
import { QUESTION_TYPES } from '../core/constants.js';
import { renderQuestion } from './question-view.js';

const PAGE = 20;
const FILTER_KEYS = ['q', 'type', 'category', 'exam', 'year', 'difficulty', 'marks', 'tag'];

export const errorBox = (e) => html`<div class="notice bad" role="alert"><b>${e?.message ?? 'Something went wrong.'}</b>${e?.code === 'NOT_CONFIGURED' ? html`<p class="small">Open <code>web/config.js</code> and paste your Supabase URL and public key.</p>` : ''}</div>`;

export function setTitle(t) { document.title = t ? `${t} · ${api.settings.siteName}` : api.settings.siteName; }

function subjectTiles(tree) {
  return html`<ul class="tiles">${tree.map((s) => html`<li><a class="tile ${s.count ? '' : 'empty'}" href="/browse/${s.slug}">
    <span class="count">${plural(s.count, 'question')}</span><span class="sym">${s.code}</span><span class="nm">${s.name}</span></a></li>`)}</ul>`;
}

export async function home(ctx, app) {
  setTitle('');
  app.innerHTML = html`<div class="container"><section class="hero">
    <h1>Search the question bank.</h1>
    <p class="lede">Every question is reviewed before it is published. Open one, think it through, then check the answer.</p>
    <form class="big-search" action="/search" role="search"><label class="sr" for="home-q">Search questions</label>
      <input id="home-q" type="search" name="q" placeholder="Search questions or IDs" autocomplete="off">
      <button class="btn-primary" type="submit">Search</button></form>
  </section><div id="home-body" class="loading">Loading…</div></div>`.toString();
  try {
    const [tax, facets] = await Promise.all([api.getTaxonomy(), api.getFacets()]);
    if (ctx.stale()) return;
    const body = html`
      <section class="section" aria-labelledby="subj-h"><h2 id="subj-h">Subjects</h2>
        ${tax.tree.length ? subjectTiles(tax.tree) : html`<div class="empty-state"><p><b>No subjects yet.</b></p><p class="muted">An admin can add subjects and chapters under Admin › Taxonomy.</p></div>`}
      </section>
      ${facets.total ? html`<section class="section"><h2>Question types</h2><ul class="chips">
        ${facets.types.map((t) => html`<li><a class="chip" href="/search?type=${t.code}">${t.label} <span class="n">${t.count}</span></a></li>`)}</ul></section>
      ${facets.exams.length ? html`<section class="section"><h2>Exams</h2><ul class="chips">
        ${facets.exams.map((x) => html`<li><a class="chip" href="/search?exam=${x.id}">${x.name} <span class="n">${x.count}</span></a></li>`)}</ul></section>` : ''}` :
      html`<div class="notice">Nothing has been published yet, so there are no questions to browse.</div>`}`;
    app.querySelector('#home-body').outerHTML = body.toString();
  } catch (e) { if (!ctx.stale()) app.querySelector('#home-body').outerHTML = errorBox(e).toString(); }
}

// ------------------------------------------------------------------ browse / search
function findBySlug(tree, { subject, chapter, topic }) {
  const s = tree.find((x) => x.slug === subject);
  if (subject && !s) return { missing: 'subject' };
  const c = chapter ? s?.chapters.find((x) => x.slug === chapter) : null;
  if (chapter && !c) return { missing: 'chapter' };
  const t = topic ? c?.topics.find((x) => x.slug === topic) : null;
  if (topic && !t) return { missing: 'topic' };
  return { s, c, t };
}

function filterGroups(facets) {
  const kinds = [{ value: 'exam', label: 'Exam questions', count: facets.exam }, { value: 'general', label: 'General practice', count: facets.general }].filter((k) => k.count);
  return [
    { key: 'category', title: 'Kind', opts: kinds.map((k) => ({ value: k.value, label: k.label, count: k.count })) },
    { key: 'type', title: 'Question type', opts: facets.types.map((t) => ({ value: t.code, label: t.label, count: t.count })) },
    { key: 'exam', title: 'Exam', opts: facets.exams.map((e) => ({ value: String(e.id), label: e.name, count: e.count })) },
    { key: 'year', title: 'Year', opts: facets.years.map((y) => ({ value: String(y.value), label: String(y.value), count: y.count })) },
    { key: 'difficulty', title: 'Difficulty', opts: facets.difficulty.map((d) => ({ value: d.value, label: d.value[0].toUpperCase() + d.value.slice(1), count: d.count })) },
    { key: 'marks', title: 'Marks', opts: facets.marks.map((m) => ({ value: String(Number(m.value)), label: `${Number(m.value)} ${Number(m.value) === 1 ? 'mark' : 'marks'}`, count: m.count })) },
    { key: 'tag', title: 'Tags', opts: facets.tags.map((t) => ({ value: t.value, label: t.value, count: t.count })) },
  ].filter((g) => g.opts.length);
}

function filtersPanel(groups, base, q) {
  return html`<nav class="filters" aria-label="Filters">${groups.map((g) => html`<details ${q[g.key] || g.key === 'type' || g.key === 'category' ? 'open' : ''}>
    <summary>${g.title}</summary>${g.opts.map((o) => {
      const active = q[g.key] === o.value;
      return html`<a class="opt" href="${withQuery(base, { ...q, [g.key]: active ? null : o.value, page: null })}" aria-current="${active}"><span>${o.label}</span><span class="n">${o.count}</span></a>`;
    })}</details>`)}</nav>`;
}

function activeChips(groups, base, q) {
  const chips = [];
  if (q.q) chips.push({ label: `“${q.q}”`, params: { ...q, q: null, page: null } });
  for (const g of groups) if (q[g.key]) {
    const o = g.opts.find((x) => x.value === q[g.key]);
    chips.push({ label: `${g.title}: ${o?.label ?? q[g.key]}`, params: { ...q, [g.key]: null, page: null } });
  }
  return chips.length ? html`<div class="active-filters">${chips.map((c) => html`<a class="chip" href="${withQuery(base, c.params)}">${c.label} <span aria-hidden="true">×</span><span class="sr">remove filter</span></a>`)}</div>` : '';
}

export async function browse(ctx, app) {
  const q = query();
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const isSearch = ctx.path === '/search';
  setTitle(isSearch ? (q.q ? `Search: ${q.q}` : 'Search') : 'Browse');
  app.innerHTML = '<div class="container loading">Loading…</div>';
  try {
    const tax = await api.getTaxonomy();
    const found = isSearch ? { s: null, c: null, t: null } : findBySlug(tax.tree, ctx.params);
    if (found.missing) { app.innerHTML = html`<div class="container"><div class="empty-state"><h2>We could not find that ${found.missing}.</h2><p><a href="/">Back to all subjects</a></p></div></div>`.toString(); return; }
    const { s, c, t } = found;
    const scope = { subject: s?.id, chapter: c?.id, topic: t?.id };
    const filters = { ...scope, q: q.q, type: q.type, category: q.category, exam: q.exam, year: q.year, difficulty: q.difficulty, marks: q.marks, tag: q.tag };
    const [result, facets, tx] = await Promise.all([
      api.search({ ...filters, limit: PAGE, offset: (page - 1) * PAGE }),
      api.getFacets(scope),
      isSearch && q.q && page === 1 ? api.searchTaxonomy(q.q).catch(() => null) : Promise.resolve(null),
    ]);
    if (ctx.stale()) return;

    const base = isSearch ? '/search' : `/browse${s ? `/${s.slug}` : ''}${c ? `/${c.slug}` : ''}${t ? `/${t.slug}` : ''}`;
    const groups = filterGroups(facets);
    const children = t ? null : c ? { label: 'Topics', items: c.topics.map((x) => ({ name: x.name, n: x.count, href: `/browse/${s.slug}/${c.slug}/${x.slug}` })) }
      : s ? { label: 'Chapters', items: s.chapters.map((x) => ({ name: x.name, n: x.count, href: `/browse/${s.slug}/${x.slug}` })) } : null;
    const heading = t?.name ?? c?.name ?? s?.name ?? (isSearch ? (q.q ? `Results for “${q.q}”` : 'All questions') : 'Questions');
    const hasFilter = FILTER_KEYS.some((k) => q[k]);
    const pageHref = (p) => withQuery(base, { ...q, page: p > 1 ? p : null });

    app.innerHTML = html`<div class="container">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">All subjects</a>
        ${s ? html`<span aria-hidden="true">›</span><a href="/browse/${s.slug}">${s.name}</a>` : ''}
        ${c ? html`<span aria-hidden="true">›</span><a href="/browse/${s.slug}/${c.slug}">${c.name}</a>` : ''}
        ${t ? html`<span aria-hidden="true">›</span><span>${t.name}</span>` : ''}</nav>
      <h1 class="h-page">${heading}</h1>
      <p class="muted">${plural(facets.total, 'published question')}${(s || c || t) ? ' here' : ''}${hasFilter ? ` · ${result.items.length}${result.has_more || page > 1 ? '+' : ''} shown with these filters` : ''}</p>
      ${tx && (tx.chapters.length || tx.topics.length) ? html`<section class="section"><h2>Matching chapters and topics</h2><ul class="sublist">
        ${tx.chapters.map((x) => html`<li><a href="/browse/${x.subject_slug}/${x.slug}"><span>${x.name} <span class="muted">· ${x.subject_name}</span></span><span class="n">chapter</span></a></li>`)}
        ${tx.topics.map((x) => html`<li><a href="/browse/${x.subject_slug}/${x.chapter_slug}/${x.slug}"><span>${x.name} <span class="muted">· ${x.chapter_name}</span></span><span class="n">topic</span></a></li>`)}</ul></section>` : ''}
      ${children?.items.length ? html`<section class="section"><h2>${children.label}</h2><ul class="sublist">${children.items.map((i) => html`<li><a href="${i.href}"><span>${i.name}</span><span class="n">${i.n}</span></a></li>`)}</ul></section>` : ''}
      <div class="browse section"><aside aria-label="Filters"><details class="filters-mobile" open>${filtersPanel(groups, base, q)}</details></aside>
      <section aria-label="Questions">${activeChips(groups, base, q)}
        ${result.items.length ? html`<ol class="qlist">${result.items.map((it) => html`<li>${renderQuestion(it, { index: tax.index })}</li>`)}</ol>` : html`<div class="empty-state"><p><b>${hasFilter || q.q ? 'No questions match these filters.' : 'No published questions here yet.'}</b></p>${hasFilter ? html`<p><a href="${base}">Clear all filters</a></p>` : ''}</div>`}
        <div class="pager">${page > 1 ? html`<a class="btn" href="${pageHref(page - 1)}">Previous</a>` : html`<span></span>`}<span class="muted small">Page ${page}</span>${result.has_more ? html`<a class="btn" href="${pageHref(page + 1)}">Next</a>` : html`<span></span>`}</div>
      </section></div></div>`.toString();
    if (window.matchMedia?.('(max-width: 760px)').matches) app.querySelector('.filters-mobile')?.removeAttribute('open');
    if (page > 1) window.scrollTo({ top: 0 });
  } catch (e) { if (!ctx.stale()) app.innerHTML = html`<div class="container">${errorBox(e)}</div>`.toString(); }
}

export async function questionPage(ctx, app) {
  const pid = ctx.params.id.toUpperCase();
  setTitle(pid);
  app.innerHTML = '<div class="container loading">Loading…</div>';
  try {
    const [q, tax] = await Promise.all([api.getQuestion(pid), api.getTaxonomy()]);
    if (ctx.stale()) return;
    if (!q) { app.innerHTML = html`<div class="container narrow"><div class="empty-state"><h2>Question not found</h2><p>${pid} is not published, or the ID is wrong.</p><p><a href="/">Browse the question bank</a></p></div></div>`.toString(); return; }
    setTitle(`${pid} · ${q.question_text.slice(0, 60)}`);
    app.innerHTML = html`<div class="container narrow"><ol class="qlist"><li>${renderQuestion(q, { index: tax.index, admin: api.signedIn() })}</li></ol>
      <p class="small muted">Share this question: <code>${location.origin}/q/${pid}</code></p></div>`.toString();
  } catch (e) { if (!ctx.stale()) app.innerHTML = html`<div class="container narrow">${errorBox(e)}</div>`.toString(); }
}
export { navigate };
