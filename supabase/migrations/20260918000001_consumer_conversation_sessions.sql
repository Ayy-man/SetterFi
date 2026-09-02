-- Opaque public-webchat sessions keep tenant identity and transcript authority server-side.
create table public.consumer_conversation_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_identity_id uuid not null references public.contact_identities(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  session_secret_hash text not null unique check (session_secret_hash ~ '^[0-9a-f]{64}$'),
  revision integer not null default 0 check (revision >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (expires_at > created_at)
);
alter table public.consumer_conversation_sessions enable row level security;
alter table public.consumer_conversation_sessions force row level security;
revoke all on public.consumer_conversation_sessions from public, anon, authenticated;
grant select, insert, update on public.consumer_conversation_sessions to service_role;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values ('consumer.conversation_started', 'system', 'tenant', false, true, 'Lead conversation started', 'Lead conversation start recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.start_consumer_conversation_session(p_tenant_slug text, p_contact_identity_id uuid, p_session_secret_hash text, p_expires_at timestamptz)
returns table (tenant_id uuid, session_id uuid, conversation_id uuid, business_name text, program_name text, privacy_url text)
language plpgsql volatile security definer set search_path = '' as $$
declare tenant_row public.tenants%rowtype; identity_row public.contact_identities%rowtype; offer_row public.offer_layers%rowtype; artifact_row public.onboarding_optin_artifacts%rowtype; conversation_row public.conversations%rowtype; created_session_id uuid;
begin
  perform app.assert_not_impersonating();
  if p_tenant_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' or p_contact_identity_id is null or p_session_secret_hash !~ '^[0-9a-f]{64}$' or p_expires_at is null or p_expires_at <= now() then raise exception 'CONSUMER_SESSION_INPUT_INVALID'; end if;
  select * into tenant_row from public.tenants where slug = p_tenant_slug and status = 'active';
  if tenant_row.id is null then raise exception 'CONSUMER_TENANT_UNAVAILABLE'; end if;
  select * into identity_row from public.contact_identities where id = p_contact_identity_id and tenant_id = tenant_row.id for update;
  if identity_row.id is null or identity_row.consent_state not in ('conversation', 'opted_in') then raise exception 'CONSUMER_CONSENT_REQUIRED'; end if;
  select * into offer_row from public.offer_layers where tenant_id = tenant_row.id and status = 'published' order by version desc limit 1;
  if offer_row.id is null then raise exception 'CONSUMER_PUBLISHED_OFFER_REQUIRED'; end if;
  select * into artifact_row from public.onboarding_optin_artifacts where tenant_id = tenant_row.id and is_current and confirmed_at is not null;
  if artifact_row.id is null then raise exception 'CONSUMER_PRIVACY_ARTIFACT_REQUIRED'; end if;
  insert into public.conversations (tenant_id, contact_id, channel, disclosure_pending) values (tenant_row.id, identity_row.contact_id, 'webchat', true) returning * into conversation_row;
  insert into public.consumer_conversation_sessions (tenant_id, contact_identity_id, conversation_id, session_secret_hash, expires_at) values (tenant_row.id, identity_row.id, conversation_row.id, p_session_secret_hash, p_expires_at) returning id into created_session_id;
  perform app.write_audit_row('consumer.conversation_started', null, tenant_row.id, 'conversation', conversation_row.id::text, null, jsonb_build_object('channel', 'webchat'));
  return query select tenant_row.id, created_session_id, conversation_row.id, tenant_row.name, coalesce(offer_row.program_name, ''), artifact_row.privacy_url;
end; $$;

create or replace function public.load_consumer_conversation_session(p_session_secret_hash text)
returns table (tenant_id uuid, session_id uuid, conversation_id uuid, contact_id uuid, revision integer, conversation_status text, current_step text, current_step_asks integer, disclosure_pending boolean)
language sql stable security definer set search_path = '' as $$
  select session.tenant_id, session.id, session.conversation_id, conversation.contact_id, session.revision, conversation.status::text, conversation.current_step, conversation.current_step_asks, conversation.disclosure_pending
  from public.consumer_conversation_sessions session join public.tenants tenant on tenant.id = session.tenant_id and tenant.status = 'active'
  join public.conversations conversation on conversation.id = session.conversation_id and conversation.tenant_id = session.tenant_id
  where session.session_secret_hash = p_session_secret_hash and session.expires_at > now();
$$;

create or replace function public.load_consumer_conversation_history(p_session_secret_hash text, p_limit integer default 20)
returns table (role text, content text, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select case when message.direction = 'in' then 'user' else 'assistant' end, message.body, message.created_at
  from public.consumer_conversation_sessions session join public.tenants tenant on tenant.id = session.tenant_id and tenant.status = 'active'
  join public.messages message on message.conversation_id = session.conversation_id and message.tenant_id = session.tenant_id
  where session.session_secret_hash = p_session_secret_hash and session.expires_at > now() and message.direction in ('in', 'out')
  order by message.created_at desc, message.id desc limit greatest(1, least(coalesce(p_limit, 20), 40));
$$;

create or replace function public.append_consumer_conversation_turn(p_session_secret_hash text, p_expected_revision integer, p_lead_body text, p_agent_body text, p_next_status public.convo_status)
returns table (lead_message_id uuid, agent_message_id uuid, revision integer)
language plpgsql volatile security definer set search_path = '' as $$
declare session_row public.consumer_conversation_sessions%rowtype; conversation_row public.conversations%rowtype; inbound_id uuid; outbound_id uuid; next_revision integer;
begin
  perform app.assert_not_impersonating();
  if p_session_secret_hash !~ '^[0-9a-f]{64}$' or p_expected_revision < 0 or nullif(btrim(p_lead_body), '') is null or char_length(p_lead_body) > 800 or nullif(btrim(p_agent_body), '') is null or char_length(p_agent_body) > 4000 then raise exception 'CONSUMER_TURN_INPUT_INVALID'; end if;
  select * into session_row from public.consumer_conversation_sessions where session_secret_hash = p_session_secret_hash and expires_at > now() for update;
  if session_row.id is null then raise exception 'CONSUMER_SESSION_UNAVAILABLE'; end if;
  if session_row.revision <> p_expected_revision then raise exception 'CONSUMER_SESSION_REVISION_CONFLICT'; end if;
  select * into conversation_row from public.conversations where id = session_row.conversation_id and tenant_id = session_row.tenant_id for update;
  if conversation_row.id is null or conversation_row.status <> 'agent' then raise exception 'CONSUMER_CONVERSATION_UNAVAILABLE'; end if;
  insert into public.messages (tenant_id, conversation_id, direction, author, body) values (session_row.tenant_id, conversation_row.id, 'in', 'lead', btrim(p_lead_body)) returning id into inbound_id;
  insert into public.messages (tenant_id, conversation_id, direction, author, body) values (session_row.tenant_id, conversation_row.id, 'out', 'agent', btrim(p_agent_body)) returning id into outbound_id;
  update public.conversations set status = p_next_status, status_reason = case when p_next_status = 'needs_human' then 'no_match_threshold' else null end, disclosure_pending = false, last_message_at = now(), updated_at = now() where id = conversation_row.id;
  update public.consumer_conversation_sessions set revision = revision + 1 where id = session_row.id returning public.consumer_conversation_sessions.revision into next_revision;
  return query select inbound_id, outbound_id, next_revision;
end; $$;

revoke all on function public.start_consumer_conversation_session(text, uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.load_consumer_conversation_session(text) from public, anon, authenticated;
revoke all on function public.load_consumer_conversation_history(text, integer) from public, anon, authenticated;
revoke all on function public.append_consumer_conversation_turn(text, integer, text, text, public.convo_status) from public, anon, authenticated;
grant execute on function public.start_consumer_conversation_session(text, uuid, text, timestamptz) to service_role;
grant execute on function public.load_consumer_conversation_session(text) to service_role;
grant execute on function public.load_consumer_conversation_history(text, integer) to service_role;
grant execute on function public.append_consumer_conversation_turn(text, integer, text, text, public.convo_status) to service_role;
