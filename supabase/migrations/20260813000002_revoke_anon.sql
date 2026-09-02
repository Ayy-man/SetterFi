-- Deny anon at the grant layer, everywhere, explicitly.
--
-- Local CLI databases already behave this way (no auto-expose), but hosted projects
-- carry legacy default privileges that GRANT to anon on the public schema — the RLS
-- suite caught the divergence on the first cloud run (anon SELECT resolved instead of
-- being rejected). RLS policies still returned zero rows, so nothing leaked, but the
-- grant layer is the outer wall and it must not depend on which environment built the
-- database. No SetterFi surface uses anon PostgREST: leads talk to our API routes
-- (service_role), operators are authenticated. anon needs nothing.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;
revoke usage on schema public from anon;

-- Future objects: strip anon from the default privileges of every role that creates
-- schema objects here (postgres locally and on hosted; supabase_admin runs migrations
-- on hosted infra but objects are owned by postgres).
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;
