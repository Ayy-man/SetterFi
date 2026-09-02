-- The top contracted tier has no ceiling, and the schema had no way to say so.
--
-- `docs/INTAKE.md:53-57` is the client's own pricing in their own words: "297/mo upto 25 calls/m",
-- "597/m upto 75 calls/m", "997 beyond that". `docs/CONTEXT.md:230` restates it. The third tier is
-- the one the column could not express: `tiers.call_allowance` is `int not null`
-- (`20260813000001_init.sql:200`) with a `>= 0` check (`20260817000001_phase1_demo_path.sql:610`),
-- so an unbounded plan had to be stored as some number, and every number is a limit the customer
-- did not agree to.
--
-- ## Why a flag and not a nullable allowance
--
-- Making `call_allowance` nullable was the first design and it was withdrawn after the readers were
-- counted: about sixteen sites across thirteen files read that column, and none of them is written
-- to survive a null. Four mattered enough to decide it. `read_coach_measurement_for_actor` resolves
-- `allowance_state := 'available'` only `if allowance_period_start is not null and allowance_limit
-- is not null` (`20260823000001_phase7_measurement.sql:1324`), so a null would have made the
-- best-paying coach's dashboard read "there is no active billing period" -- the exact sentence that
-- was just corrected elsewhere. `src/components/marketing/landing-page.tsx:183` sells the plan on
-- that number on the public marketing page, where a null renders as "0 calls included".
-- `src/lib/repositories/billing.ts:482` parses it through `integer()`, which throws on null. And
-- `src/lib/billing/allowances.ts:17` types it `allowance: number` by hand -- there are no generated
-- Supabase types in this repository, so nothing at compile time would have caught the column
-- ceasing to be one.
--
-- An additive boolean leaves all sixteen readers correct because the column still holds a number.
-- `call_allowance` on an uncapped tier keeps its contractual meaning: it is the threshold the tier
-- begins at -- 75, "beyond that" -- and not a cap. `is_uncapped` is the separate fact that nothing
-- happens when the count passes it.
--
-- ## What must change behaviourally, and it is exactly one thing
--
-- `src/lib/billing/allowances.ts` warns at `Math.ceil(allowance * 0.9)` and acts at
-- `observedCount >= candidate.allowance`, and a crossing action schedules a Stripe tier change.
-- Left alone against these rows it would warn a $997 tenant at 68 booked calls and schedule them an
-- upgrade at 75 -- a wrong charge against a contract that names no ceiling. That job reads the flag
-- and short-circuits; `allowances.test.ts` fails if an uncapped tier can produce either action.
--
-- ## What is deliberately not in here
--
-- `tier_price_versions` does not get the column. It is the price-history table and its writer
-- `record_tier_price_version` (`20260822000002_phase6_payout_actor_custody.sql:86`) has a fixed
-- signature that an admin price edit runs through; widening it would pull the admin tier editor,
-- its projection and its audit shape into a change that is about the seeded ladder. The consequence
-- is worth stating plainly rather than discovering later: `is_uncapped` survives an admin price
-- edit untouched, because that RPC updates `price_cents`, `call_allowance` and `fair_use_cap` and
-- nothing else -- but there is also no admin control that can toggle it. Today it is set by the
-- seed and by migration, and an operator who needs to flip it has no screen for it. That is a real
-- gap, logged rather than half-built here.
--
-- No coach-facing surface reads the flag yet either. `/coach/billing` and `/coach/home` will
-- present an uncapped tenant as "n of 75" with a progress meter, which is a cap being stated where
-- there is none. That is presentation rather than money and it belongs to the surface lane, but it
-- is the reason this migration is not the whole of the work.

alter table public.tiers
  add column if not exists is_uncapped boolean not null default false;

comment on column public.tiers.is_uncapped is
  'True when the plan has no booked-call ceiling. call_allowance still holds the threshold the tier begins at, so every reader that treats it as a number stays correct; this flag is what stops the allowance job warning or scheduling a tier change at that number. See docs/INTAKE.md:53-57.';
