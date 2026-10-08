-- =============================================================================
-- 0001_schema.sql — Question Bank core schema
--
-- Target: Supabase Postgres (15+). Also runs on plain Postgres 14+ if an
-- `auth` schema with users(id) and uid() exists (see tests/sql/00_stub.sql).
--
-- Design notes
--   * A question is structured data. No images are stored anywhere.
--   * Taxonomy is normalized: subjects -> chapters -> topics. Questions carry
--     subject_id AND chapter_id so composite foreign keys can prove that the
--     chapter belongs to the subject and the topic belongs to the chapter.
--   * Options live in JSONB on the question row (one row per question keeps
--     reads and storage small on the free tier). Shape is enforced by trigger.
--   * content_hash / normalized_text / search_vector are computed by the
--     database trigger, never trusted from a client.
-- =============================================================================

create extension if not exists pg_trgm  with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- Controlled vocabulary: question types
-- -----------------------------------------------------------------------------
create table public.question_types (
  code             text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  label            text not null unique,
  -- How the answer is represented:
  --   choice  options + answer {"value":"B"}
  --   text    answer {"text":"..."}
  --   numeric answer {"number":12.5,"unit":"mol","tolerance":0.05}
  --   match   match_items {left,right} + answer {"pairs":{"A":"2",...}}
  --   any     options optional; if present behaves like choice, else like text
  kind             text not null check (kind in ('choice','text','numeric','match','any')),
  min_options      smallint not null default 0 check (min_options >= 0),
  max_options      smallint not null default 0 check (max_options >= min_options),
  requires_context boolean  not null default false,
  sort_order       smallint not null default 0
);

comment on table public.question_types is
  'Closed vocabulary of question types. Changing it needs a migration because validation depends on kind.';

