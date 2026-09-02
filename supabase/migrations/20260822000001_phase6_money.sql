-- SetterFi Phase 6 money and custody contract.
-- This is the only Phase 6 schema migration. Financial history is append-only, provider mirrors
-- mutate only through guarded RPCs, and incomplete platform-cost evidence never becomes margin.
-- Phase 5 remains the sole writer of referral attribution.

-- ---------------------------------------------------------------------------
-- 1. Fail-loud upstream contract checks before any DDL
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('public.billable_events') is null
    or to_regclass('public.audit_actions') is null
    or to_regclass('public.alert_rules') is null
    or to_regclass('public.commission_ledger') is null then
    raise exception 'PHASE6_PHASE1_MONEY_CONTRACT_REQUIRED';
  end if;
  if to_regprocedure('public.claim_due_followups(uuid,text,integer,integer,timestamp with time zone)') is null then
    raise exception 'PHASE6_PHASE3_FOLLOWUP_CLAIM_CONTRACT_REQUIRED';
  end if;
  if to_regprocedure(
    'public.complete_onboarding_signup(uuid,uuid,text,text,text,text,uuid,text,text,boolean)'
  ) is null then
    raise exception 'PHASE6_PHASE5_SIGNUP_CONTRACT_REQUIRED';
  end if;
  if not exists (
    select 1
    from pg_trigger trigger_row
    where trigger_row.tgrelid = 'public.referrals'::regclass
      and trigger_row.tgname = 'referrals_signup_only'
      and not trigger_row.tgisinternal
  ) then
    raise exception 'PHASE6_PHASE5_REFERRAL_CONTRACT_REQUIRED';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Subscription mirrors
-- ---------------------------------------------------------------------------

create table public.billing_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_subscription_id text not null,
  stripe_price_id text not null,
  status text not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  provider_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint billing_subscriptions_tenant_key unique (tenant_id),
  constraint billing_subscriptions_customer_key unique (stripe_customer_id),
  constraint billing_subscriptions_subscription_key unique (stripe_subscription_id),
  constraint billing_subscriptions_status_chk check (
    status in ('trialing','active','past_due','incomplete','incomplete_expired','unpaid','paused','canceled')
  ),
  constraint billing_subscriptions_period_chk check (current_period_end > current_period_start)
);
create index billing_subscriptions_status_idx
  on public.billing_subscriptions (status, current_period_end);
create index billing_subscriptions_price_idx
  on public.billing_subscriptions (stripe_price_id);

create table public.stripe_checkout_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tier_id uuid not null references public.tiers(id),
  idempotency_key text not null,
  stripe_session_id text not null,
  stripe_customer_id text not null,
  stripe_subscription_id text,
  state text not null default 'open',
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stripe_checkout_sessions_idempotency_key unique (idempotency_key),
  constraint stripe_checkout_sessions_session_key unique (stripe_session_id),
  constraint stripe_checkout_sessions_state_chk check (state in ('open','completed','expired')),
  constraint stripe_checkout_sessions_completion_chk check (
    (state = 'completed' and completed_at is not null and stripe_subscription_id is not null)
    or (state <> 'completed' and completed_at is null)
  )
);
create index stripe_checkout_sessions_tenant_state_idx
  on public.stripe_checkout_sessions (tenant_id, state, created_at desc);

-- ---------------------------------------------------------------------------
-- 3. Append-only price, correction, and commission-window history
-- ---------------------------------------------------------------------------

create table public.tier_price_versions (
  id uuid primary key default gen_random_uuid(),
  tier_id uuid not null references public.tiers(id),
  price_cents int not null,
  call_allowance int not null,
  fair_use_cap int,
  fair_use_note text,
  effective_at timestamptz not null,
  actor_id uuid not null references public.users(id),
  reason text not null,
  audit_id bigint not null references public.audit_log(id),
  created_at timestamptz not null default now(),
  constraint tier_price_versions_values_chk check (
    price_cents >= 0 and call_allowance >= 0
    and (fair_use_cap is null or fair_use_cap >= call_allowance)
  ),
  constraint tier_price_versions_reason_chk check (nullif(btrim(reason), '') is not null),
  constraint tier_price_versions_tier_effective_key unique (tier_id, effective_at)
);
create index tier_price_versions_latest_idx
  on public.tier_price_versions (tier_id, effective_at desc);

create table public.tenant_price_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  price_cents int not null,
  effective_at timestamptz not null,
  ends_at timestamptz,
  actor_id uuid not null references public.users(id),
  reason text not null,
  audit_id bigint not null references public.audit_log(id),
  created_at timestamptz not null default now(),
  constraint tenant_price_overrides_price_chk check (price_cents >= 0),
  constraint tenant_price_overrides_window_chk check (ends_at is null or ends_at > effective_at),
  constraint tenant_price_overrides_reason_chk check (nullif(btrim(reason), '') is not null),
  constraint tenant_price_overrides_tenant_effective_key unique (tenant_id, effective_at)
);
create index tenant_price_overrides_current_idx
  on public.tenant_price_overrides (tenant_id, effective_at desc, ends_at);

create table public.billing_correction_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  billable_event_id uuid not null references public.billable_events(id) on delete restrict,
  quantity_delta int not null,
  requested_by uuid not null references public.users(id),
  reason text not null,
  audit_id bigint not null references public.audit_log(id),
  created_at timestamptz not null default now(),
  constraint billing_correction_requests_delta_chk check (quantity_delta <> 0),
  constraint billing_correction_requests_reason_chk check (nullif(btrim(reason), '') is not null)
);
create index billing_correction_requests_tenant_open_idx
  on public.billing_correction_requests (tenant_id, created_at desc);

create table public.billing_correction_decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  decision text not null,
  decided_by uuid not null references public.users(id),
  reason text not null,
  offset_event_id uuid references public.billable_events(id) on delete restrict,
  audit_id bigint not null references public.audit_log(id),
  created_at timestamptz not null default now(),
  constraint billing_correction_decisions_request_key unique (request_id),
  constraint billing_correction_decisions_request_fk foreign key (request_id)
    references public.billing_correction_requests(id) on delete restrict,
  constraint billing_correction_decisions_value_chk check (decision in ('approved','rejected')),
  constraint billing_correction_decisions_shape_chk check (
    (decision = 'approved' and offset_event_id is not null)
    or (decision = 'rejected' and offset_event_id is null)
  ),
  constraint billing_correction_decisions_reason_chk check (nullif(btrim(reason), '') is not null)
);
create index billing_correction_decisions_created_idx
  on public.billing_correction_decisions (created_at desc);

create table public.referral_commission_windows (
  referral_id uuid primary key references public.referrals(id) on delete restrict,
  first_invoice_id text not null,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint referral_commission_windows_period_chk check (
    expires_at = started_at + interval '12 months'
  )
);
create unique index referral_commission_windows_first_invoice_uidx
  on public.referral_commission_windows (first_invoice_id);

-- ---------------------------------------------------------------------------
-- 4. Payout records, allowance actions, and source-backed costs
-- ---------------------------------------------------------------------------

create table public.commission_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete restrict,
  total_cents bigint not null,
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  constraint commission_payouts_total_chk check (total_cents > 0)
);
create index commission_payouts_affiliate_idx
  on public.commission_payouts (affiliate_id, created_at desc);

create table public.commission_payout_items (
  payout_id uuid not null references public.commission_payouts(id) on delete restrict,
  ledger_id uuid not null references public.commission_ledger(id) on delete restrict,
  commission_cents bigint not null,
  created_at timestamptz not null default now(),
  primary key (payout_id, ledger_id),
  constraint commission_payout_items_ledger_key unique (ledger_id),
  constraint commission_payout_items_amount_chk check (commission_cents <> 0)
);

