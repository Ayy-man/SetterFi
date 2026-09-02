-- Reassert the custody boundary for the already-established offer-review authority.
--
-- `20260919000002_offer_review_authority.sql` introduced the append-only revision-bound table
-- and the only write RPC. This follow-up deliberately keeps direct writes unavailable: a coach
-- cannot bypass `record_offer_review`, whose database-side actor assertion permits owner/admin
-- capability only. Reapplying the grants and forced RLS makes that boundary durable even when
-- the migration chain is replayed from a later schema baseline.
set search_path = public, extensions;

alter table public.offer_reviews enable row level security;
alter table public.offer_reviews force row level security;
revoke all on public.offer_reviews from public, anon, authenticated;
revoke all on public.offer_reviews from service_role;
grant select on public.offer_reviews to service_role;

revoke execute on function public.record_offer_review(uuid,uuid,uuid,int,text,text,text)
  from public, anon, authenticated;
grant execute on function public.record_offer_review(uuid,uuid,uuid,int,text,text,text) to service_role;
