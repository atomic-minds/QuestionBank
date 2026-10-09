// Add questions: from an image (AI), from pasted JSON, or by hand.
import { html, copyText, toast } from '../dom.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { importQuestions } from '../core/importer.js';
import { LIMITS } from '../core/constants.js';
import { AI_MAX_QUESTIONS } from '../core/ai/schema.js';
import { setTitle } from './public.js';
import { photoStore, setDrafts } from './drafts.js';
import { prepareImage } from './image-tools.js';

const TABS = [['image', 'From an image'], ['json', 'Paste JSON'], ['manual', 'Write one']];

function exampleJson(tax) {
  const s = tax.tree[0];
  const c = s?.chapters[0];
  return JSON.stringify({
    format: 'qb-import', version: 1,
    questions: [
      { type: 'mcq', question: 'What is the coordination number of NaCl?', options: ['4', '6', '8', '12'], answer: 'B', explanation: 'Each Na⁺ is surrounded by six Cl⁻ ions.', subject: s?.name ?? 'Chemistry', chapter: c?.name ?? 'Solid State', topic: c?.topics[0]?.name ?? null, difficulty: 'medium', marks: 1, tags: ['nacl'], exams: [{ exam: tax.exams[0]?.name ?? 'CBSE', year: 2025 }] },
      { type: 'short_answer', question: 'Define a unit cell.', answer: 'The smallest repeating unit of a crystal lattice.', subject: s?.name ?? 'Chemistry', chapter: c?.name ?? 'Solid State' },
    ],
  }, null, 2);
}

function aiInstructions(tax) {
  const list = tax.tree.map((s) => `- ${s.name}: ${s.chapters.map((c) => c.name).join('; ')}`).join('\n');
  return `Read the attached image and return ONLY a JSON object, no commentary, in this exact shape:

{"format":"qb-import","version":1,"questions":[{
  "type": "mcq | true_false | assertion_reason | numerical | short_answer | long_answer | fill_blank | case_based | match_following",
  "question": "question text",
  "context": "passage, for case_based only, else null",
  "options": ["option text without A./B. labels"],
  "answer": "the option letter (B) for choice types; the answer text otherwise; for match_following use \\"A-2, B-1\\"",
  "explanation": "explanation or null",
  "subject": "...", "chapter": "...", "topic": "... or null",
  "difficulty": "easy | medium | hard or null", "marks": number or null, "tags": [],
  "exams": [{"exam": "name", "year": 2025}]
}]}

For match_following use "match": {"left": [...], "right": [...]} instead of options.
Do not invent questions. Use only these subject and chapter names:
${list}`;
}

export default async function add(ctx, body) {
  setTitle('Add questions');
  const tab = TABS.some(([k]) => k === ctx.query.tab) ? ctx.query.tab : 'image';
  const tax = await api.getTaxonomy({ force: true });
  if (ctx.stale()) return;
  const noTax = tax.tree.length === 0;
  body.innerHTML = html`<div class="page-head"><h1>Add questions</h1></div>
    <nav class="tabs" aria-label="How to add">${TABS.map(([k, label]) => html`<a href="/admin/add?tab=${k}" ${k === tab ? 'aria-current=page' : ''}>${label}</a>`)}</nav>
    ${noTax ? html`<div class="notice warn">Add at least one subject and chapter first, so questions can be filed. <a href="/admin/taxonomy">Open Taxonomy</a></div>` : ''}
    <div id="tab"></div>`.toString();
  const host = body.querySelector('#tab');
  if (tab === 'image') imageTab(host, tax);
  else if (tab === 'json') jsonTab(host, tax);
  else host.innerHTML = html`<div class="panel"><p>Type a question yourself. You choose the type, options and answer, and nothing is sent to an AI.</p><a class="btn btn-primary" href="/admin/edit/new">Start a blank question</a></div>`.toString();
}

