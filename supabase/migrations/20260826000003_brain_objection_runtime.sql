-- The published Brain snapshot becomes the only runtime authority for objections.
--
-- `20260826000002` gave `brain_objections` a constrained category and an independent hard gate,
-- but the table it constrained is the live, mutable admin library. Nothing at runtime reads it,
-- and the publish path (`20260818000001_phase2_brain.sql:1188`) copies only knowledge entries
-- into `brain_snapshot_entries`. So an objection has no versioned identity at all: there is no
-- row anywhere that says "this is the objection text that version 12 was evaluated against."
--
-- Four decisions, argued rather than restated:
--
-- 1. **A parallel snapshot table, not wider `brain_snapshot_entries`.** That table requires a
--    `vector(1536)` embedding and carries knowledge-shaped columns (`inbound_message`,
--    `response_template`, `disposition = 'shared'`). Objections are keyword-matched and have a
--    hard gate. Absorbing them would mean making the embedding and three more columns nullable
--    and adding a discriminator, which turns every existing `not null` on that table into a
--    comment. `objection_id` deliberately carries no FK to `public.brain_objections`, exactly as
--    `entry_id` carries none to `brain_knowledge_entries`: a snapshot has to survive deletion of
--    the live row it was copied from, or history stops being history.
--
-- 2. **Publication reads the locked draft payload, never the live library.** This is the whole
--    point of the migration. `publish_brain_draft` already holds `draft.payload` — the exact JSON
--    that was hashed and that the eval run was bound to. Copying objections out of
--    `public.brain_objections` instead would leave a window between draft hashing, evaluation and
--    publication in which an admin edit ships under an evaluated hash that never covered it. The
--    knowledge path has that exposure today (`20260818000001:1242-1250` re-reads
--    `brain_knowledge_entries where status = 'draft'` after the eval binding); closing it there
--    means putting 1536-dimension embeddings into the draft payload, which is a real size
--    decision nobody has made. It is left alone here and recorded rather than quietly changed.
--
-- 3. **Rollback copies the selected snapshot's rows forward.** It appends version N+1 and never
--    moves the current pointer backward, matching what the function already does for knowledge.
--    Re-reading the live library during a rollback would mean "roll back to version 9" produced
--    today's objection text under version 9's number.
--
-- 4. **Both functions are replaced here, not edited in place.** Past migrations are frozen; a
--    `create or replace` in this file is what keeps the migration history append-only.
--
-- `brain_objection_usage_events` lands now, empty and unwritable by application callers, because
-- this is the only migration this phase adds. Nothing writes it until the runtime matcher exists.
--
-- Release note: against the linked project this adds two empty tables and four nullable columns.
-- It rewrites no existing row and back-fills nothing. Snapshots published before objections
-- existed keep zero objection rows — back-filling them from the current library would forge a
-- history that was never evaluated.

-- ---------------------------------------------------------------------------
-- 1. The versioned objection artifact
-- ---------------------------------------------------------------------------

create table if not exists public.brain_snapshot_objections (
  snapshot_id uuid not null references public.brain_snapshots(id) on delete restrict,
  objection_id uuid not null,
  label text not null,
  pattern text,
  match_keywords text[] not null default '{}',
  response text not null,
  category text not null
    check (category in ('timing', 'clarity', 'pricing', 'compliance', 'partner')),
  hard_gate boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, objection_id)
);

create index if not exists brain_snapshot_objections_snapshot_idx
  on public.brain_snapshot_objections (snapshot_id, objection_id);
-- The runtime matcher reads keyword overlap against one snapshot. Landing the GIN index now
-- means the matching plan needs no further migration.
create index if not exists brain_snapshot_objections_keywords_idx
  on public.brain_snapshot_objections using gin (match_keywords);

comment on table public.brain_snapshot_objections is
  'Immutable objections copied from the locked draft payload at publish; the live objection library is never queried at runtime.';

