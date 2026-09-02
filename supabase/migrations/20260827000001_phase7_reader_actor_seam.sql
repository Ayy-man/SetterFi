-- The reader identity seam the measurement RPCs were always designed to need.
--
-- `app.phase7_session_actor` (`20260823000001_phase7_measurement.sql:1054`) resolves the reader
-- from the request JWT, and execute on the three read RPCs is granted to `service_role` alone
-- (`:1889-1908`). Those two facts cannot both be satisfied by any caller: a service client carries
-- no user JWT, so `app.current_user_id()` is null, the `public.users` lookup misses, and every one
-- of `/coach/home`, `/coach/analytics`, `/coach/pipelines`, `/admin/overview` and
-- `/admin/agent-performance` dies on `PHASE7_SESSION_ACTOR_REQUIRED` before any tenant logic runs.
-- The only thing satisfying the gate today is the RLS harness, which sets `request.jwt.claims` by
-- hand while running as `service_role` — claims the app has no way to supply.
--
-- The same phase already shipped the answer for exactly this caller:
-- `app.phase7_verified_test_actor(p_actor_id, p_expected_tenant)` (`:1625`) takes the actor as a
-- parameter and re-verifies it against `public.users`, and `create_test_agent_session` is how the
-- service client calls it today. This migration gives the three readers the same explicit-actor
-- seam, and moves only the *source* of the reader's identity. Every authorization test stays in
-- the database, against `public.users` and `public.impersonation_sessions`: under a security
-- definer function called by `service_role`, RLS constrains nothing, so the actor check is the
-- entire boundary between a tenant id in a URL and another tenant's contacts, conversations,
-- appointments and allowance.
--
-- No measurement body is re-emitted here. The wrappers call the existing functions unchanged --
-- copying those ~250-line bodies is the transcription-slip defect class this phase already paid
-- for twice (07-10, 07-11, and the note at `20260826000001_coach_lead_composition.sql:6-9`).

-- ---------------------------------------------------------------------------
-- 1. The actor resolver: JWT first, explicit actor second, same refusals
-- ---------------------------------------------------------------------------

create or replace function app.phase7_session_actor(
  p_expected_tenant uuid,
  p_platform_only boolean
)
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
  jwt_actor uuid := app.current_user_id();
  supplied_actor uuid := nullif(current_setting('app.phase7_reader_actor', true), '')::uuid;
  actor_id uuid := coalesce(jwt_actor, supplied_actor);
begin
  perform app.assert_not_impersonating();
  if actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  select * into actor_row from public.users actor where actor.id = actor_id;
  -- When the id came from a JWT the role claim is cross-checked against the stored row exactly as
  -- before, so a tampered or stale claim still fails. When it came from the explicit-actor GUC
  -- there is no claim to compare against and the role is taken from `public.users` alone. That is
  -- the single property this change trades away, and what replaces it is that the id is only ever
  -- derived from a server-validated `supabase.auth.getClaims()` session and that the GUC has no
  -- setter other than the three wrappers below, which are executable by `service_role` only.
  if actor_row.id is null
    or (
      jwt_actor is not null
      and actor_row.role::text is distinct from app.current_user_role()::text
    ) then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  if p_platform_only then
    if actor_row.role not in ('owner', 'admin', 'success') then
      raise exception 'PHASE7_PLATFORM_READER_REQUIRED';
    end if;
  elsif actor_row.role not in ('coach', 'coach_member')
    or actor_row.tenant_id is distinct from p_expected_tenant then
    -- A platform user reading a coach tenant is legitimate only inside a live impersonation
    -- session, and that is settled here against the table rather than on the application's word:
    -- the coach dashboards run the same reader under impersonation, and `app.current_tenant_id()`
    -- is not consulted because the service client has no claims to carry it.
    if actor_row.role not in ('owner', 'admin', 'success')
      or not exists (
        select 1 from public.impersonation_sessions session
        where session.actor_id = actor_row.id
          and session.tenant_id = p_expected_tenant
          and session.ended_at is null
          and session.expires_at > now()
      ) then
      raise exception 'PHASE7_COACH_READER_TENANT_MISMATCH';
    end if;
  end if;
  return actor_row;
end;
$$;

comment on function app.phase7_session_actor(uuid, boolean) is
  'Resolves and re-verifies the measurement reader. A request JWT keeps precedence; a service-role caller supplies the id through app.phase7_reader_actor, set transaction-locally by the *_for_actor wrappers.';

-- ---------------------------------------------------------------------------
-- 2. The wrappers: the service client's only way to name its reader
-- ---------------------------------------------------------------------------

create or replace function public.read_coach_measurement_for_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_window text,
  p_custom_from date,
  p_custom_to date,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  return public.read_coach_measurement(
    p_expected_tenant, p_window, p_custom_from, p_custom_to, p_as_of
  );
end;
$$;

create or replace function public.read_coach_lead_composition_for_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  return public.read_coach_lead_composition(p_expected_tenant, p_as_of);
end;
$$;

create or replace function public.read_platform_measurement_for_actor(
  p_actor_id uuid,
  p_as_of timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  return public.read_platform_measurement(p_as_of);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Service-only execution boundary, mirroring 20260823000001:1889-1908
-- ---------------------------------------------------------------------------

revoke execute on function
  public.read_coach_measurement_for_actor(uuid,uuid,text,date,date,timestamptz),
  public.read_coach_lead_composition_for_actor(uuid,uuid,timestamptz),
  public.read_platform_measurement_for_actor(uuid,timestamptz)
from public, anon, authenticated;
grant execute on function
  public.read_coach_measurement_for_actor(uuid,uuid,text,date,date,timestamptz),
  public.read_coach_lead_composition_for_actor(uuid,uuid,timestamptz),
  public.read_platform_measurement_for_actor(uuid,timestamptz)
to service_role;

comment on function public.read_coach_measurement_for_actor(uuid,uuid,text,date,date,timestamptz) is
  'Coach measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies it against public.users and public.impersonation_sessions.';
comment on function public.read_coach_lead_composition_for_actor(uuid,uuid,timestamptz) is
  'Coach lead composition for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies it against public.users and public.impersonation_sessions.';
comment on function public.read_platform_measurement_for_actor(uuid,timestamptz) is
  'Platform measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies the owner/admin/success audience against public.users.';
