-- Appointment cancellation and notification intent must commit together. Delivery remains an
-- application concern because notification preferences and recipient resolution live there.

create table public.booking_lifecycle_outbox (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  event_key text not null check (event_key = 'appointment.canceled'),
  payload jsonb not null check (payload ->> 'key' = event_key),
  attempts int not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  claimed_until timestamptz,
  claim_token uuid,
  dispatched_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_key, appointment_id),
  constraint booking_lifecycle_outbox_claim_shape_chk check (
    (claimed_until is null and claim_token is null)
    or (claimed_until is not null and claim_token is not null)
  )
);

create index booking_lifecycle_outbox_due_idx
  on public.booking_lifecycle_outbox (next_attempt_at, created_at, id)
  where dispatched_at is null;

alter table public.booking_lifecycle_outbox enable row level security;
alter table public.booking_lifecycle_outbox force row level security;
revoke all on public.booking_lifecycle_outbox from public, anon, authenticated, service_role;

create or replace function public.cancel_appointment_with_outbox(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_cancel_source text,
  p_actor_id uuid default null
)
returns table (audit_id bigint, outbox_event_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  appointment public.appointments%rowtype;
  contact public.contacts%rowtype;
  connection public.calendar_connections%rowtype;
  logged_id bigint;
  persisted_event_id uuid;
begin
  select * into appointment from public.appointments candidate
  where candidate.id = p_appointment_id for update;
  if appointment.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment.tenant_id, 'appointment');

  select * into contact from public.contacts candidate where candidate.id = appointment.contact_id;
  select * into connection from public.calendar_connections candidate
  where candidate.id = appointment.calendar_connection_id;
  if contact.id is null or connection.id is null then
    raise exception 'BOOKING_OUTBOX_CONTEXT_INCOMPLETE';
  end if;
  if appointment.provider = 'ghl' and nullif(btrim(contact.ghl_contact_id), '') is null then
    raise exception 'BOOKING_OUTBOX_PROVIDER_CONTACT_MISSING';
  end if;

  select public.cancel_appointment(
    p_expected_tenant, p_appointment_id, p_cancel_source, p_actor_id
  ) into logged_id;

  if not appointment.is_test then
    insert into public.booking_lifecycle_outbox (
      tenant_id, appointment_id, event_key, payload
    ) values (
      p_expected_tenant,
      appointment.id,
      'appointment.canceled',
      jsonb_build_object(
        'key', 'appointment.canceled',
        'tenantId', appointment.tenant_id,
        'conversationId', appointment.conversation_id,
        'contactId', appointment.contact_id,
        'providerContactId', case
          when appointment.provider = 'ghl' then contact.ghl_contact_id
          else appointment.contact_id::text
        end,
        'leadName', coalesce(contact.name, 'Unknown lead'),
        'channel', contact.last_channel,
        'leadTimezone', contact.timezone,
        'qualification', jsonb_build_object(
          'creditBand', contact.credit_range,
          'fundingGoal', contact.funding_goal,
          'timeline', contact.timeline
        ),
        'isTest', false,
        'appointmentId', appointment.id,
        'calendarConnectionId', connection.id,
        'calendarTimezone', connection.timezone,
        'startAt', appointment.start_at,
        'endAt', appointment.end_at,
        'attributedToAgent', appointment.attributed_to_agent,
        'cancelSource', p_cancel_source
      )
    )
    on conflict (event_key, appointment_id) do nothing
    returning id into persisted_event_id;

    if persisted_event_id is null then
      select event.id into persisted_event_id
      from public.booking_lifecycle_outbox event
      where event.event_key = 'appointment.canceled'
        and event.appointment_id = appointment.id;
    end if;
  end if;

  return query select logged_id, persisted_event_id;
end;
$$;

create or replace function public.claim_booking_lifecycle_outbox(
  p_limit int,
  p_now timestamptz default now()
)
returns table (
  event_id uuid,
  event_payload jsonb,
  event_claim_token uuid
)
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select event.id
    from public.booking_lifecycle_outbox event
    where event.dispatched_at is null
      and event.next_attempt_at <= p_now
      and (event.claimed_until is null or event.claimed_until <= p_now)
    order by event.next_attempt_at, event.created_at, event.id
    for update skip locked
    limit least(greatest(coalesce(p_limit, 1), 1), 100)
  ), claimed as (
    update public.booking_lifecycle_outbox event
    set claimed_until = p_now + interval '15 minutes',
        claim_token = gen_random_uuid(),
        attempts = event.attempts + 1,
        updated_at = now()
    from due
    where event.id = due.id
    returning event.id, event.payload, event.claim_token
  )
  select claimed.id, claimed.payload, claimed.claim_token from claimed;
$$;

create or replace function public.finish_booking_lifecycle_outbox(
  p_event_id uuid,
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
  if p_event_id is null or p_claim_token is null then
    raise exception 'BOOKING_OUTBOX_CLAIM_REQUIRED';
  end if;
  if p_succeeded and nullif(btrim(coalesce(p_error, '')), '') is not null then
    raise exception 'BOOKING_OUTBOX_SUCCESS_ERROR_INVALID';
  end if;

  update public.booking_lifecycle_outbox event
  set claimed_until = null,
      claim_token = null,
      dispatched_at = case when p_succeeded then p_now else event.dispatched_at end,
      next_attempt_at = case
        when p_succeeded then event.next_attempt_at
        else p_now + interval '15 minutes'
      end,
      last_error = case
        when p_succeeded then null
        else left(coalesce(nullif(btrim(p_error), ''), 'BOOKING_OUTBOX_DISPATCH_FAILED'), 240)
      end,
      updated_at = now()
  where event.id = p_event_id
    and event.claim_token = p_claim_token
    and event.claimed_until is not null;
  if not found then raise exception 'BOOKING_OUTBOX_CLAIM_NOT_FOUND'; end if;
end;
$$;

revoke execute on function public.cancel_appointment_with_outbox(uuid,uuid,text,uuid),
  public.claim_booking_lifecycle_outbox(int,timestamptz),
  public.finish_booking_lifecycle_outbox(uuid,uuid,boolean,text,timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_appointment_with_outbox(uuid,uuid,text,uuid),
  public.claim_booking_lifecycle_outbox(int,timestamptz),
  public.finish_booking_lifecycle_outbox(uuid,uuid,boolean,text,timestamptz)
  to service_role;
