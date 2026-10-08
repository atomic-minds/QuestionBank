-- =============================================================================
-- 0003_api.sql — the RPC surface used by the website and Edge Functions
--
--   Public (anon + authenticated; published questions only, unless admin)
--     qb_search_questions, qb_get_question, qb_taxonomy_tree, qb_facets,
--     qb_search_taxonomy
--   Admin only (checked inside the function AND by RLS)
--     qb_find_duplicates, qb_save_question, qb_consume_ai_quota, qb_admin_stats
--
-- All queries are paginated and indexed. Nothing returns an unbounded set.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Duplicate detection (admin): exact via content hash, near via trigram.
-- -----------------------------------------------------------------------------
create function public.qb_find_duplicates(
  p_type      text,
  p_question  text,
  p_context   text,
  p_options   jsonb,
  p_match     jsonb,
  p_exclude   uuid default null,
  p_threshold real default 0.8,
  p_limit     integer default 5
) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_hash text;
  v_norm text;
  v_res  jsonb;
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;

  v_hash := public.qb_content_hash(p_type, p_question, p_context,
                                   nullif(p_options, 'null'::jsonb), nullif(p_match, 'null'::jsonb));
  v_norm := public.qb_normalized_text(p_question, nullif(p_options, 'null'::jsonb));

  perform set_config('pg_trgm.similarity_threshold',
                     least(greatest(coalesce(p_threshold, 0.8), 0.3), 1.0)::text, true);

  select coalesce(jsonb_agg(to_jsonb(r) order by r.exact desc, r.similarity desc), '[]'::jsonb)
    into v_res
  from (
    select q.id, q.public_id, q.status, q.type_code, q.question_text, q.answer,
           (q.content_hash = v_hash)                          as exact,
           extensions.similarity(q.normalized_text, v_norm)   as similarity
    from public.questions q
    where q.status <> 'archived'
      and (p_exclude is null or q.id <> p_exclude)
      and (q.content_hash = v_hash or q.normalized_text operator(extensions.%) v_norm)
    order by (q.content_hash = v_hash) desc, extensions.similarity(q.normalized_text, v_norm) desc
    limit least(greatest(coalesce(p_limit, 5), 1), 20)
  ) r;

  return v_res;
end $$;

-- -----------------------------------------------------------------------------
-- Atomic create/update of a question plus its exam appearances (admin).
-- SECURITY INVOKER on purpose: RLS and table grants apply as a second guard.
-- -----------------------------------------------------------------------------
create function public.qb_save_question(p jsonb) returns jsonb
language plpgsql security invoker set search_path = public, extensions as $$
declare
  v_id       uuid    := nullif(p ->> 'id', '')::uuid;
  v_expected integer := nullif(p ->> 'expected_version', '')::integer;
  v_options  jsonb   := nullif(p -> 'options', 'null'::jsonb);
  v_match    jsonb   := nullif(p -> 'match_items', 'null'::jsonb);
  v_tags     text[]  := case when jsonb_typeof(p -> 'tags') = 'array'
                             then array(select jsonb_array_elements_text(p -> 'tags'))
                             else '{}'::text[] end;
  q          public.questions;