create table public.commission_payout_events (
  id uuid primary key default gen_random_uuid(),
  payout_id uuid not null references public.commission_payouts(id) on delete restrict,
  kind text not null,
  reference text,
  paid_on date,
  actor_id uuid not null references public.users(id),
  audit_id bigint not null references public.audit_log(id),
  created_at timestamptz not null default now(),
  constraint commission_payout_events_kind_chk check (kind in ('approved','sent')),
  constraint commission_payout_events_shape_chk check (
    (kind = 'approved' and reference is null and paid_on is null)
    or (kind = 'sent' and nullif(btrim(reference), '') is not null and paid_on is not null)
  )
);
create unique index commission_payout_events_approved_uidx
  on public.commission_payout_events (payout_id) where kind = 'approved';
create unique index commission_payout_events_sent_uidx
  on public.commission_payout_events (payout_id) where kind = 'sent';
create index commission_payout_events_payout_idx
  on public.commission_payout_events (payout_id, created_at);

create table public.allowance_actions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  billing_period_start timestamptz not null,
  billing_period_end timestamptz not null,
  kind text not null,
  threshold int not null,
  observed_count int not null,
  pending_tier_id uuid references public.tiers(id),
  effective_at timestamptz,
  notice_event_id uuid references public.notifications(id),
  stripe_schedule_id text,
  state text not null,
  created_at timestamptz not null default now(),
  constraint allowance_actions_kind_chk check (kind in ('warning','crossing','fair_use_review')),
  constraint allowance_actions_state_chk check (state in ('pending','awaiting_consent','scheduled','review')),
  constraint allowance_actions_period_chk check (billing_period_end > billing_period_start),
  constraint allowance_actions_counts_chk check (threshold >= 0 and observed_count >= 0),
  constraint allowance_actions_schedule_shape_chk check (
    (state = 'scheduled' and notice_event_id is not null and stripe_schedule_id is not null
      and pending_tier_id is not null and effective_at is not null)
    or state <> 'scheduled'
  ),
  constraint allowance_actions_period_kind_key unique (tenant_id, billing_period_end, kind)
);
create index allowance_actions_due_idx on public.allowance_actions (state, effective_at);

create table public.tenant_cost_rollups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  window_start timestamptz not null,
  window_end timestamptz not null,
  recognized_subscription_cents bigint not null,
  model_cents bigint,
  messaging_cents bigint,
  embedding_cents bigint,
  total_cost_cents bigint,
  complete boolean not null,
  missing_sources text[] not null default '{}',
  source_evidence jsonb not null default '{}'::jsonb,
  computed_at timestamptz not null default now(),
  constraint tenant_cost_rollups_window_chk check (window_end > window_start),
  constraint tenant_cost_rollups_values_chk check (
    recognized_subscription_cents >= 0 and coalesce(model_cents, 0) >= 0
    and coalesce(messaging_cents, 0) >= 0 and coalesce(embedding_cents, 0) >= 0
  ),
  constraint tenant_cost_rollups_complete_chk check (
    (complete and cardinality(missing_sources) = 0 and model_cents is not null
      and messaging_cents is not null and embedding_cents is not null
      and total_cost_cents = model_cents + messaging_cents + embedding_cents)
    or (not complete and cardinality(missing_sources) > 0 and total_cost_cents is null)
  ),
  constraint tenant_cost_rollups_window_key unique (tenant_id, window_start, window_end)
);
create index tenant_cost_rollups_latest_idx
  on public.tenant_cost_rollups (tenant_id, window_end desc);

-- ---------------------------------------------------------------------------
-- 5. Ordered commission backfill and invoice/adjustment idempotency
-- ---------------------------------------------------------------------------

alter table public.commission_ledger
  add column entry_kind text,
  add column reverses_ledger_id uuid references public.commission_ledger(id) on delete restrict,
  add column stripe_adjustment_id text;
update public.commission_ledger set entry_kind = 'accrual';
alter table public.commission_ledger alter column entry_kind set not null;
alter table public.commission_ledger
  add constraint commission_ledger_entry_kind_chk check (entry_kind in ('accrual','offset','recovery')),
  add constraint commission_ledger_entry_shape_chk check (
    (entry_kind = 'accrual' and commission_cents > 0
      and reverses_ledger_id is null and stripe_adjustment_id is null)
    or (entry_kind = 'offset' and commission_cents < 0
      and reverses_ledger_id is not null and stripe_adjustment_id is not null)
    or (entry_kind = 'recovery' and commission_cents > 0
      and reverses_ledger_id is not null and stripe_adjustment_id is not null)
  );
alter table public.commission_ledger drop constraint commission_ledger_referral_invoice_key;
create unique index commission_ledger_accrual_invoice_uidx
  on public.commission_ledger (referral_id, stripe_invoice_id) where entry_kind = 'accrual';
create unique index commission_ledger_stripe_adjustment_uidx
  on public.commission_ledger (stripe_adjustment_id) where stripe_adjustment_id is not null;
create index commission_ledger_reverses_idx
  on public.commission_ledger (reverses_ledger_id);

-- ---------------------------------------------------------------------------
-- 6. Immutability, mirror timestamps, and demo reclassification custody
-- ---------------------------------------------------------------------------

create or replace function app.reject_phase6_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%_APPEND_ONLY', upper(tg_table_name);
end;
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tier_price_versions', 'tenant_price_overrides', 'billing_correction_requests',
    'billing_correction_decisions', 'referral_commission_windows', 'commission_ledger',
    'commission_payouts', 'commission_payout_items', 'commission_payout_events',
    'allowance_actions', 'tenant_cost_rollups'
  ] loop
    execute format(
      'create trigger %I_reject_mutation before update or delete on public.%I
       for each row execute function app.reject_phase6_append_only()',
      table_name, table_name
    );
  end loop;
end
$$;

create trigger set_updated_at before update on public.billing_subscriptions
for each row execute function app.set_updated_at();
create trigger set_updated_at before update on public.stripe_checkout_sessions
for each row execute function app.set_updated_at();

create or replace function app.reject_phase6_demo_reclassification_with_money()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_demo is not distinct from old.is_demo then return new; end if;
  if exists (select 1 from public.billing_subscriptions where tenant_id = old.id)
    or exists (select 1 from public.stripe_checkout_sessions where tenant_id = old.id)
    or exists (select 1 from public.tenant_price_overrides where tenant_id = old.id)
    or exists (select 1 from public.billing_correction_requests where tenant_id = old.id)
    or exists (select 1 from public.allowance_actions where tenant_id = old.id)
    or exists (select 1 from public.tenant_cost_rollups where tenant_id = old.id)
    or exists (
      select 1 from public.referrals referral
      left join public.referral_commission_windows window_row on window_row.referral_id = referral.id
      left join public.commission_ledger ledger on ledger.referral_id = referral.id
      left join public.commission_payout_items item on item.ledger_id = ledger.id
      where referral.tenant_id = old.id
        and (window_row.referral_id is not null or ledger.id is not null or item.ledger_id is not null)
    ) then
    raise exception 'PHASE6_DEMO_RECLASSIFICATION_WITH_MONEY_FORBIDDEN';
  end if;
  return new;
end;
$$;

create trigger tenants_reject_phase6_demo_reclassification_with_money
before update of is_demo on public.tenants
for each row execute function app.reject_phase6_demo_reclassification_with_money();

-- ---------------------------------------------------------------------------
-- 7. Forced RLS and narrow table custody
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'billing_subscriptions', 'stripe_checkout_sessions', 'tier_price_versions',
    'tenant_price_overrides', 'billing_correction_requests', 'billing_correction_decisions',
    'referral_commission_windows', 'commission_payouts', 'commission_payout_items',
    'commission_payout_events', 'allowance_actions', 'tenant_cost_rollups'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end
