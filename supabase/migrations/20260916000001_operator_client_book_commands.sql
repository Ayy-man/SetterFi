-- Audited client-book and provisioning commands. Nudge/resend persist intent only; no provider
-- dispatch occurs in this migration.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('tenant.lifecycle.paused','human','tenant',true,false,'Pause logged','Client pause recorded in the audit log'),
  ('tenant.lifecycle.resumed','human','tenant',true,false,'Resume logged','Client resume recorded in the audit log'),
  ('tenant.signup.resend.intent_recorded','human','tenant',true,false,'Signup resend intent logged','Signup resend intent recorded in the audit log'),
  ('tenant.onboarding.nudge.intent_recorded','human','tenant',true,false,'Onboarding nudge intent logged','Onboarding nudge intent recorded in the audit log'),
  ('tenant.archived','human','tenant',true,false,'Archive logged','Client archive recorded in the audit log'),
  ('tenant.internal_note.added','human','tenant',false,false,'Internal note logged','Internal client note recorded in the audit log'),
  ('tenant.command.undone','human','tenant',true,false,'Undo logged','Client command undo recorded in the audit log'),
  ('provisioning.nudge.intent_recorded','human','tenant',true,false,'Provisioning nudge intent logged','Provisioning nudge intent recorded in the audit log'),
  ('provisioning.resend.intent_recorded','human','tenant',true,false,'Provisioning resend intent logged','Provisioning resend intent recorded in the audit log'),
  ('provisioning.owner.reassigned','human','tenant',true,false,'Provisioning owner reassignment logged','Provisioning owner reassignment recorded in the audit log'),
  ('provisioning.command.undone','human','tenant',true,false,'Provisioning undo logged','Provisioning command undo recorded in the audit log')
on conflict (key) do nothing;

alter table public.provisioning_steps add column platform_owner_id uuid references public.users(id);
create index provisioning_steps_platform_owner_idx on public.provisioning_steps (platform_owner_id) where platform_owner_id is not null;

create table public.platform_operator_commands (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provisioning_step_id uuid references public.provisioning_steps(id) on delete cascade,
  action text not null check (action in ('client_pause','client_resume','client_resend_signup','client_nudge_onboarding','client_archive','client_note','provisioning_nudge','provisioning_resend','provisioning_reassign')),
  state text not null check (state in ('applied','intent_recorded','recorded','undone')),
  reason text,
  actor_id uuid not null references public.users(id),
  prior_tenant_status public.tenant_status,
  prior_platform_owner_id uuid references public.users(id),
  audit_id bigint references public.audit_log(id) on delete restrict,
  undone_at timestamptz,
  undone_by uuid references public.users(id),
  undo_audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint platform_operator_commands_undo_shape_chk check ((undone_at is null and undone_by is null and undo_audit_id is null) or (undone_at is not null and undone_by is not null and undo_audit_id is not null))
);
create index platform_operator_commands_tenant_created_idx on public.platform_operator_commands (tenant_id, created_at desc);

create table public.client_internal_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  body text not null check (nullif(btrim(body),'') is not null),
  actor_id uuid not null references public.users(id),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now()
);
create index client_internal_notes_tenant_created_idx on public.client_internal_notes (tenant_id, created_at desc);
create function app.reject_client_internal_note_mutation() returns trigger language plpgsql set search_path = '' as $$ begin raise exception 'CLIENT_INTERNAL_NOTES_APPEND_ONLY'; end; $$;
create trigger client_internal_notes_reject_mutation before update or delete on public.client_internal_notes for each row execute function app.reject_client_internal_note_mutation();
alter table public.platform_operator_commands enable row level security;
alter table public.platform_operator_commands force row level security;
alter table public.client_internal_notes enable row level security;
alter table public.client_internal_notes force row level security;
revoke all on public.platform_operator_commands, public.client_internal_notes from public, anon, authenticated, service_role;

create function app.assert_operator_command_actor(p_actor_id uuid) returns void language plpgsql stable security definer set search_path = '' as $$
declare actor public.users%rowtype;
begin
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or actor.role not in ('owner','admin','success') then raise exception 'OPERATOR_COMMAND_ACTOR_FORBIDDEN'; end if;
end;
$$;

