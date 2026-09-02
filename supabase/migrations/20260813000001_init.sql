-- SetterFi — initial schema
-- Contract: docs/BACKEND-SPEC.md (§0 conventions, §1 auth/RLS, §2 GHL, §3 engine, §4 channels,
-- §5 brain, §6 onboarding, §7 TCPA, §8 billing, §9 evals, §10 security).
-- Conventions: uuid ids via gen_random_uuid(), timestamptz defaults, money in integer cents,
-- tenant_id on every tenant-owned row, ENABLE + FORCE row level security everywhere.
-- DDL only — no seed data.

-- ---------------------------------------------------------------------------
-- 0. Extensions, roles, helper schema
-- ---------------------------------------------------------------------------

-- Supabase pre-installs extensions into `extensions`; a bare Postgres puts them in `public`.
-- Creating the schema and widening search_path makes `vector(1536)` resolve either way.
create schema if not exists extensions;
create extension if not exists vector with schema extensions;
-- gen_random_uuid() is in core since PG13; pgcrypto kept available for digest()/crypt() helpers.
create extension if not exists pgcrypto with schema extensions;
set search_path = public, extensions;

-- Supabase provisions these roles. Created defensively so the migration also applies to a bare
-- Postgres 17 instance (local test harness, CI).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

create schema if not exists app;
comment on schema app is 'Internal helpers (RLS predicates, triggers). Not a client-facing API surface.';

-- ---------------------------------------------------------------------------
-- 1. Enum vocabulary
-- Qualification enums mirror src/lib/domain/qualification.ts verbatim (en-dashes included) so the
-- UI pills, the decision matrix, and the stored contact fields share one vocabulary.
-- ---------------------------------------------------------------------------

create type user_role as enum ('owner','admin','success','build','coach','coach_member','affiliate');
create type tenant_status as enum ('onboarding','active','paused','overdue','suspended','churned');

create type credit_range as enum ('below 600','600–640','640–680','680–700','700+','unknown');
create type funding_goal as enum ('<$50K','$50K–100K','$100K–150K','$150K+');
create type funding_timeline as enum ('ASAP–30d','1–3mo','3–6mo','exploring');
create type business_stage as enum ('startup','operating','unknown');
create type outcome as enum ('BOOK','SOFT_DQ','HARD_DQ');

create type convo_status as enum ('agent','needs_human','human','nurture','closed','opted_out');
create type message_direction as enum ('in','out','system');

-- One channel vocabulary. calendar_google / calendar_ghl are valid only on channel_connections.
create type channel as enum
  ('instagram','messenger','sms','whatsapp','webchat','calendar_google','calendar_ghl');
create type channel_provider as enum ('meta_direct','ghl');
create type channel_state as enum
  ('disconnected','connecting','pending_review','ready','live','error','expired');

create type publish_status as enum ('draft','published');
create type install_state as enum ('installed','token_ok','failed','uninstalled');

create type followup_purpose as enum
  ('lead_magnet','training','value_nudge','proof_point','new_angle','last_touch');
create type followup_status as enum ('scheduled','sent','canceled');

create type appointment_status as enum ('scheduled','confirmed','canceled','completed','no_show');

create type onboarding_step as enum
  ('signup','ghl_location','snapshot_wait','number_provision','a2p_submitted','meta_connect',
   'calendar_connect','offer_setup','test_pass','live');
create type a2p_state as enum
  ('not_started','brand_submitted','campaign_submitted','approved','rejected','blocked_10d');

create type meter_kind as enum ('booked_call','message');
create type commission_status as enum ('unpaid','paid','clawback');

create type webhook_provider as enum ('ghl','meta','stripe','notion','internal');
create type webhook_status as enum ('received','processed','failed','skipped');

create type unmatched_objection_status as enum ('open','resolved','dismissed');
create type notification_severity as enum ('info','success','warning','critical');