-- -----------------------------------------------------------------------------
-- Master data: subjects -> chapters -> topics, exams
-- -----------------------------------------------------------------------------
create table public.subjects (
  id         smallint generated always as identity primary key,
  code       text not null unique check (code ~ '^[A-Z][A-Z0-9]{1,7}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index subjects_name_uq on public.subjects (lower(name));

create table public.chapters (
  id         integer generated always as identity primary key,
  subject_id smallint not null references public.subjects(id) on delete restrict,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (subject_id, slug),
  unique (id, subject_id)               -- target of questions' composite FK
);
create unique index chapters_name_uq on public.chapters (subject_id, lower(name));

create table public.topics (
  id         integer generated always as identity primary key,
  chapter_id integer not null references public.chapters(id) on delete restrict,
  name       text not null check (char_length(btrim(name)) between 1 and 120),
  slug       text not null check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (chapter_id, slug),
  unique (id, chapter_id)               -- target of questions' composite FK
);
create unique index topics_name_uq on public.topics (chapter_id, lower(name));

create table public.exams (
  id         smallint generated always as identity primary key,
  code       text not null unique check (code ~ '^[A-Z0-9_]{2,20}$'),
  name       text not null check (char_length(btrim(name)) between 1 and 80),
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index exams_name_uq on public.exams (lower(name));

-- A subject's code is baked into every public question ID, so freeze it once used.
create function public.qb_subjects_bu() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.code is distinct from old.code
     and exists (select 1 from public.question_counters where subject_id = old.id) then
    raise exception 'QB_IMMUTABLE: subject code cannot change after questions exist'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

-- Per-subject counters for public IDs (QB-CHEM-000241).
create table public.question_counters (
  subject_id smallint primary key references public.subjects(id) on delete cascade,
  last_value integer not null default 0
);

create trigger subjects_bu before update on public.subjects
  for each row execute function public.qb_subjects_bu();

-- -----------------------------------------------------------------------------
-- Normalization helpers (single source of truth for duplicate detection).
--   qb_norm      case-PRESERVING: "Co" (cobalt) and "CO" (carbon monoxide)
--                must never hash as the same question.
--   qb_norm_ci   lower-cased, used only for fuzzy near-duplicate warnings.
-- -----------------------------------------------------------------------------
create function public.qb_norm(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select btrim(
    regexp_replace(                                    -- trailing ? . : ; ! ,
      regexp_replace(                                  -- leading "Q1." "1)" numbering
        regexp_replace(                                -- collapse whitespace
          translate(
            normalize(coalesce(p, ''), NFKC),          -- H₂O -> H2O, full-width -> ASCII
            chr(8216) || chr(8217) || chr(8220) || chr(8221) || chr(8211) || chr(8212),
            '''''""--'
          ),
          '\s+', ' ', 'g'),
        '^\s*(q(uestion)?\s*)?\(?[0-9]{1,3}[\).:]\s+', '', 'i'),
      '[\s?.:;!,]+$', '')
  );
$$;

create function public.qb_norm_ci(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select lower(public.qb_norm(p));
$$;

-- Text of the match-the-following lists: left in order, right sorted.
create function public.qb_match_text(p_match jsonb) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when p_match is null then ''
    else coalesce((select string_agg(public.qb_norm(m->>'text'), E'\x1e' order by ord)
                   from jsonb_array_elements(coalesce(p_match->'left', '[]'::jsonb)) with ordinality as l(m, ord)), '')
         || E'\x1d'
         || coalesce((select string_agg(public.qb_norm(m->>'text'), E'\x1e' order by public.qb_norm(m->>'text'))
                      from jsonb_array_elements(coalesce(p_match->'right', '[]'::jsonb)) as r(m)), '')
  end;
$$;

-- Exact-duplicate fingerprint: type + stem + context + options (order-independent) + match lists.
create function public.qb_content_hash(
  p_type text, p_question text, p_context text, p_options jsonb, p_match jsonb
) returns text
language sql immutable parallel safe set search_path = '' as $$
  select encode(
    extensions.digest(
      convert_to(
        coalesce(p_type, '') || E'\x1f'
        || public.qb_norm(p_question) || E'\x1f'
        || public.qb_norm(p_context) || E'\x1f'
        || coalesce((select string_agg(public.qb_norm(o->>'text'), E'\x1e' order by public.qb_norm(o->>'text'))
                     from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) as o), '')
        || E'\x1f'
        || public.qb_match_text(p_match),
        'UTF8'),
      'sha256'),
    'hex');
$$;

-- Lower-cased stem + sorted options, used for trigram near-duplicate search.
create function public.qb_normalized_text(p_question text, p_options jsonb) returns text
language sql immutable parallel safe set search_path = '' as $$
  select public.qb_norm_ci(p_question)
         || coalesce(' | ' || (
              select string_agg(public.qb_norm_ci(o->>'text'), ' | ' order by public.qb_norm_ci(o->>'text'))
              from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) as o), '');
$$;

create function public.qb_tags_valid(p_tags text[]) returns boolean
language sql immutable parallel safe set search_path = '' as $$
  select p_tags is not null
     and coalesce(cardinality(p_tags), 0) <= 12
     and not exists (
           select 1 from unnest(p_tags) as t
           where t is null or t <> lower(btrim(t)) or char_length(t) not between 1 and 40)
     and coalesce(cardinality(p_tags), 0) = (select count(distinct t) from unnest(p_tags) as t);
$$;

-- -----------------------------------------------------------------------------
-- Questions
-- -----------------------------------------------------------------------------
create table public.questions (
  id            uuid primary key default gen_random_uuid(),
  public_id     text not null unique,                 -- QB-CHEM-000241, immutable, safe to export
  subject_id    smallint not null,
  chapter_id    integer  not null,
  topic_id      integer,
  type_code     text not null references public.question_types(code),

  context       text,                                  -- passage / case study / shared stem
  question_text text not null,
  options       jsonb,                                 -- [{"id":"A","text":"..."}]
  match_items   jsonb,                                 -- {"left":[{id,text}],"right":[{id,text}]}
  answer        jsonb not null,
  explanation   text,

  difficulty    text check (difficulty in ('easy','medium','hard')),
  marks         numeric(5,2) check (marks > 0 and marks <= 100),
  tags          text[] not null default '{}' check (public.qb_tags_valid(tags)),

  status        text not null default 'draft'
                check (status in ('draft','review','published','archived')),
  origin        text not null default 'manual'
                check (origin in ('manual','ai_image','json_import')),
  source_ref    text check (char_length(source_ref) <= 300),

  -- Maintained by trigger (never supplied by clients):
  content_hash    text not null,
  normalized_text text not null,
  search_vector   tsvector not null,

  version       integer not null default 1,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  published_at  timestamptz,

  constraint q_chapter_in_subject
    foreign key (chapter_id, subject_id) references public.chapters (id, subject_id),
  constraint q_topic_in_chapter
    foreign key (topic_id, chapter_id)   references public.topics (id, chapter_id),
  constraint q_text_len        check (char_length(btrim(question_text)) between 1 and 5000),
  constraint q_context_len     check (context is null or char_length(context) <= 10000),
  constraint q_explanation_len check (explanation is null or char_length(explanation) <= 10000),
  constraint q_options_array   check (options is null or jsonb_typeof(options) = 'array'),
  constraint q_match_object    check (match_items is null or jsonb_typeof(match_items) = 'object'),
  constraint q_answer_object   check (jsonb_typeof(answer) = 'object'),
  constraint q_hash_format     check (content_hash ~ '^[0-9a-f]{64}$')
);

-- Exact duplicates cannot exist among non-archived questions (race-proof).
create unique index questions_content_hash_uq on public.questions (content_hash)
  where status <> 'archived';

create index questions_search_gin   on public.questions using gin (search_vector);
create index questions_trgm_gin     on public.questions using gin (normalized_text extensions.gin_trgm_ops);
create index questions_tags_gin     on public.questions using gin (tags);
create index questions_pub_tax_idx  on public.questions (subject_id, chapter_id, topic_id) where status = 'published';
create index questions_status_pid   on public.questions (status, public_id);
create index questions_type_idx     on public.questions (type_code);
create index questions_topic_idx    on public.questions (topic_id) where topic_id is not null;

-- A question can appear in several exams/years (the same question recurs).
create table public.question_exams (
  id          bigint generated always as identity primary key,
  question_id uuid not null references public.questions(id) on delete cascade,
  exam_id     smallint not null references public.exams(id) on delete restrict,
  year        smallint check (year between 1950 and 2100),
  paper       text check (paper is null or char_length(paper) between 1 and 80)
);
create unique index question_exams_uq on public.question_exams
  (question_id, exam_id, coalesce(year, 0), coalesce(paper, ''));
create index question_exams_exam_year_idx on public.question_exams (exam_id, year);

-- -----------------------------------------------------------------------------
-- Public ID generation
-- -----------------------------------------------------------------------------
create function public.qb_next_public_id(p_subject smallint) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_n    integer;
begin
  select code into v_code from public.subjects where id = p_subject;
  if v_code is null then
    raise exception 'QB_VALIDATION: unknown subject' using errcode = 'foreign_key_violation';
  end if;

  insert into public.question_counters (subject_id, last_value) values (p_subject, 1)
  on conflict (subject_id) do update set last_value = public.question_counters.last_value + 1
  returning last_value into v_n;

  return 'QB-' || v_code || '-' ||
         case when v_n < 1000000 then lpad(v_n::text, 6, '0') else v_n::text end;
end $$;

-- Restore support: accept an explicit public ID (from a backup) and move the
-- subject's counter past it so freshly minted IDs can never collide.
create function public.qb_register_public_id(p_subject smallint, p_public_id text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_code text;
  v_n    integer;
begin
  select code into v_code from public.subjects where id = p_subject;
  if v_code is null or p_public_id !~ ('^QB-' || v_code || '-[0-9]{6,9}$') then
    raise exception 'QB_VALIDATION: public_id must look like QB-%-000123 for this subject', coalesce(v_code, '?')
      using errcode = 'check_violation';
  end if;
  v_n := substring(p_public_id from '[0-9]+$')::integer;
  insert into public.question_counters (subject_id, last_value) values (p_subject, v_n)
  on conflict (subject_id) do update
    set last_value = greatest(public.question_counters.last_value, excluded.last_value);
end $$;

-- -----------------------------------------------------------------------------
-- The validation / derivation trigger. This is the last line of defence: even a
-- client that bypasses the Edge Functions cannot store a malformed question.
-- -----------------------------------------------------------------------------
create function public.qb_questions_biu() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare
  t         public.question_types%rowtype;
  n         integer;
  n_right   integer;
  i         integer;
  opt       jsonb;
  v_ids     text[];
  v_norms   text[];
  v_pairs   jsonb;
  k         text;
  v_opt_txt text;
  v_mat_txt text;
begin
  -- ---- identity, versioning, audit columns ---------------------------------
  if tg_op = 'INSERT' then
    if new.public_id is null or new.public_id = '' then
      new.public_id := public.qb_next_public_id(new.subject_id);
    else
      perform public.qb_register_public_id(new.subject_id, new.public_id);   -- restore from backup
    end if;
    new.version    := 1;
    new.created_at := now();
    new.updated_at := now();
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
  else
    if new.public_id is distinct from old.public_id then
      raise exception 'QB_IMMUTABLE: public_id cannot be changed' using errcode = 'check_violation';
    end if;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    new.version    := old.version + 1;
    new.updated_at := now();
    new.updated_by := auth.uid();
  end if;

  -- ---- taxonomy must be active when (re)assigned ----------------------------
  if tg_op = 'INSERT'
     or new.subject_id is distinct from old.subject_id
     or new.chapter_id is distinct from old.chapter_id
     or new.topic_id   is distinct from old.topic_id then
    if not exists (select 1 from public.subjects where id = new.subject_id and is_active)
       or not exists (select 1 from public.chapters where id = new.chapter_id and is_active)
       or (new.topic_id is not null
           and not exists (select 1 from public.topics where id = new.topic_id and is_active)) then
      raise exception 'QB_VALIDATION: subject, chapter and topic must be active' using errcode = 'check_violation';
    end if;
  end if;

  -- ---- type-specific structure ----------------------------------------------
  select * into t from public.question_types where code = new.type_code;
  if not found then
    raise exception 'QB_VALIDATION: unknown question type %', new.type_code using errcode = 'check_violation';
  end if;

  if t.requires_context and coalesce(btrim(new.context), '') = '' then
    raise exception 'QB_VALIDATION: % questions require context', t.code using errcode = 'check_violation';
  end if;

  if t.kind = 'choice' or (t.kind = 'any' and new.options is not null) then
    -- ---------------------------------------------------------------- choice
    if new.options is null then
      raise exception 'QB_VALIDATION: options are required for %', t.code using errcode = 'check_violation';
    end if;
    n := jsonb_array_length(new.options);
    if n < greatest(t.min_options, 2) or n > t.max_options then
      raise exception 'QB_VALIDATION: % needs % to % options, got %',
        t.code, greatest(t.min_options, 2), t.max_options, n using errcode = 'check_violation';
    end if;

    v_ids := '{}';  v_norms := '{}';
    for i in 0 .. n - 1 loop
      opt := new.options -> i;
      if jsonb_typeof(opt) <> 'object'
         or (opt ->> 'id') is distinct from chr(65 + i)
         or char_length(btrim(coalesce(opt ->> 'text', ''))) not between 1 and 1000
         or exists (select 1 from jsonb_object_keys(opt) as kk where kk not in ('id', 'text')) then
        raise exception 'QB_VALIDATION: option % is invalid (ids must run A, B, C... with non-empty text)', i + 1
          using errcode = 'check_violation';
      end if;
      v_ids   := v_ids   || (opt ->> 'id');
      v_norms := v_norms || public.qb_norm(opt ->> 'text');   -- case-sensitive: Co and CO are different options
    end loop;

    if (select count(distinct x) from unnest(v_norms) as x) <> n then
      raise exception 'QB_VALIDATION: two options have identical text' using errcode = 'check_violation';
    end if;

    if new.match_items is not null then
      raise exception 'QB_VALIDATION: match_items not allowed for %', t.code using errcode = 'check_violation';
    end if;

    if jsonb_typeof(new.answer -> 'value') is distinct from 'string'
       or not ((new.answer ->> 'value') = any (v_ids))
       or exists (select 1 from jsonb_object_keys(new.answer) as kk where kk <> 'value') then
      raise exception 'QB_VALIDATION: answer must be {"value": <one of the option ids>}' using errcode = 'check_violation';
    end if;

  elsif t.kind = 'text' or t.kind = 'any' then
    -- ------------------------------------------------------------------ text
    if new.options is not null or new.match_items is not null then
      raise exception 'QB_VALIDATION: options/match_items not allowed for %', t.code using errcode = 'check_violation';
    end if;
    if jsonb_typeof(new.answer -> 'text') is distinct from 'string'
       or char_length(btrim(new.answer ->> 'text')) not between 1 and 10000
       or exists (select 1 from jsonb_object_keys(new.answer) as kk where kk <> 'text') then
      raise exception 'QB_VALIDATION: answer must be {"text": <non-empty string>}' using errcode = 'check_violation';
    end if;

  elsif t.kind = 'numeric' then
    -- --------------------------------------------------------------- numeric
    if new.options is not null or new.match_items is not null then
      raise exception 'QB_VALIDATION: options/match_items not allowed for %', t.code using errcode = 'check_violation';
    end if;
    if jsonb_typeof(new.answer -> 'number') is distinct from 'number'
       or exists (select 1 from jsonb_object_keys(new.answer) as kk where kk not in ('number', 'unit', 'tolerance'))
       or (new.answer ? 'unit' and jsonb_typeof(new.answer -> 'unit') not in ('string', 'null'))
       or (jsonb_typeof(new.answer -> 'unit') = 'string' and char_length(new.answer ->> 'unit') > 20)
       or (new.answer ? 'tolerance' and jsonb_typeof(new.answer -> 'tolerance') not in ('number', 'null'))
       or (jsonb_typeof(new.answer -> 'tolerance') = 'number' and (new.answer ->> 'tolerance')::numeric < 0) then
      raise exception 'QB_VALIDATION: answer must be {"number": n, "unit"?: s, "tolerance"?: n >= 0}' using errcode = 'check_violation';
    end if;

  elsif t.kind = 'match' then
    -- ----------------------------------------------------------------- match
    if new.options is not null then
      raise exception 'QB_VALIDATION: options not allowed for %', t.code using errcode = 'check_violation';
    end if;
    if new.match_items is null
       or jsonb_typeof(new.match_items -> 'left')  is distinct from 'array'
       or jsonb_typeof(new.match_items -> 'right') is distinct from 'array'
       or exists (select 1 from jsonb_object_keys(new.match_items) as kk where kk not in ('left', 'right')) then
      raise exception 'QB_VALIDATION: match_items must be {"left":[...],"right":[...]}' using errcode = 'check_violation';
    end if;
    n       := jsonb_array_length(new.match_items -> 'left');
    n_right := jsonb_array_length(new.match_items -> 'right');
    if n not between 2 and 10 or n_right not between 2 and 10 then
      raise exception 'QB_VALIDATION: each match list needs 2 to 10 items' using errcode = 'check_violation';
    end if;
    for i in 0 .. n - 1 loop
      opt := (new.match_items -> 'left') -> i;
      if jsonb_typeof(opt) <> 'object' or (opt ->> 'id') is distinct from chr(65 + i)
         or char_length(btrim(coalesce(opt ->> 'text', ''))) not between 1 and 500 then
        raise exception 'QB_VALIDATION: left item % invalid (ids A, B, C... with text)', i + 1 using errcode = 'check_violation';
      end if;
    end loop;
    for i in 0 .. n_right - 1 loop
      opt := (new.match_items -> 'right') -> i;
      if jsonb_typeof(opt) <> 'object' or (opt ->> 'id') is distinct from (i + 1)::text
         or char_length(btrim(coalesce(opt ->> 'text', ''))) not between 1 and 500 then
        raise exception 'QB_VALIDATION: right item % invalid (ids 1, 2, 3... with text)', i + 1 using errcode = 'check_violation';
      end if;
    end loop;
    v_pairs := new.answer -> 'pairs';
    if jsonb_typeof(v_pairs) is distinct from 'object'
       or (select count(*) from jsonb_object_keys(v_pairs)) <> n
       or exists (select 1 from jsonb_object_keys(new.answer) as kk where kk <> 'pairs') then
      raise exception 'QB_VALIDATION: answer must be {"pairs": {"A":"1", ...}} covering every left item' using errcode = 'check_violation';
    end if;
    for i in 0 .. n - 1 loop
      k := chr(65 + i);
      if jsonb_typeof(v_pairs -> k) is distinct from 'string'
         or not exists (select 1 from jsonb_array_elements(new.match_items -> 'right') as r where r ->> 'id' = v_pairs ->> k) then
        raise exception 'QB_VALIDATION: pair for % must reference a right item id', k using errcode = 'check_violation';
      end if;
    end loop;
  end if;

  -- ---- derived columns -------------------------------------------------------
  new.content_hash    := public.qb_content_hash(new.type_code, new.question_text, new.context, new.options, new.match_items);
  new.normalized_text := public.qb_normalized_text(new.question_text, new.options);

  select string_agg(o ->> 'text', ' ') into v_opt_txt
    from jsonb_array_elements(coalesce(new.options, '[]'::jsonb)) as o;
  select string_agg(m ->> 'text', ' ') into v_mat_txt
    from jsonb_array_elements(coalesce(new.match_items -> 'left', '[]'::jsonb)
                              || coalesce(new.match_items -> 'right', '[]'::jsonb)) as m;

  new.search_vector :=
       setweight(to_tsvector('english', coalesce(new.question_text, '') || ' ' || coalesce(new.context, '')), 'A')
    || setweight(to_tsvector('english', coalesce(v_opt_txt, '') || ' ' || coalesce(v_mat_txt, '') || ' '
                                        || array_to_string(new.tags, ' ')), 'B')
    || setweight(to_tsvector('english', coalesce(new.explanation, '') || ' ' || coalesce(new.answer ->> 'text', '')), 'C');

  -- ---- lifecycle timestamps ---------------------------------------------------
  if new.status = 'published' and (tg_op = 'INSERT' or old.status <> 'published') then
    new.published_at := now();
  end if;

  return new;
end $$;

create trigger questions_biu before insert or update on public.questions
  for each row execute function public.qb_questions_biu();
