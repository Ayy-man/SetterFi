-- Phase 1 adversarial-review fixes. This migration follows the already-applied
-- Phase 1 migration locally and is safe to apply immediately after it on hosted.

-- Conversation takeover needs a truthful status reason. PostgreSQL cannot use a
-- newly-added enum value in the same transaction, so 000003 replaces the caller.
alter type public.convo_status_reason add value if not exists 'human_takeover';

-- ---------------------------------------------------------------------------
-- Impersonation is resolved against the live session row, never a stale tenant claim.
-- ---------------------------------------------------------------------------

create or replace function app.active_impersonation_tenant()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select s.tenant_id
  from public.impersonation_sessions s
  where s.id = app.claim('impersonation_session_id')::uuid
    and s.actor_id = app.current_user_id()
    and s.ended_at is null
    and s.expires_at > now();
$$;

create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when app.is_platform_user()
      then coalesce(app.active_impersonation_tenant(), app.claim('tenant_id')::uuid)
    else app.claim('tenant_id')::uuid
  end;
$$;

create or replace function app.not_impersonating()
returns boolean
language sql
stable
set search_path = ''
as $$
  select app.active_impersonation_tenant() is null;
$$;

create or replace function app.assert_not_impersonating()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not app.not_impersonating() then
    raise exception 'IMPERSONATION_WRITE_FORBIDDEN';
  end if;
end;
$$;

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  app_user record;
  active_session record;
  claims jsonb;
  metadata jsonb;
begin
  select role, tenant_id into app_user
  from public.users
  where id = (event ->> 'user_id')::uuid;

  if app_user.role is null then
    return event;
  end if;

  claims := coalesce(event -> 'claims', '{}'::jsonb);
  metadata := coalesce(claims -> 'app_metadata', '{}'::jsonb)
    - 'impersonating_tenant' - 'impersonation_session_id';
  metadata := metadata || jsonb_strip_nulls(jsonb_build_object(
    'role', app_user.role,
    'tenant_id', app_user.tenant_id
  ));

  if app_user.role in ('owner', 'admin', 'success') then
    select id into active_session
    from public.impersonation_sessions
    where actor_id = (event ->> 'user_id')::uuid
      and ended_at is null
      and expires_at > now()
    order by started_at desc, id desc
    limit 1;

    if active_session.id is not null then
      metadata := metadata || jsonb_build_object(
        'impersonation_session_id', active_session.id
      );
    end if;
  end if;

  claims := jsonb_set(claims, '{app_metadata}', metadata);
  return jsonb_set(event, '{claims}', claims);
end;
$$;

revoke execute on function app.active_impersonation_tenant() from public, anon;
grant execute on function app.active_impersonation_tenant() to authenticated, service_role;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Affiliate ledger reads bypass the removed referrals policy without widening data.
-- ---------------------------------------------------------------------------

create or replace function app.affiliate_owns_referral(p_referral_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.referrals r
    join public.affiliates a on a.id = r.affiliate_id
    where r.id = p_referral_id
      and a.user_id = app.current_user_id()
  );
$$;

revoke execute on function app.affiliate_owns_referral(uuid) from public, anon;
grant execute on function app.affiliate_owns_referral(uuid) to authenticated, service_role;

drop policy commission_self_read on public.commission_ledger;
create policy commission_self_read on public.commission_ledger for select to authenticated
  using (app.affiliate_owns_referral(referral_id));

-- ---------------------------------------------------------------------------
-- Calendar secrets and tenant-scoped replay keys.
-- ---------------------------------------------------------------------------

