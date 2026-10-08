// The question editor: one form that adapts to the question type. Used to fix AI mistakes,
// write questions by hand, and edit saved ones. It edits a QuestionInput (see core/validate.js)
// and never talks to the server itself.
import { html, confirmDialog } from '../dom.js';
import { OPTION_LETTERS, QUESTION_TYPES, DIFFICULTIES, STATUSES, LIMITS } from '../core/constants.js';
import { defaultOptionsFor } from '../core/validate.js';
import { normalizeTags } from '../core/text.js';

const kindOf = (d) => {
  const k = QUESTION_TYPES[d.type_code]?.kind ?? 'text';
  return k === 'any' ? (d.options ? 'choice' : 'text') : k;
};
const blankMatch = () => ({ left: [{ id: 'A', text: '' }, { id: 'B', text: '' }], right: [{ id: '1', text: '' }, { id: '2', text: '' }] });

/** Shape the draft for a (new) type, keeping what still makes sense. */
function retype(d, code) {
  const old = kindOf(d);
  d.type_code = code;
  const kind = kindOf(d);
  const def = QUESTION_TYPES[code];
  if (def.kind === 'any') { d.options = null; d.match_items = null; d.answer = { text: '' }; return; }
  if (kind === 'choice') {
    d.match_items = null;
    if (old !== 'choice' || code === 'true_false' || code === 'assertion_reason') { d.options = defaultOptionsFor(code) ?? defaultOptionsFor('mcq'); d.answer = { value: 'A' }; }
    else if (d.options.length > def.maxOptions) { d.options = d.options.slice(0, def.maxOptions); if (!d.options.some((o) => o.id === d.answer?.value)) d.answer = { value: 'A' }; }
  } else if (kind === 'text') { d.options = null; d.match_items = null; if (old !== 'text') d.answer = { text: '' }; }
  else if (kind === 'numeric') { d.options = null; d.match_items = null; if (old !== 'numeric') d.answer = { number: '', unit: '', tolerance: '' }; }
  else if (kind === 'match') { d.options = null; if (old !== 'match') { d.match_items = blankMatch(); d.answer = { pairs: {} }; } }
}

const errAt = (errors, prefix) => errors.filter((e) => e.path === prefix || e.path.startsWith(`${prefix}[`) || e.path.startsWith(`${prefix}.`));
const msgs = (errors, prefix) => errAt(errors, prefix).map((e) => html`<div class="field-error" role="alert">${e.message}</div>`);
const bad = (errors, prefix) => (errAt(errors, prefix).length ? 'true' : 'false');
const warns = (warnings, prefix) => (warnings ?? []).filter((e) => e.path === prefix || e.path.startsWith(`${prefix}[`)).map((e) => html`<div class="hint">${e.message}</div>`);

const SOURCE_NOTE = {
  answer: { extracted: ['ok', 'Answer was printed in the image.'], inferred: ['warn', 'The AI worked this answer out itself. Check it before saving.'], none: ['bad', 'The AI could not find an answer. Choose one.'] },
  explanation: { extracted: ['ok', 'Explanation was printed in the image.'], generated: ['warn', 'The AI wrote this explanation. Read it before saving.'], none: ['', ''] },
};
const sourceNote = (kind, meta) => {
  const [cls, text] = SOURCE_NOTE[kind][meta?.[`${kind}_source`]] ?? ['', ''];
  return text ? html`<div class="notice ${cls}">${text}</div>` : '';
};

