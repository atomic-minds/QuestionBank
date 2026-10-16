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

/**
 * A long formula that cannot break (a cell diagram like  Sn(s) | Sn2+ || H+ | H2(g) | Pt(s)  has no operator to break at)
 * would push the whole page wider than a phone. Such a formula becomes its own scrollable line instead.
 * Short formulas stay in the sentence.
 */
function fitWide(root) {
  const marks = [...root.querySelectorAll('.math[data-done]:not(.math-block)')];
  for (const el of marks) el.classList.remove('math-wide');           // measure each at its natural size
  for (const el of marks) {
    const box = el.closest('div, td, li, p, dd');
    if (box && box.clientWidth > 0 && el.getBoundingClientRect().width > box.clientWidth - 2) el.classList.add('math-wide');
  }
}
let fitTimer = null;
const scheduleFit = (root) => { clearTimeout(fitTimer); fitTimer = setTimeout(() => fitWide(root), 60); };
if (typeof window !== 'undefined') window.addEventListener('resize', () => scheduleFit(document));

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
  scheduleFit(root);
  if (document.fonts?.ready) document.fonts.ready.then(() => scheduleFit(root)).catch(() => {});
}

/** Watches the page: whenever new text with formulas appears, draw them. */
export function watchMath(root) {
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => hydrateMath(root), 40); }).observe(root, { childList: true, subtree: true });
  hydrateMath(root);
}
