-- Coach-owned onboarding inputs. Browser roles remain read-only: the route layer uses the
-- service role to invoke these audited RPCs after deriving both actor and tenant from claims.

set search_path = public, extensions;

do $$
begin
  if to_regclass('public.business_profiles') is null
    or to_regclass('public.calendar_connections') is null
    or to_regclass('public.audit_actions') is null
    or to_regprocedure('app.assert_not_impersonating()') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid,text,inet)') is null then
    raise exception 'ONBOARDING_COACH_WRITE_PREREQUISITES_MISSING';
  end if;
end
$$;

-- An authorization receipt is represented by its SHA-256 fingerprint. OAuth codes and provider
-- receipts can be credentials, so neither the table nor the audit trail stores their plaintext.
alter table public.calendar_connections
  enable row level security,
  force row level security,
  add column external_account_reference text,
  add column authorization_receipt_hash text,
  add column authorized_at timestamptz,
  add column authorized_by uuid references public.users(id),
  add constraint calendar_connections_authorization_receipt_chk check (
    (external_account_reference is null
      and authorization_receipt_hash is null
      and authorized_at is null
      and authorized_by is null)
    or (
      nullif(btrim(external_account_reference), '') is not null
      and authorization_receipt_hash ~ '^[0-9a-f]{64}$'
      and authorized_at is not null
      and authorized_by is not null
    )
  );

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('onboarding.business_profile.saved', 'human', 'tenant', false, true,
    'Business profile save logged', 'Business profile save recorded in the audit log'),
  ('onboarding.calendar_authorization.recorded', 'human', 'tenant', false, true,
    'Calendar authorization logged', 'Calendar authorization receipt recorded in the audit log')
on conflict (key) do nothing;