drop trigger if exists brain_snapshot_objections_immutable on public.brain_snapshot_objections;
create trigger brain_snapshot_objections_immutable
before update or delete on public.brain_snapshot_objections
for each row execute function app.phase2_reject_immutable_update_delete();

-- ---------------------------------------------------------------------------
-- 2. Append-only objection usage measurement
-- ---------------------------------------------------------------------------

create table if not exists public.brain_objection_usage_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  agent_message_id uuid not null references public.messages(id) on delete cascade,
  snapshot_id uuid not null,
  objection_id uuid not null,
  handling_outcome text not null check (handling_outcome in ('answered', 'held_safely')),
  hard_gate boolean not null,
  used_at timestamptz not null default now(),
  is_test boolean not null default false,
  -- The composite reference is the point: an objection id is only meaningful paired with the
  -- snapshot that contained it, so a live-library id can never be recorded against a version
  -- that never carried it.
  constraint brain_objection_usage_events_snapshot_objection_fk
    foreign key (snapshot_id, objection_id)
    references public.brain_snapshot_objections (snapshot_id, objection_id)
    on delete restrict,
  -- A hard-gated objection may only ever be recorded as held, never as answered. This is the
  -- schema half of the runtime gate; nothing writes these rows yet.
  constraint brain_objection_usage_events_gate_chk
    check (not hard_gate or handling_outcome = 'held_safely')
);

-- One selected objection response per outbound turn. This is the idempotency key the runtime
-- recorder will rely on, so a retried send cannot double-count a single reply.
create unique index if not exists brain_objection_usage_events_message_uidx
  on public.brain_objection_usage_events (agent_message_id);
create index if not exists brain_objection_usage_events_tenant_idx
  on public.brain_objection_usage_events (tenant_id, used_at desc);
create index if not exists brain_objection_usage_events_objection_idx
  on public.brain_objection_usage_events (objection_id, used_at desc);

comment on table public.brain_objection_usage_events is
  'Append-only record of one published objection used on one persisted agent turn; is_test is inherited from the conversation and never accepted from the caller.';

-- The trigger name matters. Triggers at the same timing fire in name order, so
-- `brain_objection_usage_events_append_only` runs before `inherit_is_test` and an attempted
-- update is refused outright rather than first re-deriving a flag it will never store.
drop trigger if exists brain_objection_usage_events_append_only
  on public.brain_objection_usage_events;
create trigger brain_objection_usage_events_append_only
before update or delete on public.brain_objection_usage_events
for each row execute function app.phase2_reject_immutable_update_delete();

-- ---------------------------------------------------------------------------
-- 3. Typed objection identity on the message trace
-- ---------------------------------------------------------------------------
-- Nullable and unwritten by any code in this migration. They exist so the trace can later name
-- the exact snapshot objection a reply came from instead of burying it in the untyped `trace`
-- jsonb, where nothing can constrain it.