export function renderEditor(d, { tax, errors = [], warnings = [], meta = null, locked = {} }) {
  const kind = kindOf(d);
  const def = QUESTION_TYPES[d.type_code];
  const subject = tax.tree.find((s) => s.id === d.subject_id);
  const chapter = subject?.chapters.find((c) => c.id === d.chapter_id);
  const maxOpts = def.maxOptions || 6;
  const fixedCount = d.type_code === 'true_false' || d.type_code === 'assertion_reason';
  const num = d.answer ?? {};

  return html`<div class="editor-form" data-editor>
    ${meta?.notes ? html`<div class="notice warn"><b>Note from the AI:</b> ${meta.notes}</div>` : ''}
    <div class="grid2">
      <div class="field"><label for="f-type">Question type</label>
        <select id="f-type" data-f="type_code" ${locked.type ? 'disabled' : ''}>${Object.entries(QUESTION_TYPES).map(([code, t]) => html`<option value="${code}" ${code === d.type_code ? 'selected' : ''}>${t.label}</option>`)}</select>${msgs(errors, 'type_code')}</div>
      <div class="field"><label for="f-subj">Subject</label>
        <select id="f-subj" data-f="subject_id" aria-invalid="${bad(errors, 'subject_id')}"><option value="">Choose…</option>${tax.tree.map((s) => html`<option value="${s.id}" ${s.id === d.subject_id ? 'selected' : ''}>${s.name}</option>`)}</select>${msgs(errors, 'subject_id')}</div>
      <div class="field"><label for="f-chap">Chapter</label>
        <select id="f-chap" data-f="chapter_id" aria-invalid="${bad(errors, 'chapter_id')}"><option value="">Choose…</option>${(subject?.chapters ?? []).map((c) => html`<option value="${c.id}" ${c.id === d.chapter_id ? 'selected' : ''}>${c.name}</option>`)}</select>${msgs(errors, 'chapter_id')}${warns(warnings, 'chapter_id')}</div>
      <div class="field"><label for="f-topic">Topic <span class="muted">(optional)</span></label>
        <select id="f-topic" data-f="topic_id" aria-invalid="${bad(errors, 'topic_id')}"><option value="">None</option>${(chapter?.topics ?? []).map((t) => html`<option value="${t.id}" ${t.id === d.topic_id ? 'selected' : ''}>${t.name}</option>`)}</select>${msgs(errors, 'topic_id')}${warns(warnings, 'topic_id')}</div>
    </div>

    ${(def.requiresContext || d.context) ? html`<div class="field"><label for="f-ctx">Passage or case ${def.requiresContext ? '' : html`<span class="muted">(optional)</span>`}</label>
      <textarea id="f-ctx" data-f="context" aria-invalid="${bad(errors, 'context')}" maxlength="${LIMITS.context}">${d.context ?? ''}</textarea>${msgs(errors, 'context')}</div>`
      : html`<p><button type="button" class="btn-sm btn-quiet" data-act="add-context">+ Add a passage or case</button></p>`}

    <div class="field"><label for="f-text">Question</label>
      <textarea id="f-text" data-f="question_text" aria-invalid="${bad(errors, 'question_text')}" maxlength="${LIMITS.questionText}">${d.question_text ?? ''}</textarea>${msgs(errors, 'question_text')}${warns(warnings, 'question_text')}</div>

    ${kind === 'choice' ? html`<fieldset><legend>Options — select the correct one</legend>
      ${def.kind === 'any' ? html`<p><button type="button" class="btn-sm" data-act="drop-options">Use a written answer instead</button></p>` : ''}
      ${(d.options ?? []).map((o, i) => html`<div class="opt-row"><span class="k">${o.id}.</span>
        <div><label class="sr" for="f-opt-${i}">Option ${o.id}</label><input id="f-opt-${i}" type="text" data-opt="${i}" value="${o.text}" aria-invalid="${bad(errors, `options[${i}]`)}" maxlength="${LIMITS.optionText}">${msgs(errors, `options[${i}]`)}</div>
        <div class="pick"><input type="radio" name="correct" value="${o.id}" ${d.answer?.value === o.id ? 'checked' : ''} aria-label="Option ${o.id} is correct"><span>${!fixedCount && (d.options.length > Math.max(def.minOptions, 2)) ? html`<button type="button" class="btn-sm btn-quiet" data-act="del-opt" data-i="${i}" aria-label="Remove option ${o.id}">Remove</button>` : 'correct'}</span></div></div>`)}
      ${errors.filter((e) => e.path === 'options').map((e) => html`<div class="field-error" role="alert">${e.message}</div>`)}${msgs(errors, 'answer')}
      ${!fixedCount && (d.options?.length ?? 0) < maxOpts ? html`<button type="button" class="btn-sm" data-act="add-opt">+ Add option</button>` : ''}
      ${sourceNote('answer', meta)}</fieldset>` : ''}

    ${kind === 'text' ? html`<div class="field"><label for="f-ans">Answer</label>
      <textarea id="f-ans" data-ans="text" aria-invalid="${bad(errors, 'answer')}" maxlength="${LIMITS.textAnswer}">${d.answer?.text ?? ''}</textarea>${msgs(errors, 'answer')}${warns(warnings, 'answer')}${sourceNote('answer', meta)}
      ${def.kind === 'any' ? html`<p><button type="button" class="btn-sm" data-act="add-options">Use answer options instead</button></p>` : ''}</div>` : ''}

    ${kind === 'numeric' ? html`<fieldset><legend>Answer</legend><div class="grid2">
      <div class="field"><label for="f-n">Number</label><input id="f-n" type="text" inputmode="decimal" data-num="number" value="${num.number ?? ''}" aria-invalid="${bad(errors, 'answer')}" placeholder="e.g. 6.02e23"></div>
      <div class="field"><label for="f-u">Unit <span class="muted">(optional)</span></label><input id="f-u" type="text" data-num="unit" value="${num.unit ?? ''}" maxlength="20" placeholder="e.g. mol/L">${msgs(errors, 'answer.unit')}</div>
      <div class="field"><label for="f-t">Tolerance <span class="muted">(optional, ±)</span></label><input id="f-t" type="text" inputmode="decimal" data-num="tolerance" value="${num.tolerance ?? ''}">${msgs(errors, 'answer.tolerance')}</div></div>
      ${msgs(errors, 'answer').filter(Boolean)}${sourceNote('answer', meta)}</fieldset>` : ''}

    ${kind === 'match' ? html`<fieldset><legend>Match the lists</legend><div class="match-grid">
      <div class="field"><label for="f-ml">List I <span class="muted">(one item per line)</span></label><textarea id="f-ml" data-match="left">${(d.match_items?.left ?? []).map((x) => x.text).join('\n')}</textarea>${msgs(errors, 'match_items.left')}</div>
      <div class="field"><label for="f-mr">List II <span class="muted">(one item per line)</span></label><textarea id="f-mr" data-match="right">${(d.match_items?.right ?? []).map((x) => x.text).join('\n')}</textarea>${msgs(errors, 'match_items.right')}</div></div>
      ${(d.match_items?.left ?? []).map((l) => html`<div class="field"><label for="f-p-${l.id}">${l.id}. ${l.text || '(empty)'} matches</label>
        <select id="f-p-${l.id}" data-pair="${l.id}"><option value="">Choose…</option>${(d.match_items.right ?? []).map((r) => html`<option value="${r.id}" ${d.answer?.pairs?.[l.id] === r.id ? 'selected' : ''}>${r.id}. ${r.text || '(empty)'}</option>`)}</select></div>`)}
      ${msgs(errors, 'answer')}${msgs(errors, 'match_items')}${sourceNote('answer', meta)}</fieldset>` : ''}

    <div class="field"><label for="f-exp">Explanation <span class="muted">(optional)</span></label>
      <textarea id="f-exp" data-f="explanation" maxlength="${LIMITS.explanation}">${d.explanation ?? ''}</textarea>${msgs(errors, 'explanation')}${sourceNote('explanation', meta)}</div>

    <div class="grid2">
      <div class="field"><label for="f-diff">Difficulty</label><select id="f-diff" data-f="difficulty"><option value="">Not set</option>${DIFFICULTIES.map((x) => html`<option value="${x}" ${d.difficulty === x ? 'selected' : ''}>${x[0].toUpperCase()}${x.slice(1)}</option>`)}</select>${msgs(errors, 'difficulty')}${warns(warnings, 'difficulty')}</div>
      <div class="field"><label for="f-marks">Marks</label><input id="f-marks" type="text" inputmode="decimal" data-f="marks" value="${d.marks ?? ''}" aria-invalid="${bad(errors, 'marks')}">${msgs(errors, 'marks')}</div>
      <div class="field"><label for="f-tags">Tags <span class="muted">(comma separated)</span></label><input id="f-tags" type="text" data-f="_tags" value="${d._tags ?? (d.tags ?? []).join(', ')}">${msgs(errors, 'tags')}${warns(warnings, 'tags')}</div>
      <div class="field"><label for="f-src">Source <span class="muted">(optional)</span></label><input id="f-src" type="text" data-f="source_ref" value="${d.source_ref ?? ''}" maxlength="${LIMITS.sourceRef}">${msgs(errors, 'source_ref')}</div>
    </div>

    <fieldset><legend>Exam appearances <span class="muted small">(leave empty for general practice questions)</span></legend>
      ${(d.exams ?? []).map((e, i) => html`<div class="grid2"><div class="field"><label for="f-ex-${i}">Exam</label><select id="f-ex-${i}" data-exam="${i}:exam_id" aria-invalid="${bad(errors, `exams[${i}]`)}"><option value="">Choose…</option>${tax.exams.map((x) => html`<option value="${x.id}" ${x.id === e.exam_id ? 'selected' : ''}>${x.name}</option>`)}</select>${msgs(errors, `exams[${i}]`)}</div>
        <div class="field"><label for="f-ey-${i}">Year</label><input id="f-ey-${i}" type="text" inputmode="numeric" data-exam="${i}:year" value="${e.year ?? ''}"></div>
        <div class="field"><label for="f-ep-${i}">Paper / shift</label><input id="f-ep-${i}" type="text" data-exam="${i}:paper" value="${e.paper ?? ''}" maxlength="${LIMITS.paper}"></div>
        <div class="field"><label class="sr">Remove</label><button type="button" class="btn-sm" data-act="del-exam" data-i="${i}">Remove exam</button></div></div>`)}
      ${msgs(errors, 'exams')}${(d.exams?.length ?? 0) < LIMITS.maxExamsPerQuestion ? html`<button type="button" class="btn-sm" data-act="add-exam">+ Add exam</button>` : ''}</fieldset>
  </div>`;
}

