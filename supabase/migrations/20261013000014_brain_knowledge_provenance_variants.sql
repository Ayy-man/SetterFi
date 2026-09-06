-- Brain knowledge provenance and question variants.
--
-- Two gaps this closes, both in how a published answer can be explained afterwards.
--
-- 1. Provenance. Every figure in an imported answer is reviewed and bound to an offer-layer field
--    or declared a platform constant, but that record lived only on `brain_import_items`. Neither
--    the authoring row nor the immutable snapshot copy carried it, so at turn time the engine could
--    not tell a reviewed figure from an unreviewed one and admitted every number in a retrieved
--    answer. `brain_knowledge_entries` and `brain_snapshot_entries` now carry `number_bindings`
--    and a `rewrite_hash` of the exact response text the bindings were reviewed against. The
--    runtime admits a number from a retrieved answer only when the bindings cover it and the hash
--    still matches the text; an edited answer therefore loses its bindings' authority until it is
--    reviewed again, rather than carrying stale review forward under a new wording.
--
--    `accept_brain_import_item` is not changed here. A row trigger on `brain_import_items` copies
--    the accepted bindings onto the knowledge entry the acceptance created, so the RPC keeps its
--    shape and a caller that wrote bindings straight to the item is covered the same way.
--
-- 2. Variants. A lead rarely asks a question in the words the Notion row used. Each knowledge
--    entry may now carry immutable question variants, each embedded, and the published ranking
--    takes the best of the entry's own question and its variants. One row per entry is returned;
--    category agreement stays the bounded 0.05 boost and never filters. Variants are copied into
--    the snapshot at publish, so retrieval keeps reading only immutable history.
--
-- Existing snapshot rows receive their bindings in one controlled rewrite under the immutable
-- trigger, exactly as 20260904000002 did for draft versions: without it every number in the
-- current hosted snapshot would be unbound the moment this deploys, and the runtime would hold
-- turns that were correct yesterday.
set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. The reviewed-rewrite hash
-- ---------------------------------------------------------------------------
-- sha256 over the UTF-8 bytes of the response template. `src/lib/brain/provenance.ts` computes
-- the same value in TypeScript; the runtime compares the two before trusting any binding.
create or replace function app.brain_rewrite_hash(p_template text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_template is null then null
    else encode(extensions.digest(convert_to(p_template, 'UTF8'), 'sha256'), 'hex')
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Bindings on the authoring table
-- ---------------------------------------------------------------------------
alter table public.brain_knowledge_entries
  add column if not exists number_bindings jsonb not null default '[]'::jsonb,
  add column if not exists rewrite_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brain_knowledge_entries_number_bindings_chk'
  ) then
    alter table public.brain_knowledge_entries
      add constraint brain_knowledge_entries_number_bindings_chk
      check (jsonb_typeof(number_bindings) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'brain_knowledge_entries_rewrite_hash_chk'
  ) then
    alter table public.brain_knowledge_entries
      add constraint brain_knowledge_entries_rewrite_hash_chk
      check (rewrite_hash is null or rewrite_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

comment on column public.brain_knowledge_entries.number_bindings is
  'Reviewed figures in response_template, each bound to an offer-layer field or platform_constant. Copied from the accepted import item; authoritative only while rewrite_hash matches the text.';
comment on column public.brain_knowledge_entries.rewrite_hash is
  'sha256 of the response_template the number_bindings were reviewed against (app.brain_rewrite_hash).';

-- Backfill from the acceptance record. The hash is taken from the accepted payload, not the
-- current row, so an entry edited after acceptance reads as unreviewed rather than as reviewed.
update public.brain_knowledge_entries entry
set number_bindings = item.number_bindings,
    rewrite_hash = app.brain_rewrite_hash(item.after_payload ->> 'responseTemplate')
from public.brain_import_items item
where item.id = entry.import_item_id
  and item.decision = 'accepted'
  and nullif(item.after_payload ->> 'responseTemplate', '') is not null;

-- Acceptance carries its bindings forward without touching the acceptance RPC.
create or replace function app.carry_brain_import_bindings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.decision = 'accepted'
    and (old.decision is distinct from new.decision
      or old.number_bindings is distinct from new.number_bindings) then
    update public.brain_knowledge_entries
    set number_bindings = new.number_bindings,
        rewrite_hash = app.brain_rewrite_hash(new.after_payload ->> 'responseTemplate')
    where import_item_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists brain_import_items_carry_bindings on public.brain_import_items;
create trigger brain_import_items_carry_bindings
after update on public.brain_import_items
for each row execute function app.carry_brain_import_bindings();

-- ---------------------------------------------------------------------------
-- 3. Question variants on the authoring table
-- ---------------------------------------------------------------------------
create table if not exists public.brain_knowledge_entry_variants (
  id uuid primary key default gen_random_uuid(),
  entry_id uuid not null references public.brain_knowledge_entries(id) on delete cascade,
  variant text not null,
  embedding vector(1536) not null,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  constraint brain_knowledge_entry_variants_text_chk
    check (nullif(btrim(variant), '') is not null and length(variant) <= 500),
  unique (entry_id, variant)
);
create index if not exists brain_knowledge_entry_variants_entry_idx
  on public.brain_knowledge_entry_variants (entry_id);
comment on table public.brain_knowledge_entry_variants is
  'Alternative phrasings of a knowledge entry''s inbound question, embedded like the question. Immutable: a variant is added or its entry is removed, never edited.';
comment on column public.brain_knowledge_entry_variants.embedding is
  'Embedding of the variant text only. Response text is never embedding input.';

-- Immutable in the same sense as history: no update, and no delete except the cascade that
-- follows the parent entry out. Inside that cascade the parent row is already gone, which is the
-- one condition under which a delete is allowed through.
create or replace function app.brain_variant_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'BRAIN_VARIANT_IMMUTABLE:%', tg_table_name;
  end if;
  if exists (select 1 from public.brain_knowledge_entries where id = old.entry_id) then
    raise exception 'BRAIN_VARIANT_IMMUTABLE:%', tg_table_name;
  end if;
  return old;
end;
$$;

drop trigger if exists brain_knowledge_entry_variants_immutable on public.brain_knowledge_entry_variants;
create trigger brain_knowledge_entry_variants_immutable
before update or delete on public.brain_knowledge_entry_variants
for each row execute function app.brain_variant_immutable();

-- ---------------------------------------------------------------------------
-- 4. Bindings on the immutable snapshot copy
-- ---------------------------------------------------------------------------
alter table public.brain_snapshot_entries
  add column if not exists number_bindings jsonb not null default '[]'::jsonb,
  add column if not exists rewrite_hash text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brain_snapshot_entries_number_bindings_chk'
  ) then
    alter table public.brain_snapshot_entries
      add constraint brain_snapshot_entries_number_bindings_chk
      check (jsonb_typeof(number_bindings) = 'array');
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'brain_snapshot_entries_rewrite_hash_chk'
  ) then
    alter table public.brain_snapshot_entries
      add constraint brain_snapshot_entries_rewrite_hash_chk
      check (rewrite_hash is null or rewrite_hash ~ '^[0-9a-f]{64}$');
  end if;
