// Review screen: every imported or AI-read question lands here first. Nothing is saved until the
// admin has looked at it and chosen "Save". Items fail or succeed one by one.
import { html, confirmDialog, toast } from '../dom.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { QUESTION_TYPES } from '../core/constants.js';
import { validateQuestionInput } from '../core/validate.js';
import { setTitle } from './public.js';
import { clearDrafts, getDrafts, persistDrafts } from './drafts.js';
import { mountEditor } from './editor.js';

const short = (t, n = 220) => (t.length > n ? `${t.slice(0, n)}…` : t);

export default async function review(ctx, body) {
  setTitle('Review drafts');
  const sess = getDrafts();
  if (!sess?.items.length) {
    body.innerHTML = html`<div class="page-head"><h1>Review drafts</h1></div><div class="empty-state"><p><b>Nothing waiting for review.</b></p>
      <p class="muted">Questions you import or read from an image appear here before they are saved.</p>
      <p><a class="btn btn-primary" href="/admin/add">Add questions</a> <a class="btn" href="/admin/questions?status=draft">See saved drafts</a></p></div>`.toString();
    return;
  }
  const tax = await api.getTaxonomy({ force: true });
  if (ctx.stale()) return;
  const examIds = new Set(tax.exams.map((e) => e.id));
  const restore = sess.mode === 'restore';
  const handles = new Map();
  const open = new Set();
  let saveStatus = 'draft';

  const find = (key) => sess.items.find((i) => i.key === key);
  const label = (it) => QUESTION_TYPES[it.draft?.type_code]?.label ?? 'Question';
  const blocked = (it) => it.dup.some((d) => d.exact);

  async function checkDuplicates(items) {
    const list = items.filter((i) => i.ok && !i.saved);
    for (let at = 0; at < list.length; at += 50) {
      const chunk = list.slice(at, at + 50);
      try {
        const r = await api.saveQuestions('dry_run', chunk.map((i) => ({ ...i.draft, public_id: undefined })));
        r.results.forEach((res, k) => { chunk[k].dup = res.duplicates ?? []; if (blocked(chunk[k])) chunk[k].selected = false; });
      } catch (e) { toast(`Could not check for duplicates: ${e.message}`, 'bad'); return; }
    }
  }

  function rowHtml(it, n) {
    const bad = !it.ok || it.saveError;
    return html`<li data-key="${it.key}"><div class="item ${bad ? 'bad' : ''}">
      <input type="checkbox" data-act="sel" ${it.selected ? 'checked' : ''} ${(!it.ok || it.saved || blocked(it)) ? 'disabled' : ''} aria-label="Save question ${n}">
      <div>
        <div class="q-meta"><b>Question ${n}</b><span class="q-type">${label(it)}</span>
          ${it.meta?.answer_source === 'inferred' ? html`<span class="badge ai">Answer worked out by AI</span>` : ''}
          ${it.meta?.answer_source === 'none' ? html`<span class="badge draft">No answer found</span>` : ''}
          ${it.meta?.explanation_source === 'generated' ? html`<span class="badge ai">Explanation written by AI</span>` : ''}
          ${it.saved ? html`<span class="badge published">Saved as ${it.saved.public_id}</span>` : (it.ok ? html`<span class="badge review">Ready</span>` : html`<span class="badge draft">Needs fixing</span>`)}</div>
        <div class="t pre">${short(it.draft?.question_text ?? '')}</div>
        <ul>${it.errors.map((e) => html`<li class="e">${e.message}</li>`)}${it.warnings.map((w) => html`<li class="w">${w.message}</li>`)}
          ${it.saveError ? html`<li class="e">${it.saveError.message}</li>` : ''}</ul>
        ${it.dup.map((d) => html`<div class="dupe">${d.exact ? html`<b>Already in the bank.</b>` : html`<b>Looks similar (${Math.round(d.similarity * 100)}%).</b>`}
          <a href="/admin/edit/${d.public_id}">${d.public_id}</a> <span class="badge ${d.status}">${d.status}</span> — ${short(d.question_text, 120)}</div>`)}
        ${it.dup.some((d) => !d.exact) && !blocked(it) && !it.saved ? html`<label class="check"><input type="checkbox" data-act="near" ${it.confirmNear ? 'checked' : ''}> This is a different question; save it anyway</label>` : ''}
      </div>
      <div class="row">${it.saved ? '' : html`<button type="button" class="btn-sm" data-act="edit">${open.has(it.key) ? 'Close' : 'Edit'}</button><button type="button" class="btn-sm btn-quiet" data-act="discard">Discard</button>`}</div></div>
      <div class="panel" data-host ${open.has(it.key) ? '' : 'hidden'}></div></li>`;
  }

  function mountOpen(li, it) {
    const host = li.querySelector('[data-host]');
    if (!host || !open.has(it.key)) return;
    host.innerHTML = '<div data-ed></div><div class="row"><button type="button" class="btn-primary btn-sm" data-act="apply">Apply changes</button></div>';
    handles.set(it.key, mountEditor(host.querySelector('[data-ed]'), { draft: it.draft, tax, errors: it.errors, warnings: it.warnings, meta: it.meta }));
  }
  const refresh = (it) => {
    const li = body.querySelector(`li[data-key="${it.key}"]`);
    const n = sess.items.indexOf(it) + 1;
    const t = document.createElement('template');
    t.innerHTML = rowHtml(it, n).toString();
    li.replaceWith(t.content.firstElementChild);
    mountOpen(body.querySelector(`li[data-key="${it.key}"]`), it);
    summary();
  };

  function summary() {
    const live = sess.items.filter((i) => !i.saved);
    const sel = sess.items.filter((i) => i.selected && i.ok && !i.saved && !blocked(i));
    body.querySelector('#sum').innerHTML = html`${sess.items.length} read · ${live.filter((i) => i.ok).length} ready · ${live.filter((i) => !i.ok).length} need fixing · ${sess.items.filter((i) => i.saved).length} saved`.toString();
    const btn = body.querySelector('[data-act=save]');
    btn.disabled = sel.length === 0;
    btn.textContent = sel.length ? `Save ${sel.length} selected` : 'Nothing selected';
    persistDrafts();
  }

  function renderAll() {
    body.innerHTML = html`<div class="page-head"><div><h1>Review drafts</h1><p class="muted" id="sum"></p></div>
      <div class="row"><button type="button" class="btn-sm" data-act="all">Select all ready</button><button type="button" class="btn-sm" data-act="none">Select none</button><button type="button" class="btn-sm btn-danger" data-act="clear">Discard all</button></div></div>
      ${sess.notes.map((n) => html`<div class="notice warn">${n}</div>`)}
      ${sess.missing && (sess.missing.chapters.length || sess.missing.topics.length || sess.missing.subjects.length) ? html`<div class="notice warn"><b>Some names are not in your taxonomy yet.</b>
        ${[...sess.missing.subjects.map((x) => `subject “${x}”`), ...sess.missing.chapters.map((x) => `chapter “${x.name}”`), ...sess.missing.topics.map((x) => `topic “${x.name}”`)].join(', ')}.
        Add them under <a href="/admin/taxonomy">Taxonomy</a>, or pick another one in Edit.</div>` : ''}
      <ol class="item-list">${sess.items.map((it, i) => rowHtml(it, i + 1))}</ol>
      <div class="sticky-bar">
        ${restore ? html`<span>Each question keeps its saved status and ID.</span>` : html`<label for="st" class="check">Save as <select id="st"><option value="draft">Draft</option><option value="review">In review</option><option value="published">Published</option></select></label>`}
        <button type="button" class="btn-primary" data-act="save">Save</button><a class="btn" href="/admin/questions?status=draft">See saved questions</a></div>`.toString();
    const st = body.querySelector('#st');
    if (st) { st.value = saveStatus; st.addEventListener('change', () => { saveStatus = st.value; }); }
    sess.items.forEach((it) => mountOpen(body.querySelector(`li[data-key="${it.key}"]`), it));
    summary();
  }

  async function save() {
    const chosen = sess.items.filter((i) => i.selected && i.ok && !i.saved && !blocked(i));
    if (!chosen.length) return;
    const risky = chosen.filter((i) => i.meta && i.meta.answer_source !== 'extracted' && i.draft.origin === 'ai_image');
    if (!restore && saveStatus === 'published' && risky.length) {
      const yes = await confirmDialog({ title: 'Publish without checking?', body: `${risky.length} of these have answers the AI worked out or could not find. Publishing makes them visible to everyone. Save as drafts first if you have not checked them.`, confirmLabel: 'Publish anyway' });
      if (!yes) return;
    }
    const btn = body.querySelector('[data-act=save]'); btn.disabled = true; btn.textContent = 'Saving…';
    let saved = 0;
    for (const confirmNear of [false, true]) {
      const group = chosen.filter((i) => i.confirmNear === confirmNear);
      for (let at = 0; at < group.length; at += 25) {
        const chunk = group.slice(at, at + 25);
        try {
          const r = await api.saveQuestions('save', chunk.map((i) => (restore ? { ...i.draft } : { ...i.draft, public_id: undefined, status: saveStatus })), { confirmNear });
          r.results.forEach((res, k) => {
            const it = chunk[k];
            if (res.ok) { it.saved = { public_id: res.public_id, id: res.id }; it.selected = false; it.saveError = null; saved += 1; }
            else {
              it.saveError = { code: res.code, message: res.message ?? (res.errors?.[0]?.message ?? 'Could not be saved.') };
              if (res.errors?.length) { it.ok = false; it.errors = res.errors; }
              if (res.duplicates?.length) it.dup = res.duplicates;
              it.selected = false;
            }
          });
        } catch (e) {
          if (e.code === 'UNAUTHENTICATED') throw e;
          chunk.forEach((i) => { i.saveError = { code: e.code, message: e.message }; });
          toast(e.message, 'bad');
        }
      }
    }
    sess.items.forEach((it) => { const h = handles.get(it.key); if (h && open.has(it.key)) it.draft = h.read(); });
    renderAll();
    const failed = sess.items.filter((i) => i.saveError).length;
    toast(`${saved} saved${failed ? `, ${failed} need attention` : ''}.`, failed ? '' : 'ok');
    if (sess.items.every((i) => i.saved)) { clearDrafts(); toast('All saved.', 'ok'); navigate(`/admin/questions?status=${restore ? '' : saveStatus}`); }
  }

  body.addEventListener('click', async (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!b) return;
    const li = b.closest('li[data-key]');
    const it = li ? find(li.dataset.key) : null;
    switch (b.dataset.act) {
      case 'edit': if (open.has(it.key)) open.delete(it.key); else open.add(it.key); refresh(it); break;
      case 'discard': {
        if (!(await confirmDialog({ title: 'Discard this question?', body: 'It has not been saved and will be removed from this list.', confirmLabel: 'Discard', danger: true }))) break;
        sess.items.splice(sess.items.indexOf(it), 1); open.delete(it.key);
        if (!sess.items.length) { clearDrafts(); navigate('/admin/add'); } else renderAll();
        break;
      }
      case 'apply': {
        const h = handles.get(it.key);
        const v = validateQuestionInput(h.read(), { taxonomy: tax.index.tree, examIds });
        it.draft = v.ok ? v.value : h.read(); it.errors = v.errors; it.warnings = []; it.ok = v.ok; it.saveError = null; it.confirmNear = false;
        if (v.ok) { open.delete(it.key); it.selected = true; await checkDuplicates([it]); if (blocked(it)) it.selected = false; refresh(it); } else { refresh(it); toast('Some fields still need fixing.', 'bad'); }
        break;
      }
      case 'all': sess.items.forEach((i) => { i.selected = i.ok && !i.saved && !blocked(i); }); renderAll(); break;
      case 'none': sess.items.forEach((i) => { i.selected = false; }); renderAll(); break;
      case 'clear':
        if (await confirmDialog({ title: 'Discard all drafts?', body: 'Nothing here has been saved. This clears the whole list.', confirmLabel: 'Discard all', danger: true })) { clearDrafts(); navigate('/admin/add'); }
        break;
      case 'save': await save(); break;
      default:
    }
  });
  body.addEventListener('change', (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const li = el.closest('li[data-key]');
    if (!li) return;
    const it = find(li.dataset.key);
    if (el.matches('[data-act=sel]')) { it.selected = el.checked; summary(); }
    if (el.matches('[data-act=near]')) { it.confirmNear = el.checked; it.selected = el.checked; it.saveError = null; refresh(it); }   // confirming means "save this one"
  });

  renderAll();
  await checkDuplicates(sess.items);
  if (!ctx.stale()) renderAll();
}
