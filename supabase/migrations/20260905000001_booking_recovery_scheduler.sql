-- Durable fair scheduling for calendar reconciliation and a recovery ledger around provider-first
-- appointment creation. Both surfaces are service-role only; tenant scope is re-verified here.

alter table public.calendar_connections
  add column reconcile_next_at timestamptz not null default now(),
  add column reconcile_claimed_until timestamptz,
  add column reconcile_claim_token uuid,
  add column reconcile_last_at timestamptz,
  add column reconcile_last_error text;

create index calendar_connections_reconcile_due_idx
  on public.calendar_connections (reconcile_next_at, id)
  where state = 'ready';

create or replace function public.claim_calendar_reconciliation(
  p_limit int,
  p_now timestamptz default now()
)
returns table (
  id uuid,
  tenant_id uuid,
  provider public.calendar_provider,
  external_calendar_id text,
  external_location_id text,
  timezone text,
  booking_url text,
  reconcile_claim_token uuid
)
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select connection.id, connection.reconcile_next_at as prior_next_at
    from public.calendar_connections connection
    where connection.state = 'ready'
      and nullif(btrim(connection.external_location_id), '') is not null
      and connection.reconcile_next_at <= p_now
      and (
        connection.reconcile_claimed_until is null
        or connection.reconcile_claimed_until <= p_now
      )
    order by connection.reconcile_next_at, connection.id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 100)
  ), claimed as (
    update public.calendar_connections connection
    set reconcile_claimed_until = p_now + interval '15 minutes',
        reconcile_claim_token = gen_random_uuid(),
        -- Advance on claim, not finish. A killed batch therefore rotates behind untouched work
        -- after its lease expires instead of monopolizing the same fixed head forever.
        reconcile_next_at = p_now + interval '1 day',
        updated_at = now()
    from due
    where connection.id = due.id
    returning connection.id, connection.tenant_id, connection.provider,
      connection.external_calendar_id, connection.external_location_id,
      connection.timezone, connection.booking_url, connection.reconcile_claim_token,
      due.prior_next_at
  )
  select claimed.id, claimed.tenant_id, claimed.provider, claimed.external_calendar_id,
    claimed.external_location_id, claimed.timezone, claimed.booking_url,
    claimed.reconcile_claim_token
  from claimed
  order by claimed.prior_next_at, claimed.id;
$$;

create or replace function public.finish_calendar_reconciliation(
  p_connection_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_error text,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if p_connection_id is null or p_claim_token is null then
    raise exception 'CALENDAR_RECONCILIATION_CLAIM_REQUIRED';
  end if;
  if p_succeeded and nullif(btrim(coalesce(p_error, '')), '') is not null then
    raise exception 'CALENDAR_RECONCILIATION_SUCCESS_ERROR_INVALID';
  end if;
  update public.calendar_connections connection
  set reconcile_claimed_until = null,
      reconcile_claim_token = null,
      reconcile_last_at = p_now,
      reconcile_last_error = case
        when p_succeeded then null
        else left(coalesce(nullif(btrim(p_error), ''), 'CALENDAR_RECONCILIATION_FAILED'), 240)
      end,
      reconcile_next_at = case
        when p_succeeded then greatest(connection.reconcile_next_at, p_now + interval '1 day')
        else p_now + interval '15 minutes'
      end,
      updated_at = now()
  where connection.id = p_connection_id
    and connection.reconcile_claim_token = p_claim_token
    and connection.reconcile_claimed_until is not null;
  if not found then raise exception 'CALENDAR_RECONCILIATION_CLAIM_NOT_FOUND'; end if;
end;
$$;

create table public.booking_intents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  selected_slot_id text not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  timezone text not null,
  idempotency_key text not null unique,
  status text not null default 'pending'
    check (status in ('pending', 'creating', 'provider_created', 'completed')),
  lease_until timestamptz,
  lease_token uuid,
  attempts int not null default 0 check (attempts >= 0),
  provider_external_id text,
  provider_recovered boolean not null default false,
  appointment_id uuid references public.appointments(id) on delete restrict,
  billable_event_id uuid references public.billable_events(id) on delete restrict,
  appointment_audit_id bigint references public.audit_log(id) on delete restrict,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint booking_intents_time_order_chk check (end_at > start_at),
  constraint booking_intents_provider_shape_chk check (
    (status = 'pending' and lease_token is null
      and provider_external_id is null and appointment_id is null)
    or (status = 'creating' and lease_token is not null
      and provider_external_id is null and appointment_id is null)
    or (status = 'provider_created' and lease_token is null
      and provider_external_id is not null and appointment_id is null)
    or (status = 'completed' and lease_token is null
      and provider_external_id is not null and appointment_id is not null)
  )
);

