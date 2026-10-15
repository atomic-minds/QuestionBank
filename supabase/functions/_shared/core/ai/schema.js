// The only shape the AI is allowed to answer in. It is sent as a response schema (so the model is
// constrained while generating) AND re-checked in adapt.js (so a misbehaving model cannot get
// anything through). Uses the OpenAPI-style subset Gemini supports (uppercase type names).
import { LIMITS, TYPE_CODES } from '../constants.js';

export const AI_MAX_QUESTIONS = 10;

const str = (description, nullable = false) => ({ type: 'STRING', description, ...(nullable ? { nullable: true } : {}) });
const strList = (description) => ({ type: 'ARRAY', nullable: true, description, items: { type: 'STRING' } });

export const AI_QUESTION_PROPERTIES = {
  type: { type: 'STRING', enum: TYPE_CODES, description: 'Question type code.' },
  question: str('The question text, transcribed faithfully.'),
  context: str('Passage / case / data the question depends on, if any.', true),
  options: strList('Answer options as plain text WITHOUT the A./(a)/1. labels. Empty for non-choice types.'),
  match_left: strList('List I items for match_following, in printed order, without labels.'),
  match_right: strList('List II items for match_following, in printed order, without labels.'),
  answer: str('ALWAYS give it. Choice types: the option letter (A, B, ...). Numerical: the final number then the unit only. Match: pairs like "A-2, B-1". Short/long/fill-blank: the model answer (one point per line starting with "- " for short/long). null only if it truly cannot be answered from the image.', true),
  answer_source: { type: 'STRING', enum: ['extracted', 'inferred', 'none'], description: 'extracted = the answer is printed in the image; inferred = you solved it yourself; none = impossible to answer (missing data/figure).' },
  explanation: str('Give it for every type except short and long answers. Numerical: the worked solution with the lines Given / To find / Concept / formula / Steps / Answer. Short and long answers: null (the answer already is the full explanation). Other types: a short reason. Use LaTeX between $ signs for real maths.', true),
  explanation_source: { type: 'STRING', enum: ['extracted', 'generated', 'none'], description: 'extracted = printed in the image; generated = you wrote it; none = no explanation.' },
  subject_id: { type: 'INTEGER', nullable: true, description: 'Subject id from the provided list, or null.' },
  chapter_id: { type: 'INTEGER', nullable: true, description: 'Chapter id from the provided list, or null.' },
  topic_id: { type: 'INTEGER', nullable: true, description: 'Topic id from the provided list, or null.' },
  difficulty: { type: 'STRING', enum: ['easy', 'medium', 'hard', 'unknown'], description: 'Your estimate of difficulty.' },
  marks: { type: 'NUMBER', nullable: true, description: 'Marks, only if printed in the image.' },
  tags: { type: 'ARRAY', description: 'Up to 5 short lowercase tags.', items: { type: 'STRING' } },
  exams: {
    type: 'ARRAY',
    description: 'Exam appearances, only if the image states them (e.g. "JEE Main 2019").',
    items: {
      type: 'OBJECT',
      properties: {
        exam_id: { type: 'INTEGER', description: 'Exam id from the provided list.' },
        year: { type: 'INTEGER', nullable: true },
        paper: str('Paper / shift / set, if printed.', true),
      },
      required: ['exam_id'],
    },
  },
  has_figure: { type: 'BOOLEAN', description: 'true if the question depends on a drawn figure, structure, graph, apparatus or table-image that cannot be written out as text.' },
  notes: str('Anything the reviewer should know (blurry text, missing figure, uncertain answer). null if nothing.', true),
};

export const AI_QUESTION_KEYS = Object.keys(AI_QUESTION_PROPERTIES);

export function buildResponseSchema() {
  return {
    type: 'OBJECT',
    properties: {
      image_issues: str('Problems with the image as a whole (cropped, unreadable parts), or null.', true),
      questions: {
        type: 'ARRAY',
        maxItems: AI_MAX_QUESTIONS,
        items: {
          type: 'OBJECT',
          properties: AI_QUESTION_PROPERTIES,
          required: ['type', 'question', 'answer_source', 'explanation_source', 'difficulty', 'tags', 'exams'],
          propertyOrdering: AI_QUESTION_KEYS,
        },
      },
    },
    required: ['questions'],
  };
}

export const AI_LIMITS = Object.freeze({ maxQuestions: AI_MAX_QUESTIONS, questionChars: LIMITS.questionText });

// ---- "Solve with AI": text in, answers out -------------------------------------------------------------------
export const SOLVE_MAX_ITEMS = 5;
export const SOLVE_PROPERTIES = {
  key: str('The key of the question being solved, copied exactly.'),
  answer: str('The answer in the format for the question type (option letter, number then unit, "A-2, B-1", or the model answer text). null only if it cannot be solved.', true),
  explanation: str('The worked solution / reason, as described in the rules. null for short and long answers (the answer is the explanation), and null if the answer is null.', true),
  confident: { type: 'BOOLEAN', description: 'true only if you are sure of the final answer after checking.' },
  notes: str('Anything the teacher should check, or why it could not be solved. null if nothing.', true),
};
export const SOLVE_KEYS = Object.keys(SOLVE_PROPERTIES);

export function buildSolveSchema() {
  return {
    type: 'OBJECT',
    properties: {
      solutions: {
        type: 'ARRAY',
        maxItems: SOLVE_MAX_ITEMS,
        items: { type: 'OBJECT', properties: SOLVE_PROPERTIES, required: ['key', 'confident'], propertyOrdering: SOLVE_KEYS },
      },
    },
    required: ['solutions'],
  };
}
