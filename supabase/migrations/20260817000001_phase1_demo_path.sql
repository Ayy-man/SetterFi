-- SetterFi Phase 1 consolidated schema contract.
--
-- This is deliberately one follow-on to the applied Phase 0 schema. The checks at the front abort
-- when a live row cannot be converted without product knowledge or a runtime secret; the named
-- remediation is safer than guessing at provider metadata, consent, cadence, or billing identity.
-- Every new public table is forced through RLS, receives an explicit narrow policy, and is denied
-- to anon at both object and default-privilege boundaries.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Fail-loud conversion preconditions and replacement vocabulary
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from public.channel_connections where channel::text in ('calendar_google', 'calendar_ghl')
    union all
    select 1 from public.contacts where channel::text in ('calendar_google', 'calendar_ghl')
    union all
    select 1 from public.conversations where channel::text in ('calendar_google', 'calendar_ghl')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_CALENDAR_CHANNEL_REMEDIATION_REQUIRED',
      detail = 'Move each calendar-valued channel_connections row into calendar_connections using provider-read calendar id, timezone, and health before retrying.';
  end if;

  if exists (select 1 from public.dnc_entries) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_SUPPRESSION_REMEDIATION_REQUIRED',
      detail = 'Export legacy DNC rows and reinsert them through the suppression helper with SETTERFI_SUPPRESSION_PEPPER before retrying.';
  end if;

  if exists (
    select 1 from public.followups
    where canceled_reason is not null
      and canceled_reason not in (
        'lead_reply', 'takeover', 'opted_out', 'hard_dq', 'no_consent', 'stale',
        'contact_deleted', 'escalated', 'scope_blocked', 'tenant_suspended',
        'conversation_closed', 'window_closed', 'superseded', 'soft_dq', 'booked'
      )
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_FOLLOWUP_REASON_REMEDIATION_REQUIRED',
      detail = 'Map every legacy canceled_reason to the reviewed follow-up cancellation vocabulary before retrying the enum cast.';
  end if;

  if exists (select 1 from public.appointments where provider::text <> 'ghl') then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_APPOINTMENT_PROVIDER_REMEDIATION_REQUIRED',
      detail = 'Map every non-GHL appointment to a verified calendar provider before retrying the enum cast.';
  end if;

  if exists (select 1 from public.appointments where external_id is null) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_APPOINTMENT_EXTERNAL_ID_REMEDIATION_REQUIRED',
      detail = 'Backfill each appointment from the provider authority; Phase 1 requires a replay key for every provider appointment.';
  end if;

  if exists (select 1 from public.model_configs) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_MODEL_CONFIG_REMEDIATION_REQUIRED',
      detail = 'Assign each existing model config to generator or moderator and leave at most one active row per role before retrying.';
  end if;

  if exists (select 1 from public.meter_events) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_BILLABLE_EVENT_REMEDIATION_REQUIRED',
      detail = 'Review legacy meter rows and convert booked-call sources to appointment-backed billable events before retrying.';
  end if;

  if exists (select 1 from public.commission_ledger) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_COMMISSION_LEDGER_REMEDIATION_REQUIRED',
      detail = 'Backfill stripe_invoice_id from the paid-invoice source and verify invoice idempotency before retrying.';
  end if;

  if exists (select 1 from public.audit_log) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_AUDIT_LOG_REMEDIATION_REQUIRED',
      detail = 'Map every legacy free-text action to the reviewed audit registry before adding referential integrity.';
  end if;

  if exists (select 1 from public.onboarding_runs) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_ONBOARDING_RUN_REMEDIATION_REQUIRED',
      detail = 'Materialize each scalar onboarding state into provisioning_steps before retrying the onboarding reshape.';
  end if;

  if exists (select 1 from public.conversations where status <> 'agent') then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_CONVERSATION_REASON_REMEDIATION_REQUIRED',
      detail = 'Assign a reviewed typed reason to every non-agent conversation before enforcing state/reason equality.';
  end if;
end
$$;

alter type public.convo_status add value if not exists 'scope_blocked';
alter type public.channel_state add value if not exists 'blocked_permanent';
alter type public.channel_state add value if not exists 'flagged';
alter type public.channel_state add value if not exists 'restricted';

create type public.messaging_channel as enum
  ('instagram', 'messenger', 'sms', 'whatsapp', 'webchat');
create type public.calendar_provider as enum ('ghl', 'google');
create type public.calendar_connection_state as enum
  ('disconnected', 'connecting', 'ready', 'error', 'expired');
create type public.appointment_source as enum ('agent', 'provider_webhook', 'system_reconcile');
create type public.convo_status_reason as enum (
  'lead_requested_human', 'no_match_threshold', 'output_check_failed',
  'tripwire_repeated', 'tripwire_escalate', 'tenant_suspended', 'scope_exit_cap',
  'booked', 'hard_dq', 'soft_dq', 'human_closed', 'stale', 'cadence_exhausted',
  'stop_keyword', 'manual_dnc'
);
create type public.pipeline_stage as enum (
  'new_lead', 'qualifying', 'booked', 'qualified_no_buy',
  'long_term_followup', 'no_show', 'disqualified'
);
create type public.followup_canceled_reason as enum (
  'lead_reply', 'takeover', 'opted_out', 'hard_dq', 'no_consent', 'stale',
  'contact_deleted', 'escalated', 'scope_blocked', 'tenant_suspended',
  'conversation_closed', 'window_closed', 'superseded', 'soft_dq', 'booked'
);
create type public.cadence_channel_class as enum ('durable', 'window_bound', 'none');
create type public.model_role as enum ('generator', 'moderator');
create type public.audit_actor_kind as enum ('human', 'system');
create type public.audit_scope as enum ('tenant', 'platform');
create type public.provisioning_step as enum (
  'account', 'billing', 'ghl_location', 'ghl_snapshot', 'phone_number',
  'sms_eligibility_screen', 'business_profile', 'optin_artifact', 'a2p_brand',
  'a2p_campaign', 'sms_live', 'meta_connect', 'whatsapp_connect',
  'calendar_connect', 'offer_layer', 'test_pass', 'go_live'
);
create type public.provisioning_state as enum (
  'pending', 'running', 'awaiting_coach', 'awaiting_platform',
  'awaiting_provider', 'done', 'failed', 'blocked'
);
create type public.awaiting_party as enum ('carrier', 'meta', 'google', 'ghl', 'stripe');
create type public.signup_intent_state as enum ('started', 'completed', 'failed');
create type public.alert_scope as enum ('tenant', 'platform');
create type public.notification_destination as enum ('bell', 'email', 'slack');
create type public.notification_delivery_status as enum
  ('pending', 'sending', 'delivered', 'failed', 'unavailable');

-- ---------------------------------------------------------------------------
-- 2. Messaging identity, replay keys, consent, and suppression
-- ---------------------------------------------------------------------------

alter table public.contacts rename column channel to last_channel;
alter table public.contacts
  alter column last_channel type public.messaging_channel
    using (last_channel::text::public.messaging_channel),
  add column timezone_source text
    check (timezone_source in ('provided', 'npa', 'default')),
  add column pipeline_stage public.pipeline_stage not null default 'new_lead',
  add column stage_set_by text not null default 'system'
    check (stage_set_by in ('system', 'user')),
  add column stage_set_at timestamptz not null default now(),
  drop column opt_in_source;

comment on column public.contacts.opted_out is
  'Denormalized any-identity suppression marker. contact_identities and suppression_entries remain authoritative.';

create index contacts_tenant_stage_idx on public.contacts (tenant_id, pipeline_stage);

alter table public.conversations
  alter column channel type public.messaging_channel using (channel::text::public.messaging_channel);

alter table public.channel_connections
  drop constraint channel_connections_tenant_id_channel_key,
  alter column channel type public.messaging_channel using (channel::text::public.messaging_channel);

alter table public.channel_connections
  add constraint channel_connections_tenant_channel_provider_key
    unique (tenant_id, channel, provider);
create unique index channel_connections_one_live_provider_idx
  on public.channel_connections (tenant_id, channel)
  where state = 'live';

create table public.contact_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  provider public.channel_provider not null,
  channel public.messaging_channel not null,
  provider_identity_id text not null,
  normalized_phone text,
  normalized_email text,
  consent_state text not null default 'none'
    check (consent_state in ('none', 'reply_only', 'conversation', 'opted_in', 'unverified', 'suppressed')),
  consent_source text
    check (consent_source in ('inbound_message', 'web_form', 'lead_confirmed_sms',
                              'verbal_recorded', 'imported_attested', 'platform_admin', 'opt_back_in')),
  consent_captured_at timestamptz,
  consent_expires_at timestamptz,
  consent_evidence jsonb,
  provider_window_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, channel, provider_identity_id)
);
create index contact_identities_contact_idx on public.contact_identities (contact_id);
create index contact_identities_phone_idx on public.contact_identities (tenant_id, normalized_phone)
  where normalized_phone is not null;

create or replace function app.enforce_child_tenant()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  parent_tenant uuid;
begin
  select tenant_id into parent_tenant from public.contacts where id = new.contact_id;
  if parent_tenant is null or parent_tenant <> new.tenant_id then
    raise exception 'CONTACT_IDENTITY_TENANT_MISMATCH';
  end if;
  return new;
end;
$$;

create trigger contact_identities_tenant_match
before insert or update of tenant_id, contact_id on public.contact_identities
for each row execute function app.enforce_child_tenant();

alter table public.messages drop constraint messages_provider_message_id_key;
create unique index messages_tenant_provider_message_key
  on public.messages (tenant_id, provider, provider_message_id)
  where provider_message_id is not null;

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.messaging_channel not null,
  provider public.channel_provider not null,
  provider_template_id text not null,
  name text not null,
  status text not null check (status in ('pending', 'approved', 'rejected', 'paused')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_template_id)
);