$$;

create policy billing_subscriptions_platform_read on public.billing_subscriptions
  for select to authenticated using (app.is_platform_operator());
create policy stripe_checkout_sessions_platform_read on public.stripe_checkout_sessions
  for select to authenticated using (app.is_platform_operator());
create policy allowance_actions_platform_read on public.allowance_actions
  for select to authenticated using (app.is_platform_operator());

create policy tier_price_versions_admin_read on public.tier_price_versions
  for select to authenticated using (app.is_platform_admin());
create policy tenant_price_overrides_admin_read on public.tenant_price_overrides
  for select to authenticated using (app.is_platform_admin());
create policy billing_correction_requests_admin_read on public.billing_correction_requests
  for select to authenticated using (app.is_platform_admin());
create policy billing_correction_decisions_admin_read on public.billing_correction_decisions
  for select to authenticated using (app.is_platform_admin());
create policy referral_commission_windows_admin_read on public.referral_commission_windows
  for select to authenticated using (app.is_platform_admin());
create policy commission_payouts_admin_read on public.commission_payouts
  for select to authenticated using (app.is_platform_admin());
create policy commission_payout_items_admin_read on public.commission_payout_items
  for select to authenticated using (app.is_platform_admin());
create policy commission_payout_events_admin_read on public.commission_payout_events
  for select to authenticated using (app.is_platform_admin());
create policy tenant_cost_rollups_admin_read on public.tenant_cost_rollups
  for select to authenticated using (app.is_platform_admin());

revoke all on public.billing_subscriptions, public.stripe_checkout_sessions,
  public.tier_price_versions, public.tenant_price_overrides,
  public.billing_correction_requests, public.billing_correction_decisions,
  public.referral_commission_windows, public.commission_payouts,
  public.commission_payout_items, public.commission_payout_events,
  public.allowance_actions, public.tenant_cost_rollups
from anon, authenticated, service_role;

grant select on public.billing_subscriptions, public.stripe_checkout_sessions,
  public.tier_price_versions, public.tenant_price_overrides,
  public.billing_correction_requests, public.billing_correction_decisions,
  public.referral_commission_windows, public.commission_payouts,
  public.commission_payout_items, public.commission_payout_events,
  public.allowance_actions, public.tenant_cost_rollups
to authenticated, service_role;

-- The ledger has two deliberate SELECT policies. Mutations go through Phase 6 RPCs even for the
-- BYPASSRLS role so direct service clients cannot rewrite financial history.
revoke insert, update, delete, truncate on public.commission_ledger from service_role;

-- ---------------------------------------------------------------------------
-- 8. Exact audit and alert registries
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('affiliate.payout.approved', 'human', 'platform', true, false,
   'Payout approval logged', 'Affiliate payout approval recorded in the audit log'),
  ('affiliate.payout.sent', 'human', 'platform', false, false,
   'Payout sent record logged', 'Affiliate payout sent record recorded in the audit log'),
  ('billing.checkout.created', 'human', 'tenant', false, true,
   'Checkout logged', 'Billing checkout creation recorded in the audit log'),
  ('billing.correction.approved', 'human', 'tenant', true, true,
   'Correction approval logged', 'Billing correction approval recorded in the audit log'),
  ('billing.correction.rejected', 'human', 'tenant', true, true,
   'Correction rejection logged', 'Billing correction rejection recorded in the audit log'),
  ('billing.correction.requested', 'human', 'tenant', true, true,
   'Correction request logged', 'Billing correction request recorded in the audit log'),
  ('billing.tenant.suspended', 'human', 'tenant', true, true,
   'Suspension logged', 'Tenant billing suspension recorded in the audit log'),
  ('billing.tenant.unsuspended', 'human', 'tenant', true, true,
   'Reactivation logged', 'Tenant billing reactivation recorded in the audit log'),
  ('billing.tenant_override.updated', 'human', 'tenant', true, true,
   'Price override logged', 'Tenant price override recorded in the audit log'),
  ('billing.tier.updated', 'human', 'platform', true, false,
   'Tier update logged', 'Billing tier update recorded in the audit log');

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles,
   include_success_owner, include_billing_contact, default_destinations,
   suppressible, default_enabled)
values
  ('billing.account_overdue', 'tenant', 'Account overdue',
   'The latest subscription invoice remains unpaid.', 'billing', '{coach}',
   false, true, '{bell,email}', false, true),
  ('billing.account_suspended', 'tenant', 'Account suspended',
   'The platform suspended new billing activity for this account.', 'billing', '{coach}',
   false, true, '{bell,email}', false, true),
  ('billing.allowance_crossed', 'tenant', 'Allowance crossed',
   'The booked-call allowance was crossed for this billing period.', 'billing', '{coach}',
   false, true, '{bell,email}', false, true),
  ('billing.allowance_warning', 'tenant', 'Allowance warning',
   'The booked-call allowance reached its warning threshold.', 'billing', '{coach}',
   false, true, '{bell,email}', false, true),
  ('billing.payment_failed', 'tenant', 'Payment failed',
   'A subscription invoice payment failed.', 'billing', '{coach}',
   false, true, '{bell,email}', false, true);

-- ---------------------------------------------------------------------------
-- 9. Shared actor and tenant helpers
-- ---------------------------------------------------------------------------

