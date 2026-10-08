// Subject > Chapter > Topic master data: indexing, name resolution and "did you mean" suggestions.
//
// Rule: a name is only turned into an id when it matches EXACTLY after normalisation
// (case, punctuation and "&" vs "and" are ignored). Near matches are offered as suggestions
// for a human to confirm; they are never assigned silently.
import { matchKey, similarity } from './text.js';

/**
 * @typedef {{id:number, name:string, slug?:string, topics:{id:number,name:string,slug?:string}[]}} ChapterNode
 * @typedef {{id:number, code?:string, name:string, slug?:string, chapters:ChapterNode[]}} SubjectNode
 * @typedef {{id:number, name:string, score:number, path?:string}} Suggestion
 */

const keysOf = (node) => {
  const set = new Set([matchKey(node.name)]);
  if (node.slug) set.add(matchKey(String(node.slug).replace(/-/g, ' ')));
  if (node.code) set.add(matchKey(node.code));
  set.delete('');
  return set;
};

/**
 * @param {SubjectNode[]} tree   shape returned by the qb_taxonomy_tree() RPC
 * @param {{id:number, code:string, name:string}[]} [exams]
 */
export function buildTaxonomyIndex(tree, exams = []) {
  const subjects = (tree ?? []).map((s) => ({ ...s, chapters: s.chapters ?? [], _keys: keysOf(s) }));
  for (const s of subjects) {
    s.chapters = s.chapters.map((c) => ({ ...c, topics: c.topics ?? [], _keys: keysOf(c), _subject: s }));
    for (const c of s.chapters) c.topics = c.topics.map((t) => ({ ...t, _keys: keysOf(t), _chapter: c }));
  }
  const examList = (exams ?? []).map((e) => ({ ...e, _keys: keysOf(e) }));
  return {
    tree: subjects,
    exams: examList,
    subjectById: new Map(subjects.map((s) => [s.id, s])),
    chapterById: new Map(subjects.flatMap((s) => s.chapters).map((c) => [c.id, c])),
    topicById: new Map(subjects.flatMap((s) => s.chapters).flatMap((c) => c.topics).map((t) => [t.id, t])),
    examById: new Map(examList.map((e) => [e.id, e])),
  };
}

const exact = (list, name) => {
  const k = matchKey(name);
  if (!k) return [];
  return list.filter((n) => n._keys.has(k));
};

