// All questions (any status) and the single-question editor.
import { html, confirmDialog, toast } from '../dom.js';
import { navigate, withQuery } from '../router.js';
import * as api from '../api.js';
import { QUESTION_TYPES, STATUSES } from '../core/constants.js';
import { emptyQuestionInput } from '../core/validate.js';
import { setTitle } from './public.js';
import { mountEditor } from './editor.js';

const PAGE = 50;
const NEXT = {
  draft: [['review', 'Send to review'], ['published', 'Publish']],
  review: [['published', 'Publish'], ['draft', 'Back to draft']],
  published: [['draft', 'Unpublish'], ['archived', 'Archive']],
  archived: [['draft', 'Restore as draft']],
};
const short = (t, n = 140) => (t.length > n ? `${t.slice(0, n)}…` : t);

/** Change status for many questions (keeps everything else exactly as saved). */
async function setStatus(list, status) {
  const items = list.map((q) => ({ ...api.toInput(q), status }));
  const out = await api.saveQuestions('save', items, { confirmNear: true });
  const failed = out.results.filter((r) => !r.ok);
  return { saved: out.results.length - failed.length, failed: failed.map((r, i) => r.message ?? r.errors?.[0]?.message ?? 'could not be saved') };
}

export default async function list(ctx, body) {
  setTitle('All questions');
  const q = ctx.query;
  const page = Math.max(1, Number.parseInt(q.page ?? '1', 10) || 1);
  const tax = await api.getTaxonomy({ force: true });
  const subject = tax.tree.find((s) => String(s.id) === q.subject);
  const res = await api.search({ q: q.q, subject: q.subject, chapter: q.chapter, type: q.type, status: q.status, limit: PAGE, offset: (page - 1) * PAGE });
  if (ctx.stale()) return;
  const link = (p) => withQuery('/admin/questions', { ...q, ...p });

  body.innerHTML = html`<div class="page-head"><h1>All questions</h1><a class="btn btn-primary" href="/admin/add">Add questions</a></div>
    <nav class="tabs" aria-label="Status">${[['', 'All'], ...STATUSES.map((s) => [s, s[0].toUpperCase() + s.slice(1)])].map(([v, l]) => html`<a href="${link({ status: v || null, page: null })}" ${(q.status ?? '') === v ? 'aria-current=page' : ''}>${l}</a>`)}</nav>
    <form class="row" action="/admin/questions" id="flt" role="search">
      <input type="hidden" name="status" value="${q.status ?? ''}">
      <div class="grow"><label class="sr" for="fq">Search</label><input id="fq" type="search" name="q" value="${q.q ?? ''}" placeholder="Search text or ID"></div>
      <div><label class="sr" for="fs">Subject</label><select id="fs" name="subject"><option value="">All subjects</option>${tax.tree.map((s) => html`<option value="${s.id}" ${String(s.id) === q.subject ? 'selected' : ''}>${s.name}</option>`)}</select></div>
      <div><label class="sr" for="fc">Chapter</label><select id="fc" name="chapter"><option value="">All chapters</option>${(subject?.chapters ?? []).map((c) => html`<option value="${c.id}" ${String(c.id) === q.chapter ? 'selected' : ''}>${c.name}</option>`)}</select></div>
      <div><label class="sr" for="ft">Type</label><select id="ft" name="type"><option value="">All types</option>${Object.entries(QUESTION_TYPES).map(([c, t]) => html`<option value="${c}" ${c === q.type ? 'selected' : ''}>${t.label}</option>`)}</select></div>
      <button type="submit">Filter</button></form>
    ${res.items.length ? html`<div class="table-wrap section"><table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all on this page"></th><th>ID</th><th>Question</th><th>Type</th><th>Where</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${res.items.map((it) => {
        const s = tax.index.subjectById.get(it.subject_id); const c = tax.index.chapterById.get(it.chapter_id);
        return html`<tr data-pid="${it.public_id}"><td><input type="checkbox" data-sel aria-label="Select ${it.public_id}"></td>
          <td class="nowrap"><a href="/admin/edit/${it.public_id}">${it.public_id}</a></td><td class="q-cell">${short(it.question_text)}</td>
          <td class="nowrap" data-label="Type">${QUESTION_TYPES[it.type_code]?.label}</td><td data-label="Where">${s?.name ?? ''}${c ? html`<br><span class="muted small">${c.name}</span>` : ''}</td>
          <td data-label="Status"><span class="badge ${it.status}">${it.status}</span>${it.origin === 'ai_image' ? html` <span class="badge ai">AI</span>` : ''}</td>
          <td class="actions">${NEXT[it.status].map(([st, l]) => html`<button type="button" class="btn-sm" data-to="${st}">${l}</button> `)}<a class="btn btn-sm" href="/admin/edit/${it.public_id}">Edit</a></td></tr>`;
      })}</tbody></table></div>
      <div class="row section" id="bulk"><label for="bs" class="small">With selected:</label><select id="bs"><option value="draft">Move to draft</option><option value="review">Send to review</option><option value="published">Publish</option><option value="archived">Archive</option></select><button type="button" id="bapply">Apply</button></div>
      <div class="pager">${page > 1 ? html`<a class="btn" href="${link({ page: page - 1 })}">Previous</a>` : html`<span></span>`}<span class="muted small">Page ${page}</span>${res.has_more ? html`<a class="btn" href="${link({ page: page + 1 })}">Next</a>` : html`<span></span>`}</div>`
      : html`<div class="empty-state section"><p><b>No questions match.</b></p><p class="muted">${q.status || q.q || q.subject ? 'Try clearing the filters.' : 'Add your first questions from an image, JSON or by hand.'}</p><a class="btn btn-primary" href="/admin/add">Add questions</a></div>`}`.toString();

  body.querySelector('#fs')?.addEventListener('change', () => { body.querySelector('#fc').value = ''; body.querySelector('#flt').requestSubmit(); });
  body.querySelector('#flt')?.addEventListener('submit', (e) => {
    e.preventDefault();
    navigate(withQuery('/admin/questions', Object.fromEntries(new FormData(e.currentTarget))));
  });
  body.querySelector('#all')?.addEventListener('change', (e) => body.querySelectorAll('[data-sel]').forEach((c) => { c.checked = e.target.checked; }));
  const byPid = (pid) => res.items.find((i) => i.public_id === pid);
  const run = async (list, status) => {
    if (status === 'published' && !(await confirmDialog({ title: `Publish ${list.length} question${list.length === 1 ? '' : 's'}?`, body: 'Published questions are visible to everyone.', confirmLabel: 'Publish' }))) return;
    if (status === 'archived' && !(await confirmDialog({ title: `Archive ${list.length} question${list.length === 1 ? '' : 's'}?`, body: 'Archived questions are hidden from the public. You can restore them later.', confirmLabel: 'Archive', danger: true }))) return;
    if (status !== 'published' && status !== 'archived' && list.some((q) => q.status === 'published')) {
      const n = list.filter((q) => q.status === 'published').length;
      if (!(await confirmDialog({ title: `Unpublish ${n} question${n === 1 ? '' : 's'}?`, body: 'They will disappear from the public site until you publish them again.', confirmLabel: 'Unpublish', danger: true }))) return;
    }
    try {
      const r = await setStatus(list, status);
      toast(`${r.saved} updated${r.failed.length ? `, ${r.failed.length} failed: ${r.failed[0]}` : ''}.`, r.failed.length ? 'bad' : 'ok');
      navigate(location.pathname + location.search, { replace: true });
    } catch (e) { toast(e.message, 'bad'); }
  };
  body.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-to]') : null;
    if (b) run([byPid(b.closest('tr').dataset.pid)], b.dataset.to);
    if (e.target instanceof Element && e.target.id === 'bapply') {
      const sel = [...body.querySelectorAll('[data-sel]:checked')].map((c) => byPid(c.closest('tr').dataset.pid));
      if (!sel.length) { toast('Select at least one question.'); return; }
      run(sel, body.querySelector('#bs').value);
    }
  });
}

