-- SetterFi Phase 5 durable self-serve onboarding contract.
--
-- Phase 1 owns the onboarding vocabulary and base rows; Phases 3 and 4 own consent validation and
-- messaging identity/connection storage. This follow-on adds evidence and transactional custody
-- without recreating those objects, storing provider secrets, or giving browser roles write access.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Fail-loud prerequisites and populated-stack remediation guards
-- ---------------------------------------------------------------------------

do $$
declare
  missing text[];
  actual_steps text[];
  expected_steps constant text[] := array[
    'account', 'billing', 'ghl_location', 'ghl_snapshot', 'phone_number',
    'sms_eligibility_screen', 'business_profile', 'optin_artifact', 'a2p_brand',
    'a2p_campaign', 'sms_live', 'meta_connect', 'whatsapp_connect',
    'calendar_connect', 'offer_layer', 'test_pass', 'go_live'
  ];
begin
  select array_agg(required_name order by required_name) into missing
  from unnest(array[
    'affiliates', 'audit_actions', 'audit_log', 'brain_snapshots', 'calendar_connections',
    'channel_connections', 'contact_identities', 'offer_layers', 'onboarding_runs',
    'provisioning_steps', 'referrals', 'signup_intents', 'tenant_settings', 'tenants',
    'tiers', 'users'
  ]) required_name
  where to_regclass('public.' || required_name) is null;

  if missing is not null then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE5_REQUIRED_RELATIONS_MISSING',
      detail = array_to_string(missing, ', ');
  end if;

  if to_regprocedure('app.assert_expected_tenant(uuid,uuid,text)') is null
    or to_regprocedure('app.assert_not_impersonating()') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid)') is null then
    raise exception 'PHASE5_PHASE1_HELPERS_REQUIRED';
  end if;

  select array_agg(e.enumlabel order by e.enumsortorder) into actual_steps
  from pg_enum e
  join pg_type t on t.oid = e.enumtypid
  join pg_namespace n on n.oid = t.typnamespace
  where n.nspname = 'public' and t.typname = 'provisioning_step';

  if actual_steps is distinct from expected_steps then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE5_PROVISIONING_STEP_PREREQUISITE_MISSING',
      detail = coalesce(array_to_string(actual_steps, ', '), 'type missing');
  end if;

  if to_regclass('public.business_profiles') is not null
    or to_regclass('public.onboarding_optin_artifacts') is not null
    or to_regclass('public.onboarding_content_screens') is not null
    or to_regclass('public.a2p_probe_receipts') is not null then
    raise exception 'PHASE5_PARTIAL_SCHEMA_REMEDIATION_REQUIRED';
  end if;

  if exists (
    select 1 from public.provisioning_steps
    where state = 'blocked' and nullif(btrim(blocked_reason), '') is null
  ) then
    raise exception 'PHASE5_BLOCKED_REASON_REMEDIATION_REQUIRED';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Durable leases and idempotency on the Phase 1 step authority
-- ---------------------------------------------------------------------------

alter table public.provisioning_steps
  add column next_attempt_at timestamptz,
  add column lease_expires_at timestamptz,
  add column last_transition_at timestamptz,
  add column attempt_id uuid,
  add column idempotency_key text;

update public.provisioning_steps
set next_attempt_at = coalesce(last_attempt_at, created_at),
    last_transition_at = updated_at,
    completed_at = case when state = 'done' then coalesce(completed_at, updated_at) else null end,
    idempotency_key = tenant_id::text || ':' || step_key::text;

alter table public.provisioning_steps
  alter column next_attempt_at set not null,
  alter column next_attempt_at set default now(),
  alter column last_transition_at set not null,
  alter column last_transition_at set default now(),
  alter column idempotency_key set not null,
  add constraint provisioning_steps_idempotency_key_key unique (idempotency_key),
  add constraint provisioning_steps_idempotency_shape_chk check (
    idempotency_key = tenant_id::text || ':' || step_key::text
  ),
  add constraint provisioning_steps_lease_shape_chk check (
    (state = 'running') = (lease_expires_at is not null and attempt_id is not null)
  ),
  add constraint provisioning_steps_completion_shape_chk check (
    (state = 'done') = (completed_at is not null)
  );

create index provisioning_steps_runnable_idx
  on public.provisioning_steps (state, next_attempt_at, lease_expires_at)
  where state in ('pending', 'failed', 'running');

-- ---------------------------------------------------------------------------
-- 3. Business, legal-artifact, content-screen, and provider evidence
-- ---------------------------------------------------------------------------

create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  legal_name text not null check (nullif(btrim(legal_name), '') is not null),
  entity_type text not null check (
    entity_type in ('sole_proprietor', 'llc', 'corporation', 'partnership', 'other')
  ),
  has_ein boolean not null,
  website_url text not null check (website_url ~ '^https://'),
  address_line1 text not null check (nullif(btrim(address_line1), '') is not null),
  address_line2 text,
  city text not null check (nullif(btrim(city), '') is not null),
  region text not null check (nullif(btrim(region), '') is not null),
  postal_code text not null check (nullif(btrim(postal_code), '') is not null),
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint business_profiles_entity_ein_chk check (
    entity_type not in ('llc', 'corporation') or has_ein
  ),
  unique (id, tenant_id)
);

create table public.onboarding_optin_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version int not null check (version > 0),
  template_version text not null check (nullif(btrim(template_version), '') is not null),
  marketing_language text not null check (nullif(btrim(marketing_language), '') is not null),
  marketing_language_hash text not null check (marketing_language_hash ~ '^[0-9a-f]{64}$'),
  non_marketing_language text not null check (nullif(btrim(non_marketing_language), '') is not null),
  non_marketing_language_hash text not null check (non_marketing_language_hash ~ '^[0-9a-f]{64}$'),
  terms_url text not null check (terms_url ~ '^https://'),
  privacy_url text not null check (privacy_url ~ '^https://'),
  campaign_description text not null check (nullif(btrim(campaign_description), '') is not null),
  campaign_description_hash text not null check (campaign_description_hash ~ '^[0-9a-f]{64}$'),
  artifact_hash text not null check (artifact_hash ~ '^[0-9a-f]{64}$'),
  placeholder boolean not null default true,
  is_current boolean not null default true,
  confirmed_at timestamptz,
  confirmed_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, version),
  unique (id, tenant_id),
  constraint onboarding_optin_artifacts_confirmation_chk check (
    (confirmed_at is null) = (confirmed_by is null)
  )
);
create unique index onboarding_optin_artifacts_current_uidx
  on public.onboarding_optin_artifacts (tenant_id) where is_current;

