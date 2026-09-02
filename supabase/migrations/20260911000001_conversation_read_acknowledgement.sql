-- Inbox unread is a durable thread-level flag, not a per-user notification receipt. Reading must
-- clear only that flag; ownership and lifecycle remain the existing takeover responsibility.

create or replace function public.acknowledge_conversation_read(
  p_expected_tenant uuid,
  p_conversation_id uuid,
  p_actor_id uuid
)
returns table (
  conversation_id uuid,
  unread_by_coach boolean,
  status public.convo_status,
  taken_over_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_row public.conversations%rowtype;
begin
  perform app.assert_not_impersonating();
  if p_actor_id is null then raise exception 'CONVERSATION_ACTOR_REQUIRED'; end if;

  select * into conversation_row
  from public.conversations
  where id = p_conversation_id
  for update;
  if conversation_row.id is null then raise exception 'CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');

  if not exists (
    select 1
    from public.users actor
    where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) then
    raise exception 'CONVERSATION_ACTOR_NOT_AUTHORIZED';
  end if;

  update public.conversations
  set unread_by_coach = false
  where id = p_conversation_id
  returning * into conversation_row;

  return query
  select conversation_row.id, conversation_row.unread_by_coach,
    conversation_row.status, conversation_row.taken_over_by;
end;
$$;

revoke execute on function public.acknowledge_conversation_read(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.acknowledge_conversation_read(uuid, uuid, uuid)
  to service_role;
