-- Provider-confirmed completion for renewal-price schedules. A passed effective time is only a
-- candidate for reconciliation; the stored subscription snapshot is changed after Stripe reports
-- the schedule released and the subscription now carries the target Price.
set search_path = public, extensions;

alter table public.allowance_actions
  add column if not exists provider_confirmed_at timestamptz,
  add column if not exists terminal_reason text,
  add column if not exists completion_notice_event_id uuid references public.notifications(id);

alter table public.allowance_actions
  drop constraint if exists allowance_actions_state_chk,
  add constraint allowance_actions_state_chk check (state in (
    'pending', 'awaiting_consent', 'scheduled', 'review', 'completed', 'failed'
  ));

alter table public.allowance_actions
  drop constraint if exists allowance_actions_schedule_shape_chk,
  add constraint allowance_actions_schedule_shape_chk check (
    (state in ('scheduled', 'completed', 'failed') and notice_event_id is not null
      and stripe_schedule_id is not null and pending_tier_id is not null and effective_at is not null)
    or state not in ('scheduled', 'completed', 'failed')
  ),
  add constraint allowance_actions_completion_shape_chk check (
    (state = 'completed' and provider_confirmed_at is not null and terminal_reason is null)
    or (state = 'failed' and provider_confirmed_at is not null
      and nullif(btrim(terminal_reason), '') is not null)
    or state not in ('completed', 'failed')
  );

drop trigger if exists allowance_actions_reject_mutation on public.allowance_actions;
create or replace function app.allowance_action_completion_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then raise exception 'PHASE6_APPEND_ONLY'; end if;
  if old.state = 'scheduled' then
    if new.state = 'completed' then
      if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
        or new.billing_period_start is distinct from old.billing_period_start
        or new.billing_period_end is distinct from old.billing_period_end
        or new.kind is distinct from old.kind or new.threshold is distinct from old.threshold
        or new.observed_count is distinct from old.observed_count
        or new.pending_tier_id is distinct from old.pending_tier_id
        or new.effective_at is distinct from old.effective_at
        or new.notice_event_id is distinct from old.notice_event_id
        or new.stripe_schedule_id is distinct from old.stripe_schedule_id
        or new.created_at is distinct from old.created_at
        or new.terminal_reason is not null then
        raise exception 'ALLOWANCE_ACTION_COMPLETION_MUTATION_INVALID';
      end if;
      return new;
    end if;
    if new.state = 'failed' then
      if new.id is distinct from old.id or new.tenant_id is distinct from old.tenant_id
        or new.billing_period_start is distinct from old.billing_period_start
        or new.billing_period_end is distinct from old.billing_period_end
        or new.kind is distinct from old.kind or new.threshold is distinct from old.threshold
        or new.observed_count is distinct from old.observed_count
        or new.pending_tier_id is distinct from old.pending_tier_id
        or new.effective_at is distinct from old.effective_at
        or new.notice_event_id is distinct from old.notice_event_id
        or new.stripe_schedule_id is distinct from old.stripe_schedule_id
        or new.created_at is distinct from old.created_at
        or new.completion_notice_event_id is not null then
        raise exception 'ALLOWANCE_ACTION_FAILURE_MUTATION_INVALID';
      end if;
      return new;
    end if;
  elsif old.state = 'completed' and new.state = 'completed'
    and old.completion_notice_event_id is null and new.completion_notice_event_id is not null
    and new.id is not distinct from old.id and new.tenant_id is not distinct from old.tenant_id
    and new.billing_period_start is not distinct from old.billing_period_start
    and new.billing_period_end is not distinct from old.billing_period_end
    and new.kind is not distinct from old.kind and new.threshold is not distinct from old.threshold
    and new.observed_count is not distinct from old.observed_count
    and new.pending_tier_id is not distinct from old.pending_tier_id
    and new.effective_at is not distinct from old.effective_at
    and new.notice_event_id is not distinct from old.notice_event_id
    and new.stripe_schedule_id is not distinct from old.stripe_schedule_id
    and new.provider_confirmed_at is not distinct from old.provider_confirmed_at
    and new.terminal_reason is not distinct from old.terminal_reason
    and new.created_at is not distinct from old.created_at then
    return new;
  end if;
  raise exception 'PHASE6_APPEND_ONLY';
