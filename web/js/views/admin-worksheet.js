// Print / PDF worksheet: choose questions, choose what to show, then print the page or "Save as PDF"
// from the browser's print dialog. Nothing is sent anywhere; the sheet is built from your questions.
import { html, rich, on, toast } from '../dom.js';
import * as api from '../api.js';
import { QUESTION_TYPES, DIFFICULTIES } from '../core/constants.js';
import { isStructureText } from '../core/chem.js';
import { setTitle } from './public.js';
import { answerSummary } from './question-view.js';
import { figureUrl } from './image-tools.js';

const short = (t, n = 110) => (t.length > n ? `${t.slice(0, n)}…` : t);
const WRITTEN = new Set(['short_answer', 'long_answer', 'case_based', 'numerical', 'fill_blank']);
const shuffle = (list) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

export function sheetQuestion(q, o) {
  const marks = o.marks && q.marks !== null && q.marks !== undefined ? html` <span class="sq-marks">[${Number(q.marks)}]</span>` : '';
  const struct = (t) => (isStructureText(t) ? 'struct' : '');
  const lines = WRITTEN.has(q.type_code) && !q.options ? (q.type_code === 'numerical' || q.type_code === 'fill_blank' ? 1 : o.space) : 0;
  return html`<li class="sq" data-qid="${q.id}">
    ${q.context ? html`<div class="sq-ctx ${struct(q.context)}">${rich(q.context)}</div>` : ''}
    <div class="sq-text ${struct(q.question_text)}">${rich(q.question_text)}${marks}</div>
    <div class="sq-fig" data-fig></div>
    ${q.options ? html`<ol class="sq-opts" type="A">${q.options.map((x) => html`<li>${rich(x.text)}</li>`)}</ol>` : ''}
    ${q.match_items ? html`<div class="sq-match"><div><b>List I</b><ol>${q.match_items.left.map((m) => html`<li>${m.id}. ${rich(m.text)}</li>`)}</ol></div><div><b>List II</b><ol>${q.match_items.right.map((m) => html`<li>${m.id}. ${rich(m.text)}</li>`)}</ol></div></div>` : ''}
    ${lines ? html`<div class="sq-lines" style="--n:${lines}" aria-hidden="true"></div>` : ''}
    ${o.ids ? html`<div class="sq-id">${q.public_id}</div>` : ''}
  </li>`;
}

export function buildSheet(list, o) {
  const total = list.reduce((a, q) => a + (q.marks ? Number(q.marks) : 0), 0);
  return html`<section class="sheet" aria-label="Worksheet">
    <header class="sheet-head"><h1>${o.title || 'Worksheet'}</h1>${o.subtitle ? html`<p class="sheet-sub">${o.subtitle}</p>` : ''}
      ${o.nameLine ? html`<div class="sheet-meta"><span>Name: <i></i></span><span>Date: <i></i></span>${total ? html`<span>Marks: <i class="short"></i> / ${total}</span>` : html`<span>Marks: <i class="short"></i></span>`}</div>` : ''}</header>
    <ol class="sheet-q">${list.map((q) => sheetQuestion(q, o))}</ol>
    ${o.key ? html`<section class="sheet-key"><h2>Answer key</h2><ol>${list.map((q) => html`<li><span class="pre">${rich(answerSummary(q))}</span>${o.keyExp && q.explanation ? html`<div class="sk-exp">${rich(q.explanation)}</div>` : ''}</li>`)}</ol></section>` : ''}
  </section>`;
}