-- ---------------------------------------------------------------------------
-- 2. RLS helpers
--
-- TODO(auth): policies read tenant + role from JWT app_metadata, NOT from a `select ... from users`
-- subquery as sketched in BACKEND-SPEC §1. Reason: a policy on `users` that subqueries `users`
-- recurses (Postgres aborts with "infinite recursion detected in policy"), and the subquery costs a
-- lookup per row on every tenant table. A Supabase custom access token hook must stamp
-- app_metadata.tenant_id and app_metadata.role from public.users at token issue, and re-issue on
-- role/tenant change. Until that hook ships, authenticated sessions resolve to NULL tenant and see
-- nothing — deny by default, which is the safe failure direction.
-- ---------------------------------------------------------------------------

create or replace function app.jwt()
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
$$;

create or replace function app.claim(claim text)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(app.jwt() -> 'app_metadata' ->> claim, '');
$$;

-- Equivalent to auth.uid(); read from the raw claim so the function has no auth-schema dependency.
create or replace function app.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(app.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function app.current_user_role()
returns public.user_role
language sql
stable
set search_path = ''
as $$
  select app.claim('role')::public.user_role;
$$;

create or replace function app.is_platform_user()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.current_user_role() in ('owner','admin','success','build'), false);
$$;

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.current_user_role() in ('owner','admin'), false);
$$;

-- "View as" (BACKEND-SPEC §1): the short-lived `impersonating_tenant` claim is honoured for
-- platform roles only, and every impersonated session is audit-logged at the route layer.
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when app.is_platform_user()
      then coalesce(app.claim('impersonating_tenant'), app.claim('tenant_id'))::uuid
    else app.claim('tenant_id')::uuid
  end;
$$;

create or replace function app.owns_tenant(row_tenant_id uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select row_tenant_id is not null
     and app.current_tenant_id() is not null
     and row_tenant_id = app.current_tenant_id();
$$;

create or replace function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Tenancy, identity, audit (§1)
-- ---------------------------------------------------------------------------

create table tiers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price_cents int not null,
  call_allowance int not null,
  fair_use_cap int,
  stripe_price_id text unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table tiers is 'Outcome-based subscription tiers. Admin-editable prices/allowances/caps (§8).';

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  status tenant_status not null default 'onboarding',
  ghl_location_id text unique,
  success_owner uuid,                                  -- FK added after users exists
  tier_id uuid references tiers(id),
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table tenants is 'One row per coach business (GHL sub-account).';

create table users (
  id uuid primary key,                                 -- = auth.users.id (no FK: auth schema is platform-owned)
  email text unique not null,
  full_name text,
  role user_role not null,
  tenant_id uuid references tenants(id),               -- null for platform roles (owner/admin/success/build)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index users_tenant_id_idx on users (tenant_id);
create index users_role_idx on users (role);

alter table tenants
  add constraint tenants_success_owner_fkey foreign key (success_owner) references users(id);
create index tenants_success_owner_idx on tenants (success_owner);
create index tenants_status_idx on tenants (status);

create table tenant_settings (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  timezone text not null default 'America/New_York',   -- IANA; fallback when a contact has none
  quiet_hours_start time not null default '08:00',     -- §7 default window 8am–9pm, lead-local
  quiet_hours_end time not null default '21:00',
  link_whitelist text[] not null default '{}',         -- §10.3 no links unless whitelisted
  notification_prefs jsonb not null default '{}'::jsonb,
  alert_webhook_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references users(id),
  tenant_id uuid,                                      -- intentionally un-FK'd: platform-scope rows carry null
  action text not null,                                -- 'brain.publish','conversation.takeover','meter.adjust'
  target text,
  reason text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_id_idx on audit_log (tenant_id, created_at desc);
create index audit_log_actor_idx on audit_log (actor_id, created_at desc);
create index audit_log_action_idx on audit_log (action, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Integrations: GHL, channels, provider event plumbing (§2, §4)
-- ---------------------------------------------------------------------------

create table ghl_installs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id),               -- null until the location is matched to a tenant
  location_id text unique not null,
  company_id text not null,
  access_token text not null,                          -- ciphertext; written via Supabase Vault, never plaintext
  refresh_token text not null,                         -- ciphertext
  token_expires_at timestamptz not null,
  install_state install_state not null default 'installed',
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ghl_installs_tenant_id_idx on ghl_installs (tenant_id);
create index ghl_installs_state_idx on ghl_installs (install_state);
comment on column ghl_installs.access_token is 'Encrypted at rest. TODO(security): wire Vault/pgsodium column encryption before first real token lands.';

create table channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  channel channel not null,
  provider channel_provider not null,
  state channel_state not null default 'disconnected',
  external_ref jsonb,                                  -- page_id / waba_id / phone_number_id / calendar_id
  access_token text,                                   -- ciphertext; page/waba-scoped
  token_expires_at timestamptz,
  template_ids jsonb,                                  -- WhatsApp approved templates, outside the 24h window
  last_heartbeat_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel)
);
create index channel_connections_tenant_id_idx on channel_connections (tenant_id);
create index channel_connections_state_idx on channel_connections (state);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider webhook_provider not null,
  provider_event_id text not null,                     -- idempotency key (GHL/Meta/Stripe event or message id)
  tenant_id uuid references tenants(id),               -- null until the payload is resolved to a tenant
  event_type text,
  signature_verified boolean not null default false,
  payload jsonb not null,
  status webhook_status not null default 'received',
  attempts int not null default 0,
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (provider, provider_event_id)
);
create index webhook_events_status_idx on webhook_events (status, received_at);
create index webhook_events_tenant_id_idx on webhook_events (tenant_id);
comment on table webhook_events is 'Inbox for every provider webhook: ack <1s writes the row, waitUntil()/cron processes it. Replays are absorbed by the (provider, provider_event_id) unique key.';

