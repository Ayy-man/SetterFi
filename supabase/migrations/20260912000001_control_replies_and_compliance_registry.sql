-- Tenant-scoped carrier control replies and the read model behind the compliance registry.
--
-- STOP/HELP/START classification is deterministic in the application, but its human-facing copy
-- must have an independently attributable approval.  Draft rows are deliberately unsendable;
-- publication creates an immutable audit receipt that binds the selected version and SHA-256 body.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  (
    'compliance.control_reply.published', 'human', 'tenant', true, true,
    'Control reply approval logged', 'Carrier control reply approval recorded in the audit log'
  );

create table public.tenant_control_reply_artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('stop', 'help', 'start')),
  version integer not null check (version > 0),
  body text not null check (
    nullif(btrim(body), '') is not null
    and body not like '%SETTERFI_DEMO_PLACEHOLDER_%'
  ),
  body_hash text not null check (
    body_hash ~ '^[0-9a-f]{64}$'
    and body_hash = encode(extensions.digest(convert_to(btrim(body), 'UTF8'), 'sha256'), 'hex')
  ),
  is_current boolean not null default true,
  is_published boolean not null default false,
  approval_reference text,
  approval_audit_id bigint references public.audit_log(id),
  published_at timestamptz,
  published_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  constraint tenant_control_reply_artifacts_publication_chk check (
    (not is_published
      and approval_reference is null
      and approval_audit_id is null
      and published_at is null
      and published_by is null)
    or (
      is_published
      and nullif(btrim(approval_reference), '') is not null
      and approval_audit_id is not null
      and published_at is not null
      and published_by is not null
    )
  ),
  unique (tenant_id, kind, version),
  unique (id, tenant_id)
);

create unique index tenant_control_reply_artifacts_current_uidx
  on public.tenant_control_reply_artifacts (tenant_id, kind) where is_current;
create index tenant_control_reply_artifacts_current_published_idx
  on public.tenant_control_reply_artifacts (tenant_id, kind, is_published)
  where is_current;

create or replace function app.enforce_control_reply_artifact_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.is_published and (
    new.tenant_id is distinct from old.tenant_id
    or new.kind is distinct from old.kind
    or new.version is distinct from old.version
    or new.body is distinct from old.body
    or new.body_hash is distinct from old.body_hash
    or new.is_published is distinct from old.is_published
    or new.approval_reference is distinct from old.approval_reference
    or new.approval_audit_id is distinct from old.approval_audit_id
    or new.published_at is distinct from old.published_at
    or new.published_by is distinct from old.published_by
    or (old.is_current = false and new.is_current <> false)
  ) then
    raise exception 'CONTROL_REPLY_ARTIFACT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger enforce_control_reply_artifact_immutable
before update on public.tenant_control_reply_artifacts
for each row execute function app.enforce_control_reply_artifact_immutable();

create or replace function app.enforce_control_reply_artifact_receipt()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_published and (tg_op = 'INSERT' or not old.is_published) and not exists (
    select 1 from public.audit_log audit
    where audit.id = new.approval_audit_id
      and audit.action = 'compliance.control_reply.published'
      and audit.tenant_id = new.tenant_id
      and audit.target_type = 'tenant_control_reply_artifact'
      and audit.target_id = new.id::text
      and audit.reason = new.approval_reference
      and audit.payload @> jsonb_build_object(
        'kind', new.kind,
        'version', new.version,
        'body_hash', new.body_hash
      )
  ) then
    raise exception 'CONTROL_REPLY_APPROVAL_RECEIPT_INVALID';
  end if;
  return new;
end;
$$;

create trigger enforce_control_reply_artifact_receipt
before insert or update on public.tenant_control_reply_artifacts
for each row execute function app.enforce_control_reply_artifact_receipt();

alter table public.tenant_control_reply_artifacts enable row level security;
alter table public.tenant_control_reply_artifacts force row level security;

create policy tenant_control_reply_artifacts_tenant_read
  on public.tenant_control_reply_artifacts for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy tenant_control_reply_artifacts_platform_read
  on public.tenant_control_reply_artifacts for select to authenticated
  using (app.is_platform_operator());

revoke all on table public.tenant_control_reply_artifacts from public, anon, authenticated, service_role;
grant select on table public.tenant_control_reply_artifacts to authenticated;
grant select, insert, update on table public.tenant_control_reply_artifacts to service_role;

