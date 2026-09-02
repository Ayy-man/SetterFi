-- The commercial-terms ledger shipped read-only: two security-definer resolvers and no way to put
-- a row into `tier_offer_terms`, so `SETTERFI_TIER_OFFER_TERMS_LIVE` could never be switched on
-- without the catalogue going empty. This is the writer, and it is the only one: the table stays
-- deny-all under row security, so every term arrives through a function that verifies the actor,
-- writes the audit row first, and hands back the receipt.
--
-- A recorded term is bookkeeping about Stripe, never a call to Stripe. Nothing here creates a
-- price. `stripe_price_id` is trusted exactly as far as the operator who typed it until Stripe is
-- connected and something reads it back, and the surface says so in those words.

set search_path = public, extensions;

-- Custody columns. Nullable because the table is already applied and this migration must not
-- assume it is empty; the writer below always fills them, and it is the only path that inserts.
alter table public.tier_offer_terms
  add column if not exists actor_id uuid references public.users(id) on delete restrict,
  add column if not exists reason text,
  add column if not exists audit_id bigint references public.audit_log(id) on delete restrict,
  add column if not exists closed_audit_id bigint references public.audit_log(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tier_offer_terms_audit_key'
  ) then
    alter table public.tier_offer_terms add constraint tier_offer_terms_audit_key unique (audit_id);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'tier_offer_terms_closed_audit_key'
  ) then
    alter table public.tier_offer_terms
      add constraint tier_offer_terms_closed_audit_key unique (closed_audit_id);
  end if;
end;
$$;

comment on column public.tier_offer_terms.stripe_price_id is
  'Recorded by a platform operator, not verified against Stripe. No code path in this repository asks Stripe whether this price exists.';

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('billing.tier_offer_term.recorded', 'human', 'platform', true, false,
    'Commercial term logged', 'Commercial term recorded in the audit log'),
  ('billing.tier_offer_term.closed', 'human', 'platform', true, false,
    'Term close logged', 'Commercial term close recorded in the audit log')
on conflict (key) do nothing;