create index booking_intents_recovery_idx
  on public.booking_intents (status, lease_until, updated_at)
  where status <> 'completed';

alter table public.booking_intents enable row level security;
alter table public.booking_intents force row level security;
revoke all on public.booking_intents from public, anon, authenticated, service_role;

create or replace function public.claim_booking_intent(
  p_idempotency_key text,
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_calendar_connection_id uuid,
  p_selected_slot_id text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text,
  p_now timestamptz default now()
)
returns table (
  intent_id uuid,
  intent_state text,
  claim_token uuid,
  recovery_required boolean,
  provider_external_id text,
  appointment_id uuid,
  billable_event_id uuid,
  appointment_audit_id bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  intent public.booking_intents%rowtype;
  contact_row public.contacts%rowtype;
begin
  if nullif(btrim(p_idempotency_key), '') is null
    or nullif(btrim(p_selected_slot_id), '') is null
    or nullif(btrim(p_timezone), '') is null
    or p_end_at <= p_start_at then
    raise exception 'BOOKING_INTENT_INPUT_INVALID';
  end if;
  select * into contact_row from public.contacts contact
  where contact.id = p_contact_id and contact.tenant_id = p_expected_tenant
  for update;
  if contact_row.id is null then raise exception 'BOOKING_INTENT_SCOPE_MISMATCH'; end if;
  -- 00010 adds deletion_intent_id. to_jsonb keeps this migration installable before that column
  -- exists while making every later claim fail closed once a deletion marker is present.
  if nullif(to_jsonb(contact_row) ->> 'deletion_intent_id', '') is not null then
    raise exception 'BOOKING_CONTACT_DELETION_PENDING';
  end if;
  if not exists (
    select 1 from public.conversations conversation
    where conversation.id = p_conversation_id
      and conversation.tenant_id = p_expected_tenant
      and conversation.contact_id = p_contact_id
  ) or not exists (
    select 1 from public.calendar_connections connection
    where connection.id = p_calendar_connection_id
      and connection.tenant_id = p_expected_tenant and connection.state = 'ready'
  ) then raise exception 'BOOKING_INTENT_SCOPE_MISMATCH'; end if;

  insert into public.booking_intents (
    tenant_id, conversation_id, contact_id, calendar_connection_id, selected_slot_id,
    start_at, end_at, timezone, idempotency_key
  ) values (
    p_expected_tenant, p_conversation_id, p_contact_id, p_calendar_connection_id,
    p_selected_slot_id, p_start_at, p_end_at, p_timezone, p_idempotency_key
  ) on conflict (idempotency_key) do nothing;

  select * into intent from public.booking_intents booking
  where booking.idempotency_key = p_idempotency_key for update;
  if intent.id is null then raise exception 'BOOKING_INTENT_NOT_FOUND'; end if;
  if intent.tenant_id is distinct from p_expected_tenant
    or intent.conversation_id is distinct from p_conversation_id
    or intent.contact_id is distinct from p_contact_id
    or intent.calendar_connection_id is distinct from p_calendar_connection_id
    or intent.selected_slot_id is distinct from p_selected_slot_id
    or intent.start_at is distinct from p_start_at
    or intent.end_at is distinct from p_end_at
    or intent.timezone is distinct from p_timezone then
    raise exception 'BOOKING_INTENT_REPLAY_MISMATCH';
  end if;

  if intent.status = 'completed' then
    return query select intent.id, 'completed'::text, null::uuid, false, intent.provider_external_id,
      intent.appointment_id, intent.billable_event_id, null::bigint;
    return;
  end if;
  if intent.status = 'provider_created' then
    return query select intent.id, 'provider_created'::text, null::uuid, false,
      intent.provider_external_id, null::uuid, null::uuid, null::bigint;
    return;
  end if;
  if intent.status = 'creating' and intent.lease_until > p_now then
    return query select intent.id, 'busy'::text, null::uuid, false,
      null::text, null::uuid, null::uuid, null::bigint;
    return;
  end if;

  recovery_required := intent.attempts > 0;
  claim_token := gen_random_uuid();
  update public.booking_intents booking
  set status = 'creating', lease_until = p_now + interval '5 minutes',
      lease_token = claim_token,
      attempts = booking.attempts + 1, last_error = null, updated_at = now()
  where booking.id = intent.id;
  return query select intent.id, 'claimed'::text, claim_token, recovery_required,
    null::text, null::uuid, null::uuid, null::bigint;
end;
$$;

create or replace function public.record_booking_intent_provider(
  p_intent_id uuid,
  p_claim_token uuid,
  p_expected_tenant uuid,
  p_provider_external_id text,
  p_recovered boolean
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
begin
  select * into intent from public.booking_intents booking
  where booking.id = p_intent_id and booking.tenant_id = p_expected_tenant for update;
  if intent.id is null then raise exception 'BOOKING_INTENT_NOT_FOUND'; end if;
  if nullif(btrim(p_provider_external_id), '') is null then
    raise exception 'BOOKING_PROVIDER_ID_REQUIRED';
  end if;
  if intent.status = 'provider_created'
    and intent.provider_external_id = p_provider_external_id then return; end if;
  if intent.status <> 'creating' or intent.lease_token is distinct from p_claim_token then
    raise exception 'BOOKING_INTENT_NOT_CLAIMED';
  end if;
  update public.booking_intents booking
  set status = 'provider_created', provider_external_id = p_provider_external_id,
      provider_recovered = p_recovered, lease_until = null, lease_token = null,
      updated_at = now()
  where booking.id = intent.id;
end;
$$;

create or replace function public.complete_booking_intent(
  p_intent_id uuid,
  p_expected_tenant uuid,
  p_provider_external_id text,
  p_appointment_id uuid,
  p_billable_event_id uuid,
  p_appointment_audit_id bigint
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare intent public.booking_intents%rowtype;
begin
  select * into intent from public.booking_intents booking
  where booking.id = p_intent_id and booking.tenant_id = p_expected_tenant for update;
  if intent.id is null then raise exception 'BOOKING_INTENT_NOT_FOUND'; end if;
  if intent.status = 'completed' and intent.appointment_id = p_appointment_id then return; end if;
  if intent.status <> 'provider_created'
    or intent.provider_external_id is distinct from p_provider_external_id then
    raise exception 'BOOKING_INTENT_PROVIDER_MISMATCH';
  end if;
  if not exists (
    select 1 from public.appointments appointment
    where appointment.id = p_appointment_id
      and appointment.tenant_id = p_expected_tenant
      and appointment.external_id = p_provider_external_id
  ) then raise exception 'BOOKING_INTENT_APPOINTMENT_MISMATCH'; end if;
  update public.booking_intents booking
  set status = 'completed', appointment_id = p_appointment_id,
      billable_event_id = p_billable_event_id,
      appointment_audit_id = p_appointment_audit_id,
      lease_until = null, last_error = null, updated_at = now()
  where booking.id = intent.id;
end;
$$;

create or replace function public.release_booking_intent(
  p_intent_id uuid,
  p_claim_token uuid,
  p_expected_tenant uuid,
  p_error text
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.booking_intents booking
  set status = 'pending', lease_until = null,
      lease_token = null,
      last_error = left(coalesce(nullif(btrim(p_error), ''), 'BOOKING_PROVIDER_FAILED'), 240),
      updated_at = now()
  where booking.id = p_intent_id and booking.tenant_id = p_expected_tenant
    and booking.status = 'creating'
    and booking.lease_token = p_claim_token;
  if not found then raise exception 'BOOKING_INTENT_NOT_CLAIMED'; end if;
end;
$$;

revoke execute on function public.claim_calendar_reconciliation(int,timestamptz),
  public.finish_calendar_reconciliation(uuid,uuid,boolean,text,timestamptz),
  public.claim_booking_intent(text,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,timestamptz),
  public.record_booking_intent_provider(uuid,uuid,uuid,text,boolean),
  public.complete_booking_intent(uuid,uuid,text,uuid,uuid,bigint),
  public.release_booking_intent(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.claim_calendar_reconciliation(int,timestamptz),
  public.finish_calendar_reconciliation(uuid,uuid,boolean,text,timestamptz),
  public.claim_booking_intent(text,uuid,uuid,uuid,uuid,text,timestamptz,timestamptz,text,timestamptz),
  public.record_booking_intent_provider(uuid,uuid,uuid,text,boolean),
  public.complete_booking_intent(uuid,uuid,text,uuid,uuid,bigint),
  public.release_booking_intent(uuid,uuid,uuid,text)
  to service_role;
