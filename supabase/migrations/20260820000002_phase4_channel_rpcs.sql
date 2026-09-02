-- Phase 4 transactional channel contract: atomic inbound identity/window persistence, provider
-- cutover, reversible contact merge, and template submission.
--
-- These functions are service-role entry points. Every human mutation resolves a real actor,
-- asserts the expected tenant, refuses impersonated writes, hashes the complete replay payload,
-- and writes its registered audit row in the same transaction as the state change.

set search_path = public, extensions;

create or replace function app.phase4_json_hash(p_payload jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(convert_to(p_payload::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function app.phase4_assert_tenant_actor(
  p_expected_tenant uuid,
  p_actor_id uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor_row public.users%rowtype;
  success_owner_id uuid;
begin
  perform app.assert_not_impersonating();
  if p_expected_tenant is null then raise exception 'EXPECTED_TENANT_REQUIRED'; end if;
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null then raise exception 'PHASE4_ACTOR_REQUIRED'; end if;

  if actor_row.role = 'coach' and actor_row.tenant_id = p_expected_tenant then return; end if;
  if actor_row.role in ('owner', 'admin') then return; end if;
  if actor_row.role = 'success' then
    select success_owner into success_owner_id
    from public.tenants where id = p_expected_tenant;
    if success_owner_id = p_actor_id then return; end if;
  end if;
  raise exception 'PHASE4_ACTOR_NOT_AUTHORIZED';
end;
$$;

drop function if exists public.persist_inbound_message(
  uuid, public.channel_provider, public.messaging_channel, text, text, text, text
);

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
  identity_row public.contact_identities%rowtype;
  contact_row public.contacts%rowtype;
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
    select c.* into contact_row from public.contacts c where c.id = identity_row.contact_id for update;
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
        last_seen_at = p_provider_window_observed_at,
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

create or replace function public.switch_channel_provider(
  p_expected_tenant uuid,
  p_channel public.messaging_channel,
  p_outgoing_connection_id uuid,
  p_incoming_connection_id uuid,
  p_backfill jsonb,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns table (
  state public.channel_state,
  applied_identity_count integer,
  audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  outgoing_row public.channel_connections%rowtype;
  incoming_row public.channel_connections%rowtype;
  receipt_row public.channel_operation_receipts%rowtype;
  payload jsonb;
  payload_hash text;
  open_count integer;
  applied_count integer;
  written_audit_id bigint;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'PROVIDER_SWITCH_REASON_REQUIRED'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  if jsonb_typeof(p_backfill) <> 'array' then raise exception 'IDENTITY_BACKFILL_INVALID'; end if;

  payload := jsonb_build_object(
    'channel', p_channel, 'outgoingConnectionId', p_outgoing_connection_id,
    'incomingConnectionId', p_incoming_connection_id, 'backfill', p_backfill,
    'actorUserId', p_actor_id, 'reason', btrim(p_reason)
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':switch_provider:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt_row from public.channel_operation_receipts
  where tenant_id = p_expected_tenant and operation = 'switch_provider'
    and idempotency_key = btrim(p_idempotency_key);
  if receipt_row.id is not null then
    if receipt_row.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt_row.result ->> 'state')::public.channel_state,
      (receipt_row.result ->> 'appliedIdentityCount')::integer,
      receipt_row.audit_id;
    return;
  end if;

  select * into outgoing_row from public.channel_connections
  where id = p_outgoing_connection_id for update;
  select * into incoming_row from public.channel_connections
  where id = p_incoming_connection_id for update;
  if outgoing_row.id is null or incoming_row.id is null then raise exception 'CHANNEL_CONNECTION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, outgoing_row.tenant_id, 'outgoing_connection');
  perform app.assert_expected_tenant(p_expected_tenant, incoming_row.tenant_id, 'incoming_connection');
  if outgoing_row.channel <> p_channel or incoming_row.channel <> p_channel
    or outgoing_row.provider = incoming_row.provider then
    raise exception 'CHANNEL_PROVIDER_SWITCH_PAIR_INVALID';
  end if;
  if outgoing_row.state <> 'live' or incoming_row.state <> 'ready' then
    raise exception 'CHANNEL_PROVIDER_SWITCH_STATE_INVALID';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_backfill) item
    where jsonb_typeof(item) <> 'object'
      or nullif(btrim(item ->> 'outgoingExternalId'), '') is null
      or nullif(btrim(item ->> 'incomingExternalId'), '') is null
      or nullif(btrim(item ->> 'contactId'), '') is null
  ) then raise exception 'IDENTITY_BACKFILL_INVALID'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_backfill) item
    group by item ->> 'contactId' having count(*) > 1
  ) or exists (
    select 1 from jsonb_array_elements(p_backfill) item
    group by item ->> 'incomingExternalId' having count(*) > 1
  ) then raise exception 'IDENTITY_BACKFILL_DUPLICATE'; end if;

  select count(distinct c.contact_id)::integer into open_count
  from public.conversations c
  join public.contacts contact on contact.id = c.contact_id
  where c.tenant_id = p_expected_tenant and c.channel = p_channel
    and c.status in ('agent', 'needs_human', 'human', 'nurture')
    and contact.merged_into_contact_id is null;
  if exists (
    select 1
    from (
      select distinct c.contact_id
      from public.conversations c
      join public.contacts contact on contact.id = c.contact_id
      where c.tenant_id = p_expected_tenant and c.channel = p_channel
        and c.status in ('agent', 'needs_human', 'human', 'nurture')
        and contact.merged_into_contact_id is null
    ) open_contact
    where not exists (
      select 1 from jsonb_array_elements(p_backfill) item
      where (item ->> 'contactId')::uuid = open_contact.contact_id
    )
  ) then raise exception 'IDENTITY_BACKFILL_REQUIRED'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_backfill) item
    left join public.contact_identities identity
      on identity.tenant_id = p_expected_tenant
      and identity.contact_id = (item ->> 'contactId')::uuid
      and identity.provider = outgoing_row.provider
      and identity.channel = p_channel
      and identity.provider_identity_id = item ->> 'outgoingExternalId'
    where identity.id is null
  ) then raise exception 'OUTGOING_IDENTITY_BACKFILL_INVALID'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_backfill) item
    join public.contact_identities identity
      on identity.tenant_id = p_expected_tenant
      and identity.provider = incoming_row.provider
      and identity.channel = p_channel
      and identity.provider_identity_id = item ->> 'incomingExternalId'
    where identity.contact_id <> (item ->> 'contactId')::uuid
  ) then raise exception 'INCOMING_IDENTITY_CONFLICT'; end if;

  insert into public.contact_identities (
    tenant_id, contact_id, provider, channel, provider_identity_id,
    normalized_phone, normalized_email, consent_state, consent_source,
    consent_captured_at, consent_expires_at
  )
  select p_expected_tenant, outgoing_identity.contact_id, incoming_row.provider, p_channel,
    item ->> 'incomingExternalId', outgoing_identity.normalized_phone,
    outgoing_identity.normalized_email, outgoing_identity.consent_state,
    outgoing_identity.consent_source, outgoing_identity.consent_captured_at,
    outgoing_identity.consent_expires_at
  from jsonb_array_elements(p_backfill) item
  join public.contact_identities outgoing_identity
    on outgoing_identity.tenant_id = p_expected_tenant
    and outgoing_identity.contact_id = (item ->> 'contactId')::uuid
    and outgoing_identity.provider = outgoing_row.provider
    and outgoing_identity.channel = p_channel
    and outgoing_identity.provider_identity_id = item ->> 'outgoingExternalId'
  on conflict (tenant_id, provider, channel, provider_identity_id) do update
  set normalized_phone = excluded.normalized_phone,
      normalized_email = excluded.normalized_email,
      consent_state = excluded.consent_state,
      consent_source = excluded.consent_source,
      consent_captured_at = excluded.consent_captured_at,
      consent_expires_at = excluded.consent_expires_at;
  get diagnostics applied_count = row_count;

  update public.channel_connections set state = 'disconnected', updated_at = now()
  where id = outgoing_row.id;
  update public.channel_connections set state = 'live', updated_at = now()
  where id = incoming_row.id;

  written_audit_id := app.write_audit_row(
    'channel.provider.switched', p_actor_id, p_expected_tenant,
    'channel_connection', incoming_row.id::text, btrim(p_reason),
    jsonb_build_object(
      'prior', jsonb_build_object(
        'outgoingConnectionId', outgoing_row.id, 'outgoingState', outgoing_row.state,
        'incomingConnectionId', incoming_row.id, 'incomingState', incoming_row.state
      ),
      'new', jsonb_build_object(
        'outgoingState', 'disconnected', 'incomingState', 'live',
        'appliedIdentityCount', applied_count, 'openContactCount', open_count
      )
    )
  );
  insert into public.channel_operation_receipts (
    tenant_id, operation, idempotency_key, payload_hash, result, audit_id
  ) values (
    p_expected_tenant, 'switch_provider', btrim(p_idempotency_key), payload_hash,
    jsonb_build_object('state', 'live', 'appliedIdentityCount', applied_count),
    written_audit_id
  );
  return query select 'live'::public.channel_state, applied_count, written_audit_id;
