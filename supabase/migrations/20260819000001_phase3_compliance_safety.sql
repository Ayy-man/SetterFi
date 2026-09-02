-- SetterFi Phase 3 compliance and safety persistence.
--
-- This migration extends the applied Phase 1/2 schema in place. Constraints over populated
-- tables are preceded by deterministic guards, suppression identifiers are application-peppered
-- before crossing the SQL boundary, and every privileged service transition writes the closed
-- audit registry in the same transaction.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Fail-loud prerequisites and populated-row guards
-- ---------------------------------------------------------------------------

do $$
declare
  missing text[];
begin
  select array_agg(required_name order by required_name) into missing
  from unnest(array[
    'alert_rules', 'appointments', 'audit_actions', 'audit_log', 'billable_events',
    'contact_identities', 'contacts', 'conversations', 'eval_cases', 'followups',
    'platform_settings', 'suppression_entries', 'tenant_settings'
  ]) required_name
  where to_regclass('public.' || required_name) is null;

  if missing is not null then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_REQUIRED_RELATIONS_MISSING',
      detail = array_to_string(missing, ', ');
  end if;

  if to_regprocedure('app.assert_expected_tenant(uuid,uuid,text)') is null
    or to_regprocedure('app.assert_not_impersonating()') is null
    or to_regprocedure('app.not_impersonating()') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid)') is null
    or to_regprocedure('public.claim_conversation(uuid,uuid,uuid,convo_status,uuid,boolean)') is null
    or to_regprocedure('public.release_conversation(uuid,uuid,uuid,uuid)') is null
    or to_regprocedure('public.record_manual_suppression(uuid,uuid,messaging_channel,text,text,text,uuid)') is null then
    raise exception 'PHASE3_PHASE1_SERVICE_CONTRACT_REQUIRED';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.followups'::regclass and conname = 'followups_touch_cap_chk'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.billable_events'::regclass and conname = 'billable_events_shape_chk'
  ) or not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tenant_settings'::regclass
      and conname = 'tenant_settings_quiet_hours_floor_chk'
  ) then
    raise exception 'PHASE3_PHASE1_CONSTRAINTS_REQUIRED';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tenant_settings'
      and policyname = 'tenant_read' and cmd = 'SELECT'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'tenant_settings'
      and policyname = 'tenant_write' and cmd = 'ALL'
  ) then
    raise exception 'PHASE3_TENANT_SETTINGS_POLICIES_REQUIRED';
  end if;

  if exists (select 1 from public.followups where deferred_count > 1) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_FOLLOWUP_DEFERRAL_REMEDIATION_REQUIRED',
      detail = 'Cancel or reconcile follow-ups already deferred more than once before retrying.';
  end if;

  if exists (
    select 1 from public.followups
    where cadence_anchor_at is null
       or scheduled_at > cadence_anchor_at + interval '60 days'
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_FOLLOWUP_CADENCE_REMEDIATION_REQUIRED',
      detail = 'Re-anchor or cancel every follow-up outside the reviewed 60-day scheduling cap.';
  end if;

  if exists (
    select 1 from public.suppression_entries
    where identifier_hash !~ '^[0-9a-f]{64}$'
       or (identifier_last4 is not null and char_length(identifier_last4) not between 1 and 4)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_SUPPRESSION_IDENTIFIER_REMEDIATION_REQUIRED',
      detail = 'Recompute malformed suppression digests application-side and retain at most four display characters before retrying.';
  end if;

  if exists (
    select 1 from public.suppression_entries
    where provider_sync_state = 'confirmed'
      and (provider_synced_at is null or provider_sync_error is not null)
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_SUPPRESSION_CONFIRMATION_REMEDIATION_REQUIRED',
      detail = 'Reconcile each confirmed provider suppression with its persisted confirmation time and cleared error before retrying.';
  end if;

  if exists (select 1 from public.platform_settings where approved) then
    raise exception using
      errcode = 'P0001',
      message = 'PHASE3_AGENT_CONTENT_APPROVAL_REVIEW_REQUIRED',
      detail = 'Review the newly required STOP, HELP, START, and scope-ladder slots before extending an approved content row.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Durable compliance state, constraints, and advisory cadence storage
-- ---------------------------------------------------------------------------

alter table public.contacts
  add column stop_confirmation_key text,
  add column stop_confirmation_reserved_at timestamptz,
  add column stop_confirmation_sent_at timestamptz,
  add column deletion_preview_token uuid,
  add column deletion_previewed_at timestamptz,
  add column deletion_preview_actor_id uuid references public.users(id) on delete set null,
  add constraint contacts_stop_confirmation_shape_chk check (
    (stop_confirmation_key is null and stop_confirmation_reserved_at is null
      and stop_confirmation_sent_at is null)
    or (nullif(btrim(stop_confirmation_key), '') is not null
      and stop_confirmation_reserved_at is not null
      and (stop_confirmation_sent_at is null
        or stop_confirmation_sent_at >= stop_confirmation_reserved_at))
  ),
  add constraint contacts_deletion_preview_shape_chk check (
    (deletion_preview_token is null and deletion_previewed_at is null
      and deletion_preview_actor_id is null)
    or (deletion_preview_token is not null and deletion_previewed_at is not null
      and deletion_preview_actor_id is not null)
  );

create unique index contacts_stop_confirmation_key_uidx
  on public.contacts (tenant_id, stop_confirmation_key)
  where stop_confirmation_key is not null;

alter table public.suppression_entries
  add column provider_sync_attempts int not null default 0,
  add column provider_last_checked_at timestamptz,
  add column provider_next_retry_at timestamptz,
  add constraint suppression_entries_hash_chk check (identifier_hash ~ '^[0-9a-f]{64}$'),
  add constraint suppression_entries_last4_chk check (
    identifier_last4 is null or char_length(identifier_last4) between 1 and 4
  ),
  add constraint suppression_entries_attempts_chk check (provider_sync_attempts >= 0),
  add constraint suppression_entries_confirmation_chk check (
    (provider_sync_state = 'confirmed' and provider_synced_at is not null
      and provider_sync_error is null)
    or provider_sync_state <> 'confirmed'
  );

alter table public.followups
  add column paused_at timestamptz,
  add column remaining_offset_seconds int,
  add column claim_token uuid,
  add column claimed_at timestamptz,
  add column claim_expires_at timestamptz,
  add column attempt_idempotency_key text,
  add column attempt_count int not null default 0,
  add constraint followups_pause_shape_chk check (
    (paused_at is null and remaining_offset_seconds is null)
    or (status = 'scheduled' and paused_at is not null
      and remaining_offset_seconds is not null and remaining_offset_seconds >= 0)
  ),
  add constraint followups_lease_shape_chk check (
    (claim_token is null and claimed_at is null and claim_expires_at is null)
    or (claim_token is not null and claimed_at is not null
      and claim_expires_at is not null and claim_expires_at > claimed_at)
  ),
  add constraint followups_attempt_count_chk check (attempt_count >= 0),
  add constraint followups_one_deferral_chk check (deferred_count between 0 and 1);

alter table public.followups drop constraint followups_consent_window_chk;
alter table public.followups
  add constraint followups_consent_window_chk check (
    cadence_anchor_at is not null
    and scheduled_at <= cadence_anchor_at + interval '60 days'
  );

drop index public.followups_due_idx;
create index followups_due_idx on public.followups (scheduled_at)
  where status = 'scheduled'
    and paused_at is null
    and remaining_offset_seconds is null
    and claim_token is null;
create unique index followups_claim_token_uidx on public.followups (claim_token)
  where claim_token is not null;
create unique index followups_attempt_idempotency_uidx
  on public.followups (tenant_id, attempt_idempotency_key)
  where attempt_idempotency_key is not null;

comment on column public.followups.channel_class is
  'Advisory record only. Runtime capability resolution is the sole materialize/send-time class authority.';

alter table public.conversations
  add column last_lead_inbound_at timestamptz,
  add column last_scope_signal_key text,
  add column last_scope_signal_at timestamptz,
  add column last_tripwire_signal_key text,
  add column last_tripwire_signal_at timestamptz,
  add column tripwire_classes text[] not null default '{}',
  add constraint conversations_scope_signal_shape_chk check (
    (last_scope_signal_key is null and last_scope_signal_at is null)
    or (nullif(btrim(last_scope_signal_key), '') is not null and last_scope_signal_at is not null)
  ),
  add constraint conversations_tripwire_signal_shape_chk check (
    (last_tripwire_signal_key is null and last_tripwire_signal_at is null)
    or (nullif(btrim(last_tripwire_signal_key), '') is not null and last_tripwire_signal_at is not null)
  );

alter table public.billable_events add column appointment_detached_at timestamptz;
alter table public.billable_events drop constraint billable_events_shape_chk;
alter table public.billable_events
  add constraint billable_events_shape_chk check (
    (adjusts_event_id is null
      and (appointment_id is not null or appointment_detached_at is not null)
      and quantity > 0 and adjusted_by is null and adjust_reason is null)
    or
    (adjusts_event_id is not null and appointment_id is null
      and appointment_detached_at is null and quantity <> 0
      and adjusted_by is not null and nullif(btrim(adjust_reason), '') is not null)
  );

create table public.tenant_test_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.messaging_channel not null,
  identifier_hash text not null check (identifier_hash ~ '^[0-9a-f]{64}$'),
  identifier_last4 text check (
    identifier_last4 is null or char_length(identifier_last4) between 1 and 4
  ),
  verified_at timestamptz not null,
  verified_by uuid not null references public.users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, identifier_hash)
);

create table public.suppression_tombstones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.messaging_channel not null,
  identifier_hash text not null check (identifier_hash ~ '^[0-9a-f]{64}$'),
  identifier_last4 text check (
    identifier_last4 is null or char_length(identifier_last4) between 1 and 4
  ),
  deleted_at timestamptz not null default now(),
  deletion_audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, identifier_hash)
);

