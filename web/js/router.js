// A small history-API router. Each view is an async function that fills #app.
const routes = [];
let current = 0;

export function route(pattern, view) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/\/:(\w+)\*/g, (_, k) => { keys.push(k); return '(?:/(.*))?'; }).replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}/?$`);
  routes.push({ re, keys, view });
}

export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  return render();
}

/** Same-origin links navigate without a page load. */
export function interceptLinks() {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
    if (!a || a.target || a.hasAttribute('download') || a.dataset.native !== undefined) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin) return;
    e.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
  addEventListener('popstate', () => render());
}

/** Query string helpers that keep URLs shareable. */
export const query = () => Object.fromEntries(new URLSearchParams(location.search));
export function withQuery(base, params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export async function render() {
  const token = ++current;
  const path = location.pathname.replace(/\/+$/, '') || '/';
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    let params;
    try { params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1] === undefined ? undefined : decodeURIComponent(m[i + 1])])); } catch { break; }   // a malformed %-escape is "not found", not a crash
    await r.view({ params, query: query(), path, stale: () => token !== current });
    return;
  }
  const notFound = routes.find((r) => r.notFound);
  if (notFound) await notFound.view({ params: {}, query: {}, path, stale: () => token !== current });
}
export function notFound(view) { routes.push({ re: /$^/, keys: [], view, notFound: true }); }
