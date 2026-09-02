-- Phase 2 database spine: review-only imports, immutable Brain snapshots, bounded offer versions,
-- hash-bound eval evidence, verified retrieval receipts, and audited service-only transitions.
-- Existing content is never guessed into the new contract: each lossy conversion is preceded by
-- a deterministic backfill or a named remediation guard that aborts before the dependent DDL.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Preconditions, legacy guards, and transaction-safe shared vocabulary
-- ---------------------------------------------------------------------------

do $$
declare
  missing text[];
begin
  select array_agg(required_name order by required_name) into missing
  from unnest(array[
    'audit_actions', 'audit_log', 'brain_knowledge_entries', 'eval_case_results', 'eval_cases',
    'eval_runs', 'message_templates', 'message_traces', 'offer_cadence_purposes', 'offer_layers',
    'qualification_rules', 'tenant_settings'
  ]) required_name
  where to_regclass('public.' || required_name) is null;
  if missing is not null then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE2_REQUIRED_RELATIONS_MISSING',
      detail = array_to_string(missing, ', ');
  end if;
  if not exists (select 1 from pg_extension where extname = 'vector') then
    raise exception 'PHASE2_VECTOR_EXTENSION_REQUIRED';
  end if;
  if to_regprocedure('app.not_impersonating()') is null
    or to_regprocedure('app.assert_expected_tenant(uuid,uuid,text)') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid)') is null then
    raise exception 'PHASE2_PHASE1_HELPERS_REQUIRED';
  end if;
end
$$;

-- An enum value added with ALTER TYPE cannot be used until the surrounding migration transaction
-- commits. Replacing this small shared type keeps Phase 2 a single migration while preserving every
-- existing status value and makes `superseded` immediately usable by the offer indexes below.
drop policy published_read on public.brain_documents;
drop policy published_read on public.brain_knowledge_entries;
drop policy published_read on public.brain_objections;
drop policy published_read on public.qualification_rules;
drop index public.brain_documents_section_idx;
drop index public.brain_knowledge_entries_category_idx;
drop index public.brain_objections_status_idx;
drop index public.flow_configs_published_idx;

alter type public.publish_status rename to publish_status_phase1;
create type public.publish_status as enum ('draft', 'published', 'superseded');

alter table public.brain_documents alter column status drop default;
alter table public.brain_knowledge_entries alter column status drop default;
alter table public.brain_objections alter column status drop default;
alter table public.qualification_rules alter column status drop default;
alter table public.flow_configs alter column status drop default;
alter table public.eval_runs alter column config_source drop default;

alter table public.brain_documents
  alter column status type public.publish_status using status::text::public.publish_status;
alter table public.brain_knowledge_entries
  alter column status type public.publish_status using status::text::public.publish_status;
alter table public.brain_objections
  alter column status type public.publish_status using status::text::public.publish_status;
alter table public.qualification_rules
  alter column status type public.publish_status using status::text::public.publish_status;
alter table public.flow_configs
  alter column status type public.publish_status using status::text::public.publish_status;
alter table public.eval_runs
  alter column config_source type public.publish_status using config_source::text::public.publish_status;

alter table public.brain_documents alter column status set default 'draft';
alter table public.brain_knowledge_entries alter column status set default 'draft';
alter table public.brain_objections alter column status set default 'draft';
alter table public.qualification_rules alter column status set default 'draft';
alter table public.flow_configs alter column status set default 'draft';
alter table public.eval_runs alter column config_source set default 'published';
drop type public.publish_status_phase1;

create index brain_documents_section_idx on public.brain_documents (section, status);
create index brain_knowledge_entries_category_idx on public.brain_knowledge_entries (category, status);
create index brain_objections_status_idx on public.brain_objections (status);
create unique index flow_configs_published_idx on public.flow_configs (tenant_id)
  where status = 'published';

create policy published_read on public.brain_documents for select to authenticated
  using (status = 'published' or app.is_platform_user());
create policy published_read on public.brain_knowledge_entries for select to authenticated
  using (status = 'published' or app.is_platform_user());
create policy published_read on public.brain_objections for select to authenticated
  using (status = 'published' or app.is_platform_user());
create policy published_read on public.qualification_rules for select to authenticated
  using (status = 'published' or app.is_platform_user());

-- Old mutable knowledge is preserved verbatim but deliberately made non-publishable. An admin has
-- to classify and review it before a snapshot can copy it into the runtime authority.
alter table public.brain_knowledge_entries
  add column source text,
  add column source_ref text,
  add column disposition text,
  add column response_template text,
  add column embedding vector(1536),
  add column import_item_id uuid;
update public.brain_knowledge_entries
set source = 'legacy_manual',
    disposition = 'needs_rewrite',
    response_template = answer,
    status = 'draft',
    published_at = null
where source is null or disposition is null or response_template is null or status <> 'draft';
alter table public.brain_knowledge_entries
  alter column source set not null,
  alter column source set default 'manual',
  alter column disposition set not null,
  alter column disposition set default 'needs_rewrite',
  alter column response_template set not null,
  add constraint brain_knowledge_entries_source_chk
    check (source in ('legacy_manual', 'manual', 'notion', 'offline', 'mock')),
  add constraint brain_knowledge_entries_disposition_chk
    check (disposition in ('shared', 'tenant_specific', 'needs_rewrite')),
  add constraint brain_knowledge_entries_publishable_chk
    check (status <> 'published' or (disposition = 'shared' and embedding is not null));
create unique index brain_knowledge_entries_source_ref_uidx
  on public.brain_knowledge_entries (source, source_ref) where source_ref is not null;
comment on column public.brain_knowledge_entries.embedding is
  'Embedding of inbound-message text only. Response text is never embedding input.';
comment on table public.brain_documents is
  'Reserved for prose sources and unused by the Phase 2 structured-row runtime.';
comment on table public.brain_chunks is
  'Reserved for prose-source chunks and unused by the Phase 2 structured-row runtime.';

-- Existing eval runs cannot be bound retroactively to an immutable draft hash. Guessing that link
-- would turn historical green rows into false gate evidence, so a populated deployment must resolve
-- them explicitly before this reshape runs.
do $$
begin
  if exists (select 1 from public.eval_runs) or exists (select 1 from public.eval_case_results) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE2_EVAL_HISTORY_REMEDIATION_REQUIRED',
      detail = 'Archive or map existing eval runs/results to an immutable draft and content hash.';
  end if;
end
$$;

