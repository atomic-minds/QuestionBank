-- =============================================================================
-- 0004_reference_data.sql — the controlled vocabulary of question types.
-- Required for the application to function; this is configuration, not demo data.
-- =============================================================================
insert into public.question_types (code, label, kind, min_options, max_options, requires_context, sort_order) values
  ('mcq',              'MCQ',                 'choice',  2, 6, false, 10),
  ('true_false',       'True/False',          'choice',  2, 2, false, 20),
  ('assertion_reason', 'Assertion-Reason',    'choice',  4, 4, false, 30),
  ('numerical',        'Numerical',           'numeric', 0, 0, false, 40),
  ('short_answer',     'Short Answer',        'text',    0, 0, false, 50),
  ('long_answer',      'Long Answer',         'text',    0, 0, false, 60),
  ('fill_blank',       'Fill in the Blank',   'text',    0, 0, false, 70),
  ('case_based',       'Case Based',          'any',     0, 6, true,  80),
  ('match_following',  'Match the Following', 'match',   0, 0, false, 90)
on conflict (code) do nothing;
