-- Durable platform review decisions for one immutable published offer revision.
-- A later publish has a new offer id/version/content hash, so it is automatically unreviewed.
set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('offer.review.cleared', 'human', 'tenant', true, false, 'Offer review logged', 'Offer clearance recorded in the audit log'),
  ('offer.review.rejected', 'human', 'tenant', true, false, 'Offer review logged', 'Offer rejection recorded in the audit log')
on conflict (key) do nothing;

create table public.offer_reviews (
  id uuid primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  offer_id uuid not null,
  offer_version int not null check (offer_version > 0),
  offer_content_hash text not null check (offer_content_hash ~ '^[0-9a-f]{64}$'),
  decision text not null check (decision in ('clear', 'rejected')),
  reason text not null check (nullif(btrim(reason), '') is not null),
  reviewed_by uuid not null references public.users(id),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete restrict
);
create index offer_reviews_current_revision_idx
  on public.offer_reviews (tenant_id, offer_id, offer_version, offer_content_hash, created_at desc, id desc);

create function app.reject_offer_review_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'OFFER_REVIEWS_APPEND_ONLY';
end;
$$;
create trigger offer_reviews_reject_mutation
before update or delete on public.offer_reviews
for each row execute function app.reject_offer_review_mutation();

alter table public.offer_reviews enable row level security;
alter table public.offer_reviews force row level security;
revoke all on public.offer_reviews from public, anon, authenticated;
grant select on public.offer_reviews to service_role;