end;
$$;

create or replace function public.merge_contacts(
  p_expected_tenant uuid,
  p_winner_id uuid,
  p_loser_id uuid,
  p_source text,
  p_evidence_id text,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns table (
  winner_id uuid,
  loser_id uuid,
  merge_audit_id bigint,
  moved_identity_count integer,
  moved_conversation_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  winner public.contacts%rowtype;
  loser public.contacts%rowtype;
  receipt_row public.channel_operation_receipts%rowtype;
  identities_before jsonb;
  conversations_before jsonb;
  candidates_before jsonb;
  payload jsonb;
  payload_hash text;
  written_audit_id bigint;
  identity_count integer;
  conversation_count integer;
  newest_is_loser boolean;
  merged_outcome public.outcome;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if p_winner_id = p_loser_id then raise exception 'CONTACT_MERGE_SELF_FORBIDDEN'; end if;
  if p_source not in ('provider_asserted', 'lead_asserted', 'human_asserted') then
    raise exception 'CONTACT_MERGE_SOURCE_INVALID';
  end if;
  if p_source <> 'human_asserted' and nullif(btrim(p_evidence_id), '') is null then
    raise exception 'CONTACT_MERGE_EVIDENCE_REQUIRED';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'CONTACT_MERGE_REASON_REQUIRED'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;

  payload := jsonb_build_object(
    'winnerId', p_winner_id, 'loserId', p_loser_id, 'source', p_source,
    'evidenceId', nullif(btrim(p_evidence_id), ''), 'actorUserId', p_actor_id,
    'reason', btrim(p_reason)
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':merge_contacts:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt_row from public.channel_operation_receipts
  where tenant_id = p_expected_tenant and operation = 'merge_contacts'
    and idempotency_key = btrim(p_idempotency_key);
  if receipt_row.id is not null then
    if receipt_row.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt_row.result ->> 'winnerId')::uuid,
      (receipt_row.result ->> 'loserId')::uuid,
      receipt_row.audit_id,
      (receipt_row.result ->> 'movedIdentityCount')::integer,
      (receipt_row.result ->> 'movedConversationCount')::integer;
    return;
  end if;

  perform 1 from public.contacts
  where id in (p_winner_id, p_loser_id) order by id for update;
  select * into winner from public.contacts where id = p_winner_id;
  select * into loser from public.contacts where id = p_loser_id;
  if winner.id is null or loser.id is null then raise exception 'CONTACT_MERGE_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, winner.tenant_id, 'winner_contact');
  perform app.assert_expected_tenant(p_expected_tenant, loser.tenant_id, 'loser_contact');
  if winner.merged_into_contact_id is not null or loser.merged_into_contact_id is not null then
    raise exception 'CONTACT_MERGE_STATE_CONFLICT';
  end if;
  if winner.is_test <> loser.is_test then raise exception 'CONTACT_MERGE_TEST_MISMATCH'; end if;

  select coalesce(jsonb_agg(to_jsonb(identity) order by identity.id), '[]'::jsonb)
  into identities_before from public.contact_identities identity
  where identity.contact_id = p_loser_id;
  select coalesce(jsonb_agg(to_jsonb(conversation) order by conversation.id), '[]'::jsonb)
  into conversations_before from public.conversations conversation
  where conversation.contact_id = p_loser_id;
  select coalesce(jsonb_agg(to_jsonb(candidate) order by candidate.id), '[]'::jsonb)
  into candidates_before from public.contact_duplicate_candidates candidate
  where candidate.tenant_id = p_expected_tenant
    and candidate.contact_a_id = least(p_winner_id, p_loser_id)
    and candidate.contact_b_id = greatest(p_winner_id, p_loser_id);

  newest_is_loser := loser.updated_at > winner.updated_at;
  merged_outcome := case
    when winner.outcome = 'BOOK' or loser.outcome = 'BOOK' then 'BOOK'::public.outcome
    when winner.outcome = 'SOFT_DQ' or loser.outcome = 'SOFT_DQ' then 'SOFT_DQ'::public.outcome
    when winner.outcome = 'HARD_DQ' or loser.outcome = 'HARD_DQ' then 'HARD_DQ'::public.outcome
    else null
  end;

  written_audit_id := app.write_audit_row(
    'contact.merged', p_actor_id, p_expected_tenant, 'contact', p_winner_id::text,
    btrim(p_reason),
    jsonb_build_object(
      'source', p_source, 'evidenceId', nullif(btrim(p_evidence_id), ''),
      'prior', jsonb_build_object(
        'winner', to_jsonb(winner), 'loser', to_jsonb(loser),
        'identities', identities_before, 'conversations', conversations_before,
        'candidates', candidates_before
      ),
      'new', jsonb_build_object(
        'winnerId', p_winner_id, 'loserMergedInto', p_winner_id,
        'optedOut', winner.opted_out or loser.opted_out,
        'outcome', merged_outcome
      )
    )
  );

  update public.contact_identities set contact_id = p_winner_id
  where contact_id = p_loser_id;
  get diagnostics identity_count = row_count;
  update public.conversations set contact_id = p_winner_id
  where contact_id = p_loser_id;
  get diagnostics conversation_count = row_count;

  update public.contacts
  set opted_out = winner.opted_out or loser.opted_out,
      credit_range = case when newest_is_loser then coalesce(loser.credit_range, winner.credit_range)
        else coalesce(winner.credit_range, loser.credit_range) end,
      funding_goal = case when newest_is_loser then coalesce(loser.funding_goal, winner.funding_goal)
        else coalesce(winner.funding_goal, loser.funding_goal) end,
      timeline = case when newest_is_loser then coalesce(loser.timeline, winner.timeline)
        else coalesce(winner.timeline, loser.timeline) end,
      business_stage = case when newest_is_loser then coalesce(loser.business_stage, winner.business_stage)
        else coalesce(winner.business_stage, loser.business_stage) end,
      annual_revenue_cents = case when newest_is_loser then coalesce(loser.annual_revenue_cents, winner.annual_revenue_cents)
        else coalesce(winner.annual_revenue_cents, loser.annual_revenue_cents) end,
      business_context = case when newest_is_loser then coalesce(loser.business_context, winner.business_context)
        else coalesce(winner.business_context, loser.business_context) end,
      dq_reason = case when newest_is_loser then coalesce(loser.dq_reason, winner.dq_reason)
        else coalesce(winner.dq_reason, loser.dq_reason) end,
      outcome = merged_outcome,
      updated_at = now()
  where id = p_winner_id;

  update public.contacts
  set merged_into_contact_id = p_winner_id, merged_at = now(), merge_audit_id = written_audit_id,
      updated_at = now()
  where id = p_loser_id;
  update public.contact_duplicate_candidates
  set state = 'merged', resolved_at = now(), resolved_by = p_actor_id, updated_at = now()
  where tenant_id = p_expected_tenant
    and contact_a_id = least(p_winner_id, p_loser_id)
    and contact_b_id = greatest(p_winner_id, p_loser_id);

  insert into public.channel_operation_receipts (
    tenant_id, operation, idempotency_key, payload_hash, result, audit_id
  ) values (
    p_expected_tenant, 'merge_contacts', btrim(p_idempotency_key), payload_hash,
    jsonb_build_object(
      'winnerId', p_winner_id, 'loserId', p_loser_id,
      'movedIdentityCount', identity_count, 'movedConversationCount', conversation_count
    ), written_audit_id
  );
  return query select p_winner_id, p_loser_id, written_audit_id, identity_count, conversation_count;
end;
$$;

create or replace function public.unmerge_contact(
  p_expected_tenant uuid,
  p_merge_audit_id bigint,
  p_actor_id uuid,
  p_reason text,
  p_idempotency_key text
)
returns table (
  winner_id uuid,
  loser_id uuid,
  unmerge_audit_id bigint,
  restored_identity_count integer,
  restored_conversation_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  merge_log public.audit_log%rowtype;
  receipt_row public.channel_operation_receipts%rowtype;
  winner_snapshot jsonb;
  loser_snapshot jsonb;
  identities_snapshot jsonb;
  conversations_snapshot jsonb;
  candidates_snapshot jsonb;
  current_loser public.contacts%rowtype;
  payload jsonb;
  payload_hash text;
  winner_uuid uuid;
  loser_uuid uuid;
  expected_count integer;
  restored_identities integer;
  restored_conversations integer;
  written_audit_id bigint;
  candidate jsonb;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_reason), '') is null then raise exception 'CONTACT_UNMERGE_REASON_REQUIRED'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;
  payload := jsonb_build_object(
    'mergeAuditId', p_merge_audit_id, 'actorUserId', p_actor_id, 'reason', btrim(p_reason)
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':unmerge_contact:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt_row from public.channel_operation_receipts
  where tenant_id = p_expected_tenant and operation = 'unmerge_contact'
    and idempotency_key = btrim(p_idempotency_key);
  if receipt_row.id is not null then
    if receipt_row.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt_row.result ->> 'winnerId')::uuid,
      (receipt_row.result ->> 'loserId')::uuid,
      receipt_row.audit_id,
      (receipt_row.result ->> 'restoredIdentityCount')::integer,
      (receipt_row.result ->> 'restoredConversationCount')::integer;
    return;
  end if;

  select * into merge_log from public.audit_log
  where id = p_merge_audit_id and action = 'contact.merged' for share;
  if merge_log.id is null then raise exception 'CONTACT_MERGE_AUDIT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, merge_log.tenant_id, 'merge_audit');
  winner_snapshot := merge_log.payload #> '{prior,winner}';
  loser_snapshot := merge_log.payload #> '{prior,loser}';
  identities_snapshot := coalesce(merge_log.payload #> '{prior,identities}', '[]'::jsonb);
  conversations_snapshot := coalesce(merge_log.payload #> '{prior,conversations}', '[]'::jsonb);
  candidates_snapshot := coalesce(merge_log.payload #> '{prior,candidates}', '[]'::jsonb);
  winner_uuid := (winner_snapshot ->> 'id')::uuid;
  loser_uuid := (loser_snapshot ->> 'id')::uuid;

  if exists (
    select 1 from public.audit_log audit
    where audit.tenant_id = p_expected_tenant and audit.action = 'contact.unmerged'
      and audit.payload ->> 'mergeAuditId' = p_merge_audit_id::text
  ) then raise exception 'CONTACT_MERGE_ALREADY_UNDONE'; end if;

  perform 1 from public.contacts where id in (winner_uuid, loser_uuid) order by id for update;
  select * into current_loser from public.contacts where id = loser_uuid;
  if current_loser.id is null or current_loser.merged_into_contact_id <> winner_uuid
    or current_loser.merge_audit_id <> p_merge_audit_id then
    raise exception 'CONTACT_UNMERGE_STATE_CONFLICT';
  end if;

  expected_count := jsonb_array_length(identities_snapshot);
  select count(*)::integer into restored_identities
  from jsonb_array_elements(identities_snapshot) item
  join public.contact_identities identity
    on identity.id = (item ->> 'id')::uuid and identity.contact_id = winner_uuid;
  if restored_identities <> expected_count then raise exception 'CONTACT_UNMERGE_IDENTITY_CONFLICT'; end if;
  expected_count := jsonb_array_length(conversations_snapshot);
  select count(*)::integer into restored_conversations
  from jsonb_array_elements(conversations_snapshot) item
  join public.conversations conversation
    on conversation.id = (item ->> 'id')::uuid and conversation.contact_id = winner_uuid;
  if restored_conversations <> expected_count then raise exception 'CONTACT_UNMERGE_CONVERSATION_CONFLICT'; end if;

  update public.contact_identities identity set contact_id = loser_uuid
  from jsonb_array_elements(identities_snapshot) item
  where identity.id = (item ->> 'id')::uuid;
  update public.conversations conversation set contact_id = loser_uuid
  from jsonb_array_elements(conversations_snapshot) item
  where conversation.id = (item ->> 'id')::uuid;

  update public.contacts
  set opted_out = (winner_snapshot ->> 'opted_out')::boolean,
      credit_range = (winner_snapshot ->> 'credit_range')::public.credit_range,
      funding_goal = (winner_snapshot ->> 'funding_goal')::public.funding_goal,
      timeline = (winner_snapshot ->> 'timeline')::public.funding_timeline,
      business_stage = (winner_snapshot ->> 'business_stage')::public.business_stage,
      annual_revenue_cents = (winner_snapshot ->> 'annual_revenue_cents')::bigint,
      business_context = winner_snapshot ->> 'business_context',
      outcome = (winner_snapshot ->> 'outcome')::public.outcome,
      dq_reason = winner_snapshot ->> 'dq_reason',
      updated_at = now()
  where id = winner_uuid;
  update public.contacts
  set merged_into_contact_id = null, merged_at = null, merge_audit_id = null, updated_at = now()
  where id = loser_uuid;

  for candidate in select value from jsonb_array_elements(candidates_snapshot) loop
    update public.contact_duplicate_candidates
    set state = candidate ->> 'state',
        resolved_at = (candidate ->> 'resolved_at')::timestamptz,
        resolved_by = (candidate ->> 'resolved_by')::uuid,
        updated_at = now()
    where id = (candidate ->> 'id')::uuid;
  end loop;

  written_audit_id := app.write_audit_row(
    'contact.unmerged', p_actor_id, p_expected_tenant, 'contact', loser_uuid::text,
    btrim(p_reason),
    jsonb_build_object(
      'mergeAuditId', p_merge_audit_id,
      'prior', jsonb_build_object('winnerId', winner_uuid, 'loserMergedInto', winner_uuid),
      'new', jsonb_build_object(
        'winner', winner_snapshot, 'loser', loser_snapshot,
        'restoredIdentityCount', restored_identities,
        'restoredConversationCount', restored_conversations
      )
    )
  );
  insert into public.channel_operation_receipts (
    tenant_id, operation, idempotency_key, payload_hash, result, audit_id
  ) values (
    p_expected_tenant, 'unmerge_contact', btrim(p_idempotency_key), payload_hash,
    jsonb_build_object(
      'winnerId', winner_uuid, 'loserId', loser_uuid,
      'restoredIdentityCount', restored_identities,
      'restoredConversationCount', restored_conversations
    ), written_audit_id
  );
  return query select winner_uuid, loser_uuid, written_audit_id,
    restored_identities, restored_conversations;
end;
$$;

create or replace function public.submit_message_template(
  p_expected_tenant uuid,
  p_channel public.messaging_channel,
  p_provider public.channel_provider,
  p_provider_template_id text,
  p_provider_template_name text,
  p_category text,
  p_locale text,
  p_body text,
  p_variables jsonb,
  p_actor_id uuid,
  p_idempotency_key text
)
returns table (
  template_id uuid,
  status text,
  audit_id bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_row public.channel_operation_receipts%rowtype;
  template_row public.message_templates%rowtype;
  payload jsonb;
  payload_hash text;
  written_audit_id bigint;
  tenant_is_demo boolean;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if nullif(btrim(p_provider_template_id), '') is null
    or nullif(btrim(p_provider_template_name), '') is null
    or nullif(btrim(p_locale), '') is null or nullif(btrim(p_body), '') is null then
    raise exception 'MESSAGE_TEMPLATE_REQUIRED_FIELD_MISSING';
  end if;
  if p_category not in ('authentication', 'marketing', 'utility') then
    raise exception 'MESSAGE_TEMPLATE_CATEGORY_INVALID';
  end if;
  if jsonb_typeof(p_variables) <> 'array' then raise exception 'MESSAGE_TEMPLATE_VARIABLES_INVALID'; end if;
  if nullif(btrim(p_idempotency_key), '') is null then raise exception 'IDEMPOTENCY_KEY_REQUIRED'; end if;

  select is_demo into tenant_is_demo from public.tenants where id = p_expected_tenant;
  if tenant_is_demo is null then raise exception 'EXPECTED_TENANT_NOT_FOUND'; end if;
  if tenant_is_demo and (
    p_provider_template_name not like 'SETTERFI_DEMO_PLACEHOLDER_%'
    or p_body not like 'SETTERFI_DEMO_PLACEHOLDER_%'
  ) then raise exception 'DEMO_TEMPLATE_PLACEHOLDER_REQUIRED'; end if;

  payload := jsonb_build_object(
    'channel', p_channel, 'provider', p_provider,
    'providerTemplateId', btrim(p_provider_template_id),
    'providerTemplateName', btrim(p_provider_template_name),
    'category', p_category, 'locale', btrim(p_locale), 'body', p_body,
    'variables', p_variables, 'actorUserId', p_actor_id
  );
  payload_hash := app.phase4_json_hash(payload);
  perform pg_advisory_xact_lock(hashtextextended(
    p_expected_tenant::text || ':submit_template:' || btrim(p_idempotency_key), 0
  ));
  select * into receipt_row from public.channel_operation_receipts
  where tenant_id = p_expected_tenant and operation = 'submit_template'
    and idempotency_key = btrim(p_idempotency_key);
  if receipt_row.id is not null then
    if receipt_row.payload_hash <> payload_hash then raise exception 'IDEMPOTENCY_PAYLOAD_MISMATCH'; end if;
    return query select
      (receipt_row.result ->> 'templateId')::uuid,
      receipt_row.result ->> 'status', receipt_row.audit_id;
    return;
  end if;

  insert into public.message_templates (
    tenant_id, channel, provider, provider_template_id, provider_template_name, name,
    category, locale, body, body_hash, variables, status, submitted_at,
    status_updated_at, is_demo
  ) values (
    p_expected_tenant, p_channel, p_provider, btrim(p_provider_template_id),
    btrim(p_provider_template_name), btrim(p_provider_template_name), p_category,
    btrim(p_locale), p_body, app.phase4_json_hash(to_jsonb(p_body)), p_variables,
    'submitted', now(), now(), tenant_is_demo
  ) returning * into template_row;

  written_audit_id := app.write_audit_row(
    'message_template.submitted', p_actor_id, p_expected_tenant,
    'message_template', template_row.id::text, null,
    jsonb_build_object(
      'prior', null,
      'new', jsonb_build_object(
        'status', template_row.status, 'providerTemplateName', template_row.provider_template_name,
        'category', template_row.category, 'locale', template_row.locale,
        'bodyHash', template_row.body_hash, 'isDemo', template_row.is_demo
      )
    )
  );
  insert into public.channel_operation_receipts (
    tenant_id, operation, idempotency_key, payload_hash, result, audit_id
  ) values (
    p_expected_tenant, 'submit_template', btrim(p_idempotency_key), payload_hash,
    jsonb_build_object('templateId', template_row.id, 'status', template_row.status),
    written_audit_id
  );
  return query select template_row.id, template_row.status, written_audit_id;
end;
$$;

revoke execute on function app.phase4_json_hash(jsonb) from public, anon, authenticated;
revoke execute on function app.phase4_assert_tenant_actor(uuid, uuid) from public, anon, authenticated;

revoke all on function public.persist_inbound_message(
  uuid, public.channel_provider, public.messaging_channel, text, text, text, text, text, text,
  timestamptz, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.persist_inbound_message(
  uuid, public.channel_provider, public.messaging_channel, text, text, text, text, text, text,
  timestamptz, timestamptz, text
) to service_role;

revoke all on function public.switch_channel_provider(
  uuid, public.messaging_channel, uuid, uuid, jsonb, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.switch_channel_provider(
  uuid, public.messaging_channel, uuid, uuid, jsonb, uuid, text, text
) to service_role;

revoke all on function public.merge_contacts(
  uuid, uuid, uuid, text, text, uuid, text, text
) from public, anon, authenticated;
grant execute on function public.merge_contacts(
  uuid, uuid, uuid, text, text, uuid, text, text
) to service_role;

revoke all on function public.unmerge_contact(uuid, bigint, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.unmerge_contact(uuid, bigint, uuid, text, text)
  to service_role;

revoke all on function public.submit_message_template(
  uuid, public.messaging_channel, public.channel_provider, text, text, text, text, text,
  jsonb, uuid, text
) from public, anon, authenticated;
grant execute on function public.submit_message_template(
  uuid, public.messaging_channel, public.channel_provider, text, text, text, text, text,
  jsonb, uuid, text
) to service_role;

comment on function public.persist_inbound_message(
  uuid, public.channel_provider, public.messaging_channel, text, text, text, text, text, text,
  timestamptz, timestamptz, text
) is 'One non-overloaded inbound transaction: mandatory provider identity, tenant-scoped message replay, and authoritative direct-Meta window.';
comment on function public.switch_channel_provider(
  uuid, public.messaging_channel, uuid, uuid, jsonb, uuid, text, text
) is 'Receipt-hashed provider cutover that changes zero rows until every open contact has a validated identity mapping.';
comment on function public.merge_contacts(uuid, uuid, uuid, text, text, uuid, text, text)
  is 'Soft directional contact merge with full before-image audit, test-boundary refusal, and untouched message/meter rows.';
comment on function public.unmerge_contact(uuid, bigint, uuid, text, text)
  is 'Conflict-safe restoration from the latest non-reversed contact merge audit snapshot.';
comment on function public.submit_message_template(
  uuid, public.messaging_channel, public.channel_provider, text, text, text, text, text,
  jsonb, uuid, text
) is 'Persists provider-submitted lifecycle only; approval remains exclusive to signed status/readback paths.';
