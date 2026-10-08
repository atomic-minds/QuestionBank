-- =============================================================================
-- tests/sql/10_database.sql
-- Exercises the REAL migrations as the three roles that exist in production:
--   anon (public visitor), authenticated non-admin, authenticated admin.
-- Each check prints "ok - <name>"; any failure raises and aborts the run.
-- =============================================================================
\set ON_ERROR_STOP on
\o /dev/null

\set as_super 'reset role;'
\set as_anon  'reset role; set role anon; select set_config(''request.jwt.claim.sub'', '''', false);'
\set as_user  'reset role; set role authenticated; select set_config(''request.jwt.claim.sub'', ''22222222-2222-2222-2222-222222222222'', false);'
\set as_admin 'reset role; set role authenticated; select set_config(''request.jwt.claim.sub'', ''11111111-1111-1111-1111-111111111111'', false);'

-- ---------------------------------------------------------------- helpers ----
drop schema if exists test cascade;
create schema test;
grant usage on schema test to public;

create function test.ok(p_cond boolean, p_name text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'FAIL: %', p_name;
  end if;
  raise notice 'ok - %', p_name;
end $$;

create function test.throws(p_sql text, p_pattern text, p_name text) returns void language plpgsql as $$
declare
  v_msg   text;
  v_state text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    if v_msg ~* p_pattern or v_state = p_pattern then
      raise notice 'ok - % [%]', p_name, left(v_msg, 80);
      return;
    end if;
    raise exception 'FAIL: % -- expected /%/ but got [%] %', p_name, p_pattern, v_state, v_msg;
  end;
  raise exception 'FAIL: % -- expected an error /%/ but the statement succeeded', p_name, p_pattern;
end $$;

-- A valid MCQ in Chemistry > Solid State; tests override fields with ||.
create function test.base() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'subject_id', (select id from public.subjects where code = 'CHEM'),
    'chapter_id', (select c.id from public.chapters c join public.subjects s on s.id = c.subject_id
                   where s.code = 'CHEM' and c.name = 'Solid State'),
    'type_code', 'mcq',
    'question_text', 'What is the coordination number of NaCl?',
    'options', '[{"id":"A","text":"4"},{"id":"B","text":"6"},{"id":"C","text":"8"},{"id":"D","text":"12"}]'::jsonb,
    'answer', '{"value":"B"}'::jsonb,
    'explanation', 'Each Na+ is surrounded by six Cl- ions.',
    'status', 'draft')
$$;

create function test.save(p_patch jsonb) returns jsonb language sql as $$
  select public.qb_save_question(test.base() || p_patch)
$$;

create function test.save_throws(p_label text, p_patch jsonb, p_pattern text) returns void language plpgsql as $$
begin
  perform test.throws(format('select public.qb_save_question(test.base() || %L::jsonb)', p_patch::text), p_pattern, p_label);
end $$;

-- sorted, comma-joined public_ids of a search result
create function test.pids(j jsonb) returns text language sql immutable as $$
  select coalesce(string_agg(i ->> 'public_id', ',' order by i ->> 'public_id'), '')
  from jsonb_array_elements(j -> 'items') i
$$;

create function test.sorted(p_ids text[]) returns text language sql immutable as $$
  select coalesce(string_agg(x, ',' order by x), '') from unnest(p_ids) x
$$;

-- ============================================================================
-- 1. Reference data and normalization (as superuser)
-- ============================================================================
:as_super
select test.ok((select count(*) from public.question_types) = 9, 'nine controlled question types are seeded');
select test.ok((select count(*) from public.subjects where code in ('CHEM','PHY','MATH','BIO')) = 4, 'starter subjects exist');
select test.ok((select count(*) from public.chapters c join public.subjects s on s.id = c.subject_id where s.code = 'CHEM') = 30,
               'starter Chemistry chapters exist');
select test.throws($$insert into public.question_types(code, label, kind) values ('MCQ', 'Multiple Choice', 'choice')$$,
                   'check constraint', 'type code must be lower_snake (no "MCQ" variant)');
select test.throws($$insert into public.question_types(code, label, kind) values ('multiple_choice', 'MCQ', 'choice')$$,
                   '23505', 'duplicate type label is rejected');

select test.ok(public.qb_norm('  Q1.  What is H₂O?  ') = 'What is H2O', 'qb_norm: numbering, whitespace, subscripts, trailing ?');
select test.ok(public.qb_norm('It’s “ok” – fine') = 'It''s "ok" - fine', 'qb_norm: smart quotes and dashes folded');
select test.ok(public.qb_content_hash('mcq', 'Oxidation state of Co?', null, null, null)
            <> public.qb_content_hash('mcq', 'Oxidation state of CO?', null, null, null),
               'hash is case-sensitive: Co (cobalt) differs from CO (carbon monoxide)');
select test.ok(public.qb_content_hash('mcq', 'Q', null, '[{"id":"A","text":"x"},{"id":"B","text":"y"}]', null)
             = public.qb_content_hash('mcq', 'Q', null, '[{"id":"A","text":"y"},{"id":"B","text":"x"}]', null),
               'hash ignores option order');
select test.ok(public.qb_content_hash('mcq', 'Q', null, null, null) <> public.qb_content_hash('short_answer', 'Q', null, null, null),
               'hash includes the question type');

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'admin@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'user@example.test');
insert into public.admin_users (user_id) values ('11111111-1111-1111-1111-111111111111');

-- ============================================================================
-- 2. Identity and master data management
-- ============================================================================
:as_admin
select test.ok(public.is_admin(), 'admin is recognised');
:as_user
select test.ok(not public.is_admin(), 'signed-in non-admin is not an admin');
:as_anon
select test.ok(not public.is_admin(), 'anon is not an admin');

:as_admin
insert into public.chapters (subject_id, name, slug)
  select id, 'Mechanics', 'mechanics' from public.subjects where code = 'PHY';
insert into public.topics (chapter_id, name, slug)
  select id, 'Crystal Structure', 'crystal-structure' from public.chapters where name = 'Solid State';
insert into public.topics (chapter_id, name, slug)
  select id, 'Unit Cell', 'unit-cell' from public.chapters where name = 'Solid State';
insert into public.topics (chapter_id, name, slug)
  select id, 'Henry''s Law', 'henrys-law' from public.chapters where name = 'Solutions';
select test.ok(true, 'admin can add chapters and topics');

select test.throws($$insert into public.chapters (subject_id, name, slug)
                     select id, 'solid state', 'solid-state-2' from public.subjects where code = 'CHEM'$$,
                   '23505', 'chapter names are unique per subject, case-insensitively');
select test.throws($$insert into public.chapters (subject_id, name, slug)
                     select id, 'New One', 'Bad Slug' from public.subjects where code = 'CHEM'$$,
                   'check constraint', 'slugs must be lower-kebab');
select test.throws($$insert into public.subjects (code, name, slug) values ('chem2', 'X', 'x')$$,
                   'check constraint', 'subject code must be upper-case');

-- ============================================================================
-- 3. Question creation and per-type validation (admin)
-- ============================================================================
select (test.save('{}'))->>'public_id' as pid1 \gset
select test.ok(:'pid1' = 'QB-CHEM-000001', 'first question gets public id QB-CHEM-000001');

select (test.save('{"question_text":"Which is the coordination number of CsCl?",
                    "options":[{"id":"A","text":"8"},{"id":"B","text":"6"},{"id":"C","text":"4"},{"id":"D","text":"12"}],
                    "answer":{"value":"A"}}'))->>'public_id' as pid2 \gset
select test.ok(:'pid2' = 'QB-CHEM-000002', 'public ids count up per subject');

select (public.qb_save_question(test.base() || jsonb_build_object(
          'subject_id', (select id from public.subjects where code = 'PHY'),
          'chapter_id', (select id from public.chapters where name = 'Mechanics'),
          'question_text', 'What is the SI unit of force?',
          'options', '[{"id":"A","text":"Newton"},{"id":"B","text":"Joule"}]'::jsonb,
          'answer', '{"value":"A"}'::jsonb, 'explanation', 'F = ma, so kg m s^-2.', 'status', 'draft')))->>'public_id' as pid_phy \gset
select test.ok(:'pid_phy' = 'QB-PHY-000001', 'each subject has its own counter');

select test.ok((select created_by = '11111111-1111-1111-1111-111111111111' and version = 1 and status = 'draft'
                from public.questions where public_id = :'pid1'), 'audit columns, version and draft default are set');

-- choice validation
select test.save_throws('MCQ answer not among options', '{"answer":{"value":"Z"}}', 'QB_VALIDATION');
select test.save_throws('MCQ answer missing value key', '{"answer":{"text":"B"}}', 'QB_VALIDATION');
select test.save_throws('MCQ with one option', '{"options":[{"id":"A","text":"4"}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.save_throws('MCQ with seven options',
  '{"options":[{"id":"A","text":"1"},{"id":"B","text":"2"},{"id":"C","text":"3"},{"id":"D","text":"4"},{"id":"E","text":"5"},{"id":"F","text":"6"},{"id":"G","text":"7"}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.save_throws('option ids must run A,B,C...', '{"options":[{"id":"A","text":"4"},{"id":"C","text":"6"}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.save_throws('empty option text', '{"options":[{"id":"A","text":"4"},{"id":"B","text":"  "}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.save_throws('duplicate option text', '{"options":[{"id":"A","text":"Six"},{"id":"B","text":"Six  "}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.ok((test.save('{"question_text":"Which of these is the poisonous gas carbon monoxide?","options":[{"id":"A","text":"Co"},{"id":"B","text":"CO"},{"id":"C","text":"Cu"},{"id":"D","text":"Cs"}],"answer":{"value":"B"}}'::jsonb)) ->> 'public_id' is not null,
  'options that differ only by letter case (Co vs CO) are different options');
select test.save_throws('MCQ without options', '{"options":null}', 'QB_VALIDATION');
select test.save_throws('empty question text', '{"question_text":"   "}', 'q_text_len');
select test.save_throws('unknown question type ("multiple_choice" is not a variant of mcq)', '{"type_code":"multiple_choice"}', 'unknown question type');
select test.save_throws('true/false needs exactly two options', '{"type_code":"true_false","question_text":"NaCl is ionic.",
  "options":[{"id":"A","text":"True"},{"id":"B","text":"False"},{"id":"C","text":"Maybe"}],"answer":{"value":"A"}}', 'QB_VALIDATION');
select test.save_throws('assertion-reason needs four options', '{"type_code":"assertion_reason","question_text":"A and R.",
  "options":[{"id":"A","text":"Both true"},{"id":"B","text":"Both false"},{"id":"C","text":"A only"}],"answer":{"value":"A"}}', 'QB_VALIDATION');

select test.ok((test.save('{"type_code":"true_false","question_text":"NaCl is an ionic solid.",
  "options":[{"id":"A","text":"True"},{"id":"B","text":"False"}],"answer":{"value":"A"}}')) ->> 'public_id' is not null, 'valid true/false saves');
select test.ok((test.save('{"type_code":"assertion_reason","question_text":"Assertion: NaCl is ionic. Reason: Na transfers an electron to Cl.",
  "options":[{"id":"A","text":"Both A and R are true and R explains A"},{"id":"B","text":"Both true, R does not explain A"},
             {"id":"C","text":"A true, R false"},{"id":"D","text":"A false, R true"}],"answer":{"value":"A"}}')) ->> 'public_id' is not null,
  'valid assertion-reason saves');

-- text / numeric
select test.save_throws('short answer with options', '{"type_code":"short_answer","question_text":"Define lattice energy.","answer":{"text":"x"}}', 'QB_VALIDATION');
select test.save_throws('short answer with empty text', '{"type_code":"short_answer","options":null,"question_text":"Define lattice energy.","answer":{"text":" "}}', 'QB_VALIDATION');
select test.save_throws('short answer using the choice answer shape', '{"type_code":"short_answer","options":null,"question_text":"Define lattice energy.","answer":{"value":"B"}}', 'QB_VALIDATION');
select test.ok((test.save('{"type_code":"short_answer","options":null,"question_text":"Define lattice energy.","answer":{"text":"Energy released when gaseous ions form one mole of ionic solid."}}')) ->> 'public_id' is not null,
  'valid short answer saves (explicit JSON null options)');
select test.ok((test.save('{"type_code":"numerical","options":null,"question_text":"Find the molarity of 4 g NaOH in 1 L.","answer":{"number":0.1,"unit":"mol/L","tolerance":0.01}}')) ->> 'public_id' is not null,
  'valid numerical saves');
select test.save_throws('numerical answer must be a number', '{"type_code":"numerical","options":null,"question_text":"Find x.","answer":{"number":"abc"}}', 'QB_VALIDATION');
select test.save_throws('numerical tolerance cannot be negative', '{"type_code":"numerical","options":null,"question_text":"Find y.","answer":{"number":1,"tolerance":-1}}', 'QB_VALIDATION');

-- case based
select test.save_throws('case based requires context', '{"type_code":"case_based","question_text":"Read the passage and answer."}', 'QB_VALIDATION');
select test.ok((test.save('{"type_code":"case_based","context":"Rock salt has a face-centred cubic lattice.","question_text":"Which ion fills octahedral voids?"}')) ->> 'public_id' is not null,
  'case based with context and options saves');
select test.ok((test.save('{"type_code":"case_based","context":"Rock salt has a face-centred cubic lattice.","options":null,"question_text":"Explain why NaCl is brittle.","answer":{"text":"Layers shift and like charges repel."}}')) ->> 'public_id' is not null,
  'case based without options uses a text answer');

-- match the following
select test.ok((test.save('{"type_code":"match_following","options":null,"question_text":"Match the compound with its structure type.",
  "match_items":{"left":[{"id":"A","text":"NaCl"},{"id":"B","text":"ZnS"}],"right":[{"id":"1","text":"Rock salt"},{"id":"2","text":"Zinc blende"}]},
  "answer":{"pairs":{"A":"1","B":"2"}}}')) ->> 'public_id' is not null, 'valid match the following saves');
select test.save_throws('match pairs must cover every left item', '{"type_code":"match_following","options":null,"question_text":"Match again.",
  "match_items":{"left":[{"id":"A","text":"NaCl"},{"id":"B","text":"ZnS"}],"right":[{"id":"1","text":"Rock salt"},{"id":"2","text":"Zinc blende"}]},
  "answer":{"pairs":{"A":"1"}}}', 'QB_VALIDATION');
select test.save_throws('match pair must reference an existing right id', '{"type_code":"match_following","options":null,"question_text":"Match again 2.",
  "match_items":{"left":[{"id":"A","text":"NaCl"},{"id":"B","text":"ZnS"}],"right":[{"id":"1","text":"Rock salt"},{"id":"2","text":"Zinc blende"}]},
  "answer":{"pairs":{"A":"1","B":"9"}}}', 'QB_VALIDATION');

-- scalar columns
select test.save_throws('marks of zero', '{"question_text":"Marks zero?","marks":0}', 'check constraint');
select test.save_throws('marks above 100', '{"question_text":"Marks high?","marks":101}', 'check constraint');
select test.save_throws('difficulty outside the allowed values', '{"question_text":"Diff?","difficulty":"impossible"}', 'check constraint');
select test.save_throws('status outside the lifecycle', '{"question_text":"Status?","status":"weird"}', 'check constraint');
select test.save_throws('tags must be lower-case', '{"question_text":"Tags upper?","tags":["Crystal"]}', 'qb_tags_valid|check constraint');
select test.save_throws('at most twelve tags', jsonb_build_object('question_text', 'Tags many?', 'tags', (select jsonb_agg('t' || g) from generate_series(1, 13) g)), 'check constraint');
select test.save_throws('tags must be distinct', '{"question_text":"Tags dup?","tags":["a","a"]}', 'check constraint');

-- taxonomy integrity
select test.save_throws('chapter must belong to the subject',
  jsonb_build_object('question_text', 'Wrong chapter?', 'subject_id', (select id from public.subjects where code = 'PHY')), 'q_chapter_in_subject');
select test.save_throws('topic must belong to the chapter',
  jsonb_build_object('question_text', 'Wrong topic?', 'topic_id', (select id from public.topics where name = 'Henry''s Law')), 'q_topic_in_chapter');
update public.chapters set is_active = false where name = 'Solid State';
select test.save_throws('inactive chapters cannot receive new questions', '{"question_text":"Inactive chapter?"}', 'must be active');
update public.chapters set is_active = true where name = 'Solid State';
select test.throws($$update public.subjects set code = 'CHEMX' where code = 'CHEM'$$, 'QB_IMMUTABLE', 'subject code is frozen once questions exist');

-- ============================================================================
-- 4. Duplicate detection
-- ============================================================================
select test.save_throws('exact duplicate (whitespace/punctuation variant) is blocked',
  '{"question_text":"What  is the coordination number of NaCl"}', 'questions_content_hash_uq');
select test.save_throws('exact duplicate with question numbering is blocked',
  '{"question_text":"1. What is the coordination number of NaCl?"}', 'questions_content_hash_uq');
select test.save_throws('exact duplicate with reordered options is blocked',
  '{"options":[{"id":"A","text":"12"},{"id":"B","text":"8"},{"id":"C","text":"6"},{"id":"D","text":"4"}],"answer":{"value":"C"}}', 'questions_content_hash_uq');

select test.ok((test.save(jsonb_build_object('chapter_id', (select id from public.chapters where name = 'Coordination Compounds'),
  'question_text', 'What is the oxidation state of Co in [Co(NH3)6]Cl3?'))) ->> 'public_id' is not null,
  'Co (cobalt) question saves');
select test.ok((test.save(jsonb_build_object('chapter_id', (select id from public.chapters where name = 'Coordination Compounds'),
  'question_text', 'What is the oxidation state of CO in [Co(NH3)6]Cl3?'))) ->> 'public_id' is not null,
  'CO differs from Co: not treated as an exact duplicate');

select test.ok(jsonb_array_length(public.qb_find_duplicates('mcq', 'What is the coordination number of NaCl?', null,
    (test.base() -> 'options'), null)) >= 1
  and (public.qb_find_duplicates('mcq', 'What is the coordination number of NaCl?', null, (test.base() -> 'options'), null) -> 0 ->> 'exact')::boolean,
  'find_duplicates reports the exact match first');
select test.ok((public.qb_find_duplicates('mcq', 'What is the coordination number of NaCl crystal?', null, (test.base() -> 'options'), null, null, 0.6) -> 0 ->> 'exact')::boolean is false
  and (public.qb_find_duplicates('mcq', 'What is the coordination number of NaCl crystal?', null, (test.base() -> 'options'), null, null, 0.6) -> 0 ->> 'similarity')::real > 0.6,
  'find_duplicates reports a near-duplicate with its similarity');
select test.ok(public.qb_find_duplicates('mcq', 'Explain the Born-Haber cycle for lithium fluoride in detail', null, null, null) = '[]'::jsonb,
  'find_duplicates returns nothing for an unrelated question');
select test.ok(not exists (
    select 1 from jsonb_array_elements(public.qb_find_duplicates('mcq', 'What is the coordination number of NaCl?', null,
      (test.base() -> 'options'), null, (select id from public.questions where public_id = :'pid1'))) r
    where r ->> 'public_id' = :'pid1'),
  'find_duplicates can exclude the question being edited');

-- archived questions do not block re-import
select (test.save('{"question_text":"Archive me then re-add me?"}'))->>'public_id' as pid_arch \gset
update public.questions set status = 'archived' where public_id = :'pid_arch';
select test.ok((test.save('{"question_text":"Archive me then re-add me?"}')) ->> 'public_id' is not null,
  'an identical question can be re-added once the old one is archived');
select test.throws(format($$update public.questions set status = 'draft' where public_id = %L$$, :'pid_arch'),
  'questions_content_hash_uq', 'un-archiving a duplicate of an active question is blocked');

-- ============================================================================
-- 5. Optimistic concurrency, immutability, exam appearances, atomicity
-- ============================================================================
select test.throws(format($$update public.questions set public_id = 'QB-CHEM-999999' where public_id = %L$$, :'pid1'),
  'QB_IMMUTABLE', 'public_id cannot be changed');

-- Publish the Solid State MCQ with metadata and an exam appearance (version 1 -> 2).
select public.qb_save_question(test.base() || jsonb_build_object(
  'id', (select id from public.questions where public_id = :'pid1'), 'expected_version', 1,
  'status', 'published', 'difficulty', 'medium', 'marks', 1, 'tags', '["crystal","ionic"]'::jsonb,
  'topic_id', (select id from public.topics where name = 'Crystal Structure'),
  'exams', jsonb_build_array(jsonb_build_object('exam_id', (select id from public.exams where code = 'CBSE'), 'year', 2025))));
select test.ok((select version = 2 and status = 'published' and published_at is not null from public.questions where public_id = :'pid1'),
  'update bumps the version and stamps published_at');
select test.save_throws('stale expected_version is rejected',
  jsonb_build_object('id', (select id from public.questions where public_id = :'pid1'), 'expected_version', 1), 'QB_CONFLICT');
select test.save_throws('unknown question id',
  '{"id":"00000000-0000-0000-0000-000000000000"}', 'QB_NOT_FOUND');

-- qb_save_question is a full replace (like HTTP PUT): every field not sent is cleared,
-- except "exams", which is left alone when the key is absent. Send the full document.
select public.qb_save_question(test.base() || jsonb_build_object(
  'id', (select id from public.questions where public_id = :'pid1'), 'status', 'published',
  'difficulty', 'medium', 'marks', 1, 'tags', '["crystal","ionic"]'::jsonb,
  'topic_id', (select id from public.topics where name = 'Crystal Structure')));
select test.ok((select count(*) from public.question_exams qe join public.questions q on q.id = qe.question_id where q.public_id = :'pid1') = 1,
  'omitting "exams" on update keeps the existing appearances');
select public.qb_save_question(test.base() || jsonb_build_object(
  'id', (select id from public.questions where public_id = :'pid1'), 'status', 'published', 'tags', '["x"]'::jsonb));
select test.ok((select difficulty is null and marks is null and tags = '{x}' from public.questions where public_id = :'pid1'),
  'update is a full replace: omitted fields are cleared');
select public.qb_save_question(test.base() || jsonb_build_object(
  'id', (select id from public.questions where public_id = :'pid1'), 'status', 'published',
  'difficulty', 'medium', 'marks', 1, 'tags', '["crystal","ionic"]'::jsonb,
  'topic_id', (select id from public.topics where name = 'Crystal Structure')));

select test.save_throws('exam year out of range',
  jsonb_build_object('question_text', 'Atomicity probe A?', 'exams', jsonb_build_array(
    jsonb_build_object('exam_id', (select id from public.exams where code = 'CBSE'), 'year', 1800))), 'check constraint');
select test.save_throws('the same exam and year twice is rejected',
  jsonb_build_object('question_text', 'Atomicity probe B?', 'exams', jsonb_build_array(
    jsonb_build_object('exam_id', (select id from public.exams where code = 'CBSE'), 'year', 2020),
    jsonb_build_object('exam_id', (select id from public.exams where code = 'CBSE'), 'year', 2020))), '23505');
select test.save_throws('unknown exam id',
  '{"question_text":"Atomicity probe C?","exams":[{"exam_id":999,"year":2020}]}', '23503');
select test.ok((select count(*) from public.questions where question_text like 'Atomicity probe%') = 0,
  'a failed exam insert rolls back the whole question (atomic save)');

-- Dataset for search tests -----------------------------------------------------
select (test.save(jsonb_build_object(
  'type_code', 'short_answer', 'options', null, 'question_text', 'Define a unit cell.',
  'answer', '{"text":"The smallest repeating unit of a crystal lattice."}'::jsonb,
  'explanation', 'It reproduces the whole lattice by translation.', 'difficulty', 'easy', 'marks', 2,
  'tags', '["unit-cell"]'::jsonb, 'status', 'published',
  'topic_id', (select id from public.topics where name = 'Unit Cell'))))->>'public_id' as pid_unit \gset

select (public.qb_save_question(test.base() || jsonb_build_object(
  'chapter_id', (select id from public.chapters where name = 'Solutions'),
  'topic_id', (select id from public.topics where name = 'Henry''s Law'),
  'question_text', 'How does the Henry''s law constant of a gas vary with temperature?',
  'options', '[{"id":"A","text":"Increases with temperature"},{"id":"B","text":"Decreases with temperature"},{"id":"C","text":"Is independent of temperature"},{"id":"D","text":"Is zero"}]'::jsonb,
  'answer', '{"value":"A"}'::jsonb, 'explanation', 'Gas solubility falls as temperature rises.',
  'difficulty', 'hard', 'marks', 4, 'tags', '["henry"]'::jsonb, 'status', 'published',
  'exams', jsonb_build_array(
     jsonb_build_object('exam_id', (select id from public.exams where code = 'JEE_MAIN'), 'year', 2024, 'paper', 'Shift 1'),
     jsonb_build_object('exam_id', (select id from public.exams where code = 'CBSE'), 'year', 2023)))))->>'public_id' as pid_henry \gset

update public.questions set status = 'published' where public_id = :'pid_phy';

select (test.save(jsonb_build_object(
  'chapter_id', (select id from public.chapters where name = 'Chemical Kinetics'),
  'type_code', 'numerical', 'options', null,
  'question_text', 'The rate constant of a first order reaction is 0.0693 per minute. Calculate the half-life.',
  'answer', '{"number":10,"unit":"min"}'::jsonb)))->>'public_id' as pid_kin \gset
-- (pid_kin stays a draft: used to prove drafts are invisible to the public)

-- ============================================================================
-- 6. Security: what each role can and cannot do
-- ============================================================================
:as_anon
select test.throws($$select * from public.questions$$, '42501', 'anon cannot read the questions table directly');
select test.throws($$select * from public.question_exams$$, '42501', 'anon cannot read question_exams directly');
select test.throws($$select * from public.admin_users$$, '42501', 'anon cannot read admin_users');
select test.throws($$select * from public.ai_usage$$, '42501', 'anon cannot read ai_usage');
select test.throws($$select * from public.question_counters$$, '42501', 'anon cannot read question_counters');
select test.throws($$insert into public.subjects (code, name, slug) values ('HACK', 'Hack', 'hack')$$, '42501', 'anon cannot write master data');
select test.throws($$select public.qb_save_question(test.base())$$, '42501', 'anon cannot call qb_save_question');
select test.throws($$select public.qb_find_duplicates('mcq', 'x', null, null, null)$$, '42501', 'anon cannot call qb_find_duplicates');
select test.throws($$select public.qb_consume_ai_quota(10)$$, '42501', 'anon cannot spend AI quota');
select test.throws($$select public.qb_admin_stats()$$, '42501', 'anon cannot read admin stats');
select test.throws($$select public.qb_next_public_id(1::smallint)$$, '42501', 'anon cannot mint public ids');

:as_user
select test.ok((select count(*) from public.questions) = 0, 'non-admin sees zero rows in questions (RLS)');
select test.throws($$select public.qb_save_question(test.base() || '{"question_text":"Sneaky insert?"}')$$, 'row-level security',
                   'non-admin cannot create questions');
with u as (update public.questions set status = 'archived' returning 1) select test.ok((select count(*) from u) = 0, 'non-admin update changes nothing');
with d as (delete from public.questions returning 1)                  select test.ok((select count(*) from d) = 0, 'non-admin delete removes nothing');
select test.throws($$insert into public.subjects (code, name, slug) values ('HACK', 'Hack', 'hack')$$, 'row-level security', 'non-admin cannot add subjects');
with u as (update public.chapters set name = 'Pwned' returning 1) select test.ok((select count(*) from u) = 0, 'non-admin cannot rename chapters');
select test.throws($$select public.qb_consume_ai_quota(10)$$, 'QB_FORBIDDEN', 'non-admin cannot spend AI quota');
select test.throws($$select public.qb_admin_stats()$$, 'QB_FORBIDDEN', 'non-admin cannot read admin stats');
select test.throws($$select public.qb_find_duplicates('mcq', 'x', null, null, null)$$, 'QB_FORBIDDEN', 'non-admin cannot probe for duplicates');
select test.ok((select count(*) from public.admin_users) = 0, 'non-admin cannot see the admin list');

:as_admin
select test.ok((select count(*) from public.admin_users) = 1, 'an admin can see their own admin row only');
select test.ok((select count(*) from public.questions) >= 15, 'admin sees every status in questions');

-- ============================================================================
-- 7. Public API as anon: visibility, search, filters, pagination, facets
-- ============================================================================
:as_anon
select test.ok(test.pids(public.qb_search_questions()) = test.sorted(array[:'pid1', :'pid_unit', :'pid_henry', :'pid_phy']),
  'anon sees exactly the published questions');
select test.ok(test.pids(public.qb_search_questions(p_status := 'draft')) = test.sorted(array[:'pid1', :'pid_unit', :'pid_henry', :'pid_phy']),
  'anon cannot use p_status to reach drafts');
select test.ok(public.qb_get_question(:'pid_kin') is null, 'anon cannot fetch a draft by id');
select test.ok(public.qb_get_question(lower(:'pid1')) ->> 'public_id' = :'pid1', 'qb_get_question is case-insensitive and returns published');
select test.ok(not (public.qb_get_question(:'pid1') ? 'content_hash') and not (public.qb_get_question(:'pid1') ? 'created_by'),
  'public payload hides content_hash and created_by');
select test.ok((public.qb_get_question(:'pid1') -> 'exams' -> 0 ->> 'year') = '2025'
           and (public.qb_get_question(:'pid1') -> 'exams' -> 0 ->> 'code') = 'CBSE', 'public payload includes exam appearances');
select test.ok((public.qb_search_questions(p_limit := 1000) ->> 'limit')::int = 50, 'anon page size is capped at 50');

-- full-text search
select test.ok(test.pids(public.qb_search_questions(p_q := 'coordination')) = :'pid1', 'FTS finds the question stem');
select test.ok(test.pids(public.qb_search_questions(p_q := 'independent')) = :'pid_henry', 'FTS finds option text');
select test.ok(test.pids(public.qb_search_questions(p_q := 'surrounding')) = :'pid1', 'FTS finds explanation text with stemming');
select test.ok(test.pids(public.qb_search_questions(p_q := 'ordination num')) = :'pid1', 'substring search works for partial words');
select test.ok(test.pids(public.qb_search_questions(p_q := 'unit-cell')) like '%' || :'pid_unit' || '%', 'search matches tags');
select test.ok(test.pids(public.qb_search_questions(p_q := '''; drop table public.questions; --')) = '', 'SQL-injection style input is just a search');
select test.ok(test.pids(public.qb_search_questions(p_q := '%')) = '' and test.pids(public.qb_search_questions(p_q := '_')) = '',
  'LIKE wildcards in the query are treated literally');

