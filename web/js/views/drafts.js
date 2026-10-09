// Drafts waiting for review. Kept in sessionStorage so a refresh does not lose work (and does not
// waste a precious AI image read). Images are never kept — only the extracted text.
const KEY = 'qb.drafts';
let current = null;

// Pictures and scanned photos are large, so they live only in memory (never in sessionStorage).
// A page refresh keeps the drafts' text but forgets these; that is the price of keeping storage small.
/** draft key -> {mime, data} picture chosen for that question */
export const figureStore = new Map();
/** photo id -> Blob of the shrunk scan, kept so a figure can be cropped out of it during review */
export const photoStore = new Map();

const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } };
const save = () => { try { current ? sessionStorage.setItem(KEY, JSON.stringify(current)) : sessionStorage.removeItem(KEY); } catch { /* storage full or blocked */ } };

export function getDrafts() { if (current === null) current = load(); return current; }
export function persistDrafts() { save(); }
export function clearDrafts() { current = null; figureStore.clear(); photoStore.clear(); save(); }

/** @param {'import'|'ai'|'restore'} mode */
export function setDrafts(result, mode) {
  current = {
    mode, notes: result.notes ?? [], missing: result.missing ?? null,
    items: result.items.map((it, i) => ({
      key: `${Date.now()}-${i}`, draft: it.draft, errors: it.errors, warnings: it.warnings, meta: it.meta ?? null,
      unresolved: it.unresolved ?? {}, ok: it.ok, selected: it.ok, dup: [], saved: null, saveError: null, confirmNear: false,
      photo: it.photo ?? null,
    })),
  };
  save();
  return current;
}
