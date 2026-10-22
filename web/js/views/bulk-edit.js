// "Edit selected" on the All questions list: change difficulty, marks, tags or the chapter / topic of
// several questions at once. Fields left on "Leave as is" are not touched. Nothing is sent from here:
// the list screen saves the changed questions through the normal save function, so every rule still applies.
import { html } from '../dom.js';
import { DIFFICULTIES, LIMITS } from '../core/constants.js';
import { normalizeTags } from '../core/text.js';

const CLEAR = '__clear';

/** True when the changes would alter anything. */
export function hasBulkChanges(ch) {
  return Boolean(ch && (ch.difficulty !== undefined || ch.marks !== undefined || ch.move
    || normalizeTags(ch.addTags ?? '').length || normalizeTags(ch.removeTags ?? '').length));
}

/**
 * A copy of one question's editable input with the changes applied. Pure, so it is covered by the node tests.
 * @param {object} input what api.toInput(question) returns
 * @param {{difficulty?: string|null, marks?: number|null, addTags?: string, removeTags?: string,
 *          move?: {subject_id:number, chapter_id:number, topic_id:number|null}}} ch
 */
export function applyBulkEdit(input, ch) {
  const next = { ...input };
  if (ch.difficulty !== undefined) next.difficulty = ch.difficulty || null;
  if (ch.marks !== undefined) next.marks = ch.marks === null || ch.marks === '' ? null : Number(ch.marks);
  if (ch.move) {
    next.subject_id = ch.move.subject_id;
    next.chapter_id = ch.move.chapter_id;
    next.topic_id = ch.move.topic_id ?? null;
  }
  const drop = new Set(normalizeTags(ch.removeTags ?? ''));
  let tags = (input.tags ?? []).filter((t) => !drop.has(t));
  for (const t of normalizeTags(ch.addTags ?? '')) if (!tags.includes(t)) tags.push(t);
  next.tags = tags;
  return next;
}

/** One line per change, for the confirmation text. */
export function describeBulkEdit(ch, tax) {
  const out = [];
  if (ch.difficulty !== undefined) out.push(ch.difficulty ? `Difficulty: ${ch.difficulty}` : 'Difficulty: cleared');
  if (ch.marks !== undefined) out.push(`Marks: ${ch.marks}`);
  const add = normalizeTags(ch.addTags ?? ''); const del = normalizeTags(ch.removeTags ?? '');
  if (add.length) out.push(`Add tags: ${add.join(', ')}`);
  if (del.length) out.push(`Remove tags: ${del.join(', ')}`);
  if (ch.move) {
    const s = tax.tree.find((x) => x.id === ch.move.subject_id);
    const c = s?.chapters.find((x) => x.id === ch.move.chapter_id);
    const t = c?.topics.find((x) => x.id === ch.move.topic_id);
    out.push(`Move to: ${[s?.name, c?.name, t?.name].filter(Boolean).join(' › ')}`);
  }
  return out;
}

/**
 * The pop-up form. Resolves with the changes (see applyBulkEdit) or null when cancelled.
 * @param {{tax: any, count: number, published: number}} o
 */
export function bulkEditDialog({ tax, count, published }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = html`<form method="dialog" id="be-form"><h3>Edit ${count} selected question${count === 1 ? '' : 's'}</h3>
      <p class="small muted">Only the boxes you change are applied. Everything else stays exactly as it is.</p>
      <div class="grid2">
        <div class="field"><label for="be-diff">Difficulty</label><select id="be-diff"><option value="">Leave as is</option>${DIFFICULTIES.map((x) => html`<option value="${x}">${x[0].toUpperCase()}${x.slice(1)}</option>`)}<option value="${CLEAR}">Clear difficulty</option></select></div>
        <div class="field"><label for="be-marks">Marks</label><input id="be-marks" type="number" min="0" step="any" inputmode="decimal" placeholder="Leave as is"></div>
      </div>
      <div class="field"><label for="be-add">Add tags <span class="muted">(separate with commas)</span></label><input id="be-add" type="text" autocomplete="off" placeholder="e.g. numerical, board-2024"></div>
      <div class="field"><label for="be-del">Remove tags</label><input id="be-del" type="text" autocomplete="off"></div>
      <div class="grid2">
        <div class="field"><label for="be-s">Move to subject</label><select id="be-s"><option value="">Leave where they are</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
        <div class="field"><label for="be-c">Chapter</label><select id="be-c" disabled><option value="">Pick a subject first</option></select></div>
        <div class="field"><label for="be-t">Topic <span class="muted">(optional)</span></label><select id="be-t" disabled><option value="">No topic</option></select></div>
      </div>
      <p class="small muted">Tags are limited to ${LIMITS.maxTags} per question; a question that would go over is skipped and reported.</p>
      ${published ? html`<p class="warn-line"><b>${published} of these ${published === 1 ? 'is' : 'are'} published.</b> Changes show on the public site straight away.</p>` : ''}
      <p class="warn-line" id="be-err" role="alert" hidden></p>
      <div class="row"><button type="button" class="btn-primary" id="be-ok">Apply to ${count}</button><button type="button" id="be-no">Cancel</button></div></form>`.toString();
    document.body.append(d);
    const $ = (id) => d.querySelector(`#${id}`);
    let result = null;
    d.addEventListener('close', () => { resolve(result); d.remove(); });
    $('be-no').addEventListener('click', () => d.close());
    $('be-s').addEventListener('change', () => {
      const s = tax.tree.find((x) => String(x.id) === $('be-s').value);
      $('be-c').innerHTML = s ? html`<option value="">Pick a chapter</option>${s.chapters.map((c) => html`<option value="${c.id}">${c.name}</option>`)}`.toString() : '<option value="">Pick a subject first</option>';
      $('be-c').disabled = !s;
      $('be-t').innerHTML = '<option value="">No topic</option>'; $('be-t').disabled = true;
    });
    $('be-c').addEventListener('change', () => {
      const s = tax.tree.find((x) => String(x.id) === $('be-s').value);
      const c = s?.chapters.find((x) => String(x.id) === $('be-c').value);
      $('be-t').innerHTML = html`<option value="">No topic</option>${(c?.topics ?? []).map((t) => html`<option value="${t.id}">${t.name}</option>`)}`.toString();
      $('be-t').disabled = !c;
    });
    $('be-ok').addEventListener('click', () => {
      const ch = {};
      const diff = $('be-diff').value;
      if (diff) ch.difficulty = diff === CLEAR ? null : diff;
      const marks = $('be-marks').value.trim();
      if (marks !== '') ch.marks = Number(marks);
      if ($('be-add').value.trim()) ch.addTags = $('be-add').value;
      if ($('be-del').value.trim()) ch.removeTags = $('be-del').value;
      let problem = '';
      if (ch.marks !== undefined && !(Number.isFinite(ch.marks) && ch.marks >= 0)) problem = 'Marks must be a number, 0 or more.';
      if ($('be-s').value) {
        if (!$('be-c').value) problem = problem || 'Pick the chapter to move them to.';
        else ch.move = { subject_id: Number($('be-s').value), chapter_id: Number($('be-c').value), topic_id: $('be-t').value ? Number($('be-t').value) : null };
      }
      if (!problem && !hasBulkChanges(ch)) problem = 'Change at least one thing first.';
      $('be-err').hidden = !problem; $('be-err').textContent = problem;
      if (problem) return;
      result = ch; d.close();
    });
    d.showModal();
    $('be-diff').focus();
  });
}