alter table public.dnc_entries rename to suppression_entries;
alter index public.dnc_entries_scope_phone_idx rename to suppression_entries_scope_identifier_legacy_idx;
alter index public.dnc_entries_phone_idx rename to suppression_entries_identifier_legacy_idx;
alter table public.suppression_entries rename column phone to identifier;
drop index public.suppression_entries_scope_identifier_legacy_idx;
drop index public.suppression_entries_identifier_legacy_idx;
alter table public.suppression_entries
  add column channel public.messaging_channel,
  add column identifier_hash text,
  add column identifier_last4 text,
  add column contact_id uuid references public.contacts(id) on delete set null,
  add column reason text,
  add column provider_sync_state text not null default 'pending'
    check (provider_sync_state in ('pending', 'confirmed', 'failed', 'not_applicable')),
  add column provider_synced_at timestamptz,
  add column provider_sync_error text,
  alter column identifier drop not null,
  alter column channel set not null,
  alter column identifier_hash set not null,
  add constraint suppression_manual_reason_chk
    check (source <> 'manual' or nullif(btrim(reason), '') is not null),
  add constraint suppression_source_chk
    check (source in ('stop_keyword', 'stop_intent', 'manual', 'import', 'deletion', 'complaint'));
create unique index suppression_entries_scope_identity_idx on public.suppression_entries
  ((coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)), channel, identifier_hash);
create index suppression_entries_identifier_hash_idx on public.suppression_entries (identifier_hash);

update public.tenant_settings
set quiet_hours_start = greatest(quiet_hours_start, time '08:00'),
    quiet_hours_end = least(quiet_hours_end, time '20:00')
where quiet_hours_start < time '08:00'
   or quiet_hours_end > time '20:00';

do $$
begin
  if exists (
    select 1 from public.tenant_settings
    where quiet_hours_start >= quiet_hours_end
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_QUIET_HOURS_REMEDIATION_REQUIRED',
      detail = 'Resolve inverted or empty send windows against the tenant owner before retrying; do not guess a window.';
  end if;
end
$$;

alter table public.tenant_settings
  alter column quiet_hours_end set default '20:00',
  add constraint tenant_settings_quiet_hours_floor_chk check (
    quiet_hours_start >= time '08:00'
    and quiet_hours_end <= time '20:00'
    and quiet_hours_start < quiet_hours_end
  );

alter table public.eval_cases
  add column provenance_severed boolean not null default false,
  add column quarantined boolean not null default false;

-- ---------------------------------------------------------------------------
-- 3. Conversation state and cadence storage
-- ---------------------------------------------------------------------------

alter table public.conversations
  add column status_reason public.convo_status_reason,
  add column status_changed_at timestamptz not null default now(),
  add column needs_human_at timestamptz,
  add column tripwire_count int not null default 0 check (tripwire_count >= 0),
  add column consecutive_no_match_count int not null default 0 check (consecutive_no_match_count >= 0),
  add column current_step_asks int not null default 0 check (current_step_asks between 0 and 3),
  add column disclosure_pending boolean not null default false,
  add column cadence_anchor_at timestamptz,
  add column cadence_anchor_message_id uuid references public.messages(id) on delete set null,
  add column consecutive_stale int not null default 0 check (consecutive_stale >= 0),
  add column origin_conversation_id uuid references public.conversations(id) on delete set null,
  add column proposed_slots jsonb,
  add column proposed_slots_at timestamptz,
  add column booking_link_sent_at timestamptz;

do $$
begin
  if exists (select 1 from public.conversations where status <> 'agent') then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_CONVERSATION_STATUS_REASON_REMEDIATION_REQUIRED',
      detail = 'Assign the documented status reason to every non-agent conversation before retrying.';
  end if;
end
$$;

alter table public.conversations
  add constraint conversations_status_reason_chk
    check ((status = 'agent') = (status_reason is null));

create index conversations_needs_human_idx on public.conversations (tenant_id, needs_human_at)
  where status = 'needs_human';

alter table public.followups
  alter column canceled_reason type public.followup_canceled_reason
    using (canceled_reason::public.followup_canceled_reason),
  add column original_scheduled_at timestamptz,
  add column deferred_count int not null default 0 check (deferred_count >= 0),
  add column resolved_identity_id uuid references public.contact_identities(id) on delete set null,
  add column channel_class public.cadence_channel_class,
  add column cadence_anchor_at timestamptz;

do $$
begin
  if exists (
    select 1 from public.followups
    where (status = 'canceled') <> (canceled_reason is not null)
       or touch_no not between 1 and 8
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_FOLLOWUP_SHAPE_REMEDIATION_REQUIRED',
      detail = 'Reconcile follow-up status/reason pairing and cap touch_no at 8 before retrying.';
  end if;
end
$$;

alter table public.followups
  add constraint followups_status_reason_chk
    check ((status = 'canceled') = (canceled_reason is not null)),
  add constraint followups_touch_cap_chk check (touch_no between 1 and 8);

with latest_inbound as (
  select distinct on (m.conversation_id)
    m.conversation_id,
    m.created_at as anchor_at,
    m.id as message_id
  from public.messages m
  where m.direction = 'in'
  order by m.conversation_id, m.created_at desc, m.id desc
)
update public.conversations c
set cadence_anchor_at = source.anchor_at,
    cadence_anchor_message_id = source.message_id
from latest_inbound source
where source.conversation_id = c.id
  and exists (select 1 from public.followups f where f.conversation_id = c.id);

update public.followups f
set cadence_anchor_at = c.cadence_anchor_at,
    channel_class = case
      when c.channel in ('sms', 'whatsapp') then 'durable'::public.cadence_channel_class
      when c.channel in ('instagram', 'messenger') then 'window_bound'::public.cadence_channel_class
      else 'none'::public.cadence_channel_class
    end
from public.conversations c
where c.id = f.conversation_id;

do $$
begin
  if exists (select 1 from public.followups where cadence_anchor_at is null) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_CADENCE_ANCHOR_REMEDIATION_REQUIRED',
      detail = 'Backfill each follow-up from its latest lead-authored inbound message; do not substitute conversation creation time.';
  end if;
end
$$;

do $$
begin
  if exists (
    select 1 from public.followups
    where scheduled_at > cadence_anchor_at + interval '60 days'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_FOLLOWUP_CONSENT_WINDOW_REMEDIATION_REQUIRED',
      detail = 'Cancel or re-anchor follow-ups scheduled beyond the documented 60-day scheduling cap before retrying.';
  end if;
end
$$;

alter table public.followups
  alter column cadence_anchor_at set not null,
  alter column channel_class set not null,
  add constraint followups_consent_window_chk
    check (scheduled_at <= cadence_anchor_at + interval '60 days');

create table public.offer_cadence_purposes (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel_class public.cadence_channel_class not null,
  touch_no int not null check (touch_no between 1 and 8),
  purpose public.followup_purpose not null,
  asset_id text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, channel_class, touch_no)
);

-- The replacement type is now independent of every live column.
drop type public.channel;

-- ---------------------------------------------------------------------------
-- 4. Calendar authority, appointments, billing, and trace custody
-- ---------------------------------------------------------------------------

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider public.calendar_provider not null,
  external_calendar_id text not null,
  external_location_id text,
  calendar_name text,
  booking_url text check (booking_url is null or booking_url ~ '^https://'),
  timezone text not null,
  slot_duration_minutes int not null default 30 check (slot_duration_minutes between 5 and 480),
  min_notice_minutes int not null default 120 check (min_notice_minutes between 0 and 43200),
  assigned_user_id text,
  state public.calendar_connection_state not null default 'disconnected',
  last_slot_fetch_at timestamptz,
  last_slot_fetch_ok boolean,
  last_error text,
  access_token text,
  token_expires_at timestamptz,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_calendar_id),
  constraint calendar_health_shape_chk check (
    (last_slot_fetch_at is null and last_slot_fetch_ok is null and last_error is null)
    or (last_slot_fetch_at is not null and last_slot_fetch_ok is not null
        and ((last_slot_fetch_ok and last_error is null) or (not last_slot_fetch_ok and last_error is not null)))
  )
);
create index calendar_connections_tenant_idx on public.calendar_connections (tenant_id);
create unique index calendar_connections_primary_idx on public.calendar_connections (tenant_id)
  where is_primary;

alter table public.appointments
  alter column provider drop default,
  alter column provider type public.calendar_provider using (provider::text::public.calendar_provider),
  alter column provider set default 'ghl',
  alter column external_id set not null,
  add column calendar_connection_id uuid references public.calendar_connections(id) on delete set null,
  add column created_source public.appointment_source not null default 'agent',
  add column attributed_to_agent boolean not null default false,
  add column cancel_source text check (cancel_source in ('lead', 'coach', 'provider_missing', 'system')),
  add column attendance_source text check (attendance_source in ('coach', 'provider', 'system')),
  add column attendance_set_at timestamptz,
  add column attendance_set_by uuid references public.users(id),
  add constraint appointments_attendance_shape_chk check (
    (attendance_source is null and attendance_set_at is null and attendance_set_by is null)
    or (attendance_source is not null and attendance_set_at is not null)
  );
create index appointments_recent_contact_idx on public.appointments (contact_id, start_at desc)
  where status <> 'canceled';

create table public.appointment_reschedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  from_start_at timestamptz not null,
  from_end_at timestamptz not null,
  to_start_at timestamptz not null,
  to_end_at timestamptz not null,
  initiated_by text not null check (initiated_by in ('lead', 'coach', 'agent', 'provider')),
  actor_id uuid references public.users(id),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  constraint appointment_reschedules_time_chk check (
    from_end_at > from_start_at and to_end_at > to_start_at
  )
);
create index appointment_reschedules_appointment_idx
  on public.appointment_reschedules (appointment_id, created_at desc);

