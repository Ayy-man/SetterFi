-- A TOTP factor is intentionally private to the server API. Enrollment is pending until a
-- correct code is atomically consumed, and the last accepted counter makes each TOTP code single-use.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('auth.mfa.enrolled', 'human', 'platform', false, false, 'Second-factor enrollment logged', 'Second-factor enrollment recorded in the audit log'),
  ('auth.mfa.activated', 'human', 'platform', false, false, 'Second-factor activation logged', 'Second-factor activation recorded in the audit log'),
  ('auth.mfa.verification_failed', 'human', 'platform', false, false, 'Second-factor verification failure logged', 'Second-factor verification failure recorded in the audit log'),
  ('auth.mfa.disabled', 'human', 'platform', false, false, 'Second-factor removal logged', 'Second-factor removal recorded in the audit log')
on conflict (key) do nothing;

create table public.account_mfa_factors (
  user_id uuid primary key references public.users(id) on delete cascade,
  -- Length is checked separately from shape: PostgreSQL caps a regex repetition count at 255, so
  -- '{16,256}' is not a wide bound, it is an invalid expression that raises on every row.
  secret text not null check (secret ~ '^[A-Z2-7]+$' and char_length(secret) between 16 and 256),
  state text not null default 'pending' check (state in ('pending', 'active')),
  activated_at timestamptz,
  last_used_counter bigint check (last_used_counter is null or last_used_counter >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_mfa_factors_activation_shape check (
    (state = 'pending' and activated_at is null) or (state = 'active' and activated_at is not null)
  )
);

create trigger account_mfa_factors_set_updated_at
before update on public.account_mfa_factors
for each row execute function app.set_updated_at();

alter table public.account_mfa_factors enable row level security;
alter table public.account_mfa_factors force row level security;
revoke all on table public.account_mfa_factors from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.account_mfa_factors to service_role;

create function app.assert_account_mfa_account(p_user_id uuid, p_tenant_id uuid)
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
  where account_user.id = p_user_id
    and account_user.tenant_id is not distinct from p_tenant_id;
  if account.id is null then raise exception 'ACCOUNT_MFA_ACCOUNT_MISMATCH'; end if;
  return account;
end;
$$;

create function public.enroll_account_mfa(
  p_expected_user uuid,
  p_expected_tenant uuid,
  p_secret text
)
returns table(status text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare account public.users%rowtype; factor public.account_mfa_factors%rowtype; logged_id bigint;
begin
  account := app.assert_account_mfa_account(p_expected_user, p_expected_tenant);
  if p_secret !~ '^[A-Z2-7]+$' or char_length(p_secret) not between 16 and 256 then
    raise exception 'ACCOUNT_MFA_SECRET_INVALID';
  end if;
  insert into public.account_mfa_factors as new_factor (user_id, secret, state, activated_at, last_used_counter)
  values (account.id, p_secret, 'pending', null, null)
  on conflict (user_id) do update
    set secret = excluded.secret, state = 'pending', activated_at = null, last_used_counter = null
    where new_factor.state = 'pending'
  returning * into factor;
  if factor.user_id is null then raise exception 'ACCOUNT_MFA_ALREADY_ACTIVE'; end if;
  logged_id := app.write_audit_row(
    'auth.mfa.enrolled', account.id, account.tenant_id, 'account_mfa_factor', account.id::text,
    null, jsonb_build_object('state', factor.state), account.id, null, 'api'
  );
  return query select factor.state, logged_id;
end;
$$;

create function public.get_account_mfa_status(p_expected_user uuid, p_expected_tenant uuid)
returns table(status text)
language plpgsql
security definer
set search_path = ''
as $$
declare account public.users%rowtype; factor public.account_mfa_factors%rowtype;
begin
  account := app.assert_account_mfa_account(p_expected_user, p_expected_tenant);
  select * into factor from public.account_mfa_factors as mfa_factor where mfa_factor.user_id = account.id;
  return query select coalesce(factor.state, 'none');
end;
$$;

-- Service-role only: the Next route reads this to verify a browser-supplied code, but never serializes it.
create function public.get_account_mfa_factor_for_verification(p_expected_user uuid, p_expected_tenant uuid)
returns table(status text, secret text)
language plpgsql
security definer
set search_path = ''
as $$
declare account public.users%rowtype;
begin
  account := app.assert_account_mfa_account(p_expected_user, p_expected_tenant);
  return query
    select mfa_factor.state, mfa_factor.secret
    from public.account_mfa_factors as mfa_factor
    where mfa_factor.user_id = account.id;
end;
$$;

create function public.record_account_mfa_failed_verification(p_expected_user uuid, p_expected_tenant uuid)
returns table(audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare account public.users%rowtype; factor public.account_mfa_factors%rowtype; logged_id bigint;
begin
  account := app.assert_account_mfa_account(p_expected_user, p_expected_tenant);
  select * into factor from public.account_mfa_factors as mfa_factor where mfa_factor.user_id = account.id;
  if factor.user_id is null then raise exception 'ACCOUNT_MFA_FACTOR_NOT_FOUND'; end if;
  logged_id := app.write_audit_row(
    'auth.mfa.verification_failed', account.id, account.tenant_id, 'account_mfa_factor', account.id::text,
    null, jsonb_build_object('state', factor.state), account.id, null, 'api'
  );
  return query select logged_id;
end;
$$;

-- The route checks the HMAC with Node crypto, then this transaction records the exact accepted
-- counter. Locking the row makes a concurrent replay lose even if both requests passed HMAC verification.
create function public.consume_account_mfa_totp(
  p_expected_user uuid,
  p_expected_tenant uuid,
  p_counter bigint,
  p_purpose text
)
returns table(status text, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare account public.users%rowtype; factor public.account_mfa_factors%rowtype; logged_id bigint;
begin
  account := app.assert_account_mfa_account(p_expected_user, p_expected_tenant);
  if p_counter < 0 or p_purpose not in ('activate', 'disable') then raise exception 'ACCOUNT_MFA_CONSUME_INVALID'; end if;
  select * into factor
  from public.account_mfa_factors as mfa_factor
  where mfa_factor.user_id = account.id
  for update;
  if factor.user_id is null then raise exception 'ACCOUNT_MFA_FACTOR_NOT_FOUND'; end if;
  if (p_purpose = 'activate' and factor.state <> 'pending')
    or (p_purpose = 'disable' and factor.state <> 'active') then
    raise exception 'ACCOUNT_MFA_FACTOR_STATE_INVALID';
  end if;
  if factor.last_used_counter is not null and p_counter <= factor.last_used_counter then
    raise exception 'ACCOUNT_MFA_CODE_REPLAYED';
  end if;

  if p_purpose = 'activate' then
    update public.account_mfa_factors as mfa_factor
    set state = 'active', activated_at = now(), last_used_counter = p_counter
    where mfa_factor.user_id = account.id;
    logged_id := app.write_audit_row(
      'auth.mfa.activated', account.id, account.tenant_id, 'account_mfa_factor', account.id::text,
      null, jsonb_build_object('counter', p_counter), account.id, null, 'api'
    );
    -- RETURN QUERY appends rows and keeps executing; without this the activate branch fell
    -- straight through into the disable branch below and deleted the factor it had just made
    -- active, returning both rows.
    return query select 'active'::text, logged_id;
    return;
  end if;

  delete from public.account_mfa_factors as mfa_factor where mfa_factor.user_id = account.id;
  logged_id := app.write_audit_row(
    'auth.mfa.disabled', account.id, account.tenant_id, 'account_mfa_factor', account.id::text,
    null, jsonb_build_object('counter', p_counter), account.id, null, 'api'
  );
  return query select 'none'::text, logged_id;
end;
$$;

revoke all on function app.assert_account_mfa_account(uuid, uuid) from public, anon, authenticated;
revoke all on function public.enroll_account_mfa(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_account_mfa_status(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_account_mfa_factor_for_verification(uuid, uuid) from public, anon, authenticated;
revoke all on function public.record_account_mfa_failed_verification(uuid, uuid) from public, anon, authenticated;
revoke all on function public.consume_account_mfa_totp(uuid, uuid, bigint, text) from public, anon, authenticated;
grant execute on function public.enroll_account_mfa(uuid, uuid, text) to service_role;
grant execute on function public.get_account_mfa_status(uuid, uuid) to service_role;
grant execute on function public.get_account_mfa_factor_for_verification(uuid, uuid) to service_role;
grant execute on function public.record_account_mfa_failed_verification(uuid, uuid) to service_role;
grant execute on function public.consume_account_mfa_totp(uuid, uuid, bigint, text) to service_role;
