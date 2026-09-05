-- Coach-authored follow-up copy stays in message_templates, which is the scheduler's source of
-- truth. Local follow-up copy is deliberately distinct from a provider-owned template: it has no
-- provider template id and moves through the platform review lifecycle here.
set search_path = public, extensions;

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('followup_copy.draft.saved', 'human', 'tenant', false, true, 'Follow-up copy draft logged', 'Follow-up copy draft recorded in the audit log'),
  ('followup_copy.submitted', 'human', 'tenant', false, true, 'Follow-up copy submission logged', 'Follow-up copy submission recorded in the audit log'),
  ('followup_copy.approved', 'human', 'tenant', true, true, 'Follow-up copy approval logged', 'Follow-up copy approval recorded in the audit log'),
  ('followup_copy.rejected', 'human', 'tenant', true, true, 'Follow-up copy rejection logged', 'Follow-up copy rejection recorded in the audit log')
on conflict (key) do nothing;

alter table public.message_templates
  drop constraint message_templates_provider_id_chk,
  add constraint message_templates_provider_id_chk check (
    status = 'draft'
    or nullif(btrim(provider_template_id), '') is not null
    or name ~ '^followup:(lead_magnet|training|value_nudge|proof_point|new_angle|last_touch)$'
  ),
  drop constraint message_templates_demo_chk,
  add constraint message_templates_demo_chk check (
    not is_demo
    or (
      provider_template_name like 'SETTERFI_DEMO_PLACEHOLDER_%'
      and body like 'SETTERFI_DEMO_PLACEHOLDER_%'
    )
  );

create unique index message_templates_followup_copy_uidx
  on public.message_templates (tenant_id, channel, name)
  where name ~ '^followup:(lead_magnet|training|value_nudge|proof_point|new_angle|last_touch)$';

create function app.assert_followup_copy_coach(
  p_actor_id uuid,
  p_expected_tenant uuid
)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role not in ('coach', 'coach_member') then
    raise exception 'FOLLOWUP_COPY_COACH_REQUIRED';
  end if;
  perform app.assert_expected_tenant(p_expected_tenant, actor_row.tenant_id, 'followup_copy_actor');
end;
$$;

