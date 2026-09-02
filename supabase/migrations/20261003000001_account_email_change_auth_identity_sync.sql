-- The confirmation link now moves Supabase Auth's identity (GoTrue admin API, outside Postgres)
-- before this projection writes public.users.email. That ordering needs the redemption split into
-- pieces: a non-mutating resolve that names the target without spending the token, a void for an
-- address GoTrue refuses at redemption time, and a divergence receipt for the window where auth
-- moved and the application row did not.
--
-- Invariant: Supabase Auth is the authority during a partial failure. The auth email moves first,
-- so a crash between the two writes leaves sign-in on the new address while public.users still
-- holds the old one; the request row stays 'pending' and the same link converges on retry, because
-- the auth step is a no-op when the identity already carries the requested address. The reverse
-- order was rejected: it would end every session (this projection deletes them) while sign-in still
-- required the old address the screen no longer shows, which locks the account owner out.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('auth.email_change.diverged', 'system', 'platform', false, false, 'Email change identity divergence logged', 'Account email change identity divergence recorded in the audit log')
on conflict (key) do nothing;

-- Reads the pending confirmation without spending it, so the auth-side move can happen first and
-- an interrupted attempt is still redeemable by the same link.
create function public.resolve_account_email_change_confirmation(p_token_hash text)
returns table(account_id uuid, target_email text, previous_email text)
language sql
stable
security definer
set search_path = ''
as $$
  select email_request.user_id, email_request.requested_email, email_request.current_email
  from public.account_email_change_requests as email_request
  where p_token_hash ~ '^[a-f0-9]{64}$'
    and email_request.confirmation_token_hash = p_token_hash
    and email_request.state = 'pending'
    and email_request.expires_at > now();
$$;

