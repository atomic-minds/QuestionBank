-- =============================================================================
-- 0008: "answer written by AI, please check" marker (admin screens only).
--
-- When the AI writes or solves an answer, the question is flagged here until the admin presses
-- "Mark as checked". The flag is NEVER visible to the public: the table has no grants and no
-- policies, and only these functions touch it:
--     qb_get_ai_checks(ids)        admin only -> {"<question uuid>": true, ...} for the flagged ids
--     qb_set_ai_check(id, on)      admin only
-- Deleting a question deletes its flag (foreign key cascade).
--
-- Safe to run more than once.
-- =============================================================================

create table if not exists public.question_ai_check (
  question_id uuid primary key references public.questions(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.question_ai_check enable row level security;
revoke all on public.question_ai_check from anon, authenticated;

create or replace function public.qb_set_ai_check(p_question uuid, p_on boolean) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  if coalesce(p_on, false) then
    if not exists (select 1 from public.questions where id = p_question) then
      raise exception 'QB_NOT_FOUND: that question does not exist' using errcode = 'no_data_found';
    end if;
    insert into public.question_ai_check (question_id) values (p_question) on conflict (question_id) do nothing;
  else
    delete from public.question_ai_check where question_id = p_question;
  end if;
  return jsonb_build_object('ok', true, 'on', coalesce(p_on, false));
end $$;

create or replace function public.qb_get_ai_checks(p_ids uuid[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when public.is_admin()
              then coalesce((select jsonb_object_agg(c.question_id::text, true)
                               from public.question_ai_check c
                              where c.question_id = any ((p_ids)[1:500])), '{}'::jsonb)
              else '{}'::jsonb end
$$;

revoke all on function public.qb_set_ai_check(uuid, boolean) from public, anon, authenticated;
revoke all on function public.qb_get_ai_checks(uuid[])       from public, anon, authenticated;
grant execute on function public.qb_set_ai_check(uuid, boolean) to authenticated;
grant execute on function public.qb_get_ai_checks(uuid[])       to authenticated;