-- filters
select test.ok(test.pids(public.qb_search_questions(p_subject := (select id from public.subjects where code = 'CHEM'))) = test.sorted(array[:'pid1', :'pid_unit', :'pid_henry']), 'filter: subject');
select test.ok(test.pids(public.qb_search_questions(p_chapter := (select id from public.chapters where name = 'Solid State'))) = test.sorted(array[:'pid1', :'pid_unit']), 'filter: chapter');
select test.ok(test.pids(public.qb_search_questions(p_topic := (select id from public.topics where name = 'Unit Cell'))) = :'pid_unit', 'filter: topic');
select test.ok(test.pids(public.qb_search_questions(p_type := 'short_answer')) = :'pid_unit', 'filter: question type');
select test.ok(test.pids(public.qb_search_questions(p_category := 'exam')) = test.sorted(array[:'pid1', :'pid_henry']), 'filter: category exam');
select test.ok(test.pids(public.qb_search_questions(p_category := 'general')) = test.sorted(array[:'pid_unit', :'pid_phy']), 'filter: category general');
select test.ok(test.pids(public.qb_search_questions(p_exam := (select id from public.exams where code = 'CBSE'))) = test.sorted(array[:'pid1', :'pid_henry']), 'filter: exam');
select test.ok(test.pids(public.qb_search_questions(p_exam := (select id from public.exams where code = 'CBSE'), p_year := 2025::smallint)) = :'pid1', 'filter: exam + year');
select test.ok(test.pids(public.qb_search_questions(p_year := 2024::smallint)) = :'pid_henry', 'filter: year alone');
select test.ok(test.pids(public.qb_search_questions(p_exam := (select id from public.exams where code = 'JEE_MAIN'))) = :'pid_henry', 'filter: a different exam');
select test.ok(test.pids(public.qb_search_questions(p_difficulty := 'hard')) = :'pid_henry', 'filter: difficulty');
select test.ok(test.pids(public.qb_search_questions(p_marks := 2)) = :'pid_unit', 'filter: marks');
select test.ok(test.pids(public.qb_search_questions(p_tag := 'ionic')) = :'pid1', 'filter: tag');
select test.ok(test.pids(public.qb_search_questions(p_subject := (select id from public.subjects where code = 'CHEM'), p_category := 'exam', p_difficulty := 'hard')) = :'pid_henry', 'filters combine with AND');
select test.throws($$select public.qb_search_questions(p_category := 'weird')$$, 'QB_VALIDATION', 'invalid category is rejected');