-- Every constraint the table already enforces is checked here first, so a refusal comes back with
-- a name a person can act on instead of a Postgres constraint string. The two that cannot be
-- pre-checked without a race -- the unique price id and the per-tier no-overlap exclusion -- are
-- caught by their SQLSTATE and renamed on the way out.
create function public.record_tier_offer_term(
  p_actor_id uuid,
  p_tier_id uuid,
  p_currency text,
  p_amount_cents int,
  p_billing_interval text,
  p_stripe_price_id text,
  p_effective_from timestamptz,
  p_effective_to timestamptz,
  p_reason text
)
returns table (term_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  new_id uuid := gen_random_uuid();
  logged_id bigint;
  normalized_currency text := upper(btrim(coalesce(p_currency, '')));
  normalized_price_id text := btrim(coalesce(p_stripe_price_id, ''));
begin
  actor := app.phase6_verified_actor(p_actor_id, null, true, false);
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'TIER_OFFER_TERM_REASON_REQUIRED';
  end if;
  if not exists (select 1 from public.tiers where id = p_tier_id) then
    raise exception 'BILLING_TIER_NOT_FOUND';
  end if;
  if normalized_currency !~ '^[A-Z]{3}$' then
    raise exception 'TIER_OFFER_TERM_CURRENCY_INVALID';
  end if;
  if p_amount_cents is null or p_amount_cents < 0 then
    raise exception 'TIER_OFFER_TERM_AMOUNT_INVALID';
  end if;
  if p_billing_interval is null or p_billing_interval not in ('day', 'week', 'month', 'year') then
    raise exception 'TIER_OFFER_TERM_INTERVAL_INVALID';
  end if;
  if normalized_price_id = '' then
    raise exception 'TIER_OFFER_TERM_STRIPE_PRICE_REQUIRED';
  end if;
  if p_effective_from is null
    or (p_effective_to is not null and p_effective_to <= p_effective_from) then
    raise exception 'TIER_OFFER_TERM_WINDOW_INVALID';
  end if;

  logged_id := app.write_audit_row(
    'billing.tier_offer_term.recorded', actor, null, 'tier_offer_term', new_id::text,
    btrim(p_reason),
    jsonb_build_object(
      'tier_id', p_tier_id,
      'currency', normalized_currency,
      'amount_cents', p_amount_cents,
      'billing_interval', p_billing_interval,
      'stripe_price_id', normalized_price_id,
      'effective_from', p_effective_from,
      'effective_to', p_effective_to
    )
  );

  begin
    insert into public.tier_offer_terms (
      id, tier_id, currency, amount_cents, billing_interval, stripe_price_id,
      effective_from, effective_to, actor_id, reason, audit_id
    ) values (
      new_id, p_tier_id, normalized_currency, p_amount_cents, p_billing_interval,
      normalized_price_id, p_effective_from, p_effective_to, actor, btrim(p_reason), logged_id
    );
  exception
    when unique_violation then raise exception 'TIER_OFFER_TERM_STRIPE_PRICE_DUPLICATE';
    when exclusion_violation then raise exception 'TIER_OFFER_TERM_WINDOW_OVERLAP';
  end;

  return query select new_id, logged_id;
end;
$$;

-- Closing a window is the only edit a recorded term accepts. Nothing rewrites an amount or a price
-- id: the way to change what a tier sells for is to end the current window and record the next one,
-- so the ledger keeps saying what was sellable when.
create function public.close_tier_offer_term(
  p_actor_id uuid,
  p_term_id uuid,
  p_effective_to timestamptz,
  p_reason text
)
returns table (term_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid;
  term public.tier_offer_terms%rowtype;
  logged_id bigint;
begin
  actor := app.phase6_verified_actor(p_actor_id, null, true, false);
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'TIER_OFFER_TERM_REASON_REQUIRED';
  end if;
  select * into term from public.tier_offer_terms where id = p_term_id for update;
  if term.id is null then raise exception 'TIER_OFFER_TERM_NOT_FOUND'; end if;
  if term.effective_to is not null then raise exception 'TIER_OFFER_TERM_ALREADY_CLOSED'; end if;
  if p_effective_to is null or p_effective_to <= term.effective_from then
    raise exception 'TIER_OFFER_TERM_WINDOW_INVALID';
  end if;

  logged_id := app.write_audit_row(
    'billing.tier_offer_term.closed', actor, null, 'tier_offer_term', p_term_id::text,
    btrim(p_reason),
    jsonb_build_object(
      'tier_id', term.tier_id,
      'effective_from', term.effective_from,
      'effective_to', p_effective_to
    )
  );

  begin
    update public.tier_offer_terms
    set effective_to = p_effective_to, closed_audit_id = logged_id
    where id = p_term_id;
  exception
    when exclusion_violation then raise exception 'TIER_OFFER_TERM_WINDOW_OVERLAP';
  end;

  return query select p_term_id, logged_id;
end;
$$;

-- The admin history read. The table's own deny-all row security stands; this is the second
-- security-definer reader, and unlike the signup catalogue it returns closed windows too, because
-- the point of the surface is what a tier used to sell for.
create function public.list_tier_offer_terms(p_actor_id uuid)
returns table (
  id uuid,
  tier_id uuid,
  tier_name text,
  currency text,
  amount_cents integer,
  billing_interval text,
  stripe_price_id text,
  effective_from timestamptz,
  effective_to timestamptz,
  reason text,
  audit_id bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.phase6_verified_actor(p_actor_id, null, true, false);
  return query
  select
    offer.id,
    offer.tier_id,
    tier.name,
    offer.currency,
    offer.amount_cents,
    offer.billing_interval,
    offer.stripe_price_id,
    offer.effective_from,
    offer.effective_to,
    offer.reason,
    offer.audit_id,
    offer.created_at
  from public.tier_offer_terms as offer
  inner join public.tiers as tier on tier.id = offer.tier_id
  order by lower(tier.name), tier.id, offer.effective_from desc;
end;
$$;

revoke execute on function public.record_tier_offer_term(
  uuid, uuid, text, int, text, text, timestamptz, timestamptz, text
) from public, anon, authenticated;
revoke execute on function public.close_tier_offer_term(uuid, uuid, timestamptz, text)
  from public, anon, authenticated;
revoke execute on function public.list_tier_offer_terms(uuid) from public, anon, authenticated;

grant execute on function public.record_tier_offer_term(
  uuid, uuid, text, int, text, text, timestamptz, timestamptz, text
) to service_role;
grant execute on function public.close_tier_offer_term(uuid, uuid, timestamptz, text) to service_role;
grant execute on function public.list_tier_offer_terms(uuid) to service_role;
