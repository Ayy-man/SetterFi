-- The affiliate table read a coach whose payments had stalled as one who was paying.
--
-- `affiliate_referral_projection` (20260822000001_phase6_money.sql:1214) returned the right three
-- columns and the wrong values in one of them: it flattened `tenant_status` to a two-state
-- `active`/`inactive` in the SQL itself, with the first four of the six enum values becoming
-- `active`. This changes the values that one column can take. **It deliberately does not add a
-- column**, and the next paragraph is the reason.
--
-- **`joined_on` was built here and then removed before it shipped.** `Affiliate.dc.html` draws a
-- fourth column, Joined, and `referrals.created_at` (20260813000001_init.sql:704) has recorded that
-- moment since the schema was written, so it was a projection away. It is not projected, because
-- `CLAUDE.md` fixes what one customer may learn about another: "Affiliate — sees only referred-coach
-- name, status, and commission earned — never their performance data." That is three fields, and a
-- join date is a fourth. Whether a join date counts as performance data in spirit is exactly the
-- question the build side does not get to answer for itself, and the canvas is a drawing rather than
-- an authority. Recorded as Alec's decision in `docs/DECISIONS.md`; the strict allowlists in
-- `src/lib/repositories/affiliates.ts`, the referrals route and the affiliate portal all refuse a
-- fourth field today, and they are the thing that caught this.
--
-- **The status.** The old two-state collapse folded `paused`, `overdue` and `suspended` into
-- `active`, which told an affiliate that commission was still coming from an account that had
-- stopped paying for it. That is the invented-figure rule wearing a different hat, and it is worse
-- than an invented figure because the affiliate makes plans on it. Four states now:
--
--   `setting_up`       onboarding -- the referral is real, the money has not started
--   `paying`           active
--   `payment_problem`  paused, overdue, suspended
--   `cancelled`        churned
--
-- `paused`, `overdue` and `suspended` deliberately collapse into ONE state. The affiliate sees a
-- referred coach's name, status and commission and nothing else, and *why* a coach's payments have
-- stalled is the coach's business, not their referrer's. "Payment problem" is the whole story the
-- affiliate can act on; distinguishing a card decline from a suspension would leak account detail
-- through a status label.
--
-- The `case` has **no `else` arm**, and that is the guard rather than an oversight. A seventh
-- `tenant_status` added later maps to no arm, yields null, and fails `parseProjection`'s key and
-- value check in `src/lib/repositories/affiliates.ts`, so the portal shows "could not load" instead
-- of quietly reading a new state as "Paying". Failing loudly in front of the affiliate is the right
-- trade here: the alternative is a wrong claim about money, made silently, to the person least able
-- to check it. `supabase/tests/phase6-schema.test.ts` pins the enum at six values so the same
-- mistake reddens a test before it ever reaches a reader.
--
-- Everything else is deliberately unchanged. Still `security definer` with an empty `search_path`,
-- still selecting one affiliate inside PostgreSQL from `app.current_user_id()` with no
-- caller-supplied identifier in the signature, and still returning no tenant identifier, no
-- referred-coach performance, and no cost or margin. The function is dropped and recreated rather
-- than replaced because PostgreSQL cannot change a function's OUT columns with
-- `create or replace`; the grants below restore exactly the pair the drop removed.

drop function if exists public.affiliate_referral_projection();

create function public.affiliate_referral_projection()
returns table (
  business_name text,
  account_status text,
  commission_earned_cents bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select tenant.name,
    case tenant.status
      when 'onboarding' then 'setting_up'
      when 'active' then 'paying'
      when 'paused' then 'payment_problem'
      when 'overdue' then 'payment_problem'
      when 'suspended' then 'payment_problem'
      when 'churned' then 'cancelled'
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

revoke execute on function public.affiliate_referral_projection() from public, anon;
grant execute on function public.affiliate_referral_projection()
  to authenticated, service_role;
