// Small, dependency-free text helpers shared by the browser, Edge Functions and tests.
import { DIFFICULTY_ALIASES, OPTION_LETTERS, TYPE_ALIASES, TYPE_CODES, LIMITS } from './constants.js';

/** Trim, unify newlines, collapse 3+ blank lines, NFC. Empty -> null. */
export function cleanText(value) {
  if (value === null || value === undefined) return null;
  const s = String(value)
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')   // control characters (keep \t \n)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s === '' ? null : s;
}

/** Key used to compare names across spellings: "Alcohols, Phenols & Ethers" ~ "alcohols phenols and ethers". */
export function matchKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Case-PRESERVING comparison key, mirroring the database's qb_norm(): "Co" (cobalt) and "CO"
 * (carbon monoxide) stay different, while spacing, curly quotes and trailing punctuation are ignored.
 */
export function exactKey(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\s?.:;!,]+$/, '');
}

/** Dice coefficient on character bigrams, 0..1. Used only to SUGGEST names, never to auto-assign. */
export function similarity(a, b) {
  const x = matchKey(a);
  const y = matchKey(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const gx = grams(x);
  const gy = grams(y);
  let overlap = 0;
  for (const [g, n] of gx) overlap += Math.min(n, gy.get(g) ?? 0);
  const total = Math.max(x.length - 1, 0) + Math.max(y.length - 1, 0);
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const aliasToType = new Map();
for (const [code, aliases] of Object.entries(TYPE_ALIASES)) {
  aliasToType.set(code.replace(/_/g, ' '), code);
  for (const a of aliases) aliasToType.set(matchKey(a), code);
}

/** "Multiple Choice", "mcq", "MCQ " ... -> "mcq". Returns null when not recognised. */
export function resolveTypeCode(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (TYPE_CODES.includes(raw)) return raw;
  return aliasToType.get(matchKey(raw.replace(/[_/-]+/g, ' '))) ?? null;
}

const aliasToDifficulty = new Map();
for (const [code, aliases] of Object.entries(DIFFICULTY_ALIASES)) for (const a of aliases) aliasToDifficulty.set(a, code);

export function resolveDifficulty(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  return aliasToDifficulty.get(matchKey(value)) ?? undefined;     // undefined = unrecognised
}

/** Lower-case kebab tags, de-duplicated, empty ones dropped. */
export function normalizeTags(value) {
  let list = value;
  if (typeof value === 'string') list = value.split(/[,;\n]/);
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const t of list) {
    const tag = String(t ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9+.\-]/g, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, LIMITS.tagLength);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

const LABEL_RE = /^\s*(?:\(([A-Ja-j]|10|[1-9])\)|([A-Ja-j]|10|[1-9])[.):])\s+/;
const LABEL_TIGHT_RE = /^\s*\(([A-Ja-j]|10|[1-9])\)\s*/;

/**
 * The labels ("A", "B", "1", "2"...) at the start of every text, when EVERY text carries a label
 * and the labels run in order. Otherwise null (the texts are treated as plain text).
 */
export function leadingLabels(texts) {
  const list = texts.map((t) => String(t ?? ''));
  if (list.length < 2) return null;
  const labels = [];
  for (const t of list) {
    const m = t.match(LABEL_TIGHT_RE) ?? t.match(LABEL_RE);
    if (!m) return null;
    labels.push((m[1] ?? m[2]).toUpperCase());
  }
  const letters = labels.every((l, i) => l === String.fromCharCode(65 + i));
  const digits = labels.every((l, i) => l === String(i + 1));
  return letters || digits ? labels : null;
}

/**
 * Remove "A.", "(B)", "c)" or "(1)" labels from option texts, but only when EVERY option
 * carries a label and the labels run in order. Anything less is treated as real text, so an
 * option like "A. Smith" next to unlabelled ones is left alone.
 */
export function stripOptionLabels(texts) {
  const list = texts.map((t) => String(t ?? ''));
  if (!leadingLabels(list)) return list;
  return list.map((t) => t.replace(LABEL_TIGHT_RE, '').replace(LABEL_RE, '').trim());
}

/** Pull a single option letter out of "B", "(b)", "B) 6", "Option C" ... -> "B" or null. */
export function parseOptionLetter(value) {
  const s = String(value ?? '').trim();
  const m = s.match(/^(?:option\s+|ans(?:wer)?[:\s]+)?\(?([A-Fa-f])\)?(?:[.):]|\s|$)/i);
  return m ? m[1].toUpperCase() : null;
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isInt(v) {
  return typeof v === 'number' && Number.isInteger(v);
}
