-- SetterFi Phase 5 read projections required by the public, coach, and platform onboarding
-- surfaces. These functions expose only the evidence each caller needs, preserve the existing
-- service-role mutation boundaries, and do not read or change any Phase 6 object.

set search_path = public, extensions;

-- Terms and privacy previously had URLs but no rendered body custody. Nullable forward columns
-- keep existing rows unavailable until a producer persists the exact body and matching hash.
alter table public.onboarding_optin_artifacts
  add column terms_body text,
  add column terms_body_hash text,
  add column privacy_body text,
  add column privacy_body_hash text,
  add constraint onboarding_optin_artifacts_terms_body_chk check (
    (terms_body is null and terms_body_hash is null)
    or (
      nullif(btrim(terms_body), '') is not null
      and terms_body_hash ~ '^[0-9a-f]{64}$'
      and terms_body_hash = encode(
        extensions.digest(convert_to(terms_body, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  ),
  add constraint onboarding_optin_artifacts_privacy_body_chk check (
    (privacy_body is null and privacy_body_hash is null)
    or (
      nullif(btrim(privacy_body), '') is not null
      and privacy_body_hash ~ '^[0-9a-f]{64}$'
      and privacy_body_hash = encode(
        extensions.digest(convert_to(privacy_body, 'UTF8'), 'sha256'),
        'hex'
      )
    )
  );

create or replace function public.list_signup_tier_catalog()
returns table (id uuid, label text)
language sql
stable
security definer
set search_path = ''
as $$
  select tier.id, tier.name as label
  from public.tiers tier
  where tier.active
  order by lower(tier.name), tier.id;
$$;

create or replace function public.read_self_signup_intent()
returns table (
  intent_id uuid,
  state text,
  tenant_id uuid,
  error_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select intent.id, intent.state::text, intent.tenant_id, intent.error
  from public.signup_intents intent
  where intent.auth_user_id = app.current_user_id();
$$;

create or replace function public.read_hosted_onboarding_artifact(
  p_tenant_slug text,
  p_page text
)
returns table (
  artifact_id uuid,
  version int,
  template_version text,
  tenant_slug text,
  business_name text,
  is_demo boolean,
  marketing_language text,
  marketing_language_hash text,
  non_marketing_language text,
  non_marketing_language_hash text,
  terms_body text,
  terms_body_hash text,
  privacy_body text,
  privacy_body_hash text,
  terms_url text,
  privacy_url text,
  campaign_description_hash text,
  artifact_hash text,
  placeholder boolean,
  confirmed_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    artifact.id,
    artifact.version,
    artifact.template_version,
    tenant.slug,
    tenant.name,
    tenant.is_demo,
    artifact.marketing_language,
    artifact.marketing_language_hash,
    artifact.non_marketing_language,
    artifact.non_marketing_language_hash,
    artifact.terms_body,
    artifact.terms_body_hash,
    artifact.privacy_body,
    artifact.privacy_body_hash,
    artifact.terms_url,
    artifact.privacy_url,
    artifact.campaign_description_hash,
    artifact.artifact_hash,
    artifact.placeholder,
    artifact.confirmed_at
  from public.tenants tenant
  join public.onboarding_optin_artifacts artifact on artifact.tenant_id = tenant.id
  where tenant.slug = lower(btrim(p_tenant_slug))
    and tenant.status = 'active'
    and artifact.is_current
    and artifact.confirmed_at is not null
    and p_page in ('consent', 'terms', 'privacy')
    and (not artifact.placeholder or tenant.is_demo)
    and (
      p_page = 'consent'
      or (p_page = 'terms' and artifact.terms_body is not null)
      or (p_page = 'privacy' and artifact.privacy_body is not null)
    )
    and (
      tenant.is_demo
      or (
        artifact.marketing_language not like '%SETTERFI_DEMO_PLACEHOLDER_%'
        and artifact.non_marketing_language not like '%SETTERFI_DEMO_PLACEHOLDER_%'
        and coalesce(artifact.terms_body, '') not like '%SETTERFI_DEMO_PLACEHOLDER_%'
        and coalesce(artifact.privacy_body, '') not like '%SETTERFI_DEMO_PLACEHOLDER_%'
      )
    );
$$;

create or replace function public.read_coach_a2p_registration(
  p_expected_tenant uuid
)
returns table (
  submitted_at timestamptz,
  registration_state text,
  terminal_rejection boolean,
  terminal_code text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  sms_row public.provisioning_steps%rowtype;
  campaign_row public.provisioning_steps%rowtype;
  receipt_result text;
  receipt_code text;
  submitted_value text;
begin
  perform app.assert_not_impersonating();
  select * into sms_row
  from public.provisioning_steps step
  where step.tenant_id = p_expected_tenant and step.step_key = 'sms_live';
  if sms_row.id is null then return; end if;
  perform app.assert_expected_tenant(p_expected_tenant, sms_row.tenant_id, 'coach_a2p_registration');

  select * into campaign_row
  from public.provisioning_steps step
  where step.tenant_id = p_expected_tenant and step.step_key = 'a2p_campaign';
  submitted_value := coalesce(
    campaign_row.external_ref ->> 'submittedAt',
    campaign_row.external_ref ->> 'submitted_at'
  );

  select receipt.result, receipt.provider_code
  into receipt_result, receipt_code
  from public.a2p_probe_receipts receipt
  where receipt.tenant_id = p_expected_tenant
  order by receipt.observed_at desc, receipt.created_at desc
  limit 1;

  return query select
    case
      when submitted_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then submitted_value::timestamptz
      else null
    end,
    sms_row.state::text,
    sms_row.state = 'blocked' or coalesce(receipt_result = 'terminal_rejection', false),
    case
      when not (
        sms_row.state = 'blocked' or coalesce(receipt_result = 'terminal_rejection', false)
      ) then null
      when coalesce(sms_row.error_code, receipt_code, '') ~ '^[A-Za-z0-9_.:-]{1,100}$'
        then coalesce(sms_row.error_code, receipt_code)
      else 'A2P_TERMINAL_REJECTION'
    end;
end;
$$;

-- Existing columns remain byte-for-byte and in the same order so CREATE OR REPLACE can append the
-- classification and confirmation evidence without invalidating service-role consumers.
create or replace view public.provisioning_tracker_rows
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
  coalesce(step.last_transition_at, intent.updated_at) as stalled_since,
  tenant.is_demo,
  content_screen.id as content_screen_id,
  case
    when content_screen.id is null then null
    when content_screen.result = 'clean' then 'clean'
    when content_screen.admin_confirmed_at is not null then 'confirmed'
    when content_screen.acknowledged_at is not null then 'awaiting_admin'
    else 'flagged'
  end as content_screen_state
from public.signup_intents intent
left join public.tenants tenant on tenant.id = intent.tenant_id
left join public.onboarding_content_screens content_screen
  on content_screen.tenant_id = intent.tenant_id and content_screen.is_current
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

revoke execute on function public.list_signup_tier_catalog() from public, anon, authenticated;
grant execute on function public.list_signup_tier_catalog() to anon, authenticated;

revoke execute on function public.read_self_signup_intent() from public, anon, authenticated;
grant execute on function public.read_self_signup_intent() to authenticated;

revoke execute on function public.read_hosted_onboarding_artifact(text, text)
  from public, anon, authenticated;
grant execute on function public.read_hosted_onboarding_artifact(text, text)
  to anon, authenticated;

revoke execute on function public.read_coach_a2p_registration(uuid)
  from public, anon, authenticated;
grant execute on function public.read_coach_a2p_registration(uuid) to service_role;

comment on function public.list_signup_tier_catalog() is
  'Public non-economic signup choices. Offerability follows tiers.active and no price or allowance column is returned.';
comment on function public.read_self_signup_intent() is
  'Authenticated self-only signup status derived from the verified JWT subject.';
comment on function public.read_hosted_onboarding_artifact(text, text) is
  'Public confirmed current artifact envelope for an active tenant slug. Non-demo placeholder bodies are excluded.';
comment on function public.read_coach_a2p_registration(uuid) is
  'Service-only coach-safe registration clock and terminal classification projection scoped by expected tenant.';