-- pagination
select test.ok(jsonb_array_length(public.qb_search_questions(p_limit := 2) -> 'items') = 2 and (public.qb_search_questions(p_limit := 2) ->> 'has_more')::boolean, 'page 1 of 2 reports has_more');
select test.ok(jsonb_array_length(public.qb_search_questions(p_limit := 2, p_offset := 2) -> 'items') = 2 and not (public.qb_search_questions(p_limit := 2, p_offset := 2) ->> 'has_more')::boolean, 'last page reports no more');
select test.ok(jsonb_array_length(public.qb_search_questions(p_limit := 2, p_offset := 4) -> 'items') = 0, 'paging past the end returns nothing');

-- facets, tree, taxonomy search
select test.ok((public.qb_facets((select id from public.subjects where code = 'CHEM')) ->> 'total')::int = 3
           and (public.qb_facets((select id from public.subjects where code = 'CHEM')) ->> 'general')::int = 1
           and (public.qb_facets((select id from public.subjects where code = 'CHEM')) ->> 'exam')::int = 2, 'facets: totals, general and exam counts');
select test.ok((public.qb_facets((select id from public.subjects where code = 'CHEM')) -> 'years') = '[{"value":2025,"count":1},{"value":2024,"count":1},{"value":2023,"count":1}]'::jsonb, 'facets: years, newest first');
select test.ok(jsonb_array_length(public.qb_facets((select id from public.subjects where code = 'CHEM')) -> 'types') = 2
           and jsonb_array_length(public.qb_facets((select id from public.subjects where code = 'CHEM')) -> 'tags') = 4, 'facets: types and tags');