comment on table public.suppression_tombstones is
  'Authoritative deletion-suppression store: peppered identifiers survive without a contact row. suppression_entries remains authoritative for live suppression.';

-- ---------------------------------------------------------------------------
-- 3. Closed registries and visibly unapproved platform content
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('contact.delete.preview', 'human', 'tenant', false, true,
    'Deletion preview logged', 'Contact deletion preview recorded in the audit log'),
  ('conversation.tripwire.refused', 'system', 'tenant', false, false,
    'Tripwire refusal logged', 'Tripwire refusal recorded in the audit log'),
  ('followup.canceled.inbound', 'system', 'tenant', false, false,
    'Follow-ups canceled', 'Inbound follow-up cancellation recorded in the audit log'),
  ('followup.claimed', 'system', 'tenant', false, false,
    'Follow-up claim logged', 'Follow-up worker claim recorded in the audit log'),
  ('followup.completed', 'system', 'tenant', false, false,
    'Follow-up completion logged', 'Follow-up completion recorded in the audit log'),
  ('followup.deferred.quiet_hours', 'system', 'tenant', false, false,
    'Follow-up deferral logged', 'Quiet-hours deferral recorded in the audit log'),
  ('followup.discarded.window_closed', 'system', 'tenant', false, false,
    'Follow-up discard logged', 'Provider-window discard recorded in the audit log'),
  ('provider.rotation.verified', 'human', 'platform', false, false,
    'Rotation verification logged', 'Provider credential rotation recorded in the audit log'),
  ('suppression.clear.provider', 'system', 'tenant', false, false,
    'Provider suppression cleared', 'Provider-confirmed suppression clear recorded in the audit log'),
  ('suppression.insert.keyword', 'system', 'tenant', false, true,
    'Opt-out logged', 'Keyword opt-out recorded in the audit log'),
  ('suppression.provider.confirmed', 'system', 'tenant', false, false,
    'Provider suppression confirmed', 'Provider suppression confirmation recorded in the audit log'),
  ('suppression.provider.unconfirmed', 'system', 'tenant', false, false,
    'Provider suppression unconfirmed', 'Provider suppression failure recorded in the audit log'),
  ('test_recipient.registered', 'human', 'tenant', false, true,
    'Test recipient logged', 'Verified test recipient recorded in the audit log');