create table public.onboarding_content_screens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (result in ('clean', 'flagged')),
  matches jsonb not null default '[]'::jsonb check (jsonb_typeof(matches) = 'array'),
  is_current boolean not null default true,
  acknowledged_at timestamptz,
  acknowledged_by uuid references public.users(id),
  admin_confirmed_at timestamptz,
  admin_confirmed_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, input_hash),
  unique (id, tenant_id),
  constraint onboarding_content_screens_ack_chk check (
    (acknowledged_at is null) = (acknowledged_by is null)
  ),
  constraint onboarding_content_screens_admin_chk check (
    (admin_confirmed_at is null) = (admin_confirmed_by is null)
    and (admin_confirmed_at is null or acknowledged_at is not null)
  ),
  constraint onboarding_content_screens_clean_chk check (
    result <> 'clean'
    or (matches = '[]'::jsonb and acknowledged_at is null and admin_confirmed_at is null)
  )
);
create unique index onboarding_content_screens_current_uidx
  on public.onboarding_content_screens (tenant_id) where is_current;

create table public.a2p_probe_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  probe_key text not null check (nullif(btrim(probe_key), '') is not null),
  target_identifier_hash text not null check (target_identifier_hash ~ '^[0-9a-f]{64}$'),
  result text not null check (
    result in ('inconclusive', 'retryable_failure', 'delivered', 'terminal_rejection')
  ),
  provider_reference text,
  provider_code text,
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, probe_key),
  unique (id, tenant_id),
  constraint a2p_probe_receipts_provider_reference_chk check (
    result not in ('delivered', 'terminal_rejection')
    or nullif(btrim(provider_reference), '') is not null
  )
);
create index a2p_probe_receipts_tenant_observed_idx
  on public.a2p_probe_receipts (tenant_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- 4. Additive Phase 5 audit registry
-- ---------------------------------------------------------------------------

-- Phase 5
insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('consent.web_form_recorded', 'system', 'tenant', false, true, 'Consent recorded', 'Hosted form consent evidence recorded in the audit log'),
  ('onboarding.artifact_confirmed', 'human', 'tenant', false, true, 'Consent page confirmation logged', 'Consent page confirmation recorded in the audit log'),
  ('onboarding.content_acknowledged', 'human', 'tenant', false, true, 'Content acknowledgement logged', 'Registration content acknowledgement recorded in the audit log'),
  ('onboarding.content_admin_confirmed', 'human', 'tenant', false, true, 'Content confirmation logged', 'Registration content confirmation recorded in the audit log'),
  ('onboarding.signup_completed', 'human', 'tenant', false, true, 'Signup logged', 'Onboarding signup recorded in the audit log');

-- ---------------------------------------------------------------------------
-- 5. Immutability and tenant-child guards
-- ---------------------------------------------------------------------------

create or replace function app.reject_a2p_probe_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'A2P_PROBE_RECEIPTS_APPEND_ONLY';
end;
$$;

create trigger a2p_probe_receipts_reject_mutation
before update or delete on public.a2p_probe_receipts
for each row execute function app.reject_a2p_probe_mutation();

create or replace function app.enforce_referral_signup_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'REFERRAL_ATTRIBUTION_IMMUTABLE';
  end if;
  if current_user <> 'postgres'
    or current_setting('app.phase5_signup_referral', true) is distinct from 'on' then
    raise exception 'REFERRAL_SIGNUP_ONLY';
  end if;
  return new;
end;
$$;

create trigger referrals_signup_only
before insert or update or delete on public.referrals
for each row execute function app.enforce_referral_signup_only();

create trigger set_updated_at before update on public.business_profiles
for each row execute function app.set_updated_at();
create trigger set_updated_at before update on public.onboarding_optin_artifacts
for each row execute function app.set_updated_at();
create trigger set_updated_at before update on public.onboarding_content_screens
for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Forced RLS, deliberate reads, and zero browser writes
-- ---------------------------------------------------------------------------

alter table public.business_profiles enable row level security;
alter table public.business_profiles force row level security;
alter table public.onboarding_optin_artifacts enable row level security;
alter table public.onboarding_optin_artifacts force row level security;
alter table public.onboarding_content_screens enable row level security;
alter table public.onboarding_content_screens force row level security;
alter table public.a2p_probe_receipts enable row level security;
alter table public.a2p_probe_receipts force row level security;

create policy business_profiles_tenant_read on public.business_profiles for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy business_profiles_platform_read on public.business_profiles for select to authenticated
  using (app.is_platform_operator());
create policy onboarding_optin_artifacts_tenant_read on public.onboarding_optin_artifacts
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy onboarding_optin_artifacts_platform_read on public.onboarding_optin_artifacts
  for select to authenticated using (app.is_platform_operator());
create policy onboarding_content_screens_tenant_read on public.onboarding_content_screens
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy onboarding_content_screens_platform_read on public.onboarding_content_screens
  for select to authenticated using (app.is_platform_operator());
create policy a2p_probe_receipts_tenant_read on public.a2p_probe_receipts
  for select to authenticated using (app.owns_tenant(tenant_id));
create policy a2p_probe_receipts_platform_read on public.a2p_probe_receipts
  for select to authenticated using (app.is_platform_operator());

revoke all on public.business_profiles, public.onboarding_optin_artifacts,
  public.onboarding_content_screens, public.a2p_probe_receipts from anon, authenticated, service_role;
grant select on public.business_profiles, public.onboarding_optin_artifacts,
  public.onboarding_content_screens, public.a2p_probe_receipts to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Filing prerequisite and actor helpers
-- ---------------------------------------------------------------------------

create or replace function app.assert_phase5_actor(
  p_actor_id uuid,
  p_tenant_id uuid,
  p_platform_only boolean default false
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
begin
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE5_ACTOR_NOT_FOUND'; end if;
  if p_platform_only then
    if actor_row.role not in ('owner', 'admin', 'success') then
      raise exception 'PHASE5_PLATFORM_ACTOR_REQUIRED';
    end if;
  elsif actor_row.tenant_id is distinct from p_tenant_id
    and actor_row.role not in ('owner', 'admin', 'success') then
    raise exception 'PHASE5_ACTOR_TENANT_MISMATCH';
  end if;
end;
$$;

create or replace function app.assert_a2p_filing_ready(p_tenant_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.onboarding_optin_artifacts artifact
    where artifact.tenant_id = p_tenant_id and artifact.is_current
      and artifact.confirmed_at is not null and not artifact.placeholder
  ) then
    raise exception 'A2P_ARTIFACT_NOT_APPROVED';
  end if;
  if not exists (
    select 1 from public.onboarding_content_screens screen
    where screen.tenant_id = p_tenant_id and screen.is_current
      and (
        screen.result = 'clean'
        or (screen.result = 'flagged' and screen.acknowledged_at is not null
          and screen.admin_confirmed_at is not null)
      )
  ) then
    raise exception 'A2P_CONTENT_SCREEN_NOT_APPROVED';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Atomic signup and immutable referral attribution
-- ---------------------------------------------------------------------------

create or replace function public.complete_onboarding_signup(
  p_expected_auth_user_id uuid,
  p_auth_user_id uuid,
  p_email text,
  p_full_name text,
  p_business_name text,
  p_slug text,
  p_tier_id uuid,
  p_timezone text,
  p_referral_code text default null,
  p_affiliate_opt_in boolean default false
)
returns table (
  tenant_id uuid,
  referral_result text,
  audit_id bigint,
  replayed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent_row public.signup_intents%rowtype;
  existing_user public.users%rowtype;
  new_tenant_id uuid;
  referral_affiliate public.affiliates%rowtype;
  referral_outcome text := 'none';
  logged_id bigint;
  generated_referral_code text;
begin
  perform app.assert_not_impersonating();
  if p_expected_auth_user_id is null or p_auth_user_id is null
    or p_expected_auth_user_id <> p_auth_user_id then
    raise exception 'SIGNUP_AUTH_USER_MISMATCH';
  end if;
  if nullif(btrim(p_email), '') is null or nullif(btrim(p_business_name), '') is null
    or nullif(btrim(p_slug), '') is null or p_tier_id is null
    or nullif(btrim(p_timezone), '') is null then
    raise exception 'SIGNUP_REQUIRED_FIELD_MISSING';
  end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then
    raise exception 'SIGNUP_TIMEZONE_INVALID:%', p_timezone;
  end if;
  if not exists (select 1 from public.tiers where id = p_tier_id and active) then
    raise exception 'SIGNUP_TIER_REQUIRED';
  end if;

  select * into intent_row from public.signup_intents
  where auth_user_id = p_auth_user_id for update;
  if intent_row.id is null then raise exception 'SIGNUP_INTENT_REQUIRED'; end if;

  select * into existing_user from public.users where id = p_auth_user_id;
  if intent_row.state = 'completed' then
    if intent_row.tenant_id is null or existing_user.tenant_id is distinct from intent_row.tenant_id then
      raise exception 'SIGNUP_REPLAY_STATE_INVALID';
    end if;
    return query select intent_row.tenant_id, 'none'::text, null::bigint, true;
    return;
  end if;

  update public.signup_intents
  set email = lower(btrim(p_email)), tier_id = p_tier_id, timezone = p_timezone,
      referral_code = nullif(btrim(p_referral_code), ''), state = 'started', error = null,
      updated_at = now()
  where id = intent_row.id;

  insert into public.tenants (
    slug, name, status, tier_id, billing_contact_email, billing_contact_name
  ) values (
    lower(btrim(p_slug)), btrim(p_business_name), 'onboarding', p_tier_id,
    lower(btrim(p_email)), nullif(btrim(p_full_name), '')
  ) returning id into new_tenant_id;

  insert into public.tenant_settings (tenant_id, timezone)
  values (new_tenant_id, p_timezone);
  if existing_user.id is null then
    insert into public.users (id, email, full_name, role, tenant_id)
    values (p_auth_user_id, lower(btrim(p_email)), nullif(btrim(p_full_name), ''), 'coach', new_tenant_id);
  elsif existing_user.role = 'affiliate' and existing_user.tenant_id is null then
    -- One person can carry an affiliate row and later become a coach; the role switches to the
    -- tenant role while the affiliate row remains the immutable attribution owner.
    update public.users
    set email = lower(btrim(p_email)), full_name = nullif(btrim(p_full_name), ''),
        role = 'coach', tenant_id = new_tenant_id, updated_at = now()
    where id = p_auth_user_id;
  else
    raise exception 'SIGNUP_AUTH_USER_ALREADY_ATTACHED';
  end if;
  insert into public.onboarding_runs (tenant_id) values (new_tenant_id);

  insert into public.provisioning_steps (
    tenant_id, step_key, state, awaiting_party, completed_at, next_attempt_at,
    last_transition_at, idempotency_key
  )
  select new_tenant_id, step_key::public.provisioning_step,
    case
      when step_key = 'account' then 'done'::public.provisioning_state
      when step_key = 'billing' then 'awaiting_platform'::public.provisioning_state
      else 'pending'::public.provisioning_state
    end,
    null::public.awaiting_party,
    case when step_key = 'account' then now() else null end,
    now(), now(), new_tenant_id::text || ':' || step_key
  from unnest(array[
    'account', 'billing', 'ghl_location', 'ghl_snapshot', 'phone_number',
    'sms_eligibility_screen', 'business_profile', 'optin_artifact', 'a2p_brand',
    'a2p_campaign', 'sms_live', 'meta_connect', 'whatsapp_connect',
    'calendar_connect', 'offer_layer', 'test_pass', 'go_live'
  ]) step_key
  on conflict on constraint provisioning_steps_tenant_id_step_key_key do nothing;

  if nullif(btrim(p_referral_code), '') is not null then
    select * into referral_affiliate from public.affiliates
    where upper(referral_code) = upper(btrim(p_referral_code));
    if referral_affiliate.id is null then
      referral_outcome := 'invalid_silent';
      logged_id := app.write_audit_row(
        'referral.code_rejected', null, new_tenant_id, 'referral_code', null, null,
        jsonb_build_object('reason', 'unknown', 'code', btrim(p_referral_code))
      );
    elsif referral_affiliate.user_id = p_auth_user_id then
      referral_outcome := 'self_referral';
      logged_id := app.write_audit_row(
        'referral.code_rejected', null, new_tenant_id, 'referral_code', null, null,
        jsonb_build_object('reason', 'self_referral', 'code', btrim(p_referral_code))
      );
    elsif not referral_affiliate.link_active then
      referral_outcome := 'invalid_silent';
      logged_id := app.write_audit_row(
        'referral.code_rejected', null, new_tenant_id, 'referral_code', null, null,
        jsonb_build_object('reason', 'revoked', 'code', btrim(p_referral_code))
      );
    else
      perform set_config('app.phase5_signup_referral', 'on', true);
      insert into public.referrals (affiliate_id, tenant_id)
      values (referral_affiliate.id, new_tenant_id);
      perform set_config('app.phase5_signup_referral', 'off', true);
      referral_outcome := 'attributed';
    end if;
  end if;

  if p_affiliate_opt_in then
    generated_referral_code := 'SF-' || upper(substr(replace(p_auth_user_id::text, '-', ''), 1, 12));
    insert into public.affiliates (user_id, referral_code)
    values (p_auth_user_id, generated_referral_code)
    on conflict (user_id) do nothing;
  end if;

  update public.signup_intents
  set tenant_id = new_tenant_id, state = 'completed', error = null, updated_at = now()
  where id = intent_row.id;

  logged_id := app.write_audit_row(
    'onboarding.signup_completed', p_auth_user_id, new_tenant_id, 'onboarding_run',
    (select run.id::text from public.onboarding_runs run where run.tenant_id = new_tenant_id), null,
    jsonb_build_object('timezone', p_timezone, 'referral_result', referral_outcome)
  );

  return query select new_tenant_id, referral_outcome, logged_id, false;
exception
  when others then
    -- The tenant transaction rolls back, while the route's earlier intent row remains durable and
    -- can record this normalized failure in a separate statement after this RPC returns.
    raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Closed state machine, bounded claims, retries, and blocked correction
-- ---------------------------------------------------------------------------

create or replace function public.claim_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_attempt_id uuid,
  p_lease_seconds int default 900
)
returns table (
  tenant_id uuid,
  step_key public.provisioning_step,
  attempt_id uuid,
  idempotency_key text,
  attempts int,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.provisioning_steps%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null or p_attempt_id is null
    or p_lease_seconds not between 30 and 1800 then
    raise exception 'PROVISIONING_CLAIM_INVALID';
  end if;

  select * into step_row from public.provisioning_steps
  where provisioning_steps.tenant_id = p_expected_tenant
    and provisioning_steps.step_key = p_step_key
  for update skip locked;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_CLAIMABLE'; end if;
  if step_row.state not in ('pending', 'failed')
    and not (step_row.state = 'running' and step_row.lease_expires_at <= now()) then
    raise exception 'PROVISIONING_STEP_NOT_CLAIMABLE:%', step_row.state;
  end if;
  if step_row.next_attempt_at > now() then raise exception 'PROVISIONING_BACKOFF_ACTIVE'; end if;
  if step_row.attempts >= 5 then raise exception 'PROVISIONING_ATTEMPT_BUDGET_EXHAUSTED'; end if;
  if p_step_key = 'a2p_campaign' then perform app.assert_a2p_filing_ready(p_expected_tenant); end if;

  update public.provisioning_steps
  set state = 'running', attempts = step_row.attempts + 1,
      started_at = coalesce(started_at, now()), last_attempt_at = now(),
      lease_expires_at = now() + make_interval(secs => p_lease_seconds),
      attempt_id = p_attempt_id, completed_at = null, awaiting_party = null,
      blocked_reason = null, error_code = null, error_message = null,
      last_transition_at = now(), updated_at = now()
  where id = step_row.id
  returning provisioning_steps.tenant_id, provisioning_steps.step_key,
    provisioning_steps.attempt_id, provisioning_steps.idempotency_key,
    provisioning_steps.attempts, provisioning_steps.lease_expires_at
  into tenant_id, step_key, attempt_id, idempotency_key, attempts, lease_expires_at;
  return next;
end;
$$;

create or replace function public.transition_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_attempt_id uuid,
  p_target_state public.provisioning_state,
  p_awaiting_party public.awaiting_party default null,
  p_error_code text default null,
  p_error_message text default null,
  p_external_ref jsonb default null,
  p_blocked_reason text default null,
  p_next_attempt_at timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.provisioning_steps%rowtype;
  allowed boolean := false;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into step_row from public.provisioning_steps
  where tenant_id = p_expected_tenant and step_key = p_step_key for update;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_FOUND'; end if;
  if step_row.state = 'running'
    and (p_attempt_id is null or step_row.attempt_id is distinct from p_attempt_id
      or step_row.lease_expires_at <= now()) then
    raise exception 'PROVISIONING_ATTEMPT_STALE';
  end if;

  allowed := case step_row.state
    when 'pending' then p_target_state in ('awaiting_coach', 'awaiting_platform', 'blocked')
    when 'running' then p_target_state in (
      'done', 'failed', 'awaiting_coach', 'awaiting_platform', 'awaiting_provider', 'blocked'
    )
    when 'awaiting_coach' then p_target_state = 'pending'
    when 'awaiting_platform' then p_target_state in ('pending', 'blocked')
    when 'awaiting_provider' then p_target_state in ('done', 'failed', 'blocked')
    else false
  end;
  if not allowed then
    raise exception 'PROVISIONING_TRANSITION_FORBIDDEN:%->%', step_row.state, p_target_state;
  end if;
  if p_target_state = 'awaiting_provider' and p_awaiting_party is null then
    raise exception 'PROVISIONING_AWAITING_PARTY_REQUIRED';
  end if;
  if p_target_state = 'blocked' and nullif(btrim(p_blocked_reason), '') is null then
    raise exception 'PROVISIONING_BLOCKED_REASON_REQUIRED';
  end if;
  if p_step_key = 'a2p_campaign' and p_target_state in ('awaiting_provider', 'done') then
    perform app.assert_a2p_filing_ready(p_expected_tenant);
  end if;

  update public.provisioning_steps
  set state = p_target_state,
      awaiting_party = case when p_target_state = 'awaiting_provider' then p_awaiting_party else null end,
      blocked_reason = case when p_target_state = 'blocked' then btrim(p_blocked_reason) else null end,
      completed_at = case when p_target_state = 'done' then now() else null end,
      lease_expires_at = null, attempt_id = null,
      error_code = case when p_target_state in ('failed', 'blocked') then p_error_code else null end,
      error_message = case when p_target_state in ('failed', 'blocked') then p_error_message else null end,
      external_ref = coalesce(p_external_ref, external_ref),
      next_attempt_at = coalesce(p_next_attempt_at, now()),
      last_transition_at = now(), updated_at = now()
  where id = step_row.id;

  if p_target_state = 'failed' then
    logged_id := app.write_audit_row(
      'onboarding.step_failed', null, p_expected_tenant, 'provisioning_step', step_row.id::text,
      null, jsonb_build_object('step_key', p_step_key, 'error_code', p_error_code)
    );
  elsif p_target_state = 'blocked' and p_step_key = 'sms_live' then
    logged_id := app.write_audit_row(
      'onboarding.a2p_blocked_permanent', null, p_expected_tenant,
      'provisioning_step', step_row.id::text, null,
      jsonb_build_object('step_key', p_step_key, 'error_code', p_error_code)
    );
  end if;
  return logged_id;
end;
$$;

create or replace function public.complete_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_attempt_id uuid,
  p_external_ref jsonb default null
)
returns bigint
language sql
set search_path = ''
as $$
  select public.transition_provisioning_step(
    p_expected_tenant, p_step_key, p_attempt_id, 'done', null, null, null,
    p_external_ref, null, null
  );
$$;

create or replace function public.fail_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_attempt_id uuid,
  p_error_code text,
  p_error_message text,
  p_next_attempt_at timestamptz
)
returns bigint
language sql
set search_path = ''
as $$
  select public.transition_provisioning_step(
    p_expected_tenant, p_step_key, p_attempt_id, 'failed', null,
    p_error_code, p_error_message, null, null, p_next_attempt_at
  );
$$;

create or replace function public.retry_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_actor_id uuid,
  p_expected_state public.provisioning_state
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.provisioning_steps%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, false);
  select * into step_row from public.provisioning_steps
  where tenant_id = p_expected_tenant and step_key = p_step_key for update;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_FOUND'; end if;
  if step_row.state <> p_expected_state or step_row.state <> 'failed' then
    raise exception 'PROVISIONING_RETRY_FORBIDDEN:%', step_row.state;
  end if;
  update public.provisioning_steps
  set state = 'pending', attempts = 0, next_attempt_at = now(),
      error_code = null, error_message = null, awaiting_party = null, blocked_reason = null,
      completed_at = null, lease_expires_at = null, attempt_id = null,
      last_transition_at = now(), updated_at = now()
  where id = step_row.id;
  logged_id := app.write_audit_row(
    'onboarding.step_retried', p_actor_id, p_expected_tenant,
    'provisioning_step', step_row.id::text, null,
    jsonb_build_object('step_key', p_step_key, 'prior_state', step_row.state)
  );
  return logged_id;