create table integration_events (
  id bigint generated always as identity primary key,
  tenant_id uuid references tenants(id),
  provider webhook_provider not null,
  direction message_direction not null,                -- out = our call to them, in = their call to us
  endpoint text,
  status_code int,
  duration_ms int,
  request jsonb,
  response jsonb,
  error text,
  created_at timestamptz not null default now()
);
create index integration_events_tenant_id_idx on integration_events (tenant_id, created_at desc);
create index integration_events_provider_idx on integration_events (provider, created_at desc);

-- ---------------------------------------------------------------------------
-- 5. The brain — platform scope, admin-owned, no tenant_id (§5)
-- ---------------------------------------------------------------------------

create table brain_documents (
  id uuid primary key default gen_random_uuid(),
  source text not null default 'notion',               -- notion|manual
  notion_page_id text unique,
  title text not null,
  section text not null,                               -- qualification|objections|voice|compliance|knowledge|faq
  status publish_status not null default 'draft',
  version int not null default 1,
  body_md text not null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brain_documents_section_idx on brain_documents (section, status);

create table brain_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references brain_documents(id) on delete cascade,
  chunk_no int not null,
  content text not null,
  embedding vector(1536),
  published boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, chunk_no)
);
-- Retrieval reads published chunks only (§5). Over-fetch 2K then trim: the ANN index can return
-- fewer rows than K once the published filter is applied, so raise ef_search per query.
create index brain_chunks_embedding_idx on brain_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index brain_chunks_published_idx on brain_chunks (published);
create index brain_chunks_document_id_idx on brain_chunks (document_id);