alter table public.meter_events rename to billable_events;
alter index public.meter_events_tenant_idx rename to billable_events_tenant_idx;
drop index public.meter_events_source_idx;
drop index public.meter_events_unreported_idx;
alter table public.billable_events
  drop column kind,
  drop column source_id,
  drop column stripe_reported,
  drop column stripe_reported_at;
alter table public.billable_events rename column created_at to occurred_at;
alter table public.billable_events
  add column appointment_id uuid references public.appointments(id) on delete set null,
  add column adjusts_event_id uuid references public.billable_events(id) on delete restrict,
  add constraint billable_events_shape_chk check (
    (adjusts_event_id is null and appointment_id is not null and quantity > 0
      and adjusted_by is null and adjust_reason is null)
    or
    (adjusts_event_id is not null and appointment_id is null and quantity <> 0
      and adjusted_by is not null and nullif(btrim(adjust_reason), '') is not null)
  );
create unique index billable_events_primary_appointment_idx
  on public.billable_events (appointment_id) where adjusts_event_id is null;
comment on table public.billable_events is
  'Append-only booked-call ledger. Primary appointment events never reverse automatically; corrections are separate offset rows.';

create table public.message_traces (
  message_id uuid primary key references public.messages(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  brain_version int,
  offer_version int,
  prompt_hash text,
  rule_fired text,
  retrieved_entry_ids uuid[] not null default '{}',
  number_sources jsonb not null default '[]'::jsonb,
  checks jsonb not null default '[]'::jsonb,
  violations jsonb not null default '[]'::jsonb,
  rejected_drafts jsonb not null default '[]'::jsonb,
  model text,
  params jsonb,
  latency_ms int check (latency_ms is null or latency_ms >= 0),
  usage jsonb,
  cost numeric,
  moderator_state text check (moderator_state in ('allowed', 'blocked', 'unavailable')),
  trace jsonb,
  created_at timestamptz not null default now()
);
insert into public.message_traces (message_id, tenant_id, trace, created_at)
select id, tenant_id, trace, created_at from public.messages where trace is not null;
alter table public.messages drop column trace;

alter table public.model_configs
  add column role public.model_role,
  add column moderator_unavailable_count bigint not null default 0
    check (moderator_unavailable_count >= 0),
  alter column role set not null;
create unique index model_configs_active_role_idx on public.model_configs (role) where active;

-- Candidate model IDs are contract placeholders and remain UNVERIFIED until the
-- credentialed OpenRouter real arm runs successfully.
insert into public.model_configs
  (id, label, openrouter_model, params, is_default, active, role)
values
  ('10000000-0000-4000-8000-000000000001', 'Generator', 'anthropic/claude-opus-4.1', '{}'::jsonb, true, true, 'generator'),
  ('10000000-0000-4000-8000-000000000002', 'Moderator', 'openai/gpt-5', '{}'::jsonb, false, true, 'moderator');

do $$
begin
  if exists (
    select 1 from public.tiers
    where price_cents < 0
       or call_allowance < 0
       or (fair_use_cap is not null and fair_use_cap < call_allowance)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_TIER_LIMIT_REMEDIATION_REQUIRED',
      detail = 'Resolve negative pricing or allowances and any fair-use cap below the included allowance before retrying.';
  end if;
end
$$;

alter table public.tiers
  add column fair_use_note text,
  add constraint tiers_price_chk check (price_cents >= 0),
  add constraint tiers_allowance_chk check (call_allowance >= 0),
  add constraint tiers_fair_use_cap_chk check (fair_use_cap is null or fair_use_cap >= call_allowance);

alter table public.commission_ledger
  drop constraint commission_ledger_referral_id_month_key,
  add column stripe_invoice_id text,
  add column invoice_paid_at timestamptz,
  alter column stripe_invoice_id set not null,
  alter column invoice_paid_at set not null,
  add constraint commission_ledger_referral_invoice_key unique (referral_id, stripe_invoice_id);
alter table public.commission_ledger drop column month;
alter table public.commission_ledger
  add column month date generated always as
    ((date_trunc('month', invoice_paid_at at time zone 'UTC'))::date) stored;

-- ---------------------------------------------------------------------------
-- 5. Audit registry, impersonation, support, and role helpers
-- ---------------------------------------------------------------------------

create table public.audit_actions (
  key text primary key,
  actor_kind public.audit_actor_kind not null,
  scope public.audit_scope not null,
  reason_required boolean not null default false,
  coach_visible boolean not null default false,
  microcopy text not null check (nullif(btrim(microcopy), '') is not null),
  aria_label text not null check (nullif(btrim(aria_label), '') is not null),
  created_at timestamptz not null default now()
);

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('appointment.attendance_set', 'human', 'tenant', false, true, 'Attendance logged', 'Attendance action recorded in the audit log'),
  ('appointment.canceled', 'system', 'tenant', false, true, 'Cancellation logged', 'Cancellation recorded in the audit log'),
  ('appointment.created', 'system', 'tenant', false, true, 'Booking logged', 'Booking recorded in the audit log'),
  ('appointment.rescheduled', 'system', 'tenant', false, true, 'Reschedule logged', 'Reschedule recorded in the audit log'),
  ('calendar.connected', 'human', 'tenant', false, true, 'Connection logged', 'Calendar connection recorded in the audit log'),
  ('calendar.disconnected', 'human', 'tenant', false, true, 'Disconnection logged', 'Calendar disconnection recorded in the audit log'),
  ('channel.went_live', 'system', 'tenant', false, true, 'Channel activation logged', 'Channel activation recorded in the audit log'),
  ('consent.opt_in', 'human', 'tenant', false, true, 'Consent logged', 'Consent action recorded in the audit log'),
  ('consent.opt_out', 'human', 'tenant', false, true, 'Opt-out logged', 'Opt-out action recorded in the audit log'),
  ('contact.delete', 'human', 'tenant', true, true, 'Deletion logged', 'Contact deletion recorded in the audit log'),
  ('conversation.channel_continued', 'system', 'tenant', false, false, 'Continuation logged', 'Channel continuation recorded in the audit log'),
  ('conversation.closed', 'human', 'tenant', true, true, 'Closure logged', 'Conversation closure recorded in the audit log'),
  ('conversation.closed.stale', 'system', 'tenant', false, false, 'Stale closure logged', 'Stale conversation closure recorded in the audit log'),
  ('conversation.escalated', 'system', 'tenant', false, true, 'Escalation logged', 'Conversation escalation recorded in the audit log'),
  ('conversation.guardrail.cleared', 'human', 'tenant', true, true, 'Guardrail clear logged', 'Guardrail clear recorded in the audit log'),
  ('conversation.scope_blocked', 'system', 'tenant', false, false, 'Scope block logged', 'Scope block recorded in the audit log'),
  ('conversation.takeover.claimed', 'human', 'tenant', false, true, 'Takeover logged', 'Takeover recorded in the audit log'),
  ('conversation.takeover.released', 'human', 'tenant', false, true, 'Hand-back logged', 'Hand-back recorded in the audit log'),
  ('export.finished', 'human', 'tenant', false, false, 'Export completion logged', 'Export completion recorded in the audit log'),
  ('export.started', 'human', 'tenant', false, false, 'Export start logged', 'Export start recorded in the audit log'),
  ('impersonation.ended', 'human', 'tenant', false, false, 'View-as session end logged', 'View-as session end recorded in the audit log'),
  ('impersonation.started', 'human', 'tenant', true, false, 'View-as session logged', 'View-as session recorded in the audit log'),
  ('onboarding.a2p_blocked_permanent', 'system', 'tenant', false, true, 'Permanent registration block logged', 'Permanent registration block recorded in the audit log'),
  ('onboarding.a2p_filing_confirmed', 'human', 'tenant', false, true, 'Registration filing logged', 'Registration filing recorded in the audit log'),
  ('onboarding.step_failed', 'system', 'tenant', false, false, 'Provisioning failure logged', 'Provisioning failure recorded in the audit log'),
  ('onboarding.step_retried', 'human', 'tenant', false, true, 'Retry logged', 'Provisioning retry recorded in the audit log'),
  ('onboarding.step_unblocked', 'human', 'tenant', true, true, 'Unblock logged', 'Provisioning unblock recorded in the audit log'),
  ('quiet_hours.window.change', 'human', 'tenant', false, true, 'Quiet-hours change logged', 'Quiet-hours change recorded in the audit log'),
  ('referral.code_rejected', 'system', 'platform', false, false, 'Referral refusal logged', 'Referral refusal recorded in the audit log'),
  ('send.refused.no_consent', 'system', 'tenant', false, false, 'Consent refusal logged', 'Consent refusal recorded in the audit log'),
  ('send.refused.suppressed', 'system', 'tenant', false, false, 'Suppression refusal logged', 'Suppression refusal recorded in the audit log'),
  ('suppression.correct', 'human', 'tenant', true, true, 'Suppression correction logged', 'Suppression correction recorded in the audit log'),
  ('suppression.insert.manual', 'human', 'tenant', false, true, 'Suppression logged', 'Suppression action recorded in the audit log'),
  ('suppression.push.failed', 'system', 'tenant', false, false, 'Provider suppression failure logged', 'Provider suppression failure recorded in the audit log'),
  ('suppression.push.provider', 'system', 'tenant', false, false, 'Provider suppression logged', 'Provider suppression recorded in the audit log'),
  ('tenant.billing_contact_changed', 'human', 'tenant', false, true, 'Billing contact change logged', 'Billing contact change recorded in the audit log'),
  ('tenant.demo_flag.changed', 'human', 'platform', true, false, 'Demo flag change logged', 'Demo flag change recorded in the audit log'),
  ('tenant.went_live', 'human', 'tenant', false, true, 'Go-live logged', 'Go-live recorded in the audit log');

create table public.impersonation_sessions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.users(id),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  reason text not null check (nullif(btrim(reason), '') is not null),
  started_at timestamptz not null,
  ended_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint impersonation_duration_chk check (
    expires_at > started_at and expires_at <= started_at + interval '30 minutes'
  ),
  constraint impersonation_end_chk check (ended_at is null or ended_at >= started_at)
);
create index impersonation_sessions_actor_active_idx
  on public.impersonation_sessions (actor_id, expires_at desc)
  where ended_at is null;

alter table public.audit_log rename column target to target_type;
alter table public.audit_log
  add column subject_user_id uuid references public.users(id),
  add column target_id text,
  add column impersonation_id uuid references public.impersonation_sessions(id),
  add constraint audit_log_action_fkey foreign key (action) references public.audit_actions(key);
create index audit_log_subject_idx on public.audit_log (subject_user_id, created_at desc);
create index audit_log_target_idx on public.audit_log (target_type, target_id, created_at desc);
create index audit_log_impersonation_idx on public.audit_log (impersonation_id, created_at desc);

create table public.support_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  subject text not null,
  status text not null default 'open' check (status in ('open', 'waiting_on_coach', 'resolved')),
  assigned_to uuid references public.users(id),
  created_by uuid not null references public.users(id),
  is_test boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index support_threads_tenant_idx on public.support_threads (tenant_id, updated_at desc);

create table public.support_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  thread_id uuid not null references public.support_threads(id) on delete cascade,
  author_id uuid not null references public.users(id),
  body text not null,
  internal boolean not null default false,
  is_test boolean not null default false,
  created_at timestamptz not null default now()
);
create index support_messages_thread_idx on public.support_messages (thread_id, created_at);

