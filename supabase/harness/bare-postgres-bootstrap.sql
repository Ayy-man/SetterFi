-- Replaying the migrations on a bare Postgres, for machines with no Docker.
--
-- `supabase start` needs Docker. Where Docker is unavailable this stands the schema up on a plain
-- Postgres instead: `20260813000001_init.sql` was written to apply either way (it creates the
-- `extensions` schema and widens `search_path` so `vector(1536)` resolves), and the only thing
-- missing is the scaffolding Supabase itself provides. That is what this file supplies -- the roles
-- the grants name, and the four `auth` objects the schema actually touches. It is not a
-- reimplementation of Supabase.
--
-- ============================================================================
-- THIS HARNESS CERTIFIES A DIFF, NOT A STATE.
-- ============================================================================
--
-- Run the suite at your parent commit, run it at your commit, and compare the two failure sets.
-- What a run tells you is whether *your* commit moved the failure set. That is the only claim it
-- is entitled to make, and it stays true even when the absolute number is zero.
--
-- Known failures at HEAD on 2026-09-01, after the scaffolding below was finished: none. The suite
-- is 388/388 on this harness. Treat any failure you see as yours until you have shown otherwise by
-- re-running at your parent commit -- do not assume it is a pre-existing hole, because right now
-- there are none to inherit.
--
-- That "none" was expensive and it is worth saying why. An earlier draft of this file shipped an
-- enumerated list of six tests it described as failing at HEAD "for reasons that have nothing to
-- do with any change under test." Every one of those six was a defect in this file. The list was
-- an alibi for incomplete scaffolding, dressed as a fact about the tree, and it would have taught
-- everyone who read it to discount six real assertions. If you find yourself adding a name to a
-- known-failures list here, the burden is to show the failure survives a correct harness -- the
-- list is the last resort, not the first explanation.
--
-- ============================================================================
-- Four details that each cost an hour, and each looked like a bug in the tree
-- ============================================================================
--
-- Every one of these presents as a plausible application failure. That is what makes them
-- expensive: the harness fails in the vocabulary of the code under test.
--
-- * **`service_role` needs `bypassrls`.** Supabase documents this role as the one PostgREST uses
--   "to bypass Row Level Security" (supabase.com/docs/guides/database/postgres/roles, checked
--   2026-09-01); the mechanism is the role attribute, and `create role` does not give it to you.
--   Without it, thirteen tests fail as though tenant isolation were leaking into privileged paths.
--   `rls.test.ts > platform roles > service_role bypasses RLS to record privileged actions` names
--   the cause outright, which is the only reason this was an hour and not a day.
--
-- * **The `extensions` schema needs `usage` granted.** pgvector installs into `extensions`, and a
--   role that cannot see the schema cannot resolve the type in it. The tests cast `$2::vector`
--   while running `set role service_role`, so this surfaces as `type "vector" does not exist` --
--   which reads as a missing extension, and sends you to check `create extension` instead of the
--   grant. `select '[1,2]'::vector` as `postgres` succeeds the whole time.
--
-- * **The database needs `timezone = 'UTC'`.** Supabase runs UTC; `initdb` gives you the host's
--   zone. A test pinning a timestamp gets `2026-08-18 06:31:00+05:30` where it expected
--   `2026-08-18 01:01:00`, which looks like an off-by-one in a date calculation and is not.
--
-- * **The database needs `en_US.UTF-8`, not `C.UTF-8`.** Three tests pin exact sorted registry
--   lists (the audit action keys and the scoped alert set), and C collation orders punctuation
--   before letters while en_US does not -- so `auth.email_verification.requested` and
--   `auth.mfa.activated` swap places and the assertion fails on ordering alone. `initdb` on macOS
--   gives you C.UTF-8, so the database has to be created from `template0` with the collation set.
--
-- And one that is merely fiddly rather than misleading: **the roles need `login`.**
-- `auth-hook.test.ts` connects *as* `supabase_auth_admin` to check the hook principal's
-- privileges, so a `nologin` role fails that test for what looks like a privilege bug.
--
-- ============================================================================
-- Usage
-- ============================================================================
--
--   PG=/opt/homebrew/opt/postgresql@17/bin        # 17, not 16: pgvector ships for 17
--   D=<scratch>/pgdata
--   "$PG/initdb" -U postgres -D "$D" -A trust -E UTF8
--   # Unix sockets are off because the scratch path exceeds the 103-byte socket limit.
--   "$PG/pg_ctl" -D "$D" -o "-p 54322 -c listen_addresses=127.0.0.1 -c unix_socket_directories=" \
--     -l "$D/server.log" -w start
--   "$PG/psql" -h 127.0.0.1 -p 54322 -U postgres -d template1 \
--     -c "drop database if exists postgres;" \
--     -c "create database postgres owner postgres template template0
--         lc_collate 'en_US.UTF-8' lc_ctype 'en_US.UTF-8';"
--   "$PG/psql" -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f this-file.sql
--   for f in supabase/migrations/*.sql; do
--     "$PG/psql" -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f" || break
--   done
--   # Not `npx vitest`: npx can resolve a cached binary that cannot see this workspace's deps,
--   # and it reports 27/27 green while exiting 1. Always run the checked-in binary by path.
--   RLS_TEST_DB_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     ./node_modules/.bin/vitest run --config vitest.rls.config.mts
--
-- Stop and delete the cluster when you are done (`pg_ctl -D "$D" stop`, then remove `$D`): it is
-- ~87MB and this machine runs close to full with several lanes gating at once.
-- The Supabase-provided scaffolding the migrations assume. Not a reimplementation of Supabase:
-- only the roles the grants name, and the four auth objects the schema actually touches.
do $$ declare r text; begin
  for r in select unnest(array['anon','authenticated','service_role','authenticator',
                              'supabase_auth_admin','supabase_admin','supabase_storage_admin',
                              'dashboard_user'])
  loop
    if not exists (select 1 from pg_roles where rolname = r) then
      execute format('create role %I login noinherit password ''postgres''', r);
    end if;
  end loop;
end $$;
alter role supabase_admin superuser createrole createdb replication bypassrls;
alter role supabase_auth_admin createrole;
-- PostgREST's elevated role bypasses RLS by role attribute, not by policy exemption.
alter role service_role bypassrls;
grant anon, authenticated, service_role to authenticator;

-- pgvector lands in `extensions`; without both of these a `::vector` cast under `set role`
-- fails with `type "vector" does not exist`, which reads as a missing extension.
-- `20260813000001_init.sql` also creates this (idempotently), but it runs *after* this file and
-- the grant below needs the schema to exist now.
create schema if not exists extensions;
alter database postgres set search_path = "$user", public, extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;
-- Supabase runs UTC. The host zone silently shifts every pinned timestamp in the suite.
alter database postgres set timezone = 'UTC';

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to postgres, anon, authenticated, service_role, supabase_auth_admin;

-- Supabase's own definitions: claims arrive through request.jwt.claims, which is what the RLS
-- suite sets with set_config('request.jwt.claims', ...).
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb;
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'));
$$;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  encrypted_password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  refreshed_at timestamptz,
  not_after timestamptz,
  ip inet,
  user_agent text
);
grant all on all tables in schema auth to supabase_auth_admin, service_role;