const MAX_PHOTOS = 10;
const STOP_CODES = new Set(['AI_DAILY_LIMIT', 'AI_QUOTA_EXHAUSTED', 'AI_NOT_CONFIGURED', 'UNAUTHENTICATED']);

function imageTab(host, tax) {
  host.innerHTML = html`<div class="panel stack">
    <div class="dropzone" id="drop"><p><b>Photos or screenshots of the questions</b></p>
      <p class="muted small">JPEG, PNG or WebP. Choose up to ${MAX_PHOTOS} photos at once; they are read one after another and all the questions land in one review list. Each photo can hold up to ${AI_MAX_QUESTIONS} questions and uses one AI read. Photos are shrunk on your device and are not stored.</p>
      <input type="file" id="file" accept="image/jpeg,image/png,image/webp" multiple aria-label="Choose photos"></div>
    <ul class="queue" id="queue" aria-live="polite"></ul>
    <div class="grid2"><div class="field"><label for="hint-s">Subject <span class="muted">(helps the AI file it)</span></label>
      <select id="hint-s"><option value="">Let the AI decide</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <div class="field"><label for="note">Note for the AI <span class="muted">(optional)</span></label><input id="note" type="text" maxlength="300" placeholder="e.g. answers are printed at the bottom"></div></div>
    <div id="x-err"></div>
    <div class="row"><button class="btn-primary" id="go" disabled>Read the questions</button><span class="muted small" id="busy"></span></div>
    <p class="muted small" id="used"></p>
    <div class="notice small"><b>Privacy:</b> the photos are sent to Google's Gemini service. On Google's free tier, Google may use what you send to improve its products and a person may review it. For private material use <a href="/admin/add?tab=json">Paste JSON</a> instead.</div>
  </div>`.toString();

  /** @type {{id:string,name:string,blob:Blob,url:string,status:'ready'|'reading'|'done'|'failed'|'skipped',msg:string,result:any,code?:string}[]} */
  const items = [];
  let running = false;
  let seq = 0;
  const file = host.querySelector('#file');
  const go = host.querySelector('#go');
  const queue = host.querySelector('#queue');
  const busy = host.querySelector('#busy');
  const err = host.querySelector('#x-err');
  const STATUS = { ready: 'Ready', reading: 'Reading…', done: '', failed: '', skipped: '' };

  api.adminStats().then((st) => { host.querySelector('#used').textContent = `AI reads used today: ${st.ai_used_today}. The count restarts at 12:00 am India time.`; }).catch(() => {});

  const pending = () => items.filter((i) => i.status === 'ready' || i.status === 'failed' || i.status === 'skipped');
  function draw() {
    queue.innerHTML = items.map((it, k) => html`<li class="q-item ${it.status}" data-id="${it.id}"><img alt="" src="${it.url}"><div><b>Photo ${k + 1}</b> <span class="muted small">${it.name}</span>
      <div class="small ${it.status === 'failed' ? 'e' : 'muted'}">${STATUS[it.status] || it.msg}</div></div>
      ${running || it.status === 'done' ? '' : html`<button type="button" class="btn-sm btn-quiet" data-rm="${it.id}" aria-label="Remove photo ${k + 1}">Remove</button>`}</li>`).join('');
    const n = pending().length;
    go.disabled = running || n === 0;
    go.textContent = n > 1 ? `Read ${n} photos` : 'Read the questions';
  }
  async function add(files) {
    err.innerHTML = '';
    const room = MAX_PHOTOS - items.length;
    const list = [...files];
    if (list.length > room) toast(`Up to ${MAX_PHOTOS} photos at a time. The first ${Math.max(room, 0)} were added.`);
    for (const f of list.slice(0, Math.max(room, 0))) {
      try {
        const blob = await prepareImage(f);
        seq += 1;
        items.push({ id: `p${Date.now()}-${seq}`, name: f.name || `photo ${seq}`, blob, url: URL.createObjectURL(blob), status: 'ready', msg: '', result: null });
      } catch (e) { err.innerHTML = html`<div class="notice bad" role="alert"><b>${f.name || 'That file'}:</b> ${e.message}</div>`.toString(); }
    }
    file.value = '';
    draw();
  }
  file.addEventListener('change', () => add(file.files));
  const drop = host.querySelector('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add(e.dataTransfer.files); });
  queue.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('[data-rm]') : null;
    if (!b || running) return;
    const at = items.findIndex((i) => i.id === b.dataset.rm);
    if (at >= 0) { URL.revokeObjectURL(items[at].url); items.splice(at, 1); draw(); }
  });

  go.addEventListener('click', async () => {
    running = true; err.innerHTML = '';
    const subjectId = Number(host.querySelector('#hint-s').value) || null;
    const note = host.querySelector('#note').value;
    const todo = pending();
    todo.forEach((i) => { i.status = 'ready'; i.msg = ''; });
    let stopWhy = null;
    let last = null;
    for (const [at, it] of todo.entries()) {
      if (stopWhy) { it.status = 'skipped'; it.msg = `Not read: ${stopWhy}`; continue; }
      it.status = 'reading'; draw();
      busy.textContent = todo.length > 1 ? `Reading photo ${at + 1} of ${todo.length}… this can take up to a minute each.` : 'Reading the image… this can take up to a minute.';
      try {
        it.result = await api.extractFromImage(it.blob, { subjectId, note });
        it.status = 'done';
        it.msg = '';
        last = it.result.ai?.quota ?? last;
      } catch (e) {
        const why = typeof e.details?.provider_message === 'string' && e.details.provider_message ? ` Google said: ${e.details.provider_message}` : '';
        it.status = 'failed'; it.msg = `${e.message}${why}`; it.code = e.code;
        if (STOP_CODES.has(e.code)) stopWhy = e.message;
      }
      draw();
    }
    running = false; busy.textContent = '';
    if (last) host.querySelector('#used').textContent = `AI reads used today: ${last.used} of ${last.limit}. The count restarts at 12:00 am India time.`;
    const done = items.filter((i) => i.status === 'done');
    const notRead = items.filter((i) => i.status === 'failed' || i.status === 'skipped');
    if (!done.length) {
      draw();
      const first = notRead[0];
      const fallback = ['AI_DAILY_LIMIT', 'AI_QUOTA_EXHAUSTED', 'AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BLOCKED', 'AI_BAD_OUTPUT'].includes(first?.code);
      err.innerHTML = html`<div class="notice bad" role="alert"><b>${first ? first.msg : 'Nothing could be read.'}</b>
        ${fallback ? html`<p class="small">You can try again, or use <a href="/admin/add?tab=json">Paste JSON</a> (you can get the JSON from any AI tool, or write it yourself).</p>` : ''}</div>`.toString();
      return;
    }
    const multi = items.length > 1;
    const merged = { items: [], notes: [], missing: { subjects: [], chapters: [], topics: [] } };
    for (const it of done) {
      const n = items.indexOf(it) + 1;
      photoStore.set(it.id, it.blob);
      for (const x of it.result.items) merged.items.push({ ...x, photo: multi ? { id: it.id, n } : { id: it.id, n: 1 } });
      for (const t of it.result.notes ?? []) merged.notes.push(multi ? `Photo ${n}: ${t}` : t);
      for (const k of ['subjects', 'chapters', 'topics']) for (const m of it.result.missing?.[k] ?? []) {
        if (!merged.missing[k].some((y) => JSON.stringify(y) === JSON.stringify(m))) merged.missing[k].push(m);
      }
    }
    for (const it of notRead) merged.notes.push(`Photo ${items.indexOf(it) + 1} (${it.name}) was not read: ${it.msg} Add it again from Add questions.`);
    setDrafts(merged, 'ai');
    const total = merged.items.length;
    toast(`${total} question${total === 1 ? '' : 's'} read${multi ? ` from ${done.length} photo${done.length === 1 ? '' : 's'}` : ''}. Please review them.`, 'ok');
    navigate('/admin/review');
  });
  draw();
}

