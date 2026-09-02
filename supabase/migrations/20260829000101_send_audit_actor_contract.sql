-- SetterFi send-audit actor contract: persist_outbound_send picks its actor the way it picks its key.
--
-- A reconciliation of all 13 direct audit_log insert sites in src/ plus this RPC against the 98
-- audit_actions registrations found six live mismatches, all in the send gateway
-- (src/lib/repositories/conversations.ts). Those were fixed on the insert side, not the
-- registration side: each of the six is written from both the coach-reply path and the actorless AI
-- cadence path, so 'human' would only move the failure to the busier machine path, and none of them
-- records something a human did.
--
-- The seventh and eighth are here. This function already picks its audit action from p_purpose, but
-- passed p_actor_id through on every purpose, so a follow_up or a control send carrying an actor
-- raises AUDIT_SYSTEM_ACTOR_FORBIDDEN inside the RPC. It is latent only because the sole gateway
-- construction that supplies an actor is the coach's manual reply, which sends human_reply. The
-- body below is carried forward verbatim from 20260820000003; the actor selection is the only
-- change, and messages.author is deliberately untouched because that column is where a human
-- reply's identity legitimately lands and the audit trigger does not police it.

create or replace function public.persist_outbound_send(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_purpose text,
  p_actor_id uuid,
  p_body text,
  p_provider text,
  p_provider_message_id text,
  p_state_entry_key text,
  p_is_test boolean
)
returns table (message_id uuid, audit_id bigint, persisted_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  persisted_message_id uuid;
  persisted_created_at timestamptz;
  logged_id bigint;
  audit_action text;
  audit_actor uuid;
begin
  select * into conversation_row
  from public.conversations
  where id = p_conversation_id
  for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(
    p_expected_tenant,
    conversation_row.tenant_id,
    'conversation'
  );

  insert into public.messages (
    tenant_id,
    conversation_id,
    direction,
    author,
    body,
    provider,
    provider_message_id,
    state_entry_key,
    is_test
  ) values (
    p_expected_tenant,
    p_conversation_id,
    'out',
    case
      when p_purpose = 'human_reply' and p_actor_id is not null
        then 'human:' || p_actor_id::text
      else 'agent'
    end,
    p_body,
    p_provider::public.channel_provider,
    p_provider_message_id,
    p_state_entry_key,
    p_is_test
  ) returning id, created_at into persisted_message_id, persisted_created_at;

  update public.conversations
  set last_message_at = persisted_created_at
  where id = p_conversation_id;

  audit_action := case
    when p_purpose = 'human_reply' then 'conversation.message.sent.human'
    when p_purpose = 'follow_up' then 'followup.completed'
    else 'conversation.channel_continued'
  end;
  audit_actor := case
    when audit_action = 'conversation.message.sent.human' then p_actor_id
    else null
  end;
  logged_id := app.write_audit_row(
    audit_action,
    audit_actor,
    p_expected_tenant,
    'conversation',
    p_conversation_id::text,
    null,
    jsonb_build_object(
      'messageId', persisted_message_id,
      'purpose', p_purpose,
      'providerMessageId', p_provider_message_id
    )
  );

  return query select persisted_message_id, logged_id, persisted_created_at;
end;
$$;

revoke all on function public.persist_outbound_send(
  uuid, uuid, text, uuid, text, text, text, text, boolean
) from public, anon, authenticated;
grant execute on function public.persist_outbound_send(
  uuid, uuid, text, uuid, text, text, text, text, boolean
) to service_role;