export default async function worksheet(ctx, body) {
  setTitle('Worksheet');
  const tax = await api.getTaxonomy({ force: true });
  if (ctx.stale()) return;
  let loaded = [];
  const sel = new Set();

  body.innerHTML = html`<div class="page-head no-print"><h1>Print a worksheet</h1></div>
    <div id="builder" class="no-print">
      <form class="panel" id="wf" novalidate>
        <fieldset><legend>1. Which questions</legend>
          <div class="grid2">
            <div class="field"><label for="w-status">Status</label><select id="w-status" name="status"><option value="published">Published only</option><option value="">All statuses</option><option value="draft">Drafts</option><option value="review">In review</option></select></div>
            <div class="field"><label for="w-sub">Subject</label><select id="w-sub" name="subject"><option value="">All subjects</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
            <div class="field"><label for="w-chap">Chapter</label><select id="w-chap" name="chapter"><option value="">All chapters</option></select></div>
            <div class="field"><label for="w-type">Type</label><select id="w-type" name="type"><option value="">All types</option>${Object.entries(QUESTION_TYPES).map(([c, t]) => html`<option value="${c}">${t.label}</option>`)}</select></div>
            <div class="field"><label for="w-diff">Difficulty</label><select id="w-diff" name="difficulty"><option value="">Any</option>${DIFFICULTIES.map((d) => html`<option value="${d}">${d[0].toUpperCase()}${d.slice(1)}</option>`)}</select></div>
            <div class="field"><label for="w-q">Words</label><input id="w-q" type="search" name="q" placeholder="Optional search text"></div>
          </div>
          <div class="row"><button type="submit" class="btn-primary" id="w-load">Show matching questions</button></div>
        </fieldset>
        <div id="w-list"></div>
        <fieldset id="w-opts" hidden><legend>2. The sheet</legend>
          <div class="grid2">
            <div class="field"><label for="o-title">Title</label><input id="o-title" type="text" maxlength="120" value="Worksheet"></div>
            <div class="field"><label for="o-sub">Line under the title <span class="muted">(optional)</span></label><input id="o-sub" type="text" maxlength="160" placeholder="e.g. Class 12 · Chemistry · Solid State"></div>
          </div>
          <div class="checks">
            <label class="check"><input type="checkbox" id="o-name" checked> Name, date and marks lines</label>
            <label class="check"><input type="checkbox" id="o-marks" checked> Show marks next to each question</label>
            <label class="check"><input type="checkbox" id="o-pics" checked> Include pictures</label>
            <label class="check"><input type="checkbox" id="o-ids"> Show question IDs (small)</label>
            <label class="check"><input type="checkbox" id="o-shuf"> Shuffle the order</label>
            <label class="check"><input type="checkbox" id="o-key" checked> Answer key on a new page at the end</label>
            <label class="check"><input type="checkbox" id="o-kexp"> Include explanations in the answer key</label>
          </div>
          <div class="field"><label for="o-space">Writing space for written answers</label><select id="o-space"><option value="0">None</option><option value="3" selected>3 lines</option><option value="6">6 lines</option><option value="10">10 lines</option></select></div>
          <div class="row"><button type="button" class="btn-primary" id="w-make">Make the worksheet</button></div>
        </fieldset>
      </form>
    </div>
    <div id="out" hidden>
      <div class="sheet-bar no-print"><button type="button" class="btn-primary" id="w-print">Print or save as PDF</button><button type="button" id="w-back">Back to choosing</button>
        <span class="muted small">In the print window choose “Save as PDF” as the printer to get a file.</span></div>
      <div id="sheet-host"></div>
    </div>`.toString();

  const form = body.querySelector('#wf');
  const val = (n) => form.elements[n]?.value ?? '';
  const listBox = body.querySelector('#w-list');
  const opts = body.querySelector('#w-opts');

  form.elements.subject.addEventListener('change', () => {
    const s = tax.tree.find((x) => String(x.id) === val('subject'));
    form.elements.chapter.innerHTML = html`<option value="">All chapters</option>${(s?.chapters ?? []).map((c) => html`<option value="${c.id}">${c.name}</option>`)}`.toString();
  });

  const count = () => { const n = body.querySelector('#pk-n'); if (n) n.textContent = `${sel.size} selected`; body.querySelector('#w-make').disabled = sel.size === 0; };
  function drawList() {
    listBox.innerHTML = loaded.length ? html`<div class="row"><label><input type="checkbox" id="pk-all"> Select all ${loaded.length}</label>
        <label class="inline" for="pk-rand">or pick</label><input id="pk-rand" type="number" min="1" max="${loaded.length}" value="${Math.min(10, loaded.length)}" class="narrow-in"><button type="button" class="btn-sm" id="pk-go">at random</button>
        <span class="muted small" id="pk-n"></span></div>
      <div class="picker-list">${loaded.map((q) => html`<label class="pk"><input type="checkbox" data-pid="${q.public_id}" ${sel.has(q.public_id) ? 'checked' : ''}> <span class="nowrap">${q.public_id}</span> <span>${short(q.question_text)}</span></label>`)}</div>`.toString()
      : html`<p class="muted">No questions match these filters.</p>`.toString();
    opts.hidden = !loaded.length;
    count();
  }
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = body.querySelector('#w-load'); btn.disabled = true; listBox.innerHTML = '<p class="loading">Loading…</p>';
    try {
      loaded = await api.fetchAll({ status: val('status') || undefined, subject: val('subject'), chapter: val('chapter'), type: val('type'), difficulty: val('difficulty'), q: val('q').trim() }, { max: 500 });
      if (loaded.truncated) toast('More than 500 questions match. Only the first 500 are listed: narrow the filters.');
      sel.clear();
    } catch (err) { listBox.innerHTML = html`<div class="notice bad" role="alert">${err.message}</div>`.toString(); btn.disabled = false; return; }
    btn.disabled = false; drawList();
  });
  on(body, 'change', '#pk-all', (e, el) => {
    body.querySelectorAll('#w-list [data-pid]').forEach((c) => { c.checked = el.checked; if (el.checked) sel.add(c.dataset.pid); else sel.delete(c.dataset.pid); });
    count();
  });
  on(body, 'change', '#w-list [data-pid]', (e, el) => { if (el.checked) sel.add(el.dataset.pid); else sel.delete(el.dataset.pid); count(); });
  on(body, 'click', '#pk-go', () => {
    const n = Math.max(1, Math.min(loaded.length, Number(body.querySelector('#pk-rand').value) || 1));
    sel.clear(); shuffle(loaded).slice(0, n).forEach((q) => sel.add(q.public_id));
    body.querySelectorAll('#w-list [data-pid]').forEach((c) => { c.checked = sel.has(c.dataset.pid); });
    count();
  });

  const out = body.querySelector('#out');
  const builder = body.querySelector('#builder');
  on(body, 'click', '#w-make', async () => {
    let list = loaded.filter((q) => sel.has(q.public_id));
    if (!list.length) return;
    if (body.querySelector('#o-shuf').checked) list = shuffle(list);
    const o = {
      title: body.querySelector('#o-title').value.trim(), subtitle: body.querySelector('#o-sub').value.trim(),
      nameLine: body.querySelector('#o-name').checked, marks: body.querySelector('#o-marks').checked, ids: body.querySelector('#o-ids').checked,
      key: body.querySelector('#o-key').checked, keyExp: body.querySelector('#o-kexp').checked, space: Number(body.querySelector('#o-space').value) || 0,
    };
    body.querySelector('#sheet-host').innerHTML = buildSheet(list, o).toString();
    builder.hidden = true; out.hidden = false;
    document.title = `${o.title || 'Worksheet'} · ${api.settings.siteName}`;
    window.scrollTo({ top: 0 });
    if (body.querySelector('#o-pics').checked) {
      try {
        const pics = await api.getImages(list.map((q) => q.id));
        body.querySelectorAll('#sheet-host li.sq').forEach((li) => {
          const img = pics[li.dataset.qid];
          if (!img) return;
          const el = document.createElement('img');
          el.src = figureUrl(img); el.alt = 'Figure';
          li.querySelector('[data-fig]').append(el);
        });
      } catch { toast('Pictures could not be loaded, so the sheet has none.', 'bad'); }
    }
  });
  on(body, 'click', '#w-back', () => { out.hidden = true; builder.hidden = false; });
  on(body, 'click', '#w-print', () => window.print());
  count();
}