create function public.record_client_operator_command(p_expected_tenant uuid, p_actor_id uuid, p_action text, p_reason text default null, p_note text default null)
returns table(command_id uuid, tenant_id uuid, action text, state text, tenant_status public.tenant_status, audit_id bigint, undo_available boolean)
language plpgsql security definer set search_path = '' as $$
declare tenant_row public.tenants%rowtype; command_row public.platform_operator_commands%rowtype; note_id uuid; logged_id bigint; audit_action text; next_status public.tenant_status; command_state text; undoable boolean := false;
begin
  perform app.assert_not_impersonating(); perform app.assert_operator_command_actor(p_actor_id);
  if p_action not in ('pause','resume','resend_signup','nudge_onboarding','archive','note') then raise exception 'CLIENT_OPERATOR_ACTION_INVALID'; end if;
  if p_action <> 'note' and nullif(btrim(p_reason),'') is null then raise exception 'CLIENT_OPERATOR_REASON_REQUIRED'; end if;
  if p_action = 'note' and nullif(btrim(p_note),'') is null then raise exception 'CLIENT_OPERATOR_NOTE_REQUIRED'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant for update;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'operator_client_command');
  case p_action
    when 'pause' then if tenant_row.status <> 'active' then raise exception 'CLIENT_PAUSE_FORBIDDEN:%',tenant_row.status; end if; next_status := 'paused'; command_state := 'applied'; undoable := true; audit_action := 'tenant.lifecycle.paused';
    when 'resume' then if tenant_row.status <> 'paused' then raise exception 'CLIENT_RESUME_FORBIDDEN:%',tenant_row.status; end if; next_status := 'active'; command_state := 'applied'; undoable := true; audit_action := 'tenant.lifecycle.resumed';
    when 'archive' then if tenant_row.status = 'churned' then raise exception 'CLIENT_ARCHIVE_FORBIDDEN:%',tenant_row.status; end if; next_status := 'churned'; command_state := 'applied'; undoable := true; audit_action := 'tenant.archived';
    when 'resend_signup' then next_status := tenant_row.status; command_state := 'intent_recorded'; audit_action := 'tenant.signup.resend.intent_recorded';
    when 'nudge_onboarding' then next_status := tenant_row.status; command_state := 'intent_recorded'; audit_action := 'tenant.onboarding.nudge.intent_recorded';
    when 'note' then next_status := tenant_row.status; command_state := 'recorded'; audit_action := 'tenant.internal_note.added'; note_id := gen_random_uuid();
  end case;
  insert into public.platform_operator_commands (tenant_id,action,state,reason,actor_id,prior_tenant_status) values (p_expected_tenant,'client_'||p_action,command_state,nullif(btrim(p_reason),''),p_actor_id,case when undoable then tenant_row.status else null end) returning * into command_row;
  if p_action in ('pause','resume','archive') then update public.tenants set status = next_status where id = p_expected_tenant; end if;
  logged_id := app.write_audit_row(audit_action,p_actor_id,p_expected_tenant,case when p_action = 'note' then 'client_internal_note' else 'tenant' end,coalesce(note_id,p_expected_tenant)::text,nullif(btrim(p_reason),''),jsonb_strip_nulls(jsonb_build_object('command_id',command_row.id,'prior_status',tenant_row.status,'status',next_status,'execution',case when command_state = 'intent_recorded' then 'intent_recorded' else 'applied' end,'provider_dispatch',case when command_state = 'intent_recorded' then 'not_wired' else null end)));
  update public.platform_operator_commands set audit_id = logged_id where id = command_row.id;
  if note_id is not null then insert into public.client_internal_notes (id,tenant_id,body,actor_id,audit_id) values (note_id,p_expected_tenant,btrim(p_note),p_actor_id,logged_id); end if;
  return query select command_row.id,p_expected_tenant,command_row.action,command_state,next_status,logged_id,undoable;
end;
$$;

