-- The moderator's verdict needs its own immutable receipt: a trace can otherwise say only that
-- a draft was blocked, not which guardrail class fired or which configured moderator made it.
alter table public.message_traces
  add column moderator_class text,
  add column moderator_rule_id text,
  add column moderator_model_config_id uuid references public.model_configs(id) on delete restrict,
  add constraint message_traces_moderator_class_chk check (
    moderator_class is null or moderator_class in ('NUM', 'CLAIM', 'ECHO', 'LINK', 'SCOPE', 'LEN', 'JUDGE')
  );

-- Test-agent turns use the same trace table through this service-only writer. Its session lock,
-- message creation, and test-row readback remain unchanged; only the durable verdict receipt is
-- projected from the already-persisted trace payload.
create or replace function public.persist_test_agent_turn(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_session_id uuid,
  p_lead_body text,
  p_agent_body text,
  p_trace jsonb,
  p_resolved_driver_arm text,
  p_answered_step_key text,
  p_asked_step_key text
)
returns table (
  contact_id uuid,
  conversation_id uuid,
  lead_message_id uuid,
  agent_message_id uuid,
  resolved_driver_arm text,
  contact_is_test boolean,
  conversation_is_test boolean,
  lead_is_test boolean,
  agent_is_test boolean,
  trace_is_test boolean,
  step_rows_is_test boolean,
  appointment_rows bigint,
  billable_rows bigint,
  followup_rows bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  session_row public.test_agent_sessions%rowtype;
  trace_test boolean;
  step_test boolean;
  new_contact_id uuid;
  new_conversation_id uuid;
  new_lead_message_id uuid;
  new_agent_message_id uuid;
begin
  perform app.phase7_verified_test_actor(p_actor_id, p_expected_tenant);
  select * into session_row from public.test_agent_sessions session
  where session.id = p_session_id for update;
  if session_row.id is null then raise exception 'PHASE7_TEST_SESSION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, session_row.tenant_id, 'test_agent_session');
  if session_row.closed_at is not null then raise exception 'PHASE7_TEST_SESSION_CLOSED'; end if;
  if nullif(btrim(coalesce(p_lead_body,'')), '') is null
    or nullif(btrim(coalesce(p_agent_body,'')), '') is null then
    raise exception 'PHASE7_TEST_TURN_BODY_REQUIRED';
  end if;
  if p_resolved_driver_arm not in ('mock','real') then
    raise exception 'PHASE7_TEST_DRIVER_ARM_INVALID';
  end if;
  if coalesce(jsonb_typeof(p_trace),'') <> 'object' then
    raise exception 'PHASE7_TEST_TRACE_REQUIRED';
  end if;

  select contact.id into new_contact_id from public.contacts contact
  where contact.test_session_id = p_session_id for update;
  if new_contact_id is null then
    insert into public.contacts (
      tenant_id, last_channel, name, test_session_id
    ) values (
      p_expected_tenant, 'webchat', 'Test lead', p_session_id
    ) returning id into new_contact_id;
  end if;
  select conversation.id into new_conversation_id from public.conversations conversation
  where conversation.contact_id = new_contact_id order by conversation.created_at limit 1 for update;
  if new_conversation_id is null then
    insert into public.conversations (tenant_id, contact_id, channel, status)
    values (p_expected_tenant, new_contact_id, 'webchat', 'agent')
    returning id into new_conversation_id;
  end if;
  insert into public.messages (tenant_id, conversation_id, direction, author, body, provider)
  values (p_expected_tenant, new_conversation_id, 'in', 'lead', p_lead_body, 'test_agent')
  returning id into new_lead_message_id;
  insert into public.messages (tenant_id, conversation_id, direction, author, body, provider)
  values (p_expected_tenant, new_conversation_id, 'out', 'agent', p_agent_body, 'test_agent')
  returning id into new_agent_message_id;
  insert into public.message_traces (
    message_id, tenant_id, trace, model, params, moderator_state, moderator_class,
    moderator_rule_id, moderator_model_config_id
  )
  values (
    new_agent_message_id, p_expected_tenant,
    p_trace || jsonb_build_object('driverArm', p_resolved_driver_arm),
    p_trace ->> 'model', coalesce(p_trace -> 'params','{}'::jsonb),
    case when p_trace ->> 'moderator' in ('allowed','blocked','unavailable')
      then p_trace ->> 'moderator' else null end,
    case when p_trace ->> 'moderatorClass' in ('NUM','CLAIM','ECHO','LINK','SCOPE','LEN','JUDGE')
      then p_trace ->> 'moderatorClass' else null end,
    p_trace ->> 'moderatorRuleId',
    case when p_trace ? 'moderatorModelConfigId'
      then (p_trace ->> 'moderatorModelConfigId')::uuid else null end
  );
  perform * from public.record_conversation_step_events(
    p_expected_tenant, new_conversation_id, new_lead_message_id, new_agent_message_id,
    p_answered_step_key, p_asked_step_key
  );

  select contact.is_test, conversation.is_test, lead.is_test, agent.is_test
  into contact_is_test, conversation_is_test, lead_is_test, agent_is_test
  from public.contacts contact
  join public.conversations conversation on conversation.id = new_conversation_id
  join public.messages lead on lead.id = new_lead_message_id
  join public.messages agent on agent.id = new_agent_message_id
  where contact.id = new_contact_id;
  trace_test := agent_is_test;
  select coalesce(bool_and(event.is_test), true) into step_test
  from public.conversation_step_events event
  where event.message_id in (new_lead_message_id, new_agent_message_id);
  trace_is_test := trace_test;
  step_rows_is_test := step_test;
  select count(*) into appointment_rows from public.appointments appointment
    where appointment.contact_id = new_contact_id;
  select count(*) into billable_rows from public.billable_events event
    join public.appointments appointment on appointment.id = event.appointment_id
    where appointment.contact_id = new_contact_id;
  select count(*) into followup_rows from public.followups followup
    where followup.conversation_id = new_conversation_id;
  contact_id := new_contact_id;
  conversation_id := new_conversation_id;
  lead_message_id := new_lead_message_id;
  agent_message_id := new_agent_message_id;
  resolved_driver_arm := p_resolved_driver_arm;
  return next;
end;
$$;