alter table public.message_traces
  add column if not exists objection_snapshot_id uuid,
  add column if not exists objection_id uuid,
  add column if not exists objection_handling_outcome text,
  add column if not exists objection_hard_gate boolean;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.message_traces'::regclass
      and conname = 'message_traces_objection_fk'
  ) then
    -- MATCH SIMPLE, so the existing all-null rows are exempt rather than needing a backfill.
    alter table public.message_traces
      add constraint message_traces_objection_fk
      foreign key (objection_snapshot_id, objection_id)
      references public.brain_snapshot_objections (snapshot_id, objection_id)
      match simple on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.message_traces'::regclass
      and conname = 'message_traces_objection_identity_chk'
  ) then
    alter table public.message_traces
      add constraint message_traces_objection_identity_chk
      check (num_nonnulls(objection_snapshot_id, objection_id) in (0, 2));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.message_traces'::regclass
      and conname = 'message_traces_objection_detail_chk'
  ) then
    alter table public.message_traces
      add constraint message_traces_objection_detail_chk
      check (
        objection_id is not null
        or (objection_handling_outcome is null and objection_hard_gate is null)
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.message_traces'::regclass
      and conname = 'message_traces_objection_outcome_chk'
  ) then
    alter table public.message_traces
      add constraint message_traces_objection_outcome_chk
      check (
        objection_handling_outcome is null
        or objection_handling_outcome in ('answered', 'held_safely')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.message_traces'::regclass
      and conname = 'message_traces_objection_gate_chk'
  ) then
    alter table public.message_traces
      add constraint message_traces_objection_gate_chk
      check (
        objection_hard_gate is not true
        or objection_handling_outcome = 'held_safely'
      );
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. Inherited test segregation for the new events table
-- ---------------------------------------------------------------------------
-- The body below is the deployed definition read from
-- `pg_get_functiondef('app.inherit_is_test()'::regprocedure)`, not a copy of any one migration
-- file: several migrations `create or replace` this function and only the catalog knows which
-- body is live. Exactly one branch is added — `brain_objection_usage_events`, immediately after
-- the `brain_knowledge_usage_events` branch it mirrors. The suite asserts the resulting branch
-- set as an exact fourteen names, so a transcription slip that drops a branch fails the build.

create or replace function app.inherit_is_test()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  inherited boolean;
begin
  case tg_table_name
    when 'contacts' then
      if new.test_session_id is not null then
        select true into inherited from public.test_agent_sessions
        where id = new.test_session_id and tenant_id = new.tenant_id;
      else
        select is_demo into inherited from public.tenants where id = new.tenant_id;
      end if;
    when 'conversations' then
      select is_test into inherited from public.contacts where id = new.contact_id;
    when 'messages' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'followups' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'appointments' then
      if new.conversation_id is not null then
        select is_test into inherited from public.conversations where id = new.conversation_id;
      else
        select is_test into inherited from public.contacts where id = new.contact_id;
      end if;
    when 'billable_events' then
      if tg_op = 'UPDATE'
         and current_setting('app.contact_deletion_active', true) = 'true'
         and old.appointment_id is not null
         and new.appointment_id is null
         and new.appointment_detached_at is not null then
        inherited := old.is_test;
      elsif new.appointment_id is not null then
        select is_test into inherited from public.appointments where id = new.appointment_id;
      else
        select is_test into inherited from public.billable_events where id = new.adjusts_event_id;
      end if;
    when 'brain_knowledge_usage_events' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'brain_objection_usage_events' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    when 'unmatched_objections' then
      if new.conversation_id is not null then
        select is_test into inherited from public.conversations where id = new.conversation_id;
      elsif new.message_id is not null then
        select is_test into inherited from public.messages where id = new.message_id;
      else
        inherited := false;
      end if;
    when 'appointment_reschedules' then
      select is_test into inherited from public.appointments where id = new.appointment_id;
    when 'support_threads' then
      select is_demo into inherited from public.tenants where id = new.tenant_id;
    when 'support_messages' then
      select is_test into inherited from public.support_threads where id = new.thread_id;
    when 'contact_notes' then
      select is_test into inherited from public.contacts where id = new.contact_id;
    when 'conversation_step_events' then
      select is_test into inherited from public.conversations where id = new.conversation_id;
    else
      raise exception 'IS_TEST_TRIGGER_UNSUPPORTED_TABLE:%', tg_table_name;
  end case;

  if inherited is null then raise exception 'IS_TEST_PARENT_NOT_FOUND:%', tg_table_name; end if;
  new.is_test := inherited;
  return new;
end;
$$;

drop trigger if exists inherit_is_test on public.brain_objection_usage_events;
create trigger inherit_is_test
before insert or update on public.brain_objection_usage_events
for each row execute function app.inherit_is_test();

-- ---------------------------------------------------------------------------
-- 5. Forced RLS and explicit grants
-- ---------------------------------------------------------------------------

