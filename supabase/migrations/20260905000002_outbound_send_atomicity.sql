-- Durable custody for lead-facing provider sends.
--
-- A message row cannot reserve an idempotency key before provider acceptance because it would
-- falsely represent an outbound message. This attempt ledger reserves the key independently,
-- records acceptance, and then commits the message, audit row, and terminal attempt atomically.

create table public.outbound_send_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  identity_id uuid not null references public.contact_identities(id) on delete restrict,
  origin_webhook_event_id uuid references public.webhook_events(id) on delete restrict,
  idempotency_key text not null check (
    nullif(btrim(idempotency_key), '') is not null and char_length(idempotency_key) <= 200
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  purpose text not null check (purpose in (
    'agent_reply', 'follow_up', 'human_reply',
    'stop_confirmation', 'help_confirmation', 'start_confirmation'
  )),
  channel public.messaging_channel not null check (channel in ('instagram','messenger','sms','whatsapp','webchat')),
  provider public.channel_provider not null,
  body text not null check (nullif(btrim(body), '') is not null),
  status text not null check (status in ('claimed', 'accepted', 'persisted', 'indeterminate')),
  claim_token uuid not null,
  lease_expires_at timestamptz not null,
  provider_idempotency_supported boolean not null default false,
  provider_message_id text,
  accepted_at timestamptz,
  message_id uuid references public.messages(id) on delete restrict,
  audit_id bigint references public.audit_log(id) on delete restrict,
  persisted_at timestamptz,
  last_error_code text,
  attempt_count integer not null default 1 check (attempt_count > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key),
  check ((status in ('accepted', 'persisted')) =
    (provider_message_id is not null and accepted_at is not null)),
  check ((status = 'persisted') =
    (message_id is not null and audit_id is not null and persisted_at is not null))
);

comment on table public.outbound_send_attempts is
  'Tenant-scoped provider dispatch claims. Indeterminate means provider acceptance cannot be ruled out and automatic retry is forbidden.';
comment on column public.outbound_send_attempts.provider_idempotency_supported is
  'True only when the exact provider endpoint documents a client idempotency primitive and the adapter forwards idempotency_key.';

create index outbound_send_attempts_reconciliation_idx
  on public.outbound_send_attempts (status, updated_at)
  where status = 'indeterminate';

alter table public.outbound_send_attempts enable row level security;
alter table public.outbound_send_attempts force row level security;
revoke all on table public.outbound_send_attempts from public, anon, authenticated, service_role;
grant select on table public.outbound_send_attempts to service_role;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'conversation.outbound_send.reconciled', 'human', 'tenant', true, true,
  'Outbound send reconciled', 'Uncertain provider send reconciled in the audit log'
) on conflict (key) do nothing;

create or replace function public.claim_outbound_send(
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
  p_origin_attempt_number integer default null
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
  ) then
    raise exception 'OUTBOUND_SEND_ORIGIN_REQUIRED';
  end if;
  if p_purpose <> 'agent_reply' and (
    p_origin_receipt_id is not null or p_origin_lease_token is not null
    or p_origin_attempt_number is not null
  ) then raise exception 'OUTBOUND_SEND_ORIGIN_INVALID'; end if;

  select * into conversation_row from public.conversations
  where id = p_conversation_id;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.contact_id <> p_contact_id or conversation_row.channel <> p_channel then
    raise exception 'OUTBOUND_SEND_SCOPE_MISMATCH';
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
    perform app.assert_expected_tenant(
      p_expected_tenant, receipt_row.tenant_id, 'outbound_origin_receipt'
    );
    inbound_provider_message_id := substring(btrim(p_idempotency_key) from '^inbound:[^:]+:(.*)$');
    if inbound_provider_message_id is null or not exists (
      select 1
      from jsonb_array_elements(coalesce(
        receipt_row.payload #> '{normalized,events}', '[]'::jsonb
      )) item
      where item->>'kind' = 'message'
        and item->>'providerMessageId' = inbound_provider_message_id
    ) then
      raise exception 'OUTBOUND_SEND_ORIGIN_PAYLOAD_MISMATCH';
    end if;
    if receipt_row.status not in ('received', 'failed')
      or receipt_row.processed_at is not null
      or receipt_row.lease_token is distinct from p_origin_lease_token
      or receipt_row.attempts <> p_origin_attempt_number
      or receipt_row.lease_expires_at is null
      or receipt_row.lease_expires_at <= clock_timestamp() then
      raise exception 'OUTBOUND_SEND_ORIGIN_LEASE_LOST';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':outbound:' || btrim(p_idempotency_key), 0
  ));
  select candidate.* into attempt
  from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant
    and candidate.idempotency_key = btrim(p_idempotency_key)
  for update;

  if attempt.id is null then
    next_token := gen_random_uuid();
    insert into public.outbound_send_attempts (
      tenant_id, conversation_id, contact_id, identity_id, origin_webhook_event_id,
      idempotency_key, payload_hash,
      purpose, channel, provider, body, status, claim_token, lease_expires_at,
      provider_idempotency_supported
    ) values (
      p_expected_tenant, p_conversation_id, p_contact_id, p_identity_id, p_origin_receipt_id,
      btrim(p_idempotency_key), p_payload_hash, p_purpose, p_channel, p_provider, p_body,
      'claimed', next_token, lease_until, p_provider_idempotency_supported
    );
    return query select 'claimed'::text, next_token, p_identity_id, p_channel,
      null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  if attempt.payload_hash <> p_payload_hash or attempt.conversation_id <> p_conversation_id
    or attempt.contact_id <> p_contact_id or attempt.identity_id <> p_identity_id
    or attempt.purpose <> p_purpose or attempt.channel <> p_channel
    or attempt.provider <> p_provider or attempt.body <> p_body
    or attempt.origin_webhook_event_id is distinct from p_origin_receipt_id then
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
    update public.outbound_send_attempts
    set status = 'indeterminate', updated_at = clock_timestamp(),
      last_error_code = 'CLAIM_EXPIRED_PROVIDER_ACCEPTANCE_UNKNOWN'
    where id = attempt.id;
    return query select 'indeterminate'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz;
    return;
  end if;

  next_token := gen_random_uuid();
  update public.outbound_send_attempts
  set claim_token = next_token, lease_expires_at = lease_until,
    attempt_count = attempt_count + 1, updated_at = clock_timestamp()
  where id = attempt.id;
  return query select attempt.status, next_token, attempt.identity_id, attempt.channel,
    attempt.provider_message_id, attempt.accepted_at, null::uuid, null::bigint, null::timestamptz;
