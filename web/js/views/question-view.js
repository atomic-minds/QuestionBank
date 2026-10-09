// How a question is shown (public pages and admin previews share this).
import { html, rich } from '../dom.js';
import { isStructureText } from '../core/chem.js';
import { QUESTION_TYPES } from '../core/constants.js';

const DIFF = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

export function answerSummary(q) {
  const a = q.answer ?? {};
  if (a.value !== undefined && q.options) {
    const o = q.options.find((x) => x.id === a.value);
    return `${a.value}. ${o?.text ?? ''}`;
  }
  if (a.number !== undefined) return `${a.number}${a.unit ? ` ${a.unit}` : ''}${a.tolerance ? ` (±${a.tolerance})` : ''}`;
  if (a.pairs && q.match_items) {
    return q.match_items.left.map((l) => {
      const r = q.match_items.right.find((x) => x.id === a.pairs[l.id]);
      return `${l.id} → ${a.pairs[l.id]} (${l.text} — ${r?.text ?? ''})`;
    }).join('\n');
  }
  return a.text ?? '';
}

export function pathOf(q, index) {
  const s = index?.subjectById.get(q.subject_id);
  const c = index?.chapterById.get(q.chapter_id);
  const t = q.topic_id ? index?.topicById.get(q.topic_id) : null;
  return { s, c, t };
}

/**
 * @param {any} q  a question as returned by qb_search_questions
 * @param {{index?: any, admin?: boolean, headingLevel?: number}} [opts]
 */
export function renderQuestion(q, { index, admin = false } = {}) {
  const { s, c, t } = pathOf(q, index);
  const type = QUESTION_TYPES[q.type_code]?.label ?? q.type_code;
  const marks = q.marks !== null && q.marks !== undefined ? Number(q.marks) : null;
  const ansId = `ans-${q.public_id}`;
  return html`
  <article class="q" data-pid="${q.public_id}" data-qid="${q.id ?? ''}" data-answer-key="${q.answer?.value ?? ''}">
    <div class="q-meta">
      <a class="q-id" href="/q/${q.public_id}">${q.public_id}</a>
      <span class="q-type">${type}</span>
      ${q.difficulty ? html`<span class="ph ${q.difficulty}">${DIFF[q.difficulty]}</span>` : ''}
      ${marks !== null ? html`<span>${marks} ${marks === 1 ? 'mark' : 'marks'}</span>` : ''}
      ${admin ? html`<span class="badge ${q.status}">${q.status}</span>${q.origin === 'ai_image' ? html`<span class="badge ai">AI</span>` : ''}` : ''}
    </div>
    ${q.context ? html`<div class="q-context ${isStructureText(q.context) ? 'struct' : ''}">${rich(q.context)}</div>` : ''}
    <p class="q-text ${isStructureText(q.question_text) ? 'struct' : ''}">${rich(q.question_text)}</p>
    ${q.options ? html`<ol class="opts" type="A">${q.options.map((o) => html`<li data-opt="${o.id}"><span class="k">${o.id}.</span><span>${rich(o.text)}</span></li>`)}</ol>` : ''}
    ${q.match_items ? html`<div class="pairs">
      <div><h4>List I</h4><ol>${q.match_items.left.map((m) => html`<li>${m.id}. ${rich(m.text)}</li>`)}</ol></div>
      <div><h4>List II</h4><ol>${q.match_items.right.map((m) => html`<li>${m.id}. ${rich(m.text)}</li>`)}</ol></div></div>` : ''}
    <button type="button" class="reveal-btn" data-action="reveal" aria-expanded="false" aria-controls="${ansId}">Show answer</button>
    <div class="answer" id="${ansId}" hidden>
      <div><span class="lbl">Answer</span><span class="pre">${rich(answerSummary(q))}</span></div>
      ${q.explanation ? html`<div class="exp"><span class="lbl">Explanation</span>${rich(q.explanation)}</div>` : ''}
    </div>
    <div class="q-foot">
      ${s ? html`<a href="/browse/${s.slug}">${s.name}</a>` : ''}
      ${c ? html`<span aria-hidden="true">›</span><a href="/browse/${s.slug}/${c.slug}">${c.name}</a>` : ''}
      ${t ? html`<span aria-hidden="true">›</span><a href="/browse/${s.slug}/${c.slug}/${t.slug}">${t.name}</a>` : ''}
      ${(q.exams ?? []).map((e) => html`<span class="exam-tag">${e.name}${e.year ? ` ${e.year}` : ''}${e.paper ? ` · ${e.paper}` : ''}</span>`)}
      ${(q.tags ?? []).map((tag) => html`<a class="tag" href="/search?tag=${encodeURIComponent(tag)}">${tag}</a>`)}
      ${admin ? html`<a href="/admin/edit/${q.public_id}">Edit</a>` : ''}
    </div>
  </article>`;
}

/** One listener for every "Show answer" button on the page. */
export function bindReveal(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('[data-action=reveal]') : null;
    if (!btn) return;
    const panel = document.getElementById(btn.getAttribute('aria-controls'));
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    btn.textContent = open ? 'Hide answer' : 'Show answer';
    panel.hidden = !open;
    const article = btn.closest('.q');
    article.querySelectorAll('.opts li').forEach((li) => li.classList.toggle('correct', open && li.dataset.opt === article.dataset.answerKey));
  });
}
