-- Round 3 backend gap (Billing lane's "Backend gaps for Codex round two", carried into round 3
-- intake): the coach billing screen files a correction as a period and a reason, with no event and
-- no quantity delta, and the attendance panel needs to show recent bookings the coach has already
-- answered, not only the unanswered queue.
--
-- What is NOT in this migration, and why. The overage rate and the billing interval are the other
-- two items on the same intake list. Neither is a stored field anywhere in this schema:
-- `20261005000002_signup_tier_call_allowance.sql`'s own comment records that no per-call overage
-- price exists in the product and that it is Alec's commercial decision to make and record in
-- docs/DECISIONS.md before it can be shown, and no table carries a billing cadence separate from
-- the two period-boundary timestamps `billing_subscriptions` already has. Adding either as a column
-- here would be this migration inventing a number nobody has decided and nothing writes -- exactly
-- what the engineering brief's "grounded, not hallucinated" and "honest states" rules forbid.
-- Flagging both as still open, needing the commercial decision first, not a repository change.
--
-- The decision side of a period-level correction is also out of scope here, deliberately.
-- `billable_events`'s own shape check (`billable_events_shape_chk`, 20260817000001_phase1_demo_
-- path.sql:539-544) requires every adjustment row to carry a non-null `adjusts_event_id` pointing
-- at a real prior billable event -- there is no way to record a "credit against a period, not an
-- event" ledger row under the current schema. Deciding a period-level request honestly needs either
-- a schema change to represent an event-less credit, or an admin flow that resolves the request
-- against a specific event chosen at decision time; either is its own round. `decide_billable_
-- correction` is changed only to fail with a clear, named error instead of hitting a raw
-- NOT NULL / check-constraint violation if it is ever called against a period-level request.

set search_path = public, extensions;

alter table public.billing_correction_requests
  alter column billable_event_id drop not null,
  alter column quantity_delta drop not null,
  add column period_start timestamptz,
  add column period_end timestamptz;

alter table public.billing_correction_requests
  drop constraint billing_correction_requests_delta_chk;

alter table public.billing_correction_requests
  add constraint billing_correction_requests_shape_chk check (
    (billable_event_id is not null and quantity_delta is not null and quantity_delta <> 0
      and period_start is null and period_end is null)
    or
    (billable_event_id is null and quantity_delta is null
      and period_start is not null and period_end is not null and period_start < period_end)
  );

