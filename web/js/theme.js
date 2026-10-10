// Light / dark appearance. The choice is kept in this browser only (localStorage, wrapped in try/catch).
// No saved choice = follow the device setting. `theme-init.js` applies the saved choice before the page paints.
const KEY = 'qb.theme';
const COLORS = { light: '#f3f5f9', dark: '#090e14' };
const listeners = new Set();

export function getPref() {
  try { const v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch { return null; }
}
const systemDark = () => Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
/** What is on screen right now: 'light' or 'dark'. */
export const effective = () => getPref() ?? (systemDark() ? 'dark' : 'light');

function paintMeta(pref) {
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    if (m.dataset.media === undefined) m.dataset.media = m.getAttribute('media') ?? '';
    if (m.dataset.content === undefined) m.dataset.content = m.getAttribute('content') ?? '';
    if (pref) { m.removeAttribute('media'); m.setAttribute('content', COLORS[pref]); }
    else { if (m.dataset.media) m.setAttribute('media', m.dataset.media); m.setAttribute('content', m.dataset.content); }
  });
}

export function apply() {
  const pref = getPref();
  if (pref) document.documentElement.dataset.theme = pref; else delete document.documentElement.dataset.theme;
  paintMeta(pref);
  listeners.forEach((fn) => fn(effective(), pref));
}

/** @param {'light'|'dark'|null} value null = follow the device */
export function setPref(value) {
  try { if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY); } catch { /* private window: the choice lasts until the page closes */ }
  if (value) document.documentElement.dataset.theme = value; else delete document.documentElement.dataset.theme;
  paintMeta(value);
  listeners.forEach((fn) => fn(effective(), value));
}
export const toggle = () => setPref(effective() === 'dark' ? 'light' : 'dark');
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!getPref()) apply(); });
