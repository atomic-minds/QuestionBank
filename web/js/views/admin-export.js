// Export & backup: Atomic Minds JSON, readable plain text, and a full backup that can be restored.
// Everything is built in the browser from pages of 500 questions, so nothing large is held on a server.
import { html, on, toast, download } from '../dom.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { QUESTION_TYPES, STATUSES, DIFFICULTIES } from '../core/constants.js';
import { buildAtomicMindsExport, buildPlainText, buildBackup, exportFilename } from '../core/export.js';
import { importQuestions } from '../core/importer.js';
import { setDrafts } from './drafts.js';
import { setTitle } from './public.js';

const FORMATS = [
  ['am', 'Atomic Minds JSON', 'The versioned file Atomic Minds imports. Keeps each QB ID so questions stay traceable.'],
  ['text', 'Plain text', 'Readable and easy to paste: Q1, options A–D, Ans, Exp.'],
  ['backup', 'Full backup', 'Everything (all statuses, IDs, taxonomy) so this bank can be restored later or moved.'],
];
const short = (t, n = 110) => (t.length > n ? `${t.slice(0, n)}…` : t);

export default async function exportView(ctx, body) {
  setTitle('Export & backup');
  const tax = await api.getTaxonomy({ force: true });
  if (ctx.stale()) return;
  let picked = null;           // loaded list when choosing questions by hand
  const sel = new Set();

  body.innerHTML = html`<div class="page-head"><h1>Export &amp; backup</h1></div>
    <form id="ex" class="panel" novalidate>
      <fieldset><legend>1. Format</legend>
        ${FORMATS.map(([v, l, d], i) => html`<div class="radio"><label><input type="radio" name="fmt" value="${v}" ${i === 0 ? 'checked' : ''}> <b>${l}</b></label><div class="hint">${d}</div></div>`)}
      </fieldset>
      <fieldset><legend>2. Which questions</legend>
        <div class="grid2">
          <div class="field"><label for="x-status">Status</label><select id="x-status" name="status"><option value="published">Published only</option><option value="">All statuses</option>${STATUSES.filter((s) => s !== 'published').map((s) => html`<option value="${s}">${s[0].toUpperCase()}${s.slice(1)} only</option>`)}</select></div>
          <div class="field"><label for="x-sub">Subject</label><select id="x-sub" name="subject"><option value="">All subjects</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
          <div class="field"><label for="x-chap">Chapter</label><select id="x-chap" name="chapter"><option value="">All chapters</option></select></div>
          <div class="field"><label for="x-type">Type</label><select id="x-type" name="type"><option value="">All types</option>${Object.entries(QUESTION_TYPES).map(([c, t]) => html`<option value="${c}">${t.label}</option>`)}</select></div>
          <div class="field"><label for="x-cat">Category</label><select id="x-cat" name="category"><option value="">General and exam</option><option value="general">General only</option><option value="exam">Exam only</option></select></div>
          <div class="field"><label for="x-exam">Exam</label><select id="x-exam" name="exam"><option value="">Any exam</option>${tax.exams.map((e) => html`<option value="${e.id}">${e.name}</option>`)}</select></div>
          <div class="field"><label for="x-year">Exam year</label><input type="text" id="x-year" name="year" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="Any"></div>
          <div class="field"><label for="x-diff">Difficulty</label><select id="x-diff" name="difficulty"><option value="">Any</option>${DIFFICULTIES.map((d) => html`<option value="${d}">${d[0].toUpperCase()}${d.slice(1)}</option>`)}</select></div>
          <div class="field"><label for="x-tag">Tag</label><input type="text" id="x-tag" name="tag" placeholder="Any"></div>
        </div>
        <div class="radio"><label><input type="radio" name="scope" value="all" checked> <b>Everything that matches</b></label></div>
        <div class="radio"><label><input type="radio" name="scope" value="pick"> <b>Let me choose questions</b></label></div>
        <div id="picker" hidden></div>
      </fieldset>
      <fieldset id="opts"><legend>3. Options</legend>
        <div data-for="am"><label><input type="checkbox" name="subjective"> Also include questions without fixed options (short, long, numerical, case-based…)</label>
          <div class="hint">Off by default because the file format is built around multiple-choice answers.</div></div>
        <div data-for="text" hidden>
          <label><input type="checkbox" name="answers" checked> Include answers</label><br>
          <label><input type="checkbox" name="expl" checked> Include explanations</label><br>
          <label><input type="checkbox" name="ids"> Include QB IDs</label></div>
        <p class="hint" data-for="backup" hidden>A backup always contains every field of every selected question.</p>
      </fieldset>
      <div id="x-msg" role="status"></div>
      <button class="btn-primary" type="submit" id="x-go">Download</button>
    </form>

    <section class="section"><h2>Restore a backup</h2>
      <div class="panel"><p>Choose a file made by “Full backup”. You will review it before anything is saved. Questions keep their IDs and statuses.</p>
        <div class="field"><label for="rs">Backup file (.json)</label><input id="rs" type="file" accept=".json,application/json"></div>
        <div id="rs-msg" role="status"></div></div></section>`.toString();

  const form = body.querySelector('#ex');
  const msg = body.querySelector('#x-msg');
  const val = (n) => form.elements[n]?.value ?? '';
  const filters = () => ({
    status: val('status') || undefined, subject: val('subject'), chapter: val('chapter'), type: val('type'),
    category: val('category'), exam: val('exam'), year: Number(val('year')) || undefined, difficulty: val('difficulty'), tag: val('tag').trim(),
  });
  const fmt = () => form.querySelector('[name=fmt]:checked').value;
  const scope = () => form.querySelector('[name=scope]:checked').value;

  const syncOptions = () => body.querySelectorAll('#opts [data-for]').forEach((el) => { el.hidden = el.dataset.for !== fmt(); });
  const syncChapters = () => {
    const s = tax.tree.find((x) => String(x.id) === val('subject'));
    form.elements.chapter.innerHTML = html`<option value="">All chapters</option>${(s?.chapters ?? []).map((c) => html`<option value="${c.id}">${c.name}</option>`)}`.toString();
  };
  syncOptions();
  on(form, 'change', '[name=fmt]', () => { syncOptions(); });
  on(form, 'change', '[name=subject]', () => { syncChapters(); picked = null; renderPicker(); });
  form.addEventListener('change', (e) => {
    if (e.target.name === 'scope') { renderPicker(); return; }
    if (e.target.closest('#picker') || e.target.name === 'fmt') return;
    picked = null; if (scope() === 'pick') renderPicker();
  });

  async function renderPicker() {
    const box = body.querySelector('#picker');
    box.hidden = scope() !== 'pick';
    if (box.hidden) return;
    if (!picked) {
      box.innerHTML = '<p class="loading">Loading…</p>';
      try { picked = await api.fetchAll(filters(), { max: 2000 }); if (picked.truncated) toast('More than 2000 questions match. Only the first 2000 are listed: narrow the filters to pick from the rest.'); } catch (e) { box.innerHTML = html`<div class="notice bad" role="alert">${e.message}</div>`.toString(); return; }
      sel.clear();
    }
    box.innerHTML = picked.length ? html`<div class="row"><label><input type="checkbox" id="pk-all"> Select all ${picked.length}</label><span class="muted small" id="pk-n"></span></div>
      <div class="picker-list">${picked.map((q) => html`<label class="pk"><input type="checkbox" data-pid="${q.public_id}" ${sel.has(q.public_id) ? 'checked' : ''}> <span class="nowrap">${q.public_id}</span> <span>${short(q.question_text)}</span></label>`)}</div>`.toString()
      : html`<p class="muted">No questions match these filters.</p>`.toString();
    count();
  }
  const count = () => { const n = body.querySelector('#pk-n'); if (n) n.textContent = `${sel.size} selected`; };
  on(body, 'change', '#picker [data-pid]', (e, el) => { el.checked ? sel.add(el.dataset.pid) : sel.delete(el.dataset.pid); count(); });
  on(body, 'change', '#pk-all', (e, el) => {
    body.querySelectorAll('#picker [data-pid]').forEach((c) => { c.checked = el.checked; el.checked ? sel.add(c.dataset.pid) : sel.delete(c.dataset.pid); });
    count();
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = body.querySelector('#x-go');
    const bad = (m) => { msg.innerHTML = html`<div class="notice bad" role="alert">${m}</div>`.toString(); };
    const yr = val('year').trim();
    if (yr && !/^\d{4}$/.test(yr)) { bad('Exam year must be four digits, like 2024.'); return; }
    btn.disabled = true; msg.innerHTML = '<p class="loading">Collecting questions…</p>';
    try {
      let list;
      if (scope() === 'pick') {
        if (!picked) await renderPicker();
        list = (picked ?? []).filter((q) => sel.has(q.public_id));
        if (!list.length) { bad('Tick at least one question, or choose “Everything that matches”.'); return; }
      } else {
        list = await api.fetchAll(filters(), { onProgress: (n) => { msg.innerHTML = html`<p class="loading">Collected ${n} questions…</p>`.toString(); } });
      }
      if (list.truncated) { bad(`More than ${list.length} questions match. To avoid exporting only part of your bank, narrow the filters (for example one subject at a time) or use a database dump (see the README).`); return; }
      if (!list.length) { bad('No questions match those filters, so there is nothing to export.'); return; }
      if (fmt() === 'backup' && list.length > 1000) { bad(`This backup would hold ${list.length} questions, but a backup file can be restored here only up to 1000 at a time. Export one subject (or status) per file, or use a database dump.`); return; }
      const idx = tax.index;
      const f = fmt();
      let skipped = [];
      if (f === 'text') {
        download(exportFilename('text'), buildPlainText(list, { includeAnswers: form.elements.answers.checked, includeExplanations: form.elements.expl.checked, includeIds: form.elements.ids.checked }), 'text/plain');
      } else if (f === 'backup') {
        download(exportFilename('backup'), JSON.stringify(buildBackup(list, idx), null, 2));
      } else {
        const out = buildAtomicMindsExport(list, idx, { includeSubjective: form.elements.subjective.checked });
        skipped = out.skipped;
        if (!out.document.count) { bad('None of the selected questions has fixed options. Tick “Also include questions without fixed options” to export them anyway.'); return; }
        download(exportFilename('am'), JSON.stringify(out.document, null, 2));
      }
      const done = f === 'am' ? list.length - skipped.length : list.length;
      msg.innerHTML = html`<div class="notice ok">Exported ${done} ${done === 1 ? 'question' : 'questions'}.${skipped.length ? html` <b>${skipped.length}</b> skipped because they have no fixed options: ${skipped.slice(0, 10).map((s) => s.id).join(', ')}${skipped.length > 10 ? '…' : ''}.` : ''}</div>`.toString();
    } catch (err) { bad(err.message); } finally { btn.disabled = false; }
  });

  body.querySelector('#rs').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    const out = body.querySelector('#rs-msg');
    if (!file) return;
    const fail = (m) => { out.innerHTML = html`<div class="notice bad" role="alert">${m}</div>`.toString(); };
    if (file.size > 4 * 1024 * 1024) { fail('That file is larger than 4 MB. Restore one subject at a time, or use a database dump (see the README).'); return; }
    let text;
    try { text = await file.text(); } catch { fail('That file could not be read.'); return; }
    const fresh = await api.getTaxonomy({ force: true });
    const result = importQuestions(text, { taxonomy: fresh.index, restore: true });
    if (result.fatal) { fail(result.fatal.message); return; }
    if (result.format !== 'qb-backup') { fail('That does not look like a Full backup file. Use “Add questions” to import other JSON.'); return; }
    setDrafts(result, 'restore');
    toast('Backup loaded. Review it before saving.', 'ok');
    navigate('/admin/review');
  });
}