create or replace function public.request_period_billing_correction(
  p_expected_tenant uuid,
  p_reason text
)
returns table (request_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  subscription_row public.billing_subscriptions%rowtype;
  new_id uuid := gen_random_uuid();
  logged_id bigint;
begin
  actor_id := app.phase6_human_actor(p_expected_tenant, false, true);
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_CORRECTION_REASON_REQUIRED'; end if;

  select * into subscription_row from public.billing_subscriptions
  where tenant_id = p_expected_tenant
    and status in ('trialing', 'active', 'past_due')
    and current_period_start <= now() and current_period_end > now()
  order by current_period_start desc
  limit 1;
  if subscription_row.tenant_id is null then
    raise exception 'BILLING_CORRECTION_NO_ACTIVE_PERIOD';
  end if;

  if exists (
    select 1 from public.billing_correction_requests request_row
    left join public.billing_correction_decisions decision_row on decision_row.request_id = request_row.id
    where request_row.tenant_id = p_expected_tenant
      and request_row.billable_event_id is null
      and request_row.period_start = subscription_row.current_period_start
      and request_row.period_end = subscription_row.current_period_end
      and decision_row.id is null
  ) then
    raise exception 'BILLING_CORRECTION_ALREADY_OPEN';
  end if;

  logged_id := app.write_audit_row(
    'billing.correction.requested', actor_id, p_expected_tenant,
    'billing_correction_request', new_id::text, p_reason,
    jsonb_build_object(
      'period_start', subscription_row.current_period_start,
      'period_end', subscription_row.current_period_end
    )
  );
  insert into public.billing_correction_requests (
    id, tenant_id, requested_by, reason, audit_id, period_start, period_end
  ) values (
    new_id, p_expected_tenant, actor_id, btrim(p_reason), logged_id,
    subscription_row.current_period_start, subscription_row.current_period_end
  );
  return query select new_id, logged_id;
end;
$$;

revoke execute on function public.request_period_billing_correction(uuid, text)
  from public, anon, authenticated;
grant execute on function public.request_period_billing_correction(uuid, text)
  to service_role;

-- Same signature as the currently-live version (20260822000002_phase6_payout_actor_custody.sql,
-- which dropped and replaced the original 20260822000001_phase6_money.sql 4-param function with
-- this 5-param one carrying an explicit p_actor_id), replaced only to fail with a named error for
-- a period-level request instead of a raw constraint violation. Every event-level branch below is
-- otherwise unchanged.
create or replace function public.decide_billable_correction(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_request_id uuid,
  p_decision text,
  p_reason text
)
returns table (decision_id uuid, offset_event_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  request_row public.billing_correction_requests%rowtype;
  existing public.billing_correction_decisions%rowtype;
  actor_id uuid;
  new_id uuid := gen_random_uuid();
  offset_id uuid;
  logged_id bigint;
  action_key text;
begin
  actor_id := app.phase6_verified_actor(p_actor_id, p_expected_tenant, true, false);
  if p_decision not in ('approved','rejected') then raise exception 'BILLING_CORRECTION_DECISION_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_CORRECTION_DECISION_REASON_REQUIRED'; end if;
  select * into request_row from public.billing_correction_requests
  where id = p_request_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, request_row.tenant_id, 'billing_correction_request');
  if request_row.billable_event_id is null then
    raise exception 'BILLING_CORRECTION_PERIOD_LEVEL_DECISION_NOT_SUPPORTED';
  end if;
  select * into existing from public.billing_correction_decisions where request_id = p_request_id;
  if existing.id is not null then
    if existing.decision is distinct from p_decision then
      raise exception 'BILLING_CORRECTION_DECISION_REPLAY_MISMATCH';
    end if;
    return query select existing.id, existing.offset_event_id, existing.audit_id;
    return;
  end if;
  if p_decision = 'approved' then
    insert into public.billable_events (
      tenant_id, quantity, adjusted_by, adjust_reason, is_test, adjusts_event_id
    ) values (
      p_expected_tenant, request_row.quantity_delta, actor_id, btrim(p_reason),
      false, request_row.billable_event_id
    ) returning id into offset_id;
    action_key := 'billing.correction.approved';
  else
    action_key := 'billing.correction.rejected';
  end if;
  logged_id := app.write_audit_row(
    action_key, actor_id, p_expected_tenant, 'billing_correction_request',
    p_request_id::text, p_reason,
    jsonb_build_object('decision', p_decision, 'offset_event_id', offset_id)
  );
  insert into public.billing_correction_decisions (
    id, request_id, decision, decided_by, reason, offset_event_id, audit_id
  ) values (
    new_id, p_request_id, p_decision, actor_id, btrim(p_reason), offset_id, logged_id
  );
  return query select new_id, offset_id, logged_id;
end;
$$;

-- coach_billing_projection gains a settled-attendance list: the recent appointments in the current
-- period whose attendance has already been answered (attendance_source is not null), mirroring
-- outcome_prompts' shape but for the queue's opposite state. PostgreSQL cannot add an OUT column
-- with `create or replace`, so the function is dropped and recreated, exactly as the original
-- migration's own comment records doing for the same reason.
drop function if exists public.coach_billing_projection(uuid);

create function public.coach_billing_projection(p_expected_tenant uuid)
returns table (
  tier_name text,
  price_cents integer,
  period_start timestamptz,
  period_end timestamptz,
  timezone text,
  booked_count bigint,
  call_allowance integer,
  subscription_state text,
  invoice_state text,
  account_state text,
  pending_tier_name text,
  pending_price_cents integer,
  pending_effective_at timestamptz,
  notices jsonb,
  correction_candidates jsonb,
  outcome_prompts jsonb,
  settled_attendance jsonb,
  is_demo boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();

  return query
  with caller as (
    select actor.id, actor.tenant_id
    from public.users actor
    where actor.id = app.current_user_id()
      and actor.role in ('coach', 'coach_member')
      and actor.role::text = app.current_user_role()::text
      and actor.tenant_id = p_expected_tenant
  )
  select
    tier.name,
    coalesce(active_override.price_cents, tier.price_cents),
    subscription.current_period_start,
    subscription.current_period_end,
    coalesce(settings.timezone, 'America/New_York'),
    coalesce((
      select sum(event.quantity)::bigint
      from public.billable_events event
      where event.tenant_id = tenant.id
        and not event.is_test
        and event.occurred_at >= subscription.current_period_start
        and event.occurred_at < subscription.current_period_end
    ), 0)::bigint,
    tier.call_allowance,
    subscription.status,
    subscription.status,
    tenant.status::text,
    pending_tier.name,
    pending_tier.price_cents,
    pending_action.effective_at,
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', action.id::text,
          'kind', action.kind,
          'state', case
            when delivery.status = 'delivered' and delivery.provider_reference is not null
              then 'sent'
            when delivery.id is null then 'queued'
            else 'pending'
          end,
          'deliveryReceiptId', delivery.provider_reference,
          'billingContactSource', case
            when exists (
              select 1 from public.users billing_user
              where billing_user.tenant_id = tenant.id
                and billing_user.email = tenant.billing_contact_email
            ) then 'login email'
            else 'tenant billing contact'
          end
        ) order by action.created_at, action.id
      )
      from public.allowance_actions action
      left join lateral (
        select delivery_row.id, delivery_row.status::text, delivery_row.provider_reference
        from public.notification_deliveries delivery_row
        where delivery_row.notification_id = action.notice_event_id
        order by
          (delivery_row.status = 'delivered' and delivery_row.provider_reference is not null) desc,
          (delivery_row.destination = 'email') desc,
          delivery_row.created_at desc
        limit 1
      ) delivery on true
      where action.tenant_id = tenant.id
        and action.billing_period_start = subscription.current_period_start
        and action.billing_period_end = subscription.current_period_end
        and action.kind in ('warning', 'crossing')
        and action.notice_event_id is not null
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'eventId', event.id::text,
          'label', coalesce(nullif(contact.name, ''), appointment.start_at::text)
        ) order by event.occurred_at desc, event.id
      )
      from public.billable_events event
      join public.appointments appointment on appointment.id = event.appointment_id
      join public.contacts contact on contact.id = appointment.contact_id
      where event.tenant_id = tenant.id
        and event.adjusts_event_id is null
        and not event.is_test
        and event.occurred_at >= subscription.current_period_start
        and event.occurred_at < subscription.current_period_end
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'appointmentId', appointment.id::text,
          'label', coalesce(nullif(contact.name, ''), appointment.start_at::text),
          'occurredAt', appointment.end_at::text
        ) order by appointment.end_at desc, appointment.id
      )
      from public.appointments appointment
      join public.contacts contact on contact.id = appointment.contact_id
      where appointment.tenant_id = tenant.id
        and not appointment.is_test
        and appointment.end_at < now()
        and appointment.status in ('scheduled', 'confirmed')
        and appointment.attendance_source is null
    ), '[]'::jsonb),
    coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'appointmentId', appointment.id::text,
          'label', coalesce(nullif(contact.name, ''), appointment.start_at::text),
          'occurredAt', appointment.attendance_set_at::text,
          'outcome', appointment.status::text
        ) order by appointment.attendance_set_at desc, appointment.id
      )
      from public.appointments appointment
      join public.contacts contact on contact.id = appointment.contact_id
      where appointment.tenant_id = tenant.id
        and not appointment.is_test
        and appointment.attendance_source is not null
        and appointment.attendance_set_at >= subscription.current_period_start
        and appointment.attendance_set_at < subscription.current_period_end
      limit 20
    ), '[]'::jsonb),
    tenant.is_demo
  from caller
  join public.tenants tenant on tenant.id = caller.tenant_id
  join public.billing_subscriptions subscription on subscription.tenant_id = tenant.id
  join public.tiers tier on tier.id = tenant.tier_id
  left join public.tenant_settings settings on settings.tenant_id = tenant.id
  left join lateral (
    select override_row.price_cents
    from public.tenant_price_overrides override_row
    where override_row.tenant_id = tenant.id
      and override_row.effective_at <= now()
      and (override_row.ends_at is null or override_row.ends_at > now())
    order by override_row.effective_at desc, override_row.created_at desc
    limit 1
  ) active_override on true
  left join lateral (
    select action.pending_tier_id, action.effective_at
    from public.allowance_actions action
    where action.tenant_id = tenant.id
      and action.billing_period_start = subscription.current_period_start
      and action.billing_period_end = subscription.current_period_end
      and action.kind = 'crossing'
      and action.state = 'scheduled'
    order by action.created_at desc
    limit 1
  ) pending_action on true
  left join public.tiers pending_tier on pending_tier.id = pending_action.pending_tier_id;
end;
$$;

comment on function public.coach_billing_projection(uuid) is
  'Session-coach-only billing state. No cost, margin, provider-cost or platform rollup field is exposed.';

revoke execute on function public.coach_billing_projection(uuid)
  from public, anon;
grant execute on function public.coach_billing_projection(uuid)
  to authenticated, service_role;
