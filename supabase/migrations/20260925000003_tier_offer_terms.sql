-- A tier's editable operational price is not itself a customer offer.  This ledger records the
-- exact Stripe-backed commercial terms that are sellable during a bounded time window.

set search_path = public, extensions;

create extension if not exists btree_gist with schema extensions;

create table public.tier_offer_terms (
  id uuid primary key default gen_random_uuid(),
  tier_id uuid not null references public.tiers(id) on delete restrict,
  currency text not null,
  amount_cents integer not null,
  billing_interval text not null,
  stripe_price_id text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint tier_offer_terms_currency_chk check (currency ~ '^[A-Z]{3}$'),
  constraint tier_offer_terms_amount_chk check (amount_cents >= 0),
  constraint tier_offer_terms_interval_chk check (
    billing_interval in ('day', 'week', 'month', 'year')
  ),
  constraint tier_offer_terms_stripe_price_chk check (nullif(btrim(stripe_price_id), '') is not null),
  constraint tier_offer_terms_window_chk check (effective_to is null or effective_to > effective_from),
  constraint tier_offer_terms_stripe_price_key unique (stripe_price_id),
  constraint tier_offer_terms_no_overlap exclude using gist (
    tier_id with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  )
);

comment on table public.tier_offer_terms is
  'Stripe-backed commercial offers. The exclusion constraint permits at most one sellable offer per tier at any instant.';

create index tier_offer_terms_lookup_idx
  on public.tier_offer_terms (tier_id, effective_from desc);

-- This resolver always returns one status row. `no_offer` is a refusal, rather than permission to
-- fall back to a prior price; the exclusion constraint makes `offered` unambiguous by construction.
create function public.resolve_tier_offer(
  p_tier_id uuid,
  p_as_of timestamptz
)
returns table (
  state text,
  offer_id uuid,
  tier_id uuid,
  currency text,
  amount_cents integer,
  billing_interval text,
  stripe_price_id text,
  effective_from timestamptz,
  effective_to timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_tier_id is null then raise exception 'BILLING_TIER_REQUIRED'; end if;
  if p_as_of is null then raise exception 'BILLING_TIER_OFFER_AS_OF_REQUIRED'; end if;

  return query
  select
    case when offer.id is null then 'no_offer' else 'offered' end,
    offer.id,
    tier.id,
    offer.currency,
    offer.amount_cents,
    offer.billing_interval,
    offer.stripe_price_id,
    offer.effective_from,
    offer.effective_to
  from public.tiers as tier
  left join public.tier_offer_terms as offer
    on offer.tier_id = tier.id
    and offer.effective_from <= p_as_of
    and (offer.effective_to is null or p_as_of < offer.effective_to)
  where tier.id = p_tier_id
    and tier.active;

  if not found then
    return query select
      'no_offer'::text, null::uuid, p_tier_id, null::text, null::integer, null::text,
      null::text, null::timestamptz, null::timestamptz;
  end if;
end;
$$;

-- The public signup projection is deliberately separate from the single-tier resolver. Every
-- selected field is relation-qualified because RETURNS TABLE names are variables in plpgsql.
create function public.list_signup_tier_offer_catalog(p_as_of timestamptz)
returns table (
  id uuid,
  label text,
  offer_id uuid,
  currency text,
  amount_cents integer,
  billing_interval text,
  stripe_price_id text,
  effective_from timestamptz,
  effective_to timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_as_of is null then raise exception 'BILLING_TIER_OFFER_AS_OF_REQUIRED'; end if;
  return query
  select
    tier.id,
    tier.name,
    offer.id,
    offer.currency,
    offer.amount_cents,
    offer.billing_interval,
    offer.stripe_price_id,
    offer.effective_from,
    offer.effective_to
  from public.tiers as tier
  inner join public.tier_offer_terms as offer on offer.tier_id = tier.id
  where tier.active
    and offer.effective_from <= p_as_of
    and (offer.effective_to is null or p_as_of < offer.effective_to)
  order by lower(tier.name), tier.id;
end;
$$;

-- No policy is defined on purpose: the catalogue is platform data that only the security-definer
-- resolvers above may read, so row security enabled with no policy is the intended deny-all. The
-- revokes below are the first line; this is the one that survives a future grant.
alter table public.tier_offer_terms enable row level security;
alter table public.tier_offer_terms force row level security;

revoke all on table public.tier_offer_terms from public, anon, authenticated;
revoke execute on function public.resolve_tier_offer(uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.list_signup_tier_offer_catalog(timestamptz) from public, anon, authenticated;
grant execute on function public.resolve_tier_offer(uuid, timestamptz) to anon, authenticated, service_role;
grant execute on function public.list_signup_tier_offer_catalog(timestamptz) to anon, authenticated, service_role;