function jsonTab(host, tax) {
  const example = exampleJson(tax);
  host.innerHTML = html`<form class="panel stack" id="jf">
    <div class="field"><label for="json">Paste JSON</label><textarea id="json" class="code" spellcheck="false" placeholder='{"questions": [ ... ]}'></textarea>
      <p class="hint">A single question, a list, or {"questions": [...]}. Up to ${LIMITS.importItemsMax} at a time. Code fences and trailing commas are fixed for you.</p></div>
    <div class="field"><label for="jfile">…or choose a .json file</label><input id="jfile" type="file" accept=".json,application/json,.txt"></div>
    <details><summary>Fill in missing details for every question (optional)</summary><div class="grid2 mt">
      <div class="field"><label for="d-s">Default subject</label><select id="d-s"><option value="">None</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <div class="field"><label for="d-c">Default chapter</label><select id="d-c"><option value="">None</option></select></div>
      <div class="field"><label for="d-e">Default exam</label><select id="d-e"><option value="">None</option>${tax.exams.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div>
      <div class="field"><label for="d-y">Year</label><input id="d-y" type="text" inputmode="numeric"></div>
      <div class="field"><label for="d-p">Paper / shift</label><input id="d-p" type="text"></div></div>
      <p class="hint">These apply only to questions that do not say it themselves.</p></details>
    <div id="j-err"></div>
    <div class="row"><button class="btn-primary" type="submit">Check and preview</button></div>
    <details><summary>Format help, example and instructions for another AI</summary><div class="stack mt">
      <p>Each question needs a type, the question text, an answer, and a subject and chapter that exist under Taxonomy. Names are matched ignoring case and punctuation. Nothing is saved until you review it.</p>
      <pre class="panel small scroll-x"><code id="ex">${example}</code></pre>
      <div class="row"><button type="button" class="btn-sm" id="cp-ex">Copy example</button><button type="button" class="btn-sm" id="cp-ai">Copy instructions for another AI</button></div></div></details>
  </form>`.toString();

  const sub = host.querySelector('#d-s');
  const chap = host.querySelector('#d-c');
  sub.addEventListener('change', () => {
    const s = tax.tree.find((x) => x.id === Number(sub.value));
    chap.innerHTML = html`<option value="">None</option>${(s?.chapters ?? []).map((c) => html`<option value="${c.id}">${c.name}</option>`)}`.toString();
  });
  host.querySelector('#jfile').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (f) host.querySelector('#json').value = await f.text();
  });
  host.querySelector('#cp-ex').addEventListener('click', async () => toast((await copyText(example)) ? 'Example copied' : 'Could not copy', 'ok'));
  host.querySelector('#cp-ai').addEventListener('click', async () => toast((await copyText(aiInstructions(tax))) ? 'Instructions copied. Paste them into the other AI along with your image.' : 'Could not copy', 'ok'));

  host.querySelector('#jf').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = host.querySelector('#json').value;
    const exam = Number(host.querySelector('#d-e').value);
    const result = importQuestions(text, {
      taxonomy: tax.index,
      defaults: { subject_id: Number(sub.value) || null, chapter_id: Number(chap.value) || null },
      defaultExams: exam ? [{ exam_id: exam, year: Number(host.querySelector('#d-y').value) || null, paper: host.querySelector('#d-p').value.trim() || null }] : [],
    });
    const err = host.querySelector('#j-err');
    if (result.fatal) {
      const at = result.fatal.line ? ` (line ${result.fatal.line}, column ${result.fatal.column})` : '';
      err.innerHTML = html`<div class="notice bad" role="alert"><b>${result.fatal.message}${at}</b><p class="small">Nothing was imported. Fix the JSON and check again.</p></div>`.toString();
      return;
    }
    setDrafts(result, 'import');
    navigate('/admin/review');
  });
}
