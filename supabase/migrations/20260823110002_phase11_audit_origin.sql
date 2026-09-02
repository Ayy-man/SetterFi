alter table public.audit_log
  add column source text,
  add column actor_ip inet;

alter table public.audit_log
  add constraint audit_log_source_check
  check (source is null or source in ('dashboard', 'api', 'system', 'job'));

drop function if exists app.write_audit_row(
  text, uuid, uuid, text, text, text, jsonb, uuid, uuid
);

create function app.write_audit_row(
  p_action text,
  p_actor_id uuid,
  p_tenant_id uuid,
  p_target_type text,
  p_target_id text,
  p_reason text default null,
  p_payload jsonb default null,
  p_subject_user_id uuid default null,
  p_impersonation_id uuid default null,
  p_source text default null,
  p_actor_ip inet default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  audit_id bigint;
begin
  insert into public.audit_log (
    actor_id, subject_user_id, tenant_id, action, target_type, target_id,
    reason, payload, impersonation_id, source, actor_ip
  ) values (
    p_actor_id, p_subject_user_id, p_tenant_id, p_action, p_target_type, p_target_id,
    p_reason, p_payload, p_impersonation_id, p_source, p_actor_ip
  ) returning id into audit_id;
  return audit_id;
end;
$$;

revoke execute on function app.write_audit_row(
  text, uuid, uuid, text, text, text, jsonb, uuid, uuid, text, inet
) from authenticated, public, anon;