-- GoTrue can refuse the address at redemption time because another identity took it after the
-- request was made. Nothing moved, so the request is closed without touching either email and the
-- caller answers with the same generic refusal it uses for a bad link.
create function public.void_account_email_change(p_token_hash text, p_reason text)
returns table(state text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  change_request public.account_email_change_requests%rowtype;
  account public.users%rowtype;
  logged_id bigint;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_reason <> 'address_unavailable' then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;
  select * into change_request
  from public.account_email_change_requests as email_request
  where email_request.confirmation_token_hash = p_token_hash
    and email_request.state = 'pending'
  for update;
  if change_request.id is null then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;
  select * into account from public.users as account_user where account_user.id = change_request.user_id;
  if account.id is null then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;
  logged_id := app.write_audit_row(
    'auth.email_change.refused', account.id, account.tenant_id, 'account', account.id::text,
    null, jsonb_build_object('state', 'superseded', 'reason', p_reason), account.id, null, 'api'
  );
  update public.account_email_change_requests as email_request
  set state = 'superseded', superseded_at = now(), completed_audit_id = logged_id
  where email_request.id = change_request.id;
  return query select 'invalid'::text, logged_id;
end;
$$;

-- The auth identity moved and this projection did not. The row is left as it stands so the operator
-- can see which store leads and in which direction; a still-pending request converges when the link
-- is opened again, and a superseded one needs an operator to move public.users.email by hand.
create function public.record_account_email_change_divergence(p_token_hash text, p_direction text)
returns table(audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  change_request public.account_email_change_requests%rowtype;
  account public.users%rowtype;
  logged_id bigint;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_direction <> 'auth_ahead_of_app' then
    return query select null::bigint;
    return;
  end if;
  select * into change_request
  from public.account_email_change_requests as email_request
  where email_request.confirmation_token_hash = p_token_hash;
  if change_request.id is null then
    return query select null::bigint;
    return;
  end if;
  select * into account from public.users as account_user where account_user.id = change_request.user_id;
  if account.id is null then
    return query select null::bigint;
    return;
  end if;
  logged_id := app.write_audit_row(
    -- Registered as a system action: nobody chose this outcome, so the row carries no human actor
    -- and the subject is the account whose two identity stores disagree.
    'auth.email_change.diverged', null, account.tenant_id, 'account', account.id::text,
    null, jsonb_build_object(
      'direction', p_direction,
      'auth_email', change_request.requested_email,
      'application_email', account.email,
      'request_state', change_request.state
    ), account.id, null, 'api'
  );
  return query select logged_id;
end;
$$;

-- Same redemption as before, with one honest change: by the time this runs the auth identity has
-- already moved, so the receipt records the sync as complete rather than pending.
create or replace function public.complete_account_email_change(p_token_hash text, p_action text)
returns table(state text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  change_request public.account_email_change_requests%rowtype;
  account public.users%rowtype;
  removed_sessions integer;
  logged_id bigint;
begin
  if p_token_hash !~ '^[a-f0-9]{64}$' or p_action not in ('confirm', 'refuse') then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  if p_action = 'confirm' then
    select * into change_request
    from public.account_email_change_requests as email_request
    where email_request.confirmation_token_hash = p_token_hash
      and email_request.state = 'pending'
      and email_request.expires_at > now()
    for update;
  else
    select * into change_request
    from public.account_email_change_requests as email_request
    where email_request.refusal_token_hash = p_token_hash
      and email_request.state = 'pending'
      and email_request.expires_at > now()
    for update;
  end if;
  if change_request.id is null then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  select * into account
  from public.users as account_user
  where account_user.id = change_request.user_id
  for update;
  if account.id is null then
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  if p_action = 'refuse' then
    logged_id := app.write_audit_row(
      'auth.email_change.refused', account.id, account.tenant_id, 'account', account.id::text,
      null, jsonb_build_object('state', 'refused'), account.id, null, 'api'
    );
    update public.account_email_change_requests as email_request
    set state = 'refused', refused_at = now(), completed_audit_id = logged_id
    where email_request.id = change_request.id;
    return query select 'refused'::text, logged_id;
    return;
  end if;

  -- A target can become occupied after a request was made. Refuse it without exposing which
  -- competing identity won, and leave the application address unchanged. The auth row that now
  -- carries this address is the account's own, so it is excluded here.
  if exists (select 1 from public.users as existing_user
             where lower(existing_user.email) = change_request.requested_email
               and existing_user.id <> account.id)
    or exists (select 1 from auth.users as auth_user
               where lower(auth_user.email) = change_request.requested_email
                 and auth_user.id <> account.id) then
    update public.account_email_change_requests as email_request
    set state = 'superseded', superseded_at = now()
    where email_request.id = change_request.id;
    return query select 'invalid'::text, null::bigint;
    return;
  end if;

  update public.users as account_user
  set email = change_request.requested_email, updated_at = now()
  where account_user.id = account.id;
  -- Supabase's admin email update leaves refresh tokens alive, so the identity change ends every
  -- session here, exactly as the password change does and as the security screen promises.
  delete from auth.sessions as auth_session where auth_session.user_id = account.id;
  get diagnostics removed_sessions = row_count;
  logged_id := app.write_audit_row(
    'auth.email_change.confirmed', account.id, account.tenant_id, 'account', account.id::text,
    null, jsonb_build_object('state', 'confirmed', 'invalidated_sessions', removed_sessions,
      'auth_identity_sync', 'complete'), account.id, null, 'api'
  );
  update public.account_email_change_requests as email_request
  set state = 'confirmed', confirmed_at = now(), completed_audit_id = logged_id
  where email_request.id = change_request.id;
  return query select 'confirmed'::text, logged_id;
end;
$$;

revoke all on function public.resolve_account_email_change_confirmation(text) from public, anon, authenticated;
revoke all on function public.void_account_email_change(text, text) from public, anon, authenticated;
revoke all on function public.record_account_email_change_divergence(text, text) from public, anon, authenticated;
grant execute on function public.resolve_account_email_change_confirmation(text) to service_role;
grant execute on function public.void_account_email_change(text, text) to service_role;
grant execute on function public.record_account_email_change_divergence(text, text) to service_role;

-- Redemption now has to pass through the route handler that moves the auth identity first, so the
-- projection write is no longer reachable on its own with only a token.
revoke execute on function public.complete_account_email_change(text, text) from anon, authenticated;
