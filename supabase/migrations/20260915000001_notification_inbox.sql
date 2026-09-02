-- Receipt-backed inbox mutations stay self-only even when the caller also has
-- broader tenant or platform read authority. The existing notifications and
-- notification_deliveries tables remain the sole notification store.

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('notification.inbox.read', 'human', 'tenant', false, true,
   'Notification read logged', 'Notification read recorded in the audit log'),
  ('notification.inbox.read_all', 'human', 'tenant', false, true,
   'Inbox read logged', 'Mark all notifications read recorded in the audit log')
on conflict (key) do nothing;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns table (notification_id uuid, read_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  notification_row public.notifications%rowtype;
  actor_id uuid := app.current_user_id();
begin
  perform app.assert_not_impersonating();
  if app.claim('impersonation_session_id') is not null then
    raise exception 'IMPERSONATION_WRITE_FORBIDDEN';
  end if;
  if actor_id is null then raise exception 'NOTIFICATION_ACTOR_REQUIRED'; end if;

  select * into notification_row
  from public.notifications
  where id = p_notification_id and user_id = actor_id
  for update;
  if notification_row.id is null then
    raise exception 'NOTIFICATION_NOT_FOUND_OR_FORBIDDEN';
  end if;

  if notification_row.read_at is null then
    update public.notifications as notification
    set read_at = now()
    where notification.id = notification_row.id
    returning notification.read_at into notification_row.read_at;

    perform app.write_audit_row(
      'notification.inbox.read', actor_id, notification_row.tenant_id,
      'notification', notification_row.id::text, null,
      jsonb_build_object('rule_id', notification_row.rule_id, 'kind', notification_row.kind),
      actor_id, null, 'api', null
    );
  end if;

  return query select notification_row.id, notification_row.read_at;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns table (marked_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := app.current_user_id();
  changed_count integer;
begin
  perform app.assert_not_impersonating();
  if app.claim('impersonation_session_id') is not null then
    raise exception 'IMPERSONATION_WRITE_FORBIDDEN';
  end if;
  if actor_id is null then raise exception 'NOTIFICATION_ACTOR_REQUIRED'; end if;

  with changed as (
    update public.notifications
    set read_at = now()
    where user_id = actor_id and read_at is null
    returning id
  )
  select count(*)::integer into changed_count from changed;

  if changed_count > 0 then
    perform app.write_audit_row(
      'notification.inbox.read_all', actor_id, null,
      'notification_inbox', actor_id::text, null,
      jsonb_build_object('marked_count', changed_count), actor_id, null, 'api', null
    );
  end if;

  return query select changed_count;
end;
$$;

revoke execute on function public.mark_notification_read(uuid) from public, anon;
revoke execute on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated, service_role;
grant execute on function public.mark_all_notifications_read() to authenticated, service_role;
