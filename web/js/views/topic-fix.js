// Review screen helpers for topics that a file or a scan names but the Taxonomy does not have yet.
//
// Plain functions, no browser needed, so they are covered by the node tests.
// Rule (same as the importer): a name matches an existing topic only when it is the SAME name after
// ignoring capitals, spaces and punctuation. Nothing is guessed. Creating a topic is a separate,
// explicit step that the admin starts with a button.
import { matchKey } from '../core/text.js';

const MAX_NAME = 120;                                    // the database limit for a topic name
const tidy = (v) => String(v ?? '').trim().replace(/\s+/g, ' ');

/** The topic this draft asked for but did not get, with the chapter it belongs to. Otherwise null. */
function wanted(it, index) {
  if (it.saved || !it.draft || it.draft.topic_id) return null;
  const given = tidy(it.unresolved?.topic?.given);
  if (!given || !matchKey(given) || given.length > MAX_NAME) return null;
  const chapter = index.chapterById.get(it.draft.chapter_id);
  if (!chapter) return null;
  return { given, chapter, key: `${chapter.id}|${matchKey(given)}` };
}

const sameName = (chapter, given) => chapter.topics.filter((t) => matchKey(t.name) === matchKey(given));

/** Put the topic into every draft that asked for `ids.get(key)`, and drop the "no topic was set" notes. */
function applyIds(items, index, ids) {
  let n = 0;
  for (const it of items) {
    const w = wanted(it, index);
    const id = w ? ids.get(w.key) : undefined;
    if (!id) continue;
    it.draft = { ...it.draft, topic_id: id };
    it.warnings = (it.warnings ?? []).filter((x) => x.path !== 'topic_id');
    if (it.unresolved) delete it.unresolved.topic;
    n += 1;
  }
  return n;
}

/**
 * Topics that exist already under the right chapter, but were not found when the file was read
 * (for example they were added in the Taxonomy after the import). Link them. Returns how many drafts changed.
 */
export function linkKnownTopics(items, index) {
  const found = new Map();
  for (const it of items) {
    const w = wanted(it, index);
    if (!w) continue;
    const hits = sameName(w.chapter, w.given);
    if (hits.length === 1) found.set(w.key, hits[0].id);
  }
  return found.size ? applyIds(items, index, found) : 0;
}

/**
 * The topics that would be created: one entry per chapter + name, best spelling first seen.
 * @returns {{key:string, chapter_id:number, chapter:string, name:string, count:number}[]}
 */
export function pendingTopics(items, index) {
  const groups = new Map();
  for (const it of items) {
    const w = wanted(it, index);
    if (!w || sameName(w.chapter, w.given).length) continue;   // already there (or ambiguous): never add a third
    const g = groups.get(w.key) ?? { key: w.key, chapter_id: w.chapter.id, chapter: w.chapter.name, name: w.given, count: 0 };
    g.count += 1;
    groups.set(w.key, g);
  }
  return [...groups.values()];
}

/** After topics were created: attach them to the drafts that asked for them. @param {Map<string, number>} ids key -> topic id */
export function attachCreated(items, index, ids) {
  return applyIds(items, index, ids);
}

/** If the chapter of a draft was changed by hand, the topic name that was read from the file no longer applies. */
export function forgetTopicIfChapterChanged(it, chapterBefore) {
  if (it.draft && it.draft.chapter_id !== chapterBefore && it.unresolved) delete it.unresolved.topic;
}
