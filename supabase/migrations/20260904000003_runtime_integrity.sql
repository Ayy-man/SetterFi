-- Keep state transitions and their evidence checks in the same database lock scope.

create or replace function public.persist_inbound_message(
  p_expected_tenant uuid,
  p_provider public.channel_provider,
  p_channel public.messaging_channel,
  p_provider_identity_id text,
  p_normalized_phone text,
  p_normalized_email text,
  p_provider_message_id text,
  p_body text,
  p_contact_name text,
  p_provider_window_observed_at timestamptz,
  p_provider_window_expires_at timestamptz,
  p_provider_window_source text
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  message_inserted boolean,
  disclosure_pending boolean,
  provider_window_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  identity_row public.contact_identities%rowtype;
  conversation_row public.conversations%rowtype;
  inbound_row public.messages%rowtype;
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
  if p_provider = 'meta_direct' and (
    p_provider_window_observed_at is null or p_provider_window_expires_at is null
    or p_provider_window_expires_at <= p_provider_window_observed_at
    or p_provider_window_source not in ('provider', 'derived_24h')
  ) then
    raise exception 'META_PROVIDER_WINDOW_REQUIRED';
  end if;
  if p_provider <> 'meta_direct' and (
    p_provider_window_observed_at is not null or p_provider_window_expires_at is not null
    or p_provider_window_source is not null
  ) then
    raise exception 'DURABLE_PROVIDER_WINDOW_FORBIDDEN';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':' || p_provider::text || ':' || p_channel::text || ':' ||
      btrim(p_provider_identity_id), 0
  ));

  select ci.* into identity_row
  from public.contact_identities ci
  where ci.tenant_id = p_expected_tenant
    and ci.provider = p_provider
    and ci.channel = p_channel
    and ci.provider_identity_id = btrim(p_provider_identity_id)
  for update;

  if identity_row.id is null then
    insert into public.contacts (tenant_id, last_channel, name, last_seen_at)
    values (p_expected_tenant, p_channel, nullif(btrim(p_contact_name), ''), now())
    returning * into contact_row;

    insert into public.contact_identities (
      tenant_id, contact_id, provider, channel, provider_identity_id,
      normalized_phone, normalized_email, consent_state, consent_source,
      consent_captured_at, consent_expires_at
    ) values (
      p_expected_tenant, contact_row.id, p_provider, p_channel, btrim(p_provider_identity_id),
      nullif(btrim(p_normalized_phone), ''), lower(nullif(btrim(p_normalized_email), '')),
      'conversation', 'inbound_message', now(), now() + interval '90 days'
    ) returning * into identity_row;
  else
    select c.* into contact_row from public.contacts c
    where c.id = identity_row.contact_id for update;
    perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
    if contact_row.merged_into_contact_id is not null then
      raise exception 'INBOUND_IDENTITY_POINTS_TO_MERGED_CONTACT';
    end if;
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
      tenant_id, contact_id, channel, disclosure_pending, last_message_at,
      provider_window_expires_at
    ) values (
      p_expected_tenant, contact_row.id, p_channel, true, now(),
      case when p_provider = 'meta_direct' then p_provider_window_expires_at else null end
    ) returning * into conversation_row;
    new_thread := true;
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider, provider_message_id
  ) values (
    p_expected_tenant, conversation_row.id, 'in', 'lead', p_body,
    p_provider::text, btrim(p_provider_message_id)
  )
  on conflict (tenant_id, provider, provider_message_id)
    where provider_message_id is not null
  do nothing
  returning * into inbound_row;

  if inbound_row.id is null then
    select m.* into inbound_row
    from public.messages m
    where m.tenant_id = p_expected_tenant
      and m.provider = p_provider::text
      and m.provider_message_id = btrim(p_provider_message_id);
    if inbound_row.id is null then raise exception 'INBOUND_REPLAY_NOT_FOUND'; end if;
    if inbound_row.conversation_id <> conversation_row.id then
      raise exception 'INBOUND_REPLAY_IDENTITY_MISMATCH';
    end if;
  else
    inserted_now := true;
    update public.contact_identities as target
    set normalized_phone = coalesce(nullif(btrim(p_normalized_phone), ''), normalized_phone),
        normalized_email = coalesce(lower(nullif(btrim(p_normalized_email), '')), normalized_email),
        provider_window_expires_at = case
          when p_provider = 'meta_direct' then p_provider_window_expires_at
          else target.provider_window_expires_at
        end
    where id = identity_row.id
    returning * into identity_row;

    update public.contacts
    set last_channel = p_channel,
        name = coalesce(name, nullif(btrim(p_contact_name), '')),
        last_seen_at = coalesce(p_provider_window_observed_at, now()),
        updated_at = now()
    where id = contact_row.id
    returning * into contact_row;

    update public.conversations as target
    set last_message_at = coalesce(p_provider_window_observed_at, now()),
        cadence_anchor_at = coalesce(p_provider_window_observed_at, now()),
        cadence_anchor_message_id = inbound_row.id,
        provider_window_expires_at = case
          when p_provider = 'meta_direct' then p_provider_window_expires_at
          else target.provider_window_expires_at
        end,
        status = case when status in ('nurture', 'closed') then 'agent' else status end,
        status_reason = case when status in ('nurture', 'closed') then null else status_reason end,
        status_changed_at = case
          when status in ('nurture', 'closed') then coalesce(p_provider_window_observed_at, now())
          else status_changed_at
        end
    where id = conversation_row.id
    returning * into conversation_row;
  end if;

  return query select contact_row.id, conversation_row.id, inbound_row.id, inserted_now,
    case when new_thread then true else conversation_row.disclosure_pending end,
    conversation_row.provider_window_expires_at;
