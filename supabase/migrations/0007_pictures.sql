-- =============================================================================
-- 0007: one optional picture per question (a structure, apparatus, graph ...).
--
-- Pictures are shrunk in the browser (about 800 px wide, usually 20-60 KB) and stored in the
-- database as base64 text, so no extra service, bucket or account is needed. They count toward
-- the free 500 MB database limit, which the dashboard already shows.
--
--   * Nobody can read or write the table directly (no grants, RLS on, no policies).
--   * Everything goes through three functions:
--       qb_get_images(ids)        public: pictures of PUBLISHED questions only (admins see all)
--       qb_set_question_image()   admin only
--       qb_clear_question_image() admin only
--   * Deleting a question deletes its picture (foreign key cascade).
--
-- Safe to run more than once.
-- =============================================================================

create table if not exists public.question_images (
  question_id uuid primary key references public.questions(id) on delete cascade,
  mime        text not null check (mime in ('image/webp', 'image/jpeg', 'image/png')),
  data        text not null check (char_length(data) between 100 and 220000 and data ~ '^[A-Za-z0-9+/]+={0,2}$'),
  bytes       integer not null check (bytes between 50 and 165000),
  updated_at  timestamptz not null default now()
);
alter table public.question_images enable row level security;
revoke all on public.question_images from anon, authenticated;

create or replace function public.qb_set_question_image(p_question uuid, p_mime text, p_data text) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_bytes integer;
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  if p_mime is null or p_mime not in ('image/webp', 'image/jpeg', 'image/png') then
    raise exception 'QB_VALIDATION: the picture must be WebP, JPEG or PNG' using errcode = 'check_violation';
  end if;
  if p_data is null or char_length(p_data) < 100 or char_length(p_data) > 220000 or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'QB_VALIDATION: the picture is empty, too large (limit about 160 KB) or not valid' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.questions where id = p_question) then
    raise exception 'QB_NOT_FOUND: that question does not exist' using errcode = 'no_data_found';
  end if;
  v_bytes := (char_length(p_data) * 3) / 4 - (length(p_data) - length(rtrim(p_data, '=')));
  insert into public.question_images (question_id, mime, data, bytes)
  values (p_question, p_mime, p_data, v_bytes)
  on conflict (question_id) do update set mime = excluded.mime, data = excluded.data, bytes = excluded.bytes, updated_at = now();
  return jsonb_build_object('ok', true, 'bytes', v_bytes);
end $$;

create or replace function public.qb_clear_question_image(p_question uuid) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  delete from public.question_images where question_id = p_question;
  return jsonb_build_object('ok', true);
end $$;

-- {"<question uuid>": {"mime": "...", "data": "<base64>"}, ...}  for the ids that have a picture.
create or replace function public.qb_get_images(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(i.question_id::text, jsonb_build_object('mime', i.mime, 'data', i.data)), '{}'::jsonb)
    from public.question_images i
    join public.questions q on q.id = i.question_id
   where i.question_id = any ((p_ids)[1:40])
     and (q.status = 'published' or public.is_admin())
$$;

-- The dashboard also shows how many pictures there are and how much room they take.
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
    'image_count', (select count(*)::int from public.question_images),
    'image_bytes', (select coalesce(sum(bytes), 0)::bigint from public.question_images));
end $$;

revoke all on function public.qb_set_question_image(uuid, text, text) from public, anon, authenticated;
revoke all on function public.qb_clear_question_image(uuid)           from public, anon, authenticated;
revoke all on function public.qb_get_images(uuid[])                   from public, anon, authenticated;
grant execute on function public.qb_set_question_image(uuid, text, text) to authenticated;
grant execute on function public.qb_clear_question_image(uuid)           to authenticated;
grant execute on function public.qb_get_images(uuid[])                   to anon, authenticated;
