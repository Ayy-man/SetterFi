-- Coach-write rollout hardening.
--
-- A human reply crosses a provider boundary, so the state check before dispatch is insufficient:
-- handback must not win between that check and durable message/audit persistence. Store the
-- claimant on the attempt, fence both claim and persistence against the conversation row, and
-- refuse handback while the provider outcome is still unresolved.

alter table public.outbound_send_attempts
  add column human_actor_id uuid references public.users(id) on delete restrict;

comment on column public.outbound_send_attempts.human_actor_id is
  'The verified human holder for a human_reply. It fences reply persistence and preserves the audit actor during reconciliation.';

drop function public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer
);

create function public.claim_outbound_send(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_contact_id uuid,
  p_identity_id uuid,
  p_purpose text,
  p_channel public.messaging_channel,
  p_provider public.channel_provider,
  p_body text,
  p_idempotency_key text,
  p_payload_hash text,
  p_provider_idempotency_supported boolean,
  p_origin_receipt_id uuid default null,
  p_origin_lease_token uuid default null,
  p_origin_attempt_number integer default null,
  p_human_actor_id uuid default null
)
returns table (
  disposition text,
  claim_token uuid,
  identity_id uuid,
  channel public.messaging_channel,
  provider_message_id text,
  accepted_at timestamptz,
  message_id uuid,
  audit_id bigint,
  persisted_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.outbound_send_attempts%rowtype;
  conversation_row public.conversations%rowtype;
  identity_row public.contact_identities%rowtype;
  receipt_row public.webhook_events%rowtype;
  inbound_provider_message_id text;
  next_token uuid;
  lease_until timestamptz := clock_timestamp() + interval '2 minutes';
begin
  if nullif(btrim(p_idempotency_key), '') is null or char_length(p_idempotency_key) > 200
    or p_payload_hash !~ '^[0-9a-f]{64}$' or nullif(btrim(p_body), '') is null then
    raise exception 'OUTBOUND_SEND_CLAIM_INVALID';
  end if;
  if p_purpose = 'agent_reply' and (
    p_origin_receipt_id is null or p_origin_lease_token is null
    or p_origin_attempt_number is null or p_origin_attempt_number < 1
  ) then raise exception 'OUTBOUND_SEND_ORIGIN_REQUIRED'; end if;
  if p_purpose <> 'agent_reply' and (
    p_origin_receipt_id is not null or p_origin_lease_token is not null
    or p_origin_attempt_number is not null
  ) then raise exception 'OUTBOUND_SEND_ORIGIN_INVALID'; end if;
  if p_purpose = 'human_reply' and p_human_actor_id is null then
    raise exception 'HUMAN_REPLY_ACTOR_REQUIRED';
  end if;
  if p_purpose <> 'human_reply' and p_human_actor_id is not null then
    raise exception 'OUTBOUND_SEND_HUMAN_ACTOR_INVALID';
  end if;

  select * into conversation_row from public.conversations
  where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.contact_id <> p_contact_id or conversation_row.channel <> p_channel then
    raise exception 'OUTBOUND_SEND_SCOPE_MISMATCH';
  end if;
  if p_purpose = 'human_reply' then
    perform app.assert_actor_not_impersonating(p_human_actor_id);
    if conversation_row.status <> 'human'
      or conversation_row.taken_over_by is distinct from p_human_actor_id then
      raise exception 'HUMAN_REPLY_STALE';
    end if;
    if not exists (
      select 1 from public.users actor
      where actor.id = p_human_actor_id
        and actor.role <> 'build'
        and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
    ) then raise exception 'HUMAN_REPLY_ACTOR_NOT_AUTHORIZED'; end if;
  end if;

  select * into identity_row from public.contact_identities where id = p_identity_id;
  if identity_row.id is null then raise exception 'CONTACT_IDENTITY_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, identity_row.tenant_id, 'contact_identity');
  if identity_row.contact_id <> p_contact_id or identity_row.channel::text <> p_channel::text
    or identity_row.provider <> p_provider then
    raise exception 'OUTBOUND_SEND_IDENTITY_MISMATCH';
  end if;

  if p_origin_receipt_id is not null then
    select candidate.* into receipt_row from public.webhook_events candidate
    where candidate.id = p_origin_receipt_id for update;
    if receipt_row.id is null then raise exception 'OUTBOUND_SEND_ORIGIN_NOT_FOUND'; end if;
    perform app.assert_expected_tenant(p_expected_tenant, receipt_row.tenant_id, 'outbound_origin_receipt');
    inbound_provider_message_id := substring(btrim(p_idempotency_key) from '^inbound:[^:]+:(.*)$');
    if inbound_provider_message_id is null or not exists (
      select 1 from jsonb_array_elements(coalesce(
        receipt_row.payload #> '{normalized,events}', '[]'::jsonb
      )) item
      where item->>'kind' = 'message' and item->>'providerMessageId' = inbound_provider_message_id
    ) then raise exception 'OUTBOUND_SEND_ORIGIN_PAYLOAD_MISMATCH'; end if;
    if receipt_row.status not in ('received', 'failed') or receipt_row.processed_at is not null
      or receipt_row.lease_token is distinct from p_origin_lease_token
      or receipt_row.attempts <> p_origin_attempt_number or receipt_row.lease_expires_at is null
      or receipt_row.lease_expires_at <= clock_timestamp() then
      raise exception 'OUTBOUND_SEND_ORIGIN_LEASE_LOST';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':outbound:' || btrim(p_idempotency_key), 0
  ));
  select candidate.* into attempt from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant and candidate.idempotency_key = btrim(p_idempotency_key)
  for update;

  if attempt.id is null then
    next_token := gen_random_uuid();
    insert into public.outbound_send_attempts (
      tenant_id, conversation_id, contact_id, identity_id, origin_webhook_event_id,
      idempotency_key, payload_hash, purpose, channel, provider, body, human_actor_id,
      status, claim_token, lease_expires_at, provider_idempotency_supported
    ) values (
      p_expected_tenant, p_conversation_id, p_contact_id, p_identity_id, p_origin_receipt_id,
      btrim(p_idempotency_key), p_payload_hash, p_purpose, p_channel, p_provider, p_body,
      p_human_actor_id, 'claimed', next_token, lease_until, p_provider_idempotency_supported
    );
    return query select 'claimed'::text, next_token, p_identity_id, p_channel,
      null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  if attempt.payload_hash <> p_payload_hash or attempt.conversation_id <> p_conversation_id
    or attempt.contact_id <> p_contact_id or attempt.identity_id <> p_identity_id
    or attempt.purpose <> p_purpose or attempt.channel <> p_channel or attempt.provider <> p_provider
    or attempt.body <> p_body or attempt.origin_webhook_event_id is distinct from p_origin_receipt_id
    or attempt.human_actor_id is distinct from p_human_actor_id then
    raise exception 'OUTBOUND_SEND_IDEMPOTENCY_CONFLICT';
  end if;
  if attempt.status = 'persisted' then
    return query select 'persisted'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, attempt.provider_message_id, attempt.accepted_at, attempt.message_id,
      attempt.audit_id, attempt.persisted_at;
    return;
  end if;
  if attempt.status = 'indeterminate' then
    return query select 'indeterminate'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  if attempt.lease_expires_at > clock_timestamp() then
    return query select 'in_progress'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, attempt.provider_message_id, attempt.accepted_at, null::uuid,
      null::bigint, null::timestamptz;
    return;
  end if;
  if attempt.status = 'claimed' and not attempt.provider_idempotency_supported then
    update public.outbound_send_attempts set status = 'indeterminate', updated_at = clock_timestamp(),
      last_error_code = 'CLAIM_EXPIRED_PROVIDER_ACCEPTANCE_UNKNOWN' where id = attempt.id;
    return query select 'indeterminate'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;
  next_token := gen_random_uuid();
  update public.outbound_send_attempts set claim_token = next_token, lease_expires_at = lease_until,
    attempt_count = attempt_count + 1, updated_at = clock_timestamp() where id = attempt.id;
  return query select attempt.status, next_token, attempt.identity_id, attempt.channel,
    attempt.provider_message_id, attempt.accepted_at, null::uuid, null::bigint, null::timestamptz;