end;
$$;

create or replace function public.unblock_provisioning_step(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_actor_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.provisioning_steps%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, true);
  if nullif(btrim(p_reason), '') is null then raise exception 'PROVISIONING_UNBLOCK_REASON_REQUIRED'; end if;
  select * into step_row from public.provisioning_steps
  where tenant_id = p_expected_tenant and step_key = p_step_key for update;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_FOUND'; end if;
  if step_row.state <> 'blocked' then raise exception 'PROVISIONING_UNBLOCK_FORBIDDEN:%', step_row.state; end if;
  update public.provisioning_steps
  set state = 'pending', attempts = 0, next_attempt_at = now(),
      error_code = null, error_message = null, awaiting_party = null, blocked_reason = null,
      completed_at = null, lease_expires_at = null, attempt_id = null,
      last_transition_at = now(), updated_at = now()
  where id = step_row.id;
  logged_id := app.write_audit_row(
    'onboarding.step_unblocked', p_actor_id, p_expected_tenant,
    'provisioning_step', step_row.id::text, btrim(p_reason),
    jsonb_build_object('step_key', p_step_key, 'prior_reason', step_row.blocked_reason)
  );
  return logged_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Artifact, content-screen, consent, and probe receipts
-- ---------------------------------------------------------------------------

create or replace function public.confirm_onboarding_artifact(
  p_expected_tenant uuid,
  p_artifact_id uuid,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  artifact_row public.onboarding_optin_artifacts%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, false);
  select * into artifact_row from public.onboarding_optin_artifacts
  where id = p_artifact_id for update;
  if artifact_row.id is null then raise exception 'ONBOARDING_ARTIFACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, artifact_row.tenant_id, 'onboarding_artifact');
  if not artifact_row.is_current then raise exception 'ONBOARDING_ARTIFACT_NOT_CURRENT'; end if;
  if artifact_row.confirmed_at is not null then
    select id into logged_id from public.audit_log
    where action = 'onboarding.artifact_confirmed' and target_id = p_artifact_id::text
    order by id desc limit 1;
    return logged_id;
  end if;
  update public.onboarding_optin_artifacts
  set confirmed_at = now(), confirmed_by = p_actor_id
  where id = p_artifact_id;
  logged_id := app.write_audit_row(
    'onboarding.artifact_confirmed', p_actor_id, p_expected_tenant,
    'onboarding_optin_artifact', p_artifact_id::text, null,
    jsonb_build_object('version', artifact_row.version, 'placeholder', artifact_row.placeholder)
  );
  return logged_id;
