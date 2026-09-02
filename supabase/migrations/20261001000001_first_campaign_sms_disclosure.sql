-- Append the carrier disclosure to the first campaign-initiated SMS for an identity.
--
-- The choice is made inside the same atomic claim that reserves provider dispatch. An
-- identity-scoped advisory lock serializes different idempotency keys, while the attempt row
-- preserves the exact effective body for retries and reconciliation. A claim released before
-- any provider request cascades its evidence, allowing the next real attempt to remain first.

alter table public.outbound_send_attempts
  add column campaign_initiated boolean not null default false,
  add column first_campaign_disclosure_appended boolean not null default false,
  add constraint outbound_send_attempts_disclosure_scope_check check (
    not first_campaign_disclosure_appended or (campaign_initiated and channel = 'sms')
  );

comment on column public.outbound_send_attempts.campaign_initiated is
  'True when the send is not a reply-in-turn or a STOP/HELP/START control response.';
comment on column public.outbound_send_attempts.first_campaign_disclosure_appended is
  'True only when body is the immutable effective first-campaign SMS body including the platform disclosure.';

create table public.sms_first_campaign_disclosures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  identity_id uuid not null references public.contact_identities(id) on delete restrict,
  outbound_send_attempt_id uuid not null unique
    references public.outbound_send_attempts(id) on delete cascade,
  disclosure_text text not null check (
    disclosure_text = 'Msg & data rates may apply. Reply STOP to opt out.'
  ),
  effective_body_hash text not null check (effective_body_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  unique (tenant_id, identity_id)
);

comment on table public.sms_first_campaign_disclosures is
  'Service-owned immutable evidence naming the attempt that carried an identity first campaign SMS disclosure.';

alter table public.sms_first_campaign_disclosures enable row level security;
alter table public.sms_first_campaign_disclosures force row level security;
revoke all on table public.sms_first_campaign_disclosures from public, anon, authenticated, service_role;
grant select on table public.sms_first_campaign_disclosures to service_role;

drop function if exists public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer, uuid
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
  p_human_actor_id uuid default null,
  p_campaign_initiated boolean default false,
  p_content_kind text default 'freeform'
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
  persisted_at timestamptz,
  effective_body text,
  first_campaign_disclosure_appended boolean
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
  carrier_disclosure constant text := 'Msg & data rates may apply. Reply STOP to opt out.';
  claimed_body text := p_body;
  append_disclosure boolean := false;
