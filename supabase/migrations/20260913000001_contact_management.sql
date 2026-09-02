-- Coach contact management: identity-safe manual creation/import, contact notes, and tenant tags.
-- All mutations are service-role RPCs so the tenant assertion, audit receipt, and state change share
-- one transaction. Raw identity values are deliberately never copied into audit payloads.

set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('contact.created.manual', 'human', 'tenant', false, true,
    'Contact creation logged', 'Manual contact creation recorded in the audit log'),
  ('contact.imported', 'human', 'tenant', false, true,
    'Contact import logged', 'Contact import recorded in the audit log'),
  ('contact.note.added', 'human', 'tenant', false, true,
    'Contact note logged', 'Contact note recorded in the audit log'),
  ('contact.tag.added', 'human', 'tenant', false, true,
    'Contact tag logged', 'Contact tag assignment recorded in the audit log'),
  ('contact.tag.removed', 'human', 'tenant', false, true,
    'Contact tag removal logged', 'Contact tag removal recorded in the audit log')
on conflict (key) do nothing;

create table public.contact_tags (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 80),
  normalized_label text generated always as (lower(btrim(label))) stored,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, normalized_label)
);

create table public.contact_tag_assignments (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tag_id uuid not null references public.contact_tags(id) on delete cascade,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (contact_id, tag_id)
);
create index contact_tag_assignments_tenant_contact_idx
  on public.contact_tag_assignments (tenant_id, contact_id, created_at desc);

create table public.contact_mutation_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  operation text not null check (operation in ('manual_create', 'import')),
  idempotency_key text not null check (
    char_length(btrim(idempotency_key)) between 1 and 128
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  outcomes jsonb not null check (jsonb_typeof(outcomes) = 'array'),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, operation, idempotency_key)
);

create or replace function app.enforce_contact_tag_assignment_tenant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_tenant uuid;
  tag_tenant uuid;
begin
  select tenant_id into contact_tenant from public.contacts where id = new.contact_id;
  select tenant_id into tag_tenant from public.contact_tags where id = new.tag_id;
  if contact_tenant is null or tag_tenant is null
    or contact_tenant <> new.tenant_id or tag_tenant <> new.tenant_id then
    raise exception 'CONTACT_TAG_TENANT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger contact_tag_assignments_tenant_guard
before insert or update of tenant_id, contact_id, tag_id on public.contact_tag_assignments
for each row execute function app.enforce_contact_tag_assignment_tenant();

