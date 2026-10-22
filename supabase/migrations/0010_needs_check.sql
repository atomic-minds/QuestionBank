-- 0010_needs_check.sql — a "Needs checking" list for questions an AI answered.
--
-- The "AI-solved, please check" marker already exists (0008). This adds:
--   * qb_search_questions(... p_needs_check ...): admin only. true = only the questions still marked.
--     (A new argument, so the old signature is replaced. The public site never passes it.)
--   * qb_admin_stats(): also returns "ai_unchecked", the number of questions still waiting for a check.
-- Safe to run twice. Run it BEFORE uploading the new site files.

drop function if exists public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, text, integer, integer);

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
  p_needs_check boolean default null,      -- admin only: true = only questions still marked "AI-solved, please check"
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
  if p_needs_check is not null and not v_admin then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
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
      and (p_needs_check is not true or exists (select 1 from public.question_ai_check k where k.question_id = q.id))
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

revoke all on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, boolean, text, integer, integer) from public, anon, authenticated;
grant execute on function public.qb_search_questions(text, smallint, integer, integer, text, text, smallint, smallint, text, numeric, text, text, text, boolean, text, integer, integer) to anon, authenticated;

-- Dashboard numbers: adds ai_unchecked.
create or replace function public.qb_admin_stats() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_day date := public.qb_ai_day();
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'by_status', coalesce((select jsonb_object_agg(status, n)
                           from (select status, count(*)::int as n from public.questions group by 1) s), '{}'::jsonb),
    'ai_used_today', coalesce((select used from public.ai_usage where day = v_day), 0),
    'ai_day', v_day,
    'ai_unchecked', (select count(*)::int from public.question_ai_check),
    'image_count', (select count(*)::int from public.question_images),
    'image_bytes', (select coalesce(sum(bytes), 0)::bigint from public.question_images));
end $$;