create function app.assert_offer_review_actor(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
begin
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin') then
    raise exception 'OFFER_REVIEW_ACTOR_FORBIDDEN';
  end if;
end;
$$;

create function public.record_offer_review(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_offer_id uuid,
  p_offer_version int,
  p_offer_content_hash text,
  p_decision text,
  p_reason text
)
returns table (offer_review_id uuid, audit_id bigint, decision text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  offer_row public.offer_layers%rowtype;
  review_id uuid := gen_random_uuid();
  logged_id bigint;
  audit_action text;
  normalized_reason text := nullif(btrim(p_reason), '');
begin
  perform app.assert_not_impersonating();
  perform app.assert_offer_review_actor(p_actor_id);
  if normalized_reason is null then raise exception 'OFFER_REVIEW_REASON_REQUIRED'; end if;
  if p_decision not in ('clear', 'rejected') then raise exception 'OFFER_REVIEW_DECISION_INVALID'; end if;
  if p_offer_version is null or p_offer_version < 1
    or p_offer_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'OFFER_REVIEW_REVISION_INVALID';
  end if;

  -- Lock the currently published revision. The complete id/version/hash assertion rejects stale
  -- admin screens and makes a later publish invalidate clearance rather than inherit it.
  select * into offer_row
  from public.offer_layers
  where id = p_offer_id and tenant_id = p_expected_tenant and status = 'published'
  for update;
  if offer_row.id is null then raise exception 'OFFER_REVIEW_PUBLISHED_OFFER_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, offer_row.tenant_id, 'offer_review');
  if offer_row.version <> p_offer_version or offer_row.content_hash <> p_offer_content_hash then
    raise exception 'OFFER_REVIEW_REVISION_STALE';
  end if;

  audit_action := case p_decision
    when 'clear' then 'offer.review.cleared'
    else 'offer.review.rejected'
  end;
  logged_id := app.write_audit_row(
    audit_action, p_actor_id, p_expected_tenant, 'offer_review', review_id::text, normalized_reason,
    jsonb_build_object(
      'offer_id', offer_row.id,
      'offer_version', offer_row.version,
      'offer_content_hash', offer_row.content_hash,
      'decision', p_decision
    )
  );
  insert into public.offer_reviews (
    id, tenant_id, offer_id, offer_version, offer_content_hash, decision, reason, reviewed_by, audit_id
  ) values (
    review_id, p_expected_tenant, offer_row.id, offer_row.version, offer_row.content_hash,
    p_decision, normalized_reason, p_actor_id, logged_id
  );
  return query select review_id, logged_id, p_decision;
end;
$$;

revoke execute on function app.reject_offer_review_mutation() from public, anon, authenticated;
revoke execute on function app.assert_offer_review_actor(uuid) from public, anon, authenticated;
revoke execute on function public.record_offer_review(uuid,uuid,uuid,int,text,text,text)
  from public, anon, authenticated;
grant execute on function public.record_offer_review(uuid,uuid,uuid,int,text,text,text) to service_role;

-- The Phase 5 RPC predates the review authority and receives only a boolean plus timestamp.
-- Rebind that asserted evidence to the *currently locked* published revision so a publication
-- between preflight and go-live cannot inherit an earlier clearance. Demo tenants retain their
-- declared synthetic path.
create or replace function public.go_live_onboarding(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_offer_review_clear boolean,
  p_offer_review_evidence_at timestamptz,
  p_subscription_state text,
  p_subscription_evidence_at timestamptz
)
returns table (tenant_id uuid, audit_id bigint, went_live_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  tenant_row public.tenants%rowtype;
  run_row public.onboarding_runs%rowtype;
  offer_row public.offer_layers%rowtype;
  logged_id bigint;
  activated_at timestamptz := now();
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, false);
  select * into tenant_row from public.tenants tenant
  where tenant.id = p_expected_tenant for update;
  if tenant_row.id is null then raise exception 'READINESS_TENANT_NOT_FOUND'; end if;
  if tenant_row.status <> 'onboarding' then raise exception 'READINESS_TENANT_NOT_ELIGIBLE'; end if;
  select * into run_row from public.onboarding_runs run
  where run.tenant_id = p_expected_tenant for update;
  if run_row.id is null then raise exception 'READINESS_RUN_NOT_FOUND'; end if;

  update public.tenants set status = 'active', updated_at = activated_at
  where id = p_expected_tenant;
  if not exists (
    select 1 from public.tenants tenant
    where tenant.id = p_expected_tenant and tenant.status = 'active'
  ) then raise exception 'READINESS_TENANT_ACTIVE_FAILED'; end if;
  if not exists (
    select 1 from public.channel_connections connection
    where connection.tenant_id = p_expected_tenant and connection.state = 'live'
      and connection.channel in ('instagram', 'messenger', 'sms', 'whatsapp', 'webchat')
  ) then raise exception 'READINESS_MESSAGING_CHANNEL_LIVE_REQUIRED'; end if;
  if not exists (
    select 1 from public.calendar_connections calendar
    where calendar.tenant_id = p_expected_tenant and calendar.is_primary
      and calendar.state = 'ready' and calendar.last_slot_fetch_ok
      and calendar.last_slot_fetch_at is not null
  ) then raise exception 'READINESS_PRIMARY_CALENDAR_HEALTHY_REQUIRED'; end if;
  select * into offer_row from public.offer_layers offer
  where offer.tenant_id = p_expected_tenant and offer.status = 'published'
  for share;
  if offer_row.id is null or nullif(btrim(offer_row.program_name), '') is null
    or offer_row.booking_mode is null then
    raise exception 'READINESS_PUBLISHED_OFFER_REQUIRED';
  end if;
  if not p_offer_review_clear or p_offer_review_evidence_at is null then
    raise exception 'READINESS_OFFER_REVIEW_CLEAR_REQUIRED';
  end if;
  if not tenant_row.is_demo and not exists (
    select 1 from public.offer_reviews review
    where review.tenant_id = p_expected_tenant
      and review.offer_id = offer_row.id
      and review.offer_version = offer_row.version
      and review.offer_content_hash = offer_row.content_hash
      and review.decision = 'clear'
      and review.created_at = p_offer_review_evidence_at
  ) then raise exception 'READINESS_OFFER_REVIEW_CLEAR_REQUIRED'; end if;
  if not exists (select 1 from public.brain_snapshots) then
    raise exception 'READINESS_PLATFORM_BRAIN_PUBLISHED_REQUIRED';
  end if;
  if not exists (
    select 1 from public.provisioning_steps step
    where step.tenant_id = p_expected_tenant and step.step_key = 'test_pass' and step.state = 'done'
  ) then raise exception 'READINESS_TEST_PASS_REQUIRED'; end if;
  if p_subscription_state not in ('active', 'trialing', 'past_due')
    or p_subscription_evidence_at is null
    or p_subscription_evidence_at < now() - interval '15 minutes' then
    raise exception 'subscription_contract_unavailable';
  end if;

  update public.onboarding_runs
  set readiness_met_at = coalesce(readiness_met_at, activated_at),
      went_live_at = activated_at, updated_at = activated_at
  where id = run_row.id;
  update public.provisioning_steps
  set state = 'done', completed_at = activated_at, lease_expires_at = null, attempt_id = null,
      awaiting_party = null, blocked_reason = null, error_code = null, error_message = null,
      last_transition_at = activated_at, updated_at = activated_at
  where provisioning_steps.tenant_id = p_expected_tenant
    and provisioning_steps.step_key = 'go_live';
  logged_id := app.write_audit_row(
    'tenant.went_live', p_actor_id, p_expected_tenant, 'tenant', p_expected_tenant::text,
    null, jsonb_build_object('subscription_state', p_subscription_state)
  );
  return query select p_expected_tenant, logged_id, activated_at;
end;
$$;

revoke execute on function public.go_live_onboarding(uuid,uuid,boolean,timestamptz,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.go_live_onboarding(uuid,uuid,boolean,timestamptz,text,timestamptz)
  to service_role;
