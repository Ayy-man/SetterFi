-- Read-only cross-tenant queue for platform staff. The function is service-only, verifies the
-- supplied actor against the live user row, and records the privileged read before returning data.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values (
  'platform.conversation_queue.read', 'human', 'platform', false, false,
  'Human queue view logged', 'Cross-tenant human conversation queue view recorded in the audit log'
)
on conflict (key) do nothing;

-- The existing per-tenant index cannot support a fair global oldest-first queue because tenant_id
-- is its leading key. This index is also deliberately limited to unclaimed, non-test work.
create index conversations_platform_human_queue_idx
  on public.conversations (needs_human_at asc, id asc)
  where status = 'needs_human' and taken_over_by is null and is_test = false;

create function public.read_platform_human_conversation_queue(p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  queue_rows jsonb;
  returned_count integer;
  audit_id bigint;
begin
  -- This checks the current database role and active impersonation state. A coach cannot turn a
  -- supplied UUID into cross-tenant authority, and no tenant selector is accepted by this RPC.
  perform app.phase2_assert_platform_actor(p_actor_id);

  select coalesce(jsonb_agg(row_to_json(queue) order by queue.waiting_since asc, queue.conversation_id asc), '[]'::jsonb)
  into queue_rows
  from (
    select
      conversation.id as conversation_id,
      conversation.tenant_id,
      tenant.name as tenant_name,
      conversation.channel::text as channel,
      conversation.status::text as status,
      conversation.status_reason::text as status_reason,
      conversation.needs_human_at as waiting_since,
      greatest(0, floor(extract(epoch from clock_timestamp() - conversation.needs_human_at)))::bigint as waiting_seconds
    from public.conversations conversation
    join public.tenants tenant on tenant.id = conversation.tenant_id
    where conversation.status = 'needs_human'
      and conversation.taken_over_by is null
      and conversation.is_test = false
      and conversation.needs_human_at is not null
    order by conversation.needs_human_at asc, conversation.id asc
    limit 100
  ) queue;

  returned_count := jsonb_array_length(queue_rows);
  audit_id := app.write_audit_row(
    'platform.conversation_queue.read', p_actor_id, null,
    'platform_conversation_queue', 'needs_human', null,
    jsonb_build_object('returned_count', returned_count, 'limit', 100)
  );

  return jsonb_build_object('audit_id', audit_id, 'conversations', queue_rows);
end;
$$;

-- No table or view is exposed for direct reading. Conversations retain their existing forced RLS;
-- the definer RPC is the only narrow cross-tenant projection and it has its own actor assertion.
revoke all on function public.read_platform_human_conversation_queue(uuid)
  from public, anon, authenticated;
grant execute on function public.read_platform_human_conversation_queue(uuid) to service_role;
