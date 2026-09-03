-- Receipt-backed history for the owner Money screen.
--
-- `billing_subscriptions` deliberately stores one mutable mirror row per tenant, which is enough
-- for today's subscription state but cannot answer what was live at an earlier month end after a
-- renewal, cancellation, or price change overwrites it.  This append-only receipt ledger records
-- each accepted mirror snapshot.  The Money read uses the latest receipt known by each month end;
-- it does not infer a past state from the current mirror.

create table public.billing_subscription_mrr_receipts (
  id uuid primary key default gen_random_uuid(),
  billing_subscription_id uuid not null references public.billing_subscriptions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tier_id uuid references public.tiers(id) on delete set null,
  plan_name text,
  stripe_price_id text not null,
  status text not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null,
  provider_updated_at timestamptz not null,
  is_test boolean not null default false,
  recorded_at timestamptz not null default now(),
  constraint billing_subscription_mrr_receipts_period_chk
    check (current_period_end > current_period_start),
  constraint billing_subscription_mrr_receipts_status_chk
    check (status in ('trialing','active','past_due','incomplete','incomplete_expired','unpaid','paused','canceled')),
  constraint billing_subscription_mrr_receipts_provider_update_key
    unique (billing_subscription_id, provider_updated_at)
);

create index billing_subscription_mrr_receipts_month_end_idx
  on public.billing_subscription_mrr_receipts (billing_subscription_id, provider_updated_at desc);
create index billing_subscription_mrr_receipts_tenant_idx
  on public.billing_subscription_mrr_receipts (tenant_id, provider_updated_at desc);

create or replace function app.record_billing_subscription_mrr_receipt()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  tier_row public.tiers%rowtype;
begin
  select * into tier_row
  from public.tiers tier
  where tier.stripe_price_id = new.stripe_price_id;

  insert into public.billing_subscription_mrr_receipts (
    billing_subscription_id, tenant_id, tier_id, plan_name, stripe_price_id, status,
    current_period_start, current_period_end, cancel_at_period_end, provider_updated_at, is_test
  ) values (
    new.id, new.tenant_id, tier_row.id, tier_row.name, new.stripe_price_id, new.status,
    new.current_period_start, new.current_period_end, new.cancel_at_period_end,
    new.provider_updated_at, false
  ) on conflict (billing_subscription_id, provider_updated_at) do nothing;
  return new;
end;
$$;

create trigger billing_subscriptions_record_mrr_receipt
after insert or update of stripe_price_id, status, current_period_start, current_period_end,
  cancel_at_period_end, provider_updated_at
on public.billing_subscriptions
for each row execute function app.record_billing_subscription_mrr_receipt();

-- Existing mirrors are themselves persisted provider receipts.  Backfill one immutable receipt
-- for each so the new projection can answer every month that their current covered period reaches.
insert into public.billing_subscription_mrr_receipts (
  billing_subscription_id, tenant_id, tier_id, plan_name, stripe_price_id, status,
  current_period_start, current_period_end, cancel_at_period_end, provider_updated_at, is_test
)
select subscription.id, subscription.tenant_id, tier.id, tier.name, subscription.stripe_price_id,
  subscription.status, subscription.current_period_start, subscription.current_period_end,
  subscription.cancel_at_period_end, subscription.provider_updated_at, false
from public.billing_subscriptions subscription
left join public.tiers tier on tier.stripe_price_id = subscription.stripe_price_id
on conflict (billing_subscription_id, provider_updated_at) do nothing;

create trigger billing_subscription_mrr_receipts_reject_mutation
before update or delete on public.billing_subscription_mrr_receipts
for each row execute function app.reject_phase6_append_only();

alter table public.billing_subscription_mrr_receipts enable row level security;
alter table public.billing_subscription_mrr_receipts force row level security;

create policy billing_subscription_mrr_receipts_admin_read
  on public.billing_subscription_mrr_receipts
  for select to authenticated using (app.is_platform_admin());

revoke all on public.billing_subscription_mrr_receipts from public, anon, authenticated, service_role;
grant select on public.billing_subscription_mrr_receipts to authenticated, service_role;
revoke insert, update, delete, truncate on public.billing_subscription_mrr_receipts from service_role;