/** Closest names to `given`, best first. Only candidates that look reasonably similar are offered. */
export function suggest(list, given, { limit = 3, min = 0.45, label = (n) => n.name } = {}) {
  const k = matchKey(given);
  if (!k) return [];
  return list
    .map((n) => {
      let score = Math.max(...[...n._keys].map((key) => similarity(k, key)), 0);
      const nk = matchKey(n.name);
      if (k.length >= 4 && (` ${nk} `.includes(` ${k} `) || ` ${k} `.includes(` ${nk} `))) score = Math.max(score, 0.7);
      return { id: n.id, name: label(n), score: Math.round(score * 100) / 100 };
    })
    .filter((s) => s.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

/**
 * Resolve classification names to ids.
 * @param {ReturnType<typeof buildTaxonomyIndex>} index
 * @param {{subject?:any, chapter?:any, topic?:any}} given     names as written in the source
 * @param {{subject_id?:number|null, chapter_id?:number|null, topic_id?:number|null}} [defaults]
 *        used ONLY for parts the source did not mention at all
 */
export function resolveClassification(index, given, defaults = {}) {
  const out = { subject_id: null, chapter_id: null, topic_id: null, errors: [], warnings: [], unresolved: {} };
  const err = (path, message) => out.errors.push({ path, message });
  const warn = (path, message) => out.warnings.push({ path, message });

  const subjectName = blank(given.subject) ? null : String(given.subject).trim();
  const chapterName = blank(given.chapter) ? null : String(given.chapter).trim();
  const topicName = blank(given.topic) ? null : String(given.topic).trim();

  // ---- subject -------------------------------------------------------------------
  let subject = null;
  if (subjectName) {
    const hits = exact(index.tree, subjectName);
    if (hits.length === 1) subject = hits[0];
    else {
      const suggestions = suggest(index.tree, subjectName);
      out.unresolved.subject = { given: subjectName, suggestions };
      err('subject_id', `Subject "${subjectName}" is not in your subject list.${hint(suggestions)}`);
    }
  } else if (defaults.subject_id) {
    subject = index.subjectById.get(defaults.subject_id) ?? null;
  }

  // ---- chapter -------------------------------------------------------------------
  let chapter = null;
  if (chapterName) {
    if (subject) {
      const hits = exact(subject.chapters, chapterName);
      if (hits.length === 1) chapter = hits[0];
      else {
        const suggestions = suggest(subject.chapters, chapterName);
        out.unresolved.chapter = { given: chapterName, suggestions };
        err('chapter_id', `Chapter "${chapterName}" is not in ${subject.name}.${hint(suggestions)}`);
      }
    } else if (subjectName) {
      out.unresolved.chapter = { given: chapterName, suggestions: [] };   // subject itself is unresolved
    } else {
      // No subject written anywhere: accept an exact chapter name only if it is unambiguous.
      const all = index.tree.flatMap((s) => s.chapters);
      const hits = exact(all, chapterName);
      if (hits.length === 1) {
        chapter = hits[0];
        subject = chapter._subject;
        warn('subject_id', `Subject was not given; "${subject.name}" was inferred from the chapter name.`);
      } else {
        const suggestions = suggest(all, chapterName, { label: (c) => `${c.name} (${c._subject.name})` });
        out.unresolved.chapter = { given: chapterName, suggestions };
        err('subject_id', hits.length > 1 ? `Chapter "${chapterName}" exists in several subjects; choose the subject.` : 'Choose a subject.');
        if (!hits.length) err('chapter_id', `Chapter "${chapterName}" was not found.${hint(suggestions)}`);
      }
    }
  } else if (defaults.chapter_id && !subjectName) {
    const c = index.chapterById.get(defaults.chapter_id);
    if (c && (!subject || c._subject.id === subject.id)) { chapter = c; subject = subject ?? c._subject; }
  }

  // ---- topic (optional) -------------------------------------------------------------
  let topic = null;
  if (topicName) {
    if (chapter) {
      const hits = exact(chapter.topics, topicName);
      if (hits.length === 1) topic = hits[0];
      else {
        const suggestions = suggest(chapter.topics, topicName);
        out.unresolved.topic = { given: topicName, suggestions };
        warn('topic_id', `Topic "${topicName}" is not in ${chapter.name}, so no topic was set.${hint(suggestions)}`);
      }
    } else {
      out.unresolved.topic = { given: topicName, suggestions: [] };
      warn('topic_id', `Topic "${topicName}" could not be placed because the chapter is unresolved.`);
    }
  } else if (defaults.topic_id && chapter && !chapterName) {
    const t = index.topicById.get(defaults.topic_id);
    if (t && t._chapter.id === chapter.id) topic = t;
  }

  if (!subject && !subjectName && !chapterName) err('subject_id', 'Choose a subject.');
  if (subject && !chapter && !chapterName) err('chapter_id', 'Choose a chapter.');

  out.subject_id = subject?.id ?? null;
  out.chapter_id = chapter?.id ?? null;
  out.topic_id = topic?.id ?? null;
  return out;
}

function hint(suggestions) {
  return suggestions.length ? ` Did you mean: ${suggestions.map((s) => `"${s.name}"`).join(', ')}?` : '';
}

/**
 * Resolve an exam reference ("CBSE", "JEE Main", an object, or "JEE Main 2019") to an exam id.
 * @returns {{exam_id:number|null, year:number|null, paper:string|null, errors:string[], suggestions:Suggestion[]}}
 */
export function resolveExamRef(index, ref) {
  const result = { exam_id: null, year: null, paper: null, errors: [], suggestions: [] };
  let name = null;
  let year = null;
  let paper = null;

  if (typeof ref === 'string') {
    // "JEE Main 2019" / "CBSE (2025)" -> name + trailing year
    const m = ref.trim().match(/^(.*?)[\s,(-]*((?:19|20|21)\d{2})\)?\s*$/);
    if (m && m[1].trim()) { name = m[1].trim(); year = Number(m[2]); } else name = ref.trim();
  } else if (ref && typeof ref === 'object') {
    name = ref.exam ?? ref.name ?? ref.code ?? ref.exam_name ?? null;
    if (!blank(ref.year)) year = Number(ref.year);
    if (!blank(ref.paper ?? ref.shift ?? ref.session)) paper = String(ref.paper ?? ref.shift ?? ref.session).trim();
    if (typeof name === 'object' && name !== null) name = name.name ?? name.code ?? null;
  }
  if (blank(name)) { result.errors.push('Name the exam.'); return result; }
  name = String(name).trim();

  const hits = exact(index.exams, name);
  if (hits.length === 1) result.exam_id = hits[0].id;
  else {
    result.suggestions = suggest(index.exams, name);
    result.errors.push(`Exam "${name}" is not in your exam list.${hint(result.suggestions)}`);
  }
  result.year = year;
  result.paper = paper;
  return result;
}