create view public.coach_support_messages
with (security_invoker = true)
as
select id, tenant_id, thread_id, author_id, body, is_test, created_at
from public.support_messages
where not internal;

create or replace function app.is_platform_operator()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(app.current_user_role() in ('owner', 'admin', 'success'), false);
$$;

create or replace function app.not_impersonating()
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.claim('impersonating_tenant') is null;
$$;

create or replace function app.can_platform_write_tenant(row_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select app.not_impersonating() and (
    app.current_user_role() in ('owner', 'admin')
    or (
      app.current_user_role() = 'success'
      and exists (
        select 1 from public.tenants t
        where t.id = row_tenant_id and t.success_owner = app.current_user_id()
      )
    )
  );
$$;

-- ---------------------------------------------------------------------------
-- 6. Onboarding, demo segregation, alerts, and shared operational storage
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column is_demo boolean not null default false,
  add column billing_contact_email text,
  add column billing_contact_name text;

with first_coach as (
  select distinct on (u.tenant_id)
    u.tenant_id,
    u.email,
    u.full_name
  from public.users u
  where u.role = 'coach'
  order by u.tenant_id, u.created_at, u.id
)
update public.tenants t
set billing_contact_email = coach.email,
    billing_contact_name = coach.full_name
from first_coach coach
where coach.tenant_id = t.id;

do $$
begin
  if exists (select 1 from public.tenants where billing_contact_email is null) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_BILLING_EMAIL_REMEDIATION_REQUIRED',
      detail = 'Create or identify the deterministic coach user for every tenant, then retry; do not invent a billing address.';
  end if;
end
$$;

alter table public.tenants alter column billing_contact_email set not null;

create view public.production_tenant_aggregate_source
with (security_invoker = true)
as
select id, slug, name, status, tier_id, created_at
from public.tenants
where not is_demo;

create table public.provisioning_steps (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  step_key public.provisioning_step not null,
  state public.provisioning_state not null default 'pending',
  awaiting_party public.awaiting_party,
  attempts int not null default 0 check (attempts >= 0),
  started_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  blocked_reason text,
  external_ref jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, step_key),
  constraint provisioning_blocked_reason_chk check (
    (state = 'blocked') = (nullif(btrim(blocked_reason), '') is not null)
  ),
  constraint provisioning_awaiting_party_chk check (
    (state = 'awaiting_provider') = (awaiting_party is not null)
  )
);
create index provisioning_steps_state_idx on public.provisioning_steps (state, last_attempt_at);

create table public.signup_intents (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique not null,
  email text not null,
  tenant_id uuid references public.tenants(id),
  tier_id uuid references public.tiers(id),
  timezone text,
  referral_code text,
  state public.signup_intent_state not null default 'started',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.onboarding_runs
  drop column step,
  drop column a2p_state,
  drop column error,
  add column started_at timestamptz not null default now(),
  add column readiness_met_at timestamptz,
  add column went_live_at timestamptz,
  add column stalled_flagged_at timestamptz,
  add constraint onboarding_runs_tenant_key unique (tenant_id);
drop type public.onboarding_step;
drop type public.a2p_state;

create table public.alert_rules (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  scope public.alert_scope not null,
  name text not null,
  description text not null,
  category text not null,
  audience_roles public.user_role[] not null default '{}',
  include_success_owner boolean not null default false,
  include_billing_contact boolean not null default false,
  default_destinations public.notification_destination[] not null default '{bell}',
  suppressible boolean not null default true,
  default_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_key, scope)
);

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled)
values
  ('appointment.booked', 'tenant', 'Appointment booked', 'A lead booked an appointment.', 'booking', '{coach}', false, false, '{bell,email}', true, true),
  ('appointment.canceled', 'tenant', 'Appointment canceled', 'An appointment was canceled.', 'booking', '{coach}', false, false, '{bell,email}', true, true),
  ('appointment.rescheduled', 'tenant', 'Appointment rescheduled', 'An appointment moved to a new slot.', 'booking', '{coach}', false, false, '{bell}', true, true),
  ('brain.no_published_snapshot', 'platform', 'No published Brain snapshot', 'The platform has no published Brain snapshot.', 'brain', '{owner,admin}', false, false, '{bell}', false, true),
  ('calendar.connection_unhealthy', 'tenant', 'Calendar needs attention', 'The primary calendar failed its latest slot fetch.', 'booking', '{coach}', false, false, '{bell,email}', true, true),
  ('conversation.channel_continuation_unavailable', 'tenant', 'Channel continuation unavailable', 'No eligible identity can continue the conversation.', 'conversation', '{coach}', false, false, '{bell}', true, false),
  ('conversation.needs_human', 'tenant', 'Conversation needs a person', 'A conversation entered the needs-human state.', 'conversation', '{coach}', false, false, '{bell}', true, true),
  ('conversation.needs_human.unclaimed_24h', 'tenant', 'Conversation unclaimed for 24 hours', 'A needs-human conversation remains unclaimed after 24 hours.', 'conversation', '{coach}', true, false, '{bell,email}', true, true),
  ('conversation.needs_human.unclaimed_4h', 'tenant', 'Conversation unclaimed for 4 hours', 'A needs-human conversation remains unclaimed after 4 hours.', 'conversation', '{coach}', false, false, '{bell}', true, true),
  ('conversation.tripwire_escalated', 'platform', 'Tripwire escalation', 'A tripwire escalated a conversation.', 'safety', '{owner,admin}', false, false, '{bell}', false, true),
  ('conversation.tripwire_escalated', 'tenant', 'Conversation escalated', 'A tripwire escalated a conversation.', 'safety', '{coach}', false, false, '{bell}', true, true),
  ('onboarding.a2p_blocked_permanent', 'platform', 'SMS registration permanently blocked', 'A carrier returned a terminal registration rejection.', 'onboarding', '{owner,admin}', false, false, '{bell,email}', false, true),
  ('onboarding.a2p_blocked_permanent', 'tenant', 'SMS registration permanently unavailable', 'The carrier returned a terminal registration rejection.', 'onboarding', '{coach}', true, false, '{bell,email}', false, true),
  ('onboarding.paying_not_live', 'tenant', 'Paying account is not live', 'A paying account remains not live after fourteen days.', 'onboarding', '{}', true, false, '{bell}', false, true),
  ('onboarding.stalled_coach', 'tenant', 'Setup waiting on coach', 'A setup step is waiting on the coach.', 'onboarding', '{coach}', false, false, '{bell}', true, true),
  ('onboarding.stalled_external', 'platform', 'Setup waiting on provider', 'A setup step is stalled on an external provider.', 'onboarding', '{owner,admin}', false, false, '{bell}', false, true),
  ('onboarding.stalled_external', 'tenant', 'Setup waiting on provider', 'A setup step is stalled on an external provider.', 'onboarding', '{coach}', true, false, '{bell}', true, true),
  ('onboarding.stalled_system', 'platform', 'Setup needs platform action', 'A setup step is stalled on the platform.', 'onboarding', '{owner,admin}', false, false, '{bell}', false, true);

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rule_id uuid not null references public.alert_rules(id) on delete cascade,
  destination public.notification_destination not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, rule_id, destination)
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  destination public.notification_destination not null,
  status public.notification_delivery_status not null default 'pending',
  attempts int not null default 0 check (attempts >= 0),
  provider_reference text,
  error text,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (notification_id, destination),
  constraint notification_delivery_receipt_chk check (
    (status = 'delivered' and delivered_at is not null and provider_reference is not null)
    or (status <> 'delivered' and delivered_at is null)
  )
);

