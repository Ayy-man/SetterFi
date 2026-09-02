-- Durable destructive-operation checkpoints and credential-custody invariants.

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

-- Phase 4 deliberately quarantined pre-envelope ciphertext as V0. It was never decryptable by the
-- V1 resolver, so downgrade every affected connection before removing that unusable custody. The
-- migration transaction keeps a ready/token_ok claim from surviving without its secret.
update public.channel_connections connection
set state = 'error',
    error = 'LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED',
    token_expires_at = null,
    updated_at = now()
where exists (
    select 1 from public.channel_connection_secrets secret
    where secret.channel_connection_id = connection.id
      and not coalesce(app.credential_envelope_valid(secret.credential_envelope), false)
  )
  or (
    connection.provider in ('ghl', 'meta_direct')
    and connection.state in ('ready', 'live')
    and not exists (
      select 1 from public.channel_connection_secrets secret
      where secret.channel_connection_id = connection.id
        and app.credential_envelope_valid(secret.credential_envelope)
    )
  );
delete from public.channel_connection_secrets secret
where not coalesce(app.credential_envelope_valid(secret.credential_envelope), false);

update public.ghl_installs install
set install_state = 'failed',
    reauthorization_required_at = coalesce(install.reauthorization_required_at, now()),
    last_error = 'LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED',
    updated_at = now()
where install.install_state <> 'uninstalled'
  and not exists (
    select 1 from public.ghl_install_secrets secret
    where secret.ghl_install_id = install.id
      and app.credential_envelope_valid(secret.access_credential_envelope)
      and app.credential_envelope_valid(secret.refresh_credential_envelope)
  );
update public.ghl_install_secrets secret
set refresh_lock_expires_at = null, refresh_lock_token = null, updated_at = now()
where not coalesce(app.credential_envelope_valid(secret.access_credential_envelope), false)
   or not coalesce(app.credential_envelope_valid(secret.refresh_credential_envelope), false);
delete from public.ghl_install_secrets secret
where not coalesce(app.credential_envelope_valid(secret.access_credential_envelope), false)
   or not coalesce(app.credential_envelope_valid(secret.refresh_credential_envelope), false);

alter table public.ghl_agency_installs
  alter column access_credential_envelope drop not null,
  alter column refresh_credential_envelope drop not null;
update public.ghl_agency_installs install
set install_state = 'failed',
    reauthorization_required_at = coalesce(install.reauthorization_required_at, now()),
    last_error = 'LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED',
    refresh_lock_expires_at = null,
    refresh_lock_token = null,
    access_credential_envelope = null,
    refresh_credential_envelope = null,
    updated_at = now()
where not coalesce(app.credential_envelope_valid(install.access_credential_envelope), false)
   or not coalesce(app.credential_envelope_valid(install.refresh_credential_envelope), false);

alter table public.ghl_install_secrets
  add constraint ghl_install_secrets_access_envelope_chk
    check (app.credential_envelope_valid(access_credential_envelope)) not valid,
  add constraint ghl_install_secrets_refresh_envelope_chk
    check (app.credential_envelope_valid(refresh_credential_envelope)) not valid;
alter table public.ghl_install_secrets
  validate constraint ghl_install_secrets_access_envelope_chk,
  validate constraint ghl_install_secrets_refresh_envelope_chk;

alter table public.channel_connection_secrets
  add constraint channel_connection_secrets_envelope_chk
    check (app.credential_envelope_valid(credential_envelope)) not valid;
alter table public.channel_connection_secrets
  validate constraint channel_connection_secrets_envelope_chk;

alter table public.ghl_agency_installs
  add constraint ghl_agency_installs_access_envelope_chk check (
    access_credential_envelope is null
    or app.credential_envelope_valid(access_credential_envelope)
  ) not valid,
  add constraint ghl_agency_installs_refresh_envelope_chk check (
    refresh_credential_envelope is null
    or app.credential_envelope_valid(refresh_credential_envelope)
  ) not valid,
  add constraint ghl_agency_installs_envelope_pair_chk check (
    (access_credential_envelope is null) = (refresh_credential_envelope is null)
  ) not valid,
  add constraint ghl_agency_installs_missing_custody_chk check (
    access_credential_envelope is not null
    or (install_state = 'failed' and reauthorization_required_at is not null)
  ) not valid;
alter table public.ghl_agency_installs
  validate constraint ghl_agency_installs_access_envelope_chk,
  validate constraint ghl_agency_installs_refresh_envelope_chk,
  validate constraint ghl_agency_installs_envelope_pair_chk,
  validate constraint ghl_agency_installs_missing_custody_chk;

alter table public.contact_identities
  add column provider_account_id text,
  add column ghl_install_id uuid references public.ghl_installs(id) on delete restrict;

with tenant_install as (
  select install.tenant_id,
    (array_agg(install.id order by install.id))[1] as install_id,
    (array_agg(install.location_id order by install.id))[1] as location_id
  from public.ghl_installs install
  group by install.tenant_id
  having count(*) = 1
)
update public.contact_identities identity
set provider_account_id = binding.location_id,
    ghl_install_id = binding.install_id,
    updated_at = now()
from tenant_install binding
where identity.provider = 'ghl' and identity.tenant_id = binding.tenant_id;

alter table public.contact_identities
  add constraint contact_identities_ghl_account_shape_chk check (
    (provider = 'ghl' and (
      (provider_account_id is null and ghl_install_id is null)
      or (nullif(btrim(provider_account_id), '') is not null and ghl_install_id is not null)
    ))
    or (provider <> 'ghl' and provider_account_id is null and ghl_install_id is null)
  );

create or replace function app.enforce_contact_identity_provider_account()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  install public.ghl_installs%rowtype;
  requested_account_id text := nullif(
    current_setting('app.inbound_provider_account_id', true), ''
  );
begin
  if new.provider <> 'ghl' then
    if new.provider_account_id is not null or new.ghl_install_id is not null then
      raise exception 'NON_GHL_IDENTITY_ACCOUNT_BINDING_FORBIDDEN';
    end if;
    return new;
  end if;
  if tg_op = 'UPDATE' and old.provider = 'ghl' and old.provider_account_id is not null
    and (new.provider_account_id is distinct from old.provider_account_id
      or new.ghl_install_id is distinct from old.ghl_install_id) then
    raise exception 'GHL_IDENTITY_ACCOUNT_REASSIGNMENT_FORBIDDEN';
  end if;
  if new.provider_account_id is null or new.ghl_install_id is null then
    if requested_account_id is not null then
      select * into install from public.ghl_installs candidate
      where candidate.tenant_id = new.tenant_id
        and candidate.location_id = requested_account_id;
    else
      select * into install from public.ghl_installs candidate
      where candidate.tenant_id = new.tenant_id
        and candidate.location_id = (
        select connection.external_account_id from public.channel_connections connection
        where connection.tenant_id = new.tenant_id and connection.provider = 'ghl'
          and connection.channel = new.channel and connection.state in ('ready', 'live')
        limit 1
      );
    end if;
    if install.id is not null then
      new.provider_account_id := install.location_id;
      new.ghl_install_id := install.id;
    end if;
  else
    select * into install from public.ghl_installs candidate
    where candidate.id = new.ghl_install_id and candidate.tenant_id = new.tenant_id;
  end if;
  if install.id is null or install.location_id is distinct from new.provider_account_id then
    raise exception 'GHL_IDENTITY_ACCOUNT_BINDING_REQUIRED';
  end if;
  return new;
end;
$$;

create trigger contact_identities_provider_account_guard
before insert or update of tenant_id, provider, channel, provider_account_id, ghl_install_id
on public.contact_identities
for each row execute function app.enforce_contact_identity_provider_account();

