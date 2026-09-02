-- Direct booking accepts only an opaque slot id that the server previously emitted to this exact
-- lead. The emission row is both provenance and a one-shot CAS token; free text never reaches the
-- calendar provider as a guessed selection.

create table public.booking_slot_emissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  outbound_message_id uuid not null unique references public.messages(id) on delete cascade,
  slot_ids text[] not null check (cardinality(slot_ids) between 1 and 5),
  proposed_at timestamptz not null,
  expires_at timestamptz not null,
  superseded_at timestamptz,
  consumed_at timestamptz,
  selected_slot_id text,
  selection_inbound_message_id uuid unique references public.messages(id) on delete set null,
  conflict_pending_at timestamptz,
  reoffered_at timestamptz,
  reoffer_booking_intent_id uuid references public.booking_intents(id) on delete restrict,
  booking_completed_at timestamptz,
  appointment_id uuid references public.appointments(id) on delete set null,
  booking_confirmed_at timestamptz,
  confirmation_outbound_message_id uuid unique references public.messages(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at > proposed_at and expires_at <= proposed_at + interval '15 minutes'),
  check (superseded_at is null or consumed_at is null),
  check ((consumed_at is null and selected_slot_id is null and selection_inbound_message_id is null)
    or (consumed_at is not null and selected_slot_id is not null
      and selection_inbound_message_id is not null)),
  check ((booking_completed_at is null and appointment_id is null)
    or (booking_completed_at is not null and appointment_id is not null)),
  check ((booking_confirmed_at is null and confirmation_outbound_message_id is null)
    or (booking_confirmed_at is not null and confirmation_outbound_message_id is not null)),
  check (reoffered_at is null or (consumed_at is not null and booking_completed_at is null)),
  check (reoffer_booking_intent_id is null or conflict_pending_at is not null),
  check (reoffered_at is null or conflict_pending_at is not null)
);

create index booking_slot_emissions_active_idx
  on public.booking_slot_emissions (tenant_id, conversation_id, expires_at desc)
  where consumed_at is null and superseded_at is null;

alter table public.booking_slot_emissions enable row level security;
alter table public.booking_slot_emissions force row level security;
revoke all on table public.booking_slot_emissions from public, anon, authenticated, service_role;

