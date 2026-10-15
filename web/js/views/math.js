// Draws LaTeX ($...$, $$...$$, \ce{...}) with KaTeX. The library files live in /vendor/katex on this same site
// (nothing comes from another website, so the security rules stay strict and it works offline once visited).
// It is loaded only when a page actually contains a formula.
let loading = null;
let timer = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = false;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.append(s);
  });
}

function loadKatex() {
  if (window.katex) return Promise.resolve(window.katex);
  if (loading) return loading;
  loading = (async () => {
    if (!document.querySelector('link[data-katex]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = '/vendor/katex/katex.min.css'; l.dataset.katex = '1';
      document.head.append(l);
    }
    await loadScript('/vendor/katex/katex.min.js');
    await loadScript('/vendor/katex/mhchem.min.js');         // \ce{H2SO4}, \ce{A -> B}
    return window.katex;
  })().catch((e) => { loading = null; throw e; });
  return loading;
}

/** Draw every formula under `root` that has not been drawn yet. Resolves when they are all done (or could not be). */
export async function hydrateMath(root = document) {
  const els = [...root.querySelectorAll('.math[data-tex]:not([data-done])')];
  if (!els.length) return;
  let katex;
  try { katex = await loadKatex(); } catch { return; }          // the readable $...$ text simply stays
  for (const el of els) {
    if (el.dataset.done) continue;
    el.dataset.done = '1';
    try {
      katex.render(el.dataset.tex, el, {
        displayMode: el.dataset.display === '1', throwOnError: false, errorColor: '#cc2f2f', strict: 'ignore', trust: false, maxExpand: 1000,
      });
    } catch { el.textContent = el.dataset.display === '1' ? `$$${el.dataset.tex}$$` : `$${el.dataset.tex}$`; }
  }
}

/** Watches the page: whenever new text with formulas appears, draw them. */
export function watchMath(root) {
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => hydrateMath(root), 40); }).observe(root, { childList: true, subtree: true });
  hydrateMath(root);
}