select test.ok((select (s ->> 'count')::int from jsonb_array_elements(public.qb_taxonomy_tree()) s where s ->> 'code' = 'CHEM') = 3, 'tree: subject count');
select test.ok((select (c ->> 'count')::int from jsonb_array_elements(public.qb_taxonomy_tree()) s, jsonb_array_elements(s -> 'chapters') c
                where s ->> 'code' = 'CHEM' and c ->> 'name' = 'Solid State') = 2, 'tree: chapter count');
select test.ok((select (t ->> 'count')::int from jsonb_array_elements(public.qb_taxonomy_tree()) s, jsonb_array_elements(s -> 'chapters') c, jsonb_array_elements(c -> 'topics') t
                where s ->> 'code' = 'CHEM' and t ->> 'name' = 'Unit Cell') = 1, 'tree: topic count');
select test.ok(public.qb_search_taxonomy('solid') -> 'chapters' -> 0 ->> 'slug' = 'solid-state', 'taxonomy search finds a chapter by name');
select test.ok(jsonb_array_length(public.qb_search_taxonomy('crystal') -> 'topics') = 1, 'taxonomy search finds a topic by name');
select test.ok(public.qb_search_taxonomy('   ') = '{"chapters":[],"topics":[]}'::jsonb, 'blank taxonomy search is empty');