create or replace function public.record_booking_slot_emission(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_outbound_message_id uuid,
  p_slot_ids text[],
  p_proposed_at timestamptz,
  p_expires_at timestamptz
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare emission_id uuid;
declare outbound_body text;
declare slot_id text;
begin
  if cardinality(p_slot_ids) < 1 or cardinality(p_slot_ids) > 5
    or exists (select 1 from unnest(p_slot_ids) value where nullif(btrim(value), '') is null)
    or exists (select 1 from unnest(p_slot_ids) value where value !~ '^[A-Za-z0-9._~-]{1,200}$')
    or cardinality(p_slot_ids) <> cardinality(array(select distinct value from unnest(p_slot_ids) value))
    or p_expires_at <= p_proposed_at
    or p_expires_at > p_proposed_at + interval '15 minutes' then
    raise exception 'BOOKING_SLOT_EMISSION_INPUT_INVALID';
  end if;
  select message.body into outbound_body
  from public.messages message
  join public.conversations conversation on conversation.id = message.conversation_id
  where message.id = p_outbound_message_id
    and message.tenant_id = p_expected_tenant
    and message.conversation_id = p_conversation_id
    and message.direction = 'out'
    and message.author = 'agent'
    and conversation.tenant_id = p_expected_tenant
    and conversation.contact_id = p_contact_id;
  if outbound_body is null then raise exception 'BOOKING_SLOT_EMISSION_SCOPE_MISMATCH'; end if;
  foreach slot_id in array p_slot_ids loop
    if position('[slot_id:' || slot_id || ']' in outbound_body) = 0 then
      raise exception 'BOOKING_SLOT_NOT_EMITTED';
    end if;
  end loop;

  -- Serializing on the conversation makes replacement and selection mutually exclusive. Every
  -- older offer is retired in the same transaction, so a selector can never fall back to it.
  perform 1 from public.conversations conversation
  where conversation.id = p_conversation_id
    and conversation.tenant_id = p_expected_tenant
    and conversation.contact_id = p_contact_id
  for update;
  if not found then raise exception 'BOOKING_SLOT_EMISSION_SCOPE_MISMATCH'; end if;
  if exists (
    select 1 from public.booking_slot_emissions slot_emission
    where slot_emission.tenant_id = p_expected_tenant
      and slot_emission.conversation_id = p_conversation_id
      and slot_emission.contact_id = p_contact_id
      and slot_emission.consumed_at is not null
      and slot_emission.booking_completed_at is null
      and slot_emission.reoffered_at is null
      and slot_emission.outbound_message_id <> p_outbound_message_id
  ) then raise exception 'BOOKING_SLOT_SELECTION_BUSY'; end if;
  update public.booking_slot_emissions slot_emission
  set superseded_at = now()
  where slot_emission.tenant_id = p_expected_tenant
    and slot_emission.conversation_id = p_conversation_id
    and slot_emission.contact_id = p_contact_id
    and slot_emission.consumed_at is null
    and slot_emission.superseded_at is null
    and slot_emission.outbound_message_id <> p_outbound_message_id;

  insert into public.booking_slot_emissions (
    tenant_id, conversation_id, contact_id, outbound_message_id,
    slot_ids, proposed_at, expires_at
  ) values (
    p_expected_tenant, p_conversation_id, p_contact_id, p_outbound_message_id,
    p_slot_ids, p_proposed_at, p_expires_at
  ) on conflict (outbound_message_id) do update
    set outbound_message_id = excluded.outbound_message_id
    where booking_slot_emissions.tenant_id = excluded.tenant_id
      and booking_slot_emissions.conversation_id = excluded.conversation_id
      and booking_slot_emissions.contact_id = excluded.contact_id
      and booking_slot_emissions.slot_ids = excluded.slot_ids
      and booking_slot_emissions.proposed_at = excluded.proposed_at
      and booking_slot_emissions.expires_at = excluded.expires_at
  returning id into emission_id;
  if emission_id is null then raise exception 'BOOKING_SLOT_EMISSION_REPLAY_MISMATCH'; end if;
  return emission_id;
end;
$$;

create or replace function public.claim_booking_slot_selection(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid,
  p_exact_slot_id text,
  p_now timestamptz default now()
)
returns table (selection_state text, emission_id uuid, selected_slot_id text)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare emission public.booking_slot_emissions%rowtype;
declare conversation_row public.conversations%rowtype;
declare recovered_message_id uuid;
declare recovered_body text;
declare recovered_slot_ids text[];
begin
  if nullif(btrim(p_exact_slot_id), '') is null then
    return query select 'invalid'::text, null::uuid, null::text;
    return;
  end if;
  if not exists (
    select 1 from public.messages message
    where message.id = p_inbound_message_id
      and message.tenant_id = p_expected_tenant
      and message.conversation_id = p_conversation_id
      and message.direction = 'in' and message.author = 'lead'
      and btrim(message.body) = p_exact_slot_id
  ) then raise exception 'BOOKING_SLOT_SELECTION_SCOPE_MISMATCH'; end if;
  select * into conversation_row from public.conversations conversation
  where conversation.id = p_conversation_id
    and conversation.tenant_id = p_expected_tenant
    and conversation.contact_id = p_contact_id
  for update;
  if conversation_row.id is null then raise exception 'BOOKING_SLOT_SELECTION_SCOPE_MISMATCH'; end if;

  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.selection_inbound_message_id = p_inbound_message_id
  for update;
  if emission.id is not null then
    if emission.tenant_id is distinct from p_expected_tenant
      or emission.conversation_id is distinct from p_conversation_id
      or emission.contact_id is distinct from p_contact_id
      or emission.selected_slot_id is distinct from p_exact_slot_id then
      raise exception 'BOOKING_SLOT_SELECTION_REPLAY_MISMATCH';
    end if;
    return query select case
        when emission.reoffered_at is not null then 'reoffer'
        when emission.conflict_pending_at is not null then 'conflict_pending'
        else 'replay' end,
      emission.id, emission.selected_slot_id;
    return;
  end if;

  -- A different inbound cannot select while a claimed selection is still creating/completing its
  -- durable appointment. Returning busy makes the receipt retry instead of minting a new offer.
  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.tenant_id = p_expected_tenant
    and slot_emission.conversation_id = p_conversation_id
    and slot_emission.contact_id = p_contact_id
    and slot_emission.consumed_at is not null
    and slot_emission.booking_completed_at is null
    and slot_emission.reoffered_at is null
  order by slot_emission.consumed_at desc limit 1;
  if emission.id is not null then
    return query select 'busy'::text, emission.id, null::text;
    return;
  end if;

  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.tenant_id = p_expected_tenant
    and slot_emission.conversation_id = p_conversation_id
    and slot_emission.contact_id = p_contact_id
    and slot_emission.consumed_at is null
    and slot_emission.superseded_at is null
    and slot_emission.expires_at >= p_now
  order by slot_emission.created_at desc
  limit 1 for update;
  if emission.id is null then
    -- If the provider send committed its outbound message but the worker died before recording the
    -- emission, rebuild the exact same provenance from the stored proposal and tokenized body.
    if conversation_row.proposed_slots_at is not null
      and conversation_row.proposed_slots_at + interval '15 minutes' >= p_now
      and jsonb_typeof(conversation_row.proposed_slots -> 'slots') = 'array' then
      select message.id, message.body into recovered_message_id, recovered_body
      from public.messages message
      where message.tenant_id = p_expected_tenant
        and message.conversation_id = p_conversation_id
        and message.direction = 'out' and message.author = 'agent'
        and message.created_at >= conversation_row.proposed_slots_at
        and exists (
          select 1 from jsonb_array_elements(conversation_row.proposed_slots -> 'slots') slot
          where nullif(btrim(slot ->> 'id'), '') is not null
            and position('[slot_id:' || (slot ->> 'id') || ']' in message.body) > 0
        )
      order by message.created_at desc limit 1;
      if recovered_message_id is null then
        return query select 'busy'::text, null::uuid, null::text;
        return;
      end if;
      select array_agg(candidate.slot_id order by candidate.ordinality)
      into recovered_slot_ids
      from (
        select slot ->> 'id' as slot_id, ordinality
        from jsonb_array_elements(conversation_row.proposed_slots -> 'slots')
          with ordinality as proposed(slot, ordinality)
        where nullif(btrim(slot ->> 'id'), '') is not null
          and position('[slot_id:' || (slot ->> 'id') || ']' in recovered_body) > 0
        order by ordinality limit 5
      ) candidate;
      if recovered_slot_ids is null then
        raise exception 'BOOKING_SLOT_RECOVERY_MISMATCH';
      end if;
      insert into public.booking_slot_emissions (
        tenant_id, conversation_id, contact_id, outbound_message_id,
        slot_ids, proposed_at, expires_at
      ) values (
        p_expected_tenant, p_conversation_id, p_contact_id, recovered_message_id,
        recovered_slot_ids, conversation_row.proposed_slots_at,
        conversation_row.proposed_slots_at + interval '15 minutes'
      ) on conflict (outbound_message_id) do nothing;
      select * into emission from public.booking_slot_emissions slot_emission
      where slot_emission.outbound_message_id = recovered_message_id
        and slot_emission.tenant_id = p_expected_tenant
        and slot_emission.conversation_id = p_conversation_id
        and slot_emission.contact_id = p_contact_id
      for update;
      if emission.id is null then raise exception 'BOOKING_SLOT_RECOVERY_FAILED'; end if;
    end if;
  end if;
  if emission.id is null then
    return query select 'no_offer'::text, null::uuid, null::text;
    return;
  end if;
  if not p_exact_slot_id = any(emission.slot_ids) then
    return query select 'invalid'::text, emission.id, null::text;
    return;
  end if;
  update public.booking_slot_emissions slot_emission
  set consumed_at = p_now,
      selected_slot_id = p_exact_slot_id,
      selection_inbound_message_id = p_inbound_message_id
  where slot_emission.id = emission.id and slot_emission.consumed_at is null
    and slot_emission.superseded_at is null;
  if not found then
    return query select 'busy'::text, emission.id, null::text;
    return;
  end if;
  return query select 'claimed'::text, emission.id, p_exact_slot_id;
end;
$$;

create or replace function public.release_booking_slot_selection_for_reoffer(
  p_expected_tenant uuid,
  p_emission_id uuid,
  p_inbound_message_id uuid,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare emission public.booking_slot_emissions%rowtype;
begin
  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.id = p_emission_id and slot_emission.tenant_id = p_expected_tenant
  for update;
  if emission.id is null
    or emission.selection_inbound_message_id is distinct from p_inbound_message_id
    or emission.consumed_at is null
    or emission.booking_completed_at is not null then
    raise exception 'BOOKING_SLOT_REOFFER_MISMATCH';
  end if;
  if emission.reoffered_at is null then
    update public.booking_slot_emissions
    set conflict_pending_at = coalesce(conflict_pending_at, p_now), reoffered_at = p_now
    where id = emission.id;
  end if;
end;
$$;

create or replace function public.checkpoint_booking_slot_conflict(
  p_expected_tenant uuid,
  p_emission_id uuid,
  p_inbound_message_id uuid,
  p_booking_intent_id uuid,
  p_claim_token uuid,
  p_error text,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare conversation_row public.conversations%rowtype;
declare emission public.booking_slot_emissions%rowtype;
declare intent public.booking_intents%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations conversation
  where conversation.id = (
    select candidate.conversation_id from public.booking_slot_emissions candidate
    where candidate.id = p_emission_id
  ) and conversation.tenant_id = p_expected_tenant
  for update;
  select * into emission from public.booking_slot_emissions candidate
  where candidate.id = p_emission_id and candidate.tenant_id = p_expected_tenant
  for update;
  select * into intent from public.booking_intents candidate
  where candidate.id = p_booking_intent_id and candidate.tenant_id = p_expected_tenant
  for update;
  if conversation_row.id is null or emission.id is null or intent.id is null
    or emission.conversation_id is distinct from conversation_row.id
    or emission.selection_inbound_message_id is distinct from p_inbound_message_id
    or emission.consumed_at is null or emission.booking_completed_at is not null
    or intent.conversation_id is distinct from emission.conversation_id
    or intent.contact_id is distinct from emission.contact_id
    or intent.selected_slot_id is distinct from emission.selected_slot_id then
    raise exception 'BOOKING_SLOT_CONFLICT_CHECKPOINT_SCOPE_MISMATCH';
  end if;
  if emission.conflict_pending_at is not null then
    if emission.reoffer_booking_intent_id is distinct from p_booking_intent_id
      or intent.status is distinct from 'pending'
      or intent.last_error is distinct from left(p_error, 240) then
      raise exception 'BOOKING_SLOT_CONFLICT_CHECKPOINT_REPLAY_MISMATCH';
    end if;
    return;
  end if;
  if intent.status is distinct from 'creating' or intent.lease_token is distinct from p_claim_token
    or nullif(btrim(p_error), '') is null then
    raise exception 'BOOKING_SLOT_CONFLICT_CHECKPOINT_CLAIM_MISMATCH';
  end if;
  update public.booking_intents
  set status = 'pending', lease_until = null, lease_token = null,
    last_error = left(p_error, 240), updated_at = now()
  where id = intent.id;
  update public.booking_slot_emissions
  set conflict_pending_at = p_now, reoffer_booking_intent_id = intent.id
  where id = emission.id;
end;
$$;

-- A provider conflict is a durable fact, not something inferred from a later availability list.
-- Persist the exact replacement proposal and the consumed-emission checkpoint in one transaction;
-- a lost response can then replay only the same intent/proposal tuple.
create or replace function public.record_booking_slot_conflict_reoffer(
  p_expected_tenant uuid,
  p_emission_id uuid,
  p_inbound_message_id uuid,
  p_proposal jsonb,
  p_proposed_at timestamptz,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare conversation_row public.conversations%rowtype;
declare emission public.booking_slot_emissions%rowtype;
declare intent public.booking_intents%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_proposed_at is null or jsonb_typeof(p_proposal) is distinct from 'object'
    or jsonb_typeof(p_proposal -> 'slots') is distinct from 'array'
    or jsonb_array_length(p_proposal -> 'slots') < 1
    or jsonb_array_length(p_proposal -> 'slots') > 5
    or exists (
      select 1 from jsonb_array_elements(p_proposal -> 'slots') slot
      where jsonb_typeof(slot) is distinct from 'object'
        or nullif(btrim(slot ->> 'id'), '') is null
        or nullif(btrim(slot ->> 'startAt'), '') is null
        or nullif(btrim(slot ->> 'endAt'), '') is null
        or nullif(btrim(slot ->> 'timezone'), '') is null
        or nullif(btrim(slot ->> 'display'), '') is null
    )
    or (
      select count(*) <> count(distinct slot ->> 'id')
      from jsonb_array_elements(p_proposal -> 'slots') slot
    )
    or nullif(p_proposal ->> 'calendarConnectionId', '') is null
    or nullif(p_proposal ->> 'proposedAt', '')::timestamptz is distinct from p_proposed_at then
    raise exception 'BOOKING_SLOT_CONFLICT_REOFFER_INPUT_INVALID';
  end if;
  select * into conversation_row from public.conversations conversation
  where conversation.id = (
    select candidate.conversation_id from public.booking_slot_emissions candidate
    where candidate.id = p_emission_id
  ) and conversation.tenant_id = p_expected_tenant
  for update;
  select * into emission from public.booking_slot_emissions candidate
  where candidate.id = p_emission_id and candidate.tenant_id = p_expected_tenant
  for update;
  select * into intent from public.booking_intents candidate
  where candidate.id = emission.reoffer_booking_intent_id and candidate.tenant_id = p_expected_tenant
  for update;
  if conversation_row.id is null or emission.id is null or intent.id is null
    or emission.conversation_id is distinct from conversation_row.id
    or emission.selection_inbound_message_id is distinct from p_inbound_message_id
    or emission.consumed_at is null or emission.booking_completed_at is not null
    or intent.conversation_id is distinct from emission.conversation_id
    or intent.contact_id is distinct from emission.contact_id
    or intent.selected_slot_id is distinct from emission.selected_slot_id
    or intent.calendar_connection_id::text is distinct from p_proposal ->> 'calendarConnectionId'
    or emission.conflict_pending_at is null
    or intent.status is distinct from 'pending'
    or intent.last_error is null then
    raise exception 'BOOKING_SLOT_CONFLICT_REOFFER_SCOPE_MISMATCH';
  end if;
  if emission.reoffered_at is not null then
    if conversation_row.proposed_slots_at is distinct from p_proposed_at
      or conversation_row.proposed_slots is distinct from p_proposal then
      raise exception 'BOOKING_SLOT_CONFLICT_REOFFER_REPLAY_MISMATCH';
    end if;
    return conversation_row.proposed_slots;
  end if;
  if conversation_row.proposed_slots_at > p_proposed_at
    or (conversation_row.proposed_slots_at = p_proposed_at
      and conversation_row.proposed_slots is distinct from p_proposal) then
    raise exception 'BOOKING_SLOT_CONFLICT_REOFFER_STALE';
  end if;
  update public.conversations
  set proposed_slots = p_proposal, proposed_slots_at = p_proposed_at, updated_at = now()
  where id = conversation_row.id;
  update public.booking_slot_emissions
  set reoffered_at = p_now
  where id = emission.id;
  return p_proposal;
end;
$$;

create or replace function public.complete_booking_slot_selection(
  p_expected_tenant uuid,
  p_emission_id uuid,
  p_inbound_message_id uuid,
  p_appointment_id uuid,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare emission public.booking_slot_emissions%rowtype;
begin
  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.id = p_emission_id and slot_emission.tenant_id = p_expected_tenant
  for update;
  if emission.id is null or emission.selection_inbound_message_id is distinct from p_inbound_message_id
    or not exists (
      select 1 from public.appointments appointment
      where appointment.id = p_appointment_id
        and appointment.tenant_id = p_expected_tenant
        and appointment.conversation_id = emission.conversation_id
        and appointment.contact_id = emission.contact_id
    ) then raise exception 'BOOKING_SLOT_COMPLETION_MISMATCH'; end if;
  if emission.booking_completed_at is not null then
    if emission.appointment_id is distinct from p_appointment_id then
      raise exception 'BOOKING_SLOT_COMPLETION_REPLAY_MISMATCH';
    end if;
    return;
  end if;
  update public.booking_slot_emissions
  set booking_completed_at = p_now, appointment_id = p_appointment_id
  where id = emission.id;
end;
$$;

-- Appointment creation is not the delivery receipt. Closing the conversation here, after the exact
-- confirmation message is durable, lets an interrupted inbound retry finish the send instead of
-- being held by a prematurely closed `booked` conversation.
create or replace function public.finalize_booking_slot_confirmation(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_outbound_message_id uuid,
  p_appointment_id uuid,
  p_now timestamptz default now()
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare emission public.booking_slot_emissions%rowtype;
begin
  select * into emission from public.booking_slot_emissions slot_emission
  where slot_emission.tenant_id = p_expected_tenant
    and slot_emission.conversation_id = p_conversation_id
    and slot_emission.selection_inbound_message_id = p_inbound_message_id
  for update;
  if emission.id is null
    or emission.booking_completed_at is null
    or emission.appointment_id is distinct from p_appointment_id
    or not exists (
      select 1 from public.messages inbound_message
      where inbound_message.id = p_inbound_message_id
        and inbound_message.tenant_id = p_expected_tenant
        and inbound_message.conversation_id = p_conversation_id
        and inbound_message.direction = 'in'
        and inbound_message.author = 'lead'
    )
    or not exists (
      select 1 from public.messages outbound_message
      where outbound_message.id = p_outbound_message_id
        and outbound_message.tenant_id = p_expected_tenant
        and outbound_message.conversation_id = p_conversation_id
        and outbound_message.direction = 'out'
        and outbound_message.author = 'agent'
    ) then raise exception 'BOOKING_SLOT_CONFIRMATION_MISMATCH'; end if;
  if emission.booking_confirmed_at is not null then
    if emission.confirmation_outbound_message_id is distinct from p_outbound_message_id then
      raise exception 'BOOKING_SLOT_CONFIRMATION_REPLAY_MISMATCH';
    end if;
    return;
  end if;

  update public.booking_slot_emissions
  set booking_confirmed_at = p_now,
      confirmation_outbound_message_id = p_outbound_message_id
  where id = emission.id;
  update public.conversations
  set status = 'closed', status_reason = 'booked', status_changed_at = p_now, updated_at = now()
  where id = p_conversation_id and tenant_id = p_expected_tenant
    and contact_id = emission.contact_id and status in ('agent', 'nurture');
  if not found then raise exception 'BOOKING_SLOT_CONFIRMATION_STATE_INVALID'; end if;
end;
$$;

create or replace function public.renew_booking_intent_lease(
  p_intent_id uuid,
  p_claim_token uuid,
  p_expected_tenant uuid,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  update public.booking_intents intent
  set lease_until = p_now + interval '5 minutes', updated_at = now()
  where intent.id = p_intent_id
    and intent.tenant_id = p_expected_tenant
    and intent.status = 'creating'
    and intent.lease_token = p_claim_token
    and intent.lease_until >= p_now;
  return found;
end;
$$;

-- A slow fetch worker may finish after a newer proposal. First-writer equality and monotonic
-- proposed_at make the conversation row a CAS register; callers receive the winning proposal and
-- therefore never emit a stale response that failed to become current.
create or replace function public.record_booking_proposed_slots(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_proposal jsonb,
  p_proposed_at timestamptz
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare conversation_row public.conversations%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_proposed_at is null or jsonb_typeof(p_proposal) is distinct from 'object'
    or jsonb_typeof(p_proposal -> 'slots') is distinct from 'array'
    or jsonb_array_length(p_proposal -> 'slots') < 1
    or jsonb_array_length(p_proposal -> 'slots') > 5
    or exists (
      select 1 from jsonb_array_elements(p_proposal -> 'slots') slot
      where jsonb_typeof(slot) is distinct from 'object'
        or nullif(btrim(slot ->> 'id'), '') is null
        or nullif(btrim(slot ->> 'startAt'), '') is null
        or nullif(btrim(slot ->> 'endAt'), '') is null
        or nullif(btrim(slot ->> 'timezone'), '') is null
        or nullif(btrim(slot ->> 'display'), '') is null
    )
    or (
      select count(*) <> count(distinct slot ->> 'id')
      from jsonb_array_elements(p_proposal -> 'slots') slot
    )
    or nullif(p_proposal ->> 'calendarConnectionId', '') is null
    or nullif(p_proposal ->> 'proposedAt', '')::timestamptz is distinct from p_proposed_at then
    raise exception 'BOOKING_PROPOSAL_INPUT_INVALID';
  end if;
  select * into conversation_row from public.conversations conversation
  where conversation.id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.proposed_slots_at is null
    or conversation_row.proposed_slots_at < p_proposed_at then
    update public.conversations
    set proposed_slots = p_proposal, proposed_slots_at = p_proposed_at, updated_at = now()
    where id = p_conversation_id;
    return p_proposal;
  end if;
  return conversation_row.proposed_slots;
end;
$$;

revoke execute on function public.record_booking_slot_emission(uuid,uuid,uuid,uuid,text[],timestamptz,timestamptz),
  public.claim_booking_slot_selection(uuid,uuid,uuid,uuid,text,timestamptz),
  public.release_booking_slot_selection_for_reoffer(uuid,uuid,uuid,timestamptz),
  public.checkpoint_booking_slot_conflict(uuid,uuid,uuid,uuid,uuid,text,timestamptz),
  public.record_booking_slot_conflict_reoffer(uuid,uuid,uuid,jsonb,timestamptz,timestamptz),
  public.complete_booking_slot_selection(uuid,uuid,uuid,uuid,timestamptz),
  public.finalize_booking_slot_confirmation(uuid,uuid,uuid,uuid,uuid,timestamptz),
  public.renew_booking_intent_lease(uuid,uuid,uuid,timestamptz),
  public.record_booking_proposed_slots(uuid,uuid,jsonb,timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_booking_slot_emission(uuid,uuid,uuid,uuid,text[],timestamptz,timestamptz),
  public.claim_booking_slot_selection(uuid,uuid,uuid,uuid,text,timestamptz),
  public.release_booking_slot_selection_for_reoffer(uuid,uuid,uuid,timestamptz),
  public.checkpoint_booking_slot_conflict(uuid,uuid,uuid,uuid,uuid,text,timestamptz),
  public.record_booking_slot_conflict_reoffer(uuid,uuid,uuid,jsonb,timestamptz,timestamptz),
  public.complete_booking_slot_selection(uuid,uuid,uuid,uuid,timestamptz),
  public.finalize_booking_slot_confirmation(uuid,uuid,uuid,uuid,uuid,timestamptz),
  public.renew_booking_intent_lease(uuid,uuid,uuid,timestamptz),
  public.record_booking_proposed_slots(uuid,uuid,jsonb,timestamptz)
  to service_role;
