// Public pages: home, browse (subject > chapter > topic), search, single question.
import { html, plural } from '../dom.js';
import { navigate, query, withQuery } from '../router.js';
import * as api from '../api.js';
import { QUESTION_TYPES } from '../core/constants.js';
import { renderQuestion } from './question-view.js';
import { bindFilterBar, filterBar } from './filterbar.js';

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

const hrefFor = (v) => {
  const { subject, chapter, topic, ...rest } = v;
  const path = subject ? `/browse/${subject}${chapter ? `/${chapter}` : ''}${chapter && topic ? `/${topic}` : ''}` : '/search';
  return withQuery(path, rest);
};

/** The dropdowns above the list. Options carry counts of published questions in the chosen subject/chapter/topic. */
function publicFields({ tree, facets, s, c }) {
  const kinds = [{ value: 'exam', label: 'Exam questions', count: facets.exam }, { value: 'general', label: 'General practice', count: facets.general }].filter((k) => k.count);
  return [
    { key: 'subject', label: 'Subject', all: 'All subjects', opts: tree.map((x) => ({ value: x.slug, label: x.name, count: x.count })) },
    { key: 'chapter', label: 'Chapter', all: 'All chapters', opts: (s?.chapters ?? []).map((x) => ({ value: x.slug, label: x.name, count: x.count })), disabledHint: 'Pick a subject first' },
    { key: 'topic', label: 'Topic', all: 'All topics', opts: (c?.topics ?? []).map((x) => ({ value: x.slug, label: x.name, count: x.count })), disabledHint: 'Pick a chapter first' },
    { key: 'type', label: 'Question type', all: 'All types', opts: facets.types.map((t) => ({ value: t.code, label: t.label, count: t.count })) },
    { key: 'category', label: 'Kind', all: 'Any kind', more: true, opts: kinds },
    { key: 'exam', label: 'Exam', all: 'All exams', more: true, opts: facets.exams.map((e) => ({ value: String(e.id), label: e.name, count: e.count })) },
    { key: 'year', label: 'Year', all: 'Any year', more: true, opts: facets.years.map((y) => ({ value: String(y.value), label: String(y.value), count: y.count })) },
    { key: 'difficulty', label: 'Difficulty', all: 'Any difficulty', more: true, opts: facets.difficulty.map((d) => ({ value: d.value, label: d.value[0].toUpperCase() + d.value.slice(1), count: d.count })) },
    { key: 'marks', label: 'Marks', all: 'Any marks', more: true, opts: facets.marks.map((m) => ({ value: String(Number(m.value)), label: `${Number(m.value)} ${Number(m.value) === 1 ? 'mark' : 'marks'}`, count: m.count })) },
    { key: 'tag', label: 'Tag', all: 'Any tag', more: true, opts: facets.tags.map((t) => ({ value: t.value, label: t.value, count: t.count })) },
  ];
}

export async function browse(ctx, app) {
  const q = query();
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const isSearch = ctx.path === '/search' || ctx.path === '/browse';
  setTitle(isSearch ? (q.q ? `Search: ${q.q}` : 'Find questions') : 'Browse');
  app.innerHTML = '<div class="container loading">Loading…</div>';
  try {
    const tax = await api.getTaxonomy();
    const found = isSearch ? { s: null, c: null, t: null } : findBySlug(tax.tree, ctx.params);
    if (found.missing) { app.innerHTML = html`<div class="container"><div class="empty-state"><h2>We could not find that ${found.missing}.</h2><p><a href="/search">Back to the question bank</a></p></div></div>`.toString(); return; }
    const { s, c, t } = found;
    const scope = { subject: s?.id, chapter: c?.id, topic: t?.id };
    const hasFilter = Boolean(s) || FILTER_KEYS.some((k) => q[k]);
    const filters = { ...scope, q: q.q, type: q.type, category: q.category, exam: q.exam, year: q.year, difficulty: q.difficulty, marks: q.marks, tag: q.tag };
    // Nothing is listed until a filter is chosen, so the question search only runs when one is.
    const [result, facets, tx] = await Promise.all([
      hasFilter ? api.search({ ...filters, limit: PAGE, offset: (page - 1) * PAGE }) : Promise.resolve(null),
      api.getFacets(scope),
      q.q && page === 1 ? api.searchTaxonomy(q.q).catch(() => null) : Promise.resolve(null),
    ]);
    if (ctx.stale()) return;

    const values = { subject: s?.slug, chapter: c?.slug, topic: t?.slug, q: q.q, type: q.type, category: q.category, exam: q.exam, year: q.year, difficulty: q.difficulty, marks: q.marks, tag: q.tag };
    const base = hrefFor({ subject: s?.slug, chapter: c?.slug, topic: t?.slug });
    const heading = t?.name ?? c?.name ?? s?.name ?? (q.q ? `Results for “${q.q}”` : 'Find questions');
    const pageHref = (p) => withQuery(base, { ...q, page: p > 1 ? p : null });
    const bar = filterBar({ fields: publicFields({ tree: tax.tree, facets, s, c }), values, searchPlaceholder: 'Search questions or IDs' });

    let list;
    if (!hasFilter) {
      list = facets.total
        ? html`<div class="pick-prompt"><h2>Choose a filter to see questions</h2>
            <p class="muted">Pick a subject, a type, an exam or any other dropdown above, or type a word and press Search. ${plural(facets.total, 'published question')} ${facets.total === 1 ? 'is' : 'are'} waiting.</p></div>`
        : html`<div class="notice">Nothing has been published yet, so there are no questions to show.</div>`;
    } else {
      list = html`<p class="muted" id="count">${plural(facets.total, 'published question')}${(s || c || t) ? ' in this part of the bank' : ''} · ${result.items.length}${result.has_more || page > 1 ? '+' : ''} shown with your filters</p>
        ${tx && (tx.chapters.length || tx.topics.length) ? html`<section class="section"><h2>Matching chapters and topics</h2><ul class="sublist">
          ${tx.chapters.map((x) => html`<li><a href="/browse/${x.subject_slug}/${x.slug}"><span>${x.name} <span class="muted">· ${x.subject_name}</span></span><span class="n">chapter</span></a></li>`)}
          ${tx.topics.map((x) => html`<li><a href="/browse/${x.subject_slug}/${x.chapter_slug}/${x.slug}"><span>${x.name} <span class="muted">· ${x.chapter_name}</span></span><span class="n">topic</span></a></li>`)}</ul></section>` : ''}
        ${result.items.length ? html`<ol class="qlist">${result.items.map((it) => html`<li>${renderQuestion(it, { index: tax.index })}</li>`)}</ol>` : html`<div class="empty-state"><p><b>No questions match these filters.</b></p><p class="muted">Try another dropdown value, or clear the filters.</p></div>`}
        <div class="pager">${page > 1 ? html`<a class="btn" href="${pageHref(page - 1)}">Previous</a>` : html`<span></span>`}<span class="muted small">Page ${page}</span>${result.has_more ? html`<a class="btn" href="${pageHref(page + 1)}">Next</a>` : html`<span></span>`}</div>`;
    }

    app.innerHTML = html`<div class="container"><h1 class="h-page">${heading}</h1>${bar}<section class="section" aria-label="Questions">${list}</section></div>`.toString();
    bindFilterBar(app, (key, v) => {
      const next = { ...v };
      if (key === 'subject') { delete next.chapter; delete next.topic; }
      if (key === 'chapter') delete next.topic;
      navigate(hrefFor(next));
    });
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