create or replace function app.phase6_human_actor(
  p_expected_tenant uuid default null,
  p_platform_only boolean default false,
  p_coach_only boolean default false
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_id uuid := app.current_user_id();
  actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users where id = actor_id;
  if actor_row.id is null or actor_row.role::text is distinct from app.current_user_role()::text then
    raise exception 'PHASE6_ACTOR_REQUIRED';
  end if;
  if p_platform_only and actor_row.role not in ('owner','admin') then
    raise exception 'PHASE6_OWNER_ADMIN_REQUIRED';
  end if;
  if p_coach_only and (
    actor_row.role not in ('coach','coach_member')
    or actor_row.tenant_id is distinct from p_expected_tenant
  ) then
    raise exception 'PHASE6_COACH_TENANT_REQUIRED';
  end if;
  if not p_platform_only and not p_coach_only
    and actor_row.role not in ('owner','admin')
    and actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'PHASE6_ACTOR_TENANT_MISMATCH';
  end if;
  return actor_id;
end;
$$;

create or replace function app.phase6_assert_tenant(p_expected_tenant uuid)
returns public.tenants
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
begin
  select * into tenant_row from public.tenants where id = p_expected_tenant;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  return tenant_row;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Checkout and subscription mirror RPCs
-- ---------------------------------------------------------------------------

create or replace function public.record_stripe_checkout_session(
  p_expected_tenant uuid,
  p_tier_id uuid,
  p_idempotency_key text,
  p_stripe_session_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_state text,
  p_expires_at timestamptz,
  p_completed_at timestamptz
)
returns table (checkout_session_id uuid, state text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.stripe_checkout_sessions%rowtype;
  new_id uuid := gen_random_uuid();
  actor_id uuid;
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  if not exists (select 1 from public.tiers where id = p_tier_id and active) then
    raise exception 'BILLING_TIER_NOT_FOUND';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null
    or nullif(btrim(p_stripe_session_id), '') is null
    or nullif(btrim(p_stripe_customer_id), '') is null then
    raise exception 'STRIPE_CHECKOUT_REQUIRED_FIELD_MISSING';
  end if;

  select * into existing from public.stripe_checkout_sessions
  where idempotency_key = p_idempotency_key for update;
  if existing.id is not null then
    if existing.tenant_id is distinct from p_expected_tenant
      or existing.tier_id is distinct from p_tier_id
      or existing.stripe_session_id is distinct from p_stripe_session_id
      or existing.stripe_customer_id is distinct from p_stripe_customer_id
      or (
        existing.stripe_subscription_id is not null
        and existing.stripe_subscription_id is distinct from p_stripe_subscription_id
      ) then
      raise exception 'STRIPE_CHECKOUT_REPLAY_MISMATCH';
    end if;
    if existing.state = 'completed' and p_state <> 'completed' then
      raise exception 'STRIPE_CHECKOUT_STATE_REGRESSION';
    end if;
    update public.stripe_checkout_sessions
    set stripe_subscription_id = coalesce(p_stripe_subscription_id, existing.stripe_subscription_id),
        state = p_state, expires_at = p_expires_at, completed_at = p_completed_at
    where id = existing.id;
    return query select existing.id, p_state;
    return;
  end if;

  actor_id := app.phase6_human_actor(p_expected_tenant, false, false);
  insert into public.stripe_checkout_sessions (
    id, tenant_id, tier_id, idempotency_key, stripe_session_id, stripe_customer_id,
    stripe_subscription_id, state, expires_at, completed_at
  ) values (
    new_id, p_expected_tenant, p_tier_id, p_idempotency_key, p_stripe_session_id,
    p_stripe_customer_id, p_stripe_subscription_id, p_state, p_expires_at, p_completed_at
  );
  perform app.write_audit_row(
    'billing.checkout.created', actor_id, p_expected_tenant, 'stripe_checkout_session',
    new_id::text, null, jsonb_build_object('tier_id', p_tier_id)
  );
  return query select new_id, p_state;
end;
$$;

create or replace function public.apply_billing_subscription_snapshot(
  p_expected_tenant uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_status text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_provider_updated_at timestamptz
)
returns table (subscription_row_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  existing public.billing_subscriptions%rowtype;
  new_id uuid := gen_random_uuid();
begin
  perform app.assert_not_impersonating();
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  if tenant_row.stripe_customer_id is not null
    and tenant_row.stripe_customer_id is distinct from p_stripe_customer_id then
    raise exception 'STRIPE_CUSTOMER_TENANT_MISMATCH';
  end if;
  if tenant_row.stripe_subscription_id is not null
    and tenant_row.stripe_subscription_id is distinct from p_stripe_subscription_id then
    raise exception 'STRIPE_SUBSCRIPTION_TENANT_MISMATCH';
  end if;

  select * into existing from public.billing_subscriptions
  where tenant_id = p_expected_tenant for update;
  if existing.id is not null then
    if existing.stripe_customer_id is distinct from p_stripe_customer_id
      or existing.stripe_subscription_id is distinct from p_stripe_subscription_id then
      raise exception 'STRIPE_SUBSCRIPTION_REPLAY_MISMATCH';
    end if;
    if p_provider_updated_at < existing.provider_updated_at then
      raise exception 'STRIPE_SUBSCRIPTION_STALE_SNAPSHOT';
    end if;
    if p_provider_updated_at = existing.provider_updated_at then
      if existing.stripe_price_id is distinct from p_stripe_price_id
        or existing.status is distinct from p_status
        or existing.current_period_start is distinct from p_current_period_start
        or existing.current_period_end is distinct from p_current_period_end
        or existing.cancel_at_period_end is distinct from p_cancel_at_period_end then
        raise exception 'STRIPE_SUBSCRIPTION_TIMESTAMP_COLLISION';
      end if;
      return query select existing.id, existing.status;
      return;
    end if;
    update public.billing_subscriptions
    set stripe_price_id = p_stripe_price_id, status = p_status,
        current_period_start = p_current_period_start,
        current_period_end = p_current_period_end,
        cancel_at_period_end = p_cancel_at_period_end,
        provider_updated_at = p_provider_updated_at
    where id = existing.id;
    subscription_row_id := existing.id;
  else
    insert into public.billing_subscriptions (
      id, tenant_id, stripe_customer_id, stripe_subscription_id, stripe_price_id, status,
      current_period_start, current_period_end, cancel_at_period_end, provider_updated_at
    ) values (
      new_id, p_expected_tenant, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_status, p_current_period_start, p_current_period_end,
      p_cancel_at_period_end, p_provider_updated_at
    );
    subscription_row_id := new_id;
  end if;
  update public.tenants
  set stripe_customer_id = coalesce(stripe_customer_id, p_stripe_customer_id),
      stripe_subscription_id = coalesce(stripe_subscription_id, p_stripe_subscription_id)
  where id = p_expected_tenant;
  status := p_status;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Human price, correction, and tenant-state RPCs
-- ---------------------------------------------------------------------------

create or replace function public.update_billing_tier(
  p_tier_id uuid,
  p_price_cents int,
  p_call_allowance int,
  p_fair_use_cap int,
  p_fair_use_note text,
  p_reason text
)
returns table (price_version_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tier_row public.tiers%rowtype;
  actor_id uuid;
  version_id uuid := gen_random_uuid();
  logged_id bigint;
begin
  actor_id := app.phase6_human_actor(null, true, false);
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_TIER_REASON_REQUIRED'; end if;
  if p_price_cents < 0 or p_call_allowance < 0
    or (p_fair_use_cap is not null and p_fair_use_cap < p_call_allowance) then
    raise exception 'BILLING_TIER_VALUES_INVALID';
  end if;
  select * into tier_row from public.tiers where id = p_tier_id for update;
  if tier_row.id is null then raise exception 'BILLING_TIER_NOT_FOUND'; end if;
  logged_id := app.write_audit_row(
    'billing.tier.updated', actor_id, null, 'tier', p_tier_id::text, p_reason,
    jsonb_build_object(
      'prior_price_cents', tier_row.price_cents,
      'prior_call_allowance', tier_row.call_allowance,
      'prior_fair_use_cap', tier_row.fair_use_cap
    )
  );
  insert into public.tier_price_versions (
    id, tier_id, price_cents, call_allowance, fair_use_cap, fair_use_note,
    effective_at, actor_id, reason, audit_id
  ) values (
    version_id, p_tier_id, p_price_cents, p_call_allowance, p_fair_use_cap,
    p_fair_use_note, now(), actor_id, btrim(p_reason), logged_id
  );
  update public.tiers
  set price_cents = p_price_cents, call_allowance = p_call_allowance,
      fair_use_cap = p_fair_use_cap, fair_use_note = p_fair_use_note
  where id = p_tier_id;
  return query select version_id, logged_id;
end;
$$;

create or replace function public.set_tenant_price_override(
  p_expected_tenant uuid,
  p_price_cents int,
  p_effective_at timestamptz,
  p_ends_at timestamptz,
  p_reason text
)
returns table (override_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  new_id uuid := gen_random_uuid();
  logged_id bigint;
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  actor_id := app.phase6_human_actor(p_expected_tenant, true, false);
  if p_price_cents < 0 then raise exception 'TENANT_PRICE_OVERRIDE_INVALID'; end if;
  if p_effective_at is null or (p_ends_at is not null and p_ends_at <= p_effective_at) then
    raise exception 'TENANT_PRICE_OVERRIDE_WINDOW_INVALID';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'TENANT_PRICE_OVERRIDE_REASON_REQUIRED'; end if;
  logged_id := app.write_audit_row(
    'billing.tenant_override.updated', actor_id, p_expected_tenant,
    'tenant_price_override', new_id::text, p_reason,
    jsonb_build_object('effective_at', p_effective_at, 'ends_at', p_ends_at)
  );
  insert into public.tenant_price_overrides (
    id, tenant_id, price_cents, effective_at, ends_at, actor_id, reason, audit_id
  ) values (
    new_id, p_expected_tenant, p_price_cents, p_effective_at, p_ends_at,
    actor_id, btrim(p_reason), logged_id
  );
  return query select new_id, logged_id;
end;
$$;

create or replace function public.request_billable_correction(
  p_expected_tenant uuid,
  p_event_id uuid,
  p_quantity_delta int,
  p_reason text
)
returns table (request_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_row public.billable_events%rowtype;
  actor_id uuid;
  new_id uuid := gen_random_uuid();
  logged_id bigint;
begin
  actor_id := app.phase6_human_actor(p_expected_tenant, false, true);
  if p_quantity_delta = 0 then raise exception 'BILLING_CORRECTION_DELTA_REQUIRED'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_CORRECTION_REASON_REQUIRED'; end if;
  select * into event_row from public.billable_events where id = p_event_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, event_row.tenant_id, 'billable_event');
  if event_row.id is null or event_row.adjusts_event_id is not null
    or event_row.appointment_id is null or event_row.is_test then
    raise exception 'BILLING_CORRECTION_PRIMARY_EVENT_REQUIRED';
  end if;
  if exists (
    select 1 from public.billing_correction_requests request_row
    left join public.billing_correction_decisions decision_row on decision_row.request_id = request_row.id
    where request_row.billable_event_id = p_event_id and decision_row.id is null
  ) then
    raise exception 'BILLING_CORRECTION_ALREADY_OPEN';
  end if;
  logged_id := app.write_audit_row(
    'billing.correction.requested', actor_id, p_expected_tenant,
    'billing_correction_request', new_id::text, p_reason,
    jsonb_build_object('billable_event_id', p_event_id, 'quantity_delta', p_quantity_delta)
  );
  insert into public.billing_correction_requests (
    id, tenant_id, billable_event_id, quantity_delta, requested_by, reason, audit_id
  ) values (
    new_id, p_expected_tenant, p_event_id, p_quantity_delta, actor_id, btrim(p_reason), logged_id
  );
  return query select new_id, logged_id;
end;
$$;

create or replace function public.decide_billable_correction(
  p_expected_tenant uuid,
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
  actor_id := app.phase6_human_actor(p_expected_tenant, true, false);
  if p_decision not in ('approved','rejected') then raise exception 'BILLING_CORRECTION_DECISION_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'BILLING_CORRECTION_DECISION_REASON_REQUIRED'; end if;
  select * into request_row from public.billing_correction_requests
  where id = p_request_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, request_row.tenant_id, 'billing_correction_request');
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

create or replace function public.set_tenant_billing_status(
  p_expected_tenant uuid,
  p_status public.tenant_status,
  p_reason text
)
returns table (tenant_id uuid, status public.tenant_status, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  subscription_row public.billing_subscriptions%rowtype;
  actor_id uuid;
  logged_id bigint;
  action_key text;
begin
  actor_id := app.phase6_human_actor(p_expected_tenant, true, false);
  if nullif(btrim(p_reason), '') is null then raise exception 'TENANT_BILLING_STATUS_REASON_REQUIRED'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  select subscription.* into subscription_row
  from public.billing_subscriptions subscription
  where subscription.tenant_id = p_expected_tenant for update;
  if p_status = 'suspended' then
    if tenant_row.status = 'suspended' then raise exception 'TENANT_ALREADY_SUSPENDED'; end if;
    action_key := 'billing.tenant.suspended';
  elsif tenant_row.status = 'suspended' and (
    (p_status = 'active' and subscription_row.status in ('active','trialing'))
    or (p_status = 'overdue' and subscription_row.status in ('past_due','unpaid'))
  ) then
    action_key := 'billing.tenant.unsuspended';
  else
    raise exception 'TENANT_BILLING_STATUS_TRANSITION_INVALID';
  end if;
  update public.tenants set status = p_status where id = p_expected_tenant;
  logged_id := app.write_audit_row(
    action_key, actor_id, p_expected_tenant, 'tenant', p_expected_tenant::text,
    p_reason, jsonb_build_object('prior_status', tenant_row.status, 'status', p_status)
  );
  return query select p_expected_tenant, p_status, logged_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 12. Commission accrual, reversal, and payout RPCs
-- ---------------------------------------------------------------------------

create or replace function public.accrue_invoice_commission(
  p_expected_tenant uuid,
  p_stripe_invoice_id text,
  p_invoice_paid_at timestamptz,
  p_amount_paid_cents bigint,
  p_total_excluding_tax_cents bigint
)
returns table (ledger_id uuid, referral_id uuid, window_started boolean, commission_cents bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  referral_row public.referrals%rowtype;
  window_row public.referral_commission_windows%rowtype;
  existing public.commission_ledger%rowtype;
  new_id uuid := gen_random_uuid();
  cents bigint;
  started boolean := false;
begin
  perform app.assert_not_impersonating();
  perform app.phase6_assert_tenant(p_expected_tenant);
  if nullif(btrim(p_stripe_invoice_id), '') is null or p_invoice_paid_at is null
    or p_amount_paid_cents < 0 or p_total_excluding_tax_cents < 0
    or p_amount_paid_cents < p_total_excluding_tax_cents then
    raise exception 'COMMISSION_INVOICE_FINANCIALS_INVALID';
  end if;
  if p_amount_paid_cents = 0 then return; end if;
  select * into referral_row from public.referrals
  where tenant_id = p_expected_tenant for update;
  if referral_row.id is null then return; end if;
  select * into existing from public.commission_ledger
  where public.commission_ledger.referral_id = referral_row.id
    and stripe_invoice_id = p_stripe_invoice_id and entry_kind = 'accrual';
  if existing.id is not null then
    return query select existing.id, existing.referral_id, false, existing.commission_cents::bigint;
    return;
  end if;
  if exists (
    select 1 from public.billing_subscriptions
    where tenant_id = p_expected_tenant and status = 'canceled'
  ) then return; end if;
  select * into window_row from public.referral_commission_windows
  where public.referral_commission_windows.referral_id = referral_row.id for update;
  if window_row.referral_id is null then
    insert into public.referral_commission_windows (
      referral_id, first_invoice_id, started_at, expires_at
    ) values (
      referral_row.id, p_stripe_invoice_id, p_invoice_paid_at,
      p_invoice_paid_at + interval '12 months'
    ) returning * into window_row;
    started := true;
  end if;
  if p_invoice_paid_at < window_row.started_at or p_invoice_paid_at >= window_row.expires_at then
    return;
  end if;
  cents := round(p_total_excluding_tax_cents::numeric * 0.10)::bigint;
  if cents <= 0 then return; end if;
  if cents > 2147483647 or p_total_excluding_tax_cents > 2147483647 then
    raise exception 'COMMISSION_VALUE_OUT_OF_RANGE';
  end if;
  insert into public.commission_ledger (
    id, referral_id, stripe_invoice_id, invoice_paid_at, base_cents,
    commission_cents, entry_kind
  ) values (
    new_id, referral_row.id, p_stripe_invoice_id, p_invoice_paid_at,
    p_total_excluding_tax_cents::int, cents::int, 'accrual'
  );
  return query select new_id, referral_row.id, started, cents;
end;
$$;

create or replace function public.reverse_invoice_commission(
  p_expected_tenant uuid,
  p_stripe_invoice_id text,
  p_stripe_adjustment_id text,
  p_adjustment_kind text,
  p_adjustment_cents bigint,
  p_occurred_at timestamptz
)
returns table (ledger_id uuid, reversed_cents bigint, entry_kind text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  accrual public.commission_ledger%rowtype;
  existing public.commission_ledger%rowtype;
  new_id uuid := gen_random_uuid();
  prior_offsets bigint;
  prior_recoveries bigint;
  available bigint;
  written bigint;
  kind text;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_stripe_adjustment_id), '') is null or p_adjustment_cents <= 0
    or p_occurred_at is null
    or p_adjustment_kind not in ('refund','dispute_loss','dispute_recovery') then
    raise exception 'COMMISSION_ADJUSTMENT_INVALID';
  end if;
  select ledger.* into existing from public.commission_ledger ledger
  where ledger.stripe_adjustment_id = p_stripe_adjustment_id;
  if existing.id is not null then
    return query select existing.id, abs(existing.commission_cents)::bigint, existing.entry_kind;
    return;
  end if;
  select ledger.* into accrual
  from public.commission_ledger ledger
  join public.referrals referral on referral.id = ledger.referral_id
  where referral.tenant_id = p_expected_tenant
    and ledger.stripe_invoice_id = p_stripe_invoice_id
    and ledger.entry_kind = 'accrual'
  for update of ledger;
  if accrual.id is null then raise exception 'COMMISSION_ACCRUAL_NOT_FOUND'; end if;
  select coalesce(sum(abs(ledger.commission_cents)), 0)::bigint into prior_offsets
  from public.commission_ledger ledger
  where ledger.reverses_ledger_id = accrual.id and ledger.entry_kind = 'offset';
  select coalesce(sum(ledger.commission_cents), 0)::bigint into prior_recoveries
  from public.commission_ledger ledger
  where ledger.reverses_ledger_id = accrual.id and ledger.entry_kind = 'recovery';
  if p_adjustment_kind = 'dispute_recovery' then
    available := greatest(prior_offsets - prior_recoveries, 0);
    kind := 'recovery';
  else
    available := greatest(accrual.commission_cents::bigint - prior_offsets + prior_recoveries, 0);
    kind := 'offset';
  end if;
  written := least(p_adjustment_cents, available);
  if written = 0 then return; end if;
  if written > 2147483647 then raise exception 'COMMISSION_VALUE_OUT_OF_RANGE'; end if;
  insert into public.commission_ledger (
    id, referral_id, stripe_invoice_id, invoice_paid_at, base_cents,
    commission_cents, entry_kind, reverses_ledger_id, stripe_adjustment_id
  ) values (
    new_id, accrual.referral_id, accrual.stripe_invoice_id, p_occurred_at, 0,
    case when kind = 'offset' then -written::int else written::int end,
    kind, accrual.id, p_stripe_adjustment_id
  );
  return query select new_id, written, kind;
end;
$$;

create or replace function public.approve_commission_payout(
  p_affiliate_id uuid,
  p_ledger_ids uuid[],
  p_reason text
)
returns table (payout_id uuid, event_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid;
  new_payout_id uuid := gen_random_uuid();
  new_event_id uuid := gen_random_uuid();
  logged_id bigint;
  ledger_count int;
  total bigint;
begin
  actor_id := app.phase6_human_actor(null, true, false);
  if nullif(btrim(p_reason), '') is null then raise exception 'PAYOUT_APPROVAL_REASON_REQUIRED'; end if;
  if p_affiliate_id is null or coalesce(cardinality(p_ledger_ids), 0) = 0
    or cardinality(p_ledger_ids) <> cardinality(array(select distinct unnest(p_ledger_ids))) then
    raise exception 'PAYOUT_LEDGER_SELECTION_INVALID';
  end if;
  perform 1 from public.affiliates where id = p_affiliate_id for update;
  if not found then raise exception 'PAYOUT_AFFILIATE_NOT_FOUND'; end if;
  select count(*)::int, sum(ledger.commission_cents)::bigint
  into ledger_count, total
  from public.commission_ledger ledger
  join public.referrals referral on referral.id = ledger.referral_id
  left join public.commission_payout_items existing_item on existing_item.ledger_id = ledger.id
  where ledger.id = any(p_ledger_ids)
    and referral.affiliate_id = p_affiliate_id
    and existing_item.ledger_id is null;
  if ledger_count <> cardinality(p_ledger_ids) or coalesce(total, 0) <= 0 then
    raise exception 'PAYOUT_LEDGER_SELECTION_INVALID';
  end if;
  logged_id := app.write_audit_row(
    'affiliate.payout.approved', actor_id, null, 'commission_payout',
    new_payout_id::text, p_reason,
    jsonb_build_object('affiliate_id', p_affiliate_id, 'ledger_count', ledger_count)
  );
  insert into public.commission_payouts (id, affiliate_id, total_cents, created_by)
  values (new_payout_id, p_affiliate_id, total, actor_id);
  insert into public.commission_payout_items (payout_id, ledger_id, commission_cents)
  select new_payout_id, ledger.id, ledger.commission_cents
  from public.commission_ledger ledger where ledger.id = any(p_ledger_ids);
  insert into public.commission_payout_events (
    id, payout_id, kind, actor_id, audit_id
  ) values (
    new_event_id, new_payout_id, 'approved', actor_id, logged_id
  );
  return query select new_payout_id, new_event_id, logged_id;
end;
$$;

create or replace function public.record_commission_payout_sent(
  p_payout_id uuid,
  p_reference text,
  p_paid_on date
)
returns table (event_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  payout_row public.commission_payouts%rowtype;
  existing public.commission_payout_events%rowtype;
  actor_id uuid;
  new_event_id uuid := gen_random_uuid();
  logged_id bigint;
begin
  actor_id := app.phase6_human_actor(null, true, false);
  if nullif(btrim(p_reference), '') is null or p_paid_on is null then
    raise exception 'PAYOUT_SENT_RECEIPT_REQUIRED';
  end if;
  select * into payout_row from public.commission_payouts where id = p_payout_id for update;
  if payout_row.id is null then raise exception 'PAYOUT_NOT_FOUND'; end if;
  if not exists (
    select 1 from public.commission_payout_events
    where payout_id = p_payout_id and kind = 'approved'
  ) then raise exception 'PAYOUT_APPROVAL_REQUIRED'; end if;
  select * into existing from public.commission_payout_events
  where payout_id = p_payout_id and kind = 'sent';
  if existing.id is not null then
    if existing.reference is distinct from btrim(p_reference)
      or existing.paid_on is distinct from p_paid_on then
      raise exception 'PAYOUT_SENT_REPLAY_MISMATCH';
    end if;
    return query select existing.id, existing.audit_id;
    return;
  end if;
  logged_id := app.write_audit_row(
    'affiliate.payout.sent', actor_id, null, 'commission_payout',
    p_payout_id::text, null,
    jsonb_build_object('reference', btrim(p_reference), 'paid_on', p_paid_on)
  );
  insert into public.commission_payout_events (
    id, payout_id, kind, reference, paid_on, actor_id, audit_id
  ) values (
    new_event_id, p_payout_id, 'sent', btrim(p_reference), p_paid_on, actor_id, logged_id
  );
  return query select new_event_id, logged_id;
end;
$$;

create or replace function public.affiliate_referral_projection()
returns table (business_name text, account_status text, commission_earned_cents bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select tenant.name,
    case
      when tenant.status in ('active','overdue','suspended','paused') then 'active'
      else 'inactive'
    end,
    coalesce(sum(ledger.commission_cents), 0)::bigint
  from public.affiliates affiliate
  join public.referrals referral on referral.affiliate_id = affiliate.id
  join public.tenants tenant on tenant.id = referral.tenant_id
  left join public.commission_ledger ledger on ledger.referral_id = referral.id
  where affiliate.user_id = app.current_user_id()
  group by tenant.id, tenant.name, tenant.status
  order by tenant.name, tenant.id;
$$;

-- ---------------------------------------------------------------------------
-- 13. Provider invoice state, allowance, and cost evidence RPCs
-- ---------------------------------------------------------------------------

create or replace function public.apply_stripe_invoice_paid(
  p_expected_tenant uuid,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_invoice_paid_at timestamptz,
  p_amount_paid_cents bigint,
  p_total_excluding_tax_cents bigint,
  p_provider_updated_at timestamptz
)
returns table (
  subscription_row_id uuid,
  tenant_status public.tenant_status,
  commission_ledger_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_row public.billing_subscriptions%rowtype;
  tenant_row public.tenants%rowtype;
  accrued record;
begin
  perform app.assert_not_impersonating();
  select * into subscription_row from public.billing_subscriptions
  where stripe_subscription_id = p_stripe_subscription_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, subscription_row.tenant_id, 'billing_subscription');
  if p_provider_updated_at < subscription_row.provider_updated_at then
    raise exception 'STRIPE_INVOICE_STALE_EVENT';
  end if;
  update public.billing_subscriptions
  set status = 'active', provider_updated_at = greatest(provider_updated_at, p_provider_updated_at)
  where id = subscription_row.id;
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.status = 'overdue' then
    update public.tenants set status = 'active' where id = p_expected_tenant;
    tenant_row.status := 'active';
  end if;
  select * into accrued from public.accrue_invoice_commission(
    p_expected_tenant, p_stripe_invoice_id, p_invoice_paid_at,
    p_amount_paid_cents, p_total_excluding_tax_cents
  );
  return query select subscription_row.id, tenant_row.status,
    accrued.ledger_id::uuid;
end;
$$;

create or replace function public.apply_stripe_invoice_failed(
  p_expected_tenant uuid,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_provider_updated_at timestamptz
)
returns table (subscription_row_id uuid, tenant_status public.tenant_status)
language plpgsql
security definer
set search_path = ''
as $$
declare
  subscription_row public.billing_subscriptions%rowtype;
  tenant_row public.tenants%rowtype;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_stripe_invoice_id), '') is null then raise exception 'STRIPE_INVOICE_ID_REQUIRED'; end if;
  select * into subscription_row from public.billing_subscriptions
  where stripe_subscription_id = p_stripe_subscription_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, subscription_row.tenant_id, 'billing_subscription');
  if p_provider_updated_at < subscription_row.provider_updated_at then
    raise exception 'STRIPE_INVOICE_STALE_EVENT';
  end if;
  update public.billing_subscriptions
  set status = 'past_due', provider_updated_at = greatest(provider_updated_at, p_provider_updated_at)
  where id = subscription_row.id;
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.status = 'active' then
    update public.tenants set status = 'overdue' where id = p_expected_tenant;
    tenant_row.status := 'overdue';
  end if;
  return query select subscription_row.id, tenant_row.status;
end;
$$;

create or replace function public.record_allowance_action(
  p_expected_tenant uuid,
  p_billing_period_start timestamptz,
  p_billing_period_end timestamptz,
  p_kind text,
  p_threshold int,
  p_observed_count int,
  p_pending_tier_id uuid,
  p_effective_at timestamptz,
  p_notice_event_id uuid,
  p_stripe_schedule_id text,
  p_state text
)
returns table (allowance_action_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing public.allowance_actions%rowtype;
  new_id uuid := gen_random_uuid();
begin
  perform app.assert_not_impersonating();
  perform app.phase6_assert_tenant(p_expected_tenant);
  select * into existing from public.allowance_actions
  where tenant_id = p_expected_tenant and billing_period_end = p_billing_period_end
    and kind = p_kind;
  if existing.id is not null then
    if existing.billing_period_start is distinct from p_billing_period_start
      or existing.threshold is distinct from p_threshold
      or existing.observed_count is distinct from p_observed_count
      or existing.pending_tier_id is distinct from p_pending_tier_id
      or existing.effective_at is distinct from p_effective_at
      or existing.notice_event_id is distinct from p_notice_event_id
      or existing.stripe_schedule_id is distinct from p_stripe_schedule_id
      or existing.state is distinct from p_state then
      raise exception 'ALLOWANCE_ACTION_REPLAY_MISMATCH';
    end if;
    return query select existing.id;
    return;
  end if;
  insert into public.allowance_actions (
    id, tenant_id, billing_period_start, billing_period_end, kind, threshold,
    observed_count, pending_tier_id, effective_at, notice_event_id,
    stripe_schedule_id, state
  ) values (
    new_id, p_expected_tenant, p_billing_period_start, p_billing_period_end,
    p_kind, p_threshold, p_observed_count, p_pending_tier_id, p_effective_at,
    p_notice_event_id, p_stripe_schedule_id, p_state
  );
  return query select new_id;
end;
$$;

create or replace function public.write_tenant_cost_rollup(
  p_expected_tenant uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_recognized_subscription_cents bigint,
  p_model_cents bigint,
  p_messaging_cents bigint,
  p_embedding_cents bigint,
  p_missing_sources text[],
  p_source_evidence jsonb
)
returns table (rollup_id uuid, complete boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  existing public.tenant_cost_rollups%rowtype;
  new_id uuid := gen_random_uuid();
  missing text[] := coalesce(p_missing_sources, '{}'::text[]);
  model_value bigint := p_model_cents;
  messaging_value bigint := p_messaging_cents;
  embedding_value bigint := p_embedding_cents;
  is_complete boolean;
  total bigint;
begin
  perform app.assert_not_impersonating();
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'PHASE6_TENANT_NOT_FOUND'; end if;
  if p_window_start is null or p_window_end <= p_window_start
    or p_recognized_subscription_cents < 0
    or coalesce(p_model_cents, 0) < 0 or coalesce(p_messaging_cents, 0) < 0
    or coalesce(p_embedding_cents, 0) < 0 then
    raise exception 'COST_ROLLUP_INPUT_INVALID';
  end if;
  if not tenant_row.is_demo then
    messaging_value := null;
    embedding_value := null;
    missing := array_append(missing, 'messaging');
    missing := array_append(missing, 'embedding');
  end if;
  if model_value is null then missing := array_append(missing, 'model'); end if;
  if messaging_value is null then missing := array_append(missing, 'messaging'); end if;
  if embedding_value is null then missing := array_append(missing, 'embedding'); end if;
  select coalesce(array_agg(distinct source order by source), '{}'::text[])
  into missing from unnest(missing) source where nullif(btrim(source), '') is not null;
  is_complete := cardinality(missing) = 0
    and model_value is not null and messaging_value is not null and embedding_value is not null;
  total := case when is_complete then model_value + messaging_value + embedding_value else null end;
  select * into existing from public.tenant_cost_rollups
  where tenant_id = p_expected_tenant and window_start = p_window_start and window_end = p_window_end;
  if existing.id is not null then
    if existing.recognized_subscription_cents is distinct from p_recognized_subscription_cents
      or existing.model_cents is distinct from model_value
      or existing.messaging_cents is distinct from messaging_value
      or existing.embedding_cents is distinct from embedding_value
      or existing.missing_sources is distinct from missing
      or existing.source_evidence is distinct from coalesce(p_source_evidence, '{}'::jsonb) then
      raise exception 'COST_ROLLUP_REPLAY_MISMATCH';
    end if;
    return query select existing.id, existing.complete;
    return;
  end if;
  insert into public.tenant_cost_rollups (
    id, tenant_id, window_start, window_end, recognized_subscription_cents,
    model_cents, messaging_cents, embedding_cents, total_cost_cents,
    complete, missing_sources, source_evidence
  ) values (
    new_id, p_expected_tenant, p_window_start, p_window_end,
    p_recognized_subscription_cents, model_value, messaging_value, embedding_value,
    total, is_complete, missing, coalesce(p_source_evidence, '{}'::jsonb)
  );
  return query select new_id, is_complete;
end;
$$;

-- Phase 3 owns the lease and audit contract. Phase 6 preserves its exact return shape and grants,
-- adding only the billing-status predicate that leaves overdue work claimable.
create or replace function public.claim_due_followups(
  p_expected_tenant uuid,
  p_worker_key text,
  p_limit int,
  p_lease_seconds int,
  p_now timestamptz default now()
)
returns table (followup_id uuid, lease_token uuid, due_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed record;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null or nullif(btrim(p_worker_key), '') is null
    or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'FOLLOWUP_CLAIM_CONFIGURATION_INVALID';
  end if;

  for claimed in
    with due as (
      select followup.id
      from public.followups followup
      join public.tenants tenant on tenant.id = followup.tenant_id
      where followup.tenant_id = p_expected_tenant
        and tenant.status <> 'suspended'
        and followup.status = 'scheduled'
        and followup.scheduled_at <= p_now
        and followup.paused_at is null
        and followup.remaining_offset_seconds is null
        and (followup.claim_token is null or followup.claim_expires_at <= p_now)
      order by followup.scheduled_at, followup.id
      limit p_limit
      for update of followup skip locked
    )
    update public.followups followup
    set claim_token = gen_random_uuid(), claimed_at = p_now,
        claim_expires_at = p_now + make_interval(secs => p_lease_seconds),
        attempt_idempotency_key = p_worker_key || ':' || followup.id::text || ':' ||
          (followup.attempt_count + 1)::text,
        attempt_count = followup.attempt_count + 1
    from due where followup.id = due.id
    returning followup.id, followup.claim_token, followup.scheduled_at
  loop
    followup_id := claimed.id;
    lease_token := claimed.claim_token;
    due_at := claimed.scheduled_at;
    audit_id := app.write_audit_row(
      'followup.claimed', null, p_expected_tenant, 'followup', followup_id::text,
      null, jsonb_build_object('worker_key', p_worker_key, 'attempt', claimed.id)
    );
    return next;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 14. Complete-only margin projection and Phase 7/8 handoff comments
-- ---------------------------------------------------------------------------

create view public.platform_margin_projection
with (security_invoker = true)
as
select tenant_id, window_start, window_end,
  recognized_subscription_cents,
  total_cost_cents,
  recognized_subscription_cents - total_cost_cents as margin_cents
from public.tenant_cost_rollups
where complete;

revoke all on public.platform_margin_projection from anon, authenticated, service_role;
grant select on public.platform_margin_projection to authenticated, service_role;

comment on table public.billing_subscriptions is
  'Stripe-derived subscription mirror. Phase 7 reads this local evidence and never queries Stripe for ANL-04.';
comment on table public.stripe_checkout_sessions is
  'Idempotent Stripe Checkout mirror. A redirect is never subscription or payment truth.';
comment on table public.referral_commission_windows is
  'Phase 6 source of commission eligibility; only accrue_invoice_commission writes it and referrals remain immutable.';
comment on table public.tenant_cost_rollups is
  'Platform-only source evidence. Production messaging and embedding costs remain missing until the rate handoff changes this contract.';
comment on view public.platform_margin_projection is
  'Owner/admin-only complete cost rows for Phase 7 ANL-04; incomplete evidence produces no margin row.';
comment on column public.commission_ledger.status is
  'LEGACY-DEAD: superseded by Phase 6 payout events / offset rows; drop in Phase 8';
comment on column public.commission_ledger.paid_by is
  'LEGACY-DEAD: superseded by Phase 6 payout events / offset rows; drop in Phase 8';
comment on column public.commission_ledger.paid_at is
  'LEGACY-DEAD: superseded by Phase 6 payout events / offset rows; drop in Phase 8';
comment on column public.commission_ledger.updated_at is
  'LEGACY-DEAD: superseded by Phase 6 payout events / offset rows; drop in Phase 8';
comment on column public.referrals.clawback is
  'LEGACY-DEAD: superseded by Phase 6 payout events / offset rows; drop in Phase 8';

-- ---------------------------------------------------------------------------
-- 15. Explicit function custody
-- ---------------------------------------------------------------------------

revoke execute on function app.phase6_human_actor(uuid,boolean,boolean)
  from public, anon, authenticated;
revoke execute on function app.phase6_assert_tenant(uuid)
  from public, anon, authenticated;
revoke execute on function app.reject_phase6_append_only()
  from public, anon, authenticated;
revoke execute on function app.reject_phase6_demo_reclassification_with_money()
  from public, anon, authenticated;

revoke execute on function public.record_stripe_checkout_session(
  uuid,uuid,text,text,text,text,text,timestamptz,timestamptz
) from public, anon, authenticated;
revoke execute on function public.apply_billing_subscription_snapshot(
  uuid,text,text,text,text,timestamptz,timestamptz,boolean,timestamptz
) from public, anon, authenticated;
revoke execute on function public.apply_stripe_invoice_paid(
  uuid,text,text,timestamptz,bigint,bigint,timestamptz
) from public, anon, authenticated;
revoke execute on function public.apply_stripe_invoice_failed(
  uuid,text,text,timestamptz
) from public, anon, authenticated;
revoke execute on function public.update_billing_tier(uuid,int,int,int,text,text)
  from public, anon, authenticated;
revoke execute on function public.set_tenant_price_override(
  uuid,int,timestamptz,timestamptz,text
) from public, anon, authenticated;
revoke execute on function public.request_billable_correction(uuid,uuid,int,text)
  from public, anon;
revoke execute on function public.decide_billable_correction(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke execute on function public.set_tenant_billing_status(uuid,public.tenant_status,text)
  from public, anon, authenticated;
revoke execute on function public.accrue_invoice_commission(
  uuid,text,timestamptz,bigint,bigint
) from public, anon, authenticated;
revoke execute on function public.reverse_invoice_commission(
  uuid,text,text,text,bigint,timestamptz
) from public, anon, authenticated;
revoke execute on function public.approve_commission_payout(uuid,uuid[],text)
  from public, anon, authenticated;
revoke execute on function public.record_commission_payout_sent(uuid,text,date)
  from public, anon, authenticated;
revoke execute on function public.affiliate_referral_projection()
  from public, anon;
revoke execute on function public.record_allowance_action(
  uuid,timestamptz,timestamptz,text,int,int,uuid,timestamptz,uuid,text,text
) from public, anon, authenticated;
revoke execute on function public.write_tenant_cost_rollup(
  uuid,timestamptz,timestamptz,bigint,bigint,bigint,bigint,text[],jsonb
) from public, anon, authenticated;

grant execute on function public.record_stripe_checkout_session(
  uuid,uuid,text,text,text,text,text,timestamptz,timestamptz
), public.apply_billing_subscription_snapshot(
  uuid,text,text,text,text,timestamptz,timestamptz,boolean,timestamptz
), public.apply_stripe_invoice_paid(
  uuid,text,text,timestamptz,bigint,bigint,timestamptz
), public.apply_stripe_invoice_failed(
  uuid,text,text,timestamptz
), public.update_billing_tier(
  uuid,int,int,int,text,text
), public.set_tenant_price_override(
  uuid,int,timestamptz,timestamptz,text
), public.decide_billable_correction(
  uuid,uuid,text,text
), public.set_tenant_billing_status(
  uuid,public.tenant_status,text
), public.accrue_invoice_commission(
  uuid,text,timestamptz,bigint,bigint
), public.reverse_invoice_commission(
  uuid,text,text,text,bigint,timestamptz
), public.approve_commission_payout(
  uuid,uuid[],text
), public.record_commission_payout_sent(
  uuid,text,date
), public.record_allowance_action(
  uuid,timestamptz,timestamptz,text,int,int,uuid,timestamptz,uuid,text,text
), public.write_tenant_cost_rollup(
  uuid,timestamptz,timestamptz,bigint,bigint,bigint,bigint,text[],jsonb
) to service_role;

grant execute on function public.request_billable_correction(uuid,uuid,int,text)
  to authenticated, service_role;
grant execute on function public.affiliate_referral_projection()
  to authenticated, service_role;

revoke execute on function public.claim_due_followups(uuid,text,int,int,timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_due_followups(uuid,text,int,int,timestamptz)
  to service_role;
