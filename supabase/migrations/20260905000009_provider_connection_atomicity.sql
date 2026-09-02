-- Provider readiness cannot become visible before its credential custody and evidence commit.

create or replace function app.credential_envelope_valid(p_envelope jsonb)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  iv_text text;
  ciphertext_text text;
  tag_text text;
  iv_bytes bytea;
  ciphertext_bytes bytea;
  tag_bytes bytea;
begin
  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object'
    or (select count(*) from jsonb_object_keys(p_envelope)) <> 6
    or not (p_envelope ?& array['version', 'keyVersion', 'algorithm', 'iv', 'ciphertext', 'tag'])
    or jsonb_typeof(p_envelope -> 'version') <> 'number'
    or jsonb_typeof(p_envelope -> 'keyVersion') <> 'number'
    or jsonb_typeof(p_envelope -> 'algorithm') <> 'string'
    or jsonb_typeof(p_envelope -> 'iv') <> 'string'
    or jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'
    or jsonb_typeof(p_envelope -> 'tag') <> 'string'
    or p_envelope -> 'version' <> '1'::jsonb
    or p_envelope -> 'keyVersion' <> '1'::jsonb
    or p_envelope ->> 'algorithm' <> 'A256GCM' then
    return false;
  end if;
  iv_text := p_envelope ->> 'iv';
  ciphertext_text := p_envelope ->> 'ciphertext';
  tag_text := p_envelope ->> 'tag';
  if iv_text !~ '^[A-Za-z0-9_-]{16}$'
    or ciphertext_text !~ '^[A-Za-z0-9_-]+$'
    or length(ciphertext_text) % 4 = 1
    or tag_text !~ '^[A-Za-z0-9_-]{22}$' then
    return false;
  end if;
  begin
    iv_bytes := decode(translate(iv_text, '-_', '+/') ||
      repeat('=', (4 - length(iv_text) % 4) % 4), 'base64');
    ciphertext_bytes := decode(translate(ciphertext_text, '-_', '+/') ||
      repeat('=', (4 - length(ciphertext_text) % 4) % 4), 'base64');
    tag_bytes := decode(translate(tag_text, '-_', '+/') ||
      repeat('=', (4 - length(tag_text) % 4) % 4), 'base64');
  exception when others then
    return false;
  end;
  return octet_length(iv_bytes) = 12
    and octet_length(ciphertext_bytes) > 0
    and octet_length(tag_bytes) = 16
    and translate(rtrim(regexp_replace(encode(iv_bytes, 'base64'), '\s', '', 'g'), '='), '+/', '-_') = iv_text
    and translate(rtrim(regexp_replace(encode(ciphertext_bytes, 'base64'), '\s', '', 'g'), '='), '+/', '-_') = ciphertext_text
    and translate(rtrim(regexp_replace(encode(tag_bytes, 'base64'), '\s', '', 'g'), '='), '+/', '-_') = tag_text;
end;
$$;