create or replace function public.persist_inbound_message(
  p_expected_tenant uuid,
  p_provider public.channel_provider,
  p_channel public.messaging_channel,
  p_provider_identity_id text,
  p_provider_account_id text,
  p_normalized_phone text,
  p_normalized_email text,
  p_provider_message_id text,
  p_body text,
  p_contact_name text,
  p_provider_window_observed_at timestamptz,
  p_provider_window_expires_at timestamptz,
  p_provider_window_source text
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_inserted boolean,
  disclosure_pending boolean,
  provider_window_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_provider = 'ghl' and nullif(btrim(p_provider_account_id), '') is null then
    raise exception 'GHL_PROVIDER_ACCOUNT_ID_REQUIRED';
  end if;
  if p_provider <> 'ghl' and p_provider_account_id is not null then
    raise exception 'NON_GHL_PROVIDER_ACCOUNT_ID_FORBIDDEN';
  end if;
  perform set_config(
    'app.inbound_provider_account_id',
    coalesce(nullif(btrim(p_provider_account_id), ''), ''),
    true
  );
  return query select * from public.persist_inbound_message(
    p_expected_tenant, p_provider, p_channel, p_provider_identity_id,
    p_normalized_phone, p_normalized_email, p_provider_message_id, p_body,
    p_contact_name, p_provider_window_observed_at, p_provider_window_expires_at,
    p_provider_window_source
  );
  perform set_config('app.inbound_provider_account_id', '', true);
  if p_provider = 'ghl' and not exists (
    select 1 from public.contact_identities identity
    where identity.tenant_id = p_expected_tenant and identity.provider = p_provider
      and identity.channel = p_channel
      and identity.provider_identity_id = btrim(p_provider_identity_id)
      and identity.provider_account_id = btrim(p_provider_account_id)
      and identity.ghl_install_id is not null
  ) then raise exception 'GHL_IDENTITY_ACCOUNT_BINDING_MISMATCH'; end if;
end;
$$;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'contact.delete.recovery_adopted', 'human', 'tenant', true, false,
  'Deletion recovery adopted', 'Privileged contact deletion recovery recorded in the audit log'
)
on conflict (key) do nothing;

