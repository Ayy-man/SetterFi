-- Durable round-robin cursors for bounded background scans.
--
-- A fixed `order by id limit N` repeatedly selects the same head when rows stay eligible. These
-- cursors advance when a batch is selected, so failures may delay their own retry but cannot hold
-- every later tenant, conversation, or receipt behind them forever.

create table public.job_scan_cursors (
  job_key text primary key check (job_key in (
    'followups',
    'compliance_lifecycle',
    'billing_allowances',
    'billing_cost_rollup',
    'scheduled_needs_human',
    'stripe_webhooks',
    'ghl_lifecycle_receipts'
  )),
  last_entity_id uuid,
  updated_at timestamptz not null default now()
);

comment on table public.job_scan_cursors is
  'Service-owned round-robin positions for bounded jobs whose eligible rows remain selectable after successful work.';

alter table public.job_scan_cursors enable row level security;
alter table public.job_scan_cursors force row level security;
revoke all on table public.job_scan_cursors from public, anon, authenticated, service_role;

create or replace function public.claim_fair_tenant_batch(
  p_job_key text,
  p_limit integer
)
returns table (tenant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_id uuid;
  candidate record;
  last_selected uuid;
begin
  if p_job_key is null or p_job_key not in ('followups', 'compliance_lifecycle') then
    raise exception 'TENANT_SCAN_JOB_KEY_INVALID';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'JOB_SCAN_LIMIT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('job-scan:' || p_job_key, 0));

  insert into public.job_scan_cursors (job_key) values (p_job_key)
  on conflict (job_key) do nothing;
  select scan.last_entity_id into cursor_id
  from public.job_scan_cursors scan where scan.job_key = p_job_key for update;

  for candidate in
    select tenant.id
    from public.tenants tenant
    order by case when cursor_id is null or tenant.id > cursor_id then 0 else 1 end, tenant.id
    limit p_limit
  loop
    tenant_id := candidate.id;
    last_selected := candidate.id;
    return next;
  end loop;

  if last_selected is not null then
    update public.job_scan_cursors
    set last_entity_id = last_selected, updated_at = clock_timestamp()
    where job_key = p_job_key;
  end if;
end;
$$;

create or replace function public.claim_fair_billing_subscription_batch(
  p_job_key text,
  p_limit integer,
  p_statuses text[] default null
)
returns table (tenant_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_id uuid;
  candidate record;
  last_selected uuid;
begin
  if p_job_key is null or p_job_key not in ('billing_allowances', 'billing_cost_rollup') then
    raise exception 'BILLING_SCAN_JOB_KEY_INVALID';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'JOB_SCAN_LIMIT_INVALID';
  end if;
  if p_statuses is not null and (
    cardinality(p_statuses) = 0 or exists (
      select 1 from unnest(p_statuses) as requested(status_value)
      where requested.status_value is null or requested.status_value not in (
        'trialing','active','past_due','incomplete','incomplete_expired',
        'unpaid','paused','canceled'
      )
    )
  ) then raise exception 'BILLING_SCAN_STATUS_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('job-scan:' || p_job_key, 0));

  insert into public.job_scan_cursors (job_key) values (p_job_key)
  on conflict (job_key) do nothing;
  select scan.last_entity_id into cursor_id
  from public.job_scan_cursors scan where scan.job_key = p_job_key for update;

  for candidate in
    select subscription.tenant_id
    from public.billing_subscriptions subscription
    where p_statuses is null or subscription.status = any(p_statuses)
    order by case when cursor_id is null or subscription.tenant_id > cursor_id then 0 else 1 end,
      subscription.tenant_id
    limit p_limit
  loop
    tenant_id := candidate.tenant_id;
    last_selected := candidate.tenant_id;
    return next;
  end loop;

  if last_selected is not null then
    update public.job_scan_cursors
    set last_entity_id = last_selected, updated_at = clock_timestamp()
    where job_key = p_job_key;
  end if;
end;
$$;

create or replace function public.claim_fair_needs_human_batch(
  p_limit integer
)
returns table (conversation_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_id uuid;
  candidate record;
  last_selected uuid;
  job_name constant text := 'scheduled_needs_human';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'JOB_SCAN_LIMIT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('job-scan:' || job_name, 0));

  insert into public.job_scan_cursors (job_key) values (job_name)
  on conflict (job_key) do nothing;
  select scan.last_entity_id into cursor_id
  from public.job_scan_cursors scan where scan.job_key = job_name for update;

  for candidate in
    select conversation.id
    from public.conversations conversation
    where conversation.status = 'needs_human'
      and conversation.taken_over_by is null
      and conversation.needs_human_at is not null
    order by case when cursor_id is null or conversation.id > cursor_id then 0 else 1 end,
      conversation.id
    limit p_limit
  loop
    conversation_id := candidate.id;
    last_selected := candidate.id;
    return next;
  end loop;

  if last_selected is not null then
    update public.job_scan_cursors
    set last_entity_id = last_selected, updated_at = clock_timestamp()
    where job_key = job_name;
  end if;
end;
$$;

create or replace function public.claim_fair_stripe_receipt_batch(
  p_limit integer
)
returns table (receipt_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_id uuid;
  candidate record;
  last_selected uuid;
  job_name constant text := 'stripe_webhooks';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'JOB_SCAN_LIMIT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('job-scan:' || job_name, 0));

  insert into public.job_scan_cursors (job_key) values (job_name)
  on conflict (job_key) do nothing;
  select scan.last_entity_id into cursor_id
  from public.job_scan_cursors scan where scan.job_key = job_name for update;

  for candidate in
    select event.id
    from public.webhook_events event
    where event.provider = 'stripe'
      and event.status in ('received', 'failed')
    order by case when cursor_id is null or event.id > cursor_id then 0 else 1 end,
      event.id
    limit p_limit
  loop
    receipt_id := candidate.id;
    last_selected := candidate.id;
    return next;
  end loop;

  if last_selected is not null then
    update public.job_scan_cursors
    set last_entity_id = last_selected, updated_at = clock_timestamp()
    where job_key = job_name;
  end if;
end;
$$;

create or replace function public.claim_fair_ghl_lifecycle_receipt_batch(
  p_limit integer
)
returns table (receipt_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cursor_id uuid;
  candidate record;
  last_selected uuid;
  job_name constant text := 'ghl_lifecycle_receipts';
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'JOB_SCAN_LIMIT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('job-scan:' || job_name, 0));

  insert into public.job_scan_cursors (job_key) values (job_name)
  on conflict (job_key) do nothing;
  select scan.last_entity_id into cursor_id
  from public.job_scan_cursors scan where scan.job_key = job_name for update;

  for candidate in
    select event.id
    from public.webhook_events event
    where event.provider = 'ghl'
      and event.event_type in ('INSTALL', 'UNINSTALL')
      and event.status in ('received', 'failed')
    order by case when cursor_id is null or event.id > cursor_id then 0 else 1 end,
      event.id
    limit p_limit
  loop
    receipt_id := candidate.id;
    last_selected := candidate.id;
    return next;
  end loop;

  if last_selected is not null then
    update public.job_scan_cursors
    set last_entity_id = last_selected, updated_at = clock_timestamp()
    where job_key = job_name;
  end if;
end;
$$;

revoke all on function public.claim_fair_tenant_batch(text,integer)
  from public, anon, authenticated;
revoke all on function public.claim_fair_billing_subscription_batch(text,integer,text[])
  from public, anon, authenticated;
revoke all on function public.claim_fair_needs_human_batch(integer)
  from public, anon, authenticated;
revoke all on function public.claim_fair_stripe_receipt_batch(integer)
  from public, anon, authenticated;
revoke all on function public.claim_fair_ghl_lifecycle_receipt_batch(integer)
  from public, anon, authenticated;
grant execute on function public.claim_fair_tenant_batch(text,integer) to service_role;
grant execute on function public.claim_fair_billing_subscription_batch(text,integer,text[])
  to service_role;
grant execute on function public.claim_fair_needs_human_batch(integer) to service_role;
grant execute on function public.claim_fair_stripe_receipt_batch(integer) to service_role;
grant execute on function public.claim_fair_ghl_lifecycle_receipt_batch(integer) to service_role;