end
$$;

-- The one controlled rewrite of history. Only rows whose published text is byte-identical to the
-- reviewed text receive bindings; anything else stays unbound, which the runtime reads as "no
-- reviewed figure here". The trigger is disabled and restored inside this migration's transaction,
-- so a failure rolls the trigger state back with everything else.
alter table public.brain_snapshot_entries disable trigger brain_snapshot_entries_immutable;
update public.brain_snapshot_entries snapshot_entry
set number_bindings = entry.number_bindings,
    rewrite_hash = entry.rewrite_hash
from public.brain_knowledge_entries entry
where entry.id = snapshot_entry.entry_id
  and entry.rewrite_hash is not null
  and app.brain_rewrite_hash(snapshot_entry.response_template) = entry.rewrite_hash;
alter table public.brain_snapshot_entries enable trigger brain_snapshot_entries_immutable;

-- ---------------------------------------------------------------------------
-- 5. Variants in the immutable snapshot
-- ---------------------------------------------------------------------------
create table if not exists public.brain_snapshot_entry_variants (
  snapshot_id uuid not null references public.brain_snapshots(id) on delete restrict,
  entry_id uuid not null,
  variant_id uuid not null,
  variant text not null,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, variant_id),
  foreign key (snapshot_id, entry_id)
    references public.brain_snapshot_entries(snapshot_id, entry_id) on delete restrict
);
create index if not exists brain_snapshot_entry_variants_entry_idx
  on public.brain_snapshot_entry_variants (snapshot_id, entry_id);