create function app.assert_followup_copy_admin(p_actor_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
declare actor_row public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  select * into actor_row from public.users where id = p_actor_id;
  if actor_row.id is null or actor_row.role not in ('owner', 'admin') then
    raise exception 'FOLLOWUP_COPY_PLATFORM_ADMIN_REQUIRED';
  end if;
end;
$$;

create function public.save_followup_copy_draft(
  p_expected_tenant uuid,
  p_channel public.messaging_channel,
  p_purpose text,
  p_body text,
  p_actor_id uuid
)
returns table (template_id uuid, status text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  template_row public.message_templates%rowtype;
  tenant_row public.tenants%rowtype;
  connection_provider public.channel_provider;
  normalized_body text := nullif(btrim(p_body), '');
  template_name text;
  logged_id bigint;
begin
  perform app.assert_followup_copy_coach(p_actor_id, p_expected_tenant);
  if p_purpose not in ('lead_magnet', 'training', 'value_nudge', 'proof_point', 'new_angle', 'last_touch')
    or normalized_body is null then raise exception 'FOLLOWUP_COPY_INVALID'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant for key share;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'followup_copy_tenant');
  if tenant_row.is_demo and normalized_body not like 'SETTERFI_DEMO_PLACEHOLDER_%' then
    raise exception 'DEMO_TEMPLATE_PLACEHOLDER_REQUIRED';
  end if;
  select connection.provider into connection_provider
  from public.channel_connections connection
  where connection.tenant_id = p_expected_tenant and connection.channel = p_channel
    and connection.state in ('ready', 'live')
  order by connection.signed_round_trip_at desc nulls last, connection.updated_at desc, connection.id desc
  limit 1;
  if connection_provider is null then raise exception 'FOLLOWUP_COPY_CHANNEL_NOT_CONNECTED'; end if;
  template_name := 'followup:' || p_purpose;
  select * into template_row from public.message_templates
  where tenant_id = p_expected_tenant and channel = p_channel and name = template_name for update;
  if template_row.id is not null and template_row.status = 'submitted' then
    raise exception 'FOLLOWUP_COPY_REVIEW_PENDING';
  end if;
  if template_row.id is null then
    insert into public.message_templates (
      tenant_id, channel, provider, provider_template_id, provider_template_name, name, body, body_hash,
      variables, status, status_updated_at, is_demo
    ) values (
      p_expected_tenant, p_channel, connection_provider, null, template_name, template_name, normalized_body,
      encode(extensions.digest(convert_to(normalized_body, 'UTF8'), 'sha256'), 'hex'), '[]'::jsonb,
      'draft', now(), tenant_row.is_demo
    ) returning * into template_row;
  else
    update public.message_templates set
      provider = connection_provider, body = normalized_body,
      body_hash = encode(extensions.digest(convert_to(normalized_body, 'UTF8'), 'sha256'), 'hex'),
      status = 'draft', submitted_at = null, approved_at = null, rejected_at = null,
      rejection_detail = null, status_updated_at = now(), updated_at = now()
    where id = template_row.id returning * into template_row;
  end if;
  logged_id := app.write_audit_row(
    'followup_copy.draft.saved', p_actor_id, p_expected_tenant, 'message_template', template_row.id::text,
    null, jsonb_build_object('purpose', p_purpose, 'channel', p_channel, 'bodyHash', template_row.body_hash)
  );
  return query select template_row.id, template_row.status, logged_id;
end;
$$;

create function public.submit_followup_copy(
  p_expected_tenant uuid,
  p_template_id uuid,
  p_actor_id uuid
)
returns table (template_id uuid, status text, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare template_row public.message_templates%rowtype; logged_id bigint;
begin
  perform app.assert_followup_copy_coach(p_actor_id, p_expected_tenant);
  select * into template_row from public.message_templates where id = p_template_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, template_row.tenant_id, 'followup_copy');
  if template_row.name !~ '^followup:(lead_magnet|training|value_nudge|proof_point|new_angle|last_touch)$'
    or template_row.status not in ('draft', 'rejected') or nullif(btrim(template_row.body), '') is null then
    raise exception 'FOLLOWUP_COPY_SUBMISSION_REFUSED'; end if;
  update public.message_templates set status = 'submitted', submitted_at = now(), rejected_at = null,
    rejection_detail = null, status_updated_at = now(), updated_at = now() where id = template_row.id returning * into template_row;
  logged_id := app.write_audit_row('followup_copy.submitted', p_actor_id, p_expected_tenant,
    'message_template', template_row.id::text, null, jsonb_build_object('purpose', substr(template_row.name, 10), 'channel', template_row.channel));
  return query select template_row.id, template_row.status, logged_id;
end;
$$;

create function public.decide_followup_copy(
  p_expected_tenant uuid, p_template_id uuid, p_decision text, p_reason text, p_actor_id uuid
)
returns table (template_id uuid, status text, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare template_row public.message_templates%rowtype; logged_id bigint; action_key text; normalized_reason text := nullif(btrim(p_reason), '');
begin
  perform app.assert_followup_copy_admin(p_actor_id);
  if p_decision not in ('approved', 'rejected') or normalized_reason is null then raise exception 'FOLLOWUP_COPY_DECISION_INVALID'; end if;
  select * into template_row from public.message_templates where id = p_template_id for update;
  perform app.assert_expected_tenant(p_expected_tenant, template_row.tenant_id, 'followup_copy');
  if template_row.name !~ '^followup:(lead_magnet|training|value_nudge|proof_point|new_angle|last_touch)$' or template_row.status <> 'submitted' then
    raise exception 'FOLLOWUP_COPY_DECISION_REFUSED'; end if;
  update public.message_templates set status = p_decision,
    approved_at = case when p_decision = 'approved' then now() else null end,
    rejected_at = case when p_decision = 'rejected' then now() else null end,
    rejection_detail = case when p_decision = 'rejected' then normalized_reason else null end,
    status_updated_at = now(), updated_at = now() where id = template_row.id returning * into template_row;
  action_key := 'followup_copy.' || p_decision;
  logged_id := app.write_audit_row(action_key, p_actor_id, p_expected_tenant, 'message_template', template_row.id::text,
    normalized_reason, jsonb_build_object('purpose', substr(template_row.name, 10), 'channel', template_row.channel, 'bodyHash', template_row.body_hash));
  return query select template_row.id, template_row.status, logged_id;
end;
$$;

revoke execute on function app.assert_followup_copy_coach(uuid,uuid) from public, anon, authenticated;
revoke execute on function app.assert_followup_copy_admin(uuid) from public, anon, authenticated;
revoke execute on function public.save_followup_copy_draft(uuid,public.messaging_channel,text,text,uuid) from public, anon, authenticated;
revoke execute on function public.submit_followup_copy(uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function public.decide_followup_copy(uuid,uuid,text,text,uuid) from public, anon, authenticated;
grant execute on function public.save_followup_copy_draft(uuid,public.messaging_channel,text,text,uuid) to service_role;
grant execute on function public.submit_followup_copy(uuid,uuid,uuid) to service_role;
grant execute on function public.decide_followup_copy(uuid,uuid,text,text,uuid) to service_role;