insert into public.alert_rules
  (event_key, scope, name, description, category, audience_roles, include_success_owner,
   include_billing_contact, default_destinations, suppressible, default_enabled)
values
  ('conversation.tripwire_escalated', 'platform', 'Tripwire escalation',
    'A tripwire escalated a conversation.', 'safety', '{owner,admin}', false, false,
    '{bell}', false, true),
  ('conversation.tripwire_escalated', 'tenant', 'Conversation escalated',
    'A tripwire escalated a conversation.', 'safety', '{coach}', false, false,
    '{bell}', true, true),
  ('suppression.provider_unconfirmed', 'platform', 'Provider suppression unconfirmed',
    'A provider has not confirmed a local suppression.', 'compliance', '{owner,admin}', false,
    false, '{bell}', false, true),
  ('suppression.provider_unconfirmed', 'tenant', 'Provider suppression unconfirmed',
    'A provider has not confirmed a local suppression.', 'compliance', '{coach}', true,
    false, '{bell,email}', true, true),
  ('contact.deleted', 'tenant', 'Contact deleted',
    'A privacy deletion completed and its suppression tombstone was retained.', 'compliance',
    '{coach}', false, false, '{bell}', true, true)
on conflict (event_key, scope) do nothing;

update public.platform_settings
set agent_content = agent_content || jsonb_build_object(
  'controlCopy', jsonb_build_object(
    'STOP', 'SETTERFI_DEMO_PLACEHOLDER_STOP_COPY',
    'HELP', 'SETTERFI_DEMO_PLACEHOLDER_HELP_COPY',
    'START', 'SETTERFI_DEMO_PLACEHOLDER_START_COPY'
  ),
  'scopeDeflection1', 'SETTERFI_DEMO_PLACEHOLDER_SCOPE_DEFLECTION_1',
  'scopeDeflection2', 'SETTERFI_DEMO_PLACEHOLDER_SCOPE_DEFLECTION_2',
  'scopeClosing', 'SETTERFI_DEMO_PLACEHOLDER_SCOPE_CLOSING'
), approved = false;

-- ---------------------------------------------------------------------------
-- 4. Forced RLS, narrow settings writes, and object grants
-- ---------------------------------------------------------------------------

alter table public.tenant_test_recipients enable row level security;
alter table public.tenant_test_recipients force row level security;
alter table public.suppression_tombstones enable row level security;
alter table public.suppression_tombstones force row level security;

create policy tenant_test_recipients_tenant_read
  on public.tenant_test_recipients for select to authenticated
  using (app.owns_tenant(tenant_id));
create policy tenant_test_recipients_platform_read
  on public.tenant_test_recipients for select to authenticated
  using (app.is_platform_operator());
create policy tenant_test_recipients_platform_write
  on public.tenant_test_recipients for all to authenticated
  using (app.is_platform_operator() and app.not_impersonating())
  with check (app.is_platform_operator() and app.not_impersonating());

create policy suppression_tombstones_platform_read
  on public.suppression_tombstones for select to authenticated
  using (app.is_platform_operator());
create policy suppression_tombstones_service_all
  on public.suppression_tombstones for all to service_role
  using (true) with check (true);

drop policy tenant_write on public.tenant_settings;
create policy tenant_settings_tenant_update
  on public.tenant_settings for update to authenticated
  using (app.owns_tenant(tenant_id) and app.not_impersonating())
  with check (app.owns_tenant(tenant_id) and app.not_impersonating());

revoke all on public.tenant_test_recipients, public.suppression_tombstones
  from public, anon, authenticated;
grant select, insert, update, delete on public.tenant_test_recipients to authenticated;
grant select on public.suppression_tombstones to authenticated;
grant all on public.tenant_test_recipients, public.suppression_tombstones to service_role;

-- ---------------------------------------------------------------------------
-- 5. Test-recipient and suppression service transitions
-- ---------------------------------------------------------------------------