end;
$$;
create trigger allowance_actions_reject_mutation
  before update or delete on public.allowance_actions
  for each row execute function app.allowance_action_completion_guard();

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('billing.tier_change.completed', 'system', 'tenant', false, true,
   'Scheduled tier change completed', 'Scheduled tier change completion recorded in the audit log'),
  ('notification.billing.tier_upgraded', 'system', 'tenant', false, true,
   'Tier upgrade notification recorded', 'Tier upgrade notification recorded')
on conflict (key) do nothing;

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled,
   email_subject, email_body, slack_text)
values
  ('billing.tier_upgraded', 'tenant', 'Client upgraded to next tier',
   'Stripe confirmed the scheduled subscription Price change.', 'billing', '{coach}', false,
   true, '{bell}', true, true,
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_BILLING_TIER_UPGRADED',
   'SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_BILLING_TIER_UPGRADED',
   'SETTERFI_DEMO_PLACEHOLDER_SLACK_TEXT_BILLING_TIER_UPGRADED')
on conflict (event_key, scope) do nothing;

alter table public.job_receipts drop constraint if exists job_receipts_job_key_check;
alter table public.job_receipts add constraint job_receipts_job_key_check check (job_key in (
  'a2p-probe', 'agent-inactivity-sweep', 'appointment-reconcile', 'billing-allowances',
  'billing-cost-rollup', 'compliance-reconcile', 'contact-deletion-recovery', 'engine-evals',
  'followups', 'ghl-install-reconcile', 'inbound-recovery', 'notification-deliveries',
  'outbound-reconciliation', 'provisioning-run', 'stripe-webhooks', 'tenant-health-rollup',
  'tier-change-reconcile'
));