create or replace function app.assert_onboarding_coach(
  p_actor_id uuid,
  p_expected_tenant uuid
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
  if p_actor_id is null or p_expected_tenant is null then
    raise exception 'ONBOARDING_COACH_SCOPE_REQUIRED';
  end if;
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role <> 'coach'
    or actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'ONBOARDING_COACH_TENANT_FORBIDDEN';
  end if;
end;
$$;

create or replace function public.save_onboarding_business_profile(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_legal_name text,
  p_entity_type text,
  p_has_ein boolean,
  p_website_url text,
  p_address_line1 text,
  p_address_line2 text,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country_code text
)
returns table (
  profile_id uuid,
  audit_id bigint,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved public.business_profiles%rowtype;
  logged_id bigint;
  entity text := lower(btrim(coalesce(p_entity_type, '')));
  country text := upper(btrim(coalesce(p_country_code, '')));
begin
  perform app.assert_not_impersonating();
  perform app.assert_onboarding_coach(p_actor_id, p_expected_tenant);
  if nullif(btrim(p_legal_name), '') is null
    or entity not in ('sole_proprietor', 'llc', 'corporation', 'partnership', 'other')
    or p_has_ein is null
    or nullif(btrim(p_website_url), '') is null or btrim(p_website_url) !~ '^https://'
    or nullif(btrim(p_address_line1), '') is null
    or nullif(btrim(p_city), '') is null
    or nullif(btrim(p_region), '') is null
    or nullif(btrim(p_postal_code), '') is null
    or country !~ '^[A-Z]{2}$' then
    raise exception 'ONBOARDING_BUSINESS_PROFILE_INVALID';
  end if;
  if entity in ('llc', 'corporation') and not p_has_ein then
    raise exception 'BUSINESS_PROFILES_ENTITY_EIN_REQUIRED';
  end if;

  insert into public.business_profiles (
    tenant_id, legal_name, entity_type, has_ein, website_url, address_line1,
    address_line2, city, region, postal_code, country_code
  ) values (
    p_expected_tenant, btrim(p_legal_name), entity, p_has_ein, btrim(p_website_url),
    btrim(p_address_line1), nullif(btrim(coalesce(p_address_line2, '')), ''),
    btrim(p_city), btrim(p_region), btrim(p_postal_code), country
  ) on conflict (tenant_id) do update set
    legal_name = excluded.legal_name,
    entity_type = excluded.entity_type,
    has_ein = excluded.has_ein,
    website_url = excluded.website_url,
    address_line1 = excluded.address_line1,
    address_line2 = excluded.address_line2,
    city = excluded.city,
    region = excluded.region,
    postal_code = excluded.postal_code,
    country_code = excluded.country_code
  returning * into saved;

  logged_id := app.write_audit_row(
    'onboarding.business_profile.saved', p_actor_id, p_expected_tenant,
    'business_profile', saved.id::text, null,
    jsonb_build_object('entity_type', saved.entity_type, 'has_ein', saved.has_ein)
  );
  return query select saved.id, logged_id, saved.updated_at;
end;
$$;

create or replace function public.record_onboarding_calendar_authorization(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_provider public.calendar_provider,
  p_external_account_reference text,
  p_external_calendar_id text,
  p_calendar_name text,
  p_timezone text,
  p_authorization_receipt_hash text
)
returns table (
  calendar_connection_id uuid,
  audit_id bigint,
  state public.calendar_connection_state,
  authorized_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  saved public.calendar_connections%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_onboarding_coach(p_actor_id, p_expected_tenant);
  if p_provider is null
    or nullif(btrim(p_external_account_reference), '') is null
    or nullif(btrim(p_external_calendar_id), '') is null
    or nullif(btrim(p_timezone), '') is null
    or p_authorization_receipt_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ONBOARDING_CALENDAR_AUTHORIZATION_INVALID';
  end if;
  if not exists (select 1 from pg_timezone_names where name = btrim(p_timezone)) then
    raise exception 'ONBOARDING_CALENDAR_TIMEZONE_INVALID';
  end if;

  -- A provider receipt proves authorization, not availability. A later slot fetch alone may
  -- move this row to ready, so this form can never manufacture a bookable calendar.
  update public.calendar_connections
  set is_primary = false, updated_at = now()
  where tenant_id = p_expected_tenant
    and is_primary
    and not (provider = p_provider and external_calendar_id = btrim(p_external_calendar_id));

  insert into public.calendar_connections (
    tenant_id, provider, external_calendar_id, calendar_name, timezone, state, is_primary,
    external_account_reference, authorization_receipt_hash, authorized_at, authorized_by
  ) values (
    p_expected_tenant, p_provider, btrim(p_external_calendar_id),
    nullif(btrim(coalesce(p_calendar_name, '')), ''), btrim(p_timezone), 'connecting', true,
    btrim(p_external_account_reference), p_authorization_receipt_hash, now(), p_actor_id
  ) on conflict (tenant_id, provider, external_calendar_id) do update set
    calendar_name = excluded.calendar_name,
    timezone = excluded.timezone,
    is_primary = true,
    external_account_reference = excluded.external_account_reference,
    authorization_receipt_hash = excluded.authorization_receipt_hash,
    authorized_at = excluded.authorized_at,
    authorized_by = excluded.authorized_by,
    state = case when public.calendar_connections.state = 'ready'
      then 'ready'::public.calendar_connection_state else 'connecting'::public.calendar_connection_state end,
    updated_at = now()
  returning * into saved;

  logged_id := app.write_audit_row(
    'onboarding.calendar_authorization.recorded', p_actor_id, p_expected_tenant,
    'calendar_connection', saved.id::text, null,
    jsonb_build_object(
      'provider', saved.provider::text,
      'external_calendar_id', saved.external_calendar_id,
      'authorization_receipt_hash', saved.authorization_receipt_hash
    )
  );
  return query select saved.id, logged_id, saved.state, saved.authorized_at;
end;
$$;

revoke all on function app.assert_onboarding_coach(uuid, uuid) from public, anon, authenticated;
revoke all on function public.save_onboarding_business_profile(
  uuid, uuid, text, text, boolean, text, text, text, text, text, text, text
) from public, anon, authenticated;
revoke all on function public.record_onboarding_calendar_authorization(
  uuid, uuid, public.calendar_provider, text, text, text, text, text
) from public, anon, authenticated;

grant execute on function public.save_onboarding_business_profile(
  uuid, uuid, text, text, boolean, text, text, text, text, text, text, text
) to service_role;
grant execute on function public.record_onboarding_calendar_authorization(
  uuid, uuid, public.calendar_provider, text, text, text, text, text
) to service_role;

comment on column public.calendar_connections.authorization_receipt_hash is
  'SHA-256 fingerprint of the provider-issued authorization receipt; raw OAuth codes and receipts are never stored.';
