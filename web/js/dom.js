// Tiny rendering helpers. Everything interpolated into html`` is escaped unless it is already
// "safe" (the result of another html`` call). This is the only way markup is built, so question text
// from the database can never become markup.
import { richHtml } from './core/chem.js';
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Safe(String(s ?? ''));
/** Question text with chemistry formatting (H₂SO₄, Fe³⁺, →). Escaped; only <sub>/<sup> are added. */
export const rich = (s) => new Safe(richHtml(s));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const part = (v) => {
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  if (v === null || v === undefined || v === false) return '';
  return esc(v);
};
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Safe(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated listener: on(root, 'click', '[data-action=x]', (event, matchedElement) => ...) */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const el = e.target instanceof Element ? e.target.closest(selector) : null;
    if (el && root.contains(el)) handler(e, el);
  });
}

export function toast(message, kind = '') {
  let box = $('.toasts');
  if (!box) { box = document.createElement('div'); box.className = 'toasts'; box.setAttribute('role', 'status'); document.body.append(box); }
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  box.append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 9000 : 4500);
}

/**
 * Yes/No pop-up. `body` may be text or html``. With `typeToConfirm: 'DELETE'` the red button stays
 * disabled until the person types that word, which is used for things that cannot be undone.
 */
export function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false, typeToConfirm = null }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = html`<form method="dialog"><h3>${title}</h3><div class="dlg-body">${typeof body === 'string' ? html`<p>${body}</p>` : body}</div>
      ${typeToConfirm ? html`<div class="field"><label for="cd-type">Type <b>${typeToConfirm}</b> to confirm</label><input id="cd-type" type="text" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>` : ''}
      <div class="row"><button class="btn-primary ${danger ? 'btn-danger' : ''}" value="ok" ${typeToConfirm ? 'disabled' : ''}>${confirmLabel}</button><button value="cancel" formnovalidate>Cancel</button></div></form>`.toString();
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok'); d.remove(); });
    document.body.append(d);
    if (typeToConfirm) {
      const input = d.querySelector('#cd-type'); const ok = d.querySelector('button[value=ok]');
      input.addEventListener('input', () => { ok.disabled = input.value.trim().toUpperCase() !== typeToConfirm.toUpperCase(); });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && ok.disabled) e.preventDefault(); });
    }
    d.showModal();
    if (typeToConfirm) d.querySelector('#cd-type').focus();
  });
}

export function download(filename, text, mime = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

/** Copy text; falls back for browsers that block the async clipboard. */
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  }
}

export function promptDialog({ title, label, value = '', confirmLabel = 'Save', maxLength = 120 }) {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = html`<form method="dialog"><h3>${title}</h3><div class="field"><label for="pd-in">${label}</label>
      <input id="pd-in" type="text" name="v" value="${value}" maxlength="${maxLength}" required></div>
      <div class="row"><button class="btn-primary" value="ok">${confirmLabel}</button><button value="cancel" formnovalidate>Cancel</button></div></form>`.toString();
    d.addEventListener('close', () => { resolve(d.returnValue === 'ok' ? d.querySelector('input').value.trim() : null); d.remove(); });
    document.body.append(d);
    d.showModal();
    d.querySelector('input').select();
  });
}
