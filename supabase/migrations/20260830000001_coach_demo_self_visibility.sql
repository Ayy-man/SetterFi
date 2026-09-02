-- Own-demo-tenant visibility for the coach measurement path, and nothing else.
--
-- `docs/GAPS.md` (entry 260819-vjf) left the is_demo position open as two costed options:
-- (a) keep demo tenants invisible everywhere and accept that a demo tenant's own coach can never
-- see a dashboard, or (b) let coach-scoped reads see their own demo tenant while platform
-- aggregates keep excluding it. This is option (b), narrowed: only the eight views the coach path
-- actually reads become actor-aware, not all twenty. The other twelve are untouched, so an unset
-- GUC leaves every one of them byte-identical in behaviour. Attributed to Ayman, 2026-08-20.
--
-- Why both predicates have to yield together: `app.inherit_is_test`
-- (`20260823000001_phase7_measurement.sql:698-767`) sets `new.is_test := tenants.is_demo` for
-- contacts, and conversations, messages, appointments, billable_events and
-- conversation_step_events each inherit from their parent. Inside a demo tenant `is_test` is the
-- same fact as `is_demo`, so relaxing only `not tenant.is_demo` would leave every row excluded by
-- its own `is_test` flag and hand the coach a wall of zeros - the exact outcome this exists to
-- avoid. Each widened branch therefore waives the row-level flag along with the tenant one.
--
-- The predicate is inlined rather than wrapped in a helper because these views are
-- `security_invoker = true` and are selected directly as `service_role` and as `authenticated`.
-- `nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid` needs no grant in any role,
-- is stable so the planner folds it once per query, and yields SQL null when unset - and
-- `tenant.id = null` is not true, so an unset GUC excludes every demo row exactly as today.
--
-- No measurement body is re-emitted here. `read_coach_measurement` (~250 lines) and
-- `read_platform_measurement` (~230 lines) are called unchanged; copying them is the
-- transcription-slip defect class this phase already paid for twice (07-10, 07-11) and which
-- `20260827000001` and `20260826000001` both open by warning about.
--
-- No table is touched, so no RLS policy or `force row level security` setting changes.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. The seam: widen only to a tenant that is genuinely a demo tenant
-- ---------------------------------------------------------------------------

