-- A coach command must be bound to the appointment version the coach actually reviewed. The
-- provider call happens after the durable request is recorded, so confirmation repeats the same
-- comparison and refuses to overwrite a webhook or another tab that won the race.
set search_path = public, extensions;

alter table public.appointment_lifecycle_commands
  add column expected_appointment_updated_at timestamptz;

drop function public.record_appointment_lifecycle_command(
  uuid, uuid, uuid, text, text, text, timestamptz, timestamptz
);

create function public.record_appointment_lifecycle_command(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_actor_id uuid,
  p_action text,
  p_reason text,
  p_idempotency_key text,
  p_expected_appointment_updated_at timestamptz,
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
    or char_length(normalized_key) > 128 or p_expected_appointment_updated_at is null
    or (p_action = 'cancel' and (p_requested_start_at is not null or p_requested_end_at is not null))
    or (p_action = 'reschedule' and (p_requested_start_at is null or p_requested_end_at is null or p_requested_end_at <= p_requested_start_at)) then
    raise exception 'APPOINTMENT_LIFECYCLE_COMMAND_INVALID';
  end if;

  select * into existing from public.appointment_lifecycle_commands command
  where command.tenant_id = p_expected_tenant and command.idempotency_key = normalized_key for update;
  if existing.id is not null then
    if existing.appointment_id <> p_appointment_id or existing.actor_id <> p_actor_id or existing.action <> p_action
      or existing.reason <> normalized_reason
      or existing.expected_appointment_updated_at is distinct from p_expected_appointment_updated_at
      or existing.requested_start_at is distinct from p_requested_start_at
      or existing.requested_end_at is distinct from p_requested_end_at then
      raise exception 'APPOINTMENT_LIFECYCLE_IDEMPOTENCY_CONFLICT';
    end if;
    return query select existing.id, existing.tenant_id, existing.appointment_id, existing.action, existing.state, existing.request_audit_id;
    return;
  end if;

  select * into appointment_row from public.appointments appointment where appointment.id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment_lifecycle_command');
  if appointment_row.updated_at is distinct from p_expected_appointment_updated_at then
    raise exception 'APPOINTMENT_LIFECYCLE_STALE_VERSION';
  end if;
  if appointment_row.status not in ('scheduled', 'confirmed') then raise exception 'APPOINTMENT_LIFECYCLE_STATUS_FORBIDDEN'; end if;

  audit_action := case p_action when 'cancel' then 'appointment.cancel.requested' else 'appointment.reschedule.requested' end;
  logged_id := app.write_audit_row(audit_action, p_actor_id, p_expected_tenant, 'appointment', appointment_row.id::text, normalized_reason,
    jsonb_strip_nulls(jsonb_build_object(
      'command_id', command_id,
      'state', 'pending',
      'expected_appointment_updated_at', p_expected_appointment_updated_at,
      'requested_start_at', p_requested_start_at,
      'requested_end_at', p_requested_end_at
    )), null, null, 'api');
  insert into public.appointment_lifecycle_commands (
    id, tenant_id, appointment_id, action, reason, idempotency_key,
    expected_appointment_updated_at, requested_start_at, requested_end_at, actor_id, request_audit_id
  ) values (
    command_id, p_expected_tenant, appointment_row.id, p_action, normalized_reason, normalized_key,
    p_expected_appointment_updated_at, p_requested_start_at, p_requested_end_at, p_actor_id, logged_id
  ) returning * into command_row;
  return query select command_row.id, command_row.tenant_id, command_row.appointment_id, command_row.action, 'pending'::text, logged_id;
end;
$$;

create or replace function public.confirm_appointment_lifecycle_command(
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
  if command_row.expected_appointment_updated_at is not null
    and appointment_row.updated_at is distinct from command_row.expected_appointment_updated_at then
    raise exception 'APPOINTMENT_LIFECYCLE_STALE_VERSION';
  end if;
  audit_action := case command_row.action when 'cancel' then 'appointment.cancel.confirmed' else 'appointment.reschedule.confirmed' end;

  if command_row.action = 'cancel' and appointment_row.status <> 'canceled' then
    select result.audit_id, result.outbox_event_id into local_audit_id, persisted_event_id
    from public.cancel_appointment_with_outbox(
      p_expected_tenant, appointment_row.id, 'coach', p_actor_id
    ) as result;
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

revoke execute on function public.record_appointment_lifecycle_command(
  uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_appointment_lifecycle_command(
  uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, timestamptz
) to service_role;
