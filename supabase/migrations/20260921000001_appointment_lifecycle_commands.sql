-- Coach lifecycle requests are durable intents. The route records this row before contacting the
-- calendar, then a separate confirmation RPC makes the local change only after provider evidence.
set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('appointment.cancel.requested', 'human', 'tenant', true, true, 'Cancellation request logged', 'Cancellation request recorded in the audit log'),
  ('appointment.cancel.confirmed', 'human', 'tenant', true, true, 'Cancellation confirmed', 'Calendar-confirmed cancellation recorded in the audit log'),
  ('appointment.cancel.failed', 'human', 'tenant', true, true, 'Cancellation failure logged', 'Calendar cancellation failure recorded in the audit log'),
  ('appointment.reschedule.requested', 'human', 'tenant', true, true, 'Reschedule request logged', 'Reschedule request recorded in the audit log'),
  ('appointment.reschedule.confirmed', 'human', 'tenant', true, true, 'Reschedule confirmed', 'Calendar-confirmed reschedule recorded in the audit log'),
  ('appointment.reschedule.failed', 'human', 'tenant', true, true, 'Reschedule failure logged', 'Calendar reschedule failure recorded in the audit log')
on conflict (key) do nothing;

create table public.appointment_lifecycle_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  action text not null check (action in ('cancel', 'reschedule')),
  state text not null check (state in ('pending', 'confirmed', 'failed')) default 'pending',
  reason text not null check (nullif(btrim(reason), '') is not null),
  idempotency_key text not null check (char_length(btrim(idempotency_key)) between 1 and 128),
  requested_start_at timestamptz,
  requested_end_at timestamptz,
  actor_id uuid not null references public.users(id) on delete restrict,
  request_audit_id bigint not null references public.audit_log(id) on delete restrict,
  confirmation_audit_id bigint references public.audit_log(id) on delete restrict,
  failure_audit_id bigint references public.audit_log(id) on delete restrict,
  provider_confirmed_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  constraint appointment_lifecycle_command_shape_chk check (
    (action = 'cancel' and requested_start_at is null and requested_end_at is null)
    or (action = 'reschedule' and requested_start_at is not null and requested_end_at is not null and requested_end_at > requested_start_at)
  ),
  constraint appointment_lifecycle_command_state_chk check (
    (state = 'pending' and provider_confirmed_at is null and failure_code is null and confirmation_audit_id is null and failure_audit_id is null)
    or (state = 'confirmed' and provider_confirmed_at is not null and failure_code is null and confirmation_audit_id is not null and failure_audit_id is null)
    or (state = 'failed' and provider_confirmed_at is null and nullif(btrim(failure_code), '') is not null and confirmation_audit_id is null and failure_audit_id is not null)
  )
);
create index appointment_lifecycle_commands_appointment_created_idx
  on public.appointment_lifecycle_commands (appointment_id, created_at desc);

alter table public.appointment_lifecycle_commands enable row level security;
alter table public.appointment_lifecycle_commands force row level security;
revoke all on public.appointment_lifecycle_commands from public, anon, authenticated, service_role;