create or replace function public.create_tenant_control_reply_artifact(
  p_expected_tenant uuid,
  p_kind text,
  p_body text,
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  artifact_id uuid;
  next_version integer;
  normalized_body text;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, true);
  normalized_body := nullif(btrim(p_body), '');
  if p_expected_tenant is null or p_kind not in ('stop', 'help', 'start') or normalized_body is null then
    raise exception 'CONTROL_REPLY_ARTIFACT_INVALID';
  end if;
  if normalized_body like '%SETTERFI_DEMO_PLACEHOLDER_%' then
    raise exception 'CONTROL_REPLY_PLACEHOLDER_FORBIDDEN';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_expected_tenant::text || ':' || p_kind, 0
  ));
  select coalesce(max(version), 0) + 1 into next_version
  from public.tenant_control_reply_artifacts
  where tenant_id = p_expected_tenant and kind = p_kind;
  update public.tenant_control_reply_artifacts
  set is_current = false
  where tenant_id = p_expected_tenant and kind = p_kind and is_current;
  insert into public.tenant_control_reply_artifacts (
    tenant_id, kind, version, body, body_hash, is_current
  ) values (
    p_expected_tenant, p_kind, next_version, normalized_body,
    encode(extensions.digest(convert_to(normalized_body, 'UTF8'), 'sha256'), 'hex'), true
  ) returning id into artifact_id;
  return artifact_id;
end;
$$;

