-- Receipt-backed provider commands. Provider calls occur in the application; this transaction is
-- the only place that exposes their outcome or changes a local connection state.

create table public.provider_connection_command_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel_connection_id uuid not null references public.channel_connections(id) on delete cascade,
  command text not null check (command in ('test', 'reconnect', 'disconnect', 'template_sync', 'replay')),
  idempotency_key text not null check (nullif(btrim(idempotency_key), '') is not null),
  outcome text not null check (outcome in ('verified', 'not_verified', 'started', 'replayed')),
  outcome_code text not null check (nullif(btrim(outcome_code), '') is not null),
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  audit_id bigint not null references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (tenant_id, command, idempotency_key)
);
create index provider_connection_command_receipts_connection_idx
  on public.provider_connection_command_receipts (channel_connection_id, created_at desc);

-- Reauthorization points the one-time OAuth state at the old connection. The secret remains
-- untouched until the existing completion flow writes a verified replacement.
alter table public.channel_oauth_states
  add column reauthorization_connection_id uuid references public.channel_connections(id) on delete cascade;
create index channel_oauth_states_reauthorization_connection_idx
  on public.channel_oauth_states (reauthorization_connection_id)
  where reauthorization_connection_id is not null;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('channel.connection.tested', 'human', 'tenant', false, true, 'Connection test logged', 'Provider connection test recorded in the audit log'),
  ('channel.connection.reconnect.started', 'human', 'tenant', false, true, 'Reconnect started', 'Provider reauthorization started and recorded in the audit log'),
  ('channel.connection.disconnected', 'human', 'tenant', false, true, 'Disconnection logged', 'Provider revocation and disconnection recorded in the audit log'),
  ('message_template.synced', 'human', 'tenant', false, true, 'Template sync logged', 'Provider template approval state recorded in the audit log'),
  ('webhook.receipt.replayed', 'human', 'tenant', false, true, 'Replay logged', 'Stored provider receipt replay recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.record_provider_connection_command(
  p_expected_tenant uuid, p_connection_id uuid, p_command text, p_actor_id uuid,
  p_idempotency_key text, p_outcome text, p_outcome_code text, p_evidence jsonb,
  p_provider_revoked boolean default false
) returns table (receipt_id uuid, audit_id bigint, replayed boolean, outcome text)
language plpgsql security definer set search_path = '' as $$
declare
  connection_row public.channel_connections%rowtype;
  existing public.provider_connection_command_receipts%rowtype;
  action_key text;
  written_audit_id bigint;
  template_row jsonb;
  template_id text;
  template_name text;
  template_status text;
  tenant_is_demo boolean;
begin
  perform app.phase4_assert_tenant_actor(p_expected_tenant, p_actor_id);
  if p_command not in ('test', 'reconnect', 'disconnect', 'template_sync', 'replay')
    or p_outcome not in ('verified', 'not_verified', 'started', 'replayed')
    or nullif(btrim(p_idempotency_key), '') is null or nullif(btrim(p_outcome_code), '') is null
    or jsonb_typeof(p_evidence) <> 'object' then raise exception 'PROVIDER_COMMAND_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_expected_tenant::text || ':provider-command:' || p_command || ':' || btrim(p_idempotency_key), 0));
  select * into existing from public.provider_connection_command_receipts
  where tenant_id = p_expected_tenant and command = p_command and idempotency_key = btrim(p_idempotency_key);
  if existing.id is not null then
    return query select existing.id, existing.audit_id, true, existing.outcome;
    return;
  end if;
  select * into connection_row from public.channel_connections where id = p_connection_id for update;
  if connection_row.id is null then raise exception 'CHANNEL_CONNECTION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, connection_row.tenant_id, 'channel_connection');
  action_key := case p_command
    when 'test' then 'channel.connection.tested' when 'reconnect' then 'channel.connection.reconnect.started'
    when 'disconnect' then 'channel.connection.disconnected' when 'template_sync' then 'message_template.synced'
    else 'webhook.receipt.replayed' end;
  if p_command = 'template_sync' and p_outcome = 'verified' then
    select is_demo into tenant_is_demo from public.tenants where id = p_expected_tenant;
    if tenant_is_demo is false then
      for template_row in select value from jsonb_array_elements(coalesce(p_evidence -> 'templates', '[]'::jsonb)) loop
        template_id := nullif(btrim(template_row ->> 'id'), '');
        template_name := nullif(btrim(template_row ->> 'name'), '');
        template_status := template_row ->> 'approvalState';
        if template_id is not null and template_name is not null
          and template_status in ('submitted', 'approved', 'rejected', 'paused', 'disabled') then
          insert into public.message_templates (
            tenant_id, channel, provider, provider_template_id, provider_template_name, name, status,
            submitted_at, approved_at, rejected_at, paused_at, disabled_at, status_updated_at, is_demo
          ) values (
            p_expected_tenant, connection_row.channel, connection_row.provider, template_id, template_name,
            template_name, template_status,
            case when template_status = 'submitted' then now() else null end,
            case when template_status = 'approved' then now() else null end,
            case when template_status = 'rejected' then now() else null end,
            case when template_status = 'paused' then now() else null end,
            case when template_status = 'disabled' then now() else null end,
            now(), false
          ) on conflict (tenant_id, provider, provider_template_id) where provider_template_id is not null
          do update set
            provider_template_name = excluded.provider_template_name,
            name = excluded.name,
            status = excluded.status,
            submitted_at = case when excluded.status = 'submitted' then now() else public.message_templates.submitted_at end,
            approved_at = case when excluded.status = 'approved' then now() else public.message_templates.approved_at end,
            rejected_at = case when excluded.status = 'rejected' then now() else public.message_templates.rejected_at end,
            paused_at = case when excluded.status = 'paused' then now() else public.message_templates.paused_at end,
            disabled_at = case when excluded.status = 'disabled' then now() else public.message_templates.disabled_at end,
            status_updated_at = now();
        end if;
      end loop;
    end if;
  end if;
  if p_command = 'disconnect' and p_outcome = 'verified' and p_provider_revoked is true then
    update public.channel_connections set state = 'disconnected', last_heartbeat_at = null, error = null, updated_at = now()
    where id = connection_row.id;
  end if;
  written_audit_id := app.write_audit_row(action_key, p_actor_id, p_expected_tenant, 'channel_connection', connection_row.id::text, null,
    jsonb_build_object('command', p_command, 'outcome', p_outcome, 'code', p_outcome_code, 'evidence', p_evidence));
  insert into public.provider_connection_command_receipts
    (tenant_id, channel_connection_id, command, idempotency_key, outcome, outcome_code, evidence, audit_id)
  values (p_expected_tenant, connection_row.id, p_command, btrim(p_idempotency_key), p_outcome, btrim(p_outcome_code), p_evidence, written_audit_id)
  returning id into receipt_id;
  audit_id := written_audit_id; replayed := false; outcome := p_outcome; return next;
end; $$;

alter table public.provider_connection_command_receipts enable row level security;
alter table public.provider_connection_command_receipts force row level security;
revoke all on public.provider_connection_command_receipts from public, anon, authenticated;
grant select on public.provider_connection_command_receipts to service_role;
create policy provider_connection_command_receipts_service_all on public.provider_connection_command_receipts
  for all to service_role using (true) with check (true);
revoke all on function public.record_provider_connection_command(uuid, uuid, text, uuid, text, text, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.record_provider_connection_command(uuid, uuid, text, uuid, text, text, text, jsonb, boolean)
  to service_role;
