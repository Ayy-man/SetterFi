-- Ordinary messaging inbox recovery. Provider acknowledgement is allowed only after the verified
-- receipt exists, so Postgres must own exclusive retry custody after the request process exits.

alter table public.webhook_events
  add column if not exists next_attempt_at timestamptz,
  add column if not exists lease_token uuid,
  add column if not exists lease_expires_at timestamptz;

update public.webhook_events
set next_attempt_at = received_at
where next_attempt_at is null;

alter table public.webhook_events
  alter column next_attempt_at set default now(),
  alter column next_attempt_at set not null,
  add constraint webhook_events_attempts_nonnegative_chk check (attempts >= 0),
  add constraint webhook_events_lease_shape_chk check (
    (lease_token is null and lease_expires_at is null)
    or (lease_token is not null and lease_expires_at is not null)
  );

create index webhook_events_inbound_recovery_idx
  on public.webhook_events (next_attempt_at, received_at, id)
  where provider in ('ghl', 'meta')
    and tenant_id is not null
    and signature_verified
    and status in ('received', 'failed')
    and event_type not in ('INSTALL', 'UNINSTALL');

-- The model result is chosen before provider delivery and then becomes immutable for this lead
-- message. A receipt retry must reuse both its exact body and the original qualification CAS inputs;
-- rerunning a nondeterministic model under the same outbound idempotency key can never be safe.
create table public.inbound_engine_turns (
  inbound_message_id uuid primary key references public.messages(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  pre_turn_current_step text,
  pre_turn_current_step_asks integer not null check (pre_turn_current_step_asks between 0 and 3),
  result_payload jsonb not null check (jsonb_typeof(result_payload) = 'object'),
  result_hash text not null check (result_hash ~ '^[0-9a-f]{64}$'),
  delivery_persisted_at timestamptz,
  result_persisted_at timestamptz,
  outbound_message_id uuid unique references public.messages(id) on delete set null,
  unsent_refresh_authorized_at timestamptz,
  created_at timestamptz not null default now(),
  check ((delivery_persisted_at is null and outbound_message_id is null)
    or (delivery_persisted_at is not null and outbound_message_id is not null)),
  check (result_persisted_at is null or delivery_persisted_at is not null)
);

alter table public.inbound_engine_turns enable row level security;
alter table public.inbound_engine_turns force row level security;
revoke all on table public.inbound_engine_turns from public, anon, authenticated, service_role;

create or replace function public.load_inbound_engine_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid
)
returns table (
  result_payload jsonb, pre_turn_current_step text, pre_turn_current_step_asks integer,
  delivery_persisted boolean, result_persisted boolean
)
language plpgsql
security definer
set search_path = ''
volatile
as $$
begin
  perform app.assert_not_impersonating();
  -- A provider-accepted send may have committed its exact message before the request lost its
  -- response. Recover that checkpoint from the fenced attempt ledger so a later takeover cannot
  -- suppress the remaining post-send writes.
  update public.inbound_engine_turns turn
  set delivery_persisted_at = attempt.persisted_at,
    outbound_message_id = attempt.message_id
  from public.outbound_send_attempts attempt, public.messages inbound_message
  where turn.inbound_message_id = p_inbound_message_id
    and turn.tenant_id = p_expected_tenant
    and turn.conversation_id = p_conversation_id
    and turn.contact_id = p_contact_id
    and turn.delivery_persisted_at is null
    and inbound_message.id = turn.inbound_message_id
    and inbound_message.tenant_id = p_expected_tenant
    and attempt.tenant_id = p_expected_tenant
    and attempt.conversation_id = p_conversation_id
    and attempt.contact_id = p_contact_id
    and attempt.status = 'persisted'
    and attempt.message_id is not null
    and attempt.idempotency_key ~ '^inbound:[^:]+:.+'
    and substring(attempt.idempotency_key from '^inbound:[^:]+:(.*)$') = inbound_message.provider_message_id
    and attempt.body = (
      select command ->> 'body'
      from jsonb_array_elements(coalesce(turn.result_payload -> 'commands', '[]'::jsonb)) command
      where command ->> 'kind' = 'send'
      limit 1
    );
  -- A provider-readback `not_accepted` authorizes regeneration, but only after the exact unsent
  -- booking offer has expired. Already-persisted turns are immutable forever.
  delete from public.inbound_engine_turns turn
  where turn.inbound_message_id = p_inbound_message_id
    and turn.tenant_id = p_expected_tenant
    and turn.conversation_id = p_conversation_id
    and turn.contact_id = p_contact_id
    and turn.delivery_persisted_at is null
    and turn.unsent_refresh_authorized_at is not null
    and exists (
      select 1 from jsonb_array_elements(coalesce(turn.result_payload -> 'commands', '[]'::jsonb)) command
      where command ->> 'kind' = 'record_booking_slot_offer'
        and nullif(command ->> 'expiresAt', '')::timestamptz <= clock_timestamp()
    );
  return query
  select turn.result_payload, turn.pre_turn_current_step, turn.pre_turn_current_step_asks,
    turn.delivery_persisted_at is not null or exists (
      select 1 from public.outbound_send_attempts attempt, public.messages inbound_message
      where inbound_message.id = turn.inbound_message_id
        and attempt.tenant_id = turn.tenant_id
        and attempt.conversation_id = turn.conversation_id
        and attempt.contact_id = turn.contact_id
        and attempt.status in ('accepted', 'persisted')
        and substring(attempt.idempotency_key from '^inbound:[^:]+:(.*)$') = inbound_message.provider_message_id
        and attempt.body = (
          select command ->> 'body'
          from jsonb_array_elements(coalesce(turn.result_payload -> 'commands', '[]'::jsonb)) command
          where command ->> 'kind' = 'send' limit 1
        )
    ),
    turn.result_persisted_at is not null
  from public.inbound_engine_turns turn
  where turn.inbound_message_id = p_inbound_message_id
    and turn.tenant_id = p_expected_tenant
    and turn.conversation_id = p_conversation_id
    and turn.contact_id = p_contact_id;