create table public.platform_settings (
  singleton boolean primary key default true check (singleton),
  alert_webhook_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.platform_settings (singleton) values (true);

create table public.request_rate_limits (
  key text primary key,
  window_started_at timestamptz not null,
  hits int not null check (hits >= 0),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 7. Database-owned inheritance and immutable audit enforcement
-- ---------------------------------------------------------------------------

alter table public.messages add column state_entry_key text;
create unique index messages_state_entry_key_idx
  on public.messages (conversation_id, state_entry_key) where state_entry_key is not null;

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

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contacts', 'conversations', 'messages', 'followups', 'appointments', 'billable_events',
    'brain_knowledge_usage_events', 'unmatched_objections', 'appointment_reschedules',
    'support_threads', 'support_messages'
  ] loop
    execute format(
      'create trigger inherit_is_test before insert or update on public.%I
       for each row execute function app.inherit_is_test()',
      table_name
    );
  end loop;
end
$$;

create or replace function app.enforce_audit_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  registry public.audit_actions%rowtype;
  session_row public.impersonation_sessions%rowtype;
begin
  select * into registry from public.audit_actions where key = new.action;
  if not found then
    raise exception 'AUDIT_ACTION_NOT_REGISTERED:%', new.action;
  end if;

  if registry.actor_kind = 'human' and new.actor_id is null then
    raise exception 'AUDIT_HUMAN_ACTOR_REQUIRED:%', new.action;
  end if;
  if registry.actor_kind = 'system' and new.actor_id is not null then
    raise exception 'AUDIT_SYSTEM_ACTOR_FORBIDDEN:%', new.action;
  end if;
  if registry.reason_required and nullif(btrim(new.reason), '') is null then
    raise exception 'AUDIT_REASON_REQUIRED:%', new.action;
  end if;
  if new.impersonation_id is not null then
    select * into session_row from public.impersonation_sessions where id = new.impersonation_id;
    if not found or session_row.actor_id is distinct from new.actor_id
      or session_row.tenant_id is distinct from new.tenant_id then
      raise exception 'AUDIT_IMPERSONATION_CONTEXT_MISMATCH';
    end if;
  end if;
  return new;
end;
$$;

create trigger audit_log_validate_insert
before insert on public.audit_log
for each row execute function app.enforce_audit_insert();

create or replace function app.reject_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'AUDIT_LOG_APPEND_ONLY';
end;
$$;

create trigger audit_log_reject_mutation
before update or delete on public.audit_log
for each row execute function app.reject_audit_mutation();

create or replace function app.reject_billable_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'BILLABLE_EVENTS_APPEND_ONLY';
end;
$$;

create trigger billable_events_reject_mutation
before update or delete on public.billable_events
for each row execute function app.reject_billable_event_mutation();

create or replace function app.write_audit_row(
  p_action text,
  p_actor_id uuid,
  p_tenant_id uuid,
  p_target_type text,
  p_target_id text,
  p_reason text default null,
  p_payload jsonb default null,
  p_subject_user_id uuid default null,
  p_impersonation_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id bigint;
begin
  insert into public.audit_log (
    actor_id, subject_user_id, tenant_id, action, target_type, target_id,
    reason, payload, impersonation_id
  ) values (
    p_actor_id, p_subject_user_id, p_tenant_id, p_action, p_target_type, p_target_id,
    p_reason, p_payload, p_impersonation_id
  ) returning id into audit_id;
  return audit_id;
end;
$$;

create or replace function app.assert_expected_tenant(
  p_expected_tenant uuid,
  p_actual_tenant uuid,
  p_target text
)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_expected_tenant is null or p_actual_tenant is null
    or p_expected_tenant <> p_actual_tenant then
    raise exception 'EXPECTED_TENANT_MISMATCH:%', p_target;
  end if;
end;
$$;

create or replace function app.assert_not_impersonating()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if app.claim('impersonating_tenant') is not null then
    raise exception 'IMPERSONATION_WRITE_FORBIDDEN';
  end if;
end;
$$;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  app_user record;
  active_session record;
  claims jsonb;
  metadata jsonb;
begin
  select role, tenant_id into app_user
  from public.users
  where id = (event ->> 'user_id')::uuid;

  if app_user.role is null then
    return event;
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb)
    - 'impersonating_tenant' - 'impersonation_session_id';
  metadata := metadata || jsonb_strip_nulls(jsonb_build_object(
    'role', app_user.role,
    'tenant_id', app_user.tenant_id
  ));

  if app_user.role in ('owner', 'admin', 'success') then
    select id, tenant_id into active_session
    from public.impersonation_sessions
    where actor_id = (event ->> 'user_id')::uuid
      and ended_at is null
      and expires_at > now()
    order by started_at desc, id desc
    limit 1;

    if active_session.id is not null then
      metadata := metadata || jsonb_build_object(
        'impersonating_tenant', active_session.tenant_id,
        'impersonation_session_id', active_session.id
      );
    end if;
  end if;

  claims := jsonb_set(claims, '{app_metadata}', metadata);
  return jsonb_set(event, '{claims}', claims);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Tenant-asserting transactional RPCs: identity, turns, and handoff
-- ---------------------------------------------------------------------------

create or replace function public.persist_inbound_message(
  p_expected_tenant uuid,
  p_provider public.channel_provider,
  p_channel public.messaging_channel,
  p_provider_identity_id text,
  p_provider_message_id text,
  p_body text,
  p_contact_name text default null
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_inserted boolean,
  disclosure_pending boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity_row public.contact_identities%rowtype;
  contact_row public.contacts%rowtype;
  conversation_row public.conversations%rowtype;
  inbound_id uuid;
  inserted_now boolean := false;
  new_thread boolean := false;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null or nullif(btrim(p_provider_identity_id), '') is null
    or nullif(btrim(p_provider_message_id), '') is null or nullif(btrim(p_body), '') is null then
    raise exception 'INBOUND_REQUIRED_FIELD_MISSING';
  end if;
  if not exists (select 1 from public.tenants where id = p_expected_tenant) then
    raise exception 'EXPECTED_TENANT_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_expected_tenant::text || ':' || p_provider::text || ':' ||
      p_channel::text || ':' || p_provider_identity_id, 0)
  );

  select ci.* into identity_row
  from public.contact_identities ci
  where ci.tenant_id = p_expected_tenant
    and ci.provider = p_provider
    and ci.channel = p_channel
    and ci.provider_identity_id = p_provider_identity_id;

  if identity_row.id is null then
    insert into public.contacts (tenant_id, last_channel, name, last_seen_at)
    values (p_expected_tenant, p_channel, p_contact_name, now())
    returning * into contact_row;

    insert into public.contact_identities (
      tenant_id, contact_id, provider, channel, provider_identity_id,
      consent_state, consent_source, consent_captured_at, consent_expires_at
    ) values (
      p_expected_tenant, contact_row.id, p_provider, p_channel, p_provider_identity_id,
      'conversation', 'inbound_message', now(), now() + interval '90 days'
    ) returning * into identity_row;
  else
    select c.* into contact_row from public.contacts c where c.id = identity_row.contact_id;
    perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
    update public.contacts
    set last_channel = p_channel, last_seen_at = now()
    where id = contact_row.id;
  end if;

  select c.* into conversation_row
  from public.conversations c
  where c.tenant_id = p_expected_tenant
    and c.contact_id = contact_row.id
    and c.channel = p_channel
    and c.status <> 'opted_out'
  order by c.created_at desc, c.id desc
  limit 1
  for update;

  if conversation_row.id is null then
    insert into public.conversations (
      tenant_id, contact_id, channel, disclosure_pending, last_message_at
    ) values (
      p_expected_tenant, contact_row.id, p_channel, true, now()
    ) returning * into conversation_row;
    new_thread := true;
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider, provider_message_id
  ) values (
    p_expected_tenant, conversation_row.id, 'in', 'lead', p_body,
    p_provider::text, p_provider_message_id
  )
  on conflict (tenant_id, provider, provider_message_id)
    where provider_message_id is not null
  do nothing
  returning id into inbound_id;

  if inbound_id is null then
    select m.id into inbound_id from public.messages m
    where m.tenant_id = p_expected_tenant
      and m.provider = p_provider::text
      and m.provider_message_id = p_provider_message_id;
  else
    inserted_now := true;
    update public.conversations
    set last_message_at = now(),
        cadence_anchor_at = now(),
        cadence_anchor_message_id = inbound_id,
        status = case when status in ('nurture', 'closed') then 'agent' else status end,
        status_reason = case when status in ('nurture', 'closed') then null else status_reason end,
        status_changed_at = case when status in ('nurture', 'closed') then now() else status_changed_at end
    where id = conversation_row.id
    returning * into conversation_row;
  end if;

  return query select contact_row.id, conversation_row.id, inbound_id, inserted_now,
    case when new_thread then true else conversation_row.disclosure_pending end;
end;
$$;

create or replace function public.record_agent_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_body text,
  p_provider text,
  p_provider_message_id text,
  p_disclosure_consumed boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  outbound_id uuid;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then
    raise exception 'CONVERSATION_NOT_FOUND';
  end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> 'agent' then
    raise exception 'CONVERSATION_HELD:%', conversation_row.status;
  end if;
  if conversation_row.disclosure_pending and not p_disclosure_consumed then
    raise exception 'DISCLOSURE_REQUIRED';
  end if;
  if not conversation_row.disclosure_pending and p_disclosure_consumed then
    raise exception 'DISCLOSURE_ALREADY_CONSUMED';
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider, provider_message_id
  ) values (
    p_expected_tenant, p_conversation_id, 'out', 'agent', p_body, p_provider, p_provider_message_id
  ) returning id into outbound_id;

  update public.conversations
  set disclosure_pending = case when p_disclosure_consumed then false else disclosure_pending end,
      last_message_at = now()
  where id = p_conversation_id;

  return outbound_id;
end;
$$;

