-- Audited platform lifecycle mutations for support_threads. Thread assignment is
-- intentionally independent from tenants.success_owner.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  (
    'support.thread.status.changed', 'human', 'tenant', true, false,
    'Thread status change logged', 'Support thread status change recorded in the audit log'
  ),
  (
    'support.thread.assignment.changed', 'human', 'tenant', true, false,
    'Thread assignment logged', 'Support thread assignment recorded in the audit log'
  );

create function public.set_support_thread_status(
  p_thread_id uuid,
  p_actor_id uuid,
  p_status text,
  p_reason text
)
returns table (thread_id uuid, tenant_id uuid, status text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  thread_row public.support_threads%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_reason), '') is null then
    raise exception 'SUPPORT_THREAD_REASON_REQUIRED';
  end if;
  if p_status not in ('open', 'waiting_on_coach', 'resolved') then
    raise exception 'SUPPORT_THREAD_STATUS_INVALID';
  end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin', 'success') then
    raise exception 'SUPPORT_THREAD_ACTOR_FORBIDDEN';
  end if;
  select * into thread_row from public.support_threads where id = p_thread_id for update;
  if thread_row.id is null then
    raise exception 'SUPPORT_THREAD_NOT_FOUND';
  end if;

  update public.support_threads
  set status = p_status, updated_at = now()
  where id = p_thread_id;
  logged_id := app.write_audit_row(
    'support.thread.status.changed', p_actor_id, thread_row.tenant_id, 'support_thread',
    p_thread_id::text, p_reason,
    jsonb_build_object('prior_status', thread_row.status, 'status', p_status),
    null, null, 'api'
  );
  return query select p_thread_id, thread_row.tenant_id, p_status, logged_id;
end;
$$;

create function public.set_support_thread_assignee(
  p_thread_id uuid,
  p_actor_id uuid,
  p_assignee_id uuid,
  p_reason text
)
returns table (thread_id uuid, tenant_id uuid, assigned_to uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  assignee public.users%rowtype;
  thread_row public.support_threads%rowtype;
  logged_id bigint;
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_reason), '') is null then
    raise exception 'SUPPORT_THREAD_REASON_REQUIRED';
  end if;
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner', 'admin', 'success') then
    raise exception 'SUPPORT_THREAD_ACTOR_FORBIDDEN';
  end if;
  if p_assignee_id is not null then
    select * into assignee from public.users where id = p_assignee_id;
    if assignee.id is null or assignee.role not in ('owner', 'admin', 'success') then
      raise exception 'SUPPORT_THREAD_ASSIGNEE_INVALID';
    end if;
  end if;
  select * into thread_row from public.support_threads where id = p_thread_id for update;
  if thread_row.id is null then
    raise exception 'SUPPORT_THREAD_NOT_FOUND';
  end if;

  update public.support_threads
  set assigned_to = p_assignee_id, updated_at = now()
  where id = p_thread_id;
  logged_id := app.write_audit_row(
    'support.thread.assignment.changed', p_actor_id, thread_row.tenant_id, 'support_thread',
    p_thread_id::text, p_reason,
    jsonb_build_object('prior_assignee_id', thread_row.assigned_to, 'assignee_id', p_assignee_id),
    p_assignee_id, null, 'api'
  );
  return query select p_thread_id, thread_row.tenant_id, p_assignee_id, logged_id;
end;
$$;

revoke execute on function public.set_support_thread_status(uuid,uuid,text,text)
  from public, anon, authenticated;
revoke execute on function public.set_support_thread_assignee(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.set_support_thread_status(uuid,uuid,text,text) to service_role;
grant execute on function public.set_support_thread_assignee(uuid,uuid,uuid,text) to service_role;