create index if not exists brain_snapshot_entry_variants_embedding_hnsw
  on public.brain_snapshot_entry_variants using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
comment on table public.brain_snapshot_entry_variants is
  'Immutable question variants copied at publish. Ranking takes the best of an entry''s question and its variants; retrieval never reads the authoring table.';

drop trigger if exists brain_snapshot_entry_variants_immutable on public.brain_snapshot_entry_variants;
create trigger brain_snapshot_entry_variants_immutable
before update or delete on public.brain_snapshot_entry_variants
for each row execute function app.phase2_reject_immutable_update_delete();

-- ---------------------------------------------------------------------------
-- 6. Forced RLS and custody for the two new tables
-- ---------------------------------------------------------------------------
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'brain_knowledge_entry_variants', 'brain_snapshot_entry_variants'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format('drop policy if exists phase2_platform_read on public.%I', table_name);
    execute format(
      'create policy phase2_platform_read on public.%I for select to authenticated
       using (app.is_platform_user())', table_name
    );
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('revoke insert, update, delete on public.%I from authenticated', table_name);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 7. Publish copies bindings and variants into the snapshot
-- ---------------------------------------------------------------------------
-- Same body as 20260826000003 with three additions: the two provenance columns on the entries
-- insert, and the variants insert that follows it. Everything else, including the objection
-- validation and the audit row, is unchanged.
create or replace function public.publish_brain_draft(
  p_actor_id uuid,
  p_expected_draft_id uuid,
  p_expected_content_hash text,
  p_eval_run_id uuid,
  p_reason text
)
returns table (snapshot_id uuid, brain_version int, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.brain_draft_versions%rowtype;
  eval_run public.eval_runs%rowtype;
  new_snapshot_id uuid;
  new_version int;
  written_audit_id bigint;
  draft_entities jsonb;
  objection_entity jsonb;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'BRAIN_PUBLISH_REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('setterfi:brain-publish'));
  select * into draft from public.brain_draft_versions
  where id = p_expected_draft_id for share;
  if draft.id is null then raise exception 'BRAIN_DRAFT_NOT_FOUND'; end if;
  if draft.content_hash <> p_expected_content_hash then raise exception 'BRAIN_DRAFT_HASH_MISMATCH'; end if;
  if exists (
    select 1 from public.brain_snapshots current_snapshot
    where current_snapshot.version = (select max(version) from public.brain_snapshots)
      and current_snapshot.content_hash = draft.content_hash
  ) then raise exception 'BRAIN_NOTHING_CHANGED'; end if;
  select * into eval_run from public.eval_runs where id = p_eval_run_id for share;
  if eval_run.id is null or eval_run.brain_draft_version_id <> draft.id
    or eval_run.content_hash <> draft.content_hash or not eval_run.suites_complete then
    raise exception 'BRAIN_EVAL_NOT_RUN_FOR_VERSION';
  end if;
  if exists (
    select 1 from public.eval_case_results result
    where result.run_id = eval_run.id
      and result.suite in (
        'compliance_guardrails', 'pricing_discipline', 'jailbreak_injection', 'output_integrity'
      ) and not result.passed
  ) then raise exception 'BRAIN_SAFETY_EVAL_FAILED'; end if;
  select coalesce(max(version), 0) + 1 into new_version from public.brain_snapshots;
  insert into public.brain_snapshots (
    version, content_hash, source_hash, payload, compiled_platform, platform_tokens,
    knowledge_mode, eval_run_id, published_by, reason
  ) values (
    new_version, draft.content_hash,
    coalesce(nullif(draft.payload ->> 'sourceHash', ''), draft.content_hash),
    draft.payload, coalesce(draft.payload ->> 'compiledPlatform', ''),
    coalesce((draft.payload ->> 'platformTokens')::int, 0),
    coalesce(draft.payload ->> 'knowledgeMode', 'inline'), eval_run.id, p_actor_id, p_reason
  ) returning id into new_snapshot_id;
  insert into public.brain_snapshot_entries (
    snapshot_id, entry_id, source_ref, category, inbound_message, response_template,
    embedding, disposition, match_keywords, number_bindings, rewrite_hash
  )
  select new_snapshot_id, id, source_ref, category, question, response_template,
    embedding, disposition, match_keywords, number_bindings, rewrite_hash
  from public.brain_knowledge_entries
  where disposition = 'shared' and status = 'draft' and embedding is not null
  order by id;

  -- Variants ride with the entries they belong to: only a variant of an entry that was itself
  -- copied above can land here, which the composite foreign key also enforces.
  insert into public.brain_snapshot_entry_variants (
    snapshot_id, entry_id, variant_id, variant, embedding
  )
  select new_snapshot_id, variant.entry_id, variant.id, variant.variant, variant.embedding
  from public.brain_knowledge_entry_variants variant
  join public.brain_knowledge_entries entry on entry.id = variant.entry_id
  where entry.disposition = 'shared' and entry.status = 'draft' and entry.embedding is not null
  order by variant.id;

  -- Objections come out of the locked payload. Every publish before objections existed, and
  -- every current caller of this function, passes a payload with no `entities` key at all, so
  -- the array access is guarded rather than dereferenced.
  draft_entities := case
    when jsonb_typeof(draft.payload -> 'entities') = 'array' then draft.payload -> 'entities'
    else '[]'::jsonb
  end;

  -- Validate before inserting, so a malformed entity names itself instead of surfacing as an
  -- opaque CHECK or cast failure three frames down.
  for objection_entity in
    select element.value from jsonb_array_elements(draft_entities) as element(value)
    where element.value ->> 'type' = 'brain_objection'
  loop
    if coalesce(objection_entity ->> 'id', '') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or nullif(btrim(coalesce(objection_entity -> 'value' ->> 'label', '')), '') is null
      or nullif(btrim(coalesce(objection_entity -> 'value' ->> 'response', '')), '') is null
      or coalesce(objection_entity -> 'value' ->> 'category', '') not in
         ('timing', 'clarity', 'pricing', 'compliance', 'partner')
    then
      raise exception 'BRAIN_SNAPSHOT_OBJECTION_INVALID:%',
        coalesce(objection_entity ->> 'id', '<missing>');
    end if;
  end loop;

  insert into public.brain_snapshot_objections (
    snapshot_id, objection_id, label, pattern, match_keywords, response, category, hard_gate
  )
  select new_snapshot_id,
    (entity.value ->> 'id')::uuid,
    btrim(entity.value -> 'value' ->> 'label'),
    nullif(btrim(coalesce(entity.value -> 'value' ->> 'pattern', '')), ''),
    coalesce(keywords.words, '{}'::text[]),
    btrim(entity.value -> 'value' ->> 'response'),
    entity.value -> 'value' ->> 'category',
    coalesce((entity.value -> 'value' ->> 'hardGate')::boolean, false)
  from jsonb_array_elements(draft_entities) as entity(value)
  -- Aggregated in ordinal order: the stored array has to match the payload array element for
  -- element, because that array is exactly what the content hash covered.
  left join lateral (
    select array_agg(keyword.word order by keyword.ordinality)::text[] as words
    from jsonb_array_elements_text(
      case when jsonb_typeof(entity.value -> 'value' -> 'matchKeywords') = 'array'
        then entity.value -> 'value' -> 'matchKeywords' else '[]'::jsonb end
    ) with ordinality as keyword(word, ordinality)
  ) keywords on true
  where entity.value ->> 'type' = 'brain_objection'
  order by entity.value ->> 'id';

  written_audit_id := app.write_audit_row(
    'brain.published', p_actor_id, null, 'brain_snapshot', new_snapshot_id::text,
    p_reason, jsonb_build_object(
      'prior', (select max(version) from public.brain_snapshots where id <> new_snapshot_id),
      'new', new_version, 'draft_id', draft.id, 'content_hash', draft.content_hash
    )
  );
  return query select new_snapshot_id, new_version, written_audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Rollback carries the same columns and the variants forward
-- ---------------------------------------------------------------------------
create or replace function public.rollback_brain_snapshot(
  p_actor_id uuid,
  p_expected_current_version int,
  p_selected_version int,
  p_reason text
)
returns table (snapshot_id uuid, brain_version int, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  current_snapshot public.brain_snapshots%rowtype;
  selected_snapshot public.brain_snapshots%rowtype;
  new_snapshot_id uuid;
  new_version int;
  written_audit_id bigint;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'BRAIN_ROLLBACK_REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtext('setterfi:brain-publish'));
  select * into current_snapshot from public.brain_snapshots
  where version = (select max(version) from public.brain_snapshots) for share;
  if current_snapshot.id is null then raise exception 'BRAIN_CURRENT_SNAPSHOT_NOT_FOUND'; end if;
  if current_snapshot.version <> p_expected_current_version then raise exception 'BRAIN_CURRENT_VERSION_STALE'; end if;
  select * into selected_snapshot from public.brain_snapshots
  where version = p_selected_version for share;
  if selected_snapshot.id is null then raise exception 'BRAIN_ROLLBACK_TARGET_NOT_FOUND'; end if;
  if selected_snapshot.version >= current_snapshot.version then raise exception 'BRAIN_ROLLBACK_TARGET_INVALID'; end if;
  new_version := current_snapshot.version + 1;
  insert into public.brain_snapshots (
    version, content_hash, source_hash, payload, compiled_platform, platform_tokens,
    knowledge_mode, eval_run_id, rollback_of_snapshot_id, published_by, reason
  ) values (
    new_version, selected_snapshot.content_hash, selected_snapshot.source_hash,
    selected_snapshot.payload, selected_snapshot.compiled_platform, selected_snapshot.platform_tokens,
    selected_snapshot.knowledge_mode, selected_snapshot.eval_run_id, selected_snapshot.id,
    p_actor_id, p_reason
  ) returning id into new_snapshot_id;
  insert into public.brain_snapshot_entries (
    snapshot_id, entry_id, source_ref, category, inbound_message, response_template,
    embedding, disposition, match_keywords, number_bindings, rewrite_hash
  )
  select new_snapshot_id, selected.entry_id, selected.source_ref, selected.category,
    selected.inbound_message, selected.response_template, selected.embedding,
    selected.disposition, selected.match_keywords, selected.number_bindings, selected.rewrite_hash
  from public.brain_snapshot_entries selected
  where selected.snapshot_id = selected_snapshot.id
  order by selected.entry_id;

  insert into public.brain_snapshot_entry_variants (
    snapshot_id, entry_id, variant_id, variant, embedding
  )
  select new_snapshot_id, selected.entry_id, selected.variant_id, selected.variant, selected.embedding
  from public.brain_snapshot_entry_variants selected
  where selected.snapshot_id = selected_snapshot.id
  order by selected.variant_id;

  -- Copied from the selected snapshot, never re-read from the live library. Rolling back to
  -- version 9 has to produce version 9's objection text, not today's under version 9's number.
  insert into public.brain_snapshot_objections (
    snapshot_id, objection_id, label, pattern, match_keywords, response, category, hard_gate
  )
  select new_snapshot_id, selected.objection_id, selected.label, selected.pattern,
    selected.match_keywords, selected.response, selected.category, selected.hard_gate
  from public.brain_snapshot_objections selected
  where selected.snapshot_id = selected_snapshot.id
  order by selected.objection_id;

  written_audit_id := app.write_audit_row(
    'brain.rolled_back', p_actor_id, null, 'brain_snapshot', new_snapshot_id::text,
    p_reason, jsonb_build_object(
      'prior', current_snapshot.version,
      'new', new_version,
      'selected_version', selected_snapshot.version
    )
  );
  return query select new_snapshot_id, new_version, written_audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Ranking over question and variants, returning provenance
-- ---------------------------------------------------------------------------
-- The return shape grows, so the function is dropped and recreated rather than replaced; the
-- custody statements below are re-issued for the new signature. Similarity is the best of the
-- entry's own question and its variants, computed from one `1 - distance` expression per pair so
-- `similarity + category_boost = score` holds to the bit, which the TypeScript boundary checks.
drop function if exists public.match_published_brain_entries(uuid, vector, text, int);

create function public.match_published_brain_entries(
  p_expected_snapshot_id uuid,
  p_query_embedding vector(1536),
  p_category_hint text default null,
  p_limit int default 5
)
returns table (
  entry_id uuid,
  category text,
  response_template text,
  number_bindings jsonb,
  rewrite_hash text,
  matched_variant text,
  similarity double precision,
  category_boost double precision,
  score double precision
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_snapshot_id uuid;
begin
  if p_query_embedding is null then raise exception 'BRAIN_QUERY_EMBEDDING_REQUIRED'; end if;
  if p_limit < 1 or p_limit > 50 then raise exception 'BRAIN_RETRIEVAL_LIMIT_INVALID'; end if;
  select id into current_snapshot_id
  from public.brain_snapshots order by version desc limit 1;
  if current_snapshot_id is null then raise exception 'BRAIN_CURRENT_SNAPSHOT_NOT_FOUND'; end if;
  if current_snapshot_id <> p_expected_snapshot_id then raise exception 'BRAIN_SNAPSHOT_STALE'; end if;
  return query
  select ranked.entry_id, ranked.category, ranked.response_template,
    ranked.number_bindings, ranked.rewrite_hash, ranked.matched_variant,
    ranked.similarity, ranked.category_boost,
    ranked.similarity + ranked.category_boost as score
  from (
    select entry.entry_id, entry.category, entry.response_template,
      entry.number_bindings, entry.rewrite_hash,
      case when best_variant.similarity > question.similarity
        then best_variant.variant else null end as matched_variant,
      case when best_variant.similarity > question.similarity
        then best_variant.similarity else question.similarity end as similarity,
      case when nullif(btrim(p_category_hint), '') is not null
        and lower(btrim(entry.category)) = lower(btrim(p_category_hint))
        then 0.05::double precision else 0::double precision end as category_boost
    from public.brain_snapshot_entries entry
    cross join lateral (
      select (1 - (entry.embedding operator(extensions.<=>) p_query_embedding))::double precision
        as similarity
    ) question
    left join lateral (
      select variant.variant,
        (1 - (variant.embedding operator(extensions.<=>) p_query_embedding))::double precision
          as similarity
      from public.brain_snapshot_entry_variants variant
      where variant.snapshot_id = entry.snapshot_id and variant.entry_id = entry.entry_id
      order by (variant.embedding operator(extensions.<=>) p_query_embedding) asc, variant.variant_id
      limit 1
    ) best_variant on true
    where entry.snapshot_id = current_snapshot_id
  ) ranked
  order by (ranked.similarity + ranked.category_boost) desc, ranked.entry_id
  limit p_limit;
end;
$$;

revoke execute on function public.match_published_brain_entries(uuid,vector,text,int)
  from public, anon, authenticated;
grant execute on function public.match_published_brain_entries(uuid,vector,text,int)
  to service_role;
comment on function public.match_published_brain_entries(uuid,vector,text,int) is
  'Ranks only the current immutable snapshot, taking the best of each entry''s question and its variants. One row per entry. Category agreement adds exactly 0.05 and never filters. Returns the reviewed number bindings and rewrite hash so the runtime can explain a figure.';