create function app.assert_appointment_lifecycle_coach(p_actor_id uuid, p_expected_tenant uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_actor_id is null or p_expected_tenant is null then
    raise exception 'APPOINTMENT_LIFECYCLE_SCOPE_REQUIRED';
  end if;
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role <> 'coach'
    or actor_row.tenant_id is distinct from p_expected_tenant then
    raise exception 'APPOINTMENT_LIFECYCLE_COACH_FORBIDDEN';
  end if;
end;
$$;

create function public.record_appointment_lifecycle_command(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text,
  p_requested_start_at timestamptz default null,
  p_requested_end_at timestamptz default null
)
returns table (command_id uuid, tenant_id uuid, appointment_id uuid, action text, state text, audit_id bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare appointment_row public.appointments%rowtype; existing public.appointment_lifecycle_commands%rowtype;
  command_row public.appointment_lifecycle_commands%rowtype; command_id uuid := gen_random_uuid(); logged_id bigint; audit_action text;
  normalized_reason text := nullif(btrim(p_reason), ''); normalized_key text := nullif(btrim(p_idempotency_key), '');
begin
  perform app.assert_appointment_lifecycle_coach(p_actor_id, p_expected_tenant);
  if p_action not in ('cancel', 'reschedule') or normalized_reason is null or normalized_key is null
    or char_length(normalized_key) > 128
    or (p_action = 'cancel' and (p_requested_start_at is not null or p_requested_end_at is not null))
    or (p_action = 'reschedule' and (p_requested_start_at is null or p_requested_end_at is null or p_requested_end_at <= p_requested_start_at)) then
    raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_INVALID';
  end if;

  select * into existing from public.appointment_lifecycle_commands command
  where command.tenant_id = p_expected_tenant and command.idempotency_key = normalized_key for update;
  if existing.id is not null then
    if existing.appointment_id <> p_appointment_id or existing.actor_id <> p_actor_id or existing.action <> p_action
      or existing.reason <> normalized_reason or existing.requested_start_at is distinct from p_requested_start_at
      or existing.requested_end_at is distinct from p_requested_end_at then
      raise exception 'APPOINTMENT_LIFECYCLE_IDEMPOTENCY_CONFLICT';
    end if;
    return query select existing.id, existing.tenant_id, existing.appointment_id, existing.action, existing.state, existing.request_audit_id;
    return;
  end if;

  select * into appointment_row from public.appointments appointment where appointment.id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment_lifecycle_command');
  if appointment_row.status not in ('scheduled', 'confirmed') then raise exception 'APPOINTMENT_LIFECYCLE_STATUS_FORBIDDEN'; end if;

  audit_action := case p_action when 'cancel' then 'appointment.cancel.requested' else 'appointment.reschedule.requested' end;
  logged_id := app.write_audit_row(audit_action, p_actor_id, p_expected_tenant, 'appointment', appointment_row.id::text, normalized_reason,
    jsonb_strip_nulls(jsonb_build_object('command_id', command_id, 'state', 'pending', 'requested_start_at', p_requested_start_at, 'requested_end_at', p_requested_end_at)), null, null, 'api');
  insert into public.appointment_lifecycle_commands (
    id, tenant_id, appointment_id, action, reason, idempotency_key, requested_start_at, requested_end_at, actor_id, request_audit_id
  ) values (
    command_id, p_expected_tenant, appointment_row.id, p_action, normalized_reason, normalized_key, p_requested_start_at, p_requested_end_at, p_actor_id, logged_id
  ) returning * into command_row;
  return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, 'pending'::text, logged_id;
end;
$$;

create function public.confirm_appointment_lifecycle_command(
  p_expected_tenant uuid, p_command_id uuid, p_actor_id uuid
)
returns table (command_id uuid, tenant_id uuid, appointment_id uuid, action text, state text, audit_id bigint, outbox_event_id uuid)
language plpgsql volatile security definer set search_path = '' as $$
declare command_row public.appointment_lifecycle_commands%rowtype; appointment_row public.appointments%rowtype;
  logged_id bigint; local_audit_id bigint; persisted_event_id uuid; audit_action text;
begin
  perform app.assert_appointment_lifecycle_coach(p_actor_id, p_expected_tenant);
  select * into command_row from public.appointment_lifecycle_commands command where command.id = p_command_id for update;
  if command_row.id is null then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, command_row.tenant_id, 'appointment_lifecycle_command');
  if command_row.actor_id <> p_actor_id then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_ACTOR_FORBIDDEN'; end if;
  if command_row.state = 'failed' then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_FAILED'; end if;
  if command_row.state = 'confirmed' then
    select event.id into persisted_event_id from public.booking_lifecycle_outbox event
    where event.appointment_id = command_row.appointment_id and event.event_key = 'appointment.canceled';
    return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, command_row.state, command_row.confirmation_audit_id, persisted_event_id;
    return;
  end if;

  select * into appointment_row from public.appointments appointment where appointment.id = command_row.appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment_lifecycle_confirmation');
  audit_action := case command_row.action when 'cancel' then 'appointment.cancel.confirmed' else 'appointment.reschedule.confirmed' end;

  if command_row.action = 'cancel' and appointment_row.status <> 'canceled' then
    select audit_id, outbox_event_id into local_audit_id, persisted_event_id
    from public.cancel_appointment_with_outbox(p_expected_tenant, appointment_row.id, 'coach', p_actor_id);
  elsif command_row.action = 'reschedule' and (appointment_row.start_at is distinct from command_row.requested_start_at or appointment_row.end_at is distinct from command_row.requested_end_at) then
    select public.reschedule_appointment(p_expected_tenant, appointment_row.id, command_row.requested_start_at, command_row.requested_end_at, 'coach', p_actor_id) into local_audit_id;
  elsif command_row.action = 'cancel' then
    select event.id into persisted_event_id from public.booking_lifecycle_outbox event
    where event.appointment_id = appointment_row.id and event.event_key = 'appointment.canceled';
  end if;

  logged_id := app.write_audit_row(audit_action, p_actor_id, p_expected_tenant, 'appointment', appointment_row.id::text, command_row.reason,
    jsonb_build_object('command_id', command_row.id, 'state', 'confirmed', 'provider_confirmation', case when appointment_row.status = 'canceled' or (appointment_row.start_at = command_row.requested_start_at and appointment_row.end_at = command_row.requested_end_at) then 'authoritative_readback' else 'provider_acknowledged' end), null, null, 'api');
  update public.appointment_lifecycle_commands set state = 'confirmed', provider_confirmed_at = now(), confirmation_audit_id = logged_id, updated_at = now() where id = command_row.id;
  return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, 'confirmed'::text, logged_id, persisted_event_id;
end;
$$;

create function public.fail_appointment_lifecycle_command(
  p_expected_tenant uuid, p_command_id uuid, p_actor_id uuid, p_failure_code text
)
returns table (command_id uuid, tenant_id uuid, appointment_id uuid, action text, state text, audit_id bigint)
language plpgsql volatile security definer set search_path = '' as $$
declare command_row public.appointment_lifecycle_commands%rowtype; logged_id bigint; audit_action text;
  normalized_code text := nullif(btrim(p_failure_code), '');
begin
  perform app.assert_appointment_lifecycle_coach(p_actor_id, p_expected_tenant);
  if normalized_code is null or char_length(normalized_code) > 120 then raise exception 'APPOINTMENT_LIFECYCLE_FAILURE_INVALID'; end if;
  select * into command_row from public.appointment_lifecycle_commands command where command.id = p_command_id for update;
  if command_row.id is null then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, command_row.tenant_id, 'appointment_lifecycle_command');
  if command_row.actor_id <> p_actor_id then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_ACTOR_FORBIDDEN'; end if;
  if command_row.state = 'confirmed' then raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_ALREADY_CONFIRMED'; end if;
  if command_row.state = 'failed' then
    return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, command_row.state, command_row.failure_audit_id;
    return;
  end if;
  audit_action := case command_row.action when 'cancel' then 'appointment.cancel.failed' else 'appointment.reschedule.failed' end;
  logged_id := app.write_audit_row(audit_action, p_actor_id, p_expected_tenant, 'appointment', command_row.appointment_id::text, command_row.reason,
    jsonb_build_object('command_id', command_row.id, 'state', 'failed', 'failure_code', normalized_code), null, null, 'api');
  update public.appointment_lifecycle_commands set state = 'failed', failure_code = normalized_code, failure_audit_id = logged_id, updated_at = now() where id = command_row.id;
  return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, 'failed'::text, logged_id;
end;
$$;

revoke all on function app.assert_appointment_lifecycle_coach(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.record_appointment_lifecycle_command(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz), public.confirm_appointment_lifecycle_command(uuid,uuid,uuid), public.fail_appointment_lifecycle_command(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.record_appointment_lifecycle_command(uuid,uuid,uuid,text,text,text,timestamptz,timestamptz), public.confirm_appointment_lifecycle_command(uuid,uuid,uuid), public.fail_appointment_lifecycle_command(uuid,uuid,uuid,text) to service_role;