alter table public.brain_snapshot_objections enable row level security;
alter table public.brain_snapshot_objections force row level security;
alter table public.brain_objection_usage_events enable row level security;
alter table public.brain_objection_usage_events force row level security;

revoke all on public.brain_snapshot_objections from anon, authenticated, service_role;
revoke all on public.brain_objection_usage_events from anon, authenticated, service_role;

-- The snapshot library is platform-only, exactly like every other PLATFORM_TABLES member.
drop policy if exists phase2_platform_read on public.brain_snapshot_objections;
create policy phase2_platform_read on public.brain_snapshot_objections
  for select to authenticated using (app.is_platform_user());
grant select on public.brain_snapshot_objections to authenticated;

-- Usage events are a coach's own measurement, so the owning tenant reads them too. No insert,
-- update or delete grant to any role: rows arrive only through the security-definer recording
-- path a later plan adds, which is what "initially inaccessible to application callers" means.
drop policy if exists brain_objection_usage_events_tenant_read
  on public.brain_objection_usage_events;
create policy brain_objection_usage_events_tenant_read on public.brain_objection_usage_events
  for select to authenticated using (app.owns_tenant(tenant_id));
drop policy if exists brain_objection_usage_events_platform_read
  on public.brain_objection_usage_events;
create policy brain_objection_usage_events_platform_read on public.brain_objection_usage_events
  for select to authenticated using (app.is_platform_user());
grant select on public.brain_objection_usage_events to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The analytics view
-- ---------------------------------------------------------------------------
-- Mirrors analytics_brain_knowledge_usage_events exactly: security_invoker so the caller's RLS
-- still applies, and both exclusions — the inherited test flag and the demo tenant — because
-- either one alone lets seeded demo traffic into a platform metric.

create or replace view public.analytics_brain_objection_usage_events
with (security_invoker = true)
as
select event.id as event_id, event.tenant_id, event.conversation_id, event.agent_message_id,
  event.snapshot_id, event.objection_id, event.handling_outcome, event.hard_gate, event.used_at
from public.brain_objection_usage_events event
join public.tenants tenant on tenant.id = event.tenant_id
where not event.is_test and not tenant.is_demo;

revoke all on public.analytics_brain_objection_usage_events
  from anon, authenticated, service_role;
grant select on public.analytics_brain_objection_usage_events
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Publication and rollback carry objections
-- ---------------------------------------------------------------------------
-- Both bodies are the existing definitions from `20260818000001_phase2_brain.sql` (:1188 and
-- :1262) with exactly one insert added each. Every guard, advisory lock, hash comparison, eval
-- binding, audit write and return shape is unchanged, and the argument lists, `security definer`
-- and `set search_path = ''` are identical. Replacing them here rather than editing that file is
-- what keeps the migration history append-only.
--
-- The objection insert reads `draft.payload` and nothing else. `public.brain_objections` is not
-- referenced anywhere in either body: reading it would reopen the exact window this migration
-- exists to close, since an admin edit landing between draft hashing and publication would then
-- ship under an evaluated hash that never covered it.

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
    embedding, disposition, match_keywords
  )
  select new_snapshot_id, id, source_ref, category, question, response_template,
    embedding, disposition, match_keywords
  from public.brain_knowledge_entries
  where disposition = 'shared' and status = 'draft' and embedding is not null
  order by id;

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
    embedding, disposition, match_keywords
  )
  select new_snapshot_id, selected.entry_id, selected.source_ref, selected.category,
    selected.inbound_message, selected.response_template, selected.embedding,
    selected.disposition, selected.match_keywords
  from public.brain_snapshot_entries selected
  where selected.snapshot_id = selected_snapshot.id
  order by selected.entry_id;

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
-- 8. Runtime matching against the published snapshot
-- ---------------------------------------------------------------------------
-- Two things this function deliberately does not do.
--
-- It does not compile `pattern`, or any admin-authored text, as a regular expression. Matching is
-- `position()` containment of a space-padded keyword inside a space-padded copy of the inbound
-- message, so a keyword containing `(` or `.*` can neither throw nor match every message, and
-- `cost` cannot fire on `costume`. Whether a regex should take precedence over keywords is an
-- unmade product decision; until it is made, `pattern` is snapshotted and never consulted.
--
-- It does not read `public.brain_objections`. The mutable library is what an admin edits between
-- publishes; ranking against it would let today's wording answer under a version that was
-- evaluated against different wording.

