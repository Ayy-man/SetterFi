-- Lets a coach-initiated support thread (e.g. "Report a duplicate" / "Request deletion" from the
-- Leads list) record which contact it is about, without ever touching that contact. The thread
-- stays a plain message to support for a human to act on; this column only makes it filterable
-- and auditable by lead.

alter table public.support_threads
  add column related_contact_id uuid references public.contacts(id);

create index support_threads_related_contact_idx
  on public.support_threads (related_contact_id)
  where related_contact_id is not null;

drop function public.create_support_thread(uuid, uuid, text, text);

create or replace function public.create_support_thread(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_subject text,
  p_body text,
  p_related_contact_id uuid default null
)
returns table (thread_id uuid, message_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.users%rowtype;
  tenant_row public.tenants%rowtype;
  contact_row public.contacts%rowtype;
  created_thread uuid := gen_random_uuid();
  created_message uuid := gen_random_uuid();
begin
  perform app.assert_not_impersonating();
  if nullif(btrim(p_subject), '') is null then raise exception 'SUPPORT_SUBJECT_REQUIRED'; end if;
  if nullif(btrim(p_body), '') is null then raise exception 'SUPPORT_BODY_REQUIRED'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'support_thread');
  select * into actor from public.users where id = p_actor_id;
  if actor.id is null or not (
    actor.tenant_id = p_expected_tenant and actor.role in ('coach', 'coach_member')
    or actor.role in ('owner', 'admin', 'success')
  ) then raise exception 'SUPPORT_ACTOR_FORBIDDEN'; end if;
  if p_related_contact_id is not null then
    select * into contact_row from public.contacts where id = p_related_contact_id;
    perform app.assert_expected_tenant(p_expected_tenant, contact_row.tenant_id, 'support_thread_contact');
  end if;
  insert into public.support_threads
    (id, tenant_id, subject, created_by, related_contact_id, is_test)
  values
    (created_thread, p_expected_tenant, btrim(p_subject), p_actor_id, p_related_contact_id, tenant_row.is_demo);
  insert into public.support_messages
    (id, tenant_id, thread_id, author_id, body, internal, is_test)
  values (created_message, p_expected_tenant, created_thread, p_actor_id, btrim(p_body), false, tenant_row.is_demo);
  return query select created_thread, created_message;
end;
$$;

revoke execute on function public.create_support_thread(uuid, uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_support_thread(uuid, uuid, text, text, uuid) to service_role;