-- Open JSON offer content has no closed mapping into the decided child tables. Empty values are
-- safely discarded; any populated value aborts so a human can migrate it without silent loss.
do $$
begin
  if exists (
    select 1 from public.offer_layers
    where coalesce(voice_answers, 'null'::jsonb) not in ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
       or coalesce(faq, 'null'::jsonb) not in ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
       or coalesce(proof, 'null'::jsonb) not in ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
       or coalesce(assets, 'null'::jsonb) not in ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
       or coalesce(cadence, 'null'::jsonb) not in ('[]'::jsonb, '{}'::jsonb, 'null'::jsonb)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE2_OFFER_JSON_REMEDIATION_REQUIRED',
      detail = 'Map non-empty offer JSON into the bounded Phase 2 child tables before retrying.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Platform authoring, immutable draft/snapshot, and compliance tables
-- ---------------------------------------------------------------------------

create table public.brain_mission (
  id uuid primary key default gen_random_uuid(),
  identity text not null default '',
  goal text not null default '',
  tone text not null default '',
  criteria text not null default '',
  guardrails text not null default '',
  dq text not null default '',
  status public.publish_status not null default 'draft',
  version int not null default 1 check (version > 0),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brain_mission_len_chk check (
    length(identity) <= 1500 and length(goal) <= 1500 and length(tone) <= 1500
    and length(criteria) <= 2500 and length(guardrails) <= 2500 and length(dq) <= 2500
  )
);
create unique index brain_mission_one_draft_uidx
  on public.brain_mission (status) where status = 'draft';
create unique index brain_mission_one_published_uidx
  on public.brain_mission (status) where status = 'published';

create table public.brain_import_batches (
  id uuid primary key default gen_random_uuid(),
  source text not null check (source in ('notion', 'offline', 'mock')),
  collection_ref text not null check (nullif(btrim(collection_ref), '') is not null),
  source_hash text not null,
  source_edited_at timestamptz,
  received_count int not null check (received_count >= 0),
  normalized_count int not null check (normalized_count >= 0),
  flagged_count int not null check (flagged_count >= 0),
  unchanged_count int not null check (unchanged_count >= 0),
  status text not null default 'open' check (status in ('open', 'applied', 'discarded', 'failed')),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint brain_import_batches_counts_chk check (
    normalized_count <= received_count and flagged_count <= normalized_count
    and unchanged_count <= normalized_count
  )
);

create table public.brain_import_items (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.brain_import_batches(id) on delete cascade,
  source_ref text not null,
  operation text not null check (operation in ('new', 'changed', 'unchanged', 'removed')),
  before_payload jsonb,
  after_payload jsonb,
  flags jsonb not null default '[]'::jsonb check (jsonb_typeof(flags) = 'array'),
  disposition text check (disposition in ('shared', 'tenant_specific', 'needs_rewrite')),
  number_bindings jsonb not null default '[]'::jsonb check (jsonb_typeof(number_bindings) = 'array'),
  decision text not null default 'pending' check (decision in ('pending', 'accepted', 'rejected')),
  decided_by uuid references public.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (batch_id, source_ref),
  constraint brain_import_items_decision_shape_chk check (
    (decision = 'pending' and decided_by is null and decided_at is null)
    or (decision <> 'pending' and decided_by is not null and decided_at is not null)
  )
);

create table public.brain_draft_versions (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now()
);
create index brain_draft_versions_hash_idx on public.brain_draft_versions (content_hash, created_at desc);

create table public.brain_snapshots (
  id uuid primary key default gen_random_uuid(),
  version int not null unique check (version > 0),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  compiled_platform text not null,
  platform_tokens int not null check (platform_tokens >= 0),
  knowledge_mode text not null check (knowledge_mode in ('inline', 'retrieved')),
  eval_run_id uuid,
  rollback_of_snapshot_id uuid references public.brain_snapshots(id),
  published_by uuid not null references public.users(id),
  reason text not null check (nullif(btrim(reason), '') is not null),
  published_at timestamptz not null default now()
);
create index brain_snapshots_hash_idx on public.brain_snapshots (content_hash, version desc);

create table public.brain_snapshot_entries (
  snapshot_id uuid not null references public.brain_snapshots(id) on delete restrict,
  entry_id uuid not null,
  source_ref text,
  category text not null,
  inbound_message text not null,
  response_template text not null,
  embedding vector(1536) not null,
  disposition text not null check (disposition = 'shared'),
  match_keywords text[] not null default '{}',
  created_at timestamptz not null default now(),
  primary key (snapshot_id, entry_id)
);
create index brain_snapshot_entries_snapshot_idx
  on public.brain_snapshot_entries (snapshot_id, entry_id);
create index brain_snapshot_entries_embedding_hnsw
  on public.brain_snapshot_entries using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
comment on table public.brain_snapshots is
  'Immutable numbered runtime authority. Rollback appends a new snapshot instead of moving history.';
comment on table public.brain_snapshot_entries is
  'Immutable structured knowledge copied at publish; live draft tables are never queried by retrieval.';

create table public.compliance_rules (
  id text primary key check (id ~ '^[A-Z]{3,5}-[0-9]{3}$'),
  check_class text not null check (check_class in ('NUM', 'CLAIM', 'ECHO', 'LINK', 'SCOPE', 'LEN')),
  slug text not null unique,
  phrase text,
  severity text not null default 'refuse' check (severity in ('refuse', 'escalate')),
  status public.publish_status not null default 'draft',
  retired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint compliance_rules_phrase_shape_chk
    check (check_class = 'CLAIM' or phrase is null)
);
insert into public.compliance_rules (id, check_class, slug)
values
  ('CLAIM-001', 'CLAIM', 'blocked-claim-phrase'),
  ('ECHO-001', 'ECHO', 'system-text-echo'),
  ('LEN-001', 'LEN', 'channel-length'),
  ('LINK-001', 'LINK', 'unapproved-link'),
  ('NUM-001', 'NUM', 'ungrounded-number'),
  ('SCOPE-001', 'SCOPE', 'role-boundary');

create table public.holding_replies (
  id uuid primary key default gen_random_uuid(),
  check_class text not null unique check (check_class in ('NUM', 'CLAIM', 'ECHO', 'LINK', 'SCOPE', 'LEN', 'CRISIS')),
  body text not null check (length(body) between 1 and 320),
  status public.publish_status not null default 'draft',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Versioned offer storage and bounded tenant-owned children
-- ---------------------------------------------------------------------------

alter table public.offer_layers
  add column id uuid default gen_random_uuid(),
  add column status public.publish_status not null default 'draft',
  add column content_hash text,
  add column program_description text,
  add column monthly_revenue_min_cents bigint,
  add column funding_goal_max_cents bigint,
  add column results_timeline_min_days int,
  add column results_timeline_max_days int,
  add column refund_posture text,
  add column voice_style_answer text,
  add column voice_objection_answer text,
  add column voice_followup_answer text;
-- Phase 1's explicitly labelled demo fixture used a descriptive placeholder rather than a product
-- selection. Preserve that meaning as "no product selected"; refuse every other free-form value.
update public.offer_layers
set products = '{}'::text[]
where products = array['Business funding readiness']::text[];
do $$
begin
  if exists (
    select 1 from public.offer_layers
    where not (products <@ array[
      'personal CC', 'personal loans', 'biz CC', 'biz line of credit', 'biz term loans'
    ]::text[])
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE2_OFFER_PRODUCT_REMEDIATION_REQUIRED',
      detail = 'Map free-form offer products to the closed Phase 2 vocabulary before retrying.';
  end if;
end
$$;
update public.offer_layers
set id = coalesce(id, gen_random_uuid()), status = 'draft', version = greatest(version, 1),
    published_at = null;
alter table public.offer_layers
  alter column id set not null,
  drop constraint offer_layers_pkey,
  drop column credit_min_enforced,
  drop column pricing_gate,
  drop column voice_answers,
  drop column faq,
  drop column proof,
  drop column assets,
  drop column cadence,
  add constraint offer_layers_pkey primary key (id),
  add constraint offer_layers_tenant_version_key unique (tenant_id, version),
  add constraint offer_layers_id_tenant_key unique (id, tenant_id),
  add constraint offer_layers_program_name_len_chk
    check (program_name is null or length(program_name) <= 120),
  add constraint offer_layers_program_description_len_chk
    check (program_description is null or length(program_description) <= 500),
  add constraint offer_layers_products_chk check (
    cardinality(products) <= 12 and products <@ array[
      'personal CC', 'personal loans', 'biz CC', 'biz line of credit', 'biz term loans'
    ]::text[]
  ),
  add constraint offer_layers_voice_len_chk check (
    (voice_style_answer is null or length(voice_style_answer) <= 180)
    and (voice_objection_answer is null or length(voice_objection_answer) <= 180)
    and (voice_followup_answer is null or length(voice_followup_answer) <= 180)
  ),
  add constraint offer_layers_money_range_chk check (
    (monthly_revenue_min_cents is null or monthly_revenue_min_cents >= 0)
    and (funding_goal_min_cents is null or funding_goal_min_cents >= 0)
    and (funding_goal_max_cents is null or funding_goal_max_cents >= 0)
    and (funding_goal_min_cents is null or funding_goal_max_cents is null
      or funding_goal_min_cents <= funding_goal_max_cents)
  ),
  add constraint offer_layers_timeline_range_chk check (
    (results_timeline_min_days is null or results_timeline_min_days between 0 and 3650)
    and (results_timeline_max_days is null or results_timeline_max_days between 0 and 3650)
    and (results_timeline_min_days is null or results_timeline_max_days is null
      or results_timeline_min_days <= results_timeline_max_days)
  ),
  add constraint offer_layers_refund_posture_chk check (
    refund_posture is null or refund_posture in ('none', 'conditional', 'published_policy')
  ),
  add constraint offer_layers_content_hash_chk check (
    content_hash is null or content_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint offer_layers_published_hash_chk check (
    status = 'draft' or content_hash is not null
  );
create unique index offer_layers_one_draft_uidx
  on public.offer_layers (tenant_id) where status = 'draft';
create unique index offer_layers_one_published_uidx
  on public.offer_layers (tenant_id) where status = 'published';
create index offer_layers_tenant_status_idx on public.offer_layers (tenant_id, status, version desc);
comment on table public.offer_layers is
  'Versioned tenant offer authority. Drafts are mutable only through save_offer_draft; published and superseded rows are historical evidence.';

create table public.offer_prices (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  label text not null check (length(label) between 1 and 60),
  amount_cents bigint not null check (amount_cents >= 0),
  billing_period text check (billing_period is null or billing_period in ('one_time', 'monthly', 'annual')),
  created_at timestamptz not null default now(),
  foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete cascade
);
create index offer_prices_offer_idx on public.offer_prices (offer_id, id);

create table public.offer_proof_entries (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null check (length(title) between 1 and 90),
  detail text not null check (length(detail) between 1 and 280),
  created_at timestamptz not null default now(),
  foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete cascade
);
create index offer_proof_entries_offer_idx on public.offer_proof_entries (offer_id, id);

create table public.offer_assets (
  id uuid primary key default gen_random_uuid(),
  offer_id uuid not null,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and length(slug) <= 64),
  label text not null check (length(label) between 1 and 90),
  url text not null check (url ~ '^https://[^[:space:]]+$' and length(url) <= 500),
  created_at timestamptz not null default now(),
  unique (offer_id, slug),
  foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete cascade
);
create index offer_assets_offer_idx on public.offer_assets (offer_id, id);

create table public.admin_action_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 80),
  body text not null check (length(body) between 1 and 1000),
  created_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index admin_action_templates_tenant_idx on public.admin_action_templates (tenant_id, created_at desc);

create table public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  body text not null check (length(body) between 1 and 2000),
  created_by uuid not null references public.users(id),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index contact_notes_contact_idx on public.contact_notes (contact_id, created_at desc);

do $$
begin
  if exists (
    select 1 from public.offer_cadence_purposes cadence
    where not exists (
      select 1 from public.offer_layers offer
      where offer.tenant_id = cadence.tenant_id and offer.status = 'draft'
    )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE2_CADENCE_OFFER_REMEDIATION_REQUIRED',
      detail = 'Create one draft offer per cadence tenant before retrying.';
  end if;
end
$$;
alter table public.offer_cadence_purposes add column offer_id uuid;
update public.offer_cadence_purposes cadence
set offer_id = offer.id
from public.offer_layers offer
where offer.tenant_id = cadence.tenant_id and offer.status = 'draft';
alter table public.offer_cadence_purposes
  alter column offer_id set not null,
  add constraint offer_cadence_purposes_offer_fkey
    foreign key (offer_id, tenant_id) references public.offer_layers(id, tenant_id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 4. Repo-held eval identity and complete per-turn trace evidence
-- ---------------------------------------------------------------------------

alter table public.eval_cases
  add column turns jsonb,
  add column expectation jsonb,
  add column suite text,
  add column kind text,
  add column source_tenant_id uuid references public.tenants(id),
  add column source_conversation_id uuid references public.conversations(id) on delete set null,
  add column source_message_id uuid references public.messages(id) on delete set null,
  add column source_contact_id uuid references public.contacts(id) on delete set null,
  add column promoted_by uuid references public.users(id);
update public.eval_cases
set turns = jsonb_build_array(prompt),
    expectation = case when expected_outcome is null then '{}'::jsonb
      else jsonb_build_object('outcome', expected_outcome::text) end,
    suite = case category
      when 'qualification' then 'qualification_accuracy'
      when 'voice' then 'voice_tone'
      when 'pricing' then 'pricing_discipline'
      when 'injection' then 'jailbreak_injection'
      else 'compliance_guardrails' end,
    kind = 'engine'
where turns is null;
alter table public.eval_cases
  alter column turns set not null,
  alter column expectation set not null,
  alter column suite set not null,
  alter column kind set not null,
  add constraint eval_cases_turns_chk check (jsonb_typeof(turns) = 'array' and jsonb_array_length(turns) > 0),
  add constraint eval_cases_expectation_chk check (jsonb_typeof(expectation) = 'object'),
  add constraint eval_cases_suite_chk check (suite in ('qualification_accuracy', 'voice_tone')),
  add constraint eval_cases_kind_chk check (kind = 'engine'),
  drop column prompt,
  drop column expected_outcome;

alter table public.eval_runs
  add column brain_draft_version_id uuid references public.brain_draft_versions(id),
  add column content_hash text,
  add column brain_version int,
  add column offer_version int,
  add column rules_version text,
  add column knowledge_mode text,
  add column tenant_id uuid references public.tenants(id),
  add column source text,
  add column kind text,
  add column corpus_revision text,
  add column suites_complete boolean not null default false;
alter table public.eval_runs alter column model_config_id drop not null;
alter table public.eval_runs
  alter column brain_draft_version_id set not null,
  alter column content_hash set not null,
  alter column rules_version set not null,
  alter column source set not null,
  alter column kind set not null,
  alter column corpus_revision set not null,
  add constraint eval_runs_content_hash_chk check (content_hash ~ '^[0-9a-f]{64}$'),
  add constraint eval_runs_kind_chk check (kind in ('checker', 'engine')),
  add constraint eval_runs_model_shape_chk check (
    (kind = 'engine' and model_config_id is not null)
    or (kind = 'checker' and model_config_id is null)
  ),
  add constraint eval_runs_knowledge_mode_chk
    check (knowledge_mode is null or knowledge_mode in ('inline', 'retrieved'));

alter table public.eval_case_results drop constraint eval_case_results_run_id_case_id_key;
alter table public.eval_case_results
  add column case_key text,
  add column suite text,
  alter column case_id drop not null,
  add constraint eval_case_results_identity_chk check (case_id is not null or nullif(btrim(case_key), '') is not null),
  add constraint eval_case_results_suite_chk check (suite in (
    'compliance_guardrails', 'pricing_discipline', 'jailbreak_injection',
    'output_integrity', 'qualification_accuracy', 'voice_tone'
  ));
create unique index eval_case_results_run_case_uidx
  on public.eval_case_results (run_id, coalesce(case_key, case_id::text));

alter table public.brain_snapshots
  add constraint brain_snapshots_eval_run_fkey
  foreign key (eval_run_id) references public.eval_runs(id) on delete restrict;

alter table public.message_traces
  add column retrieval_candidates jsonb not null default '[]'::jsonb,
  add column declared_entry_id uuid,
  add column citation_verified boolean not null default false,
  add column dropped_entry_ids uuid[] not null default '{}',
  add column offer_content_hash text;
alter table public.message_traces
  add constraint message_traces_retrieval_candidates_chk
    check (jsonb_typeof(retrieval_candidates) = 'array'),
  add constraint message_traces_citation_shape_chk
    check (not citation_verified or declared_entry_id is not null),
  add constraint message_traces_offer_hash_chk
    check (offer_content_hash is null or offer_content_hash ~ '^[0-9a-f]{64}$');

alter table public.brain_knowledge_entries
  add constraint brain_knowledge_entries_import_item_fkey
  foreign key (import_item_id) references public.brain_import_items(id) on delete set null;

-- ---------------------------------------------------------------------------
-- 5. Registry actions and immutable-history triggers
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('brain.import.accepted', 'human', 'platform', false, false,
    'Import acceptance logged', 'Brain import acceptance recorded in the audit log'),
  ('brain.published', 'human', 'platform', true, false,
    'Publish logged', 'Brain publish recorded in the audit log'),
  ('brain.rolled_back', 'human', 'platform', true, false,
    'Rollback logged', 'Brain rollback recorded in the audit log'),
  ('offer.published', 'human', 'tenant', false, true,
    'Offer publish logged', 'Offer publish recorded in the audit log'),
  ('platform_export.started', 'human', 'platform', true, false,
    'Platform export start logged', 'Platform export start recorded in the audit log'),
  ('platform_export.finished', 'human', 'platform', true, false,
    'Platform export completion logged', 'Platform export completion recorded in the audit log');

-- The alert rule lands with its typed emitter in Plan 07 so the registry cannot claim a path
-- that no state-owning code can produce.
insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled)
values
  ('brain.publish_failed', 'platform', 'Brain publish failed',
   'A reviewed Brain publish transaction was refused.', 'brain', '{owner,admin}', false, false,
   '{bell}', false, true);

create or replace function app.phase2_reject_immutable_update_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'PHASE2_IMMUTABLE_HISTORY:%', tg_table_name;
end;
$$;

create trigger brain_draft_versions_immutable
before update or delete on public.brain_draft_versions
for each row execute function app.phase2_reject_immutable_update_delete();
create trigger brain_snapshots_immutable
before update or delete on public.brain_snapshots
for each row execute function app.phase2_reject_immutable_update_delete();
create trigger brain_snapshot_entries_immutable
before update or delete on public.brain_snapshot_entries
for each row execute function app.phase2_reject_immutable_update_delete();

-- A publish is the only legal change to historical offer rows: the current published row may move
-- to superseded without changing any content. Superseded rows and every other published mutation
-- remain immutable even to the database owner.
create or replace function app.phase2_enforce_offer_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and old.status in ('published', 'superseded') then
    raise exception 'OFFER_HISTORY_IMMUTABLE';
  end if;
  if tg_op = 'UPDATE' and old.status in ('published', 'superseded') then
    if old.status = 'published' and new.status = 'superseded'
      and (to_jsonb(new) - array['status', 'updated_at']) = (to_jsonb(old) - array['status', 'updated_at']) then
      return new;
    end if;
    raise exception 'OFFER_HISTORY_IMMUTABLE';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger offer_layers_history_guard
before update or delete on public.offer_layers
for each row execute function app.phase2_enforce_offer_history();

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
      select is_demo into inherited from public.tenants where id = new.tenant_id;
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
      if new.appointment_id is not null then
        select is_test into inherited from public.appointments where id = new.appointment_id;
      else
        select is_test into inherited from public.billable_events where id = new.adjusts_event_id;
      end if;
    when 'brain_knowledge_usage_events' then
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
    else
      raise exception 'IS_TEST_TRIGGER_UNSUPPORTED_TABLE:%', tg_table_name;
  end case;

  if inherited is null then
    raise exception 'IS_TEST_PARENT_NOT_FOUND:%', tg_table_name;
  end if;
  new.is_test := inherited;
  return new;
end;
$$;

create trigger inherit_is_test
before insert or update on public.contact_notes
for each row execute function app.inherit_is_test();

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'brain_mission', 'compliance_rules',
    'holding_replies', 'admin_action_templates', 'contact_notes'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function app.set_updated_at()', table_name
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Service-only transition, eval, retrieval, and platform-export RPCs
-- ---------------------------------------------------------------------------

create or replace function app.phase2_assert_platform_actor(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_role public.user_role;
begin
  if not app.not_impersonating() then
    raise exception 'IMPERSONATION_WRITE_FORBIDDEN';
  end if;
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role is null or actor_role not in ('owner', 'admin', 'success') then
    raise exception 'PHASE2_PLATFORM_ACTOR_FORBIDDEN';
  end if;
end;
$$;

create or replace function app.phase2_json_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.accept_brain_import_item(
  p_expected_batch_id uuid,
  p_expected_source_ref text,
  p_item_id uuid,
  p_disposition text,
  p_number_bindings jsonb,
  p_embedding vector(1536),
  p_actor_id uuid
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
  select count(*) into unresolved_count
  from jsonb_array_elements(item.flags) flag
  where coalesce(flag ->> 'severity', 'blocking') = 'blocking'
    and coalesce(flag ->> 'resolved', 'false') <> 'true';
  if unresolved_count > 0 then raise exception 'BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED'; end if;
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
    response_template, embedding, import_item_id
  ) values (
    item.after_payload ->> 'inboundMessage', item.after_payload ->> 'responseTemplate',
    item.after_payload ->> 'category', coalesce(array(
      select jsonb_array_elements_text(coalesce(item.after_payload -> 'matchKeywords', '[]'::jsonb))
    ), '{}'::text[]), 'draft', batch.source, item.source_ref, p_disposition,
    item.after_payload ->> 'responseTemplate', p_embedding, item.id
  )
  on conflict (source, source_ref) where source_ref is not null do update
  set question = excluded.question,
      answer = excluded.answer,
      category = excluded.category,
      match_keywords = excluded.match_keywords,
      status = 'draft',
      published_at = null,
      disposition = excluded.disposition,
      response_template = excluded.response_template,
      embedding = excluded.embedding,
      import_item_id = excluded.import_item_id,
      updated_at = now()
  returning id into entry_id;

  update public.brain_import_items
  set disposition = p_disposition,
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
      'disposition', p_disposition
    )
  );
  return query select entry_id, written_audit_id;
end;
$$;

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
  if p_expected_content_hash is null or p_expected_content_hash <> app.phase2_json_hash(p_payload) then
    raise exception 'BRAIN_DRAFT_CONTENT_HASH_MISMATCH';
  end if;
  insert into public.brain_draft_versions (content_hash, payload, created_by)
  values (p_expected_content_hash, p_payload, p_actor_id) returning id into draft_id;
  return draft_id;
end;
$$;

create or replace function public.record_eval_run(
  p_expected_draft_id uuid,
  p_expected_content_hash text,
  p_kind text,
  p_model_config_id uuid,
  p_corpus_revision text,
  p_suite_results jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.brain_draft_versions%rowtype;
  run_id uuid;
  suite jsonb;
  case_result jsonb;
  required_suites constant text[] := array[
    'compliance_guardrails', 'pricing_discipline', 'jailbreak_injection',
    'output_integrity', 'qualification_accuracy', 'voice_tone'
  ];
  supplied_suites text[];
  total_cases int := 0;
  passed_cases int := 0;
begin
  perform app.assert_not_impersonating();
  select * into draft from public.brain_draft_versions
  where id = p_expected_draft_id for share;
  if draft.id is null then raise exception 'EVAL_DRAFT_NOT_FOUND'; end if;
  if draft.content_hash <> p_expected_content_hash then raise exception 'EVAL_DRAFT_HASH_MISMATCH'; end if;
  if p_kind not in ('checker', 'engine') then raise exception 'EVAL_KIND_INVALID'; end if;
  if (p_kind = 'checker' and p_model_config_id is not null)
    or (p_kind = 'engine' and p_model_config_id is null) then
    raise exception 'EVAL_MODEL_CONFIG_SHAPE_INVALID';
  end if;
  if nullif(btrim(p_corpus_revision), '') is null
    or jsonb_typeof(p_suite_results) <> 'array' then
    raise exception 'EVAL_SUITE_RESULTS_INVALID';
  end if;
  select array_agg(value order by value) into supplied_suites
  from (
    select distinct suite_element ->> 'suite' as value
    from jsonb_array_elements(p_suite_results) suite_element
  ) names;
  if supplied_suites is distinct from (
    select array_agg(value order by value) from unnest(required_suites) value
  ) then
    raise exception 'EVAL_SUITES_INCOMPLETE';
  end if;

  insert into public.eval_runs (
    model_config_id, brain_draft_version_id, content_hash, rules_version, source, kind,
    corpus_revision, suites_complete, ran_by, finished_at, config_source
  ) values (
    p_model_config_id, draft.id, draft.content_hash, p_corpus_revision, 'repo_corpus', p_kind,
    p_corpus_revision, true, draft.created_by, now(), 'draft'
  ) returning id into run_id;

  for suite in select value from jsonb_array_elements(p_suite_results) loop
    if jsonb_typeof(suite -> 'cases') <> 'array' or jsonb_array_length(suite -> 'cases') = 0 then
      raise exception 'EVAL_SUITE_CASES_REQUIRED:%', suite ->> 'suite';
    end if;
    for case_result in select value from jsonb_array_elements(suite -> 'cases') loop
      if nullif(btrim(case_result ->> 'caseKey'), '') is null then
        raise exception 'EVAL_CASE_KEY_REQUIRED';
      end if;
      insert into public.eval_case_results (
        run_id, case_id, case_key, suite, passed, actual_outcome, response, trace,
        latency_ms, cost_cents
      ) values (
        run_id, null, case_result ->> 'caseKey', suite ->> 'suite',
        coalesce((case_result ->> 'passed')::boolean, false),
        case when case_result ? 'actualOutcome'
          then (case_result ->> 'actualOutcome')::public.outcome else null end,
        case_result ->> 'response', case_result -> 'trace',
        nullif(case_result ->> 'latencyMs', '')::int,
        nullif(case_result ->> 'costCents', '')::int
      );
      total_cases := total_cases + 1;
      if coalesce((case_result ->> 'passed')::boolean, false) then
        passed_cases := passed_cases + 1;
      end if;
    end loop;
  end loop;
  update public.eval_runs
  set pass_rate = round((passed_cases::numeric * 100) / nullif(total_cases, 0), 2)
  where id = run_id;
  return run_id;
end;
$$;

create or replace function public.save_offer_draft(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_draft_id uuid,
  p_expected_content_hash text,
  p_offer jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.offer_layers%rowtype;
  unknown_key text;
  next_version int;
  price jsonb;
  proof jsonb;
  asset jsonb;
  purpose jsonb;
  asset_host text;
  allowed_hosts text[];
begin
  perform app.assert_not_impersonating();
  if not exists (
    select 1 from public.users actor
    where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) then
    raise exception 'OFFER_ACTOR_NOT_AUTHORIZED';
  end if;
  if jsonb_typeof(p_offer) <> 'object' then raise exception 'OFFER_PAYLOAD_INVALID'; end if;
  select key into unknown_key
  from jsonb_object_keys(p_offer) key
  where key not in (
    'programName', 'programDescription', 'creditMin', 'fundingGoalMinCents',
    'fundingGoalMaxCents', 'monthlyRevenueMinCents', 'products', 'creditRepair',
    'bookingHorizonDays', 'bookingMode', 'brandVoice', 'resultsTimelineMinDays',
    'resultsTimelineMaxDays', 'refundPosture', 'voiceStyleAnswer',
    'voiceObjectionAnswer', 'voiceFollowupAnswer', 'prices', 'proof', 'assets',
    'cadencePurposes', 'contentHash'
  ) limit 1;
  if unknown_key is not null then raise exception 'OFFER_PLATFORM_FIELD_FORBIDDEN:%', unknown_key; end if;

  if p_draft_id is not null then
    select * into draft from public.offer_layers
    where id = p_draft_id and status = 'draft' for update;
    if draft.id is null then raise exception 'OFFER_DRAFT_NOT_FOUND'; end if;
    perform app.assert_expected_tenant(p_expected_tenant, draft.tenant_id, 'offer_draft');
    if draft.content_hash is distinct from p_expected_content_hash then
      raise exception 'OFFER_DRAFT_STALE';
    end if;
  else
    if exists (select 1 from public.offer_layers where tenant_id = p_expected_tenant and status = 'draft') then
      raise exception 'OFFER_DRAFT_ALREADY_EXISTS';
    end if;
    select coalesce(max(version), 0) + 1 into next_version
    from public.offer_layers where tenant_id = p_expected_tenant;
    insert into public.offer_layers (tenant_id, id, status, version)
    values (p_expected_tenant, gen_random_uuid(), 'draft', next_version)
    returning * into draft;
  end if;

  update public.offer_layers set
    program_name = nullif(btrim(p_offer ->> 'programName'), ''),
    program_description = nullif(btrim(p_offer ->> 'programDescription'), ''),
    credit_min = nullif(p_offer ->> 'creditMin', '')::int,
    funding_goal_min_cents = nullif(p_offer ->> 'fundingGoalMinCents', '')::bigint,
    funding_goal_max_cents = nullif(p_offer ->> 'fundingGoalMaxCents', '')::bigint,
    monthly_revenue_min_cents = nullif(p_offer ->> 'monthlyRevenueMinCents', '')::bigint,
    products = coalesce(array(select jsonb_array_elements_text(coalesce(p_offer -> 'products', '[]'::jsonb))), '{}'),
    credit_repair = nullif(p_offer ->> 'creditRepair', ''),
    booking_horizon_days = coalesce(nullif(p_offer ->> 'bookingHorizonDays', '')::int, 21),
    booking_mode = coalesce(nullif(p_offer ->> 'bookingMode', ''), 'direct'),
    brand_voice = nullif(p_offer ->> 'brandVoice', ''),
    results_timeline_min_days = nullif(p_offer ->> 'resultsTimelineMinDays', '')::int,
    results_timeline_max_days = nullif(p_offer ->> 'resultsTimelineMaxDays', '')::int,
    refund_posture = nullif(p_offer ->> 'refundPosture', ''),
    voice_style_answer = nullif(btrim(p_offer ->> 'voiceStyleAnswer'), ''),
    voice_objection_answer = nullif(btrim(p_offer ->> 'voiceObjectionAnswer'), ''),
    voice_followup_answer = nullif(btrim(p_offer ->> 'voiceFollowupAnswer'), ''),
    content_hash = nullif(p_offer ->> 'contentHash', ''),
    updated_at = now()
  where id = draft.id;

  if jsonb_typeof(coalesce(p_offer -> 'prices', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'prices', '[]'::jsonb)) > 8 then
    raise exception 'OFFER_PRICE_CAP_EXCEEDED';
  end if;
  if jsonb_typeof(coalesce(p_offer -> 'proof', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'proof', '[]'::jsonb)) > 12 then
    raise exception 'OFFER_PROOF_CAP_EXCEEDED';
  end if;
  if jsonb_typeof(coalesce(p_offer -> 'assets', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_offer -> 'assets', '[]'::jsonb)) > 12 then
    raise exception 'OFFER_ASSET_CAP_EXCEEDED';
  end if;

  delete from public.offer_prices where offer_id = draft.id;
  for price in select value from jsonb_array_elements(coalesce(p_offer -> 'prices', '[]'::jsonb)) loop
    insert into public.offer_prices (offer_id, tenant_id, label, amount_cents, billing_period)
    values (draft.id, p_expected_tenant, price ->> 'label', (price ->> 'amountCents')::bigint,
      nullif(price ->> 'billingPeriod', ''));
  end loop;
  delete from public.offer_proof_entries where offer_id = draft.id;
  for proof in select value from jsonb_array_elements(coalesce(p_offer -> 'proof', '[]'::jsonb)) loop
    insert into public.offer_proof_entries (offer_id, tenant_id, title, detail)
    values (draft.id, p_expected_tenant, proof ->> 'title', proof ->> 'detail');
  end loop;

  select link_whitelist into allowed_hosts
  from public.tenant_settings where tenant_id = p_expected_tenant;
  delete from public.offer_assets where offer_id = draft.id;
  for asset in select value from jsonb_array_elements(coalesce(p_offer -> 'assets', '[]'::jsonb)) loop
    asset_host := lower(regexp_replace(asset ->> 'url', '^https://([^/]+).*$','\1'));
    if allowed_hosts is null or not exists (
      select 1 from unnest(allowed_hosts) allowed
      where asset_host = lower(allowed) or asset_host like '%.' || lower(allowed)
    ) then
      raise exception 'OFFER_ASSET_HOST_NOT_WHITELISTED';
    end if;
    insert into public.offer_assets (offer_id, tenant_id, slug, label, url)
    values (draft.id, p_expected_tenant, asset ->> 'slug', asset ->> 'label', asset ->> 'url');
  end loop;

  delete from public.offer_cadence_purposes where offer_id = draft.id;
  for purpose in select value from jsonb_array_elements(coalesce(p_offer -> 'cadencePurposes', '[]'::jsonb)) loop
    insert into public.offer_cadence_purposes
      (tenant_id, offer_id, channel_class, touch_no, purpose, asset_id)
    values (
      p_expected_tenant, draft.id, (purpose ->> 'channelClass')::public.cadence_channel_class,
      (purpose ->> 'touchNo')::int, (purpose ->> 'purpose')::public.followup_purpose,
      nullif(purpose ->> 'assetId', '')
    );
  end loop;
  return draft.id;
end;
$$;

create or replace function public.publish_offer_draft(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_draft_id uuid,
  p_expected_content_hash text
)
returns table (offer_id uuid, offer_version int, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  draft public.offer_layers%rowtype;
  prior public.offer_layers%rowtype;
  written_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if not exists (
    select 1 from public.users actor
    where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) then raise exception 'OFFER_ACTOR_NOT_AUTHORIZED'; end if;
  select * into draft from public.offer_layers
  where id = p_draft_id and status = 'draft' for update;
  if draft.id is null then raise exception 'OFFER_DRAFT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, draft.tenant_id, 'offer_draft');
  if draft.content_hash is null or draft.content_hash <> p_expected_content_hash then
    raise exception 'OFFER_DRAFT_HASH_MISMATCH';
  end if;
  select * into prior from public.offer_layers
  where tenant_id = p_expected_tenant and status = 'published' for update;
  if prior.id is not null then
    update public.offer_layers set status = 'superseded', updated_at = now() where id = prior.id;
  end if;
  update public.offer_layers set status = 'published', published_at = now(), updated_at = now()
  where id = draft.id;
  written_audit_id := app.write_audit_row(
    'offer.published', p_actor_id, p_expected_tenant, 'offer_layer', draft.id::text,
    null, jsonb_build_object(
      'prior', case when prior.id is null then null else jsonb_build_object(
        'id', prior.id, 'version', prior.version, 'content_hash', prior.content_hash) end,
      'new', jsonb_build_object('id', draft.id, 'version', draft.version, 'content_hash', draft.content_hash)
    )
  );
  return query select draft.id, draft.version, written_audit_id;
end;
$$;

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

create or replace function public.match_published_brain_entries(
  p_expected_snapshot_id uuid,
  p_query_embedding vector(1536),
  p_category_hint text default null,
  p_limit int default 5
)
returns table (
  entry_id uuid,
  category text,
  response_template text,
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
    ranked.similarity, ranked.category_boost,
    ranked.similarity + ranked.category_boost as score
  from (
    select entry.entry_id, entry.category, entry.response_template,
      (1 - (entry.embedding operator(extensions.<=>) p_query_embedding))::double precision as similarity,
      case when nullif(btrim(p_category_hint), '') is not null
        and lower(btrim(entry.category)) = lower(btrim(p_category_hint))
        then 0.05::double precision else 0::double precision end as category_boost
    from public.brain_snapshot_entries entry
    where entry.snapshot_id = current_snapshot_id
  ) ranked
  order by (ranked.similarity + ranked.category_boost) desc, ranked.entry_id
  limit p_limit;
end;
$$;

create or replace function public.start_platform_export(
  p_actor_id uuid,
  p_resource text,
  p_filter jsonb,
  p_columns text[],
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if nullif(btrim(p_resource), '') is null then raise exception 'PLATFORM_EXPORT_RESOURCE_REQUIRED'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'PLATFORM_EXPORT_REASON_REQUIRED'; end if;
  if p_columns is null or cardinality(p_columns) = 0 then raise exception 'PLATFORM_EXPORT_COLUMNS_REQUIRED'; end if;
  return app.write_audit_row(
    'platform_export.started', p_actor_id, null, 'platform_export', p_resource, p_reason,
    jsonb_build_object('filter', coalesce(p_filter, '{}'::jsonb), 'columns', p_columns)
  );
end;
$$;

create or replace function public.finish_platform_export(
  p_actor_id uuid,
  p_export_id bigint,
  p_rows bigint,
  p_bytes bigint,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  started public.audit_log%rowtype;
begin
  perform app.phase2_assert_platform_actor(p_actor_id);
  if p_rows < 0 then raise exception 'PLATFORM_EXPORT_ROW_COUNT_INVALID'; end if;
  if p_bytes < 0 then raise exception 'PLATFORM_EXPORT_BYTE_COUNT_INVALID'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'PLATFORM_EXPORT_REASON_REQUIRED'; end if;
  select * into started from public.audit_log
  where id = p_export_id and action = 'platform_export.started' for share;
  if started.id is null or started.actor_id <> p_actor_id or started.tenant_id is not null
    or started.target_type <> 'platform_export' then
    raise exception 'PLATFORM_EXPORT_START_NOT_FOUND';
  end if;
  if exists (
    select 1 from public.audit_log finished
    where finished.action = 'platform_export.finished'
      and (finished.payload ->> 'started_audit_id')::bigint = p_export_id
  ) then raise exception 'PLATFORM_EXPORT_ALREADY_FINISHED'; end if;
  return app.write_audit_row(
    'platform_export.finished', p_actor_id, null, 'platform_export', started.target_id, p_reason,
    jsonb_build_object('started_audit_id', p_export_id, 'row_count', p_rows, 'byte_count', p_bytes)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Forced RLS, explicit grant matrices, and direct-write custody
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'brain_mission', 'brain_import_batches', 'brain_import_items', 'brain_draft_versions',
    'brain_snapshots', 'brain_snapshot_entries', 'compliance_rules', 'holding_replies',
    'offer_prices', 'offer_proof_entries', 'offer_assets', 'admin_action_templates', 'contact_notes'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
  end loop;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'brain_mission', 'brain_import_batches', 'brain_import_items', 'brain_draft_versions',
    'brain_snapshots', 'brain_snapshot_entries', 'compliance_rules', 'holding_replies'
  ] loop
    execute format(
      'create policy phase2_platform_read on public.%I for select to authenticated
       using (app.is_platform_user())', table_name
    );
    execute format('grant select on public.%I to authenticated', table_name);
    execute format('revoke insert, update, delete on public.%I from authenticated', table_name);
  end loop;
end
$$;

create policy offer_prices_tenant_read on public.offer_prices for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy offer_prices_platform_read on public.offer_prices for select to authenticated
  using (app.is_platform_user());
create policy offer_proof_entries_tenant_read on public.offer_proof_entries for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy offer_proof_entries_platform_read on public.offer_proof_entries for select to authenticated
  using (app.is_platform_user());
create policy offer_assets_tenant_read on public.offer_assets for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy offer_assets_platform_read on public.offer_assets for select to authenticated
  using (app.is_platform_user());
create policy admin_action_templates_tenant_read on public.admin_action_templates for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy admin_action_templates_platform_read on public.admin_action_templates for select to authenticated
  using (app.is_platform_user());
create policy contact_notes_tenant_read on public.contact_notes for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy contact_notes_platform_read on public.contact_notes for select to authenticated
  using (app.is_platform_operator());

grant select on public.offer_prices, public.offer_proof_entries, public.offer_assets,
  public.admin_action_templates, public.contact_notes to authenticated;
revoke insert, update, delete on public.offer_prices, public.offer_proof_entries,
  public.offer_assets, public.admin_action_templates, public.contact_notes from authenticated;

-- Existing offer/config tables lose table-wide mutation. Service RPCs own offer history and a
-- coach keeps only the pre-existing settings columns that cannot weaken the link allowlist.
drop policy tenant_write on public.offer_layers;
drop policy platform_write on public.offer_layers;
revoke insert, update, delete on public.offer_layers from authenticated;
grant select on public.offer_layers to authenticated;
revoke insert, update, delete on public.offer_cadence_purposes from authenticated;
grant select on public.offer_cadence_purposes to authenticated;

revoke update on public.tenant_settings from authenticated;
grant update (timezone, quiet_hours_start, quiet_hours_end, notification_prefs,
  alert_webhook_url, updated_at) on public.tenant_settings to authenticated;

drop policy platform_all on public.eval_runs;
drop policy platform_all on public.eval_case_results;
create policy eval_runs_platform_read on public.eval_runs for select to authenticated
  using (app.is_platform_user());
create policy eval_case_results_platform_read on public.eval_case_results for select to authenticated
  using (app.is_platform_user());
revoke all on public.eval_runs, public.eval_case_results from authenticated;
grant select on public.eval_runs, public.eval_case_results to authenticated;

-- Platform authoring cases remain admin-writable, while the run/result authority is select-only.
drop policy platform_all on public.eval_cases;
create policy eval_cases_platform_read on public.eval_cases for select to authenticated
  using (app.is_platform_user());
create policy eval_cases_admin_write on public.eval_cases for all to authenticated
  using (app.is_platform_admin() and app.not_impersonating())
  with check (app.is_platform_admin() and app.not_impersonating());

-- Default privileges were revoked in Phase 1, but every Phase 2 function is locked explicitly so
-- later privilege changes cannot accidentally make a transition callable through PostgREST.
revoke execute on function app.phase2_reject_immutable_update_delete() from public, anon, authenticated;
revoke execute on function app.phase2_enforce_offer_history() from public, anon, authenticated;
revoke execute on function app.phase2_assert_platform_actor(uuid) from public, anon, authenticated;
revoke execute on function app.phase2_json_hash(jsonb) from public, anon, authenticated;

revoke execute on function public.accept_brain_import_item(uuid,text,uuid,text,jsonb,vector,uuid)
  from public, anon, authenticated;
revoke execute on function public.create_brain_draft_version(uuid,text,jsonb)
  from public, anon, authenticated;
revoke execute on function public.record_eval_run(uuid,text,text,uuid,text,jsonb)
  from public, anon, authenticated;
revoke execute on function public.save_offer_draft(uuid,uuid,uuid,text,jsonb)
  from public, anon, authenticated;
revoke execute on function public.publish_offer_draft(uuid,uuid,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.publish_brain_draft(uuid,uuid,text,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.rollback_brain_snapshot(uuid,int,int,text)
  from public, anon, authenticated;
revoke execute on function public.match_published_brain_entries(uuid,vector,text,int)
  from public, anon, authenticated;
revoke execute on function public.start_platform_export(uuid,text,jsonb,text[],text)
  from public, anon, authenticated;
revoke execute on function public.finish_platform_export(uuid,bigint,bigint,bigint,text)
  from public, anon, authenticated;

grant execute on function public.accept_brain_import_item(uuid,text,uuid,text,jsonb,vector,uuid),
  public.create_brain_draft_version(uuid,text,jsonb),
  public.record_eval_run(uuid,text,text,uuid,text,jsonb),
  public.save_offer_draft(uuid,uuid,uuid,text,jsonb),
  public.publish_offer_draft(uuid,uuid,uuid,text),
  public.publish_brain_draft(uuid,uuid,text,uuid,text),
  public.rollback_brain_snapshot(uuid,int,int,text),
  public.match_published_brain_entries(uuid,vector,text,int),
  public.start_platform_export(uuid,text,jsonb,text[],text),
  public.finish_platform_export(uuid,bigint,bigint,bigint,text)
  to service_role;

comment on function public.match_published_brain_entries(uuid,vector,text,int) is
  'Ranks only the current immutable snapshot. Category agreement adds exactly 0.05 and never filters.';
comment on function public.record_eval_run(uuid,text,text,uuid,text,jsonb) is
  'Only service_role can atomically record complete hash-bound suite evidence used by Brain publish.';
