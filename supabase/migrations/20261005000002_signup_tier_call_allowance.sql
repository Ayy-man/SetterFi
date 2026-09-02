-- The signup catalogue priced the plans by money, and the product is sold on booked calls.
--
-- `Signup.dc.html` and `Landing.dc.html` both sell a tier on its allowance -- "10 booked calls
-- included" -- and `/signup` could state a monthly price and nothing about what it buys, which is
-- the one number the tiers actually differ on. `tiers.call_allowance` has existed since
-- 20260813000001_init.sql:200 with a `>= 0` check (20260817000001_phase1_demo_path.sql:610), and
-- neither signup catalogue selected it, so it stopped at the database.
--
-- Both catalogue functions are widened, not just one. `list_signup_tier_catalog` is the unpriced
-- read and `list_signup_tier_offer_catalog` is the priced one, and `mapTierChoice`
-- (`src/lib/repositories/onboarding-signup.ts:217`) is the single mapper both paths run through --
-- widening one alone would make the allowance appear or vanish depending on which read served the
-- page, which is worse than not having it.
--
-- What is NOT in here, and why. The artboard's line is "10 booked calls included, then $34 each",
-- and the second half has no column, contract field or env value anywhere in the schema: no per-call
-- overage price is recorded anywhere in this product. It is a commercial term that has to be decided
-- and stored before it can be shown, and stating it on a signup page would be the product inventing
-- a price a customer would then be owed at. Recorded as Alec's decision in `docs/DECISIONS.md`
-- rather than guessed at here. The same goes for the artboard's "Most coaches start here" pill: the
-- catalogue returns operator-chosen labels with no recommended flag, and keying a recommendation off
-- a label string would be the page manufacturing one.
--
-- Both functions are dropped and recreated because PostgreSQL cannot change a function's OUT columns
-- with `create or replace`. The grants below restore exactly what each drop removed -- note they
-- differ, and both are reproduced exactly as the originals wrote them rather than tidied: the
-- unpriced catalogue is granted to `anon, authenticated` and deliberately not to `service_role`,
-- while the priced one adds `service_role`. A drop takes the comment with it too, so the unpriced
-- function's comment is restored below -- with its "no allowance column is returned" clause struck,
-- since that is precisely what changed.

drop function if exists public.list_signup_tier_catalog();

create function public.list_signup_tier_catalog()
returns table (id uuid, label text, call_allowance integer)
language sql
stable
security definer
set search_path = ''
as $$
  select tier.id, tier.name as label, tier.call_allowance
  from public.tiers tier
  where tier.active
  order by lower(tier.name), tier.id;
$$;

drop function if exists public.list_signup_tier_offer_catalog(timestamptz);

create function public.list_signup_tier_offer_catalog(p_as_of timestamptz)
returns table (
  id uuid,
  label text,
  call_allowance integer,
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
    tier.call_allowance,
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

revoke execute on function public.list_signup_tier_catalog() from public, anon, authenticated;
grant execute on function public.list_signup_tier_catalog() to anon, authenticated;

revoke execute on function public.list_signup_tier_offer_catalog(timestamptz)
  from public, anon, authenticated;
grant execute on function public.list_signup_tier_offer_catalog(timestamptz)
  to anon, authenticated, service_role;

comment on function public.list_signup_tier_catalog() is
  'Public non-economic signup choices. Offerability follows tiers.active. Returns the booked-call allowance, which is what the tiers differ on; no price column is returned.';
