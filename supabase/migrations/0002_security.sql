-- =============================================================================
-- 0002_security.sql — admin identity, Row Level Security, grants
--
-- Model
--   * Supabase Auth proves WHO someone is. The admin_users table says WHO MAY
--     ADMINISTER. Public sign-ups are disabled in the Supabase dashboard, but
--     even if someone did register, they would not be an admin: every write
--     policy below calls is_admin().
--   * anon has NO direct access to questions / question_exams. Public reads go
--     through audited RPCs (0003_api.sql) that only ever return published rows.
--   * Everything here is enforced by Postgres, not by frontend code.
-- =============================================================================

create table public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and exists (select 1 from public.admin_users where user_id = auth.uid());
$$;

-- Daily AI call counter (protects the Gemini free quota). Written only by
-- qb_consume_ai_quota(); no direct table access for any API role.
create table public.ai_usage (
  day  date primary key,
  used integer not null default 0 check (used >= 0)
);

-- -----------------------------------------------------------------------------
-- Row Level Security
-- -----------------------------------------------------------------------------
alter table public.question_types    enable row level security;
alter table public.subjects          enable row level security;
alter table public.chapters          enable row level security;
alter table public.topics            enable row level security;
alter table public.exams             enable row level security;
alter table public.question_counters enable row level security;
alter table public.questions         enable row level security;
alter table public.question_exams    enable row level security;
alter table public.admin_users       enable row level security;
alter table public.ai_usage          enable row level security;

-- Question types: readable by everyone, changed only by migrations.
create policy question_types_read on public.question_types
  for select to anon, authenticated using (true);

-- Master data: active rows are public, admins see and change everything.
create policy subjects_read on public.subjects for select to anon, authenticated
  using (is_active or public.is_admin());
create policy subjects_admin on public.subjects for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy chapters_read on public.chapters for select to anon, authenticated
  using (is_active or public.is_admin());
create policy chapters_admin on public.chapters for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy topics_read on public.topics for select to anon, authenticated
  using (is_active or public.is_admin());
create policy topics_admin on public.topics for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy exams_read on public.exams for select to anon, authenticated
  using (is_active or public.is_admin());
create policy exams_admin on public.exams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Questions: admin only at the table level (public reads use RPCs).
create policy questions_admin on public.questions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy question_exams_admin on public.question_exams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- A signed-in user may check whether they themselves are an admin (UI gating
-- only; real enforcement is in the policies above).
create policy admin_users_self on public.admin_users for select to authenticated
  using (user_id = auth.uid());

-- question_counters and ai_usage intentionally have no policies: only the
-- SECURITY DEFINER functions can touch them.

-- -----------------------------------------------------------------------------
-- Grants. Supabase grants broad default privileges to anon/authenticated, so
-- strip them first and grant back only what is needed.
-- -----------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.question_types to anon, authenticated;
grant select on public.subjects, public.chapters, public.topics, public.exams to anon, authenticated;
grant insert, update, delete on public.subjects, public.chapters, public.topics, public.exams to authenticated;

grant select, insert, update, delete on public.questions, public.question_exams to authenticated;
grant select on public.admin_users to authenticated;
