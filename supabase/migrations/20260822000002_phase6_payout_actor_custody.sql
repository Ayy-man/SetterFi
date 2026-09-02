-- Phase 6 actor custody: service-role RPCs receive the verified route actor and independently
-- validate that persisted user's role and tenant before changing money state.

create or replace function app.phase6_verified_actor(
  p_actor_id uuid,
  p_expected_tenant uuid,
  p_platform_only boolean,
  p_coach_only boolean
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
begin
  if p_actor_id is null then raise exception 'PHASE6_ACTOR_REQUIRED'; end if;
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE6_ACTOR_REQUIRED'; end if;
  if p_platform_only and actor_row.role not in ('owner','admin') then
    raise exception 'PHASE6_OWNER_ADMIN_REQUIRED';
  end if;
  if p_coach_only and (
    actor_row.role not in ('coach','coach_member')
    or actor_row.tenant_id is distinct from p_expected_tenant
  ) then raise exception 'PHASE6_COACH_TENANT_REQUIRED'; end if;
  if not p_platform_only and not p_coach_only
    and actor_row.role not in ('owner','admin')
    and actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'PHASE6_ACTOR_TENANT_MISMATCH';
  end if;
  return actor_row.id;
end;
$$;

drop function public.record_stripe_checkout_session(uuid,uuid,text,text,text,text,text,timestamptz,timestamptz);
create function public.record_stripe_checkout_session(
  p_expected_tenant uuid, p_actor_id uuid, p_tier_id uuid, p_idempotency_key text,
  p_stripe_session_id text, p_stripe_customer_id text, p_stripe_subscription_id text,
  p_state text, p_expires_at timestamptz, p_completed_at timestamptz
)
returns table (checkout_session_id uuid, state text)
language plpgsql security definer set search_path = '' as $$
declare
  existing public.stripe_checkout_sessions%rowtype;
  new_id uuid := gen_random_uuid();
  actor_id uuid;
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  if not exists (select 1 from public.tiers where id = p_tier_id and active) then raise exception 'BILLING_TIER_NOT_FOUND'; end if;
  if nullif(btrim(p_idempotency_key), '') is null or nullif(btrim(p_stripe_session_id), '') is null
    or nullif(btrim(p_stripe_customer_id), '') is null then raise exception 'STRIPE_CHECKOUT_REQUIRED_FIELD_MISSING'; end if;
  select * into existing from public.stripe_checkout_sessions where idempotency_key = p_idempotency_key for update;
  if existing.id is not null then
    if existing.tenant_id is distinct from p_expected_tenant or existing.tier_id is distinct from p_tier_id
      or existing.stripe_session_id is distinct from p_stripe_session_id
      or existing.stripe_customer_id is distinct from p_stripe_customer_id
      or (existing.stripe_subscription_id is not null and existing.stripe_subscription_id is distinct from p_stripe_subscription_id)
    then raise exception 'STRIPE_CHECKOUT_REPLAY_MISMATCH'; end if;
    if existing.state = 'completed' and p_state <> 'completed' then raise exception 'STRIPE_CHECKOUT_STATE_REGRESSION'; end if;
    update public.stripe_checkout_sessions set
      stripe_subscription_id = coalesce(p_stripe_subscription_id, existing.stripe_subscription_id),
      state = p_state, expires_at = p_expires_at, completed_at = p_completed_at
    where id = existing.id;
    return query select existing.id, p_state;
    return;
  end if;
  actor_id := app.phase6_verified_actor(p_actor_id, p_expected_tenant, false, false);
  insert into public.stripe_checkout_sessions (
    id, tenant_id, tier_id, idempotency_key, stripe_session_id, stripe_customer_id,
    stripe_subscription_id, state, expires_at, completed_at
  ) values (
    new_id, p_expected_tenant, p_tier_id, p_idempotency_key, p_stripe_session_id,
    p_stripe_customer_id, p_stripe_subscription_id, p_state, p_expires_at, p_completed_at
  );
  perform app.write_audit_row('billing.checkout.created', actor_id, p_expected_tenant,
    'stripe_checkout_session', new_id::text, null, jsonb_build_object('tier_id', p_tier_id));
  return query select new_id, p_state;
end;
$$;

drop function public.update_billing_tier(uuid,int,int,int,text,text);
create function public.update_billing_tier(
  p_actor_id uuid, p_tier_id uuid, p_price_cents int, p_call_allowance int,
  p_fair_use_cap int, p_fair_use_note text, p_reason text
)
returns table (price_version_id uuid, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  tier_row public.tiers%rowtype; actor_id uuid; version_id uuid := gen_random_uuid(); logged_id bigint;
begin
  actor_id := app.phase6_verified_actor(p_actor_id, null, true, false);
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_TIER_REASON_REQUIRED'; end if;
  if p_price_cents < 0 or p_call_allowance < 0 or (p_fair_use_cap is not null and p_fair_use_cap < p_call_allowance)
    then raise exception 'BILLING_TIER_VALUES_INVALID'; end if;
  select * into tier_row from public.tiers where id = p_tier_id for update;
  if tier_row.id is null then raise exception 'BILLING_TIER_NOT_FOUND'; end if;
  logged_id := app.write_audit_row('billing.tier.updated', actor_id, null, 'tier', p_tier_id::text,
    p_reason, jsonb_build_object('prior_price_cents', tier_row.price_cents,
      'prior_call_allowance', tier_row.call_allowance, 'prior_fair_use_cap', tier_row.fair_use_cap));
  insert into public.tier_price_versions (
    id,tier_id,price_cents,call_allowance,fair_use_cap,fair_use_note,effective_at,actor_id,reason,audit_id
  ) values (version_id,p_tier_id,p_price_cents,p_call_allowance,p_fair_use_cap,p_fair_use_note,now(),actor_id,btrim(p_reason),logged_id);
  update public.tiers set price_cents=p_price_cents, call_allowance=p_call_allowance,
    fair_use_cap=p_fair_use_cap, fair_use_note=p_fair_use_note where id=p_tier_id;
  return query select version_id, logged_id;
end;
$$;

drop function public.set_tenant_price_override(uuid,int,timestamptz,timestamptz,text);
create function public.set_tenant_price_override(
  p_expected_tenant uuid, p_actor_id uuid, p_price_cents int, p_effective_at timestamptz,
  p_ends_at timestamptz, p_reason text
)
returns table (override_id uuid, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare actor_id uuid; new_id uuid := gen_random_uuid(); logged_id bigint;
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  actor_id := app.phase6_verified_actor(p_actor_id, p_expected_tenant, true, false);
  if p_price_cents < 0 then raise exception 'TENANT_PRICE_OVERRIDE_INVALID'; end if;
  if p_effective_at is null or (p_ends_at is not null and p_ends_at <= p_effective_at) then raise exception 'TENANT_PRICE_OVERRIDE_WINDOW_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'TENANT_PRICE_OVERRIDE_REASON_REQUIRED'; end if;
  logged_id := app.write_audit_row('billing.tenant_override.updated',actor_id,p_expected_tenant,
    'tenant_price_override',new_id::text,p_reason,jsonb_build_object('effective_at',p_effective_at,'ends_at',p_ends_at));
  insert into public.tenant_price_overrides (id,tenant_id,price_cents,effective_at,ends_at,actor_id,reason,audit_id)
  values (new_id,p_expected_tenant,p_price_cents,p_effective_at,p_ends_at,actor_id,btrim(p_reason),logged_id);
  return query select new_id, logged_id;
end;
$$;

drop function public.decide_billable_correction(uuid,uuid,text,text);
create function public.decide_billable_correction(
  p_expected_tenant uuid, p_actor_id uuid, p_request_id uuid, p_decision text, p_reason text
)
returns table (decision_id uuid, offset_event_id uuid, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  request_row public.billing_correction_requests%rowtype; existing public.billing_correction_decisions%rowtype;
  actor_id uuid; new_id uuid := gen_random_uuid(); offset_id uuid; logged_id bigint; action_key text;
begin
  actor_id := app.phase6_verified_actor(p_actor_id,p_expected_tenant,true,false);
  if p_decision not in ('approved','rejected') then raise exception 'BILLING_CORRECTION_DECISION_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_CORRECTION_DECISION_REASON_REQUIRED'; end if;
  select * into request_row from public.billing_correction_requests where id=p_request_id for update;
  perform app.assert_expected_tenant(p_expected_tenant,request_row.tenant_id,'billing_correction_request');
  select * into existing from public.billing_correction_decisions where request_id=p_request_id;
  if existing.id is not null then
    if existing.decision is distinct from p_decision then raise exception 'BILLING_CORRECTION_DECISION_REPLAY_MISMATCH'; end if;
    return query select existing.id,existing.offset_event_id,existing.audit_id; return;
  end if;
  if p_decision='approved' then
    insert into public.billable_events (tenant_id,quantity,adjusted_by,adjust_reason,is_test,adjusts_event_id)
    values (p_expected_tenant,request_row.quantity_delta,actor_id,btrim(p_reason),false,request_row.billable_event_id)
    returning id into offset_id;
    action_key := 'billing.correction.approved';
  else action_key := 'billing.correction.rejected'; end if;
  logged_id := app.write_audit_row(action_key,actor_id,p_expected_tenant,'billing_correction_request',
    p_request_id::text,p_reason,jsonb_build_object('decision',p_decision,'offset_event_id',offset_id));
  insert into public.billing_correction_decisions (id,request_id,decision,decided_by,reason,offset_event_id,audit_id)
  values (new_id,p_request_id,p_decision,actor_id,btrim(p_reason),offset_id,logged_id);
  return query select new_id,offset_id,logged_id;
end;
$$;

drop function public.set_tenant_billing_status(uuid,public.tenant_status,text);
create function public.set_tenant_billing_status(
  p_expected_tenant uuid, p_actor_id uuid, p_status public.tenant_status, p_reason text
)
returns table (tenant_id uuid, status public.tenant_status, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  tenant_row public.tenants%rowtype; subscription_row public.billing_subscriptions%rowtype;
  actor_id uuid; logged_id bigint; action_key text;
begin
  actor_id := app.phase6_verified_actor(p_actor_id,p_expected_tenant,true,false);
  if nullif(btrim(p_reason), '') is null then raise exception 'TENANT_BILLING_STATUS_REASON_REQUIRED'; end if;
  select * into tenant_row from public.tenants where id=p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  if tenant_row.status=p_status then
    select audit.id into logged_id from public.audit_log audit
    where audit.action=case when p_status='suspended' then 'billing.tenant.suspended' else 'billing.tenant.unsuspended' end
      and audit.actor_id=actor_id and audit.tenant_id=p_expected_tenant
      and audit.target_type='tenant' and audit.target_id=p_expected_tenant::text and audit.reason=btrim(p_reason)
    order by audit.id desc limit 1;
    if logged_id is null then raise exception 'TENANT_BILLING_STATUS_REPLAY_MISMATCH'; end if;
    return query select p_expected_tenant,p_status,logged_id; return;
  end if;
  select subscription.* into subscription_row from public.billing_subscriptions subscription
  where subscription.tenant_id=p_expected_tenant for update;
  if p_status='suspended' then action_key := 'billing.tenant.suspended';
  elsif tenant_row.status='suspended' and ((p_status='active' and subscription_row.status in ('active','trialing'))
    or (p_status='overdue' and subscription_row.status in ('past_due','unpaid')))
  then action_key := 'billing.tenant.unsuspended';
  else raise exception 'TENANT_BILLING_STATUS_TRANSITION_INVALID'; end if;
  update public.tenants set status=p_status where id=p_expected_tenant;
  logged_id := app.write_audit_row(action_key,actor_id,p_expected_tenant,'tenant',p_expected_tenant::text,
    p_reason,jsonb_build_object('prior_status',tenant_row.status,'status',p_status));
  return query select p_expected_tenant,p_status,logged_id;
end;
$$;

drop function public.approve_commission_payout(uuid,uuid[],text);
create function public.approve_commission_payout(
  p_actor_id uuid, p_affiliate_id uuid, p_ledger_ids uuid[], p_reason text
)
returns table (payout_id uuid, event_id uuid, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  actor_id uuid; new_payout_id uuid:=gen_random_uuid(); new_event_id uuid:=gen_random_uuid();
  logged_id bigint; ledger_count int; total bigint;
begin
  actor_id := app.phase6_verified_actor(p_actor_id,null,true,false);
  if nullif(btrim(p_reason), '') is null then raise exception 'PAYOUT_APPROVAL_REASON_REQUIRED'; end if;
  if p_affiliate_id is null or coalesce(cardinality(p_ledger_ids),0)=0
    or cardinality(p_ledger_ids)<>cardinality(array(select distinct unnest(p_ledger_ids)))
  then raise exception 'PAYOUT_LEDGER_SELECTION_INVALID'; end if;
  perform 1 from public.affiliates where id=p_affiliate_id for update;
  if not found then raise exception 'PAYOUT_AFFILIATE_NOT_FOUND'; end if;
  select count(*)::int,sum(ledger.commission_cents)::bigint into ledger_count,total
  from public.commission_ledger ledger join public.referrals referral on referral.id=ledger.referral_id
  left join public.commission_payout_items item on item.ledger_id=ledger.id
  where ledger.id=any(p_ledger_ids) and referral.affiliate_id=p_affiliate_id and item.ledger_id is null;
  if ledger_count<>cardinality(p_ledger_ids) or coalesce(total,0)<=0 then raise exception 'PAYOUT_LEDGER_SELECTION_INVALID'; end if;
  logged_id := app.write_audit_row('affiliate.payout.approved',actor_id,null,'commission_payout',
    new_payout_id::text,p_reason,jsonb_build_object('affiliate_id',p_affiliate_id,'ledger_count',ledger_count));
  insert into public.commission_payouts (id,affiliate_id,total_cents,created_by) values (new_payout_id,p_affiliate_id,total,actor_id);
  insert into public.commission_payout_items (payout_id,ledger_id,commission_cents)
  select new_payout_id,ledger.id,ledger.commission_cents from public.commission_ledger ledger where ledger.id=any(p_ledger_ids);
  insert into public.commission_payout_events (id,payout_id,kind,actor_id,audit_id)
  values (new_event_id,new_payout_id,'approved',actor_id,logged_id);
  return query select new_payout_id,new_event_id,logged_id;
end;
$$;

drop function public.record_commission_payout_sent(uuid,text,date);
create function public.record_commission_payout_sent(
  p_actor_id uuid, p_payout_id uuid, p_reference text, p_paid_on date
)
returns table (event_id uuid, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  payout_row public.commission_payouts%rowtype; existing public.commission_payout_events%rowtype;
  actor_id uuid; new_event_id uuid:=gen_random_uuid(); logged_id bigint;
begin
  actor_id := app.phase6_verified_actor(p_actor_id,null,true,false);
  if nullif(btrim(p_reference), '') is null or p_paid_on is null then raise exception 'PAYOUT_SENT_RECEIPT_REQUIRED'; end if;
  select * into payout_row from public.commission_payouts where id=p_payout_id for update;
  if payout_row.id is null then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if not exists (select 1 from public.commission_payout_events where payout_id=p_payout_id and kind='approved')
    then raise exception 'PAYOUT_APPROVAL_REQUIRED'; end if;
  select * into existing from public.commission_payout_events where payout_id=p_payout_id and kind='sent';
  if existing.id is not null then
    if existing.reference is distinct from btrim(p_reference) or existing.paid_on is distinct from p_paid_on
      then raise exception 'PAYOUT_SENT_REPLAY_MISMATCH'; end if;
    return query select existing.id,existing.audit_id; return;
  end if;
  logged_id := app.write_audit_row('affiliate.payout.sent',actor_id,null,'commission_payout',p_payout_id::text,
    null,jsonb_build_object('reference',btrim(p_reference),'paid_on',p_paid_on));
  insert into public.commission_payout_events (id,payout_id,kind,reference,paid_on,actor_id,audit_id)
  values (new_event_id,p_payout_id,'sent',btrim(p_reference),p_paid_on,actor_id,logged_id);
  return query select new_event_id,logged_id;
end;
$$;

revoke execute on function app.phase6_verified_actor(uuid,uuid,boolean,boolean) from public,anon,authenticated;
revoke execute on function public.record_stripe_checkout_session(uuid,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz) from public,anon,authenticated;
revoke execute on function public.update_billing_tier(uuid,uuid,int,int,int,text,text) from public,anon,authenticated;
revoke execute on function public.set_tenant_price_override(uuid,uuid,int,timestamptz,timestamptz,text) from public,anon,authenticated;
revoke execute on function public.decide_billable_correction(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke execute on function public.set_tenant_billing_status(uuid,uuid,public.tenant_status,text) from public,anon,authenticated;
revoke execute on function public.approve_commission_payout(uuid,uuid,uuid[],text) from public,anon,authenticated;
revoke execute on function public.record_commission_payout_sent(uuid,uuid,text,date) from public,anon,authenticated;

grant execute on function app.phase6_verified_actor(uuid,uuid,boolean,boolean) to service_role;
grant execute on function public.record_stripe_checkout_session(uuid,uuid,uuid,text,text,text,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.update_billing_tier(uuid,uuid,int,int,int,text,text) to service_role;
grant execute on function public.set_tenant_price_override(uuid,uuid,int,timestamptz,timestamptz,text) to service_role;
grant execute on function public.decide_billable_correction(uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.set_tenant_billing_status(uuid,uuid,public.tenant_status,text) to service_role;
grant execute on function public.approve_commission_payout(uuid,uuid,uuid[],text) to service_role;
grant execute on function public.record_commission_payout_sent(uuid,uuid,text,date) to service_role;
