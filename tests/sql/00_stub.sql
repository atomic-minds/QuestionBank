-- =============================================================================
-- tests/sql/00_stub.sql — a minimal imitation of what Supabase provides, so the
-- REAL migrations can run on a plain local Postgres. Test-only; never deployed.
-- =============================================================================
create schema if not exists extensions;
create schema if not exists auth;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon')         then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create table auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

-- Same logic as Supabase's auth.uid(): reads the JWT subject set per request.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

grant usage on schema public, extensions, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- Supabase hands the API roles broad default privileges on new objects. Mimic it
-- so the tests prove our explicit REVOKEs are what actually lock things down.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Supabase's default search_path for the database.
do $$
begin
  execute format('alter database %I set search_path = "$user", public, extensions', current_database());
end $$;