end;
$$;

create or replace function public.release_conversation(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_expected_holder_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  select * into conversation_row from public.conversations where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> 'human'
    or conversation_row.taken_over_by is distinct from p_expected_holder_id
    or p_actor_id is distinct from p_expected_holder_id then
    raise exception 'CONVERSATION_RELEASE_STALE';
  end if;
  if exists (
    select 1 from public.outbound_send_attempts attempt
    where attempt.tenant_id = p_expected_tenant and attempt.conversation_id = p_conversation_id
      and attempt.purpose = 'human_reply' and attempt.status in ('claimed', 'accepted', 'indeterminate')
  ) then raise exception 'CONVERSATION_RELEASE_REPLY_PENDING'; end if;

  update public.conversations set status = 'agent', status_reason = null, status_changed_at = now(),
    taken_over_by = null, taken_over_at = null, disclosure_pending = true where id = p_conversation_id;
  update public.followups set scheduled_at = now() + make_interval(secs => remaining_offset_seconds),
    paused_at = null, remaining_offset_seconds = null
  where conversation_id = p_conversation_id and status = 'scheduled' and paused_at is not null;
  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (p_expected_tenant, p_conversation_id, 'system', 'system',
    'The automated assistant resumed this conversation.');
  audit_id := app.write_audit_row(
    'conversation.takeover.released', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null, jsonb_build_object('prior_status', 'human', 'new_status', 'agent')
  );
  return audit_id;
end;
$$;

create or replace function public.persist_claimed_outbound_send(
  p_expected_tenant uuid,
  p_idempotency_key text,
  p_claim_token uuid,
  p_actor_id uuid,
  p_provider_message_id text,
  p_is_test boolean
)
returns table (message_id uuid, audit_id bigint, persisted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.outbound_send_attempts%rowtype;
  conversation_row public.conversations%rowtype;
  persisted_message_id uuid;
  persisted_created_at timestamptz;
  logged_id bigint;
  audit_action text;
  audit_actor uuid;
begin
  select candidate.* into attempt from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant and candidate.idempotency_key = btrim(p_idempotency_key)
  for update;
  if attempt.id is null then raise exception 'OUTBOUND_SEND_ATTEMPT_NOT_FOUND'; end if;
  if attempt.claim_token <> p_claim_token then raise exception 'OUTBOUND_SEND_CLAIM_LOST'; end if;
  if attempt.status = 'persisted' then
    if attempt.provider_message_id <> btrim(p_provider_message_id) then
      raise exception 'OUTBOUND_SEND_PROVIDER_RECEIPT_CONFLICT';
    end if;
    return query select attempt.message_id, attempt.audit_id, attempt.persisted_at;
    return;
  end if;
  if attempt.status <> 'accepted' or attempt.provider_message_id <> btrim(p_provider_message_id) then
    raise exception 'OUTBOUND_SEND_ACCEPTANCE_REQUIRED';
  end if;

  audit_actor := null;
  if attempt.purpose = 'human_reply' then
    if attempt.human_actor_id is null then raise exception 'HUMAN_REPLY_ACTOR_REQUIRED'; end if;
    if p_actor_id is not null and p_actor_id is distinct from attempt.human_actor_id then
      raise exception 'HUMAN_REPLY_ACTOR_MISMATCH';
    end if;
    select * into conversation_row from public.conversations where id = attempt.conversation_id for update;
    if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
    perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
    if conversation_row.status <> 'human'
      or conversation_row.taken_over_by is distinct from attempt.human_actor_id then
      raise exception 'HUMAN_REPLY_STALE';
    end if;
    audit_actor := attempt.human_actor_id;
  end if;

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider,
    provider_message_id, state_entry_key, is_test
  ) values (
    p_expected_tenant, attempt.conversation_id, 'out',
    case when attempt.purpose = 'human_reply' then 'human:' || audit_actor::text else 'agent' end,
    attempt.body, attempt.provider, attempt.provider_message_id, attempt.idempotency_key, p_is_test
  ) returning id, created_at into persisted_message_id, persisted_created_at;
  update public.conversations set last_message_at = persisted_created_at
  where id = attempt.conversation_id and tenant_id = p_expected_tenant;
  audit_action := case when attempt.purpose = 'human_reply' then 'conversation.message.sent.human'
    when attempt.purpose = 'follow_up' then 'followup.completed' else 'conversation.channel_continued' end;
  logged_id := app.write_audit_row(
    audit_action, audit_actor, p_expected_tenant, 'conversation', attempt.conversation_id::text, null,
    jsonb_build_object('messageId', persisted_message_id, 'purpose', attempt.purpose,
      'providerMessageId', attempt.provider_message_id, 'outboundAttemptId', attempt.id)
  );
  update public.outbound_send_attempts set status = 'persisted', message_id = persisted_message_id,
    audit_id = logged_id, persisted_at = persisted_created_at, updated_at = clock_timestamp()
  where id = attempt.id;
  return query select persisted_message_id, logged_id, persisted_created_at;
end;
$$;

revoke execute on function public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer, uuid
) from public, anon, authenticated;
grant execute on function public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer, uuid
) to service_role;
