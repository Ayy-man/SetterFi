-- Normalize links written by the original Phase 1 RPCs without rewriting those security-definer
-- commands. New application producers use the typed destination registry; this trigger is the
-- compatibility seam for RPCs already deployed and for their persisted rows.

create or replace function app.normalize_legacy_notification_destination()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  conversation_id text;
begin
  if new.link = '/coach/settings/integrations' then
    new.link := '/coach/integrations';
  elsif new.link = '/coach/conversations/' then
    new.link := '/coach/conversations';
  elsif new.link ~ '^/coach/conversations/[0-9a-fA-F-]{36}$' then
    conversation_id := substring(new.link from length('/coach/conversations/') + 1);
    new.link := '/coach/conversations?conversationId=' || conversation_id;
  end if;
  return new;
end;
$$;

drop trigger if exists notifications_normalize_legacy_destination on public.notifications;
create trigger notifications_normalize_legacy_destination
before insert or update of link on public.notifications
for each row execute function app.normalize_legacy_notification_destination();

update public.notifications
set link = case
  when link = '/coach/settings/integrations' then '/coach/integrations'
  when link = '/coach/conversations/' then '/coach/conversations'
  else '/coach/conversations?conversationId='
    || substring(link from length('/coach/conversations/') + 1)
end
where link = '/coach/settings/integrations'
   or link = '/coach/conversations/'
   or link ~ '^/coach/conversations/[0-9a-fA-F-]{36}$';

revoke all on function app.normalize_legacy_notification_destination() from public;
grant execute on function app.normalize_legacy_notification_destination() to service_role;
