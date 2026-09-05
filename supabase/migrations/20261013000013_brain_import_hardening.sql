-- Brain import hardening.
--
-- Three defects from review of the import -> knowledge path:
--
-- 1. `tenant_specific` was a label, not a route. Neither `brain_import_items` nor
--    `brain_knowledge_entries` carried a tenant, so an accepted tenant_specific row was scoped to
--    nobody. Both tables gain `tenant_id`, a CHECK ties it to the disposition in both directions
--    (tenant_specific has one, nothing else may), and `accept_brain_import_item` writes it.
-- 2. The schema allowed `decision = 'rejected'` but nothing could produce it with an audit row.
--    `reject_brain_import_item` flips the decision and writes the audit row in one transaction,
--    with a required reason.
-- 3. A reviewer could tick a content flag (first-person wording, PII, a handle, a brand name, a
--    proof claim, two categories) as resolved and release the unchanged source copy to the
--    shared Brain. The application now requires an edit that re-scans clean; the RPC repeats the
--    check on the persisted flags so no caller can bypass it.
--
-- Plus: the brand list a batch was scanned against is stored on the batch, so review edits are
-- re-scanned with the same names.
--
-- Pre-existing rows: a `tenant_specific` row without a tenant was never routed anywhere, so it is
-- relabelled `needs_rewrite`. Both dispositions are quarantine for the shared Brain
-- (`publish_brain_draft` copies only `shared`), so nothing that was live or publishable changes.

-- ---------------------------------------------------------------------------------------------
-- 1. tenant_specific routes to a tenant
-- ---------------------------------------------------------------------------------------------

alter table public.brain_import_batches
  add column brand_names text[] not null default '{}'::text[];
comment on column public.brain_import_batches.brand_names is
  'Brand and business names the batch was scanned against. Review re-scans use the same list.';

alter table public.brain_import_items
  add column tenant_id uuid references public.tenants(id);

update public.brain_import_items
set disposition = 'needs_rewrite'
where disposition = 'tenant_specific' and tenant_id is null;

alter table public.brain_import_items
  add constraint brain_import_items_tenant_route_chk
    check ((disposition = 'tenant_specific') = (tenant_id is not null));
comment on column public.brain_import_items.tenant_id is
  'Set exactly when disposition is tenant_specific: the tenant the accepted entry is scoped to.';

alter table public.brain_knowledge_entries
  add column tenant_id uuid references public.tenants(id);

update public.brain_knowledge_entries
set disposition = 'needs_rewrite', updated_at = now()
where disposition = 'tenant_specific' and tenant_id is null;

alter table public.brain_knowledge_entries
  add constraint brain_knowledge_entries_tenant_route_chk
    check ((disposition = 'tenant_specific') = (tenant_id is not null));
comment on column public.brain_knowledge_entries.tenant_id is
  'Set exactly when disposition is tenant_specific. Shared rows never carry a tenant; the snapshot copies only shared rows.';

