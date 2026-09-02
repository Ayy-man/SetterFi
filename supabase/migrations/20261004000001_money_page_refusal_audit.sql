-- A real receipt for the Money-page role-boundary refusal.
--
-- `MoneySurfaceGuard` (`src/components/workspace/live/admin-money-shell.tsx`) draws a refused
-- panel when `moneyPageAccessStatus` (`view-models.ts`) says a signed-in role does not carry a
-- Money surface. The canvas wanted that panel to say "Logged -- this attempt is on the audit
-- trail with your name, the page and the time", and the component's own comment refused to draw
-- that line because it was not true: there was no `money.page.refused` key and nothing wrote a
-- row. This migration makes the sentence true rather than leaving the copy thin.
--
-- Two refusals reach that guard and only one of them belongs on a security log. `!enabled` means
-- the billing feature flag is off for everybody, including the owner -- nobody was refused
-- anything, there is simply nothing to open yet. `!authorized` means a signed-in role hit a real
-- permission boundary, which is exactly the signal worth keeping if that boundary is being
-- probed. So only the role-boundary case gets an RPC to call; the flag-off case has nothing to
-- log and nothing here changes for it. That is the whole mechanism for keeping the two refusals
-- distinguishable -- one of them can produce a row, the other structurally cannot.
--
-- The role check is re-run inside the function rather than trusted from the caller. Every other
-- privileged write in this schema authorizes against `public.users` itself instead of an
-- application-computed boolean (`app.phase7_session_actor`, `reassign_success_owner`, and so on);
-- an audit action is not exempt from that rule just because it only records a refusal rather than
-- performing one. Recomputing `moneyPageAccessStatus`'s exact rule here means a refusal receipt
-- can never be forged by an actor who was actually authorized, and a genuine role-boundary hit is
-- never silently skipped because the two copies of the rule disagreed.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'money.page.refused', 'human', 'platform', false, false,
  'Refusal logged', 'Money page refusal recorded in the audit log'
);

create or replace function public.record_money_page_refusal(
  p_actor_id uuid,
  p_surface text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  logged_id bigint;
begin
  if p_surface not in ('tiers', 'billing', 'corrections', 'affiliates') then
    raise exception 'MONEY_PAGE_SURFACE_INVALID';
  end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null then raise exception 'MONEY_PAGE_REFUSAL_ACTOR_REQUIRED'; end if;
  -- The exact rule `moneyPageAccessStatus` encodes in `view-models.ts`: owner and admin carry
  -- every surface, success carries corrections alone. An actor who is actually authorized cannot
  -- produce a refusal row, no matter what the caller believed.
  if actor.role in ('owner', 'admin') or (actor.role = 'success' and p_surface = 'corrections') then
    raise exception 'MONEY_PAGE_REFUSAL_ACTOR_AUTHORIZED';
  end if;
  logged_id := app.write_audit_row(
    'money.page.refused', p_actor_id, null, 'money_page', p_surface, null,
    jsonb_build_object('surface', p_surface, 'role', actor.role)
  );
  return logged_id;
end;
$$;

revoke all on function public.record_money_page_refusal(uuid, text) from public, anon, authenticated;
grant execute on function public.record_money_page_refusal(uuid, text) to service_role;

comment on function public.record_money_page_refusal(uuid, text) is
  'Writes a money.page.refused audit row for a real role-boundary refusal on an admin Money surface (tiers, billing, corrections, affiliates). Recomputes moneyPageAccessStatus server-side from public.users so the receipt can never be forged or skipped by the caller. Never called for a feature-flag refusal, which is not a role boundary and has nothing to log.';