end;
$$;

create or replace function public.acknowledge_onboarding_content_screen(
  p_expected_tenant uuid,
  p_screen_id uuid,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  screen_row public.onboarding_content_screens%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, false);
  select * into screen_row from public.onboarding_content_screens where id = p_screen_id for update;
  if screen_row.id is null then raise exception 'ONBOARDING_CONTENT_SCREEN_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, screen_row.tenant_id, 'content_screen');
  if not screen_row.is_current or screen_row.result <> 'flagged' then
    raise exception 'ONBOARDING_CONTENT_ACKNOWLEDGEMENT_FORBIDDEN';
  end if;
  if screen_row.acknowledged_at is not null then
    select id into logged_id from public.audit_log
    where action = 'onboarding.content_acknowledged' and target_id = p_screen_id::text
    order by id desc limit 1;
    return logged_id;
  end if;
  update public.onboarding_content_screens
  set acknowledged_at = now(), acknowledged_by = p_actor_id where id = p_screen_id;
  logged_id := app.write_audit_row(
    'onboarding.content_acknowledged', p_actor_id, p_expected_tenant,
    'onboarding_content_screen', p_screen_id::text, null,
    jsonb_build_object('input_hash', screen_row.input_hash)
  );
  return logged_id;
end;
$$;

create or replace function public.confirm_onboarding_content_screen(
  p_expected_tenant uuid,
  p_screen_id uuid,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  screen_row public.onboarding_content_screens%rowtype;
  logged_id bigint;
  filing_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, true);
  select * into screen_row from public.onboarding_content_screens where id = p_screen_id for update;
  if screen_row.id is null then raise exception 'ONBOARDING_CONTENT_SCREEN_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, screen_row.tenant_id, 'content_screen');
  if not screen_row.is_current or screen_row.result <> 'flagged'
    or screen_row.acknowledged_at is null then
    raise exception 'ONBOARDING_CONTENT_ADMIN_CONFIRMATION_FORBIDDEN';
  end if;
  if screen_row.admin_confirmed_at is not null then
    select id into logged_id from public.audit_log
    where action = 'onboarding.content_admin_confirmed' and target_id = p_screen_id::text
    order by id desc limit 1;
    return logged_id;
  end if;
  update public.onboarding_content_screens
  set admin_confirmed_at = now(), admin_confirmed_by = p_actor_id where id = p_screen_id;
  logged_id := app.write_audit_row(
    'onboarding.content_admin_confirmed', p_actor_id, p_expected_tenant,
    'onboarding_content_screen', p_screen_id::text, null,
    jsonb_build_object('input_hash', screen_row.input_hash)
  );
  filing_id := app.write_audit_row(
    'onboarding.a2p_filing_confirmed', p_actor_id, p_expected_tenant,
    'onboarding_content_screen', p_screen_id::text, null,
    jsonb_build_object('content_confirmation_audit_id', logged_id)
  );
  return filing_id;