// ------------------------------------------------------------------ single question
export async function editPage(ctx, body) {
  const isNew = ctx.params.id === 'new';
  setTitle(isNew ? 'New question' : `Edit ${ctx.params.id}`);
  const tax = await api.getTaxonomy({ force: true });
  const q = isNew ? null : await api.getQuestion(ctx.params.id.toUpperCase());
  if (ctx.stale()) return;
  if (!isNew && !q) { body.innerHTML = html`<div class="empty-state"><h2>Question not found</h2><p><a href="/admin/questions">Back to all questions</a></p></div>`.toString(); return; }
  const draft = q ? api.toInput(q) : emptyQuestionInput();
  if (isNew && tax.tree.length === 1) { draft.subject_id = tax.tree[0].id; }

  body.innerHTML = html`<div class="page-head"><div><p class="crumbs"><a href="/admin/questions">All questions</a></p><h1>${isNew ? 'New question' : q.public_id}</h1></div>
    ${q ? html`<span><span class="badge ${q.status}">${q.status}</span> <span class="muted small">version ${q.version}</span></span>` : ''}</div>
    <div class="editor"><div id="ed"></div>
    <aside class="panel stack"><div class="field"><label for="st">Status</label><select id="st">${STATUSES.map((s) => html`<option value="${s}" ${s === draft.status ? 'selected' : ''}>${s[0].toUpperCase()}${s.slice(1)}</option>`)}</select>
      <p class="hint">Only published questions are visible to the public.</p></div>
      <div id="msg"></div>
      <button class="btn-primary" id="save">${isNew ? 'Create question' : 'Save changes'}</button>
      ${q?.status === 'published' ? html`<a class="btn" href="/q/${q.public_id}">View public page</a>` : ''}
      ${q && q.status === 'archived' ? html`<button class="btn-danger" id="del">Delete permanently</button>` : ''}
      ${q ? html`<p class="hint small">Created ${new Date(q.created_at).toLocaleString()}<br>Last changed ${new Date(q.updated_at).toLocaleString()}${q.origin === 'ai_image' ? html`<br>Read from an image by AI` : ''}</p>` : ''}</aside></div>`.toString();
  const existing = q ? ((await api.getImages([q.id], { fresh: true }))[q.id] ?? null) : null;
  if (ctx.stale()) return;
  const ed = mountEditor(body.querySelector('#ed'), { draft, tax, locked: {}, image: existing });
  const msg = body.querySelector('#msg');
  const saveBtn = body.querySelector('#save');

  async function save(confirmNear = false, confirmed = false) {
    const value = { ...ed.read(), status: body.querySelector('#st').value };
    if (q?.status === 'published' && value.status !== 'published' && !confirmed) {
      const archive = value.status === 'archived';
      if (!(await confirmDialog({ title: `${archive ? 'Archive' : 'Unpublish'} ${q.public_id}?`, body: 'It will disappear from the public site until you publish it again.', confirmLabel: archive ? 'Archive' : 'Unpublish', danger: true }))) return;
    }
    if (isNew) { delete value.id; delete value.expected_version; }
    saveBtn.disabled = true; msg.innerHTML = '';
    try {
      const r = (await api.saveQuestions('save', [value], { confirmNear })).results[0];
      if (r.ok) {
        const pic = ed.image();
        let picNote = '';
        if (pic.changed) {
          try { if (pic.value) await api.setQuestionImage(r.id, pic.value); else await api.clearQuestionImage(r.id); }
          catch (err) { picNote = ` The picture could not be saved: ${err.message}`; }
        }
        toast(`${isNew ? `Created ${r.public_id}` : 'Saved'}.${picNote}`, picNote ? 'bad' : 'ok');
        if (isNew) navigate(`/admin/edit/${r.public_id}`, { replace: true }); else navigate(location.pathname, { replace: true });
        return;
      }
      if (r.errors?.length) { ed.show(r.errors); msg.innerHTML = html`<div class="notice bad" role="alert">Fix the highlighted fields.</div>`.toString(); }
      else if (r.code === 'NEAR_DUPLICATE') {
        msg.innerHTML = html`<div class="notice warn" role="alert"><b>${r.message}</b>${r.duplicates.map((d) => html`<div class="dupe"><a href="/admin/edit/${d.public_id}">${d.public_id}</a> (${Math.round(d.similarity * 100)}% similar) ${d.question_text.slice(0, 120)}</div>`)}
          <p><button type="button" id="force">Save anyway</button></p></div>`.toString();
        msg.querySelector('#force').addEventListener('click', () => save(true, true));
      } else if (r.code === 'DUPLICATE_EXACT') {
        msg.innerHTML = html`<div class="notice bad" role="alert"><b>${r.message}</b>${(r.duplicates ?? []).map((d) => html`<div class="dupe"><a href="/admin/edit/${d.public_id}">${d.public_id}</a> <span class="badge ${d.status}">${d.status}</span></div>`)}</div>`.toString();
      } else if (r.code === 'CONFLICT') {
        msg.innerHTML = html`<div class="notice bad" role="alert"><b>${r.message}</b> <a href="${location.pathname}" data-native>Reload this question</a> (your edits on this page will be lost).</div>`.toString();
      } else msg.innerHTML = html`<div class="notice bad" role="alert">${r.message ?? 'Could not be saved.'}</div>`.toString();
    } catch (e) { msg.innerHTML = html`<div class="notice bad" role="alert">${e.message}</div>`.toString(); }
    saveBtn.disabled = false;
  }
  saveBtn.addEventListener('click', () => save(false));
  body.querySelector('#del')?.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Delete permanently?', body: `${q.public_id} will be removed for good. Its ID will not be reused. Export a backup first if you might need it.`, confirmLabel: 'Delete', danger: true }))) return;
    try { await api.deleteQuestion(q.id); toast('Deleted', 'ok'); navigate('/admin/questions?status=archived'); } catch (e) { toast(e.message, 'bad'); }
  });
}