end;
$$;

create or replace function public.record_outbound_provider_acceptance(
  p_expected_tenant uuid,
  p_idempotency_key text,
  p_claim_token uuid,
  p_provider_message_id text,
  p_accepted_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare attempt public.outbound_send_attempts%rowtype;
begin
  if nullif(btrim(p_provider_message_id), '') is null or p_accepted_at is null then
    raise exception 'OUTBOUND_PROVIDER_ACCEPTANCE_INVALID';
  end if;
  select candidate.* into attempt from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant
    and candidate.idempotency_key = btrim(p_idempotency_key)
  for update;
  if attempt.id is null then raise exception 'OUTBOUND_SEND_ATTEMPT_NOT_FOUND'; end if;
  if attempt.claim_token <> p_claim_token then raise exception 'OUTBOUND_SEND_CLAIM_LOST'; end if;
  if attempt.status = 'persisted' then
    return attempt.provider_message_id = btrim(p_provider_message_id);
  end if;
  if attempt.status = 'accepted' then
    return attempt.provider_message_id = btrim(p_provider_message_id);
  end if;
  if attempt.status not in ('claimed', 'indeterminate') then
    raise exception 'OUTBOUND_SEND_ACCEPTANCE_STATE_INVALID';
  end if;
  update public.outbound_send_attempts
  set status = 'accepted', provider_message_id = btrim(p_provider_message_id),
    accepted_at = p_accepted_at, lease_expires_at = clock_timestamp() + interval '2 minutes',
    last_error_code = null, updated_at = clock_timestamp()
  where id = attempt.id;
  return true;
end;
$$;

create or replace function public.mark_outbound_dispatch_indeterminate(
  p_expected_tenant uuid,
  p_idempotency_key text,
  p_claim_token uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.outbound_send_attempts
  set status = 'indeterminate', last_error_code = left(coalesce(nullif(p_error_code, ''),
    'PROVIDER_SEND_UNKNOWN_ERROR'), 200), updated_at = clock_timestamp()
  where tenant_id = p_expected_tenant and idempotency_key = btrim(p_idempotency_key)
    and claim_token = p_claim_token and status = 'claimed';
  if not found then raise exception 'OUTBOUND_SEND_CLAIM_LOST'; end if;
end;
$$;

create or replace function public.release_outbound_send_claim(
  p_expected_tenant uuid,
  p_idempotency_key text,
  p_claim_token uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.outbound_send_attempts
  where tenant_id = p_expected_tenant and idempotency_key = btrim(p_idempotency_key)
    and claim_token = p_claim_token and status = 'claimed'
    and provider_message_id is null;
  if not found then raise exception 'OUTBOUND_SEND_CLAIM_NOT_RELEASABLE'; end if;
end;
$$;

create or replace function public.reconcile_indeterminate_outbound_send(
  p_expected_tenant uuid,
  p_idempotency_key text,
  p_resolution text,
  p_provider_message_id text,
  p_accepted_at timestamptz,
  p_evidence jsonb,
  p_actor_id uuid,
  p_reason text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  attempt public.outbound_send_attempts%rowtype;
  logged_id bigint;
begin
  if p_resolution is null or p_resolution not in ('accepted', 'not_accepted')
    or p_evidence is null or jsonb_typeof(p_evidence) <> 'object' or p_evidence = '{}'::jsonb
    or nullif(btrim(p_reason), '') is null or p_actor_id is null then
    raise exception 'OUTBOUND_RECONCILIATION_EVIDENCE_REQUIRED';
  end if;
  if p_resolution = 'accepted' and (
    nullif(btrim(p_provider_message_id), '') is null or p_accepted_at is null
  ) then
    raise exception 'OUTBOUND_RECONCILIATION_PROVIDER_RECEIPT_REQUIRED';
  end if;

  perform app.assert_actor_not_impersonating(p_actor_id);
  select candidate.* into attempt from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant
    and candidate.idempotency_key = btrim(p_idempotency_key)
  for update;
  if attempt.id is null then raise exception 'OUTBOUND_SEND_ATTEMPT_NOT_FOUND'; end if;
  if attempt.status <> 'indeterminate' then
    raise exception 'OUTBOUND_SEND_NOT_INDETERMINATE';
  end if;

  logged_id := app.write_audit_row(
    'conversation.outbound_send.reconciled', p_actor_id, p_expected_tenant,
    'conversation', attempt.conversation_id::text, p_reason,
    jsonb_build_object(
      'outboundAttemptId', attempt.id,
      'idempotencyKey', attempt.idempotency_key,
      'resolution', p_resolution,
      'providerMessageId', p_provider_message_id,
      'evidence', p_evidence
    )
  );

  if p_resolution = 'accepted' then
    update public.outbound_send_attempts
    set status = 'accepted', provider_message_id = btrim(p_provider_message_id),
      accepted_at = p_accepted_at, lease_expires_at = clock_timestamp() - interval '1 second',
      last_error_code = null, updated_at = clock_timestamp()
    where id = attempt.id;
  else
    delete from public.outbound_send_attempts where id = attempt.id;
  end if;
  return logged_id;
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
  persisted_message_id uuid;
  persisted_created_at timestamptz;
  logged_id bigint;
  audit_action text;
  audit_actor uuid;
begin
  select candidate.* into attempt from public.outbound_send_attempts candidate
  where candidate.tenant_id = p_expected_tenant
    and candidate.idempotency_key = btrim(p_idempotency_key)
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

  insert into public.messages (
    tenant_id, conversation_id, direction, author, body, provider,
    provider_message_id, state_entry_key, is_test
  ) values (
    p_expected_tenant, attempt.conversation_id, 'out',
    case when attempt.purpose = 'human_reply' and p_actor_id is not null
      then 'human:' || p_actor_id::text else 'agent' end,
    attempt.body, attempt.provider, attempt.provider_message_id,
    attempt.idempotency_key, p_is_test
  ) returning id, created_at into persisted_message_id, persisted_created_at;

  update public.conversations set last_message_at = persisted_created_at
  where id = attempt.conversation_id and tenant_id = p_expected_tenant;

  audit_action := case
    when attempt.purpose = 'human_reply' then 'conversation.message.sent.human'
    when attempt.purpose = 'follow_up' then 'followup.completed'
    else 'conversation.channel_continued'
  end;
  audit_actor := case when audit_action = 'conversation.message.sent.human' then p_actor_id else null end;
  logged_id := app.write_audit_row(
    audit_action, audit_actor, p_expected_tenant, 'conversation',
    attempt.conversation_id::text, null,
    jsonb_build_object(
      'messageId', persisted_message_id,
      'purpose', attempt.purpose,
      'providerMessageId', attempt.provider_message_id,
      'outboundAttemptId', attempt.id
    )
  );

  update public.outbound_send_attempts
  set status = 'persisted', message_id = persisted_message_id, audit_id = logged_id,
    persisted_at = persisted_created_at, updated_at = clock_timestamp()
  where id = attempt.id;

  return query select persisted_message_id, logged_id, persisted_created_at;
end;
$$;

revoke all on function public.claim_outbound_send(
  uuid,uuid,uuid,uuid,text,public.messaging_channel,public.channel_provider,text,text,text,boolean,uuid,uuid,integer
) from public, anon, authenticated;
revoke all on function public.record_outbound_provider_acceptance(uuid,text,uuid,text,timestamptz)
  from public, anon, authenticated;
revoke all on function public.mark_outbound_dispatch_indeterminate(uuid,text,uuid,text)
  from public, anon, authenticated;
revoke all on function public.release_outbound_send_claim(uuid,text,uuid)
  from public, anon, authenticated;
revoke all on function public.reconcile_indeterminate_outbound_send(
  uuid,text,text,text,timestamptz,jsonb,uuid,text
) from public, anon, authenticated;
revoke all on function public.persist_claimed_outbound_send(uuid,text,uuid,uuid,text,boolean)
  from public, anon, authenticated;

grant execute on function public.claim_outbound_send(
  uuid,uuid,uuid,uuid,text,public.messaging_channel,public.channel_provider,text,text,text,boolean,uuid,uuid,integer
) to service_role;
grant execute on function public.record_outbound_provider_acceptance(uuid,text,uuid,text,timestamptz)
  to service_role;
grant execute on function public.mark_outbound_dispatch_indeterminate(uuid,text,uuid,text)
  to service_role;
grant execute on function public.release_outbound_send_claim(uuid,text,uuid)
  to service_role;
grant execute on function public.reconcile_indeterminate_outbound_send(
  uuid,text,text,text,timestamptz,jsonb,uuid,text
) to service_role;
grant execute on function public.persist_claimed_outbound_send(uuid,text,uuid,uuid,text,boolean)
  to service_role;