create or replace function public.match_published_brain_objections(
  p_expected_snapshot_id uuid,
  p_inbound_message text,
  p_limit int default 3
)
returns table (
  snapshot_id uuid,
  objection_id uuid,
  label text,
  response text,
  category text,
  hard_gate boolean,
  matched_keywords text[],
  keyword_hits int
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  current_snapshot_id uuid;
  normalized text;
begin
  if nullif(btrim(coalesce(p_inbound_message, '')), '') is null then
    raise exception 'BRAIN_OBJECTION_MESSAGE_REQUIRED';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'BRAIN_OBJECTION_LIMIT_INVALID';
  end if;

  -- The same currency refusal `match_published_brain_entries` makes, for the same reason: a turn
  -- that thinks it is answering from version 9 must not silently be answered from version 10.
  select id into current_snapshot_id
  from public.brain_snapshots order by version desc limit 1;
  if current_snapshot_id is null then raise exception 'BRAIN_CURRENT_SNAPSHOT_NOT_FOUND'; end if;
  if current_snapshot_id <> p_expected_snapshot_id then raise exception 'BRAIN_SNAPSHOT_STALE'; end if;

  normalized := ' ' || lower(regexp_replace(p_inbound_message, '[^a-zA-Z0-9]+', ' ', 'g')) || ' ';

  return query
  select objection.snapshot_id, objection.objection_id, objection.label, objection.response,
    objection.category, objection.hard_gate, hits.matched_keywords, hits.keyword_hits
  from public.brain_snapshot_objections objection
  cross join lateral (
    select
      coalesce(array_agg(keyword.value order by keyword.value), '{}'::text[]) as matched_keywords,
      count(*)::int as keyword_hits
    from unnest(objection.match_keywords) as keyword(value)
    -- A keyword that normalizes to nothing would pad to a bare space and match every message.
    where nullif(btrim(regexp_replace(keyword.value, '[^a-zA-Z0-9]+', ' ', 'g')), '') is not null
      and position(
        ' ' || lower(btrim(regexp_replace(keyword.value, '[^a-zA-Z0-9]+', ' ', 'g'))) || ' '
        in normalized
      ) > 0
  ) hits
  where objection.snapshot_id = current_snapshot_id
    and hits.keyword_hits > 0
  -- Strongest overlap first, objection id as the tie-break, so the same message against the same
  -- snapshot always selects the same objection and the 10-04 rollup cannot drift from what shipped.
  order by hits.keyword_hits desc, objection.objection_id
  limit p_limit;
end;
$$;

revoke execute on function public.match_published_brain_objections(uuid,text,int)
  from public, anon, authenticated;
grant execute on function public.match_published_brain_objections(uuid,text,int)
  to service_role;

comment on function public.match_published_brain_objections(uuid,text,int) is
  'Ranks only the current immutable snapshot by whole-token keyword overlap; `pattern` is snapshotted but never consulted, and the mutable brain_objections library is never read.';

-- ---------------------------------------------------------------------------
-- 9. The trace declaration is validated against the snapshot, not trusted
-- ---------------------------------------------------------------------------
-- Currency is enforced at read time, not here. A trace is a historical record: if a publish lands
-- between the match and the trace insert, the right behaviour is to record what the turn actually
-- used, not to fail a reply that was already sent. What this trigger refuses is a declaration that
-- disagrees with the snapshot it names — application code must not be able to understate a hard
-- gate and slip past `brain_objection_usage_events_gate_chk`.

create or replace function app.validate_message_trace_objection()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  snapshot_gate boolean;
begin
  if new.objection_id is null then return new; end if;

  if new.objection_handling_outcome is null or new.objection_hard_gate is null then
    raise exception 'BRAIN_OBJECTION_OUTCOME_REQUIRED:%', new.objection_id;
  end if;

  select objection.hard_gate into snapshot_gate
  from public.brain_snapshot_objections objection
  where objection.snapshot_id = new.objection_snapshot_id
    and objection.objection_id = new.objection_id;
  -- This fires before `message_traces_objection_fk` gets the chance to, because BEFORE ROW
  -- triggers run ahead of constraint checking. The FK still stands behind it and is what makes a
  -- snapshot objection undeletable while a trace names it.
  if not found then
    raise exception 'BRAIN_OBJECTION_SNAPSHOT_ROW_MISSING:%', new.objection_id;
  end if;

  if snapshot_gate is distinct from new.objection_hard_gate then
    raise exception 'BRAIN_OBJECTION_GATE_MISDECLARED:%', new.objection_id;
  end if;

  return new;
end;
$$;

drop trigger if exists message_traces_objection_validate on public.message_traces;
create trigger message_traces_objection_validate
before insert on public.message_traces
for each row execute function app.validate_message_trace_objection();

-- ---------------------------------------------------------------------------
-- 10. The usage event is recorded by the trace, or not at all
-- ---------------------------------------------------------------------------
-- An objection "hit" is only real if the agent turn it describes was actually sent and actually
-- traced. A second application call could not guarantee that — it can succeed after the trace
-- failed, or fail after the trace succeeded, and both outcomes corrupt a metric nobody would think
-- to reconcile. An after-insert trigger runs inside the same statement, so a failure here aborts
-- the trace insert and Postgres does the rollback for free.
--
-- It also means there is no application insert path to secure: `brain_objection_usage_events`
-- grants INSERT to no role at all, and the only writer is this definer function. That is the same
-- arrangement `record_conversation_step_events` uses against `conversation_step_events`.
--
-- `hard_gate` is read from the snapshot rather than copied from the trace, and `is_test` is never
-- named, so `app.inherit_is_test` stays the single thing that decides it.

create or replace function app.record_brain_objection_usage()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  agent_conversation_id uuid;
  snapshot_gate boolean;
begin
  if new.objection_id is null then return null; end if;

  select message.conversation_id into agent_conversation_id
  from public.messages message where message.id = new.message_id;
  if not found then
    raise exception 'BRAIN_OBJECTION_MESSAGE_LINK_MISSING:%', new.message_id;
  end if;

  select objection.hard_gate into snapshot_gate
  from public.brain_snapshot_objections objection
  where objection.snapshot_id = new.objection_snapshot_id
    and objection.objection_id = new.objection_id;
  if not found then
    raise exception 'BRAIN_OBJECTION_SNAPSHOT_ROW_MISSING:%', new.objection_id;
  end if;

  -- No `on conflict`: a duplicate must raise. The unique index on agent_message_id is the
  -- idempotency proof, and swallowing a conflict here would silently under-count instead.
  insert into public.brain_objection_usage_events (
    tenant_id, conversation_id, agent_message_id, snapshot_id, objection_id,
    handling_outcome, hard_gate
  ) values (
    new.tenant_id, agent_conversation_id, new.message_id, new.objection_snapshot_id,
    new.objection_id, new.objection_handling_outcome, snapshot_gate
  );

  return null;
end;
$$;

drop trigger if exists message_traces_objection_record on public.message_traces;
create trigger message_traces_objection_record
after insert on public.message_traces
for each row execute function app.record_brain_objection_usage();