create function public.register_tenant_test_recipient(
  p_expected_tenant uuid,
  p_channel public.messaging_channel,
  p_identifier_hash text,
  p_identifier_last4 text,
  p_actor_id uuid
)
returns table (recipient_id uuid, audit_id bigint, inserted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  persisted_id uuid;
  logged_id bigint;
  inserted_now boolean := false;
begin
  perform app.assert_not_impersonating();
  if p_identifier_hash !~ '^[0-9a-f]{64}$' then raise exception 'TEST_RECIPIENT_HASH_INVALID'; end if;
  if p_identifier_last4 is not null and char_length(p_identifier_last4) not between 1 and 4 then
    raise exception 'TEST_RECIPIENT_LAST4_INVALID';
  end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin', 'success') then
    raise exception 'TEST_RECIPIENT_ACTOR_NOT_AUTHORIZED';
  end if;
  if not exists (select 1 from public.tenants where id = p_expected_tenant) then
    raise exception 'EXPECTED_TENANT_NOT_FOUND';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':' || p_channel::text || ':' || p_identifier_hash, 0
  ));
  insert into public.tenant_test_recipients (
    tenant_id, channel, identifier_hash, identifier_last4, verified_at, verified_by
  ) values (
    p_expected_tenant, p_channel, p_identifier_hash, p_identifier_last4, now(), p_actor_id
  ) on conflict (tenant_id, channel, identifier_hash) do nothing
  returning id into persisted_id;

  if persisted_id is null then
    select id into persisted_id from public.tenant_test_recipients
    where tenant_id = p_expected_tenant and channel = p_channel
      and identifier_hash = p_identifier_hash;
  else
    inserted_now := true;
    logged_id := app.write_audit_row(
      'test_recipient.registered', p_actor_id, p_expected_tenant, 'test_recipient',
      persisted_id::text, null, jsonb_build_object('channel', p_channel)
    );
  end if;
  return query select persisted_id, logged_id, inserted_now;
end;
$$;

