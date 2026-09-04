-- The Conversations agent toggle is spec'd to drop a named handover line into the thread
-- ("Automation paused · [name] took over"), not a generic "A person joined this conversation."
-- The line is the coach-facing evidence of who has the thread right now, so it has to carry a
-- name rather than make every takeover look interchangeable.

create or replace function public.claim_conversation(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid,
  p_expected_status public.convo_status,
  p_expected_holder_id uuid,
  p_confirm_displace boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
  audit_id bigint;
  actor_name text;
begin
  perform app.assert_not_impersonating();
  select * into conversation_row from public.conversations where id = p_conversation_id for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  if conversation_row.status <> p_expected_status
    or conversation_row.taken_over_by is distinct from p_expected_holder_id then
    raise exception 'CONVERSATION_CLAIM_STALE';
  end if;
  if conversation_row.taken_over_by is not null
    and conversation_row.taken_over_by <> p_actor_id and not p_confirm_displace then
    raise exception 'CONVERSATION_DISPLACE_CONFIRMATION_REQUIRED';
  end if;
  select coalesce(nullif(btrim(actor.full_name), ''), actor.email) into actor_name
  from public.users actor where actor.id = p_actor_id
    and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'));
  if actor_name is null then raise exception 'CONVERSATION_ACTOR_NOT_AUTHORIZED'; end if;

  update public.conversations
  set status = 'human', status_reason = 'human_takeover', status_changed_at = now(),
      taken_over_by = p_actor_id, taken_over_at = now(), unread_by_coach = false
  where id = p_conversation_id;
  update public.followups
  set paused_at = now(),
      remaining_offset_seconds = greatest(0, extract(epoch from (scheduled_at - now()))::int),
      claim_token = null, claimed_at = null, claim_expires_at = null
  where conversation_id = p_conversation_id and status = 'scheduled' and paused_at is null;
  insert into public.messages (tenant_id, conversation_id, direction, author, body)
  values (
    p_expected_tenant, p_conversation_id, 'system', 'system',
    'Automation paused · ' || actor_name || ' took over'
  );

  audit_id := app.write_audit_row(
    'conversation.takeover.claimed', p_actor_id, p_expected_tenant, 'conversation',
    p_conversation_id::text, null,
    jsonb_build_object('prior_status', conversation_row.status, 'new_status', 'human'),
    conversation_row.taken_over_by
  );
  return audit_id;
end;
$$;