end;
$$;

create or replace function public.record_inbound_engine_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid,
  p_pre_turn_current_step text,
  p_pre_turn_current_step_asks integer,
  p_result_payload jsonb
)
returns table (
  result_payload jsonb, pre_turn_current_step text, pre_turn_current_step_asks integer,
  delivery_persisted boolean, result_persisted boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if p_pre_turn_current_step_asks not between 0 and 3
    or jsonb_typeof(p_result_payload) is distinct from 'object' then
    raise exception 'INBOUND_ENGINE_TURN_INPUT_INVALID';
  end if;
  if not exists (
    select 1 from public.messages message
    join public.conversations conversation on conversation.id = message.conversation_id
    where message.id = p_inbound_message_id
      and message.tenant_id = p_expected_tenant
      and message.conversation_id = p_conversation_id
      and message.direction = 'in' and message.author = 'lead'
      and conversation.tenant_id = p_expected_tenant
      and conversation.contact_id = p_contact_id
  ) then raise exception 'INBOUND_ENGINE_TURN_SCOPE_MISMATCH'; end if;

  insert into public.inbound_engine_turns (
    inbound_message_id, tenant_id, conversation_id, contact_id,
    pre_turn_current_step, pre_turn_current_step_asks, result_payload, result_hash
  ) values (
    p_inbound_message_id, p_expected_tenant, p_conversation_id, p_contact_id,
    p_pre_turn_current_step, p_pre_turn_current_step_asks, p_result_payload,
    encode(extensions.digest(convert_to(p_result_payload::text, 'UTF8'), 'sha256'), 'hex')
  ) on conflict (inbound_message_id) do nothing;

  return query
  select turn.result_payload, turn.pre_turn_current_step, turn.pre_turn_current_step_asks,
    turn.delivery_persisted_at is not null,
    turn.result_persisted_at is not null
  from public.inbound_engine_turns turn
  where turn.inbound_message_id = p_inbound_message_id
    and turn.tenant_id = p_expected_tenant
    and turn.conversation_id = p_conversation_id
    and turn.contact_id = p_contact_id;
  if not found then raise exception 'INBOUND_ENGINE_TURN_REPLAY_MISMATCH'; end if;
end;
$$;

create or replace function public.mark_inbound_engine_turn_delivered(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid,
  p_outbound_message_id uuid,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare turn public.inbound_engine_turns%rowtype;
declare outbound public.messages%rowtype;
declare expected_body text;
begin
  perform app.assert_not_impersonating();
  select * into turn from public.inbound_engine_turns candidate
  where candidate.inbound_message_id = p_inbound_message_id
    and candidate.tenant_id = p_expected_tenant
    and candidate.conversation_id = p_conversation_id
    and candidate.contact_id = p_contact_id
  for update;
  select * into outbound from public.messages message
  where message.id = p_outbound_message_id
    and message.tenant_id = p_expected_tenant
    and message.conversation_id = p_conversation_id
    and message.direction = 'out' and message.author = 'agent';
  select command ->> 'body' into expected_body
  from jsonb_array_elements(coalesce(turn.result_payload -> 'commands', '[]'::jsonb)) command
  where command ->> 'kind' = 'send'
  limit 1;
  if turn.inbound_message_id is null or outbound.id is null
    or expected_body is null or outbound.body is distinct from expected_body then
    raise exception 'INBOUND_ENGINE_TURN_DELIVERY_MISMATCH';
  end if;
  if turn.delivery_persisted_at is not null then
    if turn.outbound_message_id is distinct from p_outbound_message_id then
      raise exception 'INBOUND_ENGINE_TURN_DELIVERY_REPLAY_MISMATCH';
    end if;
    return false;
  end if;
  update public.inbound_engine_turns
  set delivery_persisted_at = p_now, outbound_message_id = p_outbound_message_id
  where inbound_message_id = p_inbound_message_id;
  return true;
end;
$$;

create or replace function public.complete_inbound_engine_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_inbound_message_id uuid,
  p_outbound_message_id uuid,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare turn public.inbound_engine_turns%rowtype;
declare outbound public.messages%rowtype;
declare expected_body text;
begin
  perform app.assert_not_impersonating();
  select * into turn from public.inbound_engine_turns candidate
  where candidate.inbound_message_id = p_inbound_message_id
    and candidate.tenant_id = p_expected_tenant
    and candidate.conversation_id = p_conversation_id
    and candidate.contact_id = p_contact_id
  for update;
  select * into outbound from public.messages message
  where message.id = p_outbound_message_id
    and message.tenant_id = p_expected_tenant
    and message.conversation_id = p_conversation_id
    and message.direction = 'out' and message.author = 'agent';
  select command ->> 'body' into expected_body
  from jsonb_array_elements(coalesce(turn.result_payload -> 'commands', '[]'::jsonb)) command
  where command ->> 'kind' = 'send';
  if turn.inbound_message_id is null or outbound.id is null
    or expected_body is null or outbound.body is distinct from expected_body then
    raise exception 'INBOUND_ENGINE_TURN_COMPLETION_MISMATCH';
  end if;
  if turn.result_persisted_at is not null then
    if turn.outbound_message_id is distinct from p_outbound_message_id then
      raise exception 'INBOUND_ENGINE_TURN_COMPLETION_REPLAY_MISMATCH';
    end if;
    return false;
  end if;
  if turn.delivery_persisted_at is null
    or turn.outbound_message_id is distinct from p_outbound_message_id then
    raise exception 'INBOUND_ENGINE_TURN_NOT_DELIVERED';
  end if;
  update public.inbound_engine_turns
  set result_persisted_at = p_now
  where inbound_message_id = p_inbound_message_id;
  return true;
end;
$$;

create or replace function public.claim_inbound_webhook_receipts(
  p_limit int,
  p_lease_seconds int,
  p_now timestamptz,
  p_receipt_id uuid default null
)
returns table (
  receipt_id uuid,
  provider public.webhook_provider,
  provider_event_id text,
  tenant_id uuid,
  event_type text,
  payload jsonb,
  status public.webhook_status,
  attempt_number int,
  lease_token uuid,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if p_limit not between 1 and 100 or p_lease_seconds not between 30 and 900
    or p_now is null then
    raise exception 'INBOUND_RECEIPT_CLAIM_INVALID';
  end if;

  return query
  with candidates as (
    select event.id
    from public.webhook_events event
    where event.provider in ('ghl', 'meta')
      and event.tenant_id is not null
      and event.signature_verified
      and event.status in ('received', 'failed')
      and event.event_type not in ('INSTALL', 'UNINSTALL')
      and event.attempts < 8
      and event.next_attempt_at <= p_now
      and (event.lease_token is null or event.lease_expires_at <= p_now)
      and (p_receipt_id is null or event.id = p_receipt_id)
    order by event.next_attempt_at, event.received_at, event.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.webhook_events event
    set attempts = event.attempts + 1,
        lease_token = gen_random_uuid(),
        lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
        error = null
    from candidates
    where event.id = candidates.id
    returning event.*
  )
  select claimed.id, claimed.provider, claimed.provider_event_id, claimed.tenant_id,
    claimed.event_type, claimed.payload, claimed.status, claimed.attempts,
    claimed.lease_token, claimed.lease_expires_at
  from claimed
  order by claimed.next_attempt_at, claimed.received_at, claimed.id;
end;
$$;

create or replace function public.finish_inbound_webhook_receipt(
  p_receipt_id uuid,
  p_lease_token uuid,
  p_attempt_number int,
  p_status public.webhook_status,
  p_error text default null,
  p_retry_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected int;
begin
  perform app.assert_not_impersonating();
  if p_receipt_id is null or p_lease_token is null or p_attempt_number < 1
    or p_status not in ('processed', 'skipped', 'failed') then
    raise exception 'INBOUND_RECEIPT_FINISH_INVALID';
  end if;
  if p_status = 'failed' and p_retry_at is null then
    raise exception 'INBOUND_RECEIPT_RETRY_REQUIRED';
  end if;
  if p_status <> 'failed' and p_retry_at is not null then
    raise exception 'INBOUND_RECEIPT_RETRY_FORBIDDEN';
  end if;

  update public.webhook_events
  set status = p_status,
      error = case when p_status = 'failed' then left(coalesce(p_error, 'INBOUND_PROCESSING_FAILED'), 240) else null end,
      processed_at = case when p_status in ('processed', 'skipped') then now() else null end,
      next_attempt_at = coalesce(p_retry_at, next_attempt_at),
      lease_token = null,
      lease_expires_at = null
  where id = p_receipt_id
    and lease_token = p_lease_token
    and attempts = p_attempt_number;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.defer_inbound_webhook_receipt(
  p_receipt_id uuid,
  p_lease_token uuid,
  p_attempt_number int,
  p_error text,
  p_retry_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare affected int;
begin
  perform app.assert_not_impersonating();
  if p_receipt_id is null or p_lease_token is null or p_attempt_number < 1
    or nullif(btrim(p_error), '') is null or p_retry_at is null then
    raise exception 'INBOUND_RECEIPT_DEFER_INVALID';
  end if;
  update public.webhook_events
  set status = 'failed',
      error = left(p_error, 240),
      processed_at = null,
      next_attempt_at = p_retry_at,
      attempts = greatest(attempts - 1, 0),
      lease_token = null,
      lease_expires_at = null
  where id = p_receipt_id
    and lease_token = p_lease_token
    and attempts = p_attempt_number;
  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

create or replace function public.load_inbound_conversation_history(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_limit int
)
returns table (role text, content text)
language plpgsql
security definer
set search_path = ''
stable
as $$
declare
  conversation_tenant uuid;
  inbound_row public.messages%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_limit not between 1 and 40 then raise exception 'INBOUND_HISTORY_LIMIT_INVALID'; end if;
  select conversation.tenant_id into conversation_tenant
  from public.conversations conversation
  where conversation.id = p_conversation_id;
  if conversation_tenant is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_tenant, 'conversation');

  select * into inbound_row
  from public.messages message
  where message.id = p_inbound_message_id
    and message.conversation_id = p_conversation_id
    and message.direction = 'in'
    and message.author = 'lead';
  if inbound_row.id is null then raise exception 'LEAD_INBOUND_MESSAGE_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, inbound_row.tenant_id, 'inbound_message');

  return query
  select history.role, history.content
  from (
    select case when message.direction = 'in' then 'user' else 'assistant' end as role,
      message.body as content, message.created_at, message.id
    from public.messages message
    where message.tenant_id = p_expected_tenant
      and message.conversation_id = p_conversation_id
      and message.direction in ('in', 'out')
      and (message.created_at, message.id) < (inbound_row.created_at, inbound_row.id)
    order by message.created_at desc, message.id desc
    limit p_limit
  ) history
  order by history.created_at, history.id;
end;
$$;

revoke execute on function public.claim_inbound_webhook_receipts(int,int,timestamptz,uuid)
  from public, anon, authenticated;
revoke execute on function public.finish_inbound_webhook_receipt(uuid,uuid,int,public.webhook_status,text,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.defer_inbound_webhook_receipt(uuid,uuid,int,text,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.load_inbound_conversation_history(uuid,uuid,uuid,int)
  from public, anon, authenticated;
revoke execute on function public.load_inbound_engine_turn(uuid,uuid,uuid,uuid),
  public.record_inbound_engine_turn(uuid,uuid,uuid,uuid,text,integer,jsonb),
  public.mark_inbound_engine_turn_delivered(uuid,uuid,uuid,uuid,uuid,timestamptz),
  public.complete_inbound_engine_turn(uuid,uuid,uuid,uuid,uuid,timestamptz)
  from public, anon, authenticated;
grant execute on function public.claim_inbound_webhook_receipts(int,int,timestamptz,uuid)
  to service_role;
grant execute on function public.finish_inbound_webhook_receipt(uuid,uuid,int,public.webhook_status,text,timestamptz)
  to service_role;
grant execute on function public.defer_inbound_webhook_receipt(uuid,uuid,int,text,timestamptz)
  to service_role;
grant execute on function public.load_inbound_conversation_history(uuid,uuid,uuid,int)
  to service_role;
grant execute on function public.load_inbound_engine_turn(uuid,uuid,uuid,uuid),
  public.record_inbound_engine_turn(uuid,uuid,uuid,uuid,text,integer,jsonb),
  public.mark_inbound_engine_turn_delivered(uuid,uuid,uuid,uuid,uuid,timestamptz),
  public.complete_inbound_engine_turn(uuid,uuid,uuid,uuid,uuid,timestamptz)
  to service_role;