create table brain_knowledge_entries (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  category text not null,
  match_keywords text[] not null default '{}',
  status publish_status not null default 'draft',
  version int not null default 1,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brain_knowledge_entries_category_idx on brain_knowledge_entries (category, status);
create index brain_knowledge_entries_keywords_idx on brain_knowledge_entries using gin (match_keywords);

create table brain_objections (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  pattern text,                                        -- optional regex; keywords are the primary matcher
  match_keywords text[] not null default '{}',         -- round-2 keyword chips
  response text not null,                              -- grounded reply text
  category text,
  status publish_status not null default 'draft',
  version int not null default 1,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index brain_objections_keywords_idx on brain_objections using gin (match_keywords);
create index brain_objections_status_idx on brain_objections (status);

-- The qualification decision matrix: data-driven, admin-edited, first-matching-row wins.
-- Column vocabulary mirrors QualificationRule in src/lib/domain/qualification.ts.
create table qualification_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,                       -- 'strong-credit','low-credit',...
  label text not null,
  position int not null,                               -- evaluation order; first match wins
  outcome outcome not null,
  min_score int,
  max_score int,
  credit_ranges credit_range[],
  business_stage business_stage,
  min_annual_revenue_cents bigint,
  funding_goals funding_goal[],
  timelines funding_timeline[],
  status publish_status not null default 'draft',
  version int not null default 1,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint qualification_rules_score_range_chk check (min_score is null or max_score is null or min_score <= max_score)
);
create unique index qualification_rules_position_idx on qualification_rules (position);
comment on table qualification_rules is 'Platform decision table (§3). Coach settings bound thresholds/enable/order only — they can never override an outcome.';

create table model_configs (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  openrouter_model text not null,
  params jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  last_benchmark_run_id uuid,                          -- FK added after eval_runs exists
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index model_configs_single_default_idx on model_configs (is_default) where is_default;

-- ---------------------------------------------------------------------------
-- 6. Per-tenant configuration: offer layer, flow, onboarding (§5, §6)
-- ---------------------------------------------------------------------------

create table offer_layers (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  program_name text,
  credit_min int,
  credit_min_enforced boolean not null default false,
  funding_goal_min_cents bigint,
  business_revenue_required boolean not null default false,
  credit_repair text check (credit_repair in ('yes_included','yes_extra_fee','no_refer_out','no_good_credit_only')),
  products text[] not null default '{}',
  pricing_gate boolean not null default true,
  booking_horizon_days int not null default 21,
  booking_mode text not null default 'direct' check (booking_mode in ('direct','link')),
  brand_voice text check (brand_voice in ('friendly','neutral','professional')),
  voice_answers jsonb,
  faq jsonb,
  proof jsonb,
  assets jsonb,                                        -- lead magnets
  cadence jsonb,                                       -- touches with followup_purpose values
  version int not null default 1,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table offer_layers is 'Coach self-editing. WARNING: the bounds this comment used to claim do not exist yet — there is no server-side field validation, no length constraint, and no draft/published split on this table, and the tenant_isolation policy below is not column-scoped. Free text here renders into prompt block [C] and is an injection surface; behavioral columns (cadence, assets, pricing_gate, credit_min_enforced) are coach-writable through PostgREST today. See docs/BRAIN-COMPILER.md §11 for what has to land and in what order.';

create table flow_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  questions jsonb not null default '[]'::jsonb,        -- ordered question list from the coach's UI
  version int not null default 1,
  status publish_status not null default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, version)
);
create index flow_configs_tenant_id_idx on flow_configs (tenant_id);
create unique index flow_configs_published_idx on flow_configs (tenant_id) where status = 'published';

create table onboarding_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  step onboarding_step not null default 'signup',
  a2p_state a2p_state not null default 'not_started',
  a2p_submitted_at timestamptz,                        -- drives the >10-day stuck flag
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index onboarding_runs_tenant_id_idx on onboarding_runs (tenant_id);
create index onboarding_runs_step_idx on onboarding_runs (step);

-- ---------------------------------------------------------------------------
-- 7. Conversation engine (§3)
-- ---------------------------------------------------------------------------

create table contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ghl_contact_id text,
  channel channel not null,
  name text,
  phone text,
  email text,
  credit_range credit_range,
  funding_goal funding_goal,
  timeline funding_timeline,
  business_stage business_stage,
  annual_revenue_cents bigint,
  business_context text,
  outcome outcome,
  dq_reason text,                                      -- mandatory on any DQ path (§3)
  opted_out boolean not null default false,
  opt_in_source text,                                  -- required before campaign-initiated outreach (§7)
  timezone text,                                       -- IANA; quiet-hours evaluation
  is_test boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ghl_contact_id)
);
create index contacts_tenant_id_idx on contacts (tenant_id);
create index contacts_tenant_test_idx on contacts (tenant_id, is_test, created_at desc);
create index contacts_tenant_phone_idx on contacts (tenant_id, phone);
create index contacts_outcome_idx on contacts (tenant_id, outcome);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  channel channel not null,
  status convo_status not null default 'agent',
  taken_over_by uuid references users(id),
  taken_over_at timestamptz,
  current_step text,                                   -- question id in the coach's flow
  first_touch_keyword text,                            -- keyword attribution captured at create (§9)
  model_config_id uuid references model_configs(id),
  scope_attack_count int not null default 0,           -- off-topic deflection exit cap (§10.1)
  is_test boolean not null default false,
  unread_by_coach boolean not null default true,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_tenant_id_idx on conversations (tenant_id);