create table public.contact_merge_snapshots (
  merge_audit_id bigint primary key
    references public.audit_log(id) on delete cascade deferrable initially deferred,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  winner_id uuid not null references public.contacts(id) on delete cascade,
  loser_id uuid not null references public.contacts(id) on delete cascade,
  prior_payload jsonb not null check (jsonb_typeof(prior_payload) = 'object'),
  payload_digest text not null check (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now()
);
alter table public.contact_merge_snapshots enable row level security;
alter table public.contact_merge_snapshots force row level security;
revoke all on table public.contact_merge_snapshots from public, anon, authenticated, service_role;

-- Preserve reversible custody for merges that predate this migration before their audit projection
-- is minimized. Rows whose contacts no longer exist cannot be unmerged and are intentionally not
-- retained in the PII-bearing custody table.
insert into public.contact_merge_snapshots (
  merge_audit_id, tenant_id, winner_id, loser_id, prior_payload, payload_digest
)
select audit.id, audit.tenant_id, winner.id, loser.id, audit.payload -> 'prior',
  encode(extensions.digest(
    convert_to((audit.payload -> 'prior')::text, 'UTF8'), 'sha256'
  ), 'hex')
from public.audit_log audit
join public.contacts winner on winner.id::text = audit.target_id
join public.contacts loser on loser.id = (audit.payload #>> '{prior,loser,id}')::uuid
where audit.action = 'contact.merged'
  and audit.target_type = 'contact'
  and jsonb_typeof(audit.payload -> 'prior') = 'object'
  and winner.tenant_id = audit.tenant_id
  and loser.tenant_id = audit.tenant_id
  and loser.merged_into_contact_id = winner.id
  and loser.merge_audit_id = audit.id
on conflict (merge_audit_id) do nothing;

create or replace function app.capture_contact_merge_snapshot()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_payload jsonb;
  winner_id uuid;
  loser_id uuid;
  prior_digest text;
begin
  if new.action = 'contact.merged' then
    prior_payload := new.payload -> 'prior';
    winner_id := new.target_id::uuid;
    loser_id := (prior_payload #>> '{loser,id}')::uuid;
    if jsonb_typeof(prior_payload) <> 'object' or loser_id is null then
      raise exception 'CONTACT_MERGE_AUDIT_SNAPSHOT_INVALID';
    end if;
    prior_digest := encode(extensions.digest(
      convert_to(prior_payload::text, 'UTF8'), 'sha256'
    ), 'hex');
    insert into public.contact_merge_snapshots (
      merge_audit_id, tenant_id, winner_id, loser_id, prior_payload, payload_digest
    ) values (
      new.id, new.tenant_id, winner_id, loser_id, prior_payload, prior_digest
    );
    new.payload := jsonb_build_object(
      'source', new.payload -> 'source',
      'evidenceId', new.payload -> 'evidenceId',
      'winnerId', winner_id,
      'loserId', loser_id,
      'priorDigest', prior_digest,
      'movedIdentityCount', jsonb_array_length(coalesce(prior_payload -> 'identities', '[]'::jsonb)),
      'movedConversationCount', jsonb_array_length(coalesce(prior_payload -> 'conversations', '[]'::jsonb)),
      'candidateCount', jsonb_array_length(coalesce(prior_payload -> 'candidates', '[]'::jsonb)),
      'new', new.payload -> 'new'
    );
  elsif new.action = 'contact.unmerged' then
    prior_digest := encode(extensions.digest(
      convert_to(coalesce(new.payload, '{}'::jsonb)::text, 'UTF8'), 'sha256'
    ), 'hex');
    new.payload := jsonb_build_object(
      'mergeAuditId', new.payload -> 'mergeAuditId',
      'priorDigest', prior_digest,
      'restoredIdentityCount', new.payload #> '{new,restoredIdentityCount}',
      'restoredConversationCount', new.payload #> '{new,restoredConversationCount}'
    );
  end if;
  return new;
end;
$$;

create trigger audit_log_contact_merge_privacy
before insert on public.audit_log
for each row when (new.action in ('contact.merged', 'contact.unmerged'))
execute function app.capture_contact_merge_snapshot();

create or replace function app.reject_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_setting('app.audit_privacy_redaction', true) = 'true'
    and (to_jsonb(new) - 'payload') = (to_jsonb(old) - 'payload')
    and jsonb_typeof(new.payload) = 'object'
    and new.payload ->> 'privacyRedacted' = 'true'
    and new.payload ->> 'priorPayloadDigest' ~ '^[0-9a-f]{64}$' then
    return new;
  end if;
  raise exception 'AUDIT_LOG_APPEND_ONLY';
end;
$$;

create or replace function app.redact_contact_merge_audits(
  p_expected_tenant uuid,
  p_contact_ids uuid[]
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_expected_tenant is null or coalesce(cardinality(p_contact_ids), 0) = 0 then
    raise exception 'CONTACT_DELETE_AUDIT_REDACTION_SCOPE_INVALID';
  end if;
  perform set_config('app.audit_privacy_redaction', 'true', true);
  update public.audit_log audit
  set payload = jsonb_build_object(
    'privacyRedacted', true,
    'priorPayloadDigest', encode(extensions.digest(
      convert_to(coalesce(audit.payload, '{}'::jsonb)::text, 'UTF8'), 'sha256'
    ), 'hex')
  )
  where audit.tenant_id = p_expected_tenant
    and audit.action in ('contact.merged', 'contact.unmerged')
    and audit.target_type = 'contact'
    and audit.target_id in (
      select contact_id::text from unnest(p_contact_ids) as contacts(contact_id)
    )
    and audit.payload is not null;
  perform set_config('app.audit_privacy_redaction', '', true);
end;
$$;

do $$
begin
  perform set_config('app.audit_privacy_redaction', 'true', true);
  update public.audit_log audit
  set payload = jsonb_build_object(
    'privacyRedacted', true,
    'priorPayloadDigest', encode(extensions.digest(
      convert_to(coalesce(audit.payload, '{}'::jsonb)::text, 'UTF8'), 'sha256'
    ), 'hex')
  )
  where audit.action in ('contact.merged', 'contact.unmerged')
    and audit.payload is not null
    and audit.payload ->> 'privacyRedacted' is distinct from 'true';
  perform set_config('app.audit_privacy_redaction', '', true);
end;
$$;

create table public.contact_deletion_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  contact_id uuid not null,
  actor_id uuid references public.users(id) on delete set null,
  preview_token uuid not null,
  idempotency_digest text not null check (idempotency_digest ~ '^[0-9a-f]{64}$'),
  snapshot_digest text not null check (snapshot_digest ~ '^[0-9a-f]{64}$'),
  provider_target_digest text not null check (provider_target_digest ~ '^[0-9a-f]{64}$'),
  reason text not null check (nullif(btrim(reason), '') is not null),
  status text not null default 'claimed'
    check (status in ('claimed', 'provider_confirmed', 'completed')),
  provider_evidence jsonb,
  recovery_actor_id uuid references public.users(id) on delete set null,
  recovery_reason text,
  recovery_adopted_at timestamptz,
  recovery_audit_id bigint references public.audit_log(id) on delete restrict,
  audit_id bigint references public.audit_log(id) on delete restrict,
  claimed_at timestamptz not null default now(),
  provider_confirmed_at timestamptz,
  completed_at timestamptz,
  recovery_attempt_count integer not null default 0 check (recovery_attempt_count >= 0),
  recovery_lease_token uuid,
  recovery_lease_expires_at timestamptz,
  recovery_next_attempt_at timestamptz,
  recovery_last_error text,
  recovery_operator_required boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (tenant_id, contact_id, idempotency_digest),
  check (
    (status = 'claimed' and provider_evidence is null
      and provider_confirmed_at is null and completed_at is null and audit_id is null)
    or (status = 'provider_confirmed' and jsonb_typeof(provider_evidence) = 'object'
      and provider_confirmed_at is not null and completed_at is null and audit_id is null)
    or (status = 'completed' and jsonb_typeof(provider_evidence) = 'object'
      and provider_confirmed_at is not null and completed_at is not null and audit_id is not null)
  )
);

alter table public.contacts
  add column deletion_intent_id uuid references public.contact_deletion_intents(id) on delete restrict,
  add column deletion_pending_at timestamptz,
  add column deletion_preview_snapshot_digest text,
  add column deletion_preview_provider_target_digest text,
  add constraint contacts_deletion_intent_shape_chk check (
    (deletion_intent_id is null and deletion_pending_at is null)
    or (deletion_intent_id is not null and deletion_pending_at is not null)
  ),
  add constraint contacts_deletion_preview_digests_chk check (
    (deletion_preview_snapshot_digest is null and deletion_preview_provider_target_digest is null)
    or (deletion_preview_snapshot_digest ~ '^[0-9a-f]{64}$'
      and deletion_preview_provider_target_digest ~ '^[0-9a-f]{64}$')
  );

create unique index contact_deletion_intents_active_contact_uidx
  on public.contact_deletion_intents (tenant_id, contact_id)
  where status <> 'completed';

alter table public.contact_deletion_intents enable row level security;
alter table public.contact_deletion_intents force row level security;
revoke all on table public.contact_deletion_intents from public, anon, authenticated, service_role;

create or replace function app.contact_deletion_cluster_ids(p_contact_id uuid)
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(contact.id order by contact.id), '{}'::uuid[])
  from public.contacts contact
  where contact.id = p_contact_id or contact.merged_into_contact_id = p_contact_id
$$;

create or replace function app.contact_deletion_snapshot_digest(p_contact_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'contact', (select jsonb_build_array(contact.id, contact.tenant_id)
      from public.contacts contact where contact.id = p_contact_id),
    'merged_contacts', coalesce((select jsonb_agg(to_jsonb(contact) order by contact.id)
      from public.contacts contact where contact.merged_into_contact_id = p_contact_id), '[]'::jsonb),
    'identities', coalesce((select jsonb_agg(jsonb_build_array(
      identity.id, identity.channel, identity.provider, identity.provider_identity_id,
      identity.provider_account_id, identity.ghl_install_id,
      identity.normalized_phone, identity.normalized_email
    ) order by identity.id) from public.contact_identities identity
      where identity.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'contact_notes', coalesce((select jsonb_agg(to_jsonb(note) order by note.id)
      from public.contact_notes note
      where note.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'duplicate_candidates', coalesce((select jsonb_agg(to_jsonb(candidate) order by candidate.id)
      from public.contact_duplicate_candidates candidate
      where candidate.contact_a_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        or candidate.contact_b_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(conversation.id order by conversation.id)
      from public.conversations conversation
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'messages', coalesce((select jsonb_agg(message.id order by message.id)
      from public.messages message join public.conversations conversation
        on conversation.id = message.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'message_traces', coalesce((select jsonb_agg(to_jsonb(trace) order by trace.message_id)
      from public.message_traces trace
      join public.messages message on message.id = trace.message_id
      join public.conversations conversation on conversation.id = message.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'conversation_step_events', coalesce((select jsonb_agg(to_jsonb(event) order by event.id)
      from public.conversation_step_events event
      where event.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'objection_usage_events', coalesce((select jsonb_agg(to_jsonb(event) order by event.id)
      from public.brain_objection_usage_events event
      join public.conversations conversation on conversation.id = event.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'unmatched_objections', coalesce((select jsonb_agg(to_jsonb(objection) order by objection.id)
      from public.unmatched_objections objection
      left join public.conversations conversation on conversation.id = objection.conversation_id
      left join public.messages message on message.id = objection.message_id
      left join public.conversations message_conversation
        on message_conversation.id = message.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        or message_conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'appointments', coalesce((select jsonb_agg(appointment.id order by appointment.id)
      from public.appointments appointment
      where appointment.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'followups', coalesce((select jsonb_agg(followup.id order by followup.id)
      from public.followups followup
      join public.conversations conversation on conversation.id = followup.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'eval_cases', coalesce((select jsonb_agg(eval.id order by eval.id)
      from public.eval_cases eval
      where eval.source_contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        or eval.source_conversation_id in (
          select id from public.conversations
          where contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        )), '[]'::jsonb),
    'billable_events', coalesce((select jsonb_agg(billable.id order by billable.id)
      from public.billable_events billable join public.appointments appointment
        on appointment.id = billable.appointment_id
      where appointment.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'booking_intents', coalesce((select jsonb_agg(to_jsonb(booking) order by booking.id)
      from public.booking_intents booking
      where booking.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'booking_slot_emissions', coalesce((select jsonb_agg(to_jsonb(emission) order by emission.id)
      from public.booking_slot_emissions emission
      where emission.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'booking_lifecycle_outbox', coalesce((select jsonb_agg(to_jsonb(event) order by event.id)
      from public.booking_lifecycle_outbox event
      join public.appointments appointment on appointment.id = event.appointment_id
      where appointment.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'outbound_send_attempts', coalesce((select jsonb_agg(to_jsonb(attempt) order by attempt.id)
      from public.outbound_send_attempts attempt
      where attempt.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'inbound_engine_turns', coalesce((select jsonb_agg(to_jsonb(turn) order by turn.inbound_message_id)
      from public.inbound_engine_turns turn
      where turn.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'qualification_turn_receipts', coalesce((select jsonb_agg(to_jsonb(receipt) order by receipt.inbound_message_id)
      from public.qualification_turn_receipts receipt
      where receipt.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'consent_binding_redemptions', coalesce((select jsonb_agg(to_jsonb(redemption)
        order by redemption.form_submission_id)
      from public.consent_binding_redemptions redemption
      join public.contact_identities identity on identity.id = redemption.contact_identity_id
      where identity.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))), '[]'::jsonb),
    'contact_merge_snapshots', coalesce((select jsonb_agg(to_jsonb(snapshot)
        order by snapshot.merge_audit_id)
      from public.contact_merge_snapshots snapshot
      where snapshot.winner_id = p_contact_id or snapshot.loser_id = p_contact_id), '[]'::jsonb)
  )::text, 'UTF8'), 'sha256'), 'hex')
$$;

create or replace function public.get_contact_deletion_cluster_metadata(
  p_expected_tenant uuid,
  p_contact_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  contact_ids uuid[];
begin
  if not exists (
    select 1 from public.contacts contact
    where contact.id = p_contact_id and contact.tenant_id = p_expected_tenant
      and contact.merged_into_contact_id is null
  ) then raise exception 'CONTACT_DELETE_CLUSTER_NOT_FOUND'; end if;
  contact_ids := app.contact_deletion_cluster_ids(p_contact_id);
  return jsonb_build_object(
    'contactIds', to_jsonb(contact_ids),
    'mergeAuditsRedacted', (
      select count(*) from public.contact_merge_snapshots snapshot
      where snapshot.winner_id = any(contact_ids) or snapshot.loser_id = any(contact_ids)
    )
  );
end;
$$;

create or replace function app.contact_deletion_provider_target_digest(p_contact_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(string_agg(
    target.frame, '' order by target.frame collate "C"
  ), ''), 'UTF8'), 'sha256'), 'hex')
  from (
    select distinct
      octet_length(identity.provider_account_id)::text || ':' || identity.provider_account_id ||
      octet_length(identity.ghl_install_id::text)::text || ':' || identity.ghl_install_id::text ||
      octet_length(identity.provider_identity_id)::text || ':' || identity.provider_identity_id
      as frame
    from public.contact_identities identity
    where identity.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
      and identity.provider = 'ghl'
      and nullif(btrim(identity.provider_identity_id), '') is not null
  ) target
$$;

create or replace function app.assert_contact_deletion_actor(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  success_owner_id uuid;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if p_expected_tenant is null then raise exception 'EXPECTED_TENANT_REQUIRED'; end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is not null and actor.role = 'coach'
    and actor.tenant_id = p_expected_tenant then return; end if;
  if actor.id is not null and actor.role in ('owner', 'admin') then return; end if;
  if actor.id is not null and actor.role = 'success' then
    select success_owner into success_owner_id from public.tenants where id = p_expected_tenant;
    if success_owner_id = p_actor_id then return; end if;
  end if;
  raise exception 'CONTACT_DELETE_ACTOR_NOT_AUTHORIZED';
end;
$$;

create or replace function app.assert_contact_deletion_recovery_actor(
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_role public.user_role;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role is null or actor_role not in ('owner', 'admin') then
    raise exception 'CONTACT_DELETE_RECOVERY_ACTOR_NOT_AUTHORIZED';
  end if;
end;
$$;

create or replace function public.preview_contact_deletion(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  preview_token uuid := gen_random_uuid();
  snapshot_digest text;
  target_digest text;
  logged_id bigint;
begin
  perform app.assert_contact_deletion_actor(p_expected_tenant, p_actor_id);
  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  if contact_row.merged_into_contact_id is not null then
    raise exception 'CONTACT_DELETE_USE_CANONICAL_CONTACT';
  end if;
  if contact_row.deletion_intent_id is not null then raise exception 'CONTACT_DELETE_ALREADY_CLAIMED'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  if exists (
    select 1 from public.contact_identities identity
    where identity.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
      and identity.provider = 'ghl'
      and (identity.provider_account_id is null or identity.ghl_install_id is null)
  ) then raise exception 'GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED'; end if;
  snapshot_digest := app.contact_deletion_snapshot_digest(p_contact_id);
  target_digest := app.contact_deletion_provider_target_digest(p_contact_id);
  update public.contacts set deletion_preview_token = preview_token,
    deletion_previewed_at = now(), deletion_preview_actor_id = p_actor_id,
    deletion_preview_snapshot_digest = snapshot_digest,
    deletion_preview_provider_target_digest = target_digest
  where id = p_contact_id;
  logged_id := app.write_audit_row(
    'contact.delete.preview', p_actor_id, p_expected_tenant, 'contact', p_contact_id::text,
    null, jsonb_build_object('preview_token', preview_token)
  );
  return jsonb_build_object(
    'previewToken', preview_token, 'auditId', logged_id,
    'mergedContacts', cardinality(app.contact_deletion_cluster_ids(p_contact_id)) - 1,
    'conversations', (select count(*) from public.conversations
      where contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'appointments', (select count(*) from public.appointments
      where contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'identities', (select count(*) from public.contact_identities
      where contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'contactNotes', (select count(*) from public.contact_notes
      where contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'unmatchedObjections', (select count(*) from public.unmatched_objections objection
      left join public.conversations conversation on conversation.id = objection.conversation_id
      left join public.messages message on message.id = objection.message_id
      left join public.conversations message_conversation
        on message_conversation.id = message.conversation_id
      where conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        or message_conversation.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'mergeAuditsRedacted', (select count(*) from public.contact_merge_snapshots snapshot
      where snapshot.winner_id = any(app.contact_deletion_cluster_ids(p_contact_id))
        or snapshot.loser_id = any(app.contact_deletion_cluster_ids(p_contact_id))),
    'snapshotDigest', snapshot_digest, 'providerTargetDigest', target_digest,
    'providerLimitations', jsonb_build_array('meta_thread_not_deleted_by_setterfi')
  );
end;
$$;

create or replace function app.reject_contact_deletion_intent_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_payload jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  new_payload jsonb := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  old_contact_id uuid;
  new_contact_id uuid;
  additional_contact_ids uuid[] := '{}'::uuid[];
  guarded_contact record;
begin
  if current_setting('app.contact_deletion_active', true) = 'true' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_table_name = 'contacts' then
    old_contact_id := (old_payload ->> 'id')::uuid;
    new_contact_id := (new_payload ->> 'id')::uuid;
  elsif tg_table_name = 'messages' then
    select contact_id into old_contact_id from public.conversations
      where id = nullif(old_payload ->> 'conversation_id', '')::uuid;
    select contact_id into new_contact_id from public.conversations
      where id = nullif(new_payload ->> 'conversation_id', '')::uuid;
  elsif tg_table_name = 'message_traces' then
    select conversation.contact_id into old_contact_id
    from public.messages message
    join public.conversations conversation on conversation.id = message.conversation_id
    where message.id = nullif(old_payload ->> 'message_id', '')::uuid;
    select conversation.contact_id into new_contact_id
    from public.messages message
    join public.conversations conversation on conversation.id = message.conversation_id
    where message.id = nullif(new_payload ->> 'message_id', '')::uuid;
  elsif tg_table_name = 'contact_duplicate_candidates' then
    additional_contact_ids := array[
      nullif(old_payload ->> 'contact_a_id', '')::uuid,
      nullif(old_payload ->> 'contact_b_id', '')::uuid,
      nullif(new_payload ->> 'contact_a_id', '')::uuid,
      nullif(new_payload ->> 'contact_b_id', '')::uuid
    ];
  elsif tg_table_name in ('brain_objection_usage_events', 'followups') then
    select contact_id into old_contact_id from public.conversations
      where id = nullif(old_payload ->> 'conversation_id', '')::uuid;
    select contact_id into new_contact_id from public.conversations
      where id = nullif(new_payload ->> 'conversation_id', '')::uuid;
  elsif tg_table_name = 'unmatched_objections' then
    select contact_id into old_contact_id from public.conversations
      where id = nullif(old_payload ->> 'conversation_id', '')::uuid;
    if old_contact_id is null then
      select conversation.contact_id into old_contact_id
      from public.messages message
      join public.conversations conversation on conversation.id = message.conversation_id
      where message.id = nullif(old_payload ->> 'message_id', '')::uuid;
    end if;
    select contact_id into new_contact_id from public.conversations
      where id = nullif(new_payload ->> 'conversation_id', '')::uuid;
    if new_contact_id is null then
      select conversation.contact_id into new_contact_id
      from public.messages message
      join public.conversations conversation on conversation.id = message.conversation_id
      where message.id = nullif(new_payload ->> 'message_id', '')::uuid;
    end if;
  elsif tg_table_name = 'consent_binding_redemptions' then
    select contact_id into old_contact_id from public.contact_identities
      where id = nullif(old_payload ->> 'contact_identity_id', '')::uuid;
    select contact_id into new_contact_id from public.contact_identities
      where id = nullif(new_payload ->> 'contact_identity_id', '')::uuid;
  elsif tg_table_name = 'eval_cases' then
    old_contact_id := nullif(old_payload ->> 'source_contact_id', '')::uuid;
    new_contact_id := nullif(new_payload ->> 'source_contact_id', '')::uuid;
    if old_contact_id is null then
      select contact_id into old_contact_id from public.conversations
        where id = nullif(old_payload ->> 'source_conversation_id', '')::uuid;
    end if;
    if new_contact_id is null then
      select contact_id into new_contact_id from public.conversations
        where id = nullif(new_payload ->> 'source_conversation_id', '')::uuid;
    end if;
  elsif tg_table_name in ('billable_events', 'booking_lifecycle_outbox') then
    select contact_id into old_contact_id from public.appointments
      where id = nullif(old_payload ->> 'appointment_id', '')::uuid;
    select contact_id into new_contact_id from public.appointments
      where id = nullif(new_payload ->> 'appointment_id', '')::uuid;
  else
    old_contact_id := nullif(old_payload ->> 'contact_id', '')::uuid;
    new_contact_id := nullif(new_payload ->> 'contact_id', '')::uuid;
  end if;
  for guarded_contact in
    select contact.id, contact.deletion_intent_id
    from public.contacts contact
    where contact.id in (
      select candidate from unnest(
        array_cat(array[old_contact_id, new_contact_id], additional_contact_ids)
      ) as candidates(candidate) where candidate is not null
    )
    order by contact.id
    for update
  loop
    if guarded_contact.deletion_intent_id is not null then
      raise exception 'CONTACT_DELETE_INTENT_MUTATION_BLOCKED';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger contacts_deletion_intent_guard
before update or delete on public.contacts
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger contact_identities_deletion_intent_guard
before insert or update or delete on public.contact_identities
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger contact_notes_deletion_intent_guard
before insert or update or delete on public.contact_notes
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger contact_duplicate_candidates_deletion_intent_guard
before insert or update or delete on public.contact_duplicate_candidates
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger conversations_deletion_intent_guard
before insert or update or delete on public.conversations
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger messages_deletion_intent_guard
before insert or update or delete on public.messages
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger message_traces_deletion_intent_guard
before insert or update or delete on public.message_traces
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger conversation_step_events_deletion_intent_guard
before insert or update or delete on public.conversation_step_events
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger brain_objection_usage_events_deletion_intent_guard
before insert or update or delete on public.brain_objection_usage_events
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger unmatched_objections_deletion_intent_guard
before insert or update or delete on public.unmatched_objections
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger appointments_deletion_intent_guard
before insert or update or delete on public.appointments
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger followups_deletion_intent_guard
before insert or update or delete on public.followups
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger suppression_entries_deletion_intent_guard
before insert or update or delete on public.suppression_entries
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger eval_cases_deletion_intent_guard
before insert or update or delete on public.eval_cases
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger billable_events_deletion_intent_guard
before insert or update or delete on public.billable_events
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger booking_intents_deletion_intent_guard
before insert or update or delete on public.booking_intents
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger booking_slot_emissions_deletion_intent_guard
before insert or update or delete on public.booking_slot_emissions
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger booking_lifecycle_outbox_deletion_intent_guard
before insert or update or delete on public.booking_lifecycle_outbox
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger outbound_send_attempts_deletion_intent_guard
before insert or update or delete on public.outbound_send_attempts
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger inbound_engine_turns_deletion_intent_guard
before insert or update or delete on public.inbound_engine_turns
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger qualification_turn_receipts_deletion_intent_guard
before insert or update or delete on public.qualification_turn_receipts
for each row execute function app.reject_contact_deletion_intent_mutation();
create trigger consent_binding_redemptions_deletion_intent_guard
before insert or update or delete on public.consent_binding_redemptions
for each row execute function app.reject_contact_deletion_intent_mutation();

create or replace function public.begin_contact_deletion_intent(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_preview_token uuid,
  p_lease_token uuid,
  p_idempotency_digest text,
  p_snapshot_digest text,
  p_provider_target_digest text
)
returns table (intent_id uuid, status text, provider_evidence jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  intent public.contact_deletion_intents%rowtype;
begin
  perform app.assert_contact_deletion_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_reason), '') is null or p_lease_token is null
    or p_idempotency_digest !~ '^[0-9a-f]{64}$'
    or p_snapshot_digest !~ '^[0-9a-f]{64}$'
    or p_provider_target_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'CONTACT_DELETE_INTENT_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':contact-delete:' || p_contact_id::text, 0
  ));

  select * into intent from public.contact_deletion_intents row
  where row.tenant_id = p_expected_tenant and row.contact_id = p_contact_id
    and row.idempotency_digest = p_idempotency_digest;
  if intent.id is not null then
    if intent.actor_id is distinct from p_actor_id or intent.preview_token <> p_preview_token
      or intent.snapshot_digest <> p_snapshot_digest
      or intent.provider_target_digest <> p_provider_target_digest
      or intent.reason <> btrim(p_reason) then
      raise exception 'CONTACT_DELETE_INTENT_REPLAY_MISMATCH';
    end if;
    if intent.recovery_lease_expires_at > now() then
      raise exception 'CONTACT_DELETE_RECOVERY_ACTIVE';
    end if;
    update public.contact_deletion_intents row
    set recovery_lease_token = p_lease_token,
        recovery_lease_expires_at = now() + interval '90 seconds',
        updated_at = now()
    where row.id = intent.id returning * into intent;
    return query select intent.id, intent.status, intent.provider_evidence;
    return;
  end if;

  if exists (
    select 1 from public.contact_deletion_intents row
    where row.tenant_id = p_expected_tenant and row.contact_id = p_contact_id
      and row.status <> 'completed'
  ) then raise exception 'CONTACT_DELETE_ALREADY_CLAIMED'; end if;

  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  if contact_row.merged_into_contact_id is not null then
    raise exception 'CONTACT_DELETE_USE_CANONICAL_CONTACT';
  end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  perform 1 from public.contacts contact
  where contact.id = any(app.contact_deletion_cluster_ids(p_contact_id))
  order by contact.id for update;
  if exists (
    select 1 from public.booking_intents booking
    where booking.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
      and booking.status in ('creating', 'provider_created')
  ) then raise exception 'CONTACT_DELETE_BOOKING_IN_FLIGHT'; end if;
  if exists (
    select 1 from public.contact_identities identity
    where identity.contact_id = any(app.contact_deletion_cluster_ids(p_contact_id))
      and identity.provider = 'ghl'
      and (identity.provider_account_id is null or identity.ghl_install_id is null)
  ) then raise exception 'GHL_IDENTITY_ACCOUNT_REMEDIATION_REQUIRED'; end if;
  if contact_row.deletion_preview_token is distinct from p_preview_token
    or contact_row.deletion_preview_actor_id is distinct from p_actor_id
    or contact_row.deletion_previewed_at < now() - interval '15 minutes'
    or contact_row.deletion_preview_snapshot_digest is distinct from p_snapshot_digest
    or contact_row.deletion_preview_provider_target_digest is distinct from p_provider_target_digest
    or app.contact_deletion_snapshot_digest(p_contact_id) is distinct from p_snapshot_digest
    or app.contact_deletion_provider_target_digest(p_contact_id) is distinct from p_provider_target_digest then
    raise exception 'CONTACT_DELETE_PREVIEW_STALE';
  end if;

  insert into public.contact_deletion_intents (
    tenant_id, contact_id, actor_id, preview_token, idempotency_digest,
    snapshot_digest, provider_target_digest, reason
  ) values (
    p_expected_tenant, p_contact_id, p_actor_id, p_preview_token, p_idempotency_digest,
    p_snapshot_digest, p_provider_target_digest, btrim(p_reason)
  ) returning * into intent;
  update public.contact_deletion_intents row
  set recovery_lease_token = p_lease_token,
      recovery_lease_expires_at = now() + interval '90 seconds'
  where row.id = intent.id returning * into intent;
  update public.contacts
  set deletion_intent_id = intent.id, deletion_pending_at = now()
  where id = any(app.contact_deletion_cluster_ids(p_contact_id));
  return query select intent.id, intent.status, intent.provider_evidence;
end;
$$;

create or replace function public.adopt_contact_deletion_recovery(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_intent_id uuid,
  p_reason text
)
returns table (
  intent_id uuid,
  status text,
  provider_evidence jsonb,
  recovery_audit_id bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  intent public.contact_deletion_intents%rowtype;
  logged_id bigint;
begin
  perform app.assert_contact_deletion_recovery_actor(p_actor_id);
  if nullif(btrim(p_reason), '') is null then
    raise exception 'CONTACT_DELETE_RECOVERY_REASON_REQUIRED';
  end if;
  select * into intent from public.contact_deletion_intents row
  where row.id = p_intent_id for update;
  if intent.id is null or intent.tenant_id <> p_expected_tenant
    or intent.status not in ('claimed', 'provider_confirmed') then
    raise exception 'CONTACT_DELETE_RECOVERY_NOT_AVAILABLE';
  end if;
  if intent.recovery_actor_id = p_actor_id
    and intent.recovery_reason = btrim(p_reason)
    and intent.recovery_audit_id is not null then
    return query select intent.id, intent.status, intent.provider_evidence, intent.recovery_audit_id;
    return;
  end if;
  logged_id := app.write_audit_row(
    'contact.delete.recovery_adopted', p_actor_id, p_expected_tenant,
    'contact_deletion_intent', intent.id::text, btrim(p_reason),
    jsonb_build_object(
      'contact_id', intent.contact_id,
      'prior_actor_id', intent.actor_id,
      'intent_status', intent.status
    )
  );
  update public.contact_deletion_intents row
  set recovery_actor_id = p_actor_id,
      recovery_reason = btrim(p_reason),
      recovery_adopted_at = now(),
      recovery_audit_id = logged_id,
      updated_at = now()
  where row.id = intent.id
  returning * into intent;
  return query select intent.id, intent.status, intent.provider_evidence, intent.recovery_audit_id;
end;
$$;

create or replace function public.renew_contact_deletion_lease(
  p_expected_tenant uuid,
  p_intent_id uuid,
  p_lease_token uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.contact_deletion_intents row
  set recovery_lease_expires_at = now() + interval '90 seconds', updated_at = now()
  where row.id = p_intent_id and row.tenant_id = p_expected_tenant
    and row.status <> 'completed'
    and row.recovery_lease_token = p_lease_token
    and row.recovery_lease_expires_at > now();
  if not found then raise exception 'CONTACT_DELETE_LEASE_LOST'; end if;
end;
$$;

create or replace function public.release_contact_deletion_lease(
  p_expected_tenant uuid,
  p_intent_id uuid,
  p_lease_token uuid
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.contact_deletion_intents row
  set recovery_lease_token = null, recovery_lease_expires_at = null, updated_at = now()
  where row.id = p_intent_id and row.tenant_id = p_expected_tenant
    and row.recovery_lease_token = p_lease_token and row.status <> 'completed';
end;
$$;

create or replace function public.checkpoint_contact_deletion_provider(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_intent_id uuid,
  p_lease_token uuid,
  p_provider_evidence jsonb
)
returns table (intent_id uuid, status text, provider_evidence jsonb)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare intent public.contact_deletion_intents%rowtype;
begin
  perform app.assert_contact_deletion_actor(p_expected_tenant, p_actor_id);
  if jsonb_typeof(p_provider_evidence) <> 'object'
    or p_provider_evidence ->> 'kind' not in ('not_applicable', 'confirmed_absent') then
    raise exception 'CONTACT_DELETE_PROVIDER_EVIDENCE_INVALID';
  end if;
  select * into intent from public.contact_deletion_intents row where row.id = p_intent_id for update;
  if intent.id is null or intent.tenant_id <> p_expected_tenant
    or (intent.actor_id is distinct from p_actor_id
      and intent.recovery_actor_id is distinct from p_actor_id)
    or intent.recovery_lease_token is distinct from p_lease_token
    or intent.recovery_lease_expires_at <= now() then
    raise exception 'CONTACT_DELETE_INTENT_SCOPE_INVALID';
  end if;
  if intent.status = 'claimed' then
    update public.contact_deletion_intents row
    set status = 'provider_confirmed', provider_evidence = p_provider_evidence,
        provider_confirmed_at = now(), updated_at = now()
    where row.id = intent.id returning * into intent;
  elsif intent.provider_evidence is distinct from p_provider_evidence then
    raise exception 'CONTACT_DELETE_PROVIDER_EVIDENCE_MISMATCH';
  end if;
  return query select intent.id, intent.status, intent.provider_evidence;
end;
$$;

create or replace function public.finalize_contact_deletion_intent(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_intent_id uuid,
  p_lease_token uuid,
  p_tombstone_channels public.messaging_channel[],
  p_tombstone_hashes text[],
  p_tombstone_last4s text[],
  p_provider_receipt jsonb
)
returns table (deleted boolean, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  intent public.contact_deletion_intents%rowtype;
  contact_row public.contacts%rowtype;
  deletion_contact_ids uuid[];
  logged_id bigint;
  system_lease_token uuid := nullif(
    current_setting('app.contact_deletion_system_lease', true), ''
  )::uuid;
  audit_actor_id uuid;
begin
  if system_lease_token is null then
    perform app.assert_contact_deletion_actor(p_expected_tenant, p_actor_id);
  elsif p_actor_id is not null then
    raise exception 'CONTACT_DELETE_SYSTEM_ACTOR_FORBIDDEN';
  end if;
  if coalesce(cardinality(p_tombstone_channels), 0)
      <> coalesce(cardinality(p_tombstone_hashes), 0)
    or coalesce(cardinality(p_tombstone_channels), 0)
      <> coalesce(cardinality(p_tombstone_last4s), 0)
    or jsonb_typeof(p_provider_receipt) <> 'object' then
    raise exception 'CONTACT_DELETE_FINALIZE_INPUT_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':contact-delete-intent:' || p_intent_id::text, 0
  ));
  select * into intent from public.contact_deletion_intents row where row.id = p_intent_id for update;
  if intent.id is null or intent.tenant_id <> p_expected_tenant
    or (system_lease_token is null and intent.actor_id is distinct from p_actor_id
      and intent.recovery_actor_id is distinct from p_actor_id)
    or (system_lease_token is not null and (
      intent.recovery_lease_token is distinct from system_lease_token
      or intent.recovery_lease_expires_at <= now()
    ))
    or intent.recovery_lease_token is distinct from p_lease_token
    or intent.recovery_lease_expires_at <= now() then
    raise exception 'CONTACT_DELETE_INTENT_SCOPE_INVALID';
  end if;
  if intent.status = 'completed' then
    return query select false, intent.audit_id;
    return;
  end if;
  if intent.status <> 'provider_confirmed'
    or p_provider_receipt ->> 'intentId' <> intent.id::text
    or p_provider_receipt -> 'providerEvidence' is distinct from intent.provider_evidence
    or p_provider_receipt ->> 'idempotencyDigest' <> intent.idempotency_digest then
    raise exception 'CONTACT_DELETE_INTENT_NOT_FINALIZABLE';
  end if;
  select * into contact_row from public.contacts where id = intent.contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  deletion_contact_ids := app.contact_deletion_cluster_ids(intent.contact_id);
  perform 1 from public.contacts contact
  where contact.id = any(deletion_contact_ids) order by contact.id for update;

  if coalesce(cardinality(p_tombstone_hashes), 0) > 0 then
    for item_index in 1..cardinality(p_tombstone_hashes) loop
      if p_tombstone_hashes[item_index] !~ '^[0-9a-f]{64}$' then
        raise exception 'CONTACT_DELETE_TOMBSTONE_HASH_INVALID';
      end if;
      if p_tombstone_last4s[item_index] is not null
        and char_length(p_tombstone_last4s[item_index]) not between 1 and 4 then
        raise exception 'CONTACT_DELETE_TOMBSTONE_LAST4_INVALID';
      end if;
    end loop;
  end if;

  perform app.redact_contact_merge_audits(p_expected_tenant, deletion_contact_ids);
  audit_actor_id := coalesce(p_actor_id, intent.recovery_actor_id, intent.actor_id);
  logged_id := app.write_audit_row(
    'contact.delete', audit_actor_id, p_expected_tenant, 'contact', intent.contact_id::text,
    intent.reason, jsonb_build_object('provider_receipt', p_provider_receipt,
      'tombstone_count', coalesce(cardinality(p_tombstone_hashes), 0),
      'deletion_intent_id', intent.id)
  );
  if coalesce(cardinality(p_tombstone_hashes), 0) > 0 then
    for item_index in 1..cardinality(p_tombstone_hashes) loop
      insert into public.suppression_tombstones (
        tenant_id, channel, identifier_hash, identifier_last4, deletion_audit_id
      ) values (
        p_expected_tenant, p_tombstone_channels[item_index], p_tombstone_hashes[item_index],
        p_tombstone_last4s[item_index], logged_id
      ) on conflict (tenant_id, channel, identifier_hash) do update
        set deletion_audit_id = excluded.deletion_audit_id,
            deleted_at = now(), identifier_last4 = excluded.identifier_last4;
    end loop;
  end if;
  perform set_config('app.contact_deletion_active', 'true', true);
  delete from public.unmatched_objections objection
  where objection.conversation_id in (
      select conversation.id from public.conversations conversation
      where conversation.contact_id = any(deletion_contact_ids)
    )
    or objection.message_id in (
      select message.id from public.messages message
      join public.conversations conversation on conversation.id = message.conversation_id
      where conversation.contact_id = any(deletion_contact_ids)
    );
  update public.eval_cases
  set source_tenant_id = null, source_conversation_id = null,
      source_message_id = null, source_contact_id = null,
      provenance_severed = true, quarantined = true
  where source_contact_id = any(deletion_contact_ids)
     or source_conversation_id in (
       select id from public.conversations where contact_id = any(deletion_contact_ids)
     );
  update public.billable_events billable
  set appointment_detached_at = now()
  from public.appointments appointment
  where appointment.id = billable.appointment_id
    and appointment.contact_id = any(deletion_contact_ids);
  delete from public.suppression_entries where contact_id = any(deletion_contact_ids);
  delete from public.contacts
  where id = any(deletion_contact_ids) and id <> intent.contact_id;
  delete from public.contacts where id = intent.contact_id;
  perform set_config('app.contact_deletion_active', '', true);

  update public.contact_deletion_intents row
  set status = 'completed', audit_id = logged_id, completed_at = now(), updated_at = now(),
      recovery_lease_token = null, recovery_lease_expires_at = null,
      recovery_last_error = null, recovery_operator_required = false
  where row.id = intent.id;
  return query select true, logged_id;
end;
$$;

create or replace function app.contact_deletion_actor_authorized(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_contact_deletion_actor(p_expected_tenant, p_actor_id);
  return true;
exception when others then
  return false;
end;
$$;

create or replace function public.claim_contact_deletion_recovery(
  p_limit integer default 10
)
returns table (
  intent_id uuid,
  tenant_id uuid,
  contact_id uuid,
  actor_id uuid,
  status text,
  provider_evidence jsonb,
  idempotency_digest text,
  actor_authorized boolean,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 25 then
    raise exception 'CONTACT_DELETE_RECOVERY_CLAIM_INVALID';
  end if;
  return query
  with candidates as (
    select row.id from public.contact_deletion_intents row
    where row.status in ('claimed', 'provider_confirmed')
      and row.updated_at < now() - interval '2 minutes'
      and coalesce(row.recovery_next_attempt_at, '-infinity'::timestamptz) <= now()
      and (row.recovery_lease_expires_at is null or row.recovery_lease_expires_at <= now())
      and not row.recovery_operator_required
    order by row.updated_at, row.id
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.contact_deletion_intents row
    set recovery_lease_token = gen_random_uuid(),
        recovery_lease_expires_at = now() + interval '90 seconds',
        recovery_attempt_count = row.recovery_attempt_count + 1,
        recovery_last_error = null,
        updated_at = now()
    from candidates where row.id = candidates.id
    returning row.*
  )
  select claimed.id, claimed.tenant_id, claimed.contact_id, claimed.actor_id,
    claimed.status, claimed.provider_evidence, claimed.idempotency_digest,
    app.contact_deletion_actor_authorized(claimed.tenant_id, claimed.actor_id),
    claimed.recovery_lease_token
  from claimed order by claimed.updated_at, claimed.id;
end;
$$;

create or replace function public.mark_contact_deletion_recovery(
  p_intent_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_error text default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare intent public.contact_deletion_intents%rowtype;
begin
  if p_outcome not in ('retry', 'operator_required', 'completed') then
    raise exception 'CONTACT_DELETE_RECOVERY_OUTCOME_INVALID';
  end if;
  select * into intent from public.contact_deletion_intents row
  where row.id = p_intent_id for update;
  if intent.id is null or intent.recovery_lease_token is distinct from p_lease_token then
    raise exception 'CONTACT_DELETE_RECOVERY_LEASE_INVALID';
  end if;
  update public.contact_deletion_intents row
  set recovery_lease_token = null,
      recovery_lease_expires_at = null,
      recovery_operator_required = p_outcome = 'operator_required',
      recovery_last_error = case when p_outcome = 'completed' then null
        else left(coalesce(nullif(btrim(p_error), ''), 'CONTACT_DELETE_RECOVERY_FAILED'), 240) end,
      recovery_next_attempt_at = case when p_outcome = 'retry'
        then now() + make_interval(secs => least(3600,
          (60 * power(2, least(recovery_attempt_count, 5)))::integer))
        else null end,
      updated_at = now()
  where row.id = intent.id;
end;
$$;

create or replace function public.claim_contact_deletion_recovery_intent(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_intent_id uuid,
  p_lease_token uuid
)
returns table (
  intent_id uuid,
  tenant_id uuid,
  contact_id uuid,
  actor_id uuid,
  status text,
  provider_evidence jsonb,
  idempotency_digest text,
  actor_authorized boolean,
  lease_token uuid
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare intent public.contact_deletion_intents%rowtype;
begin
  perform app.assert_contact_deletion_recovery_actor(p_actor_id);
  select * into intent from public.contact_deletion_intents row
  where row.id = p_intent_id for update;
  if intent.id is null or intent.tenant_id <> p_expected_tenant
    or intent.status not in ('claimed', 'provider_confirmed')
    or intent.recovery_actor_id is distinct from p_actor_id
    or (intent.recovery_lease_expires_at is not null and intent.recovery_lease_expires_at > now()) then
    raise exception 'CONTACT_DELETE_RECOVERY_INTENT_NOT_CLAIMABLE';
  end if;
  update public.contact_deletion_intents row
  set recovery_lease_token = p_lease_token,
      recovery_lease_expires_at = now() + interval '90 seconds',
      recovery_attempt_count = row.recovery_attempt_count + 1,
      recovery_operator_required = false,
      recovery_last_error = null,
      updated_at = now()
  where row.id = intent.id returning * into intent;
  return query select intent.id, intent.tenant_id, intent.contact_id, p_actor_id,
    intent.status, intent.provider_evidence, intent.idempotency_digest, true,
    intent.recovery_lease_token;
end;
$$;

create or replace function public.finalize_contact_deletion_recovery(
  p_expected_tenant uuid,
  p_intent_id uuid,
  p_lease_token uuid,
  p_tombstone_channels public.messaging_channel[],
  p_tombstone_hashes text[],
  p_tombstone_last4s text[],
  p_provider_receipt jsonb
)
returns table (deleted boolean, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_lease_token is null then raise exception 'CONTACT_DELETE_RECOVERY_LEASE_REQUIRED'; end if;
  perform set_config('app.contact_deletion_system_lease', p_lease_token::text, true);
  return query select * from public.finalize_contact_deletion_intent(
    p_expected_tenant, null, p_intent_id, p_lease_token, p_tombstone_channels,
    p_tombstone_hashes, p_tombstone_last4s, p_provider_receipt
  );
  perform set_config('app.contact_deletion_system_lease', '', true);
end;
$$;

create or replace function public.list_contact_deletion_recovery_intents(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns table (
  intent_id uuid,
  contact_id uuid,
  status text,
  operator_required boolean,
  last_error text,
  attempt_count integer,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.assert_contact_deletion_recovery_actor(p_actor_id);
  return query select row.id, row.contact_id, row.status, row.recovery_operator_required,
    row.recovery_last_error, row.recovery_attempt_count, row.updated_at
  from public.contact_deletion_intents row
  where row.tenant_id = p_expected_tenant and row.status <> 'completed'
  order by row.updated_at, row.id;
end;
$$;

create or replace function public.unmerge_contact(
  p_expected_tenant uuid,
  p_merge_audit_id bigint,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns table (
  winner_id uuid,
  loser_id uuid,
  unmerge_audit_id bigint,
  restored_identity_count integer,
  restored_conversation_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  merge_log public.audit_log%rowtype;
  merge_snapshot public.contact_merge_snapshots%rowtype;
  receipt_row public.channel_operation_receipts%rowtype;
  winner_snapshot jsonb;
  loser_snapshot jsonb;
  identities_snapshot jsonb;
  conversations_snapshot jsonb;
  candidates_snapshot jsonb;
  current_loser public.contacts%rowtype;
  payload jsonb;
  payload_hash text;
  winner_uuid uuid;
  loser_uuid uuid;
  expected_count integer;
  restored_identities integer;
  restored_conversations integer;
  written_audit_id bigint;
  candidate jsonb;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'CONTACT_UNMERGE_REASON_REQUIRED'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  payload := jsonb_build_object(
    'mergeAuditId', p_merge_audit_id, 'actorUserId', p_actor_id, 'reason', btrim(p_reason)
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':unmerge_contact:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt_row from public.channel_operation_receipts
  where tenant_id = p_expected_tenant and operation = 'unmerge_contact'
    and idempotency_key = btrim(p_idempotency_key);
  if receipt_row.id is not null then
    if receipt_row.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt_row.result ->> 'winnerId')::uuid,
      (receipt_row.result ->> 'loserId')::uuid,
      receipt_row.audit_id,
      (receipt_row.result ->> 'restoredIdentityCount')::integer,
      (receipt_row.result ->> 'restoredConversationCount')::integer;
    return;
  end if;

  select * into merge_log from public.audit_log
  where id = p_merge_audit_id and action = 'contact.merged' for share;
  select * into merge_snapshot from public.contact_merge_snapshots snapshot
  where snapshot.merge_audit_id = p_merge_audit_id for share;
  if merge_log.id is null or merge_snapshot.merge_audit_id is null then
    raise exception 'CONTACT_MERGE_AUDIT_NOT_FOUND';
  end if;
  perform app.assert_expected_tenant(p_expected_tenant, merge_log.tenant_id, 'merge_audit');
  perform app.assert_expected_tenant(p_expected_tenant, merge_snapshot.tenant_id, 'merge_snapshot');
  if merge_snapshot.payload_digest is distinct from encode(extensions.digest(
    convert_to(merge_snapshot.prior_payload::text, 'UTF8'), 'sha256'
  ), 'hex') then raise exception 'CONTACT_MERGE_SNAPSHOT_INVALID'; end if;
  winner_snapshot := merge_snapshot.prior_payload -> 'winner';
  loser_snapshot := merge_snapshot.prior_payload -> 'loser';
  identities_snapshot := coalesce(merge_snapshot.prior_payload -> 'identities', '[]'::jsonb);
  conversations_snapshot := coalesce(merge_snapshot.prior_payload -> 'conversations', '[]'::jsonb);
  candidates_snapshot := coalesce(merge_snapshot.prior_payload -> 'candidates', '[]'::jsonb);
  winner_uuid := (winner_snapshot ->> 'id')::uuid;
  loser_uuid := (loser_snapshot ->> 'id')::uuid;
  if winner_uuid is distinct from merge_snapshot.winner_id
    or loser_uuid is distinct from merge_snapshot.loser_id then
    raise exception 'CONTACT_MERGE_SNAPSHOT_INVALID';
  end if;

  if exists (
    select 1 from public.audit_log audit
    where audit.tenant_id = p_expected_tenant and audit.action = 'contact.unmerged'
      and audit.payload ->> 'mergeAuditId' = p_merge_audit_id::text
  ) then raise exception 'CONTACT_MERGE_ALREADY_UNDONE'; end if;

  perform 1 from public.contacts where id in (winner_uuid, loser_uuid) order by id for update;
  select * into current_loser from public.contacts where id = loser_uuid;
  if current_loser.id is null or current_loser.merged_into_contact_id <> winner_uuid
    or current_loser.merge_audit_id <> p_merge_audit_id then
    raise exception 'CONTACT_UNMERGE_STATE_CONFLICT';
  end if;

  expected_count := jsonb_array_length(identities_snapshot);
  select count(*)::integer into restored_identities
  from jsonb_array_elements(identities_snapshot) item
  join public.contact_identities identity
    on identity.id = (item ->> 'id')::uuid and identity.contact_id = winner_uuid;
  if restored_identities <> expected_count then raise exception 'CONTACT_UNMERGE_IDENTITY_CONFLICT'; end if;
  expected_count := jsonb_array_length(conversations_snapshot);
  select count(*)::integer into restored_conversations
  from jsonb_array_elements(conversations_snapshot) item
  join public.conversations conversation
    on conversation.id = (item ->> 'id')::uuid and conversation.contact_id = winner_uuid;
  if restored_conversations <> expected_count then raise exception 'CONTACT_UNMERGE_CONVERSATION_CONFLICT'; end if;

  update public.contact_identities identity set contact_id = loser_uuid
  from jsonb_array_elements(identities_snapshot) item
  where identity.id = (item ->> 'id')::uuid;
  update public.conversations conversation set contact_id = loser_uuid
  from jsonb_array_elements(conversations_snapshot) item
  where conversation.id = (item ->> 'id')::uuid;
  update public.contacts
  set opted_out = (winner_snapshot ->> 'opted_out')::boolean,
      credit_range = (winner_snapshot ->> 'credit_range')::public.credit_range,
      funding_goal = (winner_snapshot ->> 'funding_goal')::public.funding_goal,
      timeline = (winner_snapshot ->> 'timeline')::public.funding_timeline,
      business_stage = (winner_snapshot ->> 'business_stage')::public.business_stage,
      annual_revenue_cents = (winner_snapshot ->> 'annual_revenue_cents')::bigint,
      business_context = winner_snapshot ->> 'business_context',
      outcome = (winner_snapshot ->> 'outcome')::public.outcome,
      dq_reason = winner_snapshot ->> 'dq_reason',
      updated_at = now()
  where id = winner_uuid;
  update public.contacts
  set merged_into_contact_id = null, merged_at = null, merge_audit_id = null, updated_at = now()
  where id = loser_uuid;
  for candidate in select value from jsonb_array_elements(candidates_snapshot) loop
    update public.contact_duplicate_candidates
    set state = candidate ->> 'state',
        resolved_at = (candidate ->> 'resolved_at')::timestamptz,
        resolved_by = (candidate ->> 'resolved_by')::uuid,
        updated_at = now()
    where id = (candidate ->> 'id')::uuid;
  end loop;

  written_audit_id := app.write_audit_row(
    'contact.unmerged', p_actor_id, p_expected_tenant, 'contact', loser_uuid::text,
    btrim(p_reason),
    jsonb_build_object(
      'mergeAuditId', p_merge_audit_id,
      'prior', jsonb_build_object('winnerId', winner_uuid, 'loserMergedInto', winner_uuid),
      'new', jsonb_build_object(
        'winner', winner_snapshot, 'loser', loser_snapshot,
        'restoredIdentityCount', restored_identities,
        'restoredConversationCount', restored_conversations
      )
    )
  );
  delete from public.contact_merge_snapshots where merge_audit_id = p_merge_audit_id;
  insert into public.channel_operation_receipts (
    tenant_id, operation, idempotency_key, payload_hash, result, audit_id
  ) values (
    p_expected_tenant, 'unmerge_contact', btrim(p_idempotency_key), payload_hash,
    jsonb_build_object(
      'winnerId', winner_uuid, 'loserId', loser_uuid,
      'restoredIdentityCount', restored_identities,
      'restoredConversationCount', restored_conversations
    ), written_audit_id
  );
  return query select winner_uuid, loser_uuid, written_audit_id,
    restored_identities, restored_conversations;
end;
$$;

create or replace function public.mark_ghl_uninstalled_atomic(p_location_id text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare install public.ghl_installs%rowtype;
begin
  if nullif(btrim(p_location_id), '') is null then raise exception 'GHL_UNINSTALL_LOCATION_REQUIRED'; end if;
  select * into install from public.ghl_installs row
  where row.location_id = p_location_id for update;
  if install.id is null then return null; end if;
  delete from public.ghl_install_secrets where ghl_install_id = install.id;
  update public.ghl_installs row set install_state = 'uninstalled', updated_at = now()
  where row.id = install.id;
  return install.id;
end;
$$;

-- The phase-3 function performs the irreversible local delete directly and accepts only a loose
-- provider receipt. Remove it so stale service-role callers fail closed instead of bypassing the
-- durable intent/checkpoint/finalize saga above.
revoke execute on function public.delete_contact_compliance(
  uuid,uuid,uuid,text,uuid,public.messaging_channel[],text[],text[],jsonb
) from public, anon, authenticated, service_role;
drop function public.delete_contact_compliance(
  uuid,uuid,uuid,text,uuid,public.messaging_channel[],text[],text[],jsonb
);

revoke execute on function app.credential_envelope_valid(jsonb),
  app.enforce_contact_identity_provider_account(),
  app.capture_contact_merge_snapshot(),
  app.redact_contact_merge_audits(uuid,uuid[]),
  app.contact_deletion_cluster_ids(uuid),
  app.assert_contact_deletion_actor(uuid,uuid),
  app.assert_contact_deletion_recovery_actor(uuid),
  app.contact_deletion_actor_authorized(uuid,uuid),
  app.contact_deletion_snapshot_digest(uuid),
  app.contact_deletion_provider_target_digest(uuid),
  app.reject_contact_deletion_intent_mutation(),
  app.reject_audit_mutation()
from public, anon, authenticated, service_role;
revoke execute on function public.persist_inbound_message(
  uuid,public.channel_provider,public.messaging_channel,text,text,text,text,text,text,
  timestamptz,timestamptz,text
) from service_role;
revoke execute on function public.persist_inbound_message(
  uuid,public.channel_provider,public.messaging_channel,text,text,text,text,text,text,text,
  timestamptz,timestamptz,text
) from public, anon, authenticated;
grant execute on function public.persist_inbound_message(
  uuid,public.channel_provider,public.messaging_channel,text,text,text,text,text,text,text,
  timestamptz,timestamptz,text
) to service_role;
grant execute on function app.credential_envelope_valid(jsonb) to service_role;
revoke execute on function public.begin_contact_deletion_intent(uuid,uuid,uuid,text,uuid,uuid,text,text,text),
  public.get_contact_deletion_cluster_metadata(uuid,uuid),
  public.claim_contact_deletion_recovery(integer),
  public.mark_contact_deletion_recovery(uuid,uuid,text,text),
  public.claim_contact_deletion_recovery_intent(uuid,uuid,uuid,uuid),
  public.finalize_contact_deletion_recovery(uuid,uuid,uuid,public.messaging_channel[],text[],text[],jsonb),
  public.list_contact_deletion_recovery_intents(uuid,uuid),
  public.adopt_contact_deletion_recovery(uuid,uuid,uuid,text),
  public.renew_contact_deletion_lease(uuid,uuid,uuid),
  public.release_contact_deletion_lease(uuid,uuid,uuid),
  public.checkpoint_contact_deletion_provider(uuid,uuid,uuid,uuid,jsonb),
  public.finalize_contact_deletion_intent(uuid,uuid,uuid,uuid,public.messaging_channel[],text[],text[],jsonb),
  public.mark_ghl_uninstalled_atomic(text)
from public, anon, authenticated;
grant execute on function public.begin_contact_deletion_intent(uuid,uuid,uuid,text,uuid,uuid,text,text,text),
  public.get_contact_deletion_cluster_metadata(uuid,uuid),
  public.claim_contact_deletion_recovery(integer),
  public.mark_contact_deletion_recovery(uuid,uuid,text,text),
  public.claim_contact_deletion_recovery_intent(uuid,uuid,uuid,uuid),
  public.finalize_contact_deletion_recovery(uuid,uuid,uuid,public.messaging_channel[],text[],text[],jsonb),
  public.list_contact_deletion_recovery_intents(uuid,uuid),
  public.adopt_contact_deletion_recovery(uuid,uuid,uuid,text),
  public.renew_contact_deletion_lease(uuid,uuid,uuid),
  public.release_contact_deletion_lease(uuid,uuid,uuid),
  public.checkpoint_contact_deletion_provider(uuid,uuid,uuid,uuid,jsonb),
  public.finalize_contact_deletion_intent(uuid,uuid,uuid,uuid,public.messaging_channel[],text[],text[],jsonb),
  public.mark_ghl_uninstalled_atomic(text)
to service_role;