create or replace function public.enter_needs_human(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_reason public.convo_status_reason,
  p_holding_body text,
  p_entry_key text,
  p_payload jsonb default '{}'::jsonb
)
returns table (message_id uuid, audit_id bigint, transitioned boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  holding_id uuid;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_reason not in ('lead_requested_human', 'no_match_threshold', 'output_check_failed',
                      'tripwire_repeated', 'tripwire_escalate') then
    raise exception 'NEEDS_HUMAN_REASON_INVALID:%', p_reason;
  end if;
  if nullif(btrim(p_entry_key), '') is null or nullif(btrim(p_holding_body), '') is null then
    raise exception 'NEEDS_HUMAN_ENTRY_REQUIRED';
  end if;

  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');

  select id into holding_id from public.messages
  where conversation_id = p_conversation_id and state_entry_key = p_entry_key;
  if holding_id is not null then
    return query select holding_id, null::bigint, false;
    return;
  end if;
  if conversation_row.status <> 'agent' then
    raise exception 'CONVERSATION_NOT_AGENT:%', conversation_row.status;
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, state_entry_key
  ) values (
    p_expected_tenant, p_conversation_id, 'out', 'agent', p_holding_body, p_entry_key
  ) returning id into holding_id;

  update public.conversations
  set status = 'needs_human', status_reason = p_reason, status_changed_at = now(),
      needs_human_at = now(), unread_by_coach = true, last_message_at = now()
  where id = p_conversation_id;

  update public.followups
  set status = 'canceled', canceled_reason = 'escalated'
  where conversation_id = p_conversation_id and status = 'scheduled';

  logged_id := app.write_audit_row(
    'conversation.escalated', null, p_expected_tenant, 'conversation',
    p_conversation_id::text, null, p_payload || jsonb_build_object('status_reason', p_reason)
  );

  if not conversation_row.is_test then
    insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link)
    select p_expected_tenant, u.id, 'conversation.needs_human', 'warning',
      'Conversation needs a person', 'A conversation is waiting for a person.',
      '/coach/conversations/' || p_conversation_id::text
    from public.users u
    where u.tenant_id = p_expected_tenant and u.role = 'coach'
    order by u.created_at, u.id
    limit 1;
  end if;

  return query select holding_id, logged_id, true;
end;
$$;

