-- The admin Inbox reads rows addressed to this operator or to nobody in particular
-- (`user_id is null`, which the schema comments as "everyone in scope"; since Phase 8 such a row
-- must still name a `recipient_email`, so these are notices whose addressee has no app account).
-- The queue shows them and offers "Mark read", but mark_notification_read only ever matched
-- `user_id = actor_id`, so the RPC raised on every one of them and the button failed permanently.
--
-- Two changes, and no more surface than that:
--
-- 1. The RPC accepts a row addressed to nobody, but only from a platform operator
--    (owner/admin/success) — exactly the roles the /admin/alerts page already gates on, and the
--    same predicate the neighboring platform policies use. A row addressed to a named person keeps
--    the current semantics precisely: only that person may mark it read.
--
-- 2. The select policy learns the same rule, because the caller has to be able to read back the
--    row it just marked. Without this an operator could mutate a row it could not see: a
--    tenant-scoped broadcast row is invisible under the old policy, since `owns_tenant` is false
--    for a platform user and the platform clause only covers `tenant_id is null`.
--
-- Honest states: a nobody-in-particular notice is one shared queue item, not a copy per operator,
-- so one operator marking it read clears it for the whole team. That is what a shared ops queue
-- means, and it mirrors how the queue itself already treats these rows: it reads the single row,
-- shows a single elapsed clock on it, and counts it once. The button's copy stays "Mark read" /
-- "Marked read" — reading a notice does not fix the thing it is about.

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
  where id = p_notification_id
    and (
      user_id = actor_id
      or (user_id is null and app.is_platform_operator())
    )
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

drop policy notifications_read on public.notifications;
create policy notifications_read on public.notifications for select to authenticated
  using (user_id = app.current_user_id()
         or app.owns_tenant(tenant_id)
         or (tenant_id is null and app.is_platform_user())
         or (user_id is null and app.is_platform_operator()));

revoke execute on function public.mark_notification_read(uuid) from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated, service_role;