create or replace function public.list_due_tier_changes(p_due_before timestamptz, p_limit int)
returns table (
  allowance_action_id uuid,
  tenant_id uuid,
  is_demo boolean,
  stripe_schedule_id text,
  stripe_subscription_id text,
  target_tier_id uuid,
  target_price_id text,
  effective_at timestamptz,
  state text,
  completion_notice_event_id uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    action.id,
    action.tenant_id,
    tenant.is_demo,
    action.stripe_schedule_id,
    subscription.stripe_subscription_id,
    action.pending_tier_id,
    tier.stripe_price_id,
    action.effective_at,
    action.state,
    action.completion_notice_event_id
  from public.allowance_actions as action
  join public.tenants as tenant on tenant.id = action.tenant_id
  join public.billing_subscriptions as subscription on subscription.tenant_id = action.tenant_id
  join public.tiers as tier on tier.id = action.pending_tier_id
  where action.kind = 'crossing'
    and ((action.state = 'scheduled' and action.effective_at <= p_due_before)
      or (action.state = 'completed' and action.completion_notice_event_id is null))
  order by action.effective_at asc, action.id asc
  limit greatest(1, least(p_limit, 100));
$$;

create or replace function public.complete_scheduled_tier_change(
  p_allowance_action_id uuid,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_status text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_provider_updated_at timestamptz,
  p_provider_confirmed_at timestamptz
)
returns table (state text, tenant_id uuid, target_tier_id uuid, target_price_id text, is_demo boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  action_row public.allowance_actions%rowtype;
  subscription_row public.billing_subscriptions%rowtype;
  tier_row public.tiers%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into action_row from public.allowance_actions as action where action.id = p_allowance_action_id for update;
  if action_row.id is null or action_row.kind <> 'crossing' then raise exception 'TIER_CHANGE_ACTION_NOT_FOUND'; end if;
  select * into tier_row from public.tiers as tier where tier.id = action_row.pending_tier_id;
  if tier_row.id is null or tier_row.stripe_price_id is null then raise exception 'TIER_CHANGE_TARGET_TIER_INVALID'; end if;
  if action_row.state = 'completed' then
    return query select action_row.state, action_row.tenant_id, action_row.pending_tier_id, tier_row.stripe_price_id,
      tenant.is_demo from public.tenants as tenant where tenant.id = action_row.tenant_id;
    return;
  end if;
  if action_row.state <> 'scheduled' then raise exception 'TIER_CHANGE_ACTION_NOT_PENDING'; end if;
  if p_stripe_price_id is distinct from tier_row.stripe_price_id then raise exception 'TIER_CHANGE_PROVIDER_PRICE_MISMATCH'; end if;
  select * into subscription_row from public.billing_subscriptions as subscription
    where subscription.tenant_id = action_row.tenant_id for update;
  if subscription_row.id is null or subscription_row.stripe_subscription_id is distinct from p_stripe_subscription_id then
    raise exception 'TIER_CHANGE_SUBSCRIPTION_MISMATCH';
  end if;
  if p_provider_updated_at < subscription_row.provider_updated_at then raise exception 'TIER_CHANGE_PROVIDER_SNAPSHOT_STALE'; end if;
  update public.billing_subscriptions as subscription set
    stripe_price_id = p_stripe_price_id, status = p_status, current_period_start = p_current_period_start,
    current_period_end = p_current_period_end, cancel_at_period_end = p_cancel_at_period_end,
    provider_updated_at = p_provider_updated_at
  where subscription.id = subscription_row.id;
  audit_id := app.write_audit_row('billing.tier_change.completed', null, action_row.tenant_id,
    'allowance_action', action_row.id::text, null,
    jsonb_build_object('stripe_schedule_id', action_row.stripe_schedule_id, 'target_tier_id', action_row.pending_tier_id,
      'target_price_id', tier_row.stripe_price_id), null, null);
  update public.allowance_actions as action set state = 'completed', provider_confirmed_at = p_provider_confirmed_at
    where action.id = action_row.id;
  return query select 'completed'::text, action_row.tenant_id, action_row.pending_tier_id, tier_row.stripe_price_id,
    tenant.is_demo from public.tenants as tenant where tenant.id = action_row.tenant_id;
end;
$$;

create or replace function public.fail_scheduled_tier_change(
  p_allowance_action_id uuid, p_reason text, p_provider_confirmed_at timestamptz
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare action_row public.allowance_actions%rowtype;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_reason), '') is null then raise exception 'TIER_CHANGE_TERMINAL_REASON_REQUIRED'; end if;
  select * into action_row from public.allowance_actions as action where action.id = p_allowance_action_id for update;
  if action_row.id is null or action_row.kind <> 'crossing' then raise exception 'TIER_CHANGE_ACTION_NOT_FOUND'; end if;
  if action_row.state = 'failed' then return 'failed'; end if;
  if action_row.state <> 'scheduled' then raise exception 'TIER_CHANGE_ACTION_NOT_PENDING'; end if;
  update public.allowance_actions as action set state = 'failed', terminal_reason = btrim(p_reason),
    provider_confirmed_at = p_provider_confirmed_at where action.id = action_row.id;
  return 'failed';
end;
$$;

create or replace function public.record_tier_change_completion_notice(
  p_allowance_action_id uuid, p_notification_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare action_row public.allowance_actions%rowtype; notification_row public.notifications%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into action_row from public.allowance_actions as action where action.id = p_allowance_action_id for update;
  if action_row.id is null or action_row.state <> 'completed' then raise exception 'TIER_CHANGE_ACTION_NOT_COMPLETED'; end if;
  if action_row.completion_notice_event_id is not null then return action_row.completion_notice_event_id; end if;
  select * into notification_row from public.notifications as notification where notification.id = p_notification_id;
  if notification_row.id is null or notification_row.tenant_id is distinct from action_row.tenant_id
    or notification_row.kind <> 'billing.tier_upgraded' then raise exception 'TIER_CHANGE_NOTIFICATION_MISMATCH'; end if;
  update public.allowance_actions as action set completion_notice_event_id = p_notification_id where action.id = action_row.id;
  return p_notification_id;
end;
$$;

revoke execute on function public.list_due_tier_changes(timestamptz,int),
  public.complete_scheduled_tier_change(uuid,text,text,text,timestamptz,timestamptz,boolean,timestamptz,timestamptz),
  public.fail_scheduled_tier_change(uuid,text,timestamptz),
  public.record_tier_change_completion_notice(uuid,uuid)
from public, anon, authenticated;
grant execute on function public.list_due_tier_changes(timestamptz,int),
  public.complete_scheduled_tier_change(uuid,text,text,text,timestamptz,timestamptz,boolean,timestamptz,timestamptz),
  public.fail_scheduled_tier_change(uuid,text,timestamptz),
  public.record_tier_change_completion_notice(uuid,uuid)
to service_role;
