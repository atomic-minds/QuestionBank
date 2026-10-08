// Drafts waiting for review. Kept in sessionStorage so a refresh does not lose work (and does not
// waste a precious AI image read). Images are never kept — only the extracted text.
const KEY = 'qb.drafts';
let current = null;

const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch { return null; } };
const save = () => { try { current ? sessionStorage.setItem(KEY, JSON.stringify(current)) : sessionStorage.removeItem(KEY); } catch { /* storage full or blocked */ } };

export function getDrafts() { if (current === null) current = load(); return current; }
export function persistDrafts() { save(); }
export function clearDrafts() { current = null; save(); }

/** @param {'import'|'ai'|'restore'} mode */
export function setDrafts(result, mode) {
  current = {
    mode, notes: result.notes ?? [], missing: result.missing ?? null,
    items: result.items.map((it, i) => ({
      key: `${Date.now()}-${i}`, draft: it.draft, errors: it.errors, warnings: it.warnings, meta: it.meta ?? null,
      unresolved: it.unresolved ?? {}, ok: it.ok, selected: it.ok, dup: [], saved: null, saveError: null, confirmNear: false,
    })),
  };
  save();
  return current;
}