-- The same identity normalisation, identity uniqueness, merged-contact refusal, and GHL binding
-- guard used by inbound persistence apply here. The helper is intentionally not exposed to
-- PostgREST; public RPCs below are its only callers.
create or replace function app.create_or_merge_contact_identity(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_name text,
  p_provider public.channel_provider,
  p_channel public.messaging_channel,
  p_provider_identity_id text,
  p_provider_account_id text,
  p_normalized_phone text,
  p_normalized_email text,
  p_audit_action text,
  p_source text
)
returns table (contact_id uuid, identity_id uuid, outcome text, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  identity_row public.contact_identities%rowtype;
  contact_row public.contacts%rowtype;
  install_row public.ghl_installs%rowtype;
  normalized_identity_id text := nullif(btrim(p_provider_identity_id), '');
  normalized_account_id text := nullif(btrim(p_provider_account_id), '');
  written_audit_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if normalized_identity_id is null then raise exception 'CONTACT_IDENTITY_ID_REQUIRED'; end if;
  if p_provider = 'ghl' and normalized_account_id is null then
    raise exception 'GHL_PROVIDER_ACCOUNT_ID_REQUIRED';
  end if;
  if p_provider <> 'ghl' and normalized_account_id is not null then
    raise exception 'NON_GHL_PROVIDER_ACCOUNT_ID_FORBIDDEN';
  end if;

  -- This is the same advisory-lock key and unique identity boundary as inbound persistence.
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':' || p_provider::text || ':' || p_channel::text || ':' ||
      normalized_identity_id, 0
  ));

  if p_provider = 'ghl' then
    select * into install_row from public.ghl_installs install
    where install.tenant_id = p_expected_tenant and install.location_id = normalized_account_id
    for share;
    if install_row.id is null then raise exception 'GHL_IDENTITY_ACCOUNT_BINDING_REQUIRED'; end if;
  end if;

  select * into identity_row from public.contact_identities identity
  where identity.tenant_id = p_expected_tenant
    and identity.provider = p_provider
    and identity.channel = p_channel
    and identity.provider_identity_id = normalized_identity_id
  for update;

  if identity_row.id is not null then
    select * into contact_row from public.contacts contact where contact.id = identity_row.contact_id
    for update;
    perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
    if contact_row.merged_into_contact_id is not null then
      raise exception 'INBOUND_IDENTITY_POINTS_TO_MERGED_CONTACT';
    end if;
    if p_provider = 'ghl' and (
      identity_row.provider_account_id is distinct from normalized_account_id
      or identity_row.ghl_install_id is distinct from install_row.id
    ) then
      raise exception 'GHL_IDENTITY_ACCOUNT_BINDING_MISMATCH';
    end if;
    written_audit_id := app.write_audit_row(
      p_audit_action, p_actor_id, p_expected_tenant, 'contact', contact_row.id::text, null,
      jsonb_build_object(
        'source', p_source,
        'outcome', 'merged_existing_identity',
        'provider', p_provider::text,
        'channel', p_channel::text,
        'identityId', identity_row.id
      )
    );
    return query select contact_row.id, identity_row.id, 'merged_existing_identity', written_audit_id;
    return;
  end if;

  insert into public.contacts (tenant_id, last_channel, name, last_seen_at)
  values (p_expected_tenant, p_channel, nullif(btrim(p_name), ''), null)
  returning * into contact_row;

  insert into public.contact_identities (
    tenant_id, contact_id, provider, channel, provider_identity_id,
    provider_account_id, ghl_install_id, normalized_phone, normalized_email,
    consent_state, consent_source
  ) values (
    p_expected_tenant, contact_row.id, p_provider, p_channel, normalized_identity_id,
    case when p_provider = 'ghl' then install_row.location_id else null end,
    case when p_provider = 'ghl' then install_row.id else null end,
    nullif(btrim(p_normalized_phone), ''), lower(nullif(btrim(p_normalized_email), '')),
    'none', null
  ) returning * into identity_row;

  written_audit_id := app.write_audit_row(
    p_audit_action, p_actor_id, p_expected_tenant, 'contact', contact_row.id::text, null,
    jsonb_build_object(
      'source', p_source,
      'outcome', 'created',
      'provider', p_provider::text,
      'channel', p_channel::text,
      'identityId', identity_row.id
    )
  );
  return query select contact_row.id, identity_row.id, 'created', written_audit_id;
end;
$$;

