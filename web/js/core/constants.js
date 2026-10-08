// Shared constants. Runs unchanged in the browser, Deno (Supabase Edge Functions) and Node.
// The question-type table mirrors supabase/migrations/0004_reference_data.sql; a test
// (tests/core/parity.test.js) fails if the two ever drift apart.

/**
 * @typedef {'choice'|'text'|'numeric'|'match'|'any'} AnswerKind
 * @typedef {{label:string, kind:AnswerKind, minOptions:number, maxOptions:number, requiresContext:boolean, sortOrder:number}} QuestionTypeDef
 */

/** @type {Readonly<Record<string, QuestionTypeDef>>} */
export const QUESTION_TYPES = Object.freeze({
  mcq:              { label: 'MCQ',                 kind: 'choice',  minOptions: 2, maxOptions: 6, requiresContext: false, sortOrder: 10 },
  true_false:       { label: 'True/False',          kind: 'choice',  minOptions: 2, maxOptions: 2, requiresContext: false, sortOrder: 20 },
  assertion_reason: { label: 'Assertion-Reason',    kind: 'choice',  minOptions: 4, maxOptions: 4, requiresContext: false, sortOrder: 30 },
  numerical:        { label: 'Numerical',           kind: 'numeric', minOptions: 0, maxOptions: 0, requiresContext: false, sortOrder: 40 },
  short_answer:     { label: 'Short Answer',        kind: 'text',    minOptions: 0, maxOptions: 0, requiresContext: false, sortOrder: 50 },
  long_answer:      { label: 'Long Answer',         kind: 'text',    minOptions: 0, maxOptions: 0, requiresContext: false, sortOrder: 60 },
  fill_blank:       { label: 'Fill in the Blank',   kind: 'text',    minOptions: 0, maxOptions: 0, requiresContext: false, sortOrder: 70 },
  case_based:       { label: 'Case Based',          kind: 'any',     minOptions: 0, maxOptions: 6, requiresContext: true,  sortOrder: 80 },
  match_following:  { label: 'Match the Following', kind: 'match',   minOptions: 0, maxOptions: 0, requiresContext: false, sortOrder: 90 },
});

export const TYPE_CODES = Object.freeze(Object.keys(QUESTION_TYPES));

/** Human spellings that must all collapse to one controlled type code. */
export const TYPE_ALIASES = Object.freeze({
  mcq: ['mcq', 'mcqs', 'multiple choice', 'multiple choice question', 'multiple choice questions', 'single correct',
        'single choice', 'objective', 'one correct'],
  true_false: ['true false', 'true or false', 'true false question', 't f', 'tf', 'true/false'],
  assertion_reason: ['assertion reason', 'assertion and reason', 'assertion reason type', 'a r', 'ar', 'assertion reasoning'],
  numerical: ['numerical', 'numeric', 'numerical value', 'numerical type', 'integer type', 'integer', 'nvt'],
  short_answer: ['short answer', 'short answer type', 'short', 'sa', 'very short answer', 'vsa', 'one word'],
  long_answer: ['long answer', 'long answer type', 'long', 'la', 'essay', 'descriptive', 'theory'],
  fill_blank: ['fill in the blank', 'fill in the blanks', 'fill blank', 'fill blanks', 'fill ups', 'fill up', 'cloze', 'blank'],
  case_based: ['case based', 'case study', 'case based question', 'passage', 'passage based', 'comprehension', 'source based'],
  match_following: ['match the following', 'match following', 'matching', 'match', 'column matching', 'match the columns',
                    'match list'],
});

export const DIFFICULTIES = Object.freeze(['easy', 'medium', 'hard']);
export const DIFFICULTY_ALIASES = Object.freeze({
  easy: ['easy', 'simple', 'low', 'basic', 'beginner'],
  medium: ['medium', 'moderate', 'average', 'med', 'intermediate'],
  hard: ['hard', 'difficult', 'tough', 'high', 'advanced'],
});

/** draft -> review -> published -> archived */
export const STATUSES = Object.freeze(['draft', 'review', 'published', 'archived']);
export const ORIGINS = Object.freeze(['manual', 'ai_image', 'json_import']);

export const OPTION_LETTERS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F']);

export const LIMITS = Object.freeze({
  questionText: 5000,
  context: 10000,
  explanation: 10000,
  optionText: 1000,
  matchItemText: 500,
  textAnswer: 10000,
  sourceRef: 300,
  paper: 80,
  tagLength: 40,
  maxTags: 12,
  maxExamsPerQuestion: 10,
  yearMin: 1950,
  yearMax: 2100,
  marksMax: 100,
  matchItemsMin: 2,
  matchItemsMax: 10,
  importItemsMax: 100,     // per JSON paste / per image
  saveItemsMax: 50,        // per save-questions request
  imageBytesMax: 3 * 1024 * 1024,
  importBytesMax: 1024 * 1024,        // pasted JSON / import file
  restoreItemsMax: 1000,              // a full-backup file restored through the review screen
  restoreBytesMax: 4 * 1024 * 1024,
});

export const ALLOWED_IMAGE_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);

export const PUBLIC_ID_PATTERN = /^QB-[A-Z][A-Z0-9]{1,7}-[0-9]{6,9}$/;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Standard four options of an Assertion-Reason question (used when a source omits them). */
export const ASSERTION_REASON_OPTIONS = Object.freeze([
  'Both Assertion (A) and Reason (R) are true, and Reason (R) is the correct explanation of Assertion (A).',
  'Both Assertion (A) and Reason (R) are true, but Reason (R) is not the correct explanation of Assertion (A).',
  'Assertion (A) is true, but Reason (R) is false.',
  'Assertion (A) is false, but Reason (R) is true.',
]);

export const EXPORT_FORMATS = Object.freeze({
  atomicMinds: { format: 'atomic-minds-question-bank', version: 1 },
  backup:      { format: 'qb-backup', version: 1 },
  import:      { format: 'qb-import', version: 1 },
});