create or replace function public.read_money_mrr_history(p_as_of timestamptz)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  result jsonb;
begin
  if p_as_of is null then raise exception 'MONEY_MRR_AS_OF_REQUIRED'; end if;
  -- A platform aggregate never widens to a demo tenant, even if another reader set the session
  -- setting earlier in this transaction.  The predicates below repeat the same test-row and demo
  -- exclusion used by the analytics projections.
  perform set_config('app.phase7_demo_tenant', '', true);

  with periods as (
    select period_start,
      period_start + interval '1 month' as period_end,
      period_start + interval '1 month' - interval '1 microsecond' as month_end
    from generate_series(
      (date_trunc('month', p_as_of at time zone 'UTC') - interval '12 months') at time zone 'UTC',
      (date_trunc('month', p_as_of at time zone 'UTC') - interval '1 month') at time zone 'UTC',
      interval '1 month'
    ) as generated(period_start)
  ), mrr_by_period as (
    select period.period_start, period.period_end,
      case
        when count(receipt.id) filter (where receipt.status = 'active') = 0 then 0::bigint
        when count(price.monthly_amount_cents) filter (where receipt.status = 'active')
          <> count(receipt.id) filter (where receipt.status = 'active') then null
        else sum(price.monthly_amount_cents) filter (where receipt.status = 'active')::bigint
      end as mrr_cents
    from periods period
    left join lateral (
      select distinct on (candidate.billing_subscription_id) candidate.*
      from public.billing_subscription_mrr_receipts candidate
      join public.tenants tenant on tenant.id = candidate.tenant_id
      where candidate.provider_updated_at <= period.month_end
        and not candidate.is_test
        and not tenant.is_demo
      order by candidate.billing_subscription_id, candidate.provider_updated_at desc, candidate.recorded_at desc
    ) receipt on true
    left join lateral (
      select coalesce(
        (
          select override_row.price_cents
          from public.tenant_price_overrides override_row
          where override_row.tenant_id = receipt.tenant_id
            and override_row.effective_at <= period.month_end
            and (override_row.ends_at is null or override_row.ends_at > period.month_end)
          order by override_row.effective_at desc
          limit 1
        ),
        (
          select version.price_cents
          from public.tier_price_versions version
          where version.tier_id = receipt.tier_id
            and version.effective_at <= period.month_end
          order by version.effective_at desc
          limit 1
        )
      )::bigint as monthly_amount_cents
    ) price on true
    where receipt.status is null
      or (receipt.current_period_start <= period.month_end and receipt.current_period_end > period.month_end)
    group by period.period_start, period.period_end
  ), current_rows as (
    select distinct on (receipt.billing_subscription_id)
      receipt.*, tenant.name as business_name, tenant.status::text as account_status,
      tenant.is_demo,
      pending.pending_tier_id, pending.effective_at as pending_effective_at
    from public.billing_subscription_mrr_receipts receipt
    join public.tenants tenant on tenant.id = receipt.tenant_id
    left join lateral (
      select action.pending_tier_id, action.effective_at
      from public.allowance_actions action
      where action.tenant_id = receipt.tenant_id
        and action.state in ('scheduled', 'awaiting_consent')
      order by action.effective_at asc, action.id asc
      limit 1
    ) pending on true
    where receipt.provider_updated_at <= p_as_of
      and not receipt.is_test
      and not tenant.is_demo
    order by receipt.billing_subscription_id, receipt.provider_updated_at desc, receipt.recorded_at desc
  ), rows as (
    select current_row.*, coalesce(
      (
        select override_row.price_cents
        from public.tenant_price_overrides override_row
        where override_row.tenant_id = current_row.tenant_id
          and override_row.effective_at <= p_as_of
          and (override_row.ends_at is null or override_row.ends_at > p_as_of)
        order by override_row.effective_at desc
        limit 1
      ),
      (
        select version.price_cents
        from public.tier_price_versions version
        where version.tier_id = current_row.tier_id and version.effective_at <= p_as_of
        order by version.effective_at desc
        limit 1
      )
    )::bigint as monthly_amount_cents
    from current_rows current_row
  )
  select jsonb_build_object(
    'mrrByPeriod', coalesce((
      select jsonb_agg(jsonb_build_object(
        'periodStart', period_start,
        'periodEnd', period_end,
        'mrrCents', mrr_cents
      ) order by period_start)
      from mrr_by_period
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tenantId', tenant_id,
        'businessName', business_name,
        'accountStatus', account_status,
        'subscriptionStatus', status,
        'providerUpdatedAt', provider_updated_at,
        'currentPeriodEnd', current_period_end,
        'cancelAtPeriodEnd', cancel_at_period_end,
        'pendingTierId', pending_tier_id,
        'pendingEffectiveAt', pending_effective_at,
        'dataLabel', null,
        'plan', plan_name,
        'monthlyAmountCents', monthly_amount_cents,
        'status', status,
        'countsAsLive', status = 'active',
        'isTest', is_test,
        'isDemo', is_demo
      ) order by business_name, tenant_id)
      from rows
    ), '[]'::jsonb)
  ) into result;
  return result;
end;
$$;

revoke all on function public.read_money_mrr_history(timestamptz)
from public, anon, authenticated;
grant execute on function public.read_money_mrr_history(timestamptz) to service_role;

comment on table public.billing_subscription_mrr_receipts is
  'Append-only provider subscription snapshots used for month-end MRR. Test receipts and demo tenants are excluded by read_money_mrr_history.';
comment on function public.read_money_mrr_history(timestamptz) is
  'Returns twelve completed UTC month-end MRR values plus current real-client billing rows. MRR sums only receipt-backed active subscriptions with a resolvable monthly amount; trialing, past_due, cancellation, and canceled statuses remain raw row states and never count as live.';