create index conversations_contact_id_idx on conversations (contact_id);
create index conversations_tenant_status_idx on conversations (tenant_id, status, last_message_at desc);
create index conversations_tenant_test_idx on conversations (tenant_id, is_test);
create index conversations_keyword_idx on conversations (tenant_id, first_touch_keyword);

create table messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction message_direction not null,
  author text not null,                                -- agent|lead|human:<user_id>|system
  body text not null,
  provider text,
  provider_message_id text unique,                     -- inbound idempotency key (§2)
  trace jsonb,                                         -- grounding receipt: rule fired, chunk ids, model, latency, cost
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index messages_tenant_id_idx on messages (tenant_id);
create index messages_conversation_idx on messages (conversation_id, created_at);

create table followups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  touch_no int not null,
  purpose followup_purpose not null,
  scheduled_at timestamptz not null,
  status followup_status not null default 'scheduled',
  sent_at timestamptz,
  canceled_reason text,                                -- 'lead_reply'|'takeover'|'opted_out'|'hard_dq'
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index followups_tenant_id_idx on followups (tenant_id);
create index followups_conversation_idx on followups (conversation_id);
create index followups_due_idx on followups (scheduled_at) where status = 'scheduled';

create table appointments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  provider channel_provider not null default 'ghl',
  external_id text,                                    -- GHL appointment id / Google event id
  calendar_id text,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text,
  status appointment_status not null default 'scheduled',
  canceled_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id),
  constraint appointments_time_order_chk check (end_at > start_at)
);
create index appointments_tenant_id_idx on appointments (tenant_id);
create index appointments_tenant_start_idx on appointments (tenant_id, start_at desc);
create index appointments_contact_idx on appointments (contact_id);
comment on table appointments is 'Booked calls. Insert fires the booked_call meter event (§8) and the coach booking notification (§3).';

create table brain_knowledge_usage_events (
  id uuid primary key default gen_random_uuid(),
  knowledge_entry_id uuid not null references brain_knowledge_entries(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  tenant_id uuid not null references tenants(id) on delete cascade,
  used_at timestamptz not null default now(),
  is_test boolean not null default false
);
create index brain_knowledge_usage_tenant_idx on brain_knowledge_usage_events (tenant_id);
create index brain_knowledge_usage_entry_idx on brain_knowledge_usage_events (knowledge_entry_id, used_at desc);
comment on table brain_knowledge_usage_events is 'Derived usage volume — never typed into the entry (§5).';

create table unmatched_objections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  message_id uuid references messages(id) on delete set null,
  body text not null,
  occurrences int not null default 1,
  status unmatched_objection_status not null default 'open',
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  brain_objection_id uuid references brain_objections(id) on delete set null,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index unmatched_objections_tenant_idx on unmatched_objections (tenant_id, status);

-- ---------------------------------------------------------------------------
-- 8. TCPA enforcement (§7)
-- ---------------------------------------------------------------------------

create table dnc_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,   -- null = platform-wide suppression
  phone text not null,
  source text not null,                                      -- 'stop_keyword'|'manual'|'import'
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
create unique index dnc_entries_scope_phone_idx on dnc_entries
  ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), phone);
create index dnc_entries_phone_idx on dnc_entries (phone);