begin
  if v_id is null then
    insert into public.questions (
      subject_id, chapter_id, topic_id, type_code, context, question_text, options, match_items,
      answer, explanation, difficulty, marks, tags, status, origin, source_ref,
      public_id, content_hash, normalized_text, search_vector)
    values (
      (p ->> 'subject_id')::smallint, (p ->> 'chapter_id')::integer, nullif(p ->> 'topic_id', '')::integer,
      p ->> 'type_code', nullif(p ->> 'context', ''), p ->> 'question_text', v_options, v_match,
      p -> 'answer', nullif(p ->> 'explanation', ''), nullif(p ->> 'difficulty', ''),
      nullif(p ->> 'marks', '')::numeric, v_tags, coalesce(nullif(p ->> 'status', ''), 'draft'),
      coalesce(nullif(p ->> 'origin', ''), 'manual'), nullif(p ->> 'source_ref', ''),
      nullif(p ->> 'public_id', ''),       -- normally null (minted); set only when restoring a backup
      '', '', ''::tsvector)                -- derived columns, overwritten by the trigger
    returning * into q;
  else
    update public.questions set
      subject_id = (p ->> 'subject_id')::smallint,
      chapter_id = (p ->> 'chapter_id')::integer,
      topic_id = nullif(p ->> 'topic_id', '')::integer,
      type_code = p ->> 'type_code',
      context = nullif(p ->> 'context', ''),
      question_text = p ->> 'question_text',
      options = v_options,
      match_items = v_match,
      answer = p -> 'answer',
      explanation = nullif(p ->> 'explanation', ''),
      difficulty = nullif(p ->> 'difficulty', ''),
      marks = nullif(p ->> 'marks', '')::numeric,
      tags = v_tags,
      status = coalesce(nullif(p ->> 'status', ''), status),
      source_ref = nullif(p ->> 'source_ref', '')
    where id = v_id and (v_expected is null or version = v_expected)
    returning * into q;

    if not found then
      if exists (select 1 from public.questions where id = v_id) then
        raise exception 'QB_CONFLICT: question was changed by someone else; reload and retry'
          using errcode = 'serialization_failure';
      end if;
      raise exception 'QB_NOT_FOUND: question does not exist' using errcode = 'no_data_found';
    end if;

    if p ? 'exams' then
      delete from public.question_exams where question_id = q.id;
    end if;
  end if;

  if jsonb_typeof(p -> 'exams') = 'array' then
    insert into public.question_exams (question_id, exam_id, year, paper)
    select q.id, (x ->> 'exam_id')::smallint, nullif(x ->> 'year', '')::smallint, nullif(x ->> 'paper', '')
    from jsonb_array_elements(p -> 'exams') as x;
  end if;

  return jsonb_build_object('id', q.id, 'public_id', q.public_id, 'version', q.version,
                            'status', q.status);
end $$;

-- -----------------------------------------------------------------------------
-- Public search / browse. One function, one visibility rule:
--   admin  -> every status (optionally filtered with p_status)
--   others -> published only
-- -----------------------------------------------------------------------------
create function public.qb_search_questions(
  p_q          text default null,
  p_subject    smallint default null,
  p_chapter    integer default null,
  p_topic      integer default null,
  p_type       text default null,
  p_category   text default null,          -- 'exam' | 'general'
  p_exam       smallint default null,
  p_year       smallint default null,
  p_difficulty text default null,
  p_marks      numeric default null,
  p_tag        text default null,
  p_status     text default null,          -- honoured for admins only
  p_public_id  text default null,
  p_limit      integer default 20,
  p_offset     integer default 0
) returns jsonb
language plpgsql stable security definer
set search_path = public, extensions
set plan_cache_mode = force_custom_plan as $$
declare
  v_admin boolean := public.is_admin();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), case when public.is_admin() then 500 else 50 end);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_has_q boolean := p_q is not null and btrim(p_q) <> '';
  v_tsq   tsquery;
  v_like  text;
  v_rows  jsonb;
  v_more  boolean;
