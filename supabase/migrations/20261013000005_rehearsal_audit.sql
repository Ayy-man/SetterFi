-- "Rehearse as the lead" is a person playing a line into a demo tenant's test thread, which runs
-- the whole inbound path and a simulated send. That is a privileged action, so it carries an audit
-- row, and the Inbox can show "Logged" over the control that writes it.
--
-- The receipt itself is not written here. The rehearsal persists its inbound through the same
-- PostgREST upsert every provider webhook uses (`persistWebhookReceipt`), whose identity checks
-- and install-tenant promotion are shared with live traffic; forking that persist into a
-- rehearsal-only RPC would give the demo path a second inbound writer to keep in step with the
-- real one. Instead the audit RPC below is the gate between the receipt and the processor: the
-- application refuses to run the turn until this row reads back, so a played line is always
-- logged before it has any effect. The RPC only accepts a receipt that exists, belongs to the
-- tenant, carries the rehearsal marker for this actor, and points at a test thread on a demo
-- tenant, so an audit row can never claim a rehearsal that did not happen. A retried submit lands
-- on the same receipt and returns the same audit row rather than logging the line twice.
--
-- Coach visible, tenant scope: the coach on the demo workspace is the one rehearsing and reads
-- the receipt back on the thread.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('conversation.rehearsal.played', 'human', 'tenant', false, true,
   'Rehearsal logged', 'Rehearsal turn recorded in the audit log')
on conflict (key) do nothing;

create function public.record_rehearsal_turn(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_conversation_id uuid,
  p_receipt_id uuid
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  receipt_row public.webhook_events%rowtype;
  conversation_row public.conversations%rowtype;
  tenant_is_demo boolean;
  actor_authorized boolean;
  audit_id bigint;
begin
  if p_expected_tenant is null or p_conversation_id is null or p_receipt_id is null then
    raise exception 'REHEARSAL_AUDIT_INPUT_REQUIRED';
  end if;
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);

  select * into receipt_row from public.webhook_events where id = p_receipt_id for update;
  if receipt_row.id is null then raise exception 'REHEARSAL_RECEIPT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, receipt_row.tenant_id, 'webhook_event');
  if receipt_row.payload -> 'raw' -> 'rehearsal' is distinct from 'true'::jsonb
    or receipt_row.payload -> 'raw' ->> 'actorId' is distinct from p_actor_id::text then
    raise exception 'REHEARSAL_RECEIPT_INVALID';
  end if;

  select * into conversation_row from public.conversations where id = p_conversation_id;
  if conversation_row.id is null then raise exception 'REHEARSAL_CONVERSATION_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, conversation_row.tenant_id, 'conversation');
  select tenant.is_demo into tenant_is_demo from public.tenants tenant where tenant.id = p_expected_tenant;
  if coalesce(tenant_is_demo, false) = false or coalesce(conversation_row.is_test, false) = false then
    raise exception 'REHEARSAL_THREAD_NOT_REHEARSABLE';
  end if;

  select exists (
    select 1 from public.users actor
    where actor.id = p_actor_id
      and (actor.tenant_id = p_expected_tenant or actor.role in ('owner', 'admin', 'success'))
  ) into actor_authorized;
  if not actor_authorized then raise exception 'REHEARSAL_ACTOR_NOT_AUTHORIZED'; end if;

  -- One receipt, one row. The receipt is locked above, so two concurrent submits of the same
  -- idempotency key serialize here and the second returns the first's audit id.
  select existing.id into audit_id
  from public.audit_log existing
  where existing.action = 'conversation.rehearsal.played'
    and existing.tenant_id = p_expected_tenant
    and existing.target_type = 'webhook_event'
    and existing.target_id = p_receipt_id::text
  order by existing.created_at
  limit 1;
  if audit_id is not null then return audit_id; end if;

  audit_id := app.write_audit_row(
    'conversation.rehearsal.played', p_actor_id, p_expected_tenant, 'webhook_event',
    p_receipt_id::text, null,
    jsonb_build_object(
      'conversationId', p_conversation_id,
      'receiptId', p_receipt_id,
      'provider', receipt_row.provider,
      'eventType', receipt_row.event_type
    ),
    null, null, 'dashboard'
  );
  return audit_id;
end;
$$;

revoke execute on function public.record_rehearsal_turn(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.record_rehearsal_turn(uuid, uuid, uuid, uuid) to service_role;

comment on function public.record_rehearsal_turn(uuid, uuid, uuid, uuid) is
  'Writes the conversation.rehearsal.played audit row for a rehearsal receipt on a demo tenant''s test thread. Idempotent per receipt; the actor id must come from a server-validated session.';