-- ---------------------------------------------------------------------------------------------
-- 2. Rejection is a real transition with an audit row
-- ---------------------------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('brain.import.rejected', 'human', 'platform', true, false,
    'Import rejection logged', 'Brain import rejection recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.reject_brain_import_item(
  p_expected_batch_id uuid,
  p_expected_source_ref text,
  p_item_id uuid,
  p_reason text,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.brain_import_items%rowtype;
  batch public.brain_import_batches%rowtype;
  written_audit_id bigint;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'BRAIN_IMPORT_REJECT_REASON_REQUIRED'; end if;
  select * into item from public.brain_import_items where id = p_item_id for update;
  if item.id is null then raise exception 'BRAIN_IMPORT_ITEM_NOT_FOUND'; end if;
  if item.batch_id <> p_expected_batch_id or item.source_ref <> p_expected_source_ref then
    raise exception 'BRAIN_IMPORT_ITEM_STALE';
  end if;
  select * into batch from public.brain_import_batches where id = item.batch_id for update;
  if batch.id is null or batch.status <> 'open' then raise exception 'BRAIN_IMPORT_BATCH_NOT_OPEN'; end if;
  if item.decision <> 'pending' then raise exception 'BRAIN_IMPORT_ITEM_NOT_PENDING'; end if;

  update public.brain_import_items
  set decision = 'rejected', decided_by = p_actor_id, decided_at = now()
  where id = item.id;
  written_audit_id := app.write_audit_row(
    'brain.import.rejected', p_actor_id, null, 'brain_import_item', item.id::text,
    btrim(p_reason), jsonb_build_object(
      'batch_id', item.batch_id,
      'source_ref', item.source_ref,
      'operation', item.operation,
      'flags', item.flags
    )
  );
  return written_audit_id;
end;
$$;

revoke execute on function public.reject_brain_import_item(uuid, text, uuid, text, uuid)
  from public, anon, authenticated;
grant execute on function public.reject_brain_import_item(uuid, text, uuid, text, uuid) to service_role;

-- ---------------------------------------------------------------------------------------------
-- 3. accept_brain_import_item: tenant routing and the edited-content rule
-- ---------------------------------------------------------------------------------------------

-- The old 7-argument signature is dropped rather than overloaded: PostgREST resolves an RPC by
-- named arguments, and two candidates differing only by a defaulted parameter are ambiguous.
drop function public.accept_brain_import_item(uuid, text, uuid, text, jsonb, vector, uuid);

create function public.accept_brain_import_item(
  p_expected_batch_id uuid,
  p_expected_source_ref text,
  p_item_id uuid,
  p_disposition text,
  p_number_bindings jsonb,
  p_embedding vector(1536),
  p_actor_id uuid,
  p_tenant_id uuid default null
)
returns table (knowledge_entry_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  item public.brain_import_items%rowtype;
  batch public.brain_import_batches%rowtype;
  unresolved_count int;
  unedited_content_count int;
  entry_id uuid;
  written_audit_id bigint;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  select * into item from public.brain_import_items where id = p_item_id for update;
  if item.id is null then raise exception 'BRAIN_IMPORT_ITEM_NOT_FOUND'; end if;
  if item.batch_id <> p_expected_batch_id or item.source_ref <> p_expected_source_ref then
    raise exception 'BRAIN_IMPORT_ITEM_STALE';
  end if;
  select * into batch from public.brain_import_batches where id = item.batch_id for update;
  if batch.id is null or batch.status <> 'open' then raise exception 'BRAIN_IMPORT_BATCH_NOT_OPEN'; end if;
  if item.decision <> 'pending' or item.operation in ('unchanged', 'removed') then
    raise exception 'BRAIN_IMPORT_ITEM_NOT_ACCEPTABLE';
  end if;
  if p_disposition not in ('shared', 'tenant_specific', 'needs_rewrite') then
    raise exception 'BRAIN_IMPORT_DISPOSITION_INVALID';
  end if;
  if p_disposition = 'tenant_specific' and p_tenant_id is null then
    raise exception 'BRAIN_IMPORT_TENANT_REQUIRED';
  end if;
  if p_disposition <> 'tenant_specific' and p_tenant_id is not null then
    raise exception 'BRAIN_IMPORT_TENANT_NOT_ALLOWED';
  end if;
  if p_tenant_id is not null and not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'BRAIN_IMPORT_TENANT_NOT_FOUND';
  end if;
  select count(*) into unresolved_count
  from jsonb_array_elements(item.flags) flag
  where coalesce(flag ->> 'severity', 'blocking') = 'blocking'
    and coalesce(flag ->> 'resolved', 'false') <> 'true';
  if unresolved_count > 0 then raise exception 'BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED'; end if;
  -- A content flag on a shared row may only have been resolved by an edit that re-scanned clean.
  -- The codes here mirror CONTENT_FLAG_CODES in src/lib/brain/import/flags.ts.
  if p_disposition = 'shared' then
    select count(*) into unedited_content_count
    from jsonb_array_elements(item.flags) flag
    where flag ->> 'code' in ('first_person_pii', 'multi_category', 'social_handle', 'brand_name', 'proof_claim')
      and coalesce(flag -> 'resolution' ->> 'kind', '') <> 'edited';
    if unedited_content_count > 0 then raise exception 'BRAIN_IMPORT_CONTENT_FLAG_NOT_EDITED'; end if;
  end if;
  if jsonb_typeof(coalesce(p_number_bindings, '[]'::jsonb)) <> 'array' then
    raise exception 'BRAIN_IMPORT_NUMBER_BINDINGS_INVALID';
  end if;
  if p_disposition = 'shared' and p_embedding is null then
    raise exception 'BRAIN_IMPORT_EMBEDDING_REQUIRED';
  end if;
  if jsonb_typeof(item.after_payload) <> 'object'
    or nullif(btrim(item.after_payload ->> 'inboundMessage'), '') is null
    or nullif(btrim(item.after_payload ->> 'responseTemplate'), '') is null
    or nullif(btrim(item.after_payload ->> 'category'), '') is null then
    raise exception 'BRAIN_IMPORT_NORMALIZED_PAYLOAD_INVALID';
  end if;

  insert into public.brain_knowledge_entries (
    question, answer, category, match_keywords, status, source, source_ref, disposition,
    tenant_id, response_template, embedding, import_item_id
  ) values (
    item.after_payload ->> 'inboundMessage', item.after_payload ->> 'responseTemplate',
    item.after_payload ->> 'category', coalesce(array(
      select jsonb_array_elements_text(coalesce(item.after_payload -> 'matchKeywords', '[]'::jsonb))
    ), '{}'::text[]), 'draft', batch.source, item.source_ref, p_disposition,
    p_tenant_id, item.after_payload ->> 'responseTemplate', p_embedding, item.id
  )
  on conflict (source, source_ref) where source_ref is not null do update
  set question = excluded.question,
      answer = excluded.answer,
      category = excluded.category,
      match_keywords = excluded.match_keywords,
      status = 'draft',
      published_at = null,
      disposition = excluded.disposition,
      tenant_id = excluded.tenant_id,
      response_template = excluded.response_template,
      embedding = excluded.embedding,
      import_item_id = excluded.import_item_id,
      updated_at = now()
  returning id into entry_id;

  update public.brain_import_items
  set disposition = p_disposition,
      tenant_id = p_tenant_id,
      number_bindings = p_number_bindings,
      decision = 'accepted', decided_by = p_actor_id, decided_at = now()
  where id = item.id;
  written_audit_id := app.write_audit_row(
    'brain.import.accepted', p_actor_id, null, 'brain_import_item', item.id::text,
    null, jsonb_build_object(
      'batch_id', item.batch_id,
      'source_ref', item.source_ref,
      'prior', item.before_payload,
      'new', item.after_payload,
      'disposition', p_disposition,
      'tenant_id', p_tenant_id
    )
  );
  return query select entry_id, written_audit_id;
end;
$$;

revoke execute on function public.accept_brain_import_item(uuid, text, uuid, text, jsonb, vector, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.accept_brain_import_item(uuid, text, uuid, text, jsonb, vector, uuid, uuid)
  to service_role;