begin
  if p_category is not null and p_category not in ('exam', 'general') then
    raise exception 'QB_VALIDATION: category must be exam or general' using errcode = 'check_violation';
  end if;

  if v_has_q then
    v_tsq  := websearch_to_tsquery('english', left(p_q, 200));
    v_like := '%' || replace(replace(replace(public.qb_norm_ci(left(p_q, 200)), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  select coalesce(jsonb_agg(
           (to_jsonb(p) - 'rank') || jsonb_build_object('exams', coalesce((
              select jsonb_agg(jsonb_build_object('exam_id', e.id, 'code', e.code, 'name', e.name,
                                                  'year', x.year, 'paper', x.paper)
                               order by x.year desc nulls last, e.code)
              from public.question_exams x
              join public.exams e on e.id = x.exam_id
              where x.question_id = p.id), '[]'::jsonb))
           order by p.rank desc, p.public_id), '[]'::jsonb)
    into v_rows
  from (
    select q.id, q.public_id, q.type_code, q.context, q.question_text, q.options, q.match_items,
           q.answer, q.explanation, q.difficulty, q.marks, q.tags, q.subject_id, q.chapter_id,
           q.topic_id, q.status, q.origin, q.source_ref, q.version, q.created_at, q.updated_at,
           q.published_at,
           (case when v_has_q then ts_rank_cd(q.search_vector, v_tsq) else 0 end)::real as rank
    from public.questions q
    where (case when v_admin then (p_status is null or q.status = p_status)
                else q.status = 'published' end)
      and (p_public_id is null or q.public_id = upper(btrim(p_public_id)))
      and (p_subject    is null or q.subject_id = p_subject)
      and (p_chapter    is null or q.chapter_id = p_chapter)
      and (p_topic      is null or q.topic_id   = p_topic)
      and (p_type       is null or q.type_code  = p_type)
      and (p_difficulty is null or q.difficulty = p_difficulty)
      and (p_marks      is null or q.marks      = p_marks)
      and (p_tag        is null or lower(btrim(p_tag)) = any (q.tags))
      and (p_category is null
           or (p_category = 'exam'    and     exists (select 1 from public.question_exams x where x.question_id = q.id))
           or (p_category = 'general' and not exists (select 1 from public.question_exams x where x.question_id = q.id)))
      and (p_exam is null and p_year is null
           or exists (select 1 from public.question_exams x
                      where x.question_id = q.id
                        and (p_exam is null or x.exam_id = p_exam)
                        and (p_year is null or x.year    = p_year)))
      and (not v_has_q or q.search_vector @@ v_tsq or q.normalized_text like v_like)
    order by (case when v_has_q then ts_rank_cd(q.search_vector, v_tsq) else 0 end) desc, q.public_id
    limit v_limit + 1 offset v_offset
  ) p;

  v_more := jsonb_array_length(v_rows) > v_limit;
  if v_more then
    v_rows := v_rows - v_limit;
  end if;

  return jsonb_build_object('items', v_rows, 'has_more', v_more, 'limit', v_limit, 'offset', v_offset);
end $$;

create function public.qb_get_question(p_public_id text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select public.qb_search_questions(p_public_id := p_public_id, p_limit := 1) -> 'items' -> 0;
$$;

-- -----------------------------------------------------------------------------
-- Subject > Chapter > Topic tree with published-question counts (public).
-- -----------------------------------------------------------------------------
create function public.qb_taxonomy_tree() returns jsonb
language sql stable security definer set search_path = public as $$
  with qc as (
    select subject_id, chapter_id, topic_id, count(*)::int as n
    from public.questions where status = 'published' group by 1, 2, 3
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'code', s.code, 'name', s.name, 'slug', s.slug,
    'count', coalesce((select sum(n) from qc where qc.subject_id = s.id), 0)::int,
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'name', c.name, 'slug', c.slug,
        'count', coalesce((select sum(n) from qc where qc.chapter_id = c.id), 0)::int,
        'topics', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', t.id, 'name', t.name, 'slug', t.slug,
            'count', coalesce((select sum(n) from qc where qc.topic_id = t.id), 0)::int)
            order by t.sort_order, t.name)
          from public.topics t where t.chapter_id = c.id and t.is_active), '[]'::jsonb))
        order by c.sort_order, c.name)
      from public.chapters c where c.subject_id = s.id and c.is_active), '[]'::jsonb))
    order by s.sort_order, s.name), '[]'::jsonb)
  from public.subjects s where s.is_active;
$$;