create table public.calendar_connection_secrets (
  calendar_connection_id uuid primary key
    references public.calendar_connections(id) on delete cascade,
  access_token text not null,
  refresh_token text,
  token_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.calendar_connection_secrets
  (calendar_connection_id, access_token, token_expires_at)
select id, access_token, token_expires_at
from public.calendar_connections
where access_token is not null;

alter table public.calendar_connections
  drop constraint calendar_connections_provider_external_calendar_id_key,
  add constraint calendar_connections_tenant_provider_calendar_key
    unique (tenant_id, provider, external_calendar_id),
  drop column access_token,
  drop column token_expires_at;

alter table public.appointments
  drop constraint appointments_provider_external_id_key,
  add constraint appointments_tenant_provider_external_key
    unique (tenant_id, provider, external_id);

alter table public.calendar_connection_secrets enable row level security;
alter table public.calendar_connection_secrets force row level security;
create policy calendar_connection_secrets_service_all
  on public.calendar_connection_secrets for all to service_role
  using (true) with check (true);
create trigger set_updated_at before update on public.calendar_connection_secrets
  for each row execute function app.set_updated_at();
revoke all on public.calendar_connection_secrets from public, anon, authenticated;
grant select, insert, update, delete on public.calendar_connection_secrets to service_role;

-- ---------------------------------------------------------------------------
-- Platform-owned agent content. The seed is visibly draft and cannot authorize
-- a non-demo send until an operator supplies approved copy later.
-- ---------------------------------------------------------------------------

alter table public.platform_settings
  add column agent_content jsonb not null default '{
    "automatedExperienceDisclosure":"[DRAFT] Automated-experience disclosure pending approval.",
    "heldReplies":{
      "NUM":"[DRAFT] NUM held reply pending approval.",
      "CLAIM":"[DRAFT] CLAIM held reply pending approval.",
      "ECHO":"[DRAFT] ECHO held reply pending approval.",
      "LINK":"[DRAFT] LINK held reply pending approval.",
      "SCOPE":"[DRAFT] SCOPE held reply pending approval.",
      "LEN":"[DRAFT] LEN held reply pending approval.",
      "JUDGE":"[DRAFT] JUDGE held reply pending approval.",
      "REVOKE":"[DRAFT] REVOKE held reply pending approval."
    },
    "platformFrame":"[DRAFT] Platform frame pending approval.",
    "mission":"[DRAFT] Mission prompt pending approval.",
    "qualification":"[DRAFT] Qualification prompt pending approval.",
    "roleBoundary":"[DRAFT] Role-boundary prompt pending approval."
  }'::jsonb,
  add column approved boolean not null default false,
  add constraint platform_settings_agent_content_shape_chk check (
    jsonb_typeof(agent_content) = 'object'
    and jsonb_typeof(agent_content -> 'heldReplies') = 'object'
  );

drop policy platform_settings_admin_read on public.platform_settings;
create policy platform_settings_platform_read on public.platform_settings
  for select to authenticated using (app.is_platform_user());