create or replace function app.phase7_widen_to_own_demo_tenant(p_tenant uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  demo_tenant uuid;
begin
  select tenant.id into demo_tenant
  from public.tenants tenant
  where tenant.id = p_tenant and tenant.is_demo;
  -- The clearing branch is load-bearing. Leaving a stale value from an earlier statement in the
  -- same transaction would widen a subsequent real-tenant read to a demo tenant it never named.
  perform set_config('app.phase7_demo_tenant', coalesce(demo_tenant::text, ''), true);
end;
$$;

comment on function app.phase7_widen_to_own_demo_tenant(uuid) is
  'Sets app.phase7_demo_tenant transaction-locally to p_tenant when that tenant is a demo tenant, and clears it otherwise. Callers must prove the reader owns the tenant before calling this.';

-- ---------------------------------------------------------------------------
-- 2. The eight views the coach path reads, and only those eight
-- ---------------------------------------------------------------------------

create or replace view public.analytics_tenants
with (security_invoker = true)
as
select tenant.id as tenant_id, tenant.created_at, tenant.status, tenant.tier_id,
  coalesce(settings.timezone, 'America/New_York') as timezone
from public.tenants tenant
left join public.tenant_settings settings on settings.tenant_id = tenant.id
where not tenant.is_demo
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

create or replace view public.analytics_contacts
with (security_invoker = true)
as
select contact.id as contact_id, contact.tenant_id, contact.created_at, contact.updated_at,
  contact.pipeline_stage, contact.stage_set_at, contact.outcome, contact.merged_into_contact_id
from public.contacts contact
join public.tenants tenant on tenant.id = contact.tenant_id
where (not contact.is_test and not tenant.is_demo)
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

create or replace view public.analytics_conversations
with (security_invoker = true)
as
select conversation.id as conversation_id, conversation.tenant_id, conversation.contact_id,
  conversation.channel, conversation.first_touch_keyword, conversation.status,
  conversation.status_reason, conversation.current_step, conversation.cadence_anchor_at,
  conversation.created_at, conversation.last_message_at
from public.conversations conversation
join public.tenants tenant on tenant.id = conversation.tenant_id
where (not conversation.is_test and not tenant.is_demo)
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

create or replace view public.analytics_messages
with (security_invoker = true)
as
select message.id as message_id, message.tenant_id, message.conversation_id,
  message.direction, message.author, message.created_at
from public.messages message
join public.tenants tenant on tenant.id = message.tenant_id
where (not message.is_test and not tenant.is_demo)
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

create or replace view public.analytics_appointments
with (security_invoker = true)
as
select appointment.id as appointment_id, appointment.tenant_id, appointment.contact_id,
  appointment.conversation_id, appointment.status, appointment.attributed_to_agent,
  appointment.start_at, appointment.end_at, appointment.created_at, appointment.updated_at
from public.appointments appointment
join public.tenants tenant on tenant.id = appointment.tenant_id
where (not appointment.is_test and not tenant.is_demo)
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

create or replace view public.analytics_billable_events
with (security_invoker = true)
as
select event.id as billable_event_id, event.tenant_id, event.quantity,
  event.appointment_id, event.adjusts_event_id, event.occurred_at
from public.billable_events event
join public.tenants tenant on tenant.id = event.tenant_id
where (not event.is_test and not tenant.is_demo)
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

-- Carried forward from its *second* definition
-- (`20260823000002_phase7_step_attribution_bound.sql:11-34`), which replaced the simple view with
-- an asked branch and a lateral-joined answered branch. Both branches are widened; emitting the
-- older single-select shape here would silently revert the reply-attribution repair.
create or replace view public.analytics_conversation_step_events
with (security_invoker = true)
as
select event.id as event_id, event.tenant_id, event.conversation_id, event.contact_id,
  event.message_id, event.step_key, event.event_kind, event.occurred_at
from public.conversation_step_events event
join public.tenants tenant on tenant.id = event.tenant_id
where event.event_kind = 'asked'
  and ((not event.is_test and not tenant.is_demo)
    or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid)
union all
select answer.id as event_id, answer.tenant_id, answer.conversation_id, answer.contact_id,
  answer.message_id, owner.step_key, answer.event_kind, answer.occurred_at
from public.conversation_step_events answer
join public.tenants tenant on tenant.id = answer.tenant_id
join lateral (
  select asked.step_key
  from public.conversation_step_events asked
  where asked.conversation_id = answer.conversation_id
    and asked.event_kind = 'asked'
    and asked.occurred_at < answer.occurred_at
    and answer.occurred_at < asked.occurred_at + interval '7 days'
  order by asked.occurred_at desc, asked.id desc
  limit 1
) owner on true
where answer.event_kind = 'answered'
  and ((not answer.is_test and not tenant.is_demo)
    or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid);

create or replace view public.analytics_billing_subscriptions
with (security_invoker = true)
as
select subscription.id as subscription_id, subscription.tenant_id, tier.id as tier_id,
  subscription.stripe_price_id, subscription.status, subscription.current_period_start,
  subscription.current_period_end, subscription.cancel_at_period_end,
  subscription.provider_updated_at, subscription.created_at
from public.billing_subscriptions subscription
join public.tenants tenant on tenant.id = subscription.tenant_id
left join public.tiers tier on tier.stripe_price_id = subscription.stripe_price_id
where not tenant.is_demo
  or tenant.id = nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;

-- ---------------------------------------------------------------------------
-- 3. The wrappers: prove ownership first, widen second
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
declare
  widened uuid;
begin
  if p_actor_id is null then
    raise exception 'PHASE7_SESSION_ACTOR_REQUIRED';
  end if;
  perform set_config('app.phase7_reader_actor', p_actor_id::text, true);
  -- Ordering is the entire security argument: the actor check raises
  -- PHASE7_COACH_READER_TENANT_MISMATCH before the GUC is ever set, so widening can only name a
  -- tenant this reader has already proved it may read. The inner body re-runs the same check.
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);
  widened := nullif(current_setting('app.phase7_demo_tenant', true), '')::uuid;
  return public.read_coach_measurement(
    p_expected_tenant, p_window, p_custom_from, p_custom_to, p_as_of
  ) || jsonb_build_object('isDemo', widened is not null);
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
  perform app.phase7_session_actor(p_expected_tenant, false);
  perform app.phase7_widen_to_own_demo_tenant(p_expected_tenant);
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
  -- A platform aggregate cannot run widened, whatever else happened in this transaction. One
  -- missed view or one caller that forgot to clear the GUC is all it would take to leak demo
  -- rows into a number the client reads as real.
  perform set_config('app.phase7_demo_tenant', '', true);
  return public.read_platform_measurement(p_as_of);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Service-only execution boundary, restated from 20260827000001:3
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
  'Coach measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies it against public.users and public.impersonation_sessions. Widens the eight coach-path views to the reader own demo tenant only after that check passes, and reports it as isDemo.';
comment on function public.read_coach_lead_composition_for_actor(uuid,uuid,timestamptz) is
  'Coach lead composition for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies it against public.users and public.impersonation_sessions. Widens the eight coach-path views to the reader own demo tenant only after that check passes.';
comment on function public.read_platform_measurement_for_actor(uuid,timestamptz) is
  'Platform measurement for a named reader. The id must come from a server-validated session, never from a request parameter the browser controls; the database re-verifies the owner/admin/success audience against public.users. Clears the demo-tenant widening before reading, so a platform aggregate never contains a demo tenant.';