-- -----------------------------------------------------------------------------
-- Filter facets (types, exams, years, difficulty, marks, tags) within a scope.
-- -----------------------------------------------------------------------------
create function public.qb_facets(
  p_subject smallint default null,
  p_chapter integer default null,
  p_topic   integer default null
) returns jsonb
language sql stable security definer set search_path = public as $$
  with base as (
    select q.id, q.type_code, q.difficulty, q.marks, q.tags
    from public.questions q
    where q.status = 'published'
      and (p_subject is null or q.subject_id = p_subject)
      and (p_chapter is null or q.chapter_id = p_chapter)
      and (p_topic   is null or q.topic_id   = p_topic)
  )
  select jsonb_build_object(
    'total', (select count(*)::int from base),
    'general', (select count(*)::int from base b
                where not exists (select 1 from public.question_exams x where x.question_id = b.id)),
    'exam', (select count(*)::int from base b
             where exists (select 1 from public.question_exams x where x.question_id = b.id)),
    'types', coalesce((
      select jsonb_agg(jsonb_build_object('code', t.code, 'label', t.label, 'count', c.n) order by t.sort_order)
      from (select type_code, count(*)::int as n from base group by 1) c
      join public.question_types t on t.code = c.type_code), '[]'::jsonb),
    'difficulty', coalesce((
      select jsonb_agg(jsonb_build_object('value', d, 'count', n)
                       order by case d when 'easy' then 1 when 'medium' then 2 else 3 end)
      from (select difficulty as d, count(*)::int as n from base where difficulty is not null group by 1) z), '[]'::jsonb),
    'marks', coalesce((
      select jsonb_agg(jsonb_build_object('value', m, 'count', n) order by m)
      from (select marks as m, count(*)::int as n from base where marks is not null group by 1) z), '[]'::jsonb),
    'exams', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'code', e.code, 'name', e.name, 'count', c.n)
                       order by e.sort_order, e.code)
      from (select x.exam_id, count(distinct b.id)::int as n
            from base b join public.question_exams x on x.question_id = b.id group by 1) c
      join public.exams e on e.id = c.exam_id), '[]'::jsonb),
    'years', coalesce((
      select jsonb_agg(jsonb_build_object('value', y, 'count', n) order by y desc)
      from (select x.year as y, count(distinct b.id)::int as n
            from base b join public.question_exams x on x.question_id = b.id
            where x.year is not null group by 1) z), '[]'::jsonb),
    'tags', coalesce((
      select jsonb_agg(jsonb_build_object('value', tg, 'count', n) order by n desc, tg)
      from (select tg, count(*)::int as n from base b, unnest(b.tags) as tg
            group by 1 order by 2 desc, 1 limit 30) z), '[]'::jsonb)
  );
$$;

-- -----------------------------------------------------------------------------
-- Taxonomy name search for the global search box ("Solid State" -> chapter link).
-- SECURITY INVOKER: RLS already hides inactive master data from anon.
-- -----------------------------------------------------------------------------
create function public.qb_search_taxonomy(p_q text) returns jsonb
language sql stable security invoker set search_path = public as $$
  with pat as (
    select '%' || replace(replace(replace(lower(btrim(left(coalesce(p_q, ''), 100))), '\', '\\'), '%', '\%'), '_', '\_') || '%' as p,
           btrim(coalesce(p_q, '')) <> '' as ok
  )
  select jsonb_build_object(
    'chapters', coalesce((
      select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'slug', c.slug,
                                          'subject_name', s.name, 'subject_slug', s.slug) order by c.name)
      from (select * from public.chapters ch, pat where pat.ok and ch.is_active and lower(ch.name) like pat.p
            order by ch.name limit 8) c
      join public.subjects s on s.id = c.subject_id and s.is_active), '[]'::jsonb),
    'topics', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'slug', t.slug,
                                          'chapter_name', c.name, 'chapter_slug', c.slug,
                                          'subject_name', s.name, 'subject_slug', s.slug) order by t.name)
      from (select * from public.topics tp, pat where pat.ok and tp.is_active and lower(tp.name) like pat.p
            order by tp.name limit 8) t
      join public.chapters c on c.id = t.chapter_id and c.is_active
      join public.subjects s on s.id = c.subject_id and s.is_active), '[]'::jsonb));
