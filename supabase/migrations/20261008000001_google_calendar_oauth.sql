-- Google Calendar OAuth: grant custody, single-use authorization state, and the two audited
-- writers that are allowed to change what a calendar connection claims about itself.
--
-- ---------------------------------------------------------------------------------------------
-- Why the grant gets its own table instead of living on calendar_connection_secrets
-- ---------------------------------------------------------------------------------------------
-- The grant arrives before the coach has picked a calendar, and there is no legal
-- "grant stored, calendar unknown" row on calendar_connections to hang it from:
--   * calendar_connection_secrets is `primary key (calendar_connection_id)`, and at grant time no
--     connection row exists yet.
--   * calendar_connections.external_calendar_id is `not null` and is part of the
--     (tenant_id, provider, external_calendar_id) unique key, so no placeholder id is legal --
--     it would either collide across tenants or pollute the key space.
--   * calendar_connection_secrets.access_token is plaintext `text not null`. A Google grant has
--     nothing to put there, and encrypted envelopes beside a plaintext column would leave two
--     storage formats on one table.
-- So the custody is keyed on tenant, holds V1 AES-256-GCM envelopes only, and no calendar
-- connection row is written at all until a calendar has been picked.
--
-- ---------------------------------------------------------------------------------------------
-- Why there is no refresh lease here, unlike ghl_agency_installs
-- ---------------------------------------------------------------------------------------------
-- ghl_agency_installs carries a compare-and-set lease column because a GoHighLevel refresh token
-- is single-use: the refresh call returns a replacement and invalidates the one that was sent, so
-- exactly one instance may spend it. Google does not rotate. Its documented refresh response
-- carries four fields (access_token, expires_in, scope, token_type) and refresh_token is not among
-- them, and the same page instructs "You should save refresh tokens in long-term storage and
-- continue to use them as long as they remain valid".
--   https://developers.google.com/identity/protocols/oauth2/web-server (read 2026-09-02)
-- Two concurrent refreshes here therefore cost one wasted HTTP call and nothing else. No lease
-- column, no heartbeat, no wait-for-the-winner loop. Do not "restore symmetry" with the GHL
-- custody: the symmetry would be a claim about Google that this page contradicts.
--
-- refresh_token_expires_at exists because an app in Testing publishing status is issued refresh
-- tokens that expire seven days after consent
-- (https://support.google.com/cloud/answer/15549945, read 2026-09-02), which makes `expired` the
-- normal operating condition for this integration rather than an exception.
--
-- ---------------------------------------------------------------------------------------------
-- Why the availability writer is an RPC, and why only its verified arm writes an audit row
-- ---------------------------------------------------------------------------------------------
-- src/lib/audit.ts states the rule: an audited mutation is never a service-role update followed by
-- a separate audit insert. Nothing in the tree writes calendar.connected or calendar.disconnected
-- today, so both writers land here, shaped after record_provider_connection_command
-- (20260917000001_provider_connection_commands.sql). That function cannot be reused: its receipts
-- table has a foreign key to channel_connections and it raises CHANNEL_CONNECTION_NOT_FOUND for
-- anything else.
--
-- The not_verified arm writes neither an audit row nor a receipt. The only available key is
-- calendar.connected, which is coachVisible: true with microcopy "Connection logged" and which the
-- audit surface renders as "connected a calendar". Writing it for a failed availability read would
-- have the log claim a connection at the same moment the page's amber card says availability is not
-- verified, on a coach-visible surface. src/lib/audit/actions.ts is closed to new keys, so no
-- narrower key exists and none is added here. That is also why the receipts table keeps
-- `audit_id not null`, matching the channel table it mirrors: a receipt only ever exists where an
-- audit row does.
--
-- calendar.connected and calendar.disconnected are already registered in public.audit_actions
-- (20260817000001_phase1_demo_path.sql), in src/lib/audit/actions.ts, and in the AUDIT_KEYS pin in
-- supabase/tests/phase1-schema.test.ts. This migration registers no audit action.

set search_path = public, extensions;

do $$
begin
  if to_regclass('public.calendar_connections') is null
    or to_regclass('public.audit_log') is null
    or to_regprocedure('app.assert_not_impersonating()') is null
    or to_regprocedure('app.assert_onboarding_coach(uuid,uuid)') is null
    or to_regprocedure('app.assert_expected_tenant(uuid,uuid,text)') is null
    or to_regprocedure('app.write_audit_row(text,uuid,uuid,text,text,text,jsonb,uuid,uuid,text,inet)') is null then
    raise exception 'GOOGLE_CALENDAR_OAUTH_PREREQUISITES_MISSING';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Single-use, ten-minute authorization state
-- ---------------------------------------------------------------------------
-- A copy of ghl_oauth_states with the `app` column dropped: there is one Google callback, so there
-- is nothing for a cross-app predicate to separate. tenant_id is `not null` here where the GHL
-- table allows null, because every Google connect is a coach acting inside one tenant and a state
-- with no tenant could never be matched to the grant it is about to store.

create table public.google_oauth_states (
  id uuid primary key default gen_random_uuid(),
  state_hash text unique not null check (state_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.users(id),
  return_path text not null check (return_path ~ '^/[^/]'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint google_oauth_states_expiry_chk check (
    expires_at > created_at and expires_at <= created_at + interval '10 minutes'
  ),
  constraint google_oauth_states_consumed_chk check (consumed_at is null or consumed_at >= created_at)
);
create index google_oauth_states_expiry_idx
  on public.google_oauth_states (expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 2. The grant itself, one per tenant
-- ---------------------------------------------------------------------------

create table public.google_calendar_grants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  google_account_email text,
  access_credential_envelope jsonb not null
    check (jsonb_typeof(access_credential_envelope) = 'object'),
  refresh_credential_envelope jsonb not null
    check (jsonb_typeof(refresh_credential_envelope) = 'object'),
  granted_scopes text[] not null,
  token_expires_at timestamptz not null,
  refresh_token_expires_at timestamptz,
  pending_calendars jsonb not null default '[]'::jsonb
    check (jsonb_typeof(pending_calendars) = 'array'),
  reauthorization_required_at timestamptz,
  revoked_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger set_updated_at before update on public.google_calendar_grants
  for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Receipts for the two calendar commands
-- ---------------------------------------------------------------------------

create table public.calendar_connection_command_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  command text not null check (command in ('verify', 'disconnect')),
  idempotency_key text not null check (nullif(btrim(idempotency_key), '') is not null),
  outcome text not null check (outcome in ('verified', 'not_verified', 'started', 'replayed')),
  outcome_code text not null check (nullif(btrim(outcome_code), '') is not null),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, command, idempotency_key)
);
create index calendar_connection_command_receipts_connection_idx
  on public.calendar_connection_command_receipts (calendar_connection_id, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Availability writer: the only path that may set `ready`
-- ---------------------------------------------------------------------------

create or replace function public.record_calendar_connection_availability(
  p_expected_tenant uuid,
  p_connection_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_outcome text,
  p_outcome_code text,
  p_evidence jsonb default '{}'::jsonb
)
returns table (receipt_id uuid, audit_id bigint, replayed boolean, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  connection_row public.calendar_connections%rowtype;
  existing public.calendar_connection_command_receipts%rowtype;
  evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  written_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_onboarding_coach(p_actor_id, p_expected_tenant);
  if p_outcome not in ('verified', 'not_verified')
    or nullif(btrim(p_idempotency_key), '') is null
    or nullif(btrim(p_outcome_code), '') is null
    or jsonb_typeof(evidence) <> 'object' then
    raise exception 'CALENDAR_COMMAND_INVALID';
  end if;

  -- Same replay guard as record_provider_connection_command: the advisory lock serialises two
  -- callers on the same key, so the loser reads the winner's committed receipt instead of writing
  -- a second audit row for one command.
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':calendar-command:verify:' || btrim(p_idempotency_key), 0));
  select * into existing from public.calendar_connection_command_receipts
  where tenant_id = p_expected_tenant and command = 'verify'
    and idempotency_key = btrim(p_idempotency_key);
  if existing.id is not null then
    return query select existing.id, existing.audit_id, true, existing.outcome;
    return;
  end if;

  select * into connection_row from public.calendar_connections
  where id = p_connection_id for update;
  if connection_row.id is null then raise exception 'CALENDAR_CONNECTION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, connection_row.tenant_id, 'calendar_connection');

  if p_outcome = 'verified' then
    -- calendar_health_shape_chk requires last_slot_fetch_at, last_slot_fetch_ok and last_error to
    -- move together, so all three are written in one statement rather than one per fact.
    update public.calendar_connections set
      state = 'ready',
      last_slot_fetch_at = now(),
      last_slot_fetch_ok = true,
      last_error = null,
      updated_at = now()
    where id = connection_row.id;

    written_audit_id := app.write_audit_row(
      'calendar.connected', p_actor_id, p_expected_tenant,
      'calendar_connection', connection_row.id::text, null,
      jsonb_build_object('command', 'verify', 'outcome', p_outcome,
        'code', btrim(p_outcome_code), 'evidence', evidence)
    );
    insert into public.calendar_connection_command_receipts
      (tenant_id, calendar_connection_id, command, idempotency_key, outcome, outcome_code,
       evidence, audit_id)
    values (p_expected_tenant, connection_row.id, 'verify', btrim(p_idempotency_key), p_outcome,
      btrim(p_outcome_code), evidence, written_audit_id)
    returning id into receipt_id;
    audit_id := written_audit_id;
  else
    -- The state is deliberately left alone. The authorization RPC inserts `connecting` and
    -- preserves an existing `ready`; a failed availability read is not authority to change either.
    update public.calendar_connections set
      last_slot_fetch_at = now(),
      last_slot_fetch_ok = false,
      last_error = btrim(p_outcome_code),
      updated_at = now()
    where id = connection_row.id;
    receipt_id := null;
    audit_id := null;
  end if;

  replayed := false;
  outcome := p_outcome;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Disconnect writer: state, health columns and the grant leave together
-- ---------------------------------------------------------------------------

create or replace function public.record_calendar_connection_disconnected(
  p_expected_tenant uuid,
  p_connection_id uuid,
  p_actor_id uuid,
  p_idempotency_key text,
  p_evidence jsonb default '{}'::jsonb
)
returns table (receipt_id uuid, audit_id bigint, replayed boolean, outcome text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  connection_row public.calendar_connections%rowtype;
  existing public.calendar_connection_command_receipts%rowtype;
  evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  written_audit_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_onboarding_coach(p_actor_id, p_expected_tenant);
  if nullif(btrim(p_idempotency_key), '') is null or jsonb_typeof(evidence) <> 'object' then
    raise exception 'CALENDAR_COMMAND_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':calendar-command:disconnect:' || btrim(p_idempotency_key), 0));
  select * into existing from public.calendar_connection_command_receipts
  where tenant_id = p_expected_tenant and command = 'disconnect'
    and idempotency_key = btrim(p_idempotency_key);
  if existing.id is not null then
    return query select existing.id, existing.audit_id, true, existing.outcome;
    return;
  end if;

  select * into connection_row from public.calendar_connections
  where id = p_connection_id for update;
  if connection_row.id is null then raise exception 'CALENDAR_CONNECTION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, connection_row.tenant_id, 'calendar_connection');

  -- A disconnected connection makes no claim about availability, so the three health columns are
  -- cleared in the same statement that clears the state.
  update public.calendar_connections set
    state = 'disconnected',
    last_slot_fetch_at = null,
    last_slot_fetch_ok = null,
    last_error = null,
    updated_at = now()
  where id = connection_row.id;

  -- The grant goes in the same transaction. A stored authorization outliving the connection it
  -- authorized is exactly the silent state the disconnect dialog promises the coach is gone.
  delete from public.google_calendar_grants where tenant_id = p_expected_tenant;

  written_audit_id := app.write_audit_row(
    'calendar.disconnected', p_actor_id, p_expected_tenant,
    'calendar_connection', connection_row.id::text, null,
    jsonb_build_object('command', 'disconnect', 'outcome', 'verified',
      'code', 'PROVIDER_REVOKED', 'evidence', evidence)
  );
  insert into public.calendar_connection_command_receipts
    (tenant_id, calendar_connection_id, command, idempotency_key, outcome, outcome_code,
     evidence, audit_id)
  values (p_expected_tenant, connection_row.id, 'disconnect', btrim(p_idempotency_key), 'verified',
    'PROVIDER_REVOKED', evidence, written_audit_id)
  returning id into receipt_id;

  audit_id := written_audit_id;
  replayed := false;
  outcome := 'verified';
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Forced RLS, exact grants, and comments
-- ---------------------------------------------------------------------------

do $$
declare
  custody_table text;
begin
  foreach custody_table in array array[
    'google_oauth_states', 'google_calendar_grants', 'calendar_connection_command_receipts'
  ] loop
    execute format('alter table public.%I enable row level security', custody_table);
    execute format('alter table public.%I force row level security', custody_table);
    execute format('revoke all on public.%I from public, anon, authenticated', custody_table);
    execute format('grant all on public.%I to service_role', custody_table);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      custody_table || '_service_all',
      custody_table
    );
  end loop;
end
$$;

revoke all on function public.record_calendar_connection_availability(uuid, uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_calendar_connection_availability(uuid, uuid, uuid, text, text, text, jsonb)
  to service_role;
revoke all on function public.record_calendar_connection_disconnected(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.record_calendar_connection_disconnected(uuid, uuid, uuid, text, jsonb)
  to service_role;

comment on table public.google_oauth_states is
  'Single-use, ten-minute OAuth state for the Google Calendar connect callback. Only the SHA-256 hash is stored; the callback consumes a row atomically so a replayed redirect matches nothing.';
comment on table public.google_calendar_grants is
  'Service-only Google Calendar grant custody, one row per tenant: V1 AES-256-GCM envelopes plus the expiries the resolver reads. Exists separately from calendar_connection_secrets because the grant is stored before any calendar has been picked.';
comment on column public.google_calendar_grants.pending_calendars is
  'Eligible calendarList entries as [{id, name, timeZone}] between the grant and the coach picking one. An entry Google returned with no timeZone is filtered out before it lands here, because a booking written into a substituted zone is worse than a calendar the coach cannot pick.';
comment on column public.google_calendar_grants.refresh_token_expires_at is
  'Consent time plus seven days while the app is in Testing publishing status, or the provider-returned lifetime when one arrives. Past this the grant is dead and the connection reads expired.';
comment on column public.google_calendar_grants.reauthorization_required_at is
  'Set when Google answers invalid_grant. The resolver fails closed from here rather than retrying a grant the provider has already refused.';
comment on table public.calendar_connection_command_receipts is
  'Receipt for each calendar command, mirroring provider_connection_command_receipts. audit_id is not null on purpose: a receipt only ever exists where an audit row does, which is why a failed availability read produces neither.';
comment on function public.record_calendar_connection_availability(uuid, uuid, uuid, text, text, text, jsonb) is
  'The only writer allowed to set calendar_connections.state = ready, and only after the caller has confirmed a freebusy read. Its not_verified arm writes the health columns alone: no audit row, no receipt.';
comment on function public.record_calendar_connection_disconnected(uuid, uuid, uuid, text, jsonb) is
  'Disconnects a calendar connection, clears all three health columns, drops the tenant Google grant, and logs calendar.disconnected, all in one transaction.';
