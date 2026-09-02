-- Forward repair for the tenant-membership RLS helper and the provisioning command lookup.
-- Both replaced objects are already applied in production.
set search_path = public, extensions;

-- The helper is evaluated by tenant RLS policies. Its membership lookup must run with the
-- function owner's narrow table authority, not with the authenticated invoker's revoked table
-- privileges. The result is still constrained to the caller's JWT subject and claimed tenant.
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when app.current_user_role() = 'coach_member' then (
      select membership.tenant_id
      from public.tenant_memberships as membership
      where membership.user_id = app.current_user_id()
        and membership.tenant_id = app.claim('tenant_id')::uuid
        and membership.role = 'coach_member'
        and membership.revoked_at is null
      limit 1
    )
    when app.is_platform_user() then coalesce(app.claim('impersonating_tenant'), app.claim('tenant_id'))::uuid
    else app.claim('tenant_id')::uuid
  end;
$$;

create or replace function public.record_provisioning_operator_command(
  p_expected_tenant uuid,
  p_step_key public.provisioning_step,
  p_actor_id uuid,
  p_action text,
  p_reason text,
  p_assignee_id uuid default null
)
returns table(
  command_id uuid,
  tenant_id uuid,
  step_key public.provisioning_step,
  action text,
  state text,
  platform_owner_id uuid,
  audit_id bigint,
  undo_available boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  step_row public.provisioning_steps%rowtype;
  assignee public.users%rowtype;
  command_row public.platform_operator_commands%rowtype;
  logged_id bigint;
  audit_action text;
  command_state text;
  next_owner uuid;
  undoable boolean := false;
begin
  perform app.assert_not_impersonating();
  perform app.assert_operator_command_actor(p_actor_id);
  if p_action not in ('nudge', 'resend', 'reassign') or nullif(btrim(p_reason), '') is null then
    raise exception 'PROVISIONING_OPERATOR_COMMAND_INVALID';
  end if;

  select * into step_row
  from public.provisioning_steps as provisioning_step
  where provisioning_step.tenant_id = p_expected_tenant
    and provisioning_step.step_key = p_step_key
  for update;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, step_row.tenant_id, 'provisioning_operator_command');

  if p_action = 'reassign' then
    if p_assignee_id is null then raise exception 'PROVISIONING_OWNER_REQUIRED'; end if;
    select * into assignee from public.users where id = p_assignee_id;
    if assignee.id is null or assignee.role not in ('owner', 'admin', 'success') then
      raise exception 'PROVISIONING_OWNER_INVALID';
    end if;
    next_owner := p_assignee_id;
    command_state := 'applied';
    undoable := true;
    audit_action := 'provisioning.owner.reassigned';
  else
    next_owner := step_row.platform_owner_id;
    command_state := 'intent_recorded';
    audit_action := case when p_action = 'nudge' then 'provisioning.nudge.intent_recorded' else 'provisioning.resend.intent_recorded' end;
  end if;

  insert into public.platform_operator_commands (
    tenant_id, provisioning_step_id, action, state, reason, actor_id, prior_platform_owner_id
  )
  values (
    p_expected_tenant, step_row.id, 'provisioning_' || p_action, command_state, btrim(p_reason),
    p_actor_id, case when undoable then step_row.platform_owner_id else null end
  )
  returning * into command_row;
  if p_action = 'reassign' then
    update public.provisioning_steps
    set platform_owner_id = next_owner, updated_at = now()
    where id = step_row.id;
  end if;

  logged_id := app.write_audit_row(
    audit_action, p_actor_id, p_expected_tenant, 'provisioning_step', step_row.id::text,
    btrim(p_reason),
    jsonb_strip_nulls(jsonb_build_object(
      'command_id', command_row.id,
      'step_key', p_step_key,
      'prior_platform_owner_id', step_row.platform_owner_id,
      'platform_owner_id', next_owner,
      'execution', case when command_state = 'intent_recorded' then 'intent_recorded' else 'applied' end,
      'provider_dispatch', case when command_state = 'intent_recorded' then 'not_wired' else null end
    )),
    next_owner
  );
  update public.platform_operator_commands set audit_id = logged_id where id = command_row.id;
  return query select command_row.id, p_expected_tenant, p_step_key, command_row.action,
    command_state, next_owner, logged_id, undoable;
end;
$$;
