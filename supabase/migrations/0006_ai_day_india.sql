-- =============================================================================
-- 0006: the daily AI counter now runs on India time, and failed reads can be refunded.
--
-- Before: the "day" rolled over at midnight US Pacific (about 12:30 pm in India), which is when
-- Google's own free-tier counter resets. For a single owner in India, a midnight (12:00 am IST)
-- reset is easier to follow. Google's OWN limit is separate and still resets on Pacific time;
-- this counter is only this app's own safety cap.
--
-- To change the time zone later, edit the one name in qb_ai_day() below and run it again.
-- Safe to run more than once.
-- =============================================================================

create or replace function public.qb_ai_day() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;
revoke all on function public.qb_ai_day() from public, anon, authenticated;

create or replace function public.qb_consume_ai_quota(p_limit integer) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_day  date := public.qb_ai_day();
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

-- Give one read back when Google refused or failed the request (it did no useful work).
create or replace function public.qb_refund_ai_quota(p_day date) returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_used integer;
begin
  if not public.is_admin() then
    raise exception 'QB_FORBIDDEN: admin only' using errcode = '42501';
  end if;
  update public.ai_usage set used = greatest(used - 1, 0) where day = p_day returning used into v_used;
  return jsonb_build_object('ok', true, 'used', coalesce(v_used, 0));
end $$;
revoke all on function public.qb_refund_ai_quota(date) from public, anon, authenticated;
grant execute on function public.qb_refund_ai_quota(date) to authenticated;

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
    'ai_day', v_day);
end $$;
