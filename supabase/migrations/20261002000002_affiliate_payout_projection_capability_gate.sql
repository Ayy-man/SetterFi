-- T15-13, the database half. `docs/DECISIONS.md:277` decided that the `affiliates` row is the
-- affiliate capability and that portal access is gated on that row existing, never on
-- `role = 'affiliate'`: `users.role` is single-valued and `users.email` is unique, so gating on the
-- role forces a coach who also refers coaches into a second account under a second email, while
-- `affiliates.user_id` attaches to the row they already have. `docs/ARCHITECTURE.md:366` states the
-- same rule.
--
-- Three layers implement the affiliate portal and until now they disagreed. `/affiliate` and
-- `affiliate_referral_projection` (20260822000001_phase6_money.sql:1214) already select the caller
-- by `affiliate.user_id = app.current_user_id()`, which is the capability. This function was the
-- odd one out: it joined `public.users` and required `actor.role = 'affiliate'`, so a dual-role
-- coach reached the portal, the referral table rendered, and payout history came back empty with no
-- explanation. Re-keyed here onto the same predicate its sibling uses.
--
-- What the role predicate was buying, and why dropping it loses nothing:
--
--   * `actor.role = 'affiliate'` was a second, weaker spelling of "has an affiliates row". The join
--     to `public.affiliates` on `app.current_user_id()` is the stronger one — it reads the live row
--     at query time, so a revoked capability closes the projection on the next statement rather
--     than at the next token refresh.
--   * `actor.role::text = app.current_user_role()::text` cross-checked the JWT's role claim against
--     the persisted row, which mattered while the role WAS the authority. With the row as the
--     authority the claim is not consulted at all, so there is no claim left to go stale. Every
--     other property is unchanged: still `security definer` with an empty `search_path`, still
--     refusing impersonated sessions, still one affiliate per session selected inside PostgreSQL
--     from `app.current_user_id()` with no caller-supplied identifier anywhere in the signature,
--     and still returning only the four payout fields the portal renders — no tenant identifier,
--     no referred-coach performance, no cost or margin.
--
-- Signature, result columns, grants and revokes are deliberately untouched, so
-- `supabase/tests/phase6-schema.test.ts` continues to pin them as it does today.

create or replace function public.affiliate_payout_history_projection()
returns table (
  amount_cents bigint,
  state text,
  reference text,
  recorded_on date
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();

  return query
  select payout.total_cents,
    case when sent.id is null then 'approved_for_payout' else 'sent' end,
    sent.reference,
    sent.paid_on
  from public.affiliates affiliate
  join public.commission_payouts payout on payout.affiliate_id = affiliate.id
  join public.commission_payout_events approved
    on approved.payout_id = payout.id and approved.kind = 'approved'
  left join public.commission_payout_events sent
    on sent.payout_id = payout.id and sent.kind = 'sent'
  where affiliate.user_id = app.current_user_id()
  order by coalesce(sent.paid_on::timestamptz, approved.created_at) desc, payout.id;
end;
$$;

comment on function public.affiliate_payout_history_projection() is
  'Session-affiliate-only payout history, selected by the affiliates row per T15-13 rather than by '
  'role, so a dual-role coach reads their own payouts. Referred-coach performance and tenant '
  'identifiers are absent.';
