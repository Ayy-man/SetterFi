-- Operator recovery for interrupted Auth-to-tenant signup. This command is deliberately
-- separate from platform_operator_commands because an Auth identity may have no tenant yet.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('onboarding.signup.repair.resumed', 'human', 'platform', true, false, 'Signup repair logged', 'Signup repair recorded in the audit log'),
  ('onboarding.signup.repair.already_healthy', 'human', 'platform', true, false, 'Signup repair check logged', 'Already healthy signup check recorded in the audit log'),
  ('onboarding.signup.repair.cannot_resume', 'human', 'platform', true, false, 'Signup repair refusal logged', 'Signup repair refusal recorded in the audit log')
on conflict (key) do nothing;

create table public.signup_repair_commands (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null,
  signup_intent_id uuid references public.signup_intents(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  state text not null check (state in ('resumed', 'already_healthy', 'cannot_resume')),
  outcome_code text,
  reason text not null check (nullif(btrim(reason), '') is not null),
  actor_id uuid not null references public.users(id),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint signup_repair_command_outcome_chk check (
    (state = 'cannot_resume') = (nullif(btrim(outcome_code), '') is not null)
  )
);
create index signup_repair_commands_auth_created_idx
  on public.signup_repair_commands (auth_user_id, created_at desc);

alter table public.signup_repair_commands enable row level security;
alter table public.signup_repair_commands force row level security;
revoke all on public.signup_repair_commands from public, anon, authenticated, service_role;

create or replace function public.repair_onboarding_signup(
  p_expected_auth_user_id uuid,
  p_expected_tenant uuid,
  p_email text,
  p_full_name text,
  p_business_name text,
  p_slug text,
  p_tier_id uuid,
  p_timezone text,
  p_actor_id uuid,
  p_reason text
)
returns table (
  command_id uuid,
  intent_id uuid,
  tenant_id uuid,
  state text,
  outcome_code text,
  audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  intent_row public.signup_intents%rowtype;
  tenant_row public.tenants%rowtype;
  existing_user public.users%rowtype;
  actor_role public.user_role;
  auth_email text;
  completion record;
  command_row public.signup_repair_commands%rowtype;
  logged_id bigint;
  result_state text := 'cannot_resume';
  result_code text := null;
  audit_action text;
  tenant_for_audit uuid := null;
  tenant_is_expected boolean := false;
begin
  perform app.assert_not_impersonating();
  if p_expected_auth_user_id is null or p_actor_id is null or nullif(btrim(p_reason), '') is null then
    raise exception 'SIGNUP_REPAIR_REQUIRED_FIELD_MISSING';
  end if;
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role not in ('owner', 'admin') then raise exception 'SIGNUP_REPAIR_ACTOR_FORBIDDEN'; end if;

  select lower(email) into auth_email from auth.users where id = p_expected_auth_user_id;
  if auth_email is null then
    result_code := 'AUTH_IDENTITY_NOT_FOUND';
  elsif nullif(btrim(p_email), '') is null or lower(btrim(p_email)) <> auth_email then
    result_code := 'AUTH_EMAIL_MISMATCH';
  else
    select * into intent_row
    from public.signup_intents
    where auth_user_id = p_expected_auth_user_id
    for update;

    -- Auth can be created before the browser reaches durable intent persistence. A new intent
    -- only receives verified account details; referral and affiliate consent are never inferred.
    if intent_row.id is null then
      select * into existing_user from public.users where id = p_expected_auth_user_id for update;
      if existing_user.id is not null and existing_user.tenant_id is not null then
        result_code := 'AUTH_IDENTITY_ALREADY_ATTACHED';
        tenant_for_audit := existing_user.tenant_id;
      elsif nullif(btrim(p_full_name), '') is null or nullif(btrim(p_business_name), '') is null
        or nullif(btrim(p_slug), '') is null or p_tier_id is null
        or nullif(btrim(p_timezone), '') is null
        or not exists (select 1 from pg_timezone_names where name = p_timezone)
        or not exists (select 1 from public.tiers where id = p_tier_id and active) then
        result_code := 'SIGNUP_DETAILS_REQUIRED';
      else
        insert into public.signup_intents (auth_user_id, email, tier_id, timezone, referral_code, state, error)
        values (p_expected_auth_user_id, auth_email, p_tier_id, btrim(p_timezone), null, 'started', null);
        select * into intent_row
        from public.signup_intents
        where auth_user_id = p_expected_auth_user_id
        for update;
      end if;
    end if;

    if intent_row.id is not null and result_code is null then
      if intent_row.state = 'completed' then
        if intent_row.tenant_id is null then
          result_code := 'COMPLETED_INTENT_TENANT_MISSING';
        elsif p_expected_tenant is null then
          result_code := 'EXPECTED_TENANT_REQUIRED';
          tenant_for_audit := intent_row.tenant_id;
        else
          begin
            perform app.assert_expected_tenant(p_expected_tenant, intent_row.tenant_id, 'signup_repair_completed');
            tenant_is_expected := true;
          exception when others then
            result_code := 'EXPECTED_TENANT_MISMATCH';
          end;
          tenant_for_audit := intent_row.tenant_id;
          select * into existing_user from public.users where id = p_expected_auth_user_id;
          if result_code is null and existing_user.tenant_id is distinct from intent_row.tenant_id then
            result_code := 'COMPLETED_IDENTITY_MAPPING_INVALID';
          elsif result_code is null then
            result_state := 'already_healthy';
          end if;
        end if;
      elsif intent_row.tenant_id is not null then
        -- A legacy partial completion can be resumed only against the caller's explicit tenant.
        -- The tenant's immutable signup facts must still agree with the original intent.
        tenant_for_audit := intent_row.tenant_id;
        if p_expected_tenant is null then
          result_code := 'EXPECTED_TENANT_REQUIRED';
        else
          begin
            perform app.assert_expected_tenant(p_expected_tenant, intent_row.tenant_id, 'signup_repair_intent');
            tenant_is_expected := true;
          exception when others then
            result_code := 'EXPECTED_TENANT_MISMATCH';
          end;
        end if;
        if result_code is null then
          select * into tenant_row from public.tenants where id = intent_row.tenant_id for update;
          if tenant_row.id is null then
            result_code := 'INTENT_TENANT_NOT_FOUND';
          elsif tenant_row.tier_id is distinct from intent_row.tier_id
            or lower(coalesce(tenant_row.billing_contact_email, '')) <> lower(intent_row.email) then
            result_code := 'INTENT_TENANT_DETAILS_MISMATCH';
          elsif intent_row.referral_code is not null then
            -- Attribution is immutable. Do not create or guess it while repairing a legacy row.
            result_code := 'REFERRAL_STATE_REQUIRES_REVIEW';
          else
            select * into existing_user from public.users where id = p_expected_auth_user_id for update;
            if existing_user.id is not null and existing_user.tenant_id is not null
              and existing_user.tenant_id is distinct from intent_row.tenant_id then
              result_code := 'AUTH_IDENTITY_ALREADY_ATTACHED';
            else
              insert into public.tenant_settings (tenant_id, timezone)
              values (intent_row.tenant_id, intent_row.timezone)
              on conflict (tenant_id) do nothing;
              insert into public.onboarding_runs (tenant_id) values (intent_row.tenant_id)
              on conflict (tenant_id) do nothing;
              insert into public.provisioning_steps (
                tenant_id, step_key, state, awaiting_party, completed_at, next_attempt_at,
                last_transition_at, idempotency_key
              )
              select intent_row.tenant_id, step_key::public.provisioning_step,
                case when step_key = 'account' then 'done'::public.provisioning_state
                  when step_key = 'billing' then 'awaiting_platform'::public.provisioning_state
                  else 'pending'::public.provisioning_state end,
                null::public.awaiting_party,
                case when step_key = 'account' then now() else null end,
                now(), now(), intent_row.tenant_id::text || ':' || step_key
              from unnest(array[
                'account', 'billing', 'ghl_location', 'ghl_snapshot', 'phone_number',
                'sms_eligibility_screen', 'business_profile', 'optin_artifact', 'a2p_brand',
                'a2p_campaign', 'sms_live', 'meta_connect', 'whatsapp_connect',
                'calendar_connect', 'offer_layer', 'test_pass', 'go_live'
              ]) step_key
              on conflict on constraint provisioning_steps_tenant_id_step_key_key do nothing;
              if existing_user.id is null then
                insert into public.users (id, email, full_name, role, tenant_id)
                values (p_expected_auth_user_id, auth_email, nullif(btrim(p_full_name), ''), 'coach', intent_row.tenant_id);
              elsif existing_user.tenant_id is null and existing_user.role = 'affiliate' then
                update public.users set role = 'coach', tenant_id = intent_row.tenant_id,
                  email = auth_email, full_name = nullif(btrim(p_full_name), ''), updated_at = now()
                where id = p_expected_auth_user_id;
              elsif existing_user.tenant_id is null then
                result_code := 'AUTH_IDENTITY_ROLE_REQUIRES_REVIEW';
              end if;
              if result_code is null then
                update public.signup_intents set state = 'completed', error = null, updated_at = now()
                where id = intent_row.id;
                perform app.write_audit_row(
                  'onboarding.signup_completed', p_expected_auth_user_id, intent_row.tenant_id,
                  'onboarding_run', (select id::text from public.onboarding_runs where tenant_id = intent_row.tenant_id),
                  null, jsonb_build_object('repair', true, 'referral_result', 'unverified_not_created')
                );
                result_state := 'resumed';
              end if;
            end if;
          end if;
        end if;
      else
        -- Tenantless interrupted attempts can only resume with their exact durable intent facts.
        if nullif(btrim(p_full_name), '') is null or nullif(btrim(p_business_name), '') is null
          or nullif(btrim(p_slug), '') is null
          or p_tier_id is distinct from intent_row.tier_id
          or btrim(p_timezone) is distinct from intent_row.timezone then
          result_code := 'INTENT_DETAILS_REQUIRED';
        else
          begin
            select * into completion from public.complete_onboarding_signup(
              p_expected_auth_user_id, p_expected_auth_user_id, intent_row.email,
              btrim(p_full_name), btrim(p_business_name), lower(btrim(p_slug)), intent_row.tier_id,
              intent_row.timezone, intent_row.referral_code, false
            );
            tenant_for_audit := completion.tenant_id;
            result_state := case when completion.replayed then 'already_healthy' else 'resumed' end;
          exception when others then
            update public.signup_intents set state = 'failed', error = 'SIGNUP_REPAIR_COMPLETION_REFUSED', updated_at = now()
            where id = intent_row.id and tenant_id is null and state <> 'completed';
            result_code := 'SIGNUP_COMPLETION_REFUSED';
          end;
        end if;
      end if;
    end if;
  end if;

  if result_state = 'resumed' then
    audit_action := 'onboarding.signup.repair.resumed';
  elsif result_state = 'already_healthy' then
    audit_action := 'onboarding.signup.repair.already_healthy';
  else
    audit_action := 'onboarding.signup.repair.cannot_resume';
  end if;
  logged_id := app.write_audit_row(
    audit_action, p_actor_id, tenant_for_audit, 'signup_intent',
    coalesce(intent_row.id::text, p_expected_auth_user_id::text), btrim(p_reason),
    jsonb_strip_nulls(jsonb_build_object(
      'command', 'signup_repair', 'state', result_state, 'outcome_code', result_code,
      'expected_tenant_asserted', tenant_is_expected
    )), case when exists (select 1 from public.users where id = p_expected_auth_user_id)
      then p_expected_auth_user_id else null end
  );
  insert into public.signup_repair_commands (
    auth_user_id, signup_intent_id, tenant_id, state, outcome_code, reason, actor_id, audit_id
  ) values (
    p_expected_auth_user_id, intent_row.id, tenant_for_audit, result_state,
    case when result_state = 'cannot_resume' then result_code else null end,
    btrim(p_reason), p_actor_id, logged_id
  ) returning * into command_row;
  return query select command_row.id, intent_row.id, tenant_for_audit, result_state,
    case when result_state = 'cannot_resume' then result_code else null end, logged_id;
end;
$$;

revoke execute on function public.repair_onboarding_signup(
  uuid, uuid, text, text, text, text, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.repair_onboarding_signup(
  uuid, uuid, text, text, text, text, uuid, text, uuid, text
) to service_role;
