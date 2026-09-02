-- Account-email changes keep their capabilities outside the browser and only retain SHA-256
-- digests. GoTrue owns auth.users, so this migration changes the application projection only.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('auth.email_change.requested', 'human', 'platform', false, false, 'Email change request logged', 'Account email change request recorded in the audit log'),
  ('auth.email_change.confirmed', 'human', 'platform', false, false, 'Email change confirmed', 'Account email change confirmation recorded in the audit log'),
  ('auth.email_change.refused', 'human', 'platform', false, false, 'Email change refused', 'Account email change refusal recorded in the audit log')
on conflict (key) do nothing;

create table public.account_email_change_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  current_email text not null,
  requested_email text not null,
  confirmation_token_hash text not null unique check (confirmation_token_hash ~ '^[a-f0-9]{64}$'),
  refusal_token_hash text not null unique check (refusal_token_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending', 'confirmed', 'refused', 'superseded')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  refused_at timestamptz,
  superseded_at timestamptz,
  requested_audit_id bigint not null references public.audit_log(id) on delete restrict,
  completed_audit_id bigint references public.audit_log(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint account_email_change_requested_email_check check (
    lower(current_email) <> lower(requested_email)
    and char_length(requested_email) between 3 and 320
  ),
  constraint account_email_change_state_shape check (
    (state = 'pending' and confirmed_at is null and refused_at is null and superseded_at is null and completed_audit_id is null)
    or (state = 'confirmed' and confirmed_at is not null and refused_at is null and superseded_at is null and completed_audit_id is not null)
    or (state = 'refused' and confirmed_at is null and refused_at is not null and superseded_at is null and completed_audit_id is not null)
    or (state = 'superseded' and confirmed_at is null and refused_at is null and superseded_at is not null)
  )
);
create index account_email_change_requests_user_pending_idx
  on public.account_email_change_requests (user_id, created_at desc)
  where state = 'pending';

alter table public.account_email_change_requests enable row level security;
alter table public.account_email_change_requests force row level security;
revoke all on table public.account_email_change_requests from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.account_email_change_requests to service_role;

create function app.assert_account_email_change_account(p_expected_user uuid, p_expected_tenant uuid, p_current_auth_email text)
returns public.users
language plpgsql
stable
security definer
set search_path = ''
as $$
declare account public.users%rowtype;
begin
  select * into account
  from public.users as account_user
  where account_user.id = p_expected_user
    and account_user.tenant_id is not distinct from p_expected_tenant;
  if account.id is null or lower(account.email) <> lower(btrim(p_current_auth_email)) then
    raise exception 'ACCOUNT_EMAIL_CHANGE_ACCOUNT_MISMATCH';
  end if;
  return account;
end;
$$;

create function public.begin_account_email_change(
  p_expected_user uuid,
  p_expected_tenant uuid,
  p_current_auth_email text,
  p_requested_email text,
  p_confirmation_token_hash text,
  p_refusal_token_hash text,
  p_mfa_counter bigint default null
)
returns table(request_id uuid, expires_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  account public.users%rowtype;
  factor public.account_mfa_factors%rowtype;
  change_request public.account_email_change_requests%rowtype;
  requested_email text;
  logged_id bigint;
begin
  account := app.assert_account_email_change_account(p_expected_user, p_expected_tenant, p_current_auth_email);
  requested_email := lower(btrim(p_requested_email));
  if requested_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(requested_email) > 320
    or requested_email = lower(account.email)
    or p_confirmation_token_hash !~ '^[a-f0-9]{64}$'
    or p_refusal_token_hash !~ '^[a-f0-9]{64}$'
    or p_confirmation_token_hash = p_refusal_token_hash then
    raise exception 'ACCOUNT_EMAIL_CHANGE_REFUSED';
  end if;

  -- Check both identity stores. The generic error above is intentionally shared with malformed
  -- addresses so this function never becomes an account-enumeration oracle.
  if exists (select 1 from public.users as existing_user where lower(existing_user.email) = requested_email)
    or exists (select 1 from auth.users as auth_user where lower(auth_user.email) = requested_email) then
    raise exception 'ACCOUNT_EMAIL_CHANGE_REFUSED';
  end if;

  select * into factor
  from public.account_mfa_factors as mfa_factor
  where mfa_factor.user_id = account.id
  for update;
  if factor.user_id is not null and factor.state = 'active' then
    if p_mfa_counter is null or p_mfa_counter < 0
      or (factor.last_used_counter is not null and p_mfa_counter <= factor.last_used_counter) then
      raise exception 'ACCOUNT_EMAIL_CHANGE_MFA_REFUSED';
    end if;
    update public.account_mfa_factors as mfa_factor
    set last_used_counter = p_mfa_counter
    where mfa_factor.user_id = account.id;
  end if;

  update public.account_email_change_requests as pending_request
  set state = 'superseded', superseded_at = now()
  where pending_request.user_id = account.id
    and pending_request.state = 'pending';

  logged_id := app.write_audit_row(
    'auth.email_change.requested', account.id, account.tenant_id, 'account', account.id::text,
    null, jsonb_build_object('state', 'pending'), account.id, null, 'api'
  );
  insert into public.account_email_change_requests as new_request (
    user_id, current_email, requested_email, confirmation_token_hash, refusal_token_hash,
    expires_at, requested_audit_id
  ) values (
    account.id, lower(account.email), requested_email, p_confirmation_token_hash, p_refusal_token_hash,
    now() + interval '1 hour', logged_id
  ) returning * into change_request;
  return query select change_request.id, change_request.expires_at, logged_id;
end;
$$;

create function public.complete_account_email_change(p_token_hash text, p_action text)
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
  -- competing identity won, and leave the application address unchanged.
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
  delete from auth.sessions as auth_session where auth_session.user_id = account.id;
  get diagnostics removed_sessions = row_count;
  logged_id := app.write_audit_row(
    'auth.email_change.confirmed', account.id, account.tenant_id, 'account', account.id::text,
    null, jsonb_build_object('state', 'confirmed', 'invalidated_sessions', removed_sessions,
      'auth_identity_sync', 'pending'), account.id, null, 'api'
  );
  update public.account_email_change_requests as email_request
  set state = 'confirmed', confirmed_at = now(), completed_audit_id = logged_id
  where email_request.id = change_request.id;
  return query select 'confirmed'::text, logged_id;
end;
$$;

revoke all on function app.assert_account_email_change_account(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.begin_account_email_change(uuid, uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.complete_account_email_change(text, text) from public;
grant execute on function public.begin_account_email_change(uuid, uuid, text, text, text, text, bigint) to service_role;
grant execute on function public.complete_account_email_change(text, text) to anon, authenticated, service_role;