create or replace function public.create_manual_contact(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_name text,
  p_provider text,
  p_channel text,
  p_provider_identity_id text,
  p_provider_account_id text,
  p_normalized_phone text,
  p_normalized_email text,
  p_idempotency_key text
)
returns table (contact_id uuid, identity_id uuid, outcome text, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  receipt public.contact_mutation_receipts%rowtype;
  payload jsonb;
  payload_hash text;
  mutation_row record;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if p_provider not in ('meta_direct', 'ghl') or p_channel not in (
    'instagram', 'messenger', 'sms', 'whatsapp', 'webchat'
  ) then raise exception 'CONTACT_IDENTITY_PROVIDER_OR_CHANNEL_INVALID'; end if;
  payload := jsonb_build_object(
    'name', nullif(btrim(p_name), ''), 'provider', p_provider, 'channel', p_channel,
    'providerIdentityId', nullif(btrim(p_provider_identity_id), ''),
    'providerAccountId', nullif(btrim(p_provider_account_id), ''),
    'normalizedPhone', nullif(btrim(p_normalized_phone), ''),
    'normalizedEmail', lower(nullif(btrim(p_normalized_email), ''))
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':manual_create:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt from public.contact_mutation_receipts row
  where row.tenant_id = p_expected_tenant and row.operation = 'manual_create'
    and row.idempotency_key = btrim(p_idempotency_key)
  for share;
  if receipt.id is not null then
    if receipt.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt.outcomes -> 0 ->> 'contactId')::uuid,
      (receipt.outcomes -> 0 ->> 'identityId')::uuid,
      receipt.outcomes -> 0 ->> 'outcome',
      (receipt.outcomes -> 0 ->> 'auditId')::bigint;
    return;
  end if;
  select * into mutation_row from app.create_or_merge_contact_identity(
    p_expected_tenant, p_actor_id, p_name, p_provider::public.channel_provider,
    p_channel::public.messaging_channel, p_provider_identity_id, p_provider_account_id,
    p_normalized_phone, p_normalized_email, 'contact.created.manual', 'manual'
  );
  insert into public.contact_mutation_receipts
    (tenant_id, operation, idempotency_key, payload_hash, outcomes, audit_id)
  values (
    p_expected_tenant, 'manual_create', btrim(p_idempotency_key), payload_hash,
    jsonb_build_array(jsonb_build_object(
      'contactId', mutation_row.contact_id, 'identityId', mutation_row.identity_id,
      'outcome', mutation_row.outcome, 'auditId', mutation_row.audit_id
    )), mutation_row.audit_id
  );
  return query select mutation_row.contact_id, mutation_row.identity_id,
    mutation_row.outcome, mutation_row.audit_id;
end;
$$;

create or replace function public.import_contacts(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_rows jsonb,
  p_idempotency_key text
)
returns table (outcomes jsonb, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  receipt public.contact_mutation_receipts%rowtype;
  row_value jsonb;
  row_index integer := 0;
  result jsonb := '[]'::jsonb;
  payload_hash text;
  row_result record;
  created_count integer := 0;
  merged_count integer := 0;
  rejected_count integer := 0;
  import_audit_id bigint;
  provider_value text;
  channel_value text;
  identity_value text;
  account_value text;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'CONTACT_IMPORT_ROWS_INVALID';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  payload_hash := app.phase4_json_hash(p_rows);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':contact_import:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt from public.contact_mutation_receipts row
  where row.tenant_id = p_expected_tenant and row.operation = 'import'
    and row.idempotency_key = btrim(p_idempotency_key)
  for share;
  if receipt.id is not null then
    if receipt.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select receipt.outcomes, receipt.audit_id;
    return;
  end if;

  for row_value in select value from jsonb_array_elements(p_rows) loop
    provider_value := nullif(btrim(row_value ->> 'provider'), '');
    channel_value := nullif(btrim(row_value ->> 'channel'), '');
    identity_value := nullif(btrim(row_value ->> 'providerIdentityId'), '');
    account_value := nullif(btrim(row_value ->> 'providerAccountId'), '');
    if jsonb_typeof(row_value) <> 'object'
      or provider_value not in ('meta_direct', 'ghl')
      or channel_value not in ('instagram', 'messenger', 'sms', 'whatsapp', 'webchat')
      or identity_value is null
      or (provider_value = 'ghl' and account_value is null)
      or (provider_value <> 'ghl' and account_value is not null) then
      result := result || jsonb_build_array(jsonb_build_object(
        'row', row_index, 'outcome', 'rejected', 'reason', 'CONTACT_IMPORT_ROW_INVALID'
      ));
      rejected_count := rejected_count + 1;
    else
      select * into row_result from app.create_or_merge_contact_identity(
        p_expected_tenant, p_actor_id, row_value ->> 'name', provider_value::public.channel_provider,
        channel_value::public.messaging_channel, identity_value, account_value,
        row_value ->> 'normalizedPhone', row_value ->> 'normalizedEmail',
        'contact.created.manual', 'import'
      );
      result := result || jsonb_build_array(jsonb_build_object(
        'row', row_index, 'outcome', row_result.outcome, 'contactId', row_result.contact_id,
        'identityId', row_result.identity_id, 'auditId', row_result.audit_id
      ));
      if row_result.outcome = 'created' then created_count := created_count + 1;
      else merged_count := merged_count + 1;
      end if;
    end if;
    row_index := row_index + 1;
  end loop;

  import_audit_id := app.write_audit_row(
    'contact.imported', p_actor_id, p_expected_tenant, 'contact_import', btrim(p_idempotency_key), null,
    jsonb_build_object(
      'rowCount', row_index, 'createdCount', created_count, 'mergedCount', merged_count,
      'rejectedCount', rejected_count
    )
  );
  insert into public.contact_mutation_receipts
    (tenant_id, operation, idempotency_key, payload_hash, outcomes, audit_id)
  values (p_expected_tenant, 'import', btrim(p_idempotency_key), payload_hash, result, import_audit_id);
  return query select result, import_audit_id;
end;
$$;

create or replace function public.add_contact_note(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid,
  p_body text
)
returns table (note_id uuid, created_at timestamptz, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  note_row public.contact_notes%rowtype;
  written_audit_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_body), '') is null or char_length(btrim(p_body)) > 2000 then
    raise exception 'CONTACT_NOTE_BODY_INVALID';
  end if;
  select * into contact_row from public.contacts contact where contact.id = p_contact_id for share;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  insert into public.contact_notes (tenant_id, contact_id, body, created_by)
  values (p_expected_tenant, contact_row.id, btrim(p_body), p_actor_id)
  returning * into note_row;
  written_audit_id := app.write_audit_row(
    'contact.note.added', p_actor_id, p_expected_tenant, 'contact', contact_row.id::text, null,
    jsonb_build_object('noteId', note_row.id)
  );
  return query select note_row.id, note_row.created_at, written_audit_id;
end;
$$;

create or replace function public.add_contact_tag(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid,
  p_label text
)
returns table (tag_id uuid, label text, tag_created_at timestamptz, added boolean, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  tag_row public.contact_tags%rowtype;
  assignment_count integer;
  written_audit_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_label), '') is null or char_length(btrim(p_label)) > 80 then
    raise exception 'CONTACT_TAG_LABEL_INVALID';
  end if;
  select * into contact_row from public.contacts contact where contact.id = p_contact_id for share;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  insert into public.contact_tags (tenant_id, label, created_by)
  values (p_expected_tenant, btrim(p_label), p_actor_id)
  on conflict (tenant_id, normalized_label) do update set label = public.contact_tags.label
  returning * into tag_row;
  insert into public.contact_tag_assignments (tenant_id, contact_id, tag_id, created_by)
  values (p_expected_tenant, contact_row.id, tag_row.id, p_actor_id)
  on conflict do nothing;
  get diagnostics assignment_count = row_count;
  written_audit_id := app.write_audit_row(
    'contact.tag.added', p_actor_id, p_expected_tenant, 'contact', contact_row.id::text, null,
    jsonb_build_object('tagId', tag_row.id, 'added', assignment_count > 0)
  );
  return query select tag_row.id, tag_row.label, tag_row.created_at, assignment_count > 0, written_audit_id;