end;
$$;

create or replace function public.record_web_form_consent(
  p_tenant_id uuid,
  p_contact_identity_id uuid,
  p_rendered_language text,
  p_page_url text,
  p_submitted_at timestamptz,
  p_purposes text[],
  p_evidence jsonb,
  p_expected_tenant_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity_row public.contact_identities%rowtype;
  evidence_keys text[];
  consent_state_value text;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_expected_tenant(p_expected_tenant_id, p_tenant_id, 'web_form_consent');
  select * into identity_row from public.contact_identities
  where id = p_contact_identity_id for update;
  if identity_row.id is null then raise exception 'CONSENT_IDENTITY_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant_id, identity_row.tenant_id, 'contact_identity');
  if nullif(btrim(p_rendered_language), '') is null or p_page_url !~ '^https://'
    or p_submitted_at is null or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' then
    raise exception 'CONSENT_EVIDENCE_INVALID';
  end if;

  select array_agg(key order by key) into evidence_keys from jsonb_object_keys(p_evidence) key;
  if evidence_keys is distinct from array[
    'channels', 'disclosureTextHash', 'disclosureVersion', 'formSubmissionId',
    'formUrl', 'purposes', 'schemaVersion', 'submittedAt'
  ]::text[] then
    raise exception 'CONSENT_EVIDENCE_INVALID';
  end if;
  if p_evidence ->> 'schemaVersion' <> '1'
    or p_evidence ->> 'formUrl' <> p_page_url
    or p_evidence ->> 'submittedAt' <> to_char(p_submitted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    or p_evidence ->> 'disclosureTextHash'
      <> encode(extensions.digest(convert_to(p_rendered_language, 'UTF8'), 'sha256'), 'hex')
    or jsonb_typeof(p_evidence -> 'purposes') <> 'array'
    or jsonb_typeof(p_evidence -> 'channels') <> 'array'
    or p_evidence -> 'purposes' <> to_jsonb(coalesce(p_purposes, '{}'::text[]))
    or exists (
      select 1 from jsonb_array_elements_text(p_evidence -> 'purposes') value
      where value not in (
        'agent_reply', 'follow_up', 'human_reply', 'stop_confirmation',
        'help_confirmation', 'start_confirmation'
      )
    )
    or exists (
      select 1 from jsonb_array_elements_text(p_evidence -> 'channels') value
      where value not in ('instagram', 'messenger', 'sms', 'whatsapp', 'webchat')
    ) then
    raise exception 'CONSENT_EVIDENCE_INVALID';
  end if;

  consent_state_value := case
    when 'follow_up' = any(coalesce(p_purposes, '{}'::text[])) then 'opted_in'
    when cardinality(coalesce(p_purposes, '{}'::text[])) > 0 then 'conversation'
    else 'none'
  end;
  update public.contact_identities
  set consent_state = consent_state_value,
      consent_source = 'web_form', consent_captured_at = p_submitted_at,
      consent_evidence = p_evidence, updated_at = now()
  where id = p_contact_identity_id;

  logged_id := app.write_audit_row(
    'consent.web_form_recorded', null, p_tenant_id, 'contact_identity',
    p_contact_identity_id::text, null,
    jsonb_build_object(
      'form_submission_id', p_evidence ->> 'formSubmissionId',
      'purposes', coalesce(p_purposes, '{}'::text[]),
      'selected', cardinality(coalesce(p_purposes, '{}'::text[])) > 0
    )
  );
  return logged_id;
end;
$$;

comment on function public.record_web_form_consent(
  uuid, uuid, text, text, timestamptz, text[], jsonb, uuid
) is
  'Phase 5 service boundary for Phase 3-validated hosted-form evidence. Phase 4 owns contact_identities; Phase 5 changes only its consent columns and never sends.';

create or replace function public.record_a2p_probe_receipt(
  p_expected_tenant uuid,
  p_probe_key text,
  p_target_identifier_hash text,
  p_result text,
  p_provider_reference text,
  p_provider_code text,
  p_observed_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_row public.a2p_probe_receipts%rowtype;
  receipt_id uuid;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null or nullif(btrim(p_probe_key), '') is null
    or p_target_identifier_hash !~ '^[0-9a-f]{64}$'
    or p_result not in ('inconclusive', 'retryable_failure', 'delivered', 'terminal_rejection')
    or p_observed_at is null then
    raise exception 'A2P_PROBE_RECEIPT_INVALID';
  end if;
  if p_result in ('delivered', 'terminal_rejection')
    and nullif(btrim(p_provider_reference), '') is null then
    raise exception 'A2P_PROBE_PROVIDER_REFERENCE_REQUIRED';
  end if;

  select * into receipt_row from public.a2p_probe_receipts
  where tenant_id = p_expected_tenant and probe_key = p_probe_key;
  if receipt_row.id is not null then
    if receipt_row.target_identifier_hash <> p_target_identifier_hash
      or receipt_row.result <> p_result
      or receipt_row.provider_reference is distinct from p_provider_reference
      or receipt_row.provider_code is distinct from p_provider_code
      or receipt_row.observed_at <> p_observed_at then
      raise exception 'A2P_PROBE_REPLAY_MISMATCH';
    end if;
    return receipt_row.id;
  end if;

  insert into public.a2p_probe_receipts (
    tenant_id, probe_key, target_identifier_hash, result,
    provider_reference, provider_code, observed_at
  ) values (
    p_expected_tenant, p_probe_key, p_target_identifier_hash, p_result,
    nullif(btrim(p_provider_reference), ''), nullif(btrim(p_provider_code), ''), p_observed_at
  ) returning id into receipt_id;
  return receipt_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Redacted platform tracker and transactional go-live authority
-- ---------------------------------------------------------------------------

create view public.provisioning_tracker_rows
with (security_invoker = true)
as
select
  intent.id as signup_intent_id,
  intent.tenant_id,
  tenant.name as business_name,
  intent.state::text as signup_state,
  step.step_key,
  coalesce(step.state::text, case when intent.state = 'failed' then 'failed' else 'pending' end) as state,
  coalesce(step.attempts, case when intent.state = 'failed' then 1 else 0 end) as attempts,
  coalesce(step.error_code, intent.error) as error_code,
  case
    when intent.tenant_id is null then 'system'
    when step.state = 'awaiting_coach' then 'coach'
    when step.state = 'awaiting_provider' then 'provider'
    when step.state in ('awaiting_platform', 'blocked') then 'platform'
    else 'system'
  end as blocking_party,
  case when step.awaiting_party in ('carrier', 'meta', 'google', 'ghl', 'stripe')
    then step.awaiting_party::text else null end as blocking_provider,
  coalesce(step.last_transition_at, intent.updated_at) as stalled_since
from public.signup_intents intent
left join public.tenants tenant on tenant.id = intent.tenant_id
left join lateral (
  select candidate.* from public.provisioning_steps candidate
  where candidate.tenant_id = intent.tenant_id and candidate.state <> 'done'
  order by
    case candidate.state
      when 'blocked' then 0 when 'failed' then 1 when 'awaiting_coach' then 2
      when 'awaiting_platform' then 3 when 'awaiting_provider' then 4 when 'running' then 5
      else 6
    end,
    candidate.last_transition_at,
    candidate.step_key
  limit 1
) step on true;

revoke all on public.provisioning_tracker_rows from public, anon, authenticated;
grant select on public.provisioning_tracker_rows to service_role;

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

  -- Condition one is intentionally proved against this transaction's own activation write.
  update public.tenants set status = 'active', updated_at = activated_at
  where id = p_expected_tenant;
  if not exists (
    select 1 from public.tenants tenant
    where tenant.id = p_expected_tenant and tenant.status = 'active'
  ) then
    raise exception 'READINESS_TENANT_ACTIVE_FAILED';
  end if;
  if not exists (
    select 1 from public.channel_connections connection
    where connection.tenant_id = p_expected_tenant and connection.state = 'live'
      and connection.channel in ('instagram', 'messenger', 'sms', 'whatsapp', 'webchat')
  ) then
    raise exception 'READINESS_MESSAGING_CHANNEL_LIVE_REQUIRED';
  end if;
  if not exists (
    select 1 from public.calendar_connections calendar
    where calendar.tenant_id = p_expected_tenant and calendar.is_primary
      and calendar.state = 'ready' and calendar.last_slot_fetch_ok
      and calendar.last_slot_fetch_at is not null
  ) then
    raise exception 'READINESS_PRIMARY_CALENDAR_HEALTHY_REQUIRED';
  end if;
  if not exists (
    select 1 from public.offer_layers offer
    where offer.tenant_id = p_expected_tenant and offer.status = 'published'
      and nullif(btrim(offer.program_name), '') is not null and offer.booking_mode is not null
  ) then
    raise exception 'READINESS_PUBLISHED_OFFER_REQUIRED';
  end if;
  if not p_offer_review_clear or p_offer_review_evidence_at is null
    or p_offer_review_evidence_at < now() - interval '15 minutes' then
    raise exception 'READINESS_OFFER_REVIEW_CLEAR_REQUIRED';
  end if;
  if not exists (select 1 from public.brain_snapshots) then
    raise exception 'READINESS_PLATFORM_BRAIN_PUBLISHED_REQUIRED';
  end if;
  if not exists (
    select 1 from public.provisioning_steps step
    where step.tenant_id = p_expected_tenant and step.step_key = 'test_pass' and step.state = 'done'
  ) then
    raise exception 'READINESS_TEST_PASS_REQUIRED';
  end if;
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

-- ---------------------------------------------------------------------------
-- 12. Service-only execution and final ownership documentation
-- ---------------------------------------------------------------------------

revoke execute on function app.assert_phase5_actor(uuid, uuid, boolean)
  from public, anon, authenticated;
revoke execute on function app.assert_a2p_filing_ready(uuid)
  from public, anon, authenticated;

revoke execute on function public.complete_onboarding_signup(
  uuid, uuid, text, text, text, text, uuid, text, text, boolean
) from public, anon, authenticated;
revoke execute on function public.claim_provisioning_step(
  uuid, public.provisioning_step, uuid, int
) from public, anon, authenticated;
revoke execute on function public.transition_provisioning_step(
  uuid, public.provisioning_step, uuid, public.provisioning_state,
  public.awaiting_party, text, text, jsonb, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.complete_provisioning_step(
  uuid, public.provisioning_step, uuid, jsonb
) from public, anon, authenticated;
revoke execute on function public.fail_provisioning_step(
  uuid, public.provisioning_step, uuid, text, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.retry_provisioning_step(
  uuid, public.provisioning_step, uuid, public.provisioning_state
) from public, anon, authenticated;
revoke execute on function public.unblock_provisioning_step(
  uuid, public.provisioning_step, uuid, text
) from public, anon, authenticated;
revoke execute on function public.confirm_onboarding_artifact(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.acknowledge_onboarding_content_screen(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.confirm_onboarding_content_screen(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.record_web_form_consent(
  uuid, uuid, text, text, timestamptz, text[], jsonb, uuid
) from public, anon, authenticated;
revoke execute on function public.record_a2p_probe_receipt(
  uuid, text, text, text, text, text, timestamptz
) from public, anon, authenticated;
revoke execute on function public.go_live_onboarding(
  uuid, uuid, boolean, timestamptz, text, timestamptz
) from public, anon, authenticated;

grant execute on function public.complete_onboarding_signup(
  uuid, uuid, text, text, text, text, uuid, text, text, boolean
) to service_role;
grant execute on function public.claim_provisioning_step(
  uuid, public.provisioning_step, uuid, int
) to service_role;
grant execute on function public.transition_provisioning_step(
  uuid, public.provisioning_step, uuid, public.provisioning_state,
  public.awaiting_party, text, text, jsonb, text, timestamptz
) to service_role;
grant execute on function public.complete_provisioning_step(
  uuid, public.provisioning_step, uuid, jsonb
) to service_role;
grant execute on function public.fail_provisioning_step(
  uuid, public.provisioning_step, uuid, text, text, timestamptz
) to service_role;
grant execute on function public.retry_provisioning_step(
  uuid, public.provisioning_step, uuid, public.provisioning_state
) to service_role;
grant execute on function public.unblock_provisioning_step(
  uuid, public.provisioning_step, uuid, text
) to service_role;
grant execute on function public.confirm_onboarding_artifact(uuid, uuid, uuid)
  to service_role;
grant execute on function public.acknowledge_onboarding_content_screen(uuid, uuid, uuid)
  to service_role;
grant execute on function public.confirm_onboarding_content_screen(uuid, uuid, uuid)
  to service_role;
grant execute on function public.record_web_form_consent(
  uuid, uuid, text, text, timestamptz, text[], jsonb, uuid
) to service_role;
grant execute on function public.record_a2p_probe_receipt(
  uuid, text, text, text, text, text, timestamptz
) to service_role;
grant execute on function public.go_live_onboarding(
  uuid, uuid, boolean, timestamptz, text, timestamptz
) to service_role;

comment on table public.business_profiles is
  'Phase 5 filing facts only. EIN presence is stored; an EIN or OTP value is never stored here.';
comment on table public.onboarding_optin_artifacts is
  'Versioned hosted consent, terms, privacy, and campaign-description evidence. Placeholder rows cannot file.';
comment on table public.onboarding_content_screens is
  'Deterministic carrier-content screen evidence; a flagged current hash requires coach acknowledgement and platform confirmation.';
comment on table public.a2p_probe_receipts is
  'Append-only normalized owned-target probe evidence. Target identifiers are one-way hashes and raw provider payloads are forbidden.';

do $$
begin
  if exists (
    select 1 from public.onboarding_optin_artifacts
    group by tenant_id having count(*) filter (where is_current) > 1
  ) or exists (
    select 1 from public.onboarding_content_screens
    group by tenant_id having count(*) filter (where is_current) > 1
  ) then
    raise exception 'PHASE5_CURRENT_EVIDENCE_REMEDIATION_REQUIRED';
  end if;
end
$$;
