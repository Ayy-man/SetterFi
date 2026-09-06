-- `20261011000001_platform_demo_visibility.sql` created `platform_review_settings` with row level
-- security enabled but not forced. Every other public table forces it (the structural invariant in
-- `supabase/tests/rls.test.ts`), so the table owner is bound by the same policies as everyone
-- else. Nothing granted anon or authenticated a privilege on the table, so the gap was never
-- reachable from a browser session, but the invariant is the guarantee and it should hold for
-- every table rather than all but one.
--
-- The switch keeps working: `platform_demo_visible()` runs as its owner, and both `postgres` and
-- `service_role` carry BYPASSRLS, so the migration seed row, the reader function and the operator's
-- direct flip are unaffected. No policy is added because no client role holds a grant.

alter table public.platform_review_settings force row level security;