end;
$$;

create or replace function public.remove_contact_tag(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid,
  p_tag_id uuid
)
returns table (removed boolean, audit_id bigint)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  removed_count integer;
  written_audit_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  select * into contact_row from public.contacts contact where contact.id = p_contact_id for share;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  delete from public.contact_tag_assignments assignment
  where assignment.tenant_id = p_expected_tenant and assignment.contact_id = contact_row.id
    and assignment.tag_id = p_tag_id;
  get diagnostics removed_count = row_count;
  written_audit_id := app.write_audit_row(
    'contact.tag.removed', p_actor_id, p_expected_tenant, 'contact', contact_row.id::text, null,
    jsonb_build_object('tagId', p_tag_id, 'removed', removed_count > 0)
  );
  return query select removed_count > 0, written_audit_id;
end;
$$;

create or replace function public.list_contact_notes(
  p_expected_tenant uuid,
  p_contact_id uuid
)
returns table (id uuid, body text, created_by uuid, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare contact_row public.contacts%rowtype;
begin
  select * into contact_row from public.contacts contact where contact.id = p_contact_id;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  return query select note.id, note.body, note.created_by, note.created_at
  from public.contact_notes note
  where note.tenant_id = p_expected_tenant and note.contact_id = contact_row.id
  order by note.created_at desc, note.id desc;
end;
$$;

create or replace function public.list_contact_tags(
  p_expected_tenant uuid,
  p_contact_id uuid
)
returns table (id uuid, label text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare contact_row public.contacts%rowtype;
begin
  select * into contact_row from public.contacts contact where contact.id = p_contact_id;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  return query select tag.id, tag.label, assignment.created_at
  from public.contact_tag_assignments assignment
  join public.contact_tags tag on tag.id = assignment.tag_id
  where assignment.tenant_id = p_expected_tenant and assignment.contact_id = contact_row.id
  order by tag.normalized_label, tag.id;
end;
$$;

alter table public.contact_tags enable row level security;
alter table public.contact_tags force row level security;
alter table public.contact_tag_assignments enable row level security;
alter table public.contact_tag_assignments force row level security;
alter table public.contact_mutation_receipts enable row level security;
alter table public.contact_mutation_receipts force row level security;
alter table public.contact_notes enable row level security;
alter table public.contact_notes force row level security;

revoke all on public.contact_tags, public.contact_tag_assignments, public.contact_mutation_receipts
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.contact_tags, public.contact_tag_assignments,
  public.contact_mutation_receipts to service_role;

drop policy if exists contact_tags_tenant_read on public.contact_tags;
create policy contact_tags_tenant_read on public.contact_tags for select to authenticated
  using (app.owns_tenant(tenant_id));
drop policy if exists contact_tags_platform_read on public.contact_tags;
create policy contact_tags_platform_read on public.contact_tags for select to authenticated
  using (app.is_platform_operator());
drop policy if exists contact_tag_assignments_tenant_read on public.contact_tag_assignments;
create policy contact_tag_assignments_tenant_read on public.contact_tag_assignments for select to authenticated
  using (app.owns_tenant(tenant_id));
drop policy if exists contact_tag_assignments_platform_read on public.contact_tag_assignments;
create policy contact_tag_assignments_platform_read on public.contact_tag_assignments for select to authenticated
  using (app.is_platform_operator());

grant select on public.contact_tags, public.contact_tag_assignments to authenticated;

revoke execute on function app.enforce_contact_tag_assignment_tenant(),
  app.create_or_merge_contact_identity(uuid,uuid,text,public.channel_provider,public.messaging_channel,text,text,text,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.create_manual_contact(uuid,uuid,text,text,text,text,text,text,text,text),
  public.import_contacts(uuid,uuid,jsonb,text),
  public.add_contact_note(uuid,uuid,uuid,text),
  public.add_contact_tag(uuid,uuid,uuid,text),
  public.remove_contact_tag(uuid,uuid,uuid,uuid),
  public.list_contact_notes(uuid,uuid),
  public.list_contact_tags(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.create_manual_contact(uuid,uuid,text,text,text,text,text,text,text,text),
  public.import_contacts(uuid,uuid,jsonb,text),
  public.add_contact_note(uuid,uuid,uuid,text),
  public.add_contact_tag(uuid,uuid,uuid,text),
  public.remove_contact_tag(uuid,uuid,uuid,uuid),
  public.list_contact_notes(uuid,uuid),
  public.list_contact_tags(uuid,uuid)
  to service_role;
