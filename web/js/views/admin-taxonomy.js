// Subjects > Chapters > Topics, and the exam list. Admin-managed master data.
//
// Names can be renamed freely (slugs stay stable so links keep working). Anything in use cannot be
// deleted: hide it instead, and it disappears from pickers but old questions keep working.
import { html, on, toast, confirmDialog, promptDialog } from '../dom.js';
import * as api from '../api.js';
import { setTitle } from './public.js';

const byOrder = (a, b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name);
const nextOrder = (list) => (list.length ? Math.max(...list.map((r) => r.sort_order)) + 10 : 10);

function friendly(e) {
  if (e.status === 409 || e.code === 'DUPLICATE_EXACT') {
    return /still in use|referenced/.test(e.message)
      ? 'It still contains chapters, topics or questions, so it cannot be deleted. Hide it instead.'
      : 'That name or code already exists here.';
  }
  return e.message;
}

export default async function taxonomyView(ctx, body) {
  setTitle('Taxonomy');
  let data = await api.adminTaxonomy();
  if (ctx.stale()) return;
  const open = new Set();

  const row = (table, r, siblings, { label, extra = '', adder = null }) => {
    const i = siblings.findIndex((x) => x.id === r.id);
    return html`<div class="tx-row ${r.is_active ? '' : 'is-off'}">
      <span class="tx-name">${r.name}${extra} ${r.is_active ? '' : html`<span class="badge archived">hidden</span>`}</span>
      <span class="tx-actions">
        ${adder}
        <button type="button" class="btn-sm" data-act="rename" data-table="${table}" data-id="${r.id}" aria-label="Rename ${label} ${r.name}">Rename</button>
        <button type="button" class="btn-sm" data-act="toggle" data-table="${table}" data-id="${r.id}" aria-label="${r.is_active ? 'Hide' : 'Show'} ${label} ${r.name}">${r.is_active ? 'Hide' : 'Show'}</button>
        <button type="button" class="btn-sm" data-act="up" data-table="${table}" data-id="${r.id}" ${i === 0 ? 'disabled' : ''} aria-label="Move ${r.name} up">↑</button>
        <button type="button" class="btn-sm" data-act="down" data-table="${table}" data-id="${r.id}" ${i === siblings.length - 1 ? 'disabled' : ''} aria-label="Move ${r.name} down">↓</button>
        <button type="button" class="btn-sm btn-danger" data-act="delete" data-table="${table}" data-id="${r.id}" aria-label="Delete ${label} ${r.name}">Delete</button>
      </span></div>`;
  };

  const draw = () => {
    const subjects = [...data.subjects].sort(byOrder);
    const exams = [...data.exams].sort(byOrder);
    body.innerHTML = html`<div class="page-head"><h1>Taxonomy</h1></div>
      <p class="muted">The lists the AI and the importer sort questions into. A name must match exactly (ignoring capitals and punctuation) to be accepted automatically; near-misses are shown as suggestions.</p>
      <section class="section"><h2>Subjects, chapters and topics</h2>
        <form class="row panel" id="add-subject"><div><label for="ns-code">Short code</label><input type="text" id="ns-code" name="code" required maxlength="8" pattern="[A-Za-z][A-Za-z0-9]{1,7}" placeholder="CHEM" aria-describedby="ns-hint"></div>
          <div class="grow"><label for="ns-name">New subject name</label><input type="text" id="ns-name" name="name" required maxlength="80" placeholder="Chemistry"></div>
          <button class="btn-primary" type="submit">Add subject</button>
          <p class="hint" id="ns-hint">2–8 letters or digits, starting with a letter. The code is part of every question ID (QB-CHEM-000123) and cannot be changed after questions exist.</p></form>
        ${subjects.length ? subjects.map((s) => {
          const chapters = data.chapters.filter((c) => c.subject_id === s.id).sort(byOrder);
          return html`<details class="tx-node" data-key="s${s.id}" ${open.has(`s${s.id}`) ? 'open' : ''}>
            <summary>${row('subjects', s, subjects, { label: 'subject', extra: html` <code>${s.code}</code> <span class="muted small">${chapters.length} ${chapters.length === 1 ? 'chapter' : 'chapters'}</span>`, adder: html`<button type="button" class="btn-sm" data-act="add-chapter" data-id="${s.id}">Add chapter</button>` })}</summary>
            <div class="tx-children">${chapters.length ? chapters.map((c) => {
              const topics = data.topics.filter((t) => t.chapter_id === c.id).sort(byOrder);
              return html`<details class="tx-node" data-key="c${c.id}" ${open.has(`c${c.id}`) ? 'open' : ''}>
                <summary>${row('chapters', c, chapters, { label: 'chapter', extra: html` <span class="muted small">${topics.length} ${topics.length === 1 ? 'topic' : 'topics'}</span>`, adder: html`<button type="button" class="btn-sm" data-act="add-topic" data-id="${c.id}">Add topic</button>` })}</summary>
                <div class="tx-children">${topics.length ? topics.map((t) => row('topics', t, topics, { label: 'topic' })) : html`<p class="muted small">No topics yet. Topics are optional.</p>`}</div></details>`;
            }) : html`<p class="muted small">No chapters yet. Use “Add chapter”.</p>`}</div></details>`;
        }) : html`<div class="empty-state"><p>No subjects yet. Add your first one above.</p></div>`}
      </section>
      <section class="section"><h2>Exams</h2>
        <form class="row panel" id="add-exam"><div><label for="ne-code">Short code</label><input type="text" id="ne-code" name="code" required maxlength="20" placeholder="JEE_MAIN"></div>
          <div class="grow"><label for="ne-name">New exam name</label><input type="text" id="ne-name" name="name" required maxlength="80" placeholder="JEE Main"></div>
          <button class="btn-primary" type="submit">Add exam</button></form>
        ${exams.length ? html`<div class="panel tx-exams">${exams.map((e) => row('exams', e, exams, { label: 'exam', extra: e.code === e.name.toUpperCase() ? '' : html` <code>${e.code}</code>` }))}</div>` : html`<p class="muted">No exams yet.</p>`}
      </section>`.toString();
  };

  const reload = async () => {
    data = await api.adminTaxonomy();
    draw();
  };
  const attempt = async (fn, okMsg) => {
    try { await fn(); await reload(); if (okMsg) toast(okMsg, 'ok'); } catch (e) { toast(friendly(e), 'bad'); }
  };
  const listFor = (table, id) => {
    const r = data[table].find((x) => String(x.id) === String(id));
    const parent = { chapters: 'subject_id', topics: 'chapter_id' }[table];
    return { r, siblings: data[table].filter((x) => !parent || x[parent] === r[parent]).sort(byOrder) };
  };

  draw();

  // Remember which sections are open so a refresh after an edit does not collapse them.
  body.addEventListener('toggle', (e) => {
    const key = e.target?.dataset?.key;
    if (key) { if (e.target.open) open.add(key); else open.delete(key); }
  }, true);

  // Keep the summary clickable controls from toggling the <details> when a button inside is pressed.
  on(body, 'click', 'summary button', (e) => e.preventDefault());

  on(body, 'click', '[data-act]', async (e, el) => {
    const { act, table, id } = el.dataset;
    if (act === 'rename') {
      const { r } = listFor(table, id);
      const name = await promptDialog({ title: 'Rename', label: 'New name', value: r.name });
      if (name && name !== r.name) await attempt(() => api.updateRow(table, r.id, { name }), 'Renamed');
    } else if (act === 'toggle') {
      const { r } = listFor(table, id);
      if (r.is_active && !(await confirmDialog({ title: `Hide “${r.name}”?`, body: 'It will no longer be offered when adding questions or on the public site. Nothing is deleted, and you can show it again later.', confirmLabel: 'Hide', danger: true }))) return;
      await attempt(() => api.updateRow(table, r.id, { is_active: !r.is_active }), r.is_active ? 'Hidden from pickers' : 'Visible again');
    } else if (act === 'up' || act === 'down') {
      const { r, siblings } = listFor(table, id);
      const i = siblings.findIndex((x) => x.id === r.id);
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= siblings.length) return;
      const arr = [...siblings];
      [arr[i], arr[j]] = [arr[j], arr[i]];
      // Give every sibling a clean 10, 20, 30… so ties (all zeros) never block a move.
      await attempt(async () => {
        for (const [k, x] of arr.entries()) if (x.sort_order !== (k + 1) * 10) await api.updateRow(table, x.id, { sort_order: (k + 1) * 10 });
      });
    } else if (act === 'delete') {
      const { r } = listFor(table, id);
      const ok = await confirmDialog({ title: `Delete “${r.name}”?`, body: 'This cannot be undone. If anything still uses it, the delete is refused and you can hide it instead.', confirmLabel: 'Delete', danger: true });
      if (ok) await attempt(() => api.deleteRow(table, r.id), 'Deleted');
    } else if (act === 'add-chapter') {
      const name = await promptDialog({ title: 'Add chapter', label: 'Chapter name', confirmLabel: 'Add' });
      if (name) { open.add(`s${id}`); await attempt(() => api.createChapter({ subject_id: Number(id), name, sort_order: nextOrder(data.chapters.filter((c) => c.subject_id === Number(id))) }), 'Chapter added'); }
    } else if (act === 'add-topic') {
      const name = await promptDialog({ title: 'Add topic', label: 'Topic name', confirmLabel: 'Add' });
      if (name) {
        const ch = data.chapters.find((c) => c.id === Number(id));
        open.add(`s${ch.subject_id}`); open.add(`c${id}`);
        await attempt(() => api.createTopic({ chapter_id: Number(id), name, sort_order: nextOrder(data.topics.filter((t) => t.chapter_id === Number(id))) }), 'Topic added');
      }
    }
  });

  on(body, 'submit', '#add-subject', async (e, form) => {
    e.preventDefault();
    const f = new FormData(form);
    await attempt(() => api.createSubject({ code: String(f.get('code')), name: String(f.get('name')), sort_order: nextOrder(data.subjects) }), 'Subject added');
  });
  on(body, 'submit', '#add-exam', async (e, form) => {
    e.preventDefault();
    const f = new FormData(form);
    await attempt(() => api.createExam({ code: String(f.get('code')), name: String(f.get('name')), sort_order: nextOrder(data.exams) }), 'Exam added');
  });
}