-- inactive master data is invisible to the public but visible to admins
:as_admin
update public.chapters set is_active = false where name = 'Surface Chemistry';
:as_anon
select test.ok((select count(*) from public.chapters where name = 'Surface Chemistry') = 0, 'anon cannot see inactive chapters');
select test.ok(not exists (select 1 from jsonb_array_elements(public.qb_taxonomy_tree()) s, jsonb_array_elements(s -> 'chapters') c where c ->> 'name' = 'Surface Chemistry'),
  'inactive chapters are not in the public tree');
:as_admin
select test.ok((select count(*) from public.chapters where name = 'Surface Chemistry') = 1, 'admin still sees inactive chapters');
update public.chapters set is_active = true where name = 'Surface Chemistry';

-- ============================================================================
-- 8. Admin RPCs: full visibility, quota guard, stats, deletion
-- ============================================================================
:as_admin
select test.ok(test.pids(public.qb_search_questions(p_status := 'draft')) like '%' || :'pid_kin' || '%', 'admin can list drafts');
select test.ok((public.qb_search_questions(p_limit := 1000) ->> 'limit')::int = 500, 'admin page size is capped at 500');
select test.ok(public.qb_get_question(:'pid_kin') ->> 'status' = 'draft', 'admin can fetch a draft by id');