-- ---------------------------------------------------------------------------
-- 9. Billing, metering, affiliates (§8)
-- ---------------------------------------------------------------------------

create table meter_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind meter_kind not null,
  quantity int not null default 1,
  source_id uuid,                                      -- appointment id / message id
  adjusted_by uuid references users(id),
  adjust_reason text,
  stripe_reported boolean not null default false,
  stripe_reported_at timestamptz,
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint meter_events_adjustment_reason_chk check (adjusted_by is null or adjust_reason is not null)
);
create index meter_events_tenant_idx on meter_events (tenant_id, created_at desc);
create unique index meter_events_source_idx on meter_events (kind, source_id) where source_id is not null;
create index meter_events_unreported_idx on meter_events (created_at) where not stripe_reported;
comment on table meter_events is 'Meter events must reach Stripe within 35 days (§8). Manual adjustment requires a reason and writes audit_log.';

create table affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique not null references users(id) on delete cascade,
  referral_code text unique not null,
  link_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references affiliates(id) on delete cascade,
  tenant_id uuid unique not null references tenants(id) on delete cascade,
  started_at timestamptz,                              -- referred coach's first invoice.paid
  expires_at timestamptz,                              -- started_at + 12 months
  clawback boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index referrals_affiliate_idx on referrals (affiliate_id);

create table commission_ledger (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals(id) on delete cascade,
  month date not null,
  base_cents int not null,
  commission_cents int not null,                       -- 10% of subscription base
  status commission_status not null default 'unpaid',
  paid_by uuid references users(id),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (referral_id, month)
);
create index commission_ledger_status_idx on commission_ledger (status, month);

-- ---------------------------------------------------------------------------
-- 10. Evals + notifications (§9, §3)
-- ---------------------------------------------------------------------------