create function public.record_provisioning_operator_command(p_expected_tenant uuid, p_step_key public.provisioning_step, p_actor_id uuid, p_action text, p_reason text, p_assignee_id uuid default null)
returns table(command_id uuid, tenant_id uuid, step_key public.provisioning_step, action text, state text, platform_owner_id uuid, audit_id bigint, undo_available boolean)
language plpgsql security definer set search_path = '' as $$
declare step_row public.provisioning_steps%rowtype; assignee public.users%rowtype; command_row public.platform_operator_commands%rowtype; logged_id bigint; audit_action text; command_state text; next_owner uuid; undoable boolean := false;
begin
  perform app.assert_not_impersonating(); perform app.assert_operator_command_actor(p_actor_id);
  if p_action not in ('nudge','resend','reassign') or nullif(btrim(p_reason),'') is null then raise exception 'PROVISIONING_OPERATOR_COMMAND_INVALID'; end if;
  select * into step_row from public.provisioning_steps where tenant_id = p_expected_tenant and step_key = p_step_key for update;
  if step_row.id is null then raise exception 'PROVISIONING_STEP_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant,step_row.tenant_id,'provisioning_operator_command');
  if p_action = 'reassign' then
    if p_assignee_id is null then raise exception 'PROVISIONING_OWNER_REQUIRED'; end if;
    select * into assignee from public.users where id = p_assignee_id;
    if assignee.id is null or assignee.role not in ('owner','admin','success') then raise exception 'PROVISIONING_OWNER_INVALID'; end if;
    next_owner := p_assignee_id; command_state := 'applied'; undoable := true; audit_action := 'provisioning.owner.reassigned';
  else
    next_owner := step_row.platform_owner_id; command_state := 'intent_recorded'; audit_action := case when p_action = 'nudge' then 'provisioning.nudge.intent_recorded' else 'provisioning.resend.intent_recorded' end;
  end if;
  insert into public.platform_operator_commands (tenant_id,provisioning_step_id,action,state,reason,actor_id,prior_platform_owner_id) values (p_expected_tenant,step_row.id,'provisioning_'||p_action,command_state,btrim(p_reason),p_actor_id,case when undoable then step_row.platform_owner_id else null end) returning * into command_row;
  if p_action = 'reassign' then update public.provisioning_steps set platform_owner_id = next_owner,updated_at = now() where id = step_row.id; end if;
  logged_id := app.write_audit_row(audit_action,p_actor_id,p_expected_tenant,'provisioning_step',step_row.id::text,btrim(p_reason),jsonb_strip_nulls(jsonb_build_object('command_id',command_row.id,'step_key',p_step_key,'prior_platform_owner_id',step_row.platform_owner_id,'platform_owner_id',next_owner,'execution',case when command_state = 'intent_recorded' then 'intent_recorded' else 'applied' end,'provider_dispatch',case when command_state = 'intent_recorded' then 'not_wired' else null end)),next_owner);
  update public.platform_operator_commands set audit_id = logged_id where id = command_row.id;
  return query select command_row.id,p_expected_tenant,p_step_key,command_row.action,command_state,next_owner,logged_id,undoable;
end;
$$;

create function public.undo_platform_operator_command(p_expected_tenant uuid,p_command_id uuid,p_actor_id uuid,p_reason text)
returns table(command_id uuid,tenant_id uuid,action text,state text,tenant_status public.tenant_status,platform_owner_id uuid,audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare command_row public.platform_operator_commands%rowtype; step_row public.provisioning_steps%rowtype; next_status public.tenant_status; next_owner uuid; logged_id bigint; audit_action text;
begin
  perform app.assert_not_impersonating(); perform app.assert_operator_command_actor(p_actor_id);
  if nullif(btrim(p_reason),'') is null then raise exception 'OPERATOR_COMMAND_UNDO_REASON_REQUIRED'; end if;
  select * into command_row from public.platform_operator_commands where id = p_command_id for update;
  if command_row.id is null then raise exception 'OPERATOR_COMMAND_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant,command_row.tenant_id,'operator_command_undo');
  if command_row.undone_at is not null or command_row.action not in ('client_pause','client_resume','client_archive','provisioning_reassign') then raise exception 'OPERATOR_COMMAND_UNDO_FORBIDDEN'; end if;
  if command_row.action like 'client_%' then
    update public.tenants set status = command_row.prior_tenant_status where id = p_expected_tenant; next_status := command_row.prior_tenant_status; audit_action := 'tenant.command.undone';
  else
    select * into step_row from public.provisioning_steps where id = command_row.provisioning_step_id for update;
    perform app.assert_expected_tenant(p_expected_tenant,step_row.tenant_id,'provisioning_command_undo');
    update public.provisioning_steps set platform_owner_id = command_row.prior_platform_owner_id,updated_at = now() where id = step_row.id;
    next_owner := command_row.prior_platform_owner_id; audit_action := 'provisioning.command.undone';
  end if;
  logged_id := app.write_audit_row(audit_action,p_actor_id,p_expected_tenant,case when command_row.action like 'client_%' then 'tenant' else 'provisioning_step' end,(case when command_row.action like 'client_%' then p_expected_tenant else command_row.provisioning_step_id end)::text,btrim(p_reason),jsonb_build_object('command_id',command_row.id,'undone_action',command_row.action));
  update public.platform_operator_commands set state = 'undone',undone_at = now(),undone_by = p_actor_id,undo_audit_id = logged_id where id = command_row.id;
  return query select command_row.id,p_expected_tenant,command_row.action,'undone',next_status,next_owner,logged_id;
end;
$$;

revoke execute on function public.record_client_operator_command(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke execute on function public.record_provisioning_operator_command(uuid,public.provisioning_step,uuid,text,text,uuid) from public,anon,authenticated;
revoke execute on function public.undo_platform_operator_command(uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.record_client_operator_command(uuid,uuid,text,text,text) to service_role;
grant execute on function public.record_provisioning_operator_command(uuid,public.provisioning_step,uuid,text,text,uuid) to service_role;
grant execute on function public.undo_platform_operator_command(uuid,uuid,uuid,text) to service_role;