select test.ok((public.qb_consume_ai_quota(2) ->> 'used')::int = 1, 'AI quota: first call allowed');
select test.ok((public.qb_consume_ai_quota(2) ->> 'allowed')::boolean, 'AI quota: second call allowed');
select test.ok(not (public.qb_consume_ai_quota(2) ->> 'allowed')::boolean, 'AI quota: third call refused at the cap');
select test.ok((public.qb_admin_stats() ->> 'ai_used_today')::int = 2 and (public.qb_admin_stats() ->> 'db_bytes')::bigint > 0
           and (public.qb_admin_stats() -> 'by_status' ->> 'published')::int = 4, 'admin stats: AI usage, database size and status counts');
select test.throws($$select public.qb_consume_ai_quota(-1)$$, 'QB_VALIDATION', 'negative AI limit is rejected');

select test.ok((select count(*) from public.question_exams qe join public.questions q on q.id = qe.question_id where q.public_id = :'pid_henry') = 2, 'henry question has two exam appearances');
delete from public.questions where public_id = :'pid_henry';
select test.ok((select count(*) from public.question_exams) = 1, 'deleting a question cascades to its exam appearances');

-- ============================================================================
-- 9. Restore from backup: explicit public IDs survive, counters stay ahead
-- ============================================================================
:as_admin
select (test.save('{"question_text":"Restored question one?","public_id":"QB-CHEM-000500"}'))->>'public_id' as pid_restored \gset
select test.ok(:'pid_restored' = 'QB-CHEM-000500', 'a backup can be restored with its original public id');
select (test.save('{"question_text":"Fresh question after the restore?"}'))->>'public_id' as pid_after \gset
select test.ok(:'pid_after' = 'QB-CHEM-000501', 'new ids continue after the highest restored id');
select test.save_throws('restored id must belong to the question subject', '{"question_text":"Wrong prefix?","public_id":"QB-PHY-000007"}', 'QB_VALIDATION');
select test.save_throws('restored id must have the QB format', '{"question_text":"Bad format?","public_id":"chem-7"}', 'QB_VALIDATION');
select test.save_throws('restored id must be unique', '{"question_text":"Same id again?","public_id":"QB-CHEM-000500"}', '23505');
:as_user
select test.throws($$select public.qb_register_public_id(1::smallint, 'QB-CHEM-000900')$$, '42501', 'only the trigger can register ids');
:as_admin

-- Marker proving the whole file ran to the end (the harness requires it).
select test.ok(true, 'END OF 10_database');
