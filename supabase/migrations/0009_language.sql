-- 0009_language.sql — Language filter (Bengali / English) for questions.
--
-- Every question gets a "language" that the database works out by itself:
--   'bn'  when the question text (or its passage) contains Bengali letters (U+0980 to U+09FF)
--   'en'  otherwise
-- Nothing has to be typed in, old questions are covered at once, and it can never go out of date
-- because it is recomputed whenever the question text changes. Safe to run twice.

alter table public.questions
  add column if not exists language text
  generated always as (
    case when question_text ~ '[\u0980-\u09FF]' or context ~ '[\u0980-\u09FF]' then 'bn' else 'en' end
  ) stored;

-- Search: same function as before plus p_language (a new argument, so the old signature is replaced).
drop function if exists public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, integer, integer);

create or replace function public.qb_search_questions(
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
  p_language   text default null,          -- 'bn' (Bengali) | 'en' (English)
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
  if p_language is not null and p_language not in ('bn', 'en') then
    raise exception 'QB_VALIDATION: language must be bn or en' using errcode = 'check_violation';
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
      and (p_language   is null or q.language = p_language)
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

revoke all on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, text, integer, integer) to anon, authenticated;

-- Facets: adds the question counts per language (same signature, so it is simply replaced).
create or replace function public.qb_facets(
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
    'languages', coalesce((
      select jsonb_agg(jsonb_build_object('value', l, 'count', n) order by case l when 'bn' then 1 else 2 end)
      from (select q.language as l, count(*)::int as n from public.questions q
            where q.id in (select id from base) group by 1) z), '[]'::jsonb),
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

revoke all on function public.qb_facets(smallint, integer, integer) from public, anon, authenticated;
grant execute on function public.qb_facets(smallint, integer, integer) to anon, authenticated;
