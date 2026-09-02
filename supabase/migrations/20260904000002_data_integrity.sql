-- Bind support children to the same tenant as their parent and bind every evaluated Brain draft to
-- the exact shared knowledge set that existed when the draft was created.

alter table public.support_threads
  add constraint support_threads_id_tenant_key unique (id, tenant_id);

alter table public.support_messages
  add constraint support_messages_thread_tenant_fkey
  foreign key (thread_id, tenant_id)
  references public.support_threads(id, tenant_id)
  on delete cascade
  not valid;

-- `not valid` avoids taking the stronger validation lock while the constraint is installed, but
-- leaving it that way would let historical cross-tenant rows remain outside the contract forever.
-- Validation is fail-closed: an existing mismatch blocks the migration instead of shipping a
-- partially enforced tenant boundary.
alter table public.support_messages
  validate constraint support_messages_thread_tenant_fkey;

create or replace function app.brain_publish_knowledge_hash()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'id', entry.id,
    'sourceRef', entry.source_ref,
    'category', entry.category,
    'question', entry.question,
    'responseTemplate', entry.response_template,
    'embedding', entry.embedding::text,
    'disposition', entry.disposition,
    'matchKeywords', entry.match_keywords
  ) order by entry.id), '[]'::jsonb)::text, 'UTF8'), 'sha256'), 'hex')
  from public.brain_knowledge_entries entry
  where entry.disposition = 'shared'
    and entry.status = 'draft'
    and entry.embedding is not null;
$$;

alter table public.brain_draft_versions
  add column knowledge_hash text check (knowledge_hash ~ '^[0-9a-f]{64}$');

-- Existing drafts predate this binding and must be recreated and re-evaluated. Giving each a
-- non-current valid hash makes a later publish fail by name instead of silently blessing live rows.
-- The Phase 2 immutable-history trigger correctly rejects ordinary changes. This migration is the
-- one controlled compatibility rewrite: disable that one trigger inside the surrounding migration
-- transaction, backfill the non-current marker, and restore it immediately. If the update fails,
-- PostgreSQL rolls the trigger state back with the rest of the migration.
alter table public.brain_draft_versions disable trigger brain_draft_versions_immutable;
update public.brain_draft_versions
set knowledge_hash = encode(
  extensions.digest(convert_to('legacy-unbound:' || id::text, 'UTF8'), 'sha256'),
  'hex'
);
alter table public.brain_draft_versions enable trigger brain_draft_versions_immutable;

alter table public.brain_draft_versions
  alter column knowledge_hash set default app.brain_publish_knowledge_hash(),
  alter column knowledge_hash set not null;

create or replace function public.create_brain_draft_version(
  p_actor_id uuid,
  p_expected_content_hash text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft_id uuid;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if p_expected_content_hash is null
    or p_expected_content_hash <> app.phase2_json_hash(p_payload) then
    raise exception 'BRAIN_DRAFT_CONTENT_HASH_MISMATCH';
  end if;
  insert into public.brain_draft_versions (
    content_hash, knowledge_hash, payload, created_by
  ) values (
    p_expected_content_hash, app.brain_publish_knowledge_hash(), p_payload, p_actor_id
  ) returning id into draft_id;
  return draft_id;
end;
$$;

create or replace function app.lock_brain_publish_knowledge()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('setterfi:brain-publish'));
  return null;
end;
$$;

drop trigger if exists brain_knowledge_publish_lock on public.brain_knowledge_entries;
create trigger brain_knowledge_publish_lock
before insert or update or delete on public.brain_knowledge_entries
for each statement execute function app.lock_brain_publish_knowledge();

create or replace function app.assert_brain_snapshot_knowledge_binding()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  expected_hash text;
  current_hash text;
begin
  if new.eval_run_id is null or new.rollback_of_snapshot_id is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtext('setterfi:brain-publish'));
  select draft.knowledge_hash into expected_hash
  from public.eval_runs run
  join public.brain_draft_versions draft on draft.id = run.brain_draft_version_id
  where run.id = new.eval_run_id;
  if expected_hash is null then raise exception 'BRAIN_KNOWLEDGE_BINDING_REQUIRED'; end if;
  current_hash := app.brain_publish_knowledge_hash();
  if current_hash <> expected_hash then raise exception 'BRAIN_KNOWLEDGE_CHANGED_SINCE_DRAFT'; end if;
  return new;
end;
$$;

drop trigger if exists brain_snapshot_knowledge_binding on public.brain_snapshots;
create trigger brain_snapshot_knowledge_binding
before insert on public.brain_snapshots
for each row execute function app.assert_brain_snapshot_knowledge_binding();

revoke execute on function app.brain_publish_knowledge_hash()
  from public, anon, authenticated;
revoke execute on function app.lock_brain_publish_knowledge()
  from public, anon, authenticated;
revoke execute on function app.assert_brain_snapshot_knowledge_binding()
  from public, anon, authenticated;
grant execute on function app.brain_publish_knowledge_hash() to service_role;
