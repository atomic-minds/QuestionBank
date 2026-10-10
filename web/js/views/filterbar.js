// The filter bar shown above question lists (public pages and the admin list).
// Dropdown menus across the top; nothing is listed until at least one is chosen.
//
// A field is { key, label, all, opts: [{value, label, count?}], more?, input?, placeholder?, disabledHint? }
//   - `opts` makes a dropdown; `input: 'text' | 'number'` makes a small box instead (admin Marks / Tag)
//   - `more: true` puts it under "More filters"
import { html } from '../dom.js';

function control(f, value) {
  const id = `fb-${f.key}`;
  if (f.input) {
    return html`<input id="${id}" name="${f.key}" type="${f.input}" value="${value ?? ''}" placeholder="${f.placeholder ?? ''}" ${f.input === 'number' ? 'step=any min=0 inputmode=decimal' : 'maxlength=40 autocomplete=off'}>`;
  }
  const opts = f.opts ?? [];
  const known = !value || opts.some((o) => o.value === value);
  if (!opts.length) return html`<select id="${id}" name="${f.key}" disabled><option value="">${f.disabledHint ?? 'None yet'}</option></select>`;
  return html`<select id="${id}" name="${f.key}"><option value="">${f.all}</option>
    ${known ? '' : html`<option value="${value}" selected>${value}</option>`}
    ${opts.map((o) => html`<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}${o.count === undefined ? '' : ` (${o.count})`}</option>`)}</select>`;
}

const field = (f, values) => html`<div class="fld"><label for="fb-${f.key}">${f.label}</label>${control(f, values[f.key])}</div>`;

/**
 * @param {{fields: object[], values: Record<string,string>, searchPlaceholder?: string, id?: string}} o
 * @returns the form markup (html``)
 */
export function filterBar({ fields, values, searchPlaceholder = 'Search text or ID', id = 'fbar' }) {
  const main = fields.filter((f) => !f.more);
  const more = fields.filter((f) => f.more);
  const moreOpen = more.some((f) => values[f.key]);
  const any = Object.values(values).some(Boolean);
  return html`<form class="fbar" id="${id}" role="search" aria-label="Filters" autocomplete="off">
    <div class="fbar-search"><label class="sr" for="fb-q">Search</label>
      <input id="fb-q" type="search" name="q" value="${values.q ?? ''}" placeholder="${searchPlaceholder}">
      <button class="btn-primary" type="submit">Search</button></div>
    <div class="fbar-grid">${main.map((f) => field(f, values))}</div>
    ${more.length ? html`<details class="fbar-more" ${moreOpen ? 'open' : ''}><summary>More filters</summary><div class="fbar-grid">${more.map((f) => field(f, values))}</div></details>` : ''}
    <div class="fbar-foot">${any ? html`<button type="button" data-clear>Clear all filters</button>` : html`<span class="muted small">Pick any dropdown to see questions.</span>`}</div>
  </form>`;
}

/** Wire the bar. `onChange(changedKey, values)` runs when a dropdown changes, a box is filled in or Search is pressed. */
export function bindFilterBar(root, onChange) {
  const form = root.querySelector('.fbar');
  if (!form) return;
  const read = () => {
    const out = {};
    for (const [k, v] of new FormData(form)) { const t = String(v).trim(); if (t) out[k] = t; }
    return out;
  };
  form.addEventListener('change', (e) => { const t = e.target; if (t instanceof HTMLElement && t.getAttribute('name') && t.getAttribute('name') !== 'q') onChange(t.getAttribute('name'), read()); });
  form.addEventListener('submit', (e) => { e.preventDefault(); onChange('q', read()); });
  form.querySelector('[data-clear]')?.addEventListener('click', () => onChange(null, {}));
}
