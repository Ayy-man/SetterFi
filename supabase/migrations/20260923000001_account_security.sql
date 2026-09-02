-- Signed-in account controls. Auth owns the session schema; these narrowly scoped SECURITY
-- DEFINER functions expose only a caller's own active session metadata and revocation commands.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('auth.sessions.viewed','human','platform',false,false,'Session review logged','Account session review recorded in the audit log'),
  ('auth.session.revoked','human','platform',true,false,'Session revocation logged','Account session revocation recorded in the audit log'),
  ('auth.sessions.others_revoked','human','platform',true,false,'Other sessions revocation logged','Other account sessions revocation recorded in the audit log'),
  ('auth.password.changed','human','platform',false,false,'Password change logged','Account password change recorded in the audit log')
on conflict (key) do nothing;

create function app.assert_account_security_actor(p_expected_user uuid, p_expected_tenant uuid, p_target text)
returns public.users
language plpgsql stable security definer set search_path = '' as $$
declare account public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  if auth.uid() is null or auth.uid() <> p_expected_user then raise exception 'ACCOUNT_SECURITY_ACTOR_FORBIDDEN:%', p_target; end if;
  select * into account from public.users where id = p_expected_user;
  if account.id is null or account.tenant_id is distinct from p_expected_tenant then raise exception 'ACCOUNT_SECURITY_ACCOUNT_MISMATCH:%', p_target; end if;
  -- Platform accounts legitimately have no tenant. Tenant-bound accounts additionally use the
  -- standard expected-tenant assertion rather than trusting a browser-supplied tenant id.
  if account.tenant_id is not null then perform app.assert_expected_tenant(p_expected_tenant, account.tenant_id, p_target); end if;
  return account;
end;
$$;

create function public.list_account_security_sessions(p_expected_user uuid, p_expected_tenant uuid)
returns table(id uuid, started_at timestamptz, last_seen_at timestamptz, ip_address text, user_agent text, is_current boolean)
language plpgsql security definer set search_path = '' as $$
declare account public.users%rowtype; current_session uuid;
begin
  account := app.assert_account_security_actor(p_expected_user, p_expected_tenant, 'account_security_session_list');
  current_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  return query
    select session.id, session.created_at, coalesce(session.refreshed_at, session.updated_at, session.created_at), session.ip::text, session.user_agent, session.id = current_session
    from auth.sessions session
    where session.user_id = account.id and (session.not_after is null or session.not_after > now())
    order by coalesce(session.refreshed_at, session.updated_at, session.created_at) desc, session.id desc;
end;
$$;

create function public.revoke_account_security_session(p_expected_user uuid, p_expected_tenant uuid, p_session_id uuid, p_reason text)
returns table(revoked_session_id uuid, is_current boolean, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare account public.users%rowtype; session_row auth.sessions%rowtype; logged_id bigint; current_session uuid;
begin
  account := app.assert_account_security_actor(p_expected_user, p_expected_tenant, 'account_security_session_revoke');
  if nullif(btrim(p_reason),'') is null then raise exception 'ACCOUNT_SECURITY_REASON_REQUIRED'; end if;
  select * into session_row from auth.sessions where id = p_session_id for update;
  if session_row.id is null or session_row.user_id <> account.id then raise exception 'ACCOUNT_SECURITY_SESSION_NOT_FOUND'; end if;
  current_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  delete from auth.sessions where id = session_row.id;
  logged_id := app.write_audit_row('auth.session.revoked', account.id, account.tenant_id, 'auth_session', session_row.id::text, btrim(p_reason), jsonb_build_object('is_current', session_row.id = current_session), account.id, null, 'api');
  return query select session_row.id, session_row.id = current_session, logged_id;
end;
$$;

create function public.record_account_security_sessions_viewed(p_expected_user uuid, p_expected_tenant uuid)
returns table(audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare account public.users%rowtype; logged_id bigint;
begin
  account := app.assert_account_security_actor(p_expected_user, p_expected_tenant, 'account_security_session_view');
  logged_id := app.write_audit_row('auth.sessions.viewed', account.id, account.tenant_id, 'account', account.id::text, null, null, account.id, null, 'api');
  return query select logged_id;
end;
$$;

create function public.revoke_other_account_security_sessions(p_expected_user uuid, p_expected_tenant uuid, p_reason text)
returns table(revoked_count integer, audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare account public.users%rowtype; current_session uuid; removed integer; logged_id bigint;
begin
  account := app.assert_account_security_actor(p_expected_user, p_expected_tenant, 'account_security_other_sessions_revoke');
  if nullif(btrim(p_reason),'') is null then raise exception 'ACCOUNT_SECURITY_REASON_REQUIRED'; end if;
  current_session := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  delete from auth.sessions where user_id = account.id and id <> current_session;
  get diagnostics removed = row_count;
  logged_id := app.write_audit_row('auth.sessions.others_revoked', account.id, account.tenant_id, 'account', account.id::text, btrim(p_reason), jsonb_build_object('revoked_count', removed), account.id, null, 'api');
  return query select removed, logged_id;
end;
$$;

create function public.record_account_security_password_change(p_expected_user uuid, p_expected_tenant uuid)
returns table(audit_id bigint)
language plpgsql security definer set search_path = '' as $$
declare account public.users%rowtype; logged_id bigint;
begin
  account := app.assert_account_security_actor(p_expected_user, p_expected_tenant, 'account_security_password_change');
  logged_id := app.write_audit_row('auth.password.changed', account.id, account.tenant_id, 'account', account.id::text, null, jsonb_build_object('other_sessions', 'ended'), account.id, null, 'api');
  return query select logged_id;
end;
$$;

revoke all on function public.list_account_security_sessions(uuid,uuid) from public, anon;
revoke all on function public.record_account_security_sessions_viewed(uuid,uuid) from public, anon;
revoke all on function public.revoke_account_security_session(uuid,uuid,uuid,text) from public, anon;
revoke all on function public.revoke_other_account_security_sessions(uuid,uuid,text) from public, anon;
revoke all on function public.record_account_security_password_change(uuid,uuid) from public, anon;
grant execute on function public.list_account_security_sessions(uuid,uuid) to authenticated;
grant execute on function public.record_account_security_sessions_viewed(uuid,uuid) to authenticated;
grant execute on function public.revoke_account_security_session(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.revoke_other_account_security_sessions(uuid,uuid,text) to authenticated;
grant execute on function public.record_account_security_password_change(uuid,uuid) to authenticated;