$$;

-- -----------------------------------------------------------------------------
-- AI quota guard + admin dashboard stats (admin only).
-- The day rolls over at midnight US Pacific, which is when Gemini free-tier
-- daily limits reset, so "used today" matches Google's own counter.
-- -----------------------------------------------------------------------------
create function public.qb_consume_ai_quota(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_day  date := (now() at time zone 'America/Los_Angeles')::date;
  v_used integer;
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 0 then
    raise exception 'QB_VALIDATION: limit must be >= 0' using errcode = 'check_violation';
  end if;

  delete from public.ai_usage where day < v_day - 30;
  insert into public.ai_usage (day, used) values (v_day, 0) on conflict (day) do nothing;

  update public.ai_usage set used = used + 1
   where day = v_day and used < p_limit
  returning used into v_used;

  if v_used is null then
    select used into v_used from public.ai_usage where day = v_day;
    return jsonb_build_object('allowed', false, 'used', v_used, 'limit', p_limit, 'day', v_day);
  end if;
  return jsonb_build_object('allowed', true, 'used', v_used, 'limit', p_limit, 'day', v_day);
end $$;

create function public.qb_admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_day date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'by_status', coalesce((select jsonb_object_agg(status, n)
                           from (select status, count(*)::int as n from public.questions group by 1) s), '{}'::jsonb),
    'ai_used_today', coalesce((select used from public.ai_usage where day = v_day), 0),
    'ai_day', v_day);
end $$;

-- -----------------------------------------------------------------------------
-- Execute privileges. Postgres grants EXECUTE to PUBLIC by default and Supabase
-- adds anon/authenticated on top, so revoke everything, then grant explicitly.
-- (The pure, immutable helpers qb_norm*, qb_content_hash, qb_tags_valid stay
-- executable: a CHECK constraint runs them as the calling role.)
-- -----------------------------------------------------------------------------
revoke all on function public.qb_next_public_id(smallint)                                       from public, anon, authenticated;
revoke all on function public.qb_register_public_id(smallint, text)                             from public, anon, authenticated;
revoke all on function public.qb_questions_biu()                                                from public, anon, authenticated;
revoke all on function public.qb_subjects_bu()                                                  from public, anon, authenticated;
revoke all on function public.is_admin()                                                        from public, anon, authenticated;
revoke all on function public.qb_find_duplicates(text, text, text, jsonb, jsonb, uuid, real, integer) from public, anon, authenticated;
revoke all on function public.qb_save_question(jsonb)                                           from public, anon, authenticated;
revoke all on function public.qb_consume_ai_quota(integer)                                      from public, anon, authenticated;
revoke all on function public.qb_admin_stats()                                                  from public, anon, authenticated;
revoke all on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.qb_get_question(text)                                             from public, anon, authenticated;
revoke all on function public.qb_taxonomy_tree()                                                from public, anon, authenticated;
revoke all on function public.qb_facets(smallint, integer, integer)                             from public, anon, authenticated;
revoke all on function public.qb_search_taxonomy(text)                                          from public, anon, authenticated;

grant execute on function public.is_admin()                                                     to anon, authenticated;
grant execute on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, integer, integer) to anon, authenticated;
grant execute on function public.qb_get_question(text)                                          to anon, authenticated;
grant execute on function public.qb_taxonomy_tree()                                             to anon, authenticated;
grant execute on function public.qb_facets(smallint, integer, integer)                          to anon, authenticated;
grant execute on function public.qb_search_taxonomy(text)                                       to anon, authenticated;

grant execute on function public.qb_find_duplicates(text, text, text, jsonb, jsonb, uuid, real, integer) to authenticated;
grant execute on function public.qb_save_question(jsonb)                                        to authenticated;
grant execute on function public.qb_consume_ai_quota(integer)                                   to authenticated;
grant execute on function public.qb_admin_stats()                                               to authenticated;