create or replace function public.persist_ghl_install_credentials_atomic(
  p_expected_tenant uuid,
  p_location_id text,
  p_company_id text,
  p_token_expires_at timestamptz,
  p_access_credential_envelope jsonb,
  p_refresh_credential_envelope jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.ghl_installs%rowtype;
  install_id uuid;
begin
  if p_expected_tenant is null
    or nullif(btrim(p_location_id), '') is null
    or nullif(btrim(p_company_id), '') is null
    or p_token_expires_at is null
    or not app.credential_envelope_valid(p_access_credential_envelope)
    or not app.credential_envelope_valid(p_refresh_credential_envelope) then
    raise exception 'GHL_INSTALL_ATOMIC_INPUT_INVALID';
  end if;

  select * into existing from public.ghl_installs install
  where install.location_id = p_location_id for update;
  if existing.id is not null and existing.tenant_id is not null
    and existing.tenant_id <> p_expected_tenant then
    raise exception 'GHL_INSTALL_LOCATION_BOUND_ELSEWHERE';
  end if;

  if existing.id is null then
    insert into public.ghl_installs (
      tenant_id, location_id, company_id, token_expires_at, install_state, last_error
    ) values (
      p_expected_tenant, p_location_id, p_company_id, p_token_expires_at, 'installed', null
    ) returning id into install_id;
  else
    update public.ghl_installs install
    set tenant_id = p_expected_tenant,
        company_id = p_company_id,
        token_expires_at = p_token_expires_at,
        install_state = 'installed',
        last_error = null
    where install.id = existing.id
    returning install.id into install_id;
  end if;

  insert into public.ghl_install_secrets (
    ghl_install_id, access_credential_envelope, refresh_credential_envelope
  ) values (
    install_id, p_access_credential_envelope, p_refresh_credential_envelope
  )
  on conflict (ghl_install_id) do update
  set access_credential_envelope = excluded.access_credential_envelope,
      refresh_credential_envelope = excluded.refresh_credential_envelope,
      updated_at = now();

  return install_id;
end;
$$;

create or replace function public.persist_meta_whatsapp_connection_atomic(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_waba_id text,
  p_phone_number_id text,
  p_state public.channel_state,
  p_credential_envelope jsonb,
  p_token_expires_at timestamptz,
  p_scopes text[],
  p_completed_at timestamptz,
  p_phone_verified_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  existing public.channel_connections%rowtype;
  connection_id uuid;
  prior_state public.channel_state;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_waba_id), '') is null
    or nullif(btrim(p_phone_number_id), '') is null
    or p_state not in ('pending_review', 'ready')
    or not app.credential_envelope_valid(p_credential_envelope)
    or not coalesce(p_scopes @> array[
      'whatsapp_business_management', 'whatsapp_business_messaging'
    ], false)
    or p_completed_at is null
    or (p_state = 'ready' and p_phone_verified_at is null) then
    raise exception 'WHATSAPP_CONNECTION_ATOMIC_INPUT_INVALID';
  end if;

  if exists (
    select 1 from public.channel_connections connection
    where connection.provider = 'meta_direct'
      and connection.channel = 'whatsapp'
      and connection.external_account_id = p_phone_number_id
      and connection.tenant_id <> p_expected_tenant
  ) then raise exception 'WHATSAPP_CONNECTION_ACCOUNT_BOUND_ELSEWHERE'; end if;

  select * into existing from public.channel_connections connection
  where connection.tenant_id = p_expected_tenant
    and connection.channel = 'whatsapp'
  for update;
  if existing.id is not null and (
    existing.provider <> 'meta_direct'
    or existing.external_account_id is distinct from p_phone_number_id
  ) then raise exception 'WHATSAPP_CONNECTION_ACCOUNT_CONFLICT'; end if;
  prior_state := existing.state;

  if existing.id is null then
    insert into public.channel_connections (
      tenant_id, channel, provider, state, external_account_id, external_account_label,
      external_ref, token_expires_at, oauth_completed_at, asset_verified_at,
      webhook_subscribed_at, error
    ) values (
      p_expected_tenant, 'whatsapp', 'meta_direct', p_state,
      p_phone_number_id, p_phone_number_id,
      jsonb_build_object(
        'account_id', p_phone_number_id,
        'waba_id', p_waba_id,
        'phone_number_id', p_phone_number_id,
        'scopes', to_jsonb(coalesce(p_scopes, '{}'::text[]))
      ),
      p_token_expires_at, p_completed_at, p_phone_verified_at, p_completed_at, null
    ) returning id into connection_id;
  else
    update public.channel_connections connection
    set state = p_state,
        external_account_label = p_phone_number_id,
        external_ref = jsonb_build_object(
          'account_id', p_phone_number_id,
          'waba_id', p_waba_id,
          'phone_number_id', p_phone_number_id,
          'scopes', to_jsonb(coalesce(p_scopes, '{}'::text[]))
        ),
        token_expires_at = p_token_expires_at,
        oauth_completed_at = p_completed_at,
        asset_verified_at = p_phone_verified_at,
        webhook_subscribed_at = p_completed_at,
        error = null
    where connection.id = existing.id
    returning connection.id into connection_id;
  end if;

  insert into public.channel_connection_secrets (
    channel_connection_id, credential_envelope
  ) values (connection_id, p_credential_envelope)
  on conflict (channel_connection_id) do update
  set credential_envelope = excluded.credential_envelope,
      updated_at = now();

  perform app.write_audit_row(
    'channel.connect.started', p_actor_id, p_expected_tenant,
    'channel_connection', connection_id::text, null,
    jsonb_build_object(
      'before', case when existing.id is null then null else jsonb_build_object('state', prior_state) end,
      'after', jsonb_build_object('channel', 'whatsapp', 'state', p_state)
    )
  );
  perform app.write_audit_row(
    'channel.connect.completed', null, p_expected_tenant,
    'channel_connection', connection_id::text, null,
    jsonb_build_object(
      'before', jsonb_build_object('state', coalesce(prior_state::text, 'connecting')),
      'after', jsonb_build_object('channel', 'whatsapp', 'state', p_state)
    )
  );

  return connection_id;
end;
$$;

revoke execute on function app.credential_envelope_valid(jsonb)
from public, anon, authenticated, service_role;

revoke execute on function public.persist_ghl_install_credentials_atomic(
  uuid,text,text,timestamptz,jsonb,jsonb
), public.persist_meta_whatsapp_connection_atomic(
  uuid,uuid,text,text,public.channel_state,jsonb,timestamptz,text[],timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.persist_ghl_install_credentials_atomic(
  uuid,text,text,timestamptz,jsonb,jsonb
), public.persist_meta_whatsapp_connection_atomic(
  uuid,uuid,text,text,public.channel_state,jsonb,timestamptz,text[],timestamptz,timestamptz
) to service_role;
