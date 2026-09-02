-- Grant the access-token hook the tables it grew into.
--
-- `20260813000003_access_token_hook.sql:50-58` shipped a hook that read exactly one
-- table, with a grant block that matched its body: schema usage, execute, a revoke
-- from authenticated/public, `grant select on public.users`, and a permissive
-- `users_auth_admin_read` select policy. The policy is there because the init sweep
-- at `20260813000001_init.sql:834` puts FORCE RLS on every public table, so a grant
-- on its own still reads nothing.
--
-- `20260824000001_phase8_operate_handover.sql:711` then replaced the body with one
-- that also reads `public.affiliates` (the affiliate_access capability) and
-- `public.impersonation_sessions` (the active session id for owner/admin/success),
-- and re-granted only execute at `:791`. The body grew and the grant block did not
-- follow it, so every token request died as `Error running hook URI` — the hook is
-- SECURITY INVOKER and runs as `supabase_auth_admin`, a principal no test drove.
--
-- This does for both new tables exactly what `20260813000003:55-59` does for
-- `public.users`, and nothing more: select only, to that one role. `create policy`
-- has no `if not exists`, so drop-then-create is the repo's idempotency guard
-- (`20260824000001_phase8_operate_handover.sql:331-332`) and what keeps
-- `supabase migration up --include-all` re-runnable.

grant select on public.affiliates to supabase_auth_admin;
drop policy if exists affiliates_auth_admin_read on public.affiliates;
create policy affiliates_auth_admin_read on public.affiliates
  as permissive for select
  to supabase_auth_admin
  using (true);

grant select on public.impersonation_sessions to supabase_auth_admin;
drop policy if exists impersonation_sessions_auth_admin_read on public.impersonation_sessions;
create policy impersonation_sessions_auth_admin_read on public.impersonation_sessions
  as permissive for select
  to supabase_auth_admin
  using (true);
