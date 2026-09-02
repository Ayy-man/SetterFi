-- Phase 4 channel foundation: provider-neutral identity/connection state, template lifecycle,
-- credential custody, duplicate review, and the closed audit/alert registries.
--
-- Existing Phase 1 objects are extended in place. Every lossy or enforcing change is preceded by
-- a deterministic backfill or a named remediation guard, so a hosted-shaped populated database
-- aborts before plaintext custody or an honest provider state can be misrepresented.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Fail-loud prerequisites and existing-row guards
-- ---------------------------------------------------------------------------

do $$
declare
  missing text[];
begin
  select array_agg(required_name order by required_name) into missing
  from unnest(array[
    'alert_rules', 'audit_actions', 'audit_log', 'channel_connections', 'contact_identities',
    'contacts', 'conversations', 'ghl_installs', 'message_templates', 'messages', 'webhook_events'
  ]) required_name
  where to_regclass('public.' || required_name) is null;

  if missing is not null then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE4_REQUIRED_RELATIONS_MISSING',
      detail = array_to_string(missing, ', ');
  end if;

  if to_regprocedure('app.not_impersonating()') is null
    or to_regprocedure('app.set_updated_at()') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid)') is null then
    raise exception 'PHASE4_PHASE1_HELPERS_REQUIRED';
  end if;

  if exists (
    select 1
    from public.contact_identities identity
    join public.contacts contact on contact.id = identity.contact_id
    where identity.tenant_id <> contact.tenant_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE4_IDENTITY_TENANT_REMEDIATION_REQUIRED',
      detail = 'Repair contact_identities rows whose tenant differs from their contact before retrying.';
  end if;

  if exists (
    select tenant_id, channel
    from public.channel_connections
    where state = 'live'
    group by tenant_id, channel
    having count(*) > 1
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE4_DUPLICATE_LIVE_CONNECTION_REMEDIATION_REQUIRED',
      detail = 'Choose one receipt-backed live provider per tenant and channel before retrying.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Contact merge state and suspected-duplicate evidence
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column merged_into_contact_id uuid references public.contacts(id) on delete restrict,
  add column merged_at timestamptz,
  add column merge_audit_id bigint references public.audit_log(id) on delete restrict,
  add constraint contacts_merge_shape_chk check (
    (merged_into_contact_id is null and merged_at is null and merge_audit_id is null)
    or (merged_into_contact_id is not null and merged_at is not null and merge_audit_id is not null)
  ),
  add constraint contacts_merge_self_chk check (merged_into_contact_id is null or merged_into_contact_id <> id);

create index contacts_merged_into_idx on public.contacts (tenant_id, merged_into_contact_id)
  where merged_into_contact_id is not null;

create or replace function app.enforce_contact_merge_target()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_tenant uuid;
begin
  if new.merged_into_contact_id is null then return new; end if;

  select tenant_id into target_tenant
  from public.contacts
  where id = new.merged_into_contact_id;
  if target_tenant is null then raise exception 'MERGE_TARGET_NOT_FOUND'; end if;
  if target_tenant <> new.tenant_id then raise exception 'MERGE_TARGET_TENANT_MISMATCH'; end if;

  if exists (
    with recursive ancestry(id) as (
      select new.merged_into_contact_id
      union all
      select contact.merged_into_contact_id
      from public.contacts contact
      join ancestry prior on contact.id = prior.id
      where contact.merged_into_contact_id is not null
    )
    select 1 from ancestry where id = new.id
  ) then
    raise exception 'MERGE_CYCLE_FORBIDDEN';
  end if;
  return new;
end;
$$;

create trigger contacts_merge_target_guard
before insert or update of tenant_id, merged_into_contact_id on public.contacts
for each row execute function app.enforce_contact_merge_target();

create table public.contact_duplicate_candidates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_a_id uuid not null references public.contacts(id) on delete cascade,
  contact_b_id uuid not null references public.contacts(id) on delete cascade,
  source text not null check (source in (
    'field_match', 'provider_asserted', 'lead_asserted', 'human_asserted'
  )),
  evidence_key text not null check (nullif(btrim(evidence_key), '') is not null),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  state text not null default 'open' check (state in ('open', 'merged', 'dismissed')),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_duplicate_candidates_order_chk check (contact_a_id < contact_b_id),
  constraint contact_duplicate_candidates_resolution_chk check (
    (state = 'open' and resolved_at is null and resolved_by is null)
    or (state <> 'open' and resolved_at is not null)
  ),
  unique (tenant_id, contact_a_id, contact_b_id, source, evidence_key)
);

create index contact_duplicate_candidates_open_idx
  on public.contact_duplicate_candidates (tenant_id, created_at desc)
  where state = 'open';

create or replace function app.enforce_duplicate_candidate_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  tenant_a uuid;
  tenant_b uuid;
begin
  select tenant_id into tenant_a from public.contacts where id = new.contact_a_id;
  select tenant_id into tenant_b from public.contacts where id = new.contact_b_id;
  if tenant_a is null or tenant_b is null
    or tenant_a <> new.tenant_id or tenant_b <> new.tenant_id then
    raise exception 'DUPLICATE_CANDIDATE_TENANT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger contact_duplicate_candidates_tenant_guard
before insert or update of tenant_id, contact_a_id, contact_b_id
on public.contact_duplicate_candidates
for each row execute function app.enforce_duplicate_candidate_tenant();

-- ---------------------------------------------------------------------------
-- 3. Authoritative provider window and template lifecycle
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column provider_window_expires_at timestamptz;

alter table public.message_templates
  add column provider_template_name text,
  add column category text check (category is null or category in ('authentication', 'marketing', 'utility')),
  add column locale text,
  add column body text,
  add column body_hash text,
  add column variables jsonb not null default '[]'::jsonb,
  add column submitted_at timestamptz,
  add column approved_at timestamptz,
  add column rejected_at timestamptz,
  add column paused_at timestamptz,
  add column disabled_at timestamptz,
  add column status_updated_at timestamptz,
  add column rejection_detail text,
  add column is_demo boolean not null default false;

alter table public.message_templates
  drop constraint message_templates_status_check;

update public.message_templates
set provider_template_name = name,
    status = case when status = 'pending' then 'submitted' else status end,
    submitted_at = case when status = 'pending' then created_at else submitted_at end,
    approved_at = case when status = 'approved' then updated_at else approved_at end,
    rejected_at = case when status = 'rejected' then updated_at else rejected_at end,
    paused_at = case when status = 'paused' then updated_at else paused_at end,
    status_updated_at = updated_at
where provider_template_name is null or status = 'pending' or status_updated_at is null;

alter table public.message_templates
  alter column provider_template_id drop not null,
  alter column provider_template_name set not null,
  add constraint message_templates_status_chk check (
    status in ('draft', 'submitted', 'approved', 'rejected', 'paused', 'disabled')
  ),
  add constraint message_templates_provider_id_chk check (
    status = 'draft' or nullif(btrim(provider_template_id), '') is not null
  ),
  add constraint message_templates_body_hash_chk check (
    body_hash is null or body_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint message_templates_variables_chk check (jsonb_typeof(variables) = 'array'),
  add constraint message_templates_lifecycle_chk check (
    (status <> 'submitted' or submitted_at is not null)
    and (status <> 'approved' or approved_at is not null)
    and (status <> 'rejected' or rejected_at is not null)
    and (status <> 'paused' or paused_at is not null)
    and (status <> 'disabled' or disabled_at is not null)
  ),
  add constraint message_templates_demo_chk check (
    not is_demo
    or (
      provider_template_name like 'SETTERFI_DEMO_PLACEHOLDER_%'
      and body like 'SETTERFI_DEMO_PLACEHOLDER_%'
    )
  );

alter table public.message_templates
  drop constraint message_templates_tenant_id_provider_provider_template_id_key;
create unique index message_templates_provider_id_uidx
  on public.message_templates (tenant_id, provider, provider_template_id)
  where provider_template_id is not null;
create unique index message_templates_provider_name_uidx
  on public.message_templates (tenant_id, channel, provider, provider_template_name, locale)
  where locale is not null;
create index message_templates_sendable_idx
  on public.message_templates (tenant_id, channel, provider, locale)
  where status = 'approved';

-- ---------------------------------------------------------------------------
-- 4. Connection receipt state, OAuth state, and one-live enforcement
-- ---------------------------------------------------------------------------

create unique index if not exists channel_connections_one_live_provider_idx
  on public.channel_connections (tenant_id, channel)
  where state = 'live';

alter table public.channel_connections
  add column external_account_id text,
  add column external_account_label text,
  add column oauth_completed_at timestamptz,
  add column asset_verified_at timestamptz,
  add column webhook_subscribed_at timestamptz,
  add column signed_round_trip_at timestamptz,
  add column last_signed_inbound_receipt_id uuid references public.webhook_events(id) on delete set null,
  add column last_signed_outbound_message_id uuid references public.messages(id) on delete set null;

do $$
begin
  if exists (
    select 1
    from public.channel_connections
    where provider = 'meta_direct' and state = 'live'
      and (external_account_id is null or asset_verified_at is null
        or webhook_subscribed_at is null or signed_round_trip_at is null
        or last_signed_inbound_receipt_id is null or last_signed_outbound_message_id is null)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE4_META_LIVE_RECEIPT_REMEDIATION_REQUIRED',
      detail = 'Demote the connection or backfill verified asset, subscription, signed inbound, outbound, and round-trip receipts before retrying.';
  end if;
end
$$;

alter table public.channel_connections
  add constraint channel_connections_meta_live_receipt_chk check (
    provider <> 'meta_direct' or state <> 'live'
    or (
      nullif(btrim(external_account_id), '') is not null
      and asset_verified_at is not null
      and webhook_subscribed_at is not null
      and signed_round_trip_at is not null
      and last_signed_inbound_receipt_id is not null
      and last_signed_outbound_message_id is not null
    )
  );

create unique index channel_connections_provider_account_uidx
  on public.channel_connections (provider, channel, external_account_id)
  where external_account_id is not null;

create table public.channel_oauth_states (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.users(id),
  channel public.messaging_channel not null,
  state_hash text unique not null check (state_hash ~ '^[0-9a-f]{64}$'),
  pkce_verifier_envelope jsonb check (
    pkce_verifier_envelope is null or jsonb_typeof(pkce_verifier_envelope) = 'object'
  ),
  return_path text not null check (return_path ~ '^/[^/]'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint channel_oauth_states_expiry_chk check (
    expires_at > created_at and expires_at <= created_at + interval '10 minutes'
  ),
  constraint channel_oauth_states_consumed_chk check (consumed_at is null or consumed_at >= created_at)
);
create index channel_oauth_states_expiry_idx
  on public.channel_oauth_states (expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 5. Service-only credential custody and operation replay receipts
-- ---------------------------------------------------------------------------

create table public.channel_connection_secrets (
  channel_connection_id uuid primary key
    references public.channel_connections(id) on delete cascade,
  credential_envelope jsonb not null check (jsonb_typeof(credential_envelope) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ghl_install_secrets (
  ghl_install_id uuid primary key references public.ghl_installs(id) on delete cascade,
  access_credential_envelope jsonb not null
    check (jsonb_typeof(access_credential_envelope) = 'object'),
  refresh_credential_envelope jsonb not null
    check (jsonb_typeof(refresh_credential_envelope) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Phase 1 labelled these values ciphertext but kept them in browser-readable tables. Version zero
-- preserves that ciphertext byte-for-byte under service custody; every new write uses the V1
-- AES-256-GCM envelope introduced by Plan 04-02, and its resolver fails closed on legacy format.
insert into public.channel_connection_secrets (channel_connection_id, credential_envelope)
select id, jsonb_build_object(
  'version', 0,
  'algorithm', 'LEGACY_CIPHERTEXT',
  'ciphertext', access_token
)
from public.channel_connections
where access_token is not null;

insert into public.ghl_install_secrets (
  ghl_install_id, access_credential_envelope, refresh_credential_envelope
)
select id,
  jsonb_build_object('version', 0, 'algorithm', 'LEGACY_CIPHERTEXT', 'ciphertext', access_token),
  jsonb_build_object('version', 0, 'algorithm', 'LEGACY_CIPHERTEXT', 'ciphertext', refresh_token)
from public.ghl_installs;

do $$
begin
  if (select count(*) from public.channel_connections where access_token is not null)
    <> (select count(*) from public.channel_connection_secrets) then
    raise exception 'PHASE4_CHANNEL_SECRET_MIGRATION_INCOMPLETE';
  end if;
  if (select count(*) from public.ghl_installs)
    <> (select count(*) from public.ghl_install_secrets) then
    raise exception 'PHASE4_GHL_SECRET_MIGRATION_INCOMPLETE';
  end if;
end
$$;

alter table public.channel_connections drop column access_token;
alter table public.ghl_installs drop column access_token, drop column refresh_token;

create table public.channel_operation_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation text not null check (operation in (
    'switch_provider', 'merge_contacts', 'unmerge_contact', 'submit_template'
  )),
  idempotency_key text not null check (nullif(btrim(idempotency_key), '') is not null),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, operation, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- 6. Closed audit and alert registries
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('channel.connect.started', 'human', 'tenant', false, true,
    'Connection start logged', 'Channel connection start recorded in the audit log'),
  ('channel.connect.completed', 'system', 'tenant', false, true,
    'Connection logged', 'Channel connection completion recorded in the audit log'),
  ('channel.provider.switched', 'human', 'tenant', true, true,
    'Provider switch logged', 'Channel provider switch recorded in the audit log'),
  ('channel.disconnected', 'human', 'tenant', false, true,
    'Disconnection logged', 'Channel disconnection recorded in the audit log'),
  ('contact.merged', 'human', 'tenant', true, true,
    'Merge logged', 'Contact merge recorded in the audit log'),
  ('contact.unmerged', 'human', 'tenant', true, true,
    'Undo logged', 'Contact merge undo recorded in the audit log'),
  ('message_template.submitted', 'human', 'tenant', false, true,
    'Template submission logged', 'Message template submission recorded in the audit log'),
  ('send.refused.window_expired', 'system', 'tenant', false, false,
    'Window refusal logged', 'Expired provider-window refusal recorded in the audit log'),
  ('message_template.rejected', 'system', 'tenant', false, true,
    'Template rejection logged', 'Message template rejection recorded in the audit log');

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled)
values
  ('send.refused.window_expired', 'tenant', 'Message window expired',
    'A provider window closed before an eligible outbound message could be sent.',
    'channel', '{coach}', false, false, '{bell}', true, true),
  ('message_template.rejected', 'tenant', 'Message template rejected',
    'A submitted message template was rejected by the provider.',
    'channel', '{coach}', true, false, '{bell,email}', true, true);

-- ---------------------------------------------------------------------------
-- 7. Forced RLS, exact grants, triggers, and comments
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contact_duplicate_candidates', 'channel_oauth_states', 'channel_connection_secrets',
    'ghl_install_secrets', 'channel_operation_receipts'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end
$$;

create policy contact_duplicate_candidates_tenant_read
  on public.contact_duplicate_candidates for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy contact_duplicate_candidates_platform_read
  on public.contact_duplicate_candidates for select to authenticated
  using (app.is_platform_operator());
grant select on public.contact_duplicate_candidates to authenticated;

create policy channel_oauth_states_service_all
  on public.channel_oauth_states for all to service_role using (true) with check (true);
create policy channel_connection_secrets_service_all
  on public.channel_connection_secrets for all to service_role using (true) with check (true);
create policy ghl_install_secrets_service_all
  on public.ghl_install_secrets for all to service_role using (true) with check (true);
create policy channel_operation_receipts_service_all
  on public.channel_operation_receipts for all to service_role using (true) with check (true);

-- Connection transitions and templates are service-owned. Authenticated sessions retain the
-- provider-neutral read policies but cannot manufacture live, approved, or receipt-backed state.
drop policy tenant_write on public.channel_connections;
drop policy platform_write on public.channel_connections;
revoke insert, update, delete on public.channel_connections from authenticated;
grant select on public.channel_connections to authenticated;

drop policy ghl_installs_platform_all on public.ghl_installs;
create policy ghl_installs_platform_read on public.ghl_installs for select to authenticated
  using (app.is_platform_user());
revoke insert, update, delete on public.ghl_installs from authenticated;
grant select on public.ghl_installs to authenticated;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contact_duplicate_candidates', 'channel_oauth_states',
    'channel_connection_secrets', 'ghl_install_secrets'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function app.set_updated_at()',
      table_name
    );
  end loop;
end
$$;

revoke execute on function app.enforce_contact_merge_target() from public, anon, authenticated;
revoke execute on function app.enforce_duplicate_candidate_tenant() from public, anon, authenticated;

comment on column public.conversations.provider_window_expires_at is
  'Authoritative provider window mirrored on every accepted Meta inbound; null means unavailable, never open.';
comment on table public.contact_duplicate_candidates is
  'Evidence for review only. Test/demo state is derived by joining both contacts; no is_test copy may drift.';
comment on table public.channel_connection_secrets is
  'Service-only credential envelopes. New writes are AES-256-GCM V1; browser roles have no grant.';
comment on table public.ghl_install_secrets is
  'Service-only GHL credential envelopes moved out of browser-readable install metadata.';
comment on table public.channel_operation_receipts is
  'Tenant-scoped payload-hashed idempotency receipts for Phase 4 transactional RPCs.';