create or replace function public.publish_tenant_control_reply_artifact(
  p_expected_tenant uuid,
  p_artifact_id uuid,
  p_actor_id uuid,
  p_approval_reference text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  artifact_row public.tenant_control_reply_artifacts%rowtype;
  audit_id bigint;
  normalized_reference text;
begin
  perform app.assert_not_impersonating();
  perform app.assert_phase5_actor(p_actor_id, p_expected_tenant, true);
  normalized_reference := nullif(btrim(p_approval_reference), '');
  if normalized_reference is null then raise exception 'CONTROL_REPLY_APPROVAL_REFERENCE_REQUIRED'; end if;
  select * into artifact_row from public.tenant_control_reply_artifacts where id = p_artifact_id for update;
  if artifact_row.id is null then raise exception 'CONTROL_REPLY_ARTIFACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, artifact_row.tenant_id, 'control_reply_artifact');
  if not artifact_row.is_current then raise exception 'CONTROL_REPLY_ARTIFACT_NOT_CURRENT'; end if;
  if artifact_row.is_published then
    select id into audit_id from public.audit_log
    where action = 'compliance.control_reply.published' and target_id = p_artifact_id::text
    order by id desc limit 1;
    if audit_id is null then raise exception 'CONTROL_REPLY_APPROVAL_RECEIPT_MISSING'; end if;
    return audit_id;
  end if;

  audit_id := app.write_audit_row(
    'compliance.control_reply.published', p_actor_id, p_expected_tenant,
    'tenant_control_reply_artifact', p_artifact_id::text, normalized_reference,
    jsonb_build_object('kind', artifact_row.kind, 'version', artifact_row.version, 'body_hash', artifact_row.body_hash)
  );
  update public.tenant_control_reply_artifacts
  set is_published = true,
      approval_reference = normalized_reference,
      approval_audit_id = audit_id,
      published_at = now(),
      published_by = p_actor_id
  where id = p_artifact_id;
  return audit_id;
end;
$$;

revoke all on function public.create_tenant_control_reply_artifact(uuid, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.publish_tenant_control_reply_artifact(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_tenant_control_reply_artifact(uuid, text, text, uuid)
  to service_role;
grant execute on function public.publish_tenant_control_reply_artifact(uuid, uuid, uuid, text)
  to service_role;

-- One RPC defines the complete cohort for all three registry tables.  The caller supplies either
-- an impersonated tenant id or null for a platform-wide view, then reuses these exact parameters
-- when asking the export lane for CSV or JSON.
create or replace function public.read_compliance_registry_page(
  p_tenant_id uuid,
  p_resource text,
  p_page_size integer,
  p_offset integer,
  p_search text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized_search text;
begin
  if p_resource not in ('suppressions', 'tombstones', 'contacts') then
    raise exception 'COMPLIANCE_REGISTRY_RESOURCE_INVALID';
  end if;
  if p_page_size not between 1 and 100 or p_offset < 0 then
    raise exception 'COMPLIANCE_REGISTRY_PAGE_INVALID';
  end if;
  normalized_search := nullif(btrim(regexp_replace(coalesce(p_search, ''), '[[:space:]]+', ' ', 'g')), '');
  if normalized_search is not null and char_length(normalized_search) > 120 then
    raise exception 'COMPLIANCE_REGISTRY_SEARCH_INVALID';
  end if;

  return (
    with records as (
      select
        entry.id::text as row_id,
        entry.created_at as sort_at,
        jsonb_build_object(
          'id', entry.id::text,
          'tenantName', coalesce(tenant.name, 'Platform'),
          'contactName', contact.name,
          'channel', entry.channel::text,
          'identifierLast4', entry.identifier_last4,
          'source', entry.source,
          'providerSyncState', entry.provider_sync_state,
          'providerSyncedAt', entry.provider_synced_at,
          'createdAt', entry.created_at,
          'isDemo', coalesce(tenant.is_demo, false),
          'isTest', coalesce(contact.is_test, false)
        ) as payload,
        lower(concat_ws(' ', tenant.name, contact.name, entry.channel::text, entry.identifier_last4,
          entry.source, entry.provider_sync_state)) as search_text
      from public.suppression_entries entry
      left join public.tenants tenant on tenant.id = entry.tenant_id
      left join public.contacts contact on contact.id = entry.contact_id and contact.tenant_id = entry.tenant_id
      where p_resource = 'suppressions' and (p_tenant_id is null or entry.tenant_id = p_tenant_id)

      union all

      select
        tombstone.id::text as row_id,
        tombstone.created_at as sort_at,
        jsonb_build_object(
          'id', tombstone.id::text,
          'tenantName', coalesce(tenant.name, 'Unknown tenant'),
          'channel', tombstone.channel::text,
          'identifierLast4', tombstone.identifier_last4,
          'deletionAuditId', tombstone.deletion_audit_id,
          'createdAt', tombstone.created_at,
          'isDemo', coalesce(tenant.is_demo, false)
        ) as payload,
        lower(concat_ws(' ', tenant.name, tombstone.channel::text, tombstone.identifier_last4,
          tombstone.deletion_audit_id::text)) as search_text
      from public.suppression_tombstones tombstone
      join public.tenants tenant on tenant.id = tombstone.tenant_id
      where p_resource = 'tombstones' and (p_tenant_id is null or tombstone.tenant_id = p_tenant_id)

      union all

      select
        contact.id::text as row_id,
        coalesce(contact.last_seen_at, contact.created_at) as sort_at,
        jsonb_build_object(
          'id', contact.id::text,
          'tenantId', contact.tenant_id::text,
          'tenantName', coalesce(tenant.name, 'Unknown tenant'),
          'name', coalesce(nullif(btrim(contact.name), ''), 'Unnamed contact'),
          'pipelineStage', contact.pipeline_stage::text,
          'lastSeenAt', coalesce(contact.last_seen_at, contact.created_at),
          'isDemo', coalesce(tenant.is_demo, false),
          'isTest', contact.is_test
        ) as payload,
        lower(concat_ws(' ', tenant.name, contact.name, contact.pipeline_stage::text)) as search_text
      from public.contacts contact
      join public.tenants tenant on tenant.id = contact.tenant_id
      where p_resource = 'contacts'
        and contact.merged_into_contact_id is null
        and (p_tenant_id is null or contact.tenant_id = p_tenant_id)
    ),
    filtered as (
      select * from records
      where normalized_search is null or position(lower(normalized_search) in search_text) > 0
    ),
    paged as (
      select * from filtered order by sort_at desc, row_id desc
      limit p_page_size offset p_offset
    )
    select jsonb_build_object(
      'rows', coalesce(jsonb_agg(payload order by sort_at desc, row_id desc), '[]'::jsonb),
      'total_rows', (select count(*) from filtered)
    ) from paged
  );
end;
$$;

revoke all on function public.read_compliance_registry_page(uuid, text, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.read_compliance_registry_page(uuid, text, integer, integer, text)
  to service_role;

comment on table public.tenant_control_reply_artifacts is
  'Per-tenant versioned STOP/HELP/START copy. Only a published row with a matching receipt and body hash may be sent.';
comment on function public.read_compliance_registry_page(uuid, text, integer, integer, text) is
  'Exact-count, stable-order, server-filtered page for compliance tables. CSV/JSON callers must pass the same resource and search values.';