end;
$$;

create or replace function public.enter_needs_human_with_message(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_message_id uuid,
  p_reason public.convo_status_reason
)
returns table (message_id uuid, audit_id bigint, transitioned boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  message_row public.messages%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_reason not in ('lead_requested_human', 'no_match_threshold', 'output_check_failed',
                      'tripwire_repeated', 'tripwire_escalate') then
    raise exception 'NEEDS_HUMAN_REASON_INVALID:%', p_reason;
  end if;

  select * into conversation_row
  from public.conversations
  where id = p_conversation_id
  for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(
    p_expected_tenant, conversation_row.tenant_id, 'conversation'
  );

  select * into message_row
  from public.messages
  where id = p_message_id and conversation_id = p_conversation_id;
  if message_row.id is null then raise exception 'NEEDS_HUMAN_MESSAGE_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, message_row.tenant_id, 'message');
  if message_row.direction <> 'out' or message_row.author <> 'agent'
    or message_row.provider_message_id is null then
    raise exception 'NEEDS_HUMAN_MESSAGE_INVALID';
  end if;

  if conversation_row.status = 'needs_human' and conversation_row.status_reason = p_reason then
    return query select p_message_id, null::bigint, false;
    return;
  end if;
  if conversation_row.status <> 'agent' then
    raise exception 'CONVERSATION_NOT_AGENT:%', conversation_row.status;
  end if;

  update public.conversations
  set status = 'needs_human', status_reason = p_reason, status_changed_at = now(),
      needs_human_at = now(), unread_by_coach = true,
      last_message_at = greatest(coalesce(last_message_at, message_row.created_at), message_row.created_at)
  where id = p_conversation_id;

  update public.followups
  set status = 'canceled', canceled_reason = 'escalated'
  where conversation_id = p_conversation_id and status = 'scheduled';

  logged_id := app.write_audit_row(
    'conversation.escalated', null, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('status_reason', p_reason, 'message_id', p_message_id)
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

  return query select p_message_id, logged_id, true;
end;
$$;

revoke execute on function public.enter_needs_human_with_message(
  uuid, uuid, uuid, public.convo_status_reason
) from public, anon, authenticated;
grant execute on function public.enter_needs_human_with_message(
  uuid, uuid, uuid, public.convo_status_reason
) to service_role;

create or replace function public.clear_identity_suppression(
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
  contact_row public.contacts%rowtype;
  identity_row public.contact_identities%rowtype;
  removed_count int;
  still_suppressed boolean;
begin
  perform app.assert_not_impersonating();
  if not p_provider_confirmed then raise exception 'SUPPRESSION_CLEAR_PROVIDER_UNCONFIRMED'; end if;
  if p_identifier_hash !~ '^[0-9a-f]{64}$' then raise exception 'SUPPRESSION_HASH_INVALID'; end if;
  select * into contact_row from public.contacts
  where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  select * into identity_row from public.contact_identities
  where id = p_identity_id and contact_id = p_contact_id for update;
  if identity_row.id is null then raise exception 'CONTACT_IDENTITY_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, identity_row.tenant_id, 'identity');

  delete from public.suppression_entries
  where tenant_id = p_expected_tenant and contact_id = p_contact_id
    and channel = identity_row.channel and identifier_hash = p_identifier_hash;
  get diagnostics removed_count = row_count;
  if removed_count = 0 then raise exception 'SUPPRESSION_NOT_FOUND'; end if;

  select exists (
    select 1 from public.suppression_entries
    where tenant_id = p_expected_tenant and contact_id = p_contact_id
  ) into still_suppressed;

  update public.contact_identities
  set consent_state = 'opted_in', consent_source = 'opt_back_in',
      consent_captured_at = now(), consent_expires_at = now() + interval '90 days'
  where id = p_identity_id;
  update public.contacts
  set opted_out = still_suppressed,
      stop_confirmation_key = case when still_suppressed then stop_confirmation_key else null end,
      stop_confirmation_reserved_at = case
        when still_suppressed then stop_confirmation_reserved_at else null end,
      stop_confirmation_sent_at = case
        when still_suppressed then stop_confirmation_sent_at else null end
  where id = p_contact_id and tenant_id = p_expected_tenant;
  update public.conversations
  set status = 'agent', status_reason = null, status_changed_at = now()
  where tenant_id = p_expected_tenant and contact_id = p_contact_id
    and channel = identity_row.channel and status = 'opted_out';

  return app.write_audit_row(
    'suppression.clear.provider', null, p_expected_tenant, 'contact_identity',
    p_identity_id::text, null, jsonb_build_object('channel', identity_row.channel)
  );
end;
$$;

revoke execute on function public.clear_identity_suppression(
  uuid, uuid, uuid, text, boolean
) from public, anon, authenticated;
grant execute on function public.clear_identity_suppression(
  uuid, uuid, uuid, text, boolean
) to service_role;

-- Some deployed phase-11 bases never received this superseded eight-argument signature. Keep
-- the replacement strict where it exists without making the entire forward migration depend on a
-- historical overload that may already have been removed.
drop function if exists public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, text, uuid, text, uuid, text
);

create function public.set_contact_pipeline_stage(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_expected_stage public.pipeline_stage,
  p_stage public.pipeline_stage,
  p_set_by text,
  p_actor_id uuid default null,
  p_reason text default null,
  p_appointment_id uuid default null,
  p_idempotency_key text default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  latest_appointment public.appointments%rowtype;
  booked_appointment public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  if p_set_by = 'user' and p_actor_id is null then raise exception 'PIPELINE_ACTOR_REQUIRED'; end if;

  if p_idempotency_key is not null then
    select id into audit_id
    from public.audit_log
    where tenant_id = p_expected_tenant
      and action = 'contact.pipeline_stage.set'
      and target_type = 'contact'
      and target_id = p_contact_id::text
      and payload ->> 'idempotency_key' = p_idempotency_key
    order by id
    limit 1;
    if audit_id is not null then return audit_id; end if;
  end if;

  if contact_row.pipeline_stage is distinct from p_expected_stage then
    raise exception 'PIPELINE_EXPECTED_STAGE_STALE';
  end if;
  if p_set_by = 'system' and contact_row.stage_set_by = 'user' and p_stage <> 'booked' then
    raise exception 'PIPELINE_USER_STAGE_PROTECTED';
  end if;
  if p_stage = 'booked' and p_appointment_id is null then
    raise exception 'PIPELINE_BOOKED_REQUIRES_APPOINTMENT';
  end if;
  if p_stage = 'booked' then
    select * into booked_appointment from public.appointments
    where id = p_appointment_id
    for update;
    if booked_appointment.id is null or booked_appointment.contact_id <> p_contact_id then
      raise exception 'PIPELINE_BOOKED_APPOINTMENT_MISMATCH';
    end if;
    perform app.assert_expected_tenant(
      p_expected_tenant, booked_appointment.tenant_id, 'appointment'
    );
    if booked_appointment.status not in ('scheduled', 'confirmed') then
      raise exception 'PIPELINE_BOOKED_APPOINTMENT_INVALID_STATUS';
    end if;
  end if;
  if p_stage = 'no_show' then
    select * into latest_appointment from public.appointments
    where contact_id = p_contact_id
    order by start_at desc, id desc limit 1
    for update;
    if latest_appointment.id is null or latest_appointment.status <> 'no_show' then
      raise exception 'PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT';
    end if;
    perform app.assert_expected_tenant(
      p_expected_tenant, latest_appointment.tenant_id, 'appointment'
    );
  end if;

  update public.contacts
  set pipeline_stage = p_stage, stage_set_by = p_set_by, stage_set_at = now()
  where id = p_contact_id;

  if p_set_by is distinct from 'user' then return null; end if;

  audit_id := app.write_audit_row(
    'contact.pipeline_stage.set', p_actor_id, p_expected_tenant, 'contact',
    p_contact_id::text, p_reason,
    jsonb_build_object(
      'prior_stage', contact_row.pipeline_stage,
      'expected_stage', p_expected_stage,
      'new_stage', p_stage,
      'set_by', p_set_by,
      'appointment_id', p_appointment_id,
      'idempotency_key', p_idempotency_key
    ),
    null,
    null
  );
  return audit_id;
end;
$$;

revoke execute on function public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, public.pipeline_stage, text, uuid, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, public.pipeline_stage, text, uuid, text, uuid, text
) to service_role;
