-- Runtime custody for accepted-but-unpersisted and provider-indeterminate outbound attempts.
--
-- Accepted rows can be finished without another provider call. Indeterminate rows are never sent
-- again automatically: the worker creates an operator alert, and only the existing evidence-
-- requiring human reconciliation RPC can authorize accepted/not-accepted resolution.

alter table public.outbound_send_attempts
  add column reconciliation_attempts integer not null default 0
    check (reconciliation_attempts >= 0),
  add column reconciliation_next_attempt_at timestamptz,
  add column reconciliation_alerted_at timestamptz,
  add column reconciliation_audit_id bigint references public.audit_log(id) on delete restrict;

-- Recover bindings for attempts created between the atomic-send migration and this runtime worker.
-- A missing/ambiguous historical receipt remains unbound and therefore cannot be silently requeued.
update public.outbound_send_attempts attempt
set origin_webhook_event_id = (
  select event.id
  from public.webhook_events event
  where event.tenant_id = attempt.tenant_id
    and exists (
      select 1
      from jsonb_array_elements(coalesce(event.payload #> '{normalized,events}', '[]'::jsonb)) item
      where item->>'kind' = 'message'
        and item->>'providerMessageId' = substring(attempt.idempotency_key from '^inbound:[^:]+:(.*)$')
    )
  order by event.received_at, event.id
  limit 1
)
where attempt.purpose = 'agent_reply'
  and attempt.origin_webhook_event_id is null
  and attempt.idempotency_key ~ '^inbound:[^:]+:.+';

create index outbound_send_attempts_runtime_reconciliation_idx
  on public.outbound_send_attempts (
    reconciliation_next_attempt_at, lease_expires_at, updated_at, id
  )
  where status in ('claimed', 'accepted', 'indeterminate');

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'conversation.outbound_send.reconciliation_required', 'system', 'tenant', false, true,
  'Outbound send needs reconciliation',
  'Uncertain provider send recorded for evidence-backed reconciliation'
) on conflict (key) do nothing;

insert into public.alert_rules (
  event_key, scope, name, description, category, audience_roles,
  include_success_owner, include_billing_contact, default_destinations,
  suppressible, default_enabled, email_subject, email_body, slack_text
)
values
  (
    'conversation.outbound_send_unconfirmed', 'tenant',
    'Outbound send needs reconciliation',
    'Provider acceptance is uncertain and automatic resend is blocked.',
    'conversation', '{coach}', true, false, '{bell}', false, true,
    'Outbound send needs reconciliation',
    'A provider send is blocked pending evidence-backed reconciliation.',
    'A provider send is blocked pending evidence-backed reconciliation.'
  ),
  (
    'conversation.outbound_send_unconfirmed', 'platform',
    'Outbound send needs reconciliation',
    'Provider acceptance is uncertain and automatic resend is blocked.',
    'conversation', '{owner,admin}', false, false, '{bell}', false, true,
    'Outbound send needs reconciliation',
    'A provider send is blocked pending evidence-backed reconciliation.',
    'A provider send is blocked pending evidence-backed reconciliation.'
  )
on conflict (event_key, scope) do nothing;

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
  if attempt.purpose = 'agent_reply' and attempt.origin_webhook_event_id is null then
    raise exception 'OUTBOUND_RECONCILIATION_ORIGIN_REQUIRED';
  end if;
  if not (p_evidence ?& array[
      'provider','channel','kind','evidenceId','result','providerMessageId','observedAt'
    ]) or p_evidence - array[
      'provider','channel','kind','evidenceId','result','providerMessageId','observedAt'
    ] <> '{}'::jsonb
    or p_evidence->>'provider' <> attempt.provider::text
    or p_evidence->>'channel' <> attempt.channel::text
    or p_evidence->>'kind' not in ('provider_receipt', 'provider_readback')
    or nullif(btrim(p_evidence->>'evidenceId'), '') is null
    or char_length(p_evidence->>'evidenceId') > 500
    or nullif(btrim(p_evidence->>'observedAt'), '') is null
    or (p_evidence->>'observedAt')::timestamptz is null then
    raise exception 'OUTBOUND_RECONCILIATION_EVIDENCE_INVALID';
  end if;
  if p_resolution = 'accepted' and (
    p_evidence->>'result' <> 'accepted'
    or jsonb_typeof(p_evidence->'providerMessageId') <> 'string'
    or p_evidence->>'providerMessageId' <> btrim(p_provider_message_id)
  ) then
    raise exception 'OUTBOUND_RECONCILIATION_ACCEPTANCE_EVIDENCE_INVALID';
  end if;
  if p_resolution = 'not_accepted' and (
    p_provider_message_id is not null or p_accepted_at is not null
    or p_evidence->>'kind' <> 'provider_readback'
    or p_evidence->>'result' <> 'not_found'
    or jsonb_typeof(p_evidence->'providerMessageId') <> 'null'
  ) then
    raise exception 'OUTBOUND_RECONCILIATION_NONACCEPTANCE_EVIDENCE_INVALID';
  end if;

  logged_id := app.write_audit_row(
    'conversation.outbound_send.reconciled', p_actor_id, p_expected_tenant,
    'conversation', attempt.conversation_id::text, p_reason,
    jsonb_build_object(
      'outboundAttemptId', attempt.id,
      'idempotencyKey', attempt.idempotency_key,
      'resolution', p_resolution,
      'providerMessageId', p_provider_message_id,
      'originWebhookEventId', attempt.origin_webhook_event_id,
      'evidence', p_evidence
    )
  );

  if attempt.origin_webhook_event_id is not null then
    update public.webhook_events
    set status = 'failed', attempts = 0,
      error = case when p_resolution = 'accepted'
        then 'OUTBOUND_RECONCILED_ACCEPTED_PENDING_PERSISTENCE'
        else 'OUTBOUND_RECONCILED_NOT_ACCEPTED_RETRY_AUTHORIZED' end,
      processed_at = null, next_attempt_at = clock_timestamp(),
      lease_token = null, lease_expires_at = null
    where id = attempt.origin_webhook_event_id and tenant_id = p_expected_tenant;
    if not found then raise exception 'OUTBOUND_RECONCILIATION_ORIGIN_LOST'; end if;
  end if;

  if p_resolution = 'accepted' then
    update public.outbound_send_attempts
    set status = 'accepted', provider_message_id = btrim(p_provider_message_id),
      accepted_at = p_accepted_at, claim_token = gen_random_uuid(),
      lease_expires_at = clock_timestamp() - interval '1 second',
      reconciliation_next_attempt_at = clock_timestamp(),
      last_error_code = null, updated_at = clock_timestamp()
    where id = attempt.id;
  else
    -- Provider read-back proves this attempt was never accepted. Authorize only the linked,
    -- incomplete inbound turn to regenerate after any emitted booking slots expire; completed or
    -- provider-persisted turns remain immutable.
    update public.inbound_engine_turns turn
    set unsent_refresh_authorized_at = clock_timestamp()
    from public.messages inbound_message
    where turn.inbound_message_id = inbound_message.id
      and turn.tenant_id = p_expected_tenant
      and turn.conversation_id = attempt.conversation_id
      and turn.result_persisted_at is null
      and inbound_message.tenant_id = p_expected_tenant
      and inbound_message.conversation_id = attempt.conversation_id
      and inbound_message.direction = 'in'
      and inbound_message.author = 'lead'
      and inbound_message.provider_message_id = substring(attempt.idempotency_key from '^inbound:[^:]+:(.*)$');
    delete from public.outbound_send_attempts where id = attempt.id;
  end if;
  return logged_id;
end;
$$;

create or replace function public.claim_outbound_reconciliation_batch(
  p_limit integer,
  p_lease_seconds integer,
  p_now timestamptz
)
returns table (
  attempt_id uuid,
  tenant_id uuid,
  conversation_id uuid,
  idempotency_key text,
  disposition text,
  claim_token uuid,
  provider_message_id text,
  accepted_at timestamptz,
  error_code text,
  is_test boolean,
  reconciliation_attempt integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform app.assert_not_impersonating();
  if p_limit is null or p_limit < 1 or p_limit > 100
    or p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900
    or p_now is null then
    raise exception 'OUTBOUND_RECONCILIATION_CLAIM_INVALID';
  end if;

  return query
  with candidates as (
    select attempt.id
    from public.outbound_send_attempts attempt
    where attempt.status in ('claimed', 'accepted', 'indeterminate')
      and attempt.lease_expires_at <= p_now
      and (attempt.reconciliation_next_attempt_at is null
        or attempt.reconciliation_next_attempt_at <= p_now)
      and (
        attempt.status = 'accepted'
        or (attempt.status = 'claimed' and not attempt.provider_idempotency_supported)
        or (attempt.status = 'indeterminate' and attempt.reconciliation_alerted_at is null)
      )
    order by case when attempt.status = 'accepted' then 0 else 1 end,
      attempt.updated_at, attempt.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update public.outbound_send_attempts attempt
    set status = case when attempt.status = 'claimed' then 'indeterminate' else attempt.status end,
      last_error_code = case when attempt.status = 'claimed'
        then 'CLAIM_EXPIRED_PROVIDER_ACCEPTANCE_UNKNOWN'
        else attempt.last_error_code end,
      lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
      claim_token = gen_random_uuid(),
      reconciliation_attempts = attempt.reconciliation_attempts + 1,
      reconciliation_next_attempt_at = null,
      updated_at = p_now
    from candidates
    where attempt.id = candidates.id
    returning attempt.*
  )
  select claimed.id, claimed.tenant_id, claimed.conversation_id,
    claimed.idempotency_key, claimed.status, claimed.claim_token,
    claimed.provider_message_id, claimed.accepted_at, claimed.last_error_code,
    contact.is_test, claimed.reconciliation_attempts
  from claimed
  join public.contacts contact on contact.id = claimed.contact_id
  order by case when claimed.status = 'accepted' then 0 else 1 end,
    claimed.updated_at, claimed.id;
end;
$$;

create or replace function public.finish_outbound_reconciliation_attempt(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_error text,
  p_retry_at timestamptz,
  p_now timestamptz
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
  perform app.assert_not_impersonating();
  if p_outcome is null or p_outcome not in ('alerted', 'retry') or p_now is null then
    raise exception 'OUTBOUND_RECONCILIATION_FINISH_INVALID';
  end if;
  if p_outcome = 'retry' and (p_retry_at is null or p_retry_at <= p_now
    or nullif(btrim(p_error), '') is null) then
    raise exception 'OUTBOUND_RECONCILIATION_RETRY_INVALID';
  end if;

  select candidate.* into attempt
  from public.outbound_send_attempts candidate
  where candidate.id = p_attempt_id and candidate.claim_token = p_claim_token
  for update;
  if attempt.id is null or attempt.status not in ('accepted', 'indeterminate') then
    raise exception 'OUTBOUND_RECONCILIATION_CLAIM_LOST';
  end if;

  if p_outcome = 'alerted' then
    if attempt.status <> 'indeterminate' then
      raise exception 'OUTBOUND_RECONCILIATION_ALERT_STATE_INVALID';
    end if;
    logged_id := app.write_audit_row(
      'conversation.outbound_send.reconciliation_required', null, attempt.tenant_id,
      'conversation', attempt.conversation_id::text, null,
      jsonb_build_object(
        'outboundAttemptId', attempt.id,
        'idempotencyKey', attempt.idempotency_key,
        'errorCode', attempt.last_error_code,
        'reconciliationAttempt', attempt.reconciliation_attempts
      )
    );
    update public.outbound_send_attempts
    set reconciliation_alerted_at = p_now, reconciliation_audit_id = logged_id,
      reconciliation_next_attempt_at = null,
      lease_expires_at = p_now - interval '1 second', updated_at = p_now
    where id = attempt.id;
    return logged_id;
  end if;

  update public.outbound_send_attempts
  set reconciliation_next_attempt_at = p_retry_at,
    lease_expires_at = p_now - interval '1 second',
    last_error_code = left(btrim(p_error), 200), updated_at = p_now
  where id = attempt.id;
  return null;
end;
$$;

revoke all on function public.claim_outbound_reconciliation_batch(integer,integer,timestamptz)
  from public, anon, authenticated;
revoke all on function public.finish_outbound_reconciliation_attempt(
  uuid,uuid,text,text,timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.claim_outbound_reconciliation_batch(integer,integer,timestamptz)
  to service_role;
grant execute on function public.finish_outbound_reconciliation_attempt(
  uuid,uuid,text,text,timestamptz,timestamptz
) to service_role;