begin
  if nullif(btrim(p_idempotency_key), '') is null or char_length(p_idempotency_key) > 200
    or p_payload_hash !~ '^[0-9a-f]{64}$' or nullif(btrim(p_body), '') is null
    or p_content_kind not in ('freeform', 'approved_template') then
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
    if p_campaign_initiated and p_channel = 'sms' then
      perform pg_advisory_xact_lock(hashtextextended(
        p_expected_tenant::text || ':first-campaign-sms:' || p_identity_id::text, 0
      ));
      append_disclosure := not exists (
        select 1 from public.sms_first_campaign_disclosures evidence
        where evidence.tenant_id = p_expected_tenant and evidence.identity_id = p_identity_id
      );
      if append_disclosure and p_content_kind <> 'freeform' then
        raise exception 'SMS_FIRST_CAMPAIGN_DISCLOSURE_REQUIRES_FREEFORM';
      end if;
      if append_disclosure then
        claimed_body := rtrim(p_body) || E'\n\n' || carrier_disclosure;
      end if;
    end if;

    next_token := gen_random_uuid();
    insert into public.outbound_send_attempts (
      tenant_id, conversation_id, contact_id, identity_id, origin_webhook_event_id,
      idempotency_key, payload_hash, purpose, channel, provider, body, human_actor_id,
      status, claim_token, lease_expires_at, provider_idempotency_supported,
      campaign_initiated, first_campaign_disclosure_appended
    ) values (
      p_expected_tenant, p_conversation_id, p_contact_id, p_identity_id, p_origin_receipt_id,
      btrim(p_idempotency_key), p_payload_hash, p_purpose, p_channel, p_provider, claimed_body,
      p_human_actor_id, 'claimed', next_token, lease_until, p_provider_idempotency_supported,
      p_campaign_initiated, append_disclosure
    ) returning * into attempt;

    if append_disclosure then
      insert into public.sms_first_campaign_disclosures (
        tenant_id, identity_id, outbound_send_attempt_id, disclosure_text, effective_body_hash
      ) values (
        p_expected_tenant, p_identity_id, attempt.id, carrier_disclosure,
        encode(extensions.digest(claimed_body, 'sha256'), 'hex')
      );
    end if;

    return query select 'claimed'::text, next_token, p_identity_id, p_channel,
      null::text, null::timestamptz, null::uuid, null::bigint, null::timestamptz,
      attempt.body, attempt.first_campaign_disclosure_appended;
    return;
  end if;

  if attempt.payload_hash <> p_payload_hash or attempt.conversation_id <> p_conversation_id
    or attempt.contact_id <> p_contact_id or attempt.identity_id <> p_identity_id
    or attempt.purpose <> p_purpose or attempt.channel <> p_channel or attempt.provider <> p_provider
    or attempt.campaign_initiated <> p_campaign_initiated
    or attempt.body <> (case when attempt.first_campaign_disclosure_appended
      then rtrim(p_body) || E'\n\n' || carrier_disclosure else p_body end)
    or attempt.origin_webhook_event_id is distinct from p_origin_receipt_id
    or attempt.human_actor_id is distinct from p_human_actor_id then
    raise exception 'OUTBOUND_SEND_IDEMPOTENCY_CONFLICT';
  end if;
  if attempt.status = 'persisted' then
    return query select 'persisted'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, attempt.provider_message_id, attempt.accepted_at, attempt.message_id,
      attempt.audit_id, attempt.persisted_at, attempt.body,
      attempt.first_campaign_disclosure_appended;
    return;
  end if;
  if attempt.status = 'indeterminate' then
    return query select 'indeterminate'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, null::text, null::timestamptz, null::uuid, null::bigint,
      null::timestamptz, attempt.body, attempt.first_campaign_disclosure_appended;
    return;
  end if;
  if attempt.lease_expires_at > clock_timestamp() then
    return query select 'in_progress'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, attempt.provider_message_id, attempt.accepted_at, null::uuid,
      null::bigint, null::timestamptz, attempt.body, attempt.first_campaign_disclosure_appended;
    return;
  end if;
  if attempt.status = 'claimed' and not attempt.provider_idempotency_supported then
    update public.outbound_send_attempts set status = 'indeterminate', updated_at = clock_timestamp(),
      last_error_code = 'CLAIM_EXPIRED_PROVIDER_ACCEPTANCE_UNKNOWN' where id = attempt.id;
    return query select 'indeterminate'::text, attempt.claim_token, attempt.identity_id,
      attempt.channel, null::text, null::timestamptz, null::uuid, null::bigint,
      null::timestamptz, attempt.body, attempt.first_campaign_disclosure_appended;
    return;
  end if;
  next_token := gen_random_uuid();
  update public.outbound_send_attempts set claim_token = next_token, lease_expires_at = lease_until,
    attempt_count = attempt_count + 1, updated_at = clock_timestamp() where id = attempt.id;
  return query select attempt.status, next_token, attempt.identity_id, attempt.channel,
    attempt.provider_message_id, attempt.accepted_at, null::uuid, null::bigint,
    null::timestamptz, attempt.body, attempt.first_campaign_disclosure_appended;
end;
$$;

revoke execute on function public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer, uuid, boolean, text
) from public, anon, authenticated;
grant execute on function public.claim_outbound_send(
  uuid, uuid, uuid, uuid, text, public.messaging_channel, public.channel_provider,
  text, text, text, boolean, uuid, uuid, integer, uuid, boolean, text
) to service_role;
