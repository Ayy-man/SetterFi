-- Money's MRR history keeps its own copy of the demo rule, apart from the analytics views, so
-- 20261011000001 left it reading nothing on a demo-only platform. Same switch, same predicate:
-- a demo tenant's receipts count when platform_demo_visible() is on, and a real tenant's test
-- receipts never do. The function body is otherwise the live definition unchanged.

CREATE OR REPLACE FUNCTION public.read_money_mrr_history(p_as_of timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
        and ((not candidate.is_test and not tenant.is_demo) or (tenant.is_demo and public.platform_demo_visible()))
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
      and ((not receipt.is_test and not tenant.is_demo) or (tenant.is_demo and public.platform_demo_visible()))
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
$function$;
