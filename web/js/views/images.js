// Shows each question's picture (if it has one) under the question text. Pictures are fetched in one
// request per page of questions, after the questions are already on screen, so lists stay fast.
import * as api from '../api.js';
import { figureUrl } from './image-tools.js';

let timer = null;

export async function hydrateImages(root = document) {
  const arts = [...root.querySelectorAll('article.q[data-qid]:not([data-img])')].filter((a) => a.dataset.qid);
  if (!arts.length) return;
  arts.forEach((a) => { a.dataset.img = 'wait'; });
  let found = {};
  try { found = await api.getImages(arts.map((a) => a.dataset.qid)); } catch { arts.forEach((a) => { delete a.dataset.img; }); return; }
  for (const a of arts) {
    const img = found[a.dataset.qid];
    a.dataset.img = img ? 'yes' : 'no';
    if (!img || a.querySelector('.q-fig')) continue;
    const fig = document.createElement('figure');
    fig.className = 'q-fig';
    const el = document.createElement('img');
    el.src = figureUrl(img);
    el.alt = `Figure for question ${a.dataset.pid ?? ''}`.trim();
    el.decoding = 'async';
    fig.append(el);
    const anchor = a.querySelector('.q-text');
    if (anchor) anchor.after(fig); else a.prepend(fig);
  }
}

/** Watches the page: whenever new question cards appear, load their pictures. */
export function watchImages(root) {
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => hydrateImages(root), 60); }).observe(root, { childList: true, subtree: true });
}