create function public.record_keyword_suppression(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_channels public.messaging_channel[],
  p_identifier_hashes text[],
  p_identifier_last4s text[],
  p_source text,
  p_confirmation_key text
)
returns table (suppression_ids uuid[], confirmation_reserved boolean, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  persisted_ids uuid[] := array[]::uuid[];
  persisted_id uuid;
  reserved boolean := false;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_source not in ('stop_keyword', 'stop_intent') then raise exception 'SUPPRESSION_SOURCE_INVALID'; end if;
  if nullif(btrim(p_confirmation_key), '') is null then raise exception 'SUPPRESSION_CONFIRMATION_KEY_REQUIRED'; end if;
  if coalesce(cardinality(p_channels), 0) = 0
    or cardinality(p_channels) <> cardinality(p_identifier_hashes)
    or cardinality(p_channels) <> cardinality(p_identifier_last4s) then
    raise exception 'SUPPRESSION_IDENTITY_ARRAYS_INVALID';
  end if;

  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');

  if contact_row.stop_confirmation_key = p_confirmation_key then
    select coalesce(array_agg(id order by id), '{}') into persisted_ids
    from public.suppression_entries where tenant_id = p_expected_tenant and contact_id = p_contact_id;
    return query select persisted_ids, false, null::bigint;
    return;
  end if;

  if contact_row.stop_confirmation_key is null then
    update public.contacts
    set opted_out = true, stop_confirmation_key = p_confirmation_key,
        stop_confirmation_reserved_at = now(), stop_confirmation_sent_at = null
    where id = p_contact_id;
    reserved := true;
  else
    update public.contacts set opted_out = true where id = p_contact_id;
  end if;

  for item_index in 1..cardinality(p_channels) loop
    if p_identifier_hashes[item_index] !~ '^[0-9a-f]{64}$' then
      raise exception 'SUPPRESSION_HASH_INVALID';
    end if;
    if p_identifier_last4s[item_index] is not null
      and char_length(p_identifier_last4s[item_index]) not between 1 and 4 then
      raise exception 'SUPPRESSION_LAST4_INVALID';
    end if;
    insert into public.suppression_entries (
      tenant_id, channel, identifier_hash, identifier_last4, contact_id,
      source, provider_sync_state
    ) values (
      p_expected_tenant, p_channels[item_index], p_identifier_hashes[item_index],
      p_identifier_last4s[item_index], p_contact_id, p_source, 'pending'
    ) on conflict do nothing returning id into persisted_id;
    if persisted_id is null then
      select id into persisted_id from public.suppression_entries
      where tenant_id = p_expected_tenant and channel = p_channels[item_index]
        and identifier_hash = p_identifier_hashes[item_index];
    end if;
    persisted_ids := array_append(persisted_ids, persisted_id);
  end loop;

  update public.followups followup
  set status = 'canceled', canceled_reason = 'opted_out', claim_token = null,
      claimed_at = null, claim_expires_at = null
  from public.conversations conversation
  where conversation.id = followup.conversation_id
    and conversation.contact_id = p_contact_id
    and followup.status = 'scheduled';
  update public.conversations
  set status = 'opted_out', status_reason = 'stop_keyword', status_changed_at = now()
  where contact_id = p_contact_id and status <> 'opted_out';

  logged_id := app.write_audit_row(
    'suppression.insert.keyword', null, p_expected_tenant, 'contact', p_contact_id::text,
    null, jsonb_build_object(
      'source', p_source, 'channels', p_channels, 'confirmation_reserved', reserved
    )
  );
  return query select persisted_ids, reserved, logged_id;
end;
$$;

create function public.record_provider_suppression_result(
  p_expected_tenant uuid,
  p_suppression_id uuid,
  p_confirmed boolean,
  p_error text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  suppression_row public.suppression_entries%rowtype;
  action_key text;
begin
  perform app.assert_not_impersonating();
  select * into suppression_row from public.suppression_entries
  where id = p_suppression_id for update;
  if suppression_row.id is null then raise exception 'SUPPRESSION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, suppression_row.tenant_id, 'suppression');
  if p_confirmed and p_error is not null then raise exception 'SUPPRESSION_RESULT_SHAPE_INVALID'; end if;
  if not p_confirmed and nullif(btrim(p_error), '') is null then
    raise exception 'SUPPRESSION_ERROR_REQUIRED';
  end if;

  update public.suppression_entries
  set provider_sync_state = case when p_confirmed then 'confirmed' else 'failed' end,
      provider_synced_at = case when p_confirmed then now() else null end,
      provider_sync_error = case when p_confirmed then null else btrim(p_error) end,
      provider_sync_attempts = provider_sync_attempts + 1,
      provider_last_checked_at = now(),
      provider_next_retry_at = case when p_confirmed then null else now() + interval '15 minutes' end
  where id = p_suppression_id;

  action_key := case when p_confirmed
    then 'suppression.provider.confirmed' else 'suppression.provider.unconfirmed' end;
  return app.write_audit_row(
    action_key, null, p_expected_tenant, 'suppression_entry', p_suppression_id::text,
    null, jsonb_build_object('confirmed', p_confirmed, 'error_code', p_error)
  );
end;
$$;

create function public.clear_identity_suppression(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_identity_id uuid,
  p_identifier_hash text,
  p_provider_confirmed boolean
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  identity_row public.contact_identities%rowtype;
  removed_count int;
begin
  perform app.assert_not_impersonating();
  if not p_provider_confirmed then raise exception 'SUPPRESSION_CLEAR_PROVIDER_UNCONFIRMED'; end if;
  if p_identifier_hash !~ '^[0-9a-f]{64}$' then raise exception 'SUPPRESSION_HASH_INVALID'; end if;
  select * into identity_row from public.contact_identities
  where id = p_identity_id and contact_id = p_contact_id for update;
  if identity_row.id is null then raise exception 'CONTACT_IDENTITY_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, identity_row.tenant_id, 'identity');

  delete from public.suppression_entries
  where tenant_id = p_expected_tenant and contact_id = p_contact_id
    and channel = identity_row.channel and identifier_hash = p_identifier_hash;
  get diagnostics removed_count = row_count;
  if removed_count = 0 then raise exception 'SUPPRESSION_NOT_FOUND'; end if;

  update public.contact_identities
  set consent_state = 'opted_in', consent_source = 'opt_back_in',
      consent_captured_at = now(), consent_expires_at = now() + interval '90 days'
  where id = p_identity_id;
  update public.contacts
  set opted_out = exists (
    select 1 from public.suppression_entries
    where tenant_id = p_expected_tenant and contact_id = p_contact_id
  )
  where id = p_contact_id;
  update public.conversations
  set status = 'agent', status_reason = null, status_changed_at = now()
  where contact_id = p_contact_id and channel = identity_row.channel and status = 'opted_out';

  return app.write_audit_row(
    'suppression.clear.provider', null, p_expected_tenant, 'contact_identity',
    p_identity_id::text, null, jsonb_build_object('channel', identity_row.channel)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Follow-up leasing, inbound cancellation, and server-held safety ladders
-- ---------------------------------------------------------------------------

create function public.claim_due_followups(
  p_expected_tenant uuid,
  p_worker_key text,
  p_limit int,
  p_lease_seconds int,
  p_now timestamptz default now()
)
returns table (followup_id uuid, lease_token uuid, due_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  claimed record;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null or nullif(btrim(p_worker_key), '') is null
    or p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'FOLLOWUP_CLAIM_CONFIGURATION_INVALID';
  end if;

  for claimed in
    with due as (
      select followup.id
      from public.followups followup
      where followup.tenant_id = p_expected_tenant
        and followup.status = 'scheduled'
        and followup.scheduled_at <= p_now
        and followup.paused_at is null
        and followup.remaining_offset_seconds is null
        and (followup.claim_token is null or followup.claim_expires_at <= p_now)
      order by followup.scheduled_at, followup.id
      limit p_limit
      for update skip locked
    )
    update public.followups followup
    set claim_token = gen_random_uuid(), claimed_at = p_now,
        claim_expires_at = p_now + make_interval(secs => p_lease_seconds),
        attempt_idempotency_key = p_worker_key || ':' || followup.id::text || ':' ||
          (followup.attempt_count + 1)::text,
        attempt_count = followup.attempt_count + 1
    from due where followup.id = due.id
    returning followup.id, followup.claim_token, followup.scheduled_at
  loop
    followup_id := claimed.id;
    lease_token := claimed.claim_token;
    due_at := claimed.scheduled_at;
    audit_id := app.write_audit_row(
      'followup.claimed', null, p_expected_tenant, 'followup', followup_id::text,
      null, jsonb_build_object('worker_key', p_worker_key, 'attempt', claimed.id)
    );
    return next;
  end loop;
end;
$$;

create function public.complete_followup_attempt(
  p_expected_tenant uuid,
  p_followup_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_scheduled_at timestamptz default null,
  p_canceled_reason public.followup_canceled_reason default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  followup_row public.followups%rowtype;
  action_key text;
begin
  perform app.assert_not_impersonating();
  select * into followup_row from public.followups where id = p_followup_id for update;
  if followup_row.id is null then raise exception 'FOLLOWUP_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, followup_row.tenant_id, 'followup');
  if followup_row.claim_token is distinct from p_claim_token then raise exception 'FOLLOWUP_CLAIM_STALE'; end if;
  if p_outcome not in ('sent', 'canceled', 'deferred') then raise exception 'FOLLOWUP_OUTCOME_INVALID'; end if;

  if p_outcome = 'sent' then
    if p_scheduled_at is not null or p_canceled_reason is not null then
      raise exception 'FOLLOWUP_COMPLETION_SHAPE_INVALID';
    end if;
    update public.followups set status = 'sent', sent_at = now(), claim_token = null,
      claimed_at = null, claim_expires_at = null where id = p_followup_id;
    action_key := 'followup.completed';
  elsif p_outcome = 'canceled' then
    if p_canceled_reason is null then raise exception 'FOLLOWUP_CANCEL_REASON_REQUIRED'; end if;
    update public.followups set status = 'canceled', canceled_reason = p_canceled_reason,
      claim_token = null, claimed_at = null, claim_expires_at = null where id = p_followup_id;
    action_key := case when p_canceled_reason = 'window_closed'
      then 'followup.discarded.window_closed' else 'followup.completed' end;
  else
    if p_scheduled_at is null or p_canceled_reason is not null then
      raise exception 'FOLLOWUP_DEFERRAL_SHAPE_INVALID';
    end if;
    if followup_row.deferred_count >= 1 then raise exception 'FOLLOWUP_ALREADY_DEFERRED'; end if;
    if p_scheduled_at > followup_row.cadence_anchor_at + interval '60 days' then
      raise exception 'FOLLOWUP_DEFERRAL_OUTSIDE_CADENCE';
    end if;
    update public.followups set scheduled_at = p_scheduled_at,
      original_scheduled_at = coalesce(original_scheduled_at, scheduled_at),
      deferred_count = deferred_count + 1, claim_token = null,
      claimed_at = null, claim_expires_at = null where id = p_followup_id;
    action_key := 'followup.deferred.quiet_hours';
  end if;

  return app.write_audit_row(
    action_key, null, p_expected_tenant, 'followup', p_followup_id::text,
    null, jsonb_build_object('outcome', p_outcome, 'canceled_reason', p_canceled_reason)
  );
end;
$$;

create function public.cancel_contact_followups_on_inbound(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid
)
returns table (canceled_count int, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inbound_row record;
  affected int;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  select message.id, message.created_at, conversation.id as conversation_id,
    conversation.tenant_id, conversation.contact_id
  into inbound_row
  from public.messages message
  join public.conversations conversation on conversation.id = message.conversation_id
  where message.id = p_inbound_message_id and message.direction = 'in' and message.author = 'lead';
  if inbound_row.id is null then raise exception 'LEAD_INBOUND_MESSAGE_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, inbound_row.tenant_id, 'inbound_message');
  if inbound_row.contact_id <> p_contact_id then raise exception 'INBOUND_CONTACT_MISMATCH'; end if;

  update public.followups followup
  set status = 'canceled', canceled_reason = 'lead_reply', claim_token = null,
      claimed_at = null, claim_expires_at = null
  from public.conversations conversation
  where conversation.id = followup.conversation_id
    and conversation.contact_id = p_contact_id
    and conversation.status in ('agent', 'needs_human', 'human')
    and followup.status = 'scheduled';
  get diagnostics affected = row_count;
  update public.conversations
  set cadence_anchor_at = inbound_row.created_at,
      cadence_anchor_message_id = p_inbound_message_id,
      last_lead_inbound_at = inbound_row.created_at
  where id = inbound_row.conversation_id;

  if affected > 0 then
    logged_id := app.write_audit_row(
      'followup.canceled.inbound', null, p_expected_tenant, 'contact', p_contact_id::text,
      null, jsonb_build_object('message_id', p_inbound_message_id, 'count', affected)
    );
  end if;
  return query select affected, logged_id;
end;
$$;

create function public.apply_scope_signal(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_signal_key text
)
returns table (persisted_count int, action text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  next_count int;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_signal_key), '') is null then raise exception 'SCOPE_SIGNAL_KEY_REQUIRED'; end if;
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.last_scope_signal_key = p_signal_key then
    return query select conversation_row.scope_attack_count,
      case conversation_row.scope_attack_count when 1 then 'deflect_1'
        when 2 then 'deflect_2' else 'scope_blocked' end,
      null::bigint;
    return;
  end if;
  if conversation_row.status <> 'agent' then raise exception 'CONVERSATION_HELD:%', conversation_row.status; end if;

  next_count := conversation_row.scope_attack_count + 1;
  update public.conversations
  set scope_attack_count = next_count, last_scope_signal_key = p_signal_key,
      last_scope_signal_at = now(),
      status = case when next_count >= 3 then 'scope_blocked' else status end,
      status_reason = case when next_count >= 3 then 'scope_exit_cap' else status_reason end,
      status_changed_at = case when next_count >= 3 then now() else status_changed_at end
  where id = p_conversation_id;
  if next_count >= 3 then
    update public.followups set status = 'canceled', canceled_reason = 'scope_blocked',
      claim_token = null, claimed_at = null, claim_expires_at = null
    where conversation_id = p_conversation_id and status = 'scheduled';
    logged_id := app.write_audit_row(
      'conversation.scope_blocked', null, p_expected_tenant, 'conversation',
      p_conversation_id::text, null, jsonb_build_object('scope_attack_count', next_count)
    );
  end if;
  return query select next_count,
    case next_count when 1 then 'deflect_1' when 2 then 'deflect_2' else 'scope_blocked' end,
    logged_id;
end;
$$;

create function public.apply_tripwire_signal(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_signal_key text,
  p_class text,
  p_severity text
)
returns table (persisted_count int, action text, audit_ids bigint[])
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  next_count int;
  next_action text;
  logged_ids bigint[] := array[]::bigint[];
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_signal_key), '') is null or nullif(btrim(p_class), '') is null then
    raise exception 'TRIPWIRE_SIGNAL_REQUIRED';
  end if;
  if p_severity not in ('refuse', 'escalate') then raise exception 'TRIPWIRE_SEVERITY_INVALID'; end if;
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.last_tripwire_signal_key = p_signal_key then
    return query select conversation_row.tripwire_count,
      case when conversation_row.status = 'needs_human' then 'escalated' else 'refused' end,
      '{}'::bigint[];
    return;
  end if;
  if conversation_row.status <> 'agent' then raise exception 'CONVERSATION_HELD:%', conversation_row.status; end if;

  next_count := conversation_row.tripwire_count + 1;
  next_action := case when p_severity = 'escalate' or next_count >= 2
    then 'escalated' else 'refused' end;
  update public.conversations
  set tripwire_count = next_count,
      tripwire_classes = case when p_class = any(tripwire_classes)
        then tripwire_classes else array_append(tripwire_classes, p_class) end,
      last_tripwire_signal_key = p_signal_key, last_tripwire_signal_at = now(),
      status = case when next_action = 'escalated' then 'needs_human' else status end,
      status_reason = case when next_action = 'escalated' and p_severity = 'escalate'
        then 'tripwire_escalate'::public.convo_status_reason
        when next_action = 'escalated' then 'tripwire_repeated'::public.convo_status_reason
        else status_reason end,
      status_changed_at = case when next_action = 'escalated' then now() else status_changed_at end,
      needs_human_at = case when next_action = 'escalated' then now() else needs_human_at end,
      unread_by_coach = case when next_action = 'escalated' then true else unread_by_coach end
  where id = p_conversation_id;

  logged_id := app.write_audit_row(
    'conversation.tripwire.refused', null, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('class', p_class, 'severity', p_severity, 'count', next_count)
  );
  logged_ids := array_append(logged_ids, logged_id);
  if next_action = 'escalated' then
    update public.followups set status = 'canceled', canceled_reason = 'escalated',
      claim_token = null, claimed_at = null, claim_expires_at = null
    where conversation_id = p_conversation_id and status = 'scheduled';
    logged_id := app.write_audit_row(
      'conversation.escalated', null, p_expected_tenant, 'conversation',
      p_conversation_id::text, null,
      jsonb_build_object('status_reason', case when p_severity = 'escalate'
        then 'tripwire_escalate' else 'tripwire_repeated' end,
        'tripwire_count', next_count, 'classes', conversation_row.tripwire_classes || p_class)
    );
    logged_ids := array_append(logged_ids, logged_id);
  end if;
  return query select next_count, next_action, logged_ids;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Pause-aware takeover and hand-back
-- ---------------------------------------------------------------------------

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
  select * into conversation_row from public.conversations where id = p_conversation_id for update;
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
    select 1 from public.users actor where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) then raise exception 'CONVERSATION_ACTOR_NOT_AUTHORIZED'; end if;

  update public.conversations
  set status = 'human', status_reason = 'human_takeover', status_changed_at = now(),
      taken_over_by = p_actor_id, taken_over_at = now(), unread_by_coach = false
  where id = p_conversation_id;
  update public.followups
  set paused_at = now(),
      remaining_offset_seconds = greatest(0, extract(epoch from (scheduled_at - now()))::int),
      claim_token = null, claimed_at = null, claim_expires_at = null
  where conversation_id = p_conversation_id and status = 'scheduled' and paused_at is null;
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
  select * into conversation_row from public.conversations where id = p_conversation_id for update;
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
  update public.followups
  set scheduled_at = now() + make_interval(secs => remaining_offset_seconds),
      paused_at = null, remaining_offset_seconds = null
  where conversation_id = p_conversation_id and status = 'scheduled' and paused_at is not null;
  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (p_expected_tenant, p_conversation_id, 'system', 'system',
    'The automated assistant resumed this conversation.');

  audit_id := app.write_audit_row(
    'conversation.takeover.released', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('prior_status', 'human', 'new_status', 'agent')
  );
  return audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Preview-bound hard deletion with tombstone and billing survival
-- ---------------------------------------------------------------------------

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

create or replace function app.reject_billable_event_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('app.demo_reclassification_tenant', true) = old.tenant_id::text
     and (to_jsonb(new) - 'is_test') = (to_jsonb(old) - 'is_test') then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and current_setting('app.contact_deletion_active', true) = 'true'
     and (to_jsonb(new) - 'appointment_id' - 'appointment_detached_at')
       = (to_jsonb(old) - 'appointment_id' - 'appointment_detached_at')
     and old.adjusts_event_id is null
     and old.appointment_id is not null
     and new.appointment_detached_at is not null then
    return new;
  end if;
  raise exception 'BILLABLE_EVENTS_APPEND_ONLY';
end;
$$;

create function public.preview_contact_deletion(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  actor public.users%rowtype;
  preview_token uuid := gen_random_uuid();
  logged_id bigint;
  result jsonb;
begin
  perform app.assert_not_impersonating();
  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role = 'build'
    or (actor.tenant_id is distinct from p_expected_tenant
      and actor.role not in ('owner', 'admin', 'success')) then
    raise exception 'CONTACT_DELETE_ACTOR_NOT_AUTHORIZED';
  end if;

  update public.contacts set deletion_preview_token = preview_token,
    deletion_previewed_at = now(), deletion_preview_actor_id = p_actor_id
  where id = p_contact_id;
  logged_id := app.write_audit_row(
    'contact.delete.preview', p_actor_id, p_expected_tenant, 'contact', p_contact_id::text,
    null, jsonb_build_object('preview_token', preview_token)
  );
  select jsonb_build_object(
    'previewToken', preview_token,
    'auditId', logged_id,
    'conversations', (select count(*) from public.conversations where contact_id = p_contact_id),
    'appointments', (select count(*) from public.appointments where contact_id = p_contact_id),
    'identities', (select count(*) from public.contact_identities where contact_id = p_contact_id),
    'providerLimitations', jsonb_build_array('meta_thread_not_deleted_by_setterfi')
  ) into result;
  return result;
end;
$$;

create function public.delete_contact_compliance(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_preview_token uuid,
  p_tombstone_channels public.messaging_channel[],
  p_tombstone_hashes text[],
  p_tombstone_last4s text[],
  p_provider_receipt jsonb default '{}'::jsonb
)
returns table (deleted boolean, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  existing_audit bigint;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_reason), '') is null then raise exception 'CONTACT_DELETE_REASON_REQUIRED'; end if;
  if coalesce(cardinality(p_tombstone_channels), 0) = 0
    or cardinality(p_tombstone_channels) <> cardinality(p_tombstone_hashes)
    or cardinality(p_tombstone_channels) <> cardinality(p_tombstone_last4s) then
    raise exception 'CONTACT_DELETE_TOMBSTONES_INVALID';
  end if;
  if jsonb_typeof(p_provider_receipt) <> 'object' then raise exception 'CONTACT_DELETE_PROVIDER_RECEIPT_INVALID'; end if;

  -- The lock makes a concurrent replay wait for the first transaction's surviving audit row
  -- instead of racing the contact cascade and reporting a false CONTACT_NOT_FOUND.
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':contact-delete:' || p_contact_id::text, 0
  ));
  select id into existing_audit from public.audit_log
  where tenant_id = p_expected_tenant and action = 'contact.delete'
    and target_type = 'contact' and target_id = p_contact_id::text
  order by id desc limit 1;
  if existing_audit is not null then
    return query select false, existing_audit;
    return;
  end if;

  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  if contact_row.deletion_preview_token is distinct from p_preview_token
    or contact_row.deletion_preview_actor_id is distinct from p_actor_id
    or contact_row.deletion_previewed_at < now() - interval '15 minutes' then
    raise exception 'CONTACT_DELETE_PREVIEW_STALE';
  end if;

  for item_index in 1..cardinality(p_tombstone_hashes) loop
    if p_tombstone_hashes[item_index] !~ '^[0-9a-f]{64}$' then
      raise exception 'CONTACT_DELETE_TOMBSTONE_HASH_INVALID';
    end if;
    if p_tombstone_last4s[item_index] is not null
      and char_length(p_tombstone_last4s[item_index]) not between 1 and 4 then
      raise exception 'CONTACT_DELETE_TOMBSTONE_LAST4_INVALID';
    end if;
  end loop;

  logged_id := app.write_audit_row(
    'contact.delete', p_actor_id, p_expected_tenant, 'contact', p_contact_id::text,
    p_reason, jsonb_build_object('provider_receipt', p_provider_receipt,
      'tombstone_count', cardinality(p_tombstone_hashes))
  );
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

  update public.eval_cases
  set source_tenant_id = null, source_conversation_id = null,
      source_message_id = null, source_contact_id = null,
      provenance_severed = true, quarantined = true
  where source_contact_id = p_contact_id
     or source_conversation_id in (
       select id from public.conversations where contact_id = p_contact_id
     );
  perform set_config('app.contact_deletion_active', 'true', true);
  update public.billable_events billable
  set appointment_detached_at = now()
  from public.appointments appointment
  where appointment.id = billable.appointment_id and appointment.contact_id = p_contact_id;
  delete from public.suppression_entries where contact_id = p_contact_id;
  delete from public.contacts where id = p_contact_id;
  perform set_config('app.contact_deletion_active', '', true);

  return query select true, logged_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Explicit function custody
-- ---------------------------------------------------------------------------

revoke execute on function public.register_tenant_test_recipient(uuid,public.messaging_channel,text,text,uuid)
  from public, anon, authenticated;
revoke execute on function public.record_keyword_suppression(uuid,uuid,public.messaging_channel[],text[],text[],text,text)
  from public, anon, authenticated;
revoke execute on function public.record_provider_suppression_result(uuid,uuid,boolean,text)
  from public, anon, authenticated;
revoke execute on function public.clear_identity_suppression(uuid,uuid,uuid,text,boolean)
  from public, anon, authenticated;
revoke execute on function public.claim_due_followups(uuid,text,int,int,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.complete_followup_attempt(uuid,uuid,uuid,text,timestamptz,public.followup_canceled_reason)
  from public, anon, authenticated;
revoke execute on function public.cancel_contact_followups_on_inbound(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke execute on function public.apply_scope_signal(uuid,uuid,text)
  from public, anon, authenticated;
revoke execute on function public.apply_tripwire_signal(uuid,uuid,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.preview_contact_deletion(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke execute on function public.delete_contact_compliance(uuid,uuid,uuid,text,uuid,public.messaging_channel[],text[],text[],jsonb)
  from public, anon, authenticated;
revoke execute on function app.reject_billable_event_mutation()
  from public, anon, authenticated;

grant execute on function public.register_tenant_test_recipient(uuid,public.messaging_channel,text,text,uuid),
  public.record_keyword_suppression(uuid,uuid,public.messaging_channel[],text[],text[],text,text),
  public.record_provider_suppression_result(uuid,uuid,boolean,text),
  public.clear_identity_suppression(uuid,uuid,uuid,text,boolean),
  public.claim_due_followups(uuid,text,int,int,timestamptz),
  public.complete_followup_attempt(uuid,uuid,uuid,text,timestamptz,public.followup_canceled_reason),
  public.cancel_contact_followups_on_inbound(uuid,uuid,uuid),
  public.apply_scope_signal(uuid,uuid,text),
  public.apply_tripwire_signal(uuid,uuid,text,text,text),
  public.preview_contact_deletion(uuid,uuid,uuid),
  public.delete_contact_compliance(uuid,uuid,uuid,text,uuid,public.messaging_channel[],text[],text[],jsonb)
to service_role;
