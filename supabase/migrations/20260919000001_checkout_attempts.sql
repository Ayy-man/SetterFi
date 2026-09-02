-- A checkout attempt is durable intent, distinct from the Stripe Checkout mirror.
--
-- The same open attempt keeps its idempotency key so a double submit cannot create two Stripe
-- sessions. Once Stripe's expiry is known to have passed, or the caller returns from cancellation
-- and explicitly asks to retry, the next claim receives a new attempt and key. A retry request is
-- not a provider outcome: it remains pending until Stripe confirms completed or expired state.

create table public.checkout_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tier_id uuid not null references public.tiers(id),
  price_id text not null check (nullif(btrim(price_id), '') is not null),
  idempotency_key text not null unique check (nullif(btrim(idempotency_key), '') is not null),
  provider_session_id text unique,
  provider_session_expires_at timestamptz,
  outcome text not null default 'pending' check (outcome in ('pending', 'succeeded', 'expired')),
  outcome_confirmed_at timestamptz,
  retry_requested_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint checkout_attempts_provider_session_shape_chk check (
    (provider_session_id is null and provider_session_expires_at is null)
    or (provider_session_id is not null and provider_session_expires_at is not null)
  ),
  constraint checkout_attempts_outcome_shape_chk check (
    (outcome = 'pending' and outcome_confirmed_at is null)
    or (outcome in ('succeeded', 'expired') and outcome_confirmed_at is not null)
  )
);

comment on table public.checkout_attempts is
  'Durable Stripe Checkout intent. Pending means Stripe has not confirmed a terminal outcome; a browser cancellation only requests a fresh attempt.';
comment on column public.checkout_attempts.retry_requested_at is
  'Local retry intent after the buyer returned from Checkout. It does not say Stripe cancelled the prior session, whose outcome remains pending until provider confirmation.';

create unique index checkout_attempts_one_reusable_attempt_idx
  on public.checkout_attempts (tenant_id, tier_id, price_id)
  where outcome = 'pending' and retry_requested_at is null;
create index checkout_attempts_tenant_latest_idx
  on public.checkout_attempts (tenant_id, created_at desc, id desc);

create trigger set_checkout_attempts_updated_at before update on public.checkout_attempts
for each row execute function app.set_updated_at();

create function public.claim_stripe_checkout_attempt(
  p_expected_tenant uuid,
  p_tier_id uuid,
  p_price_id text
)
returns table (attempt_id uuid, idempotency_key text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed public.checkout_attempts%rowtype;
  normalized_price_id text := nullif(btrim(p_price_id), '');
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  if normalized_price_id is null then raise exception 'CHECKOUT_ATTEMPT_PRICE_REQUIRED'; end if;
  if not exists (select 1 from public.tiers where id = p_tier_id and active) then
    raise exception 'BILLING_TIER_NOT_FOUND';
  end if;

  -- Stripe supplies an authoritative expiry when the provider session is recorded. At or after
  -- that timestamp, the old key cannot be used to revive the checkout, so retire it atomically
  -- before claiming the next attempt.
  update public.checkout_attempts
  set outcome = 'expired', outcome_confirmed_at = clock_timestamp()
  where tenant_id = p_expected_tenant
    and tier_id = p_tier_id
    and price_id = normalized_price_id
    and outcome = 'pending'
    and retry_requested_at is null
    and provider_session_expires_at is not null
    and provider_session_expires_at <= clock_timestamp();

  insert into public.checkout_attempts (
    tenant_id, tier_id, price_id, idempotency_key
  ) values (
    p_expected_tenant,
    p_tier_id,
    normalized_price_id,
    'checkout:' || p_expected_tenant::text || ':' || p_tier_id::text || ':' || normalized_price_id || ':attempt:' || gen_random_uuid()::text
  )
  on conflict (tenant_id, tier_id, price_id)
    where outcome = 'pending' and retry_requested_at is null
  do update set updated_at = clock_timestamp()
  returning * into claimed;

  return query select claimed.id, claimed.idempotency_key, claimed.outcome;
end;
$$;

create function public.record_stripe_checkout_attempt_session(
  p_attempt_id uuid,
  p_stripe_session_id text,
  p_expires_at timestamptz
)
returns table (attempt_id uuid, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.checkout_attempts%rowtype;
begin
  if nullif(btrim(p_stripe_session_id), '') is null or p_expires_at is null then
    raise exception 'CHECKOUT_ATTEMPT_PROVIDER_RECEIPT_REQUIRED';
  end if;
  select * into attempt from public.checkout_attempts where id = p_attempt_id for update;
  if attempt.id is null then raise exception 'CHECKOUT_ATTEMPT_NOT_FOUND'; end if;
  if attempt.provider_session_id is not null and attempt.provider_session_id <> btrim(p_stripe_session_id) then
    raise exception 'CHECKOUT_ATTEMPT_PROVIDER_REPLAY_MISMATCH';
  end if;
  if attempt.outcome <> 'pending' then raise exception 'CHECKOUT_ATTEMPT_TERMINAL'; end if;

  update public.checkout_attempts
  set provider_session_id = btrim(p_stripe_session_id),
      provider_session_expires_at = p_expires_at
  where id = attempt.id;
  return query select attempt.id, attempt.outcome;
end;
$$;

create function public.request_stripe_checkout_attempt_retry(
  p_expected_tenant uuid,
  p_tier_id uuid
)
returns table (retired_attempt_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  perform app.phase6_assert_tenant(p_expected_tenant);
  update public.checkout_attempts
  set retry_requested_at = clock_timestamp()
  where tenant_id = p_expected_tenant
    and tier_id = p_tier_id
    and outcome = 'pending'
    and retry_requested_at is null;
  get diagnostics changed = row_count;
  return query select changed;
end;
$$;

-- Stripe webhook processing already drives stripe_checkout_sessions. Keep attempt outcome derived
-- from that provider-backed mirror rather than from a redirect or local create response.
create function app.sync_checkout_attempt_outcome()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'completed' then
    update public.checkout_attempts
    set outcome = 'succeeded', outcome_confirmed_at = clock_timestamp()
    where idempotency_key = new.idempotency_key and outcome = 'pending';
  elsif new.state = 'expired' then
    update public.checkout_attempts
    set outcome = 'expired', outcome_confirmed_at = clock_timestamp()
    where idempotency_key = new.idempotency_key and outcome = 'pending';
  end if;
  return new;
end;
$$;

create trigger sync_checkout_attempt_outcome
after insert or update of state on public.stripe_checkout_sessions
for each row execute function app.sync_checkout_attempt_outcome();

alter table public.checkout_attempts enable row level security;
alter table public.checkout_attempts force row level security;

create policy checkout_attempts_platform_read on public.checkout_attempts
  for select to authenticated using (app.is_platform_operator());

revoke all on table public.checkout_attempts from public, anon, authenticated, service_role;
grant select on table public.checkout_attempts to authenticated;
grant select on table public.checkout_attempts to service_role;

revoke all on function public.claim_stripe_checkout_attempt(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.record_stripe_checkout_attempt_session(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.request_stripe_checkout_attempt_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_stripe_checkout_attempt(uuid, uuid, text) to service_role;
grant execute on function public.record_stripe_checkout_attempt_session(uuid, text, timestamptz) to service_role;
grant execute on function public.request_stripe_checkout_attempt_retry(uuid, uuid) to service_role;