-- ---------------------------------------------------------------------------
-- Attendance has distinct human and machine audit contracts.
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('appointment.attendance_set.system', 'system', 'tenant', false, true,
   'Attendance logged', 'Attendance recorded from the calendar provider in the audit log'),
  ('conversation.message.sent.human', 'human', 'tenant', false, true,
   'Message sent', 'Human-authored message recorded in the audit log'),
  ('conversation.internal_note.added', 'human', 'tenant', false, true,
   'Internal note added', 'Internal conversation note recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.record_appointment_attendance(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_status public.appointment_status,
  p_source text,
  p_actor_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  appointment_row public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_source <> 'coach' then
    raise exception 'ATTENDANCE_HUMAN_SOURCE_INVALID:%', p_source;
  end if;
  if p_actor_id is null then raise exception 'ATTENDANCE_ACTOR_REQUIRED'; end if;
  if p_status not in ('completed', 'no_show') then
    raise exception 'ATTENDANCE_STATUS_INVALID';
  end if;
  select * into appointment_row from public.appointments where id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');

  update public.appointments
  set status = p_status, attendance_source = p_source, attendance_set_at = now(),
      attendance_set_by = p_actor_id, updated_at = now()
  where id = p_appointment_id;

  if p_status = 'no_show' then
    update public.contacts
    set pipeline_stage = 'no_show', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id;
  else
    update public.contacts
    set pipeline_stage = 'booked', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id and pipeline_stage = 'no_show';
  end if;

  audit_id := app.write_audit_row(
    'appointment.attendance_set', p_actor_id, p_expected_tenant, 'appointment',
    p_appointment_id::text, null,
    jsonb_build_object('prior_status', appointment_row.status,
                       'new_status', p_status, 'source', p_source)
  );
  return audit_id;
end;
$$;

create or replace function public.record_appointment_attendance_system(
  p_expected_tenant uuid,
  p_appointment_id uuid,
  p_status public.appointment_status,
  p_source text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  appointment_row public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_source not in ('provider', 'system') then
    raise exception 'ATTENDANCE_SYSTEM_SOURCE_INVALID:%', p_source;
  end if;
  if p_status not in ('completed', 'no_show') then
    raise exception 'ATTENDANCE_STATUS_INVALID';
  end if;

  select * into appointment_row from public.appointments where id = p_appointment_id for update;
  if appointment_row.id is null then raise exception 'APPOINTMENT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, appointment_row.tenant_id, 'appointment');
  if appointment_row.attendance_source = 'coach' then
    raise exception 'COACH_ATTENDANCE_IS_AUTHORITATIVE';
  end if;

  update public.appointments
  set status = p_status, attendance_source = p_source, attendance_set_at = now(),
      attendance_set_by = null, updated_at = now()
  where id = p_appointment_id;

  if p_status = 'no_show' then
    update public.contacts
    set pipeline_stage = 'no_show', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id;
  else
    update public.contacts
    set pipeline_stage = 'booked', stage_set_by = 'system', stage_set_at = now()
    where id = appointment_row.contact_id and pipeline_stage = 'no_show';
  end if;

  audit_id := app.write_audit_row(
    'appointment.attendance_set.system', null, p_expected_tenant, 'appointment',
    p_appointment_id::text, null,
    jsonb_build_object('prior_status', appointment_row.status,
                       'new_status', p_status, 'source', p_source)
  );
  return audit_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Provider booking idempotency, attribution billing, and typed agent turns.
-- ---------------------------------------------------------------------------

create or replace function public.record_provider_appointment(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_conversation_id uuid,
  p_calendar_connection_id uuid,
  p_provider public.calendar_provider,
  p_external_id text,
  p_start_at timestamptz,
  p_end_at timestamptz,
  p_timezone text,
  p_created_source public.appointment_source,
  p_attributed_to_agent boolean
)
returns table (appointment_id uuid, billable_event_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_tenant uuid;
  conversation_tenant uuid;
  calendar_tenant uuid;
  appointment_row public.appointments%rowtype;
  billable_id uuid;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  select tenant_id into contact_tenant from public.contacts where id = p_contact_id;
  perform app.assert_expected_tenant(p_expected_tenant, contact_tenant, 'contact');
  if p_conversation_id is not null then
    select tenant_id into conversation_tenant from public.conversations where id = p_conversation_id;
    perform app.assert_expected_tenant(p_expected_tenant, conversation_tenant, 'conversation');
  end if;
  if p_calendar_connection_id is not null then
    select tenant_id into calendar_tenant from public.calendar_connections
    where id = p_calendar_connection_id;
    perform app.assert_expected_tenant(p_expected_tenant, calendar_tenant, 'calendar_connection');
  end if;
  if p_end_at <= p_start_at or nullif(btrim(p_external_id), '') is null
    or nullif(btrim(p_timezone), '') is null then
    raise exception 'APPOINTMENT_REQUIRED_FIELD_INVALID';
  end if;

  select * into appointment_row from public.appointments
  where tenant_id = p_expected_tenant
    and provider = p_provider
    and external_id = p_external_id
  for update;
  if appointment_row.id is not null then
    select be.id into billable_id from public.billable_events be
    where be.appointment_id = appointment_row.id and be.adjusts_event_id is null;
    return query select appointment_row.id, billable_id, null::bigint;
    return;
  end if;

  insert into public.appointments (
    tenant_id, contact_id, conversation_id, provider, external_id,
    calendar_connection_id, calendar_id, start_at, end_at, timezone,
    created_source, attributed_to_agent
  ) values (
    p_expected_tenant, p_contact_id, p_conversation_id, p_provider, p_external_id,
    p_calendar_connection_id,
    (select external_calendar_id from public.calendar_connections where id = p_calendar_connection_id),
    p_start_at, p_end_at, p_timezone, p_created_source, p_attributed_to_agent
  ) returning * into appointment_row;

  if p_attributed_to_agent and not appointment_row.is_test then
    insert into public.billable_events (tenant_id, quantity, appointment_id, is_test)
    values (p_expected_tenant, 1, appointment_row.id, false)
    returning id into billable_id;
  end if;

  update public.contacts
  set pipeline_stage = 'booked', stage_set_by = 'system', stage_set_at = now()
  where id = p_contact_id;

  logged_id := app.write_audit_row(
    'appointment.created', null, p_expected_tenant, 'appointment', appointment_row.id::text,
    null, jsonb_build_object(
      'created_source', p_created_source,
      'attributed_to_agent', p_attributed_to_agent,
      'provider_external_id', p_external_id
    )
  );

  if not appointment_row.is_test then
    insert into public.notifications (tenant_id, user_id, kind, severity, title, body, link)
    select p_expected_tenant, u.id, 'appointment.booked', 'success',
      'Appointment booked', 'A lead booked an appointment.',
      '/coach/conversations/' || coalesce(p_conversation_id::text, '')
    from public.users u
    where u.tenant_id = p_expected_tenant and u.role = 'coach'
    order by u.created_at, u.id
    limit 1;
  end if;

  return query select appointment_row.id, billable_id, logged_id;
end;
$$;

drop function public.record_agent_turn(uuid, uuid, text, text, text, boolean);
create function public.record_agent_turn(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_body text,
  p_provider public.channel_provider,
  p_provider_message_id text,
  p_disclosure_consumed boolean
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  outbound_id uuid;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> 'agent' then
    raise exception 'CONVERSATION_HELD:%', conversation_row.status;
  end if;
  if conversation_row.disclosure_pending and not p_disclosure_consumed then
    raise exception 'DISCLOSURE_REQUIRED';
  end if;
  if not conversation_row.disclosure_pending and p_disclosure_consumed then
    raise exception 'DISCLOSURE_ALREADY_CONSUMED';
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider, provider_message_id
  ) values (
    p_expected_tenant, p_conversation_id, 'out', 'agent', p_body,
    p_provider::text, p_provider_message_id
  ) returning id into outbound_id;

  update public.conversations
  set disclosure_pending = case when p_disclosure_consumed then false else disclosure_pending end,
      last_message_at = now()
  where id = p_conversation_id;
  return outbound_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audited human messages and suppression inserts are single-transaction RPCs.
-- ---------------------------------------------------------------------------

create or replace function public.send_human_message(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_kind text,
  p_body text,
  p_expected_state public.convo_status
)
returns table (message_id uuid, audit_id bigint, action_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  actor public.users%rowtype;
  persisted_message_id uuid;
  logged_id bigint;
  audit_action text;
begin
  perform app.assert_not_impersonating();
  if p_actor_id is null then raise exception 'HUMAN_MESSAGE_ACTOR_REQUIRED'; end if;
  if p_kind not in ('reply', 'internal_note') then raise exception 'HUMAN_MESSAGE_KIND_INVALID'; end if;
  if nullif(btrim(p_body), '') is null or char_length(btrim(p_body)) > 800 then
    raise exception 'HUMAN_MESSAGE_BODY_INVALID';
  end if;
  if p_expected_state <> 'human' then raise exception 'HUMAN_MESSAGE_EXPECTED_STATE_INVALID'; end if;

  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> p_expected_state then raise exception 'HUMAN_MESSAGE_STATE_STALE'; end if;
  if conversation_row.taken_over_by is distinct from p_actor_id then
    raise exception 'HUMAN_MESSAGE_ACTOR_NOT_HOLDER';
  end if;

  select * into actor from public.users where id = p_actor_id;
  if actor.id is null then raise exception 'HUMAN_MESSAGE_ACTOR_NOT_FOUND'; end if;
  if actor.role = 'build'
     or (actor.tenant_id is distinct from p_expected_tenant
         and actor.role not in ('owner', 'admin', 'success')) then
    raise exception 'HUMAN_MESSAGE_ACTOR_NOT_AUTHORIZED';
  end if;

  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (
    p_expected_tenant,
    p_conversation_id,
    case when p_kind = 'reply' then 'out'::public.message_direction
         else 'system'::public.message_direction end,
    'human:' || p_actor_id::text,
    btrim(p_body)
  ) returning id into persisted_message_id;

  update public.conversations set last_message_at = now(), unread_by_coach = false
  where id = p_conversation_id;

  audit_action := case when p_kind = 'reply'
    then 'conversation.message.sent.human'
    else 'conversation.internal_note.added' end;
  logged_id := app.write_audit_row(
    audit_action, p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('message_id', persisted_message_id, 'kind', p_kind)
  );
  return query select persisted_message_id, logged_id, audit_action;
end;
$$;

create or replace function public.record_manual_suppression(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_channel public.messaging_channel,
  p_identifier_hash text,
  p_identifier_last4 text,
  p_reason text,
  p_actor_id uuid
)
returns table (suppression_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  contact_tenant uuid;
  persisted_id uuid;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if p_actor_id is null then raise exception 'SUPPRESSION_ACTOR_REQUIRED'; end if;
  if p_identifier_hash !~ '^[0-9a-f]{64}$' then raise exception 'SUPPRESSION_HASH_INVALID'; end if;
  if p_identifier_last4 is not null and p_identifier_last4 !~ '^.{1,4}$' then
    raise exception 'SUPPRESSION_LAST4_INVALID';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'SUPPRESSION_REASON_REQUIRED'; end if;

  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role = 'build'
     or (actor.tenant_id is distinct from p_expected_tenant
         and actor.role not in ('owner', 'admin', 'success')) then
    raise exception 'SUPPRESSION_ACTOR_NOT_AUTHORIZED';
  end if;
  if p_contact_id is not null then
    select tenant_id into contact_tenant from public.contacts where id = p_contact_id;
    perform app.assert_expected_tenant(p_expected_tenant, contact_tenant, 'contact');
  end if;

  insert into public.suppression_entries (
    tenant_id, channel, identifier_hash, identifier_last4, contact_id,
    source, reason, created_by, provider_sync_state
  ) values (
    p_expected_tenant, p_channel, p_identifier_hash, p_identifier_last4, p_contact_id,
    'manual', btrim(p_reason), p_actor_id, 'pending'
  ) on conflict do nothing
  returning id into persisted_id;

  if persisted_id is null then
    select id into persisted_id from public.suppression_entries
    where tenant_id = p_expected_tenant
      and channel = p_channel
      and identifier_hash = p_identifier_hash;
  end if;

  logged_id := app.write_audit_row(
    'suppression.insert.manual', p_actor_id, p_expected_tenant, 'suppression_entry',
    persisted_id::text, null, jsonb_build_object('channel', p_channel)
  );
  return query select persisted_id, logged_id;
end;
$$;

drop policy suppression_tenant_insert on public.suppression_entries;

-- ---------------------------------------------------------------------------
-- Demo reclassification, exports, rate limiting, and notification immutability.
-- ---------------------------------------------------------------------------

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
  raise exception 'BILLABLE_EVENTS_APPEND_ONLY';
end;
$$;

create or replace function public.set_tenant_demo_flag(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_is_demo boolean,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior_value boolean;
  actor_role public.user_role;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select role into actor_role from public.users where id = p_actor_id;
  if actor_role not in ('owner', 'admin') then raise exception 'DEMO_FLAG_ROLE_FORBIDDEN'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'DEMO_FLAG_REASON_REQUIRED'; end if;
  select is_demo into prior_value from public.tenants
  where id = p_expected_tenant for update;
  if prior_value is null then raise exception 'EXPECTED_TENANT_NOT_FOUND'; end if;

  update public.tenants set is_demo = p_is_demo, updated_at = now()
  where id = p_expected_tenant;
  update public.contacts set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.conversations set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.messages set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.appointments set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.followups set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.brain_knowledge_usage_events set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.unmatched_objections set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.appointment_reschedules set is_test = p_is_demo where tenant_id = p_expected_tenant;
  perform set_config('app.demo_reclassification_tenant', p_expected_tenant::text, true);
  update public.billable_events set is_test = p_is_demo where tenant_id = p_expected_tenant;
  perform set_config('app.demo_reclassification_tenant', '', true);
  update public.support_threads set is_test = p_is_demo where tenant_id = p_expected_tenant;
  update public.support_messages set is_test = p_is_demo where tenant_id = p_expected_tenant;

  audit_id := app.write_audit_row(
    'tenant.demo_flag.changed', p_actor_id, p_expected_tenant, 'tenant',
    p_expected_tenant::text, p_reason,
    jsonb_build_object('prior', prior_value, 'new', p_is_demo)
  );
  return audit_id;
end;
$$;

create or replace function public.start_export(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_resource text,
  p_filter jsonb,
  p_columns text[]
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  if not exists (select 1 from public.tenants where id = p_expected_tenant) then
    raise exception 'EXPECTED_TENANT_NOT_FOUND';
  end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null then raise exception 'EXPORT_ACTOR_NOT_FOUND'; end if;
  if actor.role = 'build' then raise exception 'EXPORT_ROLE_FORBIDDEN:build'; end if;
  if actor.tenant_id is distinct from p_expected_tenant
     and actor.role not in ('owner', 'admin', 'success') then
    raise exception 'EXPORT_ACTOR_NOT_AUTHORIZED';
  end if;
  return app.write_audit_row(
    'export.started', p_actor_id, p_expected_tenant, 'export', p_resource,
    null, jsonb_build_object('filter', coalesce(p_filter, '{}'::jsonb), 'columns', p_columns)
  );
end;
$$;

create or replace function public.consume_rate_limit(
  p_key text,
  p_limit int,
  p_window_seconds int,
  p_now timestamptz default now()
)
returns table (allowed boolean, remaining int, retry_after int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  limiter public.request_rate_limits%rowtype;
  elapsed_seconds int;
begin
  if nullif(btrim(p_key), '') is null or p_limit <= 0 or p_window_seconds <= 0 then
    raise exception 'RATE_LIMIT_CONFIGURATION_INVALID';
  end if;
  insert into public.request_rate_limits (key, window_started_at, hits)
  values (p_key, p_now, 0)
  on conflict (key) do nothing;

  select * into limiter from public.request_rate_limits where key = p_key for update;
  if limiter.key is null then raise exception 'RATE_LIMIT_ROW_MISSING'; end if;
  if p_now >= limiter.window_started_at + make_interval(secs => p_window_seconds) then
    limiter.window_started_at := p_now;
    limiter.hits := 0;
  end if;
  elapsed_seconds := greatest(0, extract(epoch from (p_now - limiter.window_started_at))::int);

  if limiter.hits >= p_limit then
    update public.request_rate_limits
    set window_started_at = limiter.window_started_at, hits = limiter.hits, updated_at = now()
    where key = p_key;
    return query select false, 0, greatest(1, p_window_seconds - elapsed_seconds);
  else
    limiter.hits := limiter.hits + 1;
    update public.request_rate_limits
    set window_started_at = limiter.window_started_at, hits = limiter.hits, updated_at = now()
    where key = p_key;
    return query select true, greatest(0, p_limit - limiter.hits), 0;
  end if;
end;
$$;

create or replace function app.enforce_notification_read_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(new) - 'read_at') is distinct from (to_jsonb(old) - 'read_at') then
    raise exception 'NOTIFICATION_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger notifications_read_only
before update on public.notifications
for each row execute function app.enforce_notification_read_only();
revoke execute on function app.enforce_notification_read_only() from public, anon, authenticated;
revoke execute on function app.reject_billable_event_mutation() from public, anon, authenticated;

-- Bell delivery is database-local and has no provider receipt.
alter table public.notification_deliveries
  drop constraint notification_delivery_receipt_chk,
  add constraint notification_delivery_receipt_chk check (
    (status = 'delivered'
      and delivered_at is not null
      and (destination = 'bell' or provider_reference is not null))
    or (status <> 'delivered' and delivered_at is null)
  );

-- ---------------------------------------------------------------------------
-- Direct-write custody and impersonation-aware policy replacements.
-- ---------------------------------------------------------------------------

drop policy tenants_platform_write on public.tenants;
create policy tenants_platform_write on public.tenants for all to authenticated
  using (app.can_platform_write_tenant(id))
  with check (app.can_platform_write_tenant(id));

drop policy users_self_update on public.users;
create policy users_self_update on public.users for update to authenticated
  using (id = app.current_user_id() and app.not_impersonating())
  with check (id = app.current_user_id() and role = app.current_user_role() and app.not_impersonating());
drop policy users_platform_write on public.users;
create policy users_platform_write on public.users for all to authenticated
  using (app.is_platform_admin() and app.not_impersonating())
  with check (app.is_platform_admin() and app.not_impersonating());

drop policy model_configs_admin_write on public.model_configs;
create policy model_configs_admin_write on public.model_configs for all to authenticated
  using (app.is_platform_admin() and app.not_impersonating())
  with check (app.is_platform_admin() and app.not_impersonating());

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'brain_documents', 'brain_knowledge_entries', 'brain_objections', 'qualification_rules'
  ] loop
    execute format('drop policy admin_write on public.%I', table_name);
    execute format(
      'create policy admin_write on public.%I for all to authenticated
       using (app.is_platform_admin() and app.not_impersonating())
       with check (app.is_platform_admin() and app.not_impersonating())', table_name
    );
  end loop;
end
$$;

drop policy brain_chunks_admin_write on public.brain_chunks;
create policy brain_chunks_admin_write on public.brain_chunks for all to authenticated
  using (app.is_platform_admin() and app.not_impersonating())
  with check (app.is_platform_admin() and app.not_impersonating());

do $$
declare
  table_name text;
begin
  foreach table_name in array array['eval_cases', 'eval_runs', 'eval_case_results'] loop
    execute format('drop policy platform_all on public.%I', table_name);
    execute format(
      'create policy platform_all on public.%I for all to authenticated
       using (app.is_platform_user() and app.not_impersonating())
       with check (app.is_platform_user() and app.not_impersonating())', table_name
    );
  end loop;
end
$$;

drop policy affiliates_platform_all on public.affiliates;
create policy affiliates_platform_all on public.affiliates for all to authenticated
  using (app.is_platform_user() and app.not_impersonating())
  with check (app.is_platform_user() and app.not_impersonating());

drop policy ghl_installs_platform_all on public.ghl_installs;
create policy ghl_installs_platform_all on public.ghl_installs for all to authenticated
  using (app.is_platform_user() and app.not_impersonating())
  with check (app.is_platform_user() and app.not_impersonating());

drop policy message_traces_admin_read on public.message_traces;
create policy message_traces_platform_read on public.message_traces for select to authenticated
  using (app.is_platform_user());

drop policy tenant_write on public.conversations;
drop policy platform_write on public.conversations;
drop policy tenant_write on public.followups;
drop policy platform_write on public.followups;
drop policy tenant_write on public.appointments;
drop policy platform_write on public.appointments;
revoke insert, update, delete on public.conversations, public.followups, public.appointments
  from authenticated;

-- A table-level UPDATE grant overrides a column revoke, so replace it with
-- explicit per-column grants while keeping the contacts write policies intact.
revoke update (pipeline_stage) on public.contacts from authenticated;
revoke update on public.contacts from authenticated;
do $$
declare
  columns text;
begin
  select string_agg(format('%I', column_name), ', ' order by ordinal_position)
  into columns
  from information_schema.columns
  where table_schema = 'public'
    and table_name = 'contacts'
    and column_name <> 'pipeline_stage'
    and is_generated = 'NEVER';
  execute format('grant update (%s) on public.contacts to authenticated', columns);
end
$$;

revoke all on public.coach_support_messages, public.production_tenant_aggregate_source
  from anon, authenticated;
grant select on public.coach_support_messages, public.production_tenant_aggregate_source
  to authenticated;

-- New functions follow the explicit service custody used by Phase 1 RPCs.
revoke execute on function public.record_appointment_attendance_system(uuid, uuid, public.appointment_status, text)
  from public, anon, authenticated;
revoke execute on function public.send_human_message(uuid, uuid, uuid, text, text, public.convo_status)
  from public, anon, authenticated;
revoke execute on function public.record_manual_suppression(uuid, uuid, public.messaging_channel, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_appointment_attendance_system(uuid, uuid, public.appointment_status, text)
  to service_role;
grant execute on function public.send_human_message(uuid, uuid, uuid, text, text, public.convo_status)
  to service_role;
grant execute on function public.record_manual_suppression(uuid, uuid, public.messaging_channel, text, text, text, uuid)
  to service_role;

-- Re-created public RPCs lost the blanket grant that ran in 000001.
grant execute on function public.record_appointment_attendance(uuid, uuid, public.appointment_status, text, uuid)
  to service_role;
grant execute on function public.record_provider_appointment(uuid, uuid, uuid, uuid, public.calendar_provider, text, timestamptz, timestamptz, text, public.appointment_source, boolean)
  to service_role;
grant execute on function public.record_agent_turn(uuid, uuid, text, public.channel_provider, text, boolean)
  to service_role;
grant execute on function public.set_tenant_demo_flag(uuid, uuid, boolean, text) to service_role;
grant execute on function public.start_export(uuid, uuid, text, jsonb, text[]) to service_role;
grant execute on function public.consume_rate_limit(text, int, int, timestamptz) to service_role;

alter default privileges in schema app
  revoke all on functions from anon, authenticated, public;