create or replace function public.claim_conversation(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_expected_status public.convo_status,
  p_expected_holder_id uuid,
  p_confirm_displace boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> p_expected_status
    or conversation_row.taken_over_by is distinct from p_expected_holder_id then
    raise exception 'CONVERSATION_CLAIM_STALE';
  end if;
  if conversation_row.taken_over_by is not null
    and conversation_row.taken_over_by <> p_actor_id and not p_confirm_displace then
    raise exception 'CONVERSATION_DISPLACE_CONFIRMATION_REQUIRED';
  end if;
  if not exists (
    select 1 from public.users u
    where u.id = p_actor_id
      and (u.tenant_id = p_expected_tenant or u.role in ('owner', 'admin', 'success'))
  ) then
    raise exception 'CONVERSATION_ACTOR_NOT_AUTHORIZED';
  end if;

  update public.conversations
  set status = 'human', status_reason = 'lead_requested_human', status_changed_at = now(),
      taken_over_by = p_actor_id, taken_over_at = now(), unread_by_coach = false
  where id = p_conversation_id;
  update public.followups
  set status = 'canceled', canceled_reason = 'takeover'
  where conversation_id = p_conversation_id and status = 'scheduled';
  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (p_expected_tenant, p_conversation_id, 'system', 'system', 'A person joined this conversation.');

  audit_id := app.write_audit_row(
    'conversation.takeover.claimed', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('prior_status', conversation_row.status, 'new_status', 'human'),
    conversation_row.taken_over_by
  );
  return audit_id;
end;
$$;

create or replace function public.release_conversation(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_expected_holder_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> 'human'
    or conversation_row.taken_over_by is distinct from p_expected_holder_id
    or p_actor_id is distinct from p_expected_holder_id then
    raise exception 'CONVERSATION_RELEASE_STALE';
  end if;

  update public.conversations
  set status = 'agent', status_reason = null, status_changed_at = now(),
      taken_over_by = null, taken_over_at = null, disclosure_pending = true
  where id = p_conversation_id;
  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (p_expected_tenant, p_conversation_id, 'system', 'system', 'The automated assistant resumed this conversation.');

  audit_id := app.write_audit_row(
    'conversation.takeover.released', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('prior_status', 'human', 'new_status', 'agent')
  );
  return audit_id;
end;
$$;

create or replace function public.clear_conversation_guardrail(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status not in ('needs_human', 'scope_blocked') then
    raise exception 'CONVERSATION_GUARDRAIL_NOT_HELD';
  end if;
  update public.conversations
  set status = 'agent', status_reason = null, status_changed_at = now(), needs_human_at = null,
      tripwire_count = 0, scope_attack_count = 0, consecutive_no_match_count = 0,
      disclosure_pending = true
  where id = p_conversation_id;
  audit_id := app.write_audit_row(
    'conversation.guardrail.cleared', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, p_reason,
    jsonb_build_object('prior_status', conversation_row.status, 'new_status', 'agent')
  );
  return audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Tenant-asserting transactional RPCs: calendar, appointment, and pipeline
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from public.appointments where status = 'canceled') then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE1_APPOINTMENT_CANCEL_SOURCE_REMEDIATION_REQUIRED',
      detail = 'Assign lead/coach/provider_missing/system to every canceled appointment from the provider record before retrying.';
  end if;
end
$$;

alter table public.appointments
  add constraint appointments_cancel_shape_chk check (
    (status = 'canceled') = (canceled_at is not null and cancel_source is not null)
  );

create or replace function public.record_provider_appointment(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_calendar_connection_id uuid,
  p_provider public.calendar_provider,
  p_external_id text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text,
  p_created_source public.appointment_source,
  p_attributed_to_agent boolean
)
returns table (appointment_id uuid, billable_event_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_tenant uuid;
  conversation_tenant uuid;
  calendar_tenant uuid;
  appointment_row public.appointments%rowtype;
  billable_id uuid;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  select tenant_id into contact_tenant from public.contacts where id = p_contact_id;
  perform app.assert_expected_tenant(p_expected_tenant, contact_tenant, 'contact');
  if p_conversation_id is not null then
    select tenant_id into conversation_tenant from public.conversations where id = p_conversation_id;
    perform app.assert_expected_tenant(p_expected_tenant, conversation_tenant, 'conversation');
  end if;
  if p_calendar_connection_id is not null then
    select tenant_id into calendar_tenant from public.calendar_connections
    where id = p_calendar_connection_id;
    perform app.assert_expected_tenant(p_expected_tenant, calendar_tenant, 'calendar_connection');
  end if;
  if p_end_at <= p_start_at or nullif(btrim(p_external_id), '') is null
    or nullif(btrim(p_timezone), '') is null then
    raise exception 'APPOINTMENT_REQUIRED_FIELD_INVALID';
  end if;

  select * into appointment_row from public.appointments
  where provider = p_provider and external_id = p_external_id
  for update;
  if appointment_row.id is not null then
    perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');
    select be.id into billable_id from public.billable_events be
    where be.appointment_id = appointment_row.id and be.adjusts_event_id is null;
    return query select appointment_row.id, billable_id, null::bigint;
    return;
  end if;

  insert into public.appointments (
    tenant_id, contact_id, conversation_id, provider, external_id,
    calendar_connection_id, calendar_id, start_at, end_at, timezone,
    created_source, attributed_to_agent
  ) values (
    p_expected_tenant, p_contact_id, p_conversation_id, p_provider, p_external_id,
    p_calendar_connection_id,
    (select external_calendar_id from public.calendar_connections where id = p_calendar_connection_id),
    p_start_at, p_end_at, p_timezone, p_created_source, p_attributed_to_agent
  ) returning * into appointment_row;

  if p_created_source = 'agent' and p_attributed_to_agent and not appointment_row.is_test then
    insert into public.billable_events (tenant_id, quantity, appointment_id, is_test)
    values (p_expected_tenant, 1, appointment_row.id, false)
    returning id into billable_id;
  end if;

  update public.contacts
  set pipeline_stage = 'booked', stage_set_by = 'system', stage_set_at = now()
  where id = p_contact_id;

  logged_id := app.write_audit_row(
    'appointment.created', null, p_expected_tenant, 'appointment', appointment_row.id::text,
    null, jsonb_build_object(
      'created_source', p_created_source,
      'attributed_to_agent', p_attributed_to_agent,
      'provider_external_id', p_external_id
    )
  );

  if not appointment_row.is_test then
    insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link)
    select p_expected_tenant, u.id, 'appointment.booked', 'success',
      'Appointment booked', 'A lead booked an appointment.',
      '/coach/conversations/' || coalesce(p_conversation_id::text, '')
    from public.users u
    where u.tenant_id = p_expected_tenant and u.role = 'coach'
    order by u.created_at, u.id
    limit 1;
  end if;

  return query select appointment_row.id, billable_id, logged_id;
end;
$$;

create or replace function public.reschedule_appointment(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_to_start_at timestamptz,
  p_to_end_at timestamptz,
  p_initiated_by text,
  p_actor_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  appointment_row public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into appointment_row from public.appointments where id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');
  if p_to_end_at <= p_to_start_at then raise exception 'APPOINTMENT_TIME_INVALID'; end if;

  insert into public.appointment_reschedules (
    tenant_id, appointment_id, from_start_at, from_end_at, to_start_at, to_end_at,
    initiated_by, actor_id, is_test
  ) values (
    p_expected_tenant, p_appointment_id, appointment_row.start_at, appointment_row.end_at,
    p_to_start_at, p_to_end_at, p_initiated_by, p_actor_id, false
  );
  update public.appointments
  set start_at = p_to_start_at, end_at = p_to_end_at, updated_at = now()
  where id = p_appointment_id;

  audit_id := app.write_audit_row(
    'appointment.rescheduled', null, p_expected_tenant, 'appointment', p_appointment_id::text,
    null, jsonb_build_object(
      'prior', jsonb_build_object('start_at', appointment_row.start_at, 'end_at', appointment_row.end_at),
      'new', jsonb_build_object('start_at', p_to_start_at, 'end_at', p_to_end_at),
      'initiated_by', p_initiated_by,
      'actor_id', p_actor_id
    )
  );
  return audit_id;
end;
$$;

create or replace function public.cancel_appointment(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_cancel_source text,
  p_actor_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  appointment_row public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into appointment_row from public.appointments where id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');

  update public.appointments
  set status = 'canceled', canceled_at = now(), cancel_source = p_cancel_source, updated_at = now()
  where id = p_appointment_id;
  update public.contacts
  set pipeline_stage = 'qualifying', stage_set_by = 'system', stage_set_at = now()
  where id = appointment_row.contact_id
    and pipeline_stage = 'booked' and stage_set_by = 'system';

  audit_id := app.write_audit_row(
    'appointment.canceled', null, p_expected_tenant, 'appointment', p_appointment_id::text,
    null, jsonb_build_object('cancel_source', p_cancel_source, 'actor_id', p_actor_id)
  );
  return audit_id;
end;
$$;

create or replace function public.record_appointment_attendance(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_status public.appointment_status,
  p_source text,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  appointment_row public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_status not in ('completed', 'no_show') then
    raise exception 'ATTENDANCE_STATUS_INVALID';
  end if;
  select * into appointment_row from public.appointments where id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');
  if appointment_row.attendance_source = 'coach' and p_source <> 'coach' then
    raise exception 'COACH_ATTENDANCE_IS_AUTHORITATIVE';
  end if;

  update public.appointments
  set status = p_status, attendance_source = p_source, attendance_set_at = now(),
      attendance_set_by = p_actor_id, updated_at = now()
  where id = p_appointment_id;

  if p_status = 'no_show' then
    update public.contacts
    set pipeline_stage = 'no_show', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id;
  else
    update public.contacts
    set pipeline_stage = 'booked', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id and pipeline_stage = 'no_show';
  end if;

  audit_id := app.write_audit_row(
    'appointment.attendance_set', p_actor_id, p_expected_tenant, 'appointment',
    p_appointment_id::text, null,
    jsonb_build_object('prior_status', appointment_row.status, 'new_status', p_status, 'source', p_source)
  );
  return audit_id;
end;
$$;

create or replace function public.set_contact_pipeline_stage(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_stage public.pipeline_stage,
  p_set_by text,
  p_actor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  latest_appointment public.appointments%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  if p_set_by = 'user' and p_actor_id is null then raise exception 'PIPELINE_ACTOR_REQUIRED'; end if;
  if p_set_by = 'system' and contact_row.stage_set_by = 'user' and p_stage <> 'booked' then
    raise exception 'PIPELINE_USER_STAGE_PROTECTED';
  end if;
  if p_stage = 'no_show' then
    select * into latest_appointment from public.appointments
    where contact_id = p_contact_id
    order by start_at desc, id desc limit 1;
    if latest_appointment.id is null or latest_appointment.status <> 'no_show' then
      raise exception 'PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT';
    end if;
  end if;
  update public.contacts
  set pipeline_stage = p_stage, stage_set_by = p_set_by, stage_set_at = now()
  where id = p_contact_id;
end;
$$;

create or replace function public.record_calendar_slot_fetch(
  p_expected_tenant uuid,
  p_calendar_connection_id uuid,
  p_ok boolean,
  p_error text,
  p_fetched_at timestamptz default now()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  calendar_tenant uuid;
begin
  perform app.assert_not_impersonating();
  select tenant_id into calendar_tenant from public.calendar_connections
  where id = p_calendar_connection_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, calendar_tenant, 'calendar_connection');
  if (p_ok and p_error is not null) or (not p_ok and nullif(btrim(p_error), '') is null) then
    raise exception 'CALENDAR_SLOT_HEALTH_SHAPE_INVALID';
  end if;
  update public.calendar_connections
  set last_slot_fetch_at = p_fetched_at,
      last_slot_fetch_ok = p_ok,
      last_error = case when p_ok then null else p_error end,
      updated_at = now()
  where id = p_calendar_connection_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Tenant-asserting transactional RPCs: impersonation, demo, export, limiter
-- ---------------------------------------------------------------------------

create or replace function public.start_impersonation(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_reason text,
  p_now timestamptz default now()
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_role public.user_role;
  session_id uuid;
begin
  perform app.assert_not_impersonating();
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role not in ('owner', 'admin', 'success') then
    raise exception 'IMPERSONATION_ROLE_FORBIDDEN';
  end if;
  if not exists (select 1 from public.tenants where id = p_expected_tenant) then
    raise exception 'EXPECTED_TENANT_NOT_FOUND';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'IMPERSONATION_REASON_REQUIRED'; end if;
  if exists (
    select 1 from public.impersonation_sessions
    where actor_id = p_actor_id and ended_at is null and expires_at > p_now
  ) then
    raise exception 'IMPERSONATION_SESSION_ALREADY_ACTIVE';
  end if;

  insert into public.impersonation_sessions (
    actor_id, tenant_id, reason, started_at, expires_at
  ) values (
    p_actor_id, p_expected_tenant, p_reason, p_now, p_now + interval '30 minutes'
  ) returning id into session_id;

  perform app.write_audit_row(
    'impersonation.started', p_actor_id, p_expected_tenant, 'impersonation_session',
    session_id::text, p_reason, jsonb_build_object('expires_at', p_now + interval '30 minutes'),
    null, session_id
  );
  return session_id;
end;
$$;

create or replace function public.end_impersonation(
  p_session_id uuid,
  p_actor_id uuid,
  p_now timestamptz default now()
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.impersonation_sessions%rowtype;
  audit_id bigint;
begin
  select * into session_row from public.impersonation_sessions
  where id = p_session_id for update;
  if session_row.id is null or session_row.actor_id <> p_actor_id then
    raise exception 'IMPERSONATION_SESSION_NOT_FOUND';
  end if;
  if session_row.ended_at is not null then
    raise exception 'IMPERSONATION_SESSION_ALREADY_ENDED';
  end if;
  update public.impersonation_sessions set ended_at = p_now where id = p_session_id;
  audit_id := app.write_audit_row(
    'impersonation.ended', p_actor_id, session_row.tenant_id, 'impersonation_session',
    p_session_id::text, null, jsonb_build_object('ended_at', p_now), null, p_session_id
  );
  return audit_id;
end;
$$;

create or replace function public.set_tenant_demo_flag(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_is_demo boolean,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_value boolean;
  actor_role public.user_role;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role not in ('owner', 'admin') then raise exception 'DEMO_FLAG_ROLE_FORBIDDEN'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'DEMO_FLAG_REASON_REQUIRED'; end if;
  select is_demo into prior_value from public.tenants
  where id = p_expected_tenant for update;
  if prior_value is null then raise exception 'EXPECTED_TENANT_NOT_FOUND'; end if;
  update public.tenants set is_demo = p_is_demo, updated_at = now()
  where id = p_expected_tenant;
  audit_id := app.write_audit_row(
    'tenant.demo_flag.changed', p_actor_id, p_expected_tenant, 'tenant',
    p_expected_tenant::text, p_reason,
    jsonb_build_object('prior', prior_value, 'new', p_is_demo)
  );
  return audit_id;
end;
$$;

create or replace function public.start_export(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_resource text,
  p_filter jsonb,
  p_columns text[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if not exists (select 1 from public.tenants where id = p_expected_tenant) then
    raise exception 'EXPECTED_TENANT_NOT_FOUND';
  end if;
  return app.write_audit_row(
    'export.started', p_actor_id, p_expected_tenant, 'export', p_resource,
    null, jsonb_build_object('filter', coalesce(p_filter, '{}'::jsonb), 'columns', p_columns)
  );
end;
$$;

create or replace function public.finish_export(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_started_audit_id bigint,
  p_resource text,
  p_row_count bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if p_row_count < 0 then raise exception 'EXPORT_ROW_COUNT_INVALID'; end if;
  if not exists (
    select 1 from public.audit_log
    where id = p_started_audit_id and action = 'export.started'
      and tenant_id = p_expected_tenant and actor_id = p_actor_id
  ) then
    raise exception 'EXPORT_START_NOT_FOUND';
  end if;
  return app.write_audit_row(
    'export.finished', p_actor_id, p_expected_tenant, 'export', p_resource,
    null, jsonb_build_object('started_audit_id', p_started_audit_id, 'row_count', p_row_count)
  );
end;
$$;

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int,
  p_now timestamptz default now()
)
returns table (allowed boolean, remaining int, retry_after int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  limiter public.request_rate_limits%rowtype;
  elapsed_seconds int;
begin
  if nullif(btrim(p_key), '') is null or p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'RATE_LIMIT_CONFIGURATION_INVALID';
  end if;
  insert into public.request_rate_limits (key, window_started_at, hits)
  values (p_key, p_now, 0)
  on conflict (key) do nothing;

  select * into limiter from public.request_rate_limits where key = p_key for update;
  if p_now >= limiter.window_started_at + make_interval(secs => p_window_seconds) then
    limiter.window_started_at := p_now;
    limiter.hits := 0;
  end if;
  elapsed_seconds := greatest(0, extract(epoch from (p_now - limiter.window_started_at))::int);

  if limiter.hits >= p_limit then
    update public.request_rate_limits
    set window_started_at = limiter.window_started_at, hits = limiter.hits, updated_at = now()
    where key = p_key;
    return query select false, 0, greatest(1, p_window_seconds - elapsed_seconds);
  else
    limiter.hits := limiter.hits + 1;
    update public.request_rate_limits
    set window_started_at = limiter.window_started_at, hits = limiter.hits, updated_at = now()
    where key = p_key;
    return query select true, greatest(0, p_limit - limiter.hits), 0;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Updated-at hooks, narrow RLS policies, grants, and function custody
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contact_identities', 'message_templates', 'calendar_connections', 'support_threads',
    'provisioning_steps', 'signup_intents', 'alert_rules', 'notification_preferences',
    'notification_deliveries', 'platform_settings'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
       for each row execute function app.set_updated_at()',
      table_name
    );
  end loop;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contact_identities', 'message_templates', 'offer_cadence_purposes', 'calendar_connections',
    'appointment_reschedules', 'message_traces', 'audit_actions', 'impersonation_sessions',
    'support_threads', 'support_messages', 'provisioning_steps', 'signup_intents', 'alert_rules',
    'notification_preferences', 'notification_deliveries', 'platform_settings',
    'request_rate_limits'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
  end loop;
end
$$;

-- Replace blanket tenant writes so impersonation can read without ever satisfying a write policy.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenant_settings', 'channel_connections', 'offer_layers', 'flow_configs', 'onboarding_runs',
    'contacts', 'conversations', 'messages', 'followups', 'appointments',
    'brain_knowledge_usage_events', 'unmatched_objections', 'billable_events'
  ] loop
    execute format('drop policy tenant_isolation on public.%I', table_name);
    execute format('drop policy platform_read on public.%I', table_name);
    execute format('drop policy platform_write on public.%I', table_name);
  end loop;
end
$$;

-- Configuration-shaped tenant tables remain visible to build; writes are tenant-owned or assigned-book.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenant_settings', 'channel_connections', 'offer_layers', 'flow_configs', 'onboarding_runs'
  ] loop
    execute format(
      'create policy tenant_read on public.%I for select to authenticated
       using (app.owns_tenant(tenant_id))', table_name);
    execute format(
      'create policy tenant_write on public.%I for all to authenticated
       using (app.owns_tenant(tenant_id) and app.not_impersonating())
       with check (app.owns_tenant(tenant_id) and app.not_impersonating())', table_name);
    execute format(
      'create policy platform_read on public.%I for select to authenticated
       using (app.is_platform_user())', table_name);
    execute format(
      'create policy platform_write on public.%I for all to authenticated
       using (app.can_platform_write_tenant(tenant_id))
       with check (app.can_platform_write_tenant(tenant_id))', table_name);
  end loop;
end
$$;

-- Lead and derived lead-data tables exclude build and make every direct write impersonation-aware.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contacts', 'conversations', 'followups', 'appointments',
    'brain_knowledge_usage_events', 'unmatched_objections'
  ] loop
    execute format(
      'create policy tenant_read on public.%I for select to authenticated
       using (app.owns_tenant(tenant_id))', table_name);
    execute format(
      'create policy tenant_write on public.%I for all to authenticated
       using (app.owns_tenant(tenant_id) and app.not_impersonating())
       with check (app.owns_tenant(tenant_id) and app.not_impersonating())', table_name);
    execute format(
      'create policy platform_read on public.%I for select to authenticated
       using (app.is_platform_operator())', table_name);
    execute format(
      'create policy platform_write on public.%I for all to authenticated
       using (app.can_platform_write_tenant(tenant_id))
       with check (app.can_platform_write_tenant(tenant_id))', table_name);
  end loop;
end
$$;

-- Messages and financial rows are direct-read only; all mutations use service RPCs.
create policy messages_tenant_read on public.messages for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy messages_platform_read on public.messages for select to authenticated
  using (app.is_platform_operator());
create policy billable_events_tenant_read on public.billable_events for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy billable_events_platform_read on public.billable_events for select to authenticated
  using (app.is_platform_operator());

drop policy tiers_read on public.tiers;
drop policy tiers_admin_write on public.tiers;
create policy tiers_scoped_read on public.tiers for select to authenticated
  using (
    app.is_platform_user()
    or exists (
      select 1 from public.tenants t
      where t.id = app.current_tenant_id() and t.tier_id = tiers.id
    )
  );

drop policy dnc_tenant_read on public.suppression_entries;
drop policy dnc_tenant_insert on public.suppression_entries;
drop policy dnc_platform_all on public.suppression_entries;
create policy suppression_tenant_read on public.suppression_entries for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy suppression_tenant_insert on public.suppression_entries for insert to authenticated
  with check (app.owns_tenant(tenant_id) and app.not_impersonating());
create policy suppression_platform_read on public.suppression_entries for select to authenticated
  using (app.is_platform_operator());

drop policy audit_log_platform_read on public.audit_log;
create policy audit_log_platform_read on public.audit_log for select to authenticated
  using (app.is_platform_operator());

drop policy referrals_self_read on public.referrals;
drop policy referrals_platform_all on public.referrals;
create policy referrals_platform_read on public.referrals for select to authenticated
  using (app.is_platform_operator());
drop policy commission_owner_write on public.commission_ledger;

drop policy notifications_mark_read on public.notifications;
create policy notifications_mark_read on public.notifications for update to authenticated
  using ((user_id = app.current_user_id() or app.owns_tenant(tenant_id)) and app.not_impersonating())
  with check ((user_id = app.current_user_id() or app.owns_tenant(tenant_id)) and app.not_impersonating());

create policy contact_identities_tenant_read on public.contact_identities for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy contact_identities_platform_read on public.contact_identities for select to authenticated
  using (app.is_platform_operator());

create policy message_templates_tenant_read on public.message_templates for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy message_templates_platform_read on public.message_templates for select to authenticated
  using (app.is_platform_user());

create policy offer_cadence_tenant_read on public.offer_cadence_purposes for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy offer_cadence_platform_read on public.offer_cadence_purposes for select to authenticated
  using (app.is_platform_user());

create policy calendar_connections_tenant_read on public.calendar_connections for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy calendar_connections_platform_read on public.calendar_connections for select to authenticated
  using (app.is_platform_operator());

create policy appointment_reschedules_tenant_read on public.appointment_reschedules for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy appointment_reschedules_platform_read on public.appointment_reschedules for select to authenticated
  using (app.is_platform_operator());

create policy message_traces_admin_read on public.message_traces for select to authenticated
  using (app.is_platform_admin());

create policy audit_actions_registry_read on public.audit_actions for select to authenticated
  using (coach_visible or app.is_platform_user());

create policy impersonation_sessions_actor_read on public.impersonation_sessions for select to authenticated
  using (actor_id = app.current_user_id() or app.is_platform_operator());

create policy support_threads_tenant_read on public.support_threads for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy support_threads_platform_read on public.support_threads for select to authenticated
  using (app.is_platform_operator());
create policy support_messages_tenant_read on public.support_messages for select to authenticated
  using (app.owns_tenant(tenant_id) and not internal);
create policy support_messages_platform_read on public.support_messages for select to authenticated
  using (app.is_platform_operator());

create policy provisioning_steps_tenant_read on public.provisioning_steps for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy provisioning_steps_platform_read on public.provisioning_steps for select to authenticated
  using (app.is_platform_user());

create policy signup_intents_self_read on public.signup_intents for select to authenticated
  using (auth_user_id = app.current_user_id());
create policy signup_intents_platform_read on public.signup_intents for select to authenticated
  using (app.is_platform_user());

create policy alert_rules_read on public.alert_rules for select to authenticated using (true);

create policy notification_preferences_self_read on public.notification_preferences
  for select to authenticated using (user_id = app.current_user_id());
create policy notification_preferences_self_insert on public.notification_preferences
  for insert to authenticated with check (user_id = app.current_user_id() and app.not_impersonating());
create policy notification_preferences_self_update on public.notification_preferences
  for update to authenticated
  using (user_id = app.current_user_id() and app.not_impersonating())
  with check (user_id = app.current_user_id() and app.not_impersonating());
create policy notification_preferences_platform_read on public.notification_preferences
  for select to authenticated using (app.is_platform_operator());

create policy notification_deliveries_recipient_read on public.notification_deliveries
  for select to authenticated using (
    exists (
      select 1 from public.notifications n
      where n.id = notification_deliveries.notification_id
        and (n.user_id = app.current_user_id() or app.owns_tenant(n.tenant_id))
    )
  );
create policy notification_deliveries_platform_read on public.notification_deliveries
  for select to authenticated using (app.is_platform_operator());

create policy platform_settings_admin_read on public.platform_settings for select to authenticated
  using (app.is_platform_admin());
create policy request_rate_limits_admin_read on public.request_rate_limits for select to authenticated
  using (app.is_platform_admin());

-- Default grants from Phase 0 were intentionally broad; this follow-on makes every new object opt in.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'contact_identities', 'message_templates', 'offer_cadence_purposes', 'calendar_connections',
    'appointment_reschedules', 'message_traces', 'audit_actions', 'impersonation_sessions',
    'support_threads', 'support_messages', 'provisioning_steps', 'signup_intents', 'alert_rules',
    'notification_preferences', 'notification_deliveries', 'platform_settings',
    'request_rate_limits'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', table_name);
  end loop;
end
$$;

revoke all on public.messages, public.billable_events, public.tiers, public.audit_log,
  public.referrals, public.commission_ledger from authenticated;
grant select on public.messages, public.billable_events, public.tiers, public.audit_log,
  public.referrals, public.commission_ledger to authenticated;

grant select on public.contact_identities, public.message_templates, public.offer_cadence_purposes,
  public.calendar_connections, public.appointment_reschedules, public.message_traces,
  public.audit_actions, public.impersonation_sessions, public.support_threads,
  public.support_messages, public.provisioning_steps, public.signup_intents, public.alert_rules,
  public.notification_deliveries, public.platform_settings, public.request_rate_limits
  to authenticated;
grant select, insert, update on public.notification_preferences to authenticated;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon, authenticated;
revoke update, delete on public.audit_log from service_role;
grant select, insert on public.audit_log to service_role;
revoke insert, update, delete on public.messages, public.billable_events from service_role;
grant select on public.messages, public.billable_events to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated, public;

revoke execute on all functions in schema public from anon, authenticated, public;
grant execute on all functions in schema public to service_role;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

revoke execute on function app.write_audit_row(text, uuid, uuid, text, text, text, jsonb, uuid, uuid)
  from authenticated, public, anon;
revoke execute on function app.assert_expected_tenant(uuid, uuid, text)
  from authenticated, public, anon;
revoke execute on function app.assert_not_impersonating() from authenticated, public, anon;
grant execute on function app.is_platform_operator(), app.not_impersonating(),
  app.can_platform_write_tenant(uuid) to authenticated, service_role;

-- Reassert hook lockdown after replacing the function.
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated, public, anon;
grant select on public.users to supabase_auth_admin;
