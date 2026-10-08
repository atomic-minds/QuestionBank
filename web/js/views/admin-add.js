// Add questions: from an image (AI), from pasted JSON, or by hand.
import { html, copyText, toast } from '../dom.js';
import { navigate } from '../router.js';
import * as api from '../api.js';
import { importQuestions } from '../core/importer.js';
import { LIMITS } from '../core/constants.js';
import { AI_MAX_QUESTIONS } from '../core/ai/schema.js';
import { setTitle } from './public.js';
import { setDrafts } from './drafts.js';
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

function imageTab(host, tax) {
  host.innerHTML = html`<div class="panel stack">
    <div class="dropzone" id="drop"><p><b>Photo or screenshot of the question(s)</b></p>
      <p class="muted small">JPEG, PNG or WebP. Up to ${AI_MAX_QUESTIONS} questions per image. The image is shrunk on your device and is not stored.</p>
      <input type="file" id="file" accept="image/jpeg,image/png,image/webp" aria-label="Choose an image"><div id="pv"></div></div>
    <div class="grid2"><div class="field"><label for="hint-s">Subject <span class="muted">(helps the AI file it)</span></label>
      <select id="hint-s"><option value="">Let the AI decide</option>${tax.tree.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></div>
      <div class="field"><label for="note">Note for the AI <span class="muted">(optional)</span></label><input id="note" type="text" maxlength="300" placeholder="e.g. answers are printed at the bottom"></div></div>
    <div id="x-err"></div>
    <div class="row"><button class="btn-primary" id="go" disabled>Read the questions</button><span class="muted small" id="busy"></span></div>
    <div class="notice small"><b>Privacy:</b> the image is sent to Google's Gemini service. On Google's free tier, Google may use what you send to improve its products and a person may review it. For private material use <a href="/admin/add?tab=json">Paste JSON</a> instead.</div>
  </div>`.toString();

  let blob = null;
  const file = host.querySelector('#file');
  const go = host.querySelector('#go');
  const pick = async (f) => {
    if (!f) return;
    try {
      blob = await prepareImage(f);
      host.querySelector('#pv').innerHTML = html`<img class="preview" alt="Preview of the chosen image" src="${URL.createObjectURL(blob)}"><p class="hint">${Math.round(blob.size / 1024)} KB after shrinking</p>`.toString();
      go.disabled = false;
      host.querySelector('#x-err').innerHTML = '';
    } catch (e) { blob = null; go.disabled = true; host.querySelector('#x-err').innerHTML = html`<div class="notice bad" role="alert">${e.message}</div>`.toString(); }
  };
  file.addEventListener('change', () => pick(file.files[0]));
  const drop = host.querySelector('#drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  go.addEventListener('click', async () => {
    go.disabled = true; host.querySelector('#busy').textContent = 'Reading the image… this can take up to a minute.';
    host.querySelector('#x-err').innerHTML = '';
    try {
      const r = await api.extractFromImage(blob, { subjectId: Number(host.querySelector('#hint-s').value) || null, note: host.querySelector('#note').value });
      setDrafts(r, 'ai');
      toast(`${r.summary.total} question${r.summary.total === 1 ? '' : 's'} read. Please review them.`, 'ok');
      navigate('/admin/review');
    } catch (e) {
      const fallback = ['AI_DAILY_LIMIT', 'AI_QUOTA_EXHAUSTED', 'AI_NOT_CONFIGURED', 'AI_UNAVAILABLE', 'AI_TIMEOUT', 'AI_BLOCKED', 'AI_BAD_OUTPUT'].includes(e.code);
      host.querySelector('#x-err').innerHTML = html`<div class="notice bad" role="alert"><b>${e.message}</b>
        ${fallback ? html`<p class="small">You can try again, or use <a href="/admin/add?tab=json">Paste JSON</a> (you can get the JSON from any AI tool, or write it yourself).</p>` : ''}</div>`.toString();
      go.disabled = false; host.querySelector('#busy').textContent = '';
    }
  });
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