create table eval_cases (
  id uuid primary key default gen_random_uuid(),
  prompt text not null,
  expected_outcome outcome,
  category text not null,                              -- qualification|compliance|injection|voice|pricing
  notes text,
  active boolean not null default true,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index eval_cases_category_idx on eval_cases (category) where active;

create table eval_runs (
  id uuid primary key default gen_random_uuid(),
  model_config_id uuid not null references model_configs(id),
  config_source publish_status not null default 'published',
  pass_rate numeric(5,2),
  cost_cents int,
  latency_ms int,
  ran_by uuid references users(id),
  finished_at timestamptz,
  created_at timestamptz not null default now()
);
create index eval_runs_model_idx on eval_runs (model_config_id, created_at desc);

create table eval_case_results (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references eval_runs(id) on delete cascade,
  case_id uuid not null references eval_cases(id) on delete cascade,
  passed boolean not null,
  actual_outcome outcome,
  response text,
  trace jsonb,
  latency_ms int,
  cost_cents int,
  created_at timestamptz not null default now(),
  unique (run_id, case_id)
);
create index eval_case_results_run_idx on eval_case_results (run_id);

alter table model_configs
  add constraint model_configs_last_benchmark_run_fkey
  foreign key (last_benchmark_run_id) references eval_runs(id) on delete set null;

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,  -- null = platform-scope alert
  user_id uuid references users(id) on delete cascade,      -- null = everyone in scope
  kind text not null,                                       -- 'appointment.booked','conversation.needs_human','a2p.stuck',...
  severity notification_severity not null default 'info',
  title text not null,
  body text,
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_tenant_idx on notifications (tenant_id, created_at desc);
create index notifications_unread_idx on notifications (user_id, created_at desc) where read_at is null;

-- ---------------------------------------------------------------------------
-- 11. updated_at triggers (every mutable table)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
  mutable_tables text[] := array[
    'tiers','tenants','users','tenant_settings','ghl_installs','channel_connections',
    'brain_documents','brain_chunks','brain_knowledge_entries','brain_objections',
    'qualification_rules','model_configs','offer_layers','flow_configs','onboarding_runs',
    'contacts','conversations','followups','appointments','unmatched_objections',
    'affiliates','referrals','commission_ledger','eval_cases'
  ];
begin
  foreach t in array mutable_tables loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function app.set_updated_at()', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 12. Row level security
--
-- Every table gets ENABLE + FORCE. service_role holds BYPASSRLS, which is why BACKEND-SPEC §0
-- requires webhook/job handlers to re-impose tenant scoping in code — RLS is the second line here,
-- not the only one. Policies are scoped `to authenticated`; anon is granted nothing at all, so the
-- public consumer chat route must run server-side under a scoped service-role handler.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'tiers','tenants','users','tenant_settings','audit_log','ghl_installs','channel_connections',
    'webhook_events','integration_events','brain_documents','brain_chunks',
    'brain_knowledge_entries','brain_objections','qualification_rules','model_configs',
    'offer_layers','flow_configs','onboarding_runs','contacts','conversations','messages',
    'followups','appointments','brain_knowledge_usage_events','unmatched_objections',
    'dnc_entries','meter_events','affiliates','referrals','commission_ledger','eval_cases',
    'eval_runs','eval_case_results','notifications'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;

-- --- Tenant-scoped tables: one isolation policy + one platform-read policy each ---------------
-- Baseline pattern (BACKEND-SPEC §1), applied uniformly. Per-table role nuance (success may not
-- publish brain or edit billing; coach_member may not touch billing) is enforced additionally in
-- route guards — TODO(auth): tighten the write halves once the access-token hook lands and roles
-- are trustworthy inside policies.

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenant_settings','channel_connections','offer_layers','flow_configs','onboarding_runs',
    'contacts','conversations','messages','followups','appointments',
    'brain_knowledge_usage_events','unmatched_objections','meter_events'
  ] loop
    execute format(
      'create policy tenant_isolation on public.%I for all to authenticated
         using (app.owns_tenant(tenant_id))
         with check (app.owns_tenant(tenant_id))', t);
    execute format(
      'create policy platform_read on public.%I for select to authenticated
         using (app.is_platform_user())', t);
    execute format(
      'create policy platform_write on public.%I for all to authenticated
         using (app.is_platform_user() and app.current_user_role() <> ''build'')
         with check (app.is_platform_user() and app.current_user_role() <> ''build'')', t);
  end loop;
end
$$;

-- --- Identity + tenancy -----------------------------------------------------------------------

create policy users_self_read on users for select to authenticated
  using (id = app.current_user_id());
-- No subquery on `users` here: a users-policy that reads users recurses. Self-escalation is blocked
-- by pinning role to the (server-issued) JWT claim.
create policy users_self_update on users for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id() and role = app.current_user_role());
create policy users_tenant_read on users for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy users_platform_read on users for select to authenticated
  using (app.is_platform_user());
create policy users_platform_write on users for all to authenticated
  using (app.is_platform_admin())
  with check (app.is_platform_admin());

create policy tenants_self_read on tenants for select to authenticated
  using (id = app.current_tenant_id());
create policy tenants_platform_read on tenants for select to authenticated
  using (app.is_platform_user());
create policy tenants_platform_write on tenants for all to authenticated
  using (app.is_platform_user() and app.current_user_role() <> 'build')
  with check (app.is_platform_user() and app.current_user_role() <> 'build');

-- Tiers are readable by everyone signed in (a coach sees their own plan); only owner/admin edit.
create policy tiers_read on tiers for select to authenticated using (true);
create policy tiers_admin_write on tiers for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

-- Audit log is append-only from the service role and readable by platform staff only. No
-- authenticated INSERT/UPDATE/DELETE policy exists, so clients cannot forge or erase entries.
create policy audit_log_platform_read on audit_log for select to authenticated
  using (app.is_platform_user());

-- --- Integration + ops tables: platform staff only (coaches never see provider plumbing) -------

create policy ghl_installs_platform_all on ghl_installs for all to authenticated
  using (app.is_platform_user()) with check (app.is_platform_user());
create policy webhook_events_platform_read on webhook_events for select to authenticated
  using (app.is_platform_user());
create policy integration_events_platform_read on integration_events for select to authenticated
  using (app.is_platform_user());

-- --- The brain: published content is world-readable to signed-in users, drafts are admin-only --
-- Draft context is available exclusively in evals/test panel, which run under platform roles (§5).

do $$
declare
  t text;
begin
  foreach t in array array['brain_documents','brain_knowledge_entries','brain_objections','qualification_rules'] loop
    execute format(
      'create policy published_read on public.%I for select to authenticated
         using (status = ''published'' or app.is_platform_user())', t);
    execute format(
      'create policy admin_write on public.%I for all to authenticated
         using (app.is_platform_admin()) with check (app.is_platform_admin())', t);
  end loop;
end
$$;

create policy brain_chunks_published_read on brain_chunks for select to authenticated
  using (published or app.is_platform_user());
create policy brain_chunks_admin_write on brain_chunks for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

create policy model_configs_platform_read on model_configs for select to authenticated
  using (app.is_platform_user());
create policy model_configs_admin_write on model_configs for all to authenticated
  using (app.is_platform_admin()) with check (app.is_platform_admin());

-- --- DNC: a tenant sees its own suppressions; platform-wide rows are platform-only -------------

create policy dnc_tenant_read on dnc_entries for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy dnc_tenant_insert on dnc_entries for insert to authenticated
  with check (app.owns_tenant(tenant_id));
create policy dnc_platform_all on dnc_entries for all to authenticated
  using (app.is_platform_user()) with check (app.is_platform_user());

-- --- Affiliates: own referral rows only, never the referred tenant's performance data ----------
-- TODO(security): the row exposes tenant_id and commission amounts; the affiliate API must project
-- name/status/commission only and never join tenant analytics (§1 role capabilities).

create policy affiliates_self_read on affiliates for select to authenticated
  using (user_id = app.current_user_id());
create policy affiliates_platform_all on affiliates for all to authenticated
  using (app.is_platform_user()) with check (app.is_platform_user());

create policy referrals_self_read on referrals for select to authenticated
  using (exists (select 1 from affiliates a
                 where a.id = referrals.affiliate_id and a.user_id = app.current_user_id()));
create policy referrals_platform_all on referrals for all to authenticated
  using (app.is_platform_user()) with check (app.is_platform_user());

create policy commission_self_read on commission_ledger for select to authenticated
  using (exists (select 1 from referrals r
                 join affiliates a on a.id = r.affiliate_id
                 where r.id = commission_ledger.referral_id and a.user_id = app.current_user_id()));
-- Payout settings are owner-only (§1: admin = everything minus payout settings).
create policy commission_platform_read on commission_ledger for select to authenticated
  using (app.is_platform_user());
create policy commission_owner_write on commission_ledger for all to authenticated
  using (app.current_user_role() = 'owner') with check (app.current_user_role() = 'owner');

-- --- Evals: platform staff only ----------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['eval_cases','eval_runs','eval_case_results'] loop
    execute format(
      'create policy platform_all on public.%I for all to authenticated
         using (app.is_platform_user()) with check (app.is_platform_user())', t);
  end loop;
end
$$;

-- --- Notifications: your own, or your tenant's ------------------------------------------------

create policy notifications_read on notifications for select to authenticated
  using (user_id = app.current_user_id()
         or app.owns_tenant(tenant_id)
         or (tenant_id is null and app.is_platform_user()));
create policy notifications_mark_read on notifications for update to authenticated
  using (user_id = app.current_user_id() or app.owns_tenant(tenant_id))
  with check (user_id = app.current_user_id() or app.owns_tenant(tenant_id));

-- ---------------------------------------------------------------------------
-- 13. Grants
-- anon gets nothing: there is no public read path into this schema. The lead-facing consumer chat
-- runs server-side under a tenant-scoped service-role handler.
-- ---------------------------------------------------------------------------

revoke all on schema public from anon;
grant usage on schema public to authenticated, service_role;
grant usage on schema app to authenticated, service_role;

grant execute on all functions in schema app to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;
