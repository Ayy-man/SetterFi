drop function public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, text, uuid
);

create function public.set_contact_pipeline_stage(
  p_expected_tenant uuid,
  p_contact_id uuid,
  p_stage public.pipeline_stage,
  p_set_by text,
  p_actor_id uuid default null,
  p_reason text default null,
  p_appointment_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_row public.contacts%rowtype;
  latest_appointment public.appointments%rowtype;
  booked_appointment public.appointments%rowtype;
  audit_id bigint;
begin
  perform app.assert_not_impersonating();
  select * into contact_row from public.contacts where id = p_contact_id for update;
  if contact_row.id is null then raise exception 'CONTACT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'contact');
  if p_set_by = 'user' and p_actor_id is null then raise exception 'PIPELINE_ACTOR_REQUIRED'; end if;
  if p_set_by = 'system' and contact_row.stage_set_by = 'user' and p_stage <> 'booked' then
    raise exception 'PIPELINE_USER_STAGE_PROTECTED';
  end if;
  if p_stage = 'booked' and p_appointment_id is null then
    raise exception 'PIPELINE_BOOKED_REQUIRES_APPOINTMENT';
  end if;
  if p_stage = 'booked' then
    select * into booked_appointment from public.appointments
    where id = p_appointment_id;
    if booked_appointment.id is null or booked_appointment.contact_id <> p_contact_id then
      raise exception 'PIPELINE_BOOKED_APPOINTMENT_MISMATCH';
    end if;
    perform app.assert_expected_tenant(
      p_expected_tenant, booked_appointment.tenant_id, 'appointment'
    );
  end if;
  if p_stage = 'no_show' then
    select * into latest_appointment from public.appointments
    where contact_id = p_contact_id
    order by start_at desc, id desc limit 1;
    if latest_appointment.id is null or latest_appointment.status <> 'no_show' then
      raise exception 'PIPELINE_NO_SHOW_REQUIRES_LATEST_APPOINTMENT';
    end if;
  end if;
  update public.contacts
  set pipeline_stage = p_stage, stage_set_by = p_set_by, stage_set_at = now()
  where id = p_contact_id;

  if p_set_by is distinct from 'user' then
    return null;
  end if;

  audit_id := app.write_audit_row(
    'contact.pipeline_stage.set', p_actor_id, p_expected_tenant, 'contact',
    p_contact_id::text, p_reason,
    jsonb_build_object(
      'prior_stage', contact_row.pipeline_stage,
      'new_stage', p_stage,
      'set_by', p_set_by,
      'appointment_id', p_appointment_id
    ),
    null,
    null
  );
  return audit_id;
end;
$$;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('contact.pipeline_stage.set', 'human', 'tenant', false, true, 'Logged',
    'Change the pipeline stage. This change is recorded in the audit log.');

revoke execute on function public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, text, uuid, text, uuid
) from public, anon, authenticated;
grant execute on function public.set_contact_pipeline_stage(
  uuid, uuid, public.pipeline_stage, text, uuid, text, uuid
) to service_role;
