-- =============================================================================
-- 0005_starter_taxonomy.sql — optional starter master data (no questions).
--
-- These are only convenient defaults so AI classification and the review form
-- have something to choose from on day one. Rename, add, deactivate or extend
-- everything from Admin -> Taxonomy. Safe to re-run (on conflict do nothing).
-- =============================================================================
insert into public.subjects (code, name, slug, sort_order) values
  ('CHEM', 'Chemistry',   'chemistry',   10),
  ('PHY',  'Physics',     'physics',     20),
  ('MATH', 'Mathematics', 'mathematics', 30),
  ('BIO',  'Biology',     'biology',     40)
on conflict do nothing;

insert into public.chapters (subject_id, name, slug, sort_order)
select (select id from public.subjects where code = 'CHEM'),
       v.name,
       trim(both '-' from lower(regexp_replace(v.name, '[^a-zA-Z0-9]+', '-', 'g'))),
       v.ord * 10
from unnest(array[
  'Some Basic Concepts of Chemistry',
  'Structure of Atom',
  'Classification of Elements and Periodicity',
  'Chemical Bonding and Molecular Structure',
  'States of Matter',
  'Thermodynamics',
  'Chemical Equilibrium',
  'Ionic Equilibrium',
  'Redox Reactions',
  'Hydrogen',
  's-Block Elements',
  'p-Block Elements',
  'd- and f-Block Elements',
  'Coordination Compounds',
  'General Principles of Isolation of Elements',
  'Organic Chemistry: Basic Principles and Techniques',
  'Hydrocarbons',
  'Haloalkanes and Haloarenes',
  'Alcohols, Phenols and Ethers',
  'Aldehydes, Ketones and Carboxylic Acids',
  'Amines',
  'Biomolecules',
  'Polymers',
  'Chemistry in Everyday Life',
  'Environmental Chemistry',
  'Solid State',
  'Solutions',
  'Electrochemistry',
  'Chemical Kinetics',
  'Surface Chemistry'
]) with ordinality as v(name, ord)
on conflict do nothing;

insert into public.exams (code, name, sort_order) values
  ('CBSE',     'CBSE',          10),
  ('ICSE',     'ICSE',          20),
  ('JEE_MAIN', 'JEE Main',      30),
  ('JEE_ADV',  'JEE Advanced',  40),
  ('NEET',     'NEET UG',       50),
  ('CUET',     'CUET',          60)
on conflict do nothing;
