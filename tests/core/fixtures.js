// Small, realistic master data used by the unit tests. (Tests only — the app reads the real tables.)
import { buildTaxonomyIndex } from '../../supabase/functions/_shared/core/taxonomy.js';

export const TREE = [
  {
    id: 1, code: 'CHEM', name: 'Chemistry', slug: 'chemistry', chapters: [
      { id: 10, name: 'Solid State', slug: 'solid-state', topics: [
        { id: 100, name: 'Crystal Structure', slug: 'crystal-structure' },
        { id: 101, name: 'Defects', slug: 'defects' },
      ] },
      { id: 11, name: 'Alcohols, Phenols and Ethers', slug: 'alcohols-phenols-and-ethers', topics: [] },
      { id: 12, name: 'Thermodynamics', slug: 'thermodynamics', topics: [] },
    ],
  },
  {
    id: 2, code: 'PHY', name: 'Physics', slug: 'physics', chapters: [
      { id: 20, name: 'Thermodynamics', slug: 'thermodynamics', topics: [] },
      { id: 21, name: 'Optics', slug: 'optics', topics: [] },
    ],
  },
];
export const EXAMS = [
  { id: 1, code: 'CBSE', name: 'CBSE' },
  { id: 2, code: 'JEE_MAIN', name: 'JEE Main' },
  { id: 3, code: 'NEET', name: 'NEET' },
];
export const index = () => buildTaxonomyIndex(TREE, EXAMS);

/** A question exactly as qb_search_questions() returns it. */
export const dbQuestion = (over = {}) => ({
  id: '123e4567-e89b-12d3-a456-426614174000', public_id: 'QB-CHEM-000241', type_code: 'mcq', context: null,
  question_text: 'What is the coordination number of NaCl?',
  options: [{ id: 'A', text: '4' }, { id: 'B', text: '6' }, { id: 'C', text: '8' }, { id: 'D', text: '12' }],
  match_items: null, answer: { value: 'B' }, explanation: 'In the NaCl crystal structure, each Na+ ion is surrounded by six Cl- ions.',
  difficulty: 'medium', marks: '1.00', tags: ['nacl'], subject_id: 1, chapter_id: 10, topic_id: 100, status: 'published',
  origin: 'manual', source_ref: null, version: 3, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  published_at: '2026-01-02T00:00:00Z', exams: [],
  ...over,
});
