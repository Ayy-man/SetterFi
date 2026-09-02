-- Phase 6 client portal reads close the session-to-surface seam without widening table access.
-- Both projections derive the persisted caller from the verified JWT, return no cross-scope row,
-- and expose only the exact coach-billing or affiliate-payout fields rendered by the portals.

create or replace function public.coach_billing_projection(p_expected_tenant uuid)
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

create or replace function public.affiliate_payout_history_projection()
returns table (
  amount_cents bigint,
  state text,
  reference text,
  recorded_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();

  return query
  select payout.total_cents,
    case when sent.id is null then 'approved_for_payout' else 'sent' end,
    sent.reference,
    sent.paid_on
  from public.users actor
  join public.affiliates affiliate on affiliate.user_id = actor.id
  join public.commission_payouts payout on payout.affiliate_id = affiliate.id
  join public.commission_payout_events approved
    on approved.payout_id = payout.id and approved.kind = 'approved'
  left join public.commission_payout_events sent
    on sent.payout_id = payout.id and sent.kind = 'sent'
  where actor.id = app.current_user_id()
    and actor.role = 'affiliate'
    and actor.role::text = app.current_user_role()::text
  order by coalesce(sent.paid_on::timestamptz, approved.created_at) desc, payout.id;
end;
$$;

comment on function public.coach_billing_projection(uuid) is
  'Session-coach-only billing state. No cost, margin, provider-cost or platform rollup field is exposed.';
comment on function public.affiliate_payout_history_projection() is
  'Session-affiliate-only payout history. Referred-coach performance and tenant identifiers are absent.';

revoke execute on function public.coach_billing_projection(uuid)
  from public, anon;
revoke execute on function public.affiliate_payout_history_projection()
  from public, anon;

grant execute on function public.coach_billing_projection(uuid)
  to authenticated, service_role;
grant execute on function public.affiliate_payout_history_projection()
  to authenticated, service_role;