/**
 * Mount the editor into `container`. Returns handles to read the value and show new errors.
 * @param {HTMLElement} container
 * @param {{draft:any, tax:any, errors?:any[], warnings?:any[], meta?:any, locked?:any}} cfg
 */
const clip = (t, n = 80) => { const x = String(t ?? '').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
/** True when the draft holds typed work that a type change or "drop options" would throw away. */
function hasWork(d) {
  if ((d.options ?? []).some((o) => String(o.text ?? '').trim())) return true;
  if (String(d.answer?.text ?? '').trim() || String(d.answer?.number ?? '').trim()) return true;
  if (Object.keys(d.answer?.pairs ?? {}).length) return true;
  const m = d.match_items;
  return Boolean(m && ((m.left ?? []).some((x) => String(x.text ?? '').trim()) || (m.right ?? []).some((x) => String(x.text ?? '').trim())));
}

export function mountEditor(container, cfg) {
  const state = { draft: structuredClone(cfg.draft), errors: cfg.errors ?? [], warnings: cfg.warnings ?? [] };
  const d = state.draft;
  if (d.exams === undefined) d.exams = [];
  if (kindOf(d) === 'numeric') d.answer = { number: d.answer?.number ?? '', unit: d.answer?.unit ?? '', tolerance: d.answer?.tolerance ?? '' };

  const draw = () => {
    const scroll = window.scrollY;
    container.innerHTML = renderEditor(state.draft, { tax: cfg.tax, errors: state.errors, warnings: state.warnings, meta: cfg.meta, locked: cfg.locked ?? {} }).toString();
    window.scrollTo({ top: scroll });
    lastType = state.draft.type_code;
  };
  let lastType = state.draft.type_code;
  const intOrNull = (v) => (v === '' || v === null ? null : Number(v));

  const sync = (el) => {
    const dr = state.draft;
    if (el.matches('[data-f]')) {
      const f = el.dataset.f;
      if (['subject_id', 'chapter_id', 'topic_id'].includes(f)) dr[f] = intOrNull(el.value);
      else if (f === '_tags') dr._tags = el.value;
      else dr[f] = el.value === '' ? null : el.value;
      if (f === 'question_text') dr.question_text = el.value;
    } else if (el.matches('[data-opt]')) dr.options[Number(el.dataset.opt)].text = el.value;
    else if (el.matches('input[name=correct]')) dr.answer = { value: el.value };
    else if (el.matches('[data-ans=text]')) dr.answer = { text: el.value };
    else if (el.matches('[data-num]')) { dr.answer = { ...(dr.answer ?? {}), [el.dataset.num]: el.value }; }
    else if (el.matches('[data-match]')) {
      const side = el.dataset.match;
      const lines = el.value.split('\n').map((s) => s.trim()).filter(Boolean);
      dr.match_items = dr.match_items ?? blankMatch();
      dr.match_items[side] = lines.map((text, i) => ({ id: side === 'left' ? OPTION_LETTERS[i] ?? String.fromCharCode(65 + i) : String(i + 1), text }));
    } else if (el.matches('[data-pair]')) {
      const pairs = { ...(dr.answer?.pairs ?? {}) };
      if (el.value) pairs[el.dataset.pair] = el.value; else delete pairs[el.dataset.pair];
      dr.answer = { pairs };
    } else if (el.matches('[data-exam]')) {
      const [i, key] = el.dataset.exam.split(':');
      dr.exams[Number(i)][key] = key === 'exam_id' ? intOrNull(el.value) : el.value;
    }
  };

  container.addEventListener('input', (e) => { if (e.target instanceof Element) sync(e.target); });
  container.addEventListener('change', async (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    sync(el);
    const dr = state.draft;
    if (el.matches('[data-f=type_code]')) {
      const prev = lastType;
      const from = QUESTION_TYPES[prev]; const to = QUESTION_TYPES[el.value];
      const loses = from && to && (from.kind !== to.kind || (prev !== el.value && ['true_false', 'assertion_reason'].includes(el.value)));
      if (loses && hasWork(dr) && !(await confirmDialog({ title: `Change type to ${to.label}?`, body: 'The options and answer you have entered for the current type will be replaced. The question text stays.', confirmLabel: 'Change type', danger: true }))) { dr.type_code = prev; draw(); return; }
      retype(dr, el.value); state.errors = []; draw();
    }
    else if (el.matches('[data-f=subject_id]')) { dr.chapter_id = null; dr.topic_id = null; draw(); }
    else if (el.matches('[data-f=chapter_id]')) { dr.topic_id = null; draw(); }
    else if (el.matches('[data-match]')) draw();
  });
  container.addEventListener('click', async (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-act]') : null;
    if (!b) return;
    const dr = state.draft;
    const i = Number(b.dataset.i);
    const sure = (title, body, confirmLabel = 'Remove') => confirmDialog({ title, body, confirmLabel, danger: true });
    switch (b.dataset.act) {
      case 'add-opt': dr.options.push({ id: OPTION_LETTERS[dr.options.length], text: '' }); break;
      case 'del-opt': {
        const o = dr.options[i];
        const label = OPTION_LETTERS[i];
        const text = clip(o?.text);
        const lead = text ? `“${text}” will be removed. ` : 'This empty option will be removed. ';
        const extra = dr.answer?.value === o?.id ? ' It is the marked correct answer, so the correct answer will reset to option A.' : '';
        if (!(await sure(`Remove option ${label}?`, `${lead}The options after it move up one letter.${extra}`))) return;
        dr.options.splice(i, 1);
        dr.options.forEach((o, k) => { o.id = OPTION_LETTERS[k]; });
        if (!dr.options.some((o) => o.id === dr.answer?.value)) dr.answer = { value: 'A' };
        break;
      }
      case 'add-exam': dr.exams.push({ exam_id: null, year: '', paper: '' }); break;
      case 'del-exam': {
        const ex = dr.exams[i];
        const nm = (cfg.tax?.exams ?? []).find((x) => x.id === ex?.exam_id)?.name;
        const what = [nm, ex?.year, ex?.paper].filter(Boolean).join(' ');
        if (!(await sure('Remove this exam appearance?', what ? `${what} will be removed from this question.` : 'This empty exam row will be removed.'))) return;
        dr.exams.splice(i, 1); break;
      }
      case 'add-context': dr.context = ''; break;
      case 'drop-options':
        if (hasWork(dr) && !(await sure('Remove all answer options?', 'The options and the marked correct answer will be removed, and you will type a written answer instead.', 'Remove options'))) return;
        dr.options = null; dr.answer = { text: '' }; break;
      case 'add-options': dr.options = defaultOptionsFor('mcq'); dr.answer = { value: 'A' }; break;
      default: return;
    }
    draw();
  });

  draw();
  return {
    /** The draft as a clean QuestionInput (what the server validates). */
    read() {
      const dr = structuredClone(state.draft);
      dr.tags = normalizeTags(dr._tags ?? dr.tags ?? []);
      delete dr._tags;
      if (kindOf(dr) === 'numeric' && dr.answer) {
        const a = dr.answer;
        const n = a.number === '' ? undefined : Number(a.number);
        dr.answer = { number: n === undefined ? '' : (Number.isFinite(n) ? n : a.number) };
        if (String(a.unit ?? '').trim()) dr.answer.unit = String(a.unit).trim();
        if (String(a.tolerance ?? '').trim()) { const t = Number(a.tolerance); dr.answer.tolerance = Number.isFinite(t) ? t : a.tolerance; }
      }
      if (dr.exams) dr.exams = dr.exams.map((e) => ({ exam_id: e.exam_id, year: e.year === '' ? null : e.year, paper: e.paper === '' ? null : e.paper })).filter((e) => e.exam_id !== null || e.year || e.paper);
      return dr;
    },
    show(errors, warnings = state.warnings) { state.errors = errors; state.warnings = warnings; draw(); },
  };
}

export { STATUSES };
