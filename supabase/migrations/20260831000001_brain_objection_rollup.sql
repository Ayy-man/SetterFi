-- Phase 10-04. The coach-facing read side of the objection runtime.
--
-- This is a NEW migration file rather than an append to
-- `20260826000003_brain_objection_runtime.sql`, and that is deliberate. Phase 10's first three
-- plans are merged and 20260826000003 is already recorded as applied on the hosted project.
-- Supabase keys applied migrations by version, so bytes appended to an applied file are never
-- executed against hosted: the repository's schema and the hosted schema would diverge
-- permanently with nothing reporting it. 20260826000003 is closed. Every later DDL gets its own
-- version.
--
-- Nothing here writes. The rollup reads `public.analytics_brain_objection_usage_events` and
-- `public.brain_snapshot_objections` and returns one jsonb envelope.

-- ---------------------------------------------------------------------------
-- 1. The rollup itself
-- ---------------------------------------------------------------------------
-- A `security definer` function bypasses RLS, including the `security_invoker` analytics view's,
-- because its owner carries BYPASSRLS. The tenant predicate below is therefore load-bearing on its
-- own: `read_coach_top_objections_for_actor` authorizes the actor for the tenant first, and this
-- body filters to that same tenant second. Neither half is optional.
create or replace function public.read_coach_top_objections(
  p_expected_tenant uuid,
  p_as_of timestamptz,
  p_limit int,
  p_include_hard_gated boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  -- The panel asking for zero rows is a caller bug, not an instruction to blank the surface, so
  -- the limit is clamped rather than raised on.
  v_limit int := least(greatest(coalesce(p_limit, 5), 1), 20);
  v_as_of timestamptz := coalesce(p_as_of, now());
  v_window_start timestamptz;
  v_include_hard_gated boolean := coalesce(p_include_hard_gated, false);
  -- The booked-rate attribution rule is an unmade client decision (10-SPEC:373-381). Four things
  -- have to be approved before a percentage may appear on a coach's screen: the reporting window,
  -- whether a booking counts only after the objection's first hit, whether it must be
  -- agent-attributed, and the maximum attribution period. Until then this constant reads
  -- 'awaiting_definition', every row's bookedRate is null, and the repository refuses any payload
  -- that contradicts the pair.
  --
  -- When the answer lands, the whole change is two edits in one migration: this constant becomes
  -- 'defined', and the numerator CTE is added below it. Nothing else moves — the view model's
  -- `available` branch is already written and tested.
  v_attribution_state constant text := 'awaiting_definition';
  v_rows jsonb;
begin
  v_window_start := v_as_of - interval '30 days';

  with hits as (
    select
      event.objection_id,
      count(distinct event.conversation_id) as conversation_count,
      bool_or(event.hard_gate) as hard_gate
    from public.analytics_brain_objection_usage_events event
    where event.tenant_id = p_expected_tenant
      and event.used_at >= v_window_start
      and event.used_at < v_as_of
      and (v_include_hard_gated or not event.hard_gate)
    group by event.objection_id
  ),
  labelled as (
    select
      hits.objection_id,
      hits.conversation_count,
      hits.hard_gate,
      -- An objection's label can differ across snapshots, so the one rendered is the label as of
      -- the most recent hit inside the window, tie-broken by snapshot id. That is a decision, not
      -- an accident, and it is joined on the composite (snapshot_id, objection_id) so a rename in
      -- the mutable `public.brain_objections` library can never reach a coach's screen.
      (
        select snapshot_objection.label
        from public.analytics_brain_objection_usage_events recent
        join public.brain_snapshot_objections snapshot_objection
          on snapshot_objection.snapshot_id = recent.snapshot_id
          and snapshot_objection.objection_id = recent.objection_id
        where recent.tenant_id = p_expected_tenant
          and recent.objection_id = hits.objection_id
          and recent.used_at >= v_window_start
          and recent.used_at < v_as_of
        order by recent.used_at desc, recent.snapshot_id desc
        limit 1
      ) as label
    from hits
  ),
  ranked as (
    select *
    from labelled
    -- Deterministic across reads, so the panel's row order never shuffles between two loads of
    -- the same data.
    order by conversation_count desc, label asc, objection_id asc
    limit v_limit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'objectionId', ranked.objection_id,
        'label', ranked.label,
        'hardGate', ranked.hard_gate,
        'conversationCount', ranked.conversation_count,
        'bookedRate', null,
        'state', case when ranked.hard_gate then 'held_safely' else v_attribution_state end
      )
      order by ranked.conversation_count desc, ranked.label asc, ranked.objection_id asc
    ),
    '[]'::jsonb
  )
  into v_rows
  from ranked;

  -- `rows` defaults to an empty array rather than SQL null so the repository never has to
  -- distinguish absent from empty. A coach with no recorded matches gets an honest empty panel.
  return jsonb_build_object(
    'tenantId', p_expected_tenant,
    'asOf', to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windowStart', to_char(v_window_start at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'windowEnd', to_char(v_as_of at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'attributionState', v_attribution_state,
    'rows', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The explicit-actor wrapper
-- ---------------------------------------------------------------------------
-- Copies `read_coach_lead_composition_for_actor`
-- (`20260830000001_coach_demo_self_visibility.sql:209`) with one deliberate omission:
-- `app.phase7_widen_to_own_demo_tenant` is NOT called. That helper widens the eight Phase 7
-- coach-path views and `analytics_brain_objection_usage_events` is not one of them, so calling it
-- here would imply a widening that does not happen. A coach on a demo tenant therefore sees an
-- empty panel, which is the honest reading of ANL-03 rather than a bug.
create or replace function public.read_coach_top_objections_for_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_as_of timestamptz,
  p_limit int,
  p_include_hard_gated boolean
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
  -- Authorization first, filter second. The actor check raises before any row is read, and the
  -- inner body's `where tenant_id = p_expected_tenant` then narrows to the tenant this reader has
  -- already proved it may read.
  perform app.phase7_session_actor(p_expected_tenant, false);
  return public.read_coach_top_objections(
    p_expected_tenant, p_as_of, p_limit, p_include_hard_gated
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Custody
-- ---------------------------------------------------------------------------
revoke execute on function
  public.read_coach_top_objections(uuid,timestamptz,int,boolean),
  public.read_coach_top_objections_for_actor(uuid,uuid,timestamptz,int,boolean)
from public, anon, authenticated;

grant execute on function
  public.read_coach_top_objections(uuid,timestamptz,int,boolean),
  public.read_coach_top_objections_for_actor(uuid,uuid,timestamptz,int,boolean)
to service_role;

comment on function public.read_coach_top_objections(uuid,timestamptz,int,boolean) is
  'Coach Top objections rollup over public.analytics_brain_objection_usage_events for one tenant across a trailing half-open 30-day window; counts are distinct conversations, labels come from the snapshot at the most recent hit, and bookedRate is null while attributionState reads awaiting_definition.';

comment on function public.read_coach_top_objections_for_actor(uuid,uuid,timestamptz,int,boolean) is
  'Actor-authorized entry point for the Top objections rollup. p_actor_id comes from a server-validated supabase.auth.getClaims() session and never from a request parameter the browser controls.';
