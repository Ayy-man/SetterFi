-- Coach teammate invitations are deliberately a single-workspace capability. `public.users` and
-- the JWT contract still carry one tenant; the membership row gives revocation a live database
-- authority check without pretending that account switching already exists.
set search_path = public, extensions;

insert into public.audit_actions (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('tenant.membership.invited', 'human', 'tenant', false, true, 'Teammate invitation logged', 'Teammate invitation recorded in the audit log'),
  ('tenant.membership.accepted', 'human', 'tenant', false, true, 'Teammate acceptance logged', 'Teammate acceptance recorded in the audit log'),
  ('tenant.membership.declined', 'human', 'tenant', false, true, 'Teammate decline logged', 'Teammate decline recorded in the audit log'),
  ('tenant.membership.expired', 'system', 'tenant', false, true, 'Teammate invitation expiry logged', 'Teammate invitation expiry recorded in the audit log'),
  ('tenant.membership.revoked', 'human', 'tenant', false, true, 'Teammate removal logged', 'Teammate removal recorded in the audit log')
on conflict (key) do nothing;

create table public.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete restrict,
  role public.user_role not null check (role = 'coach_member'),
  invited_by uuid not null references public.users(id) on delete restrict,
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id),
  constraint tenant_memberships_revocation_shape check (
    (revoked_at is null and revoked_by is null) or (revoked_at is not null and revoked_by is not null)
  )
);
create index tenant_memberships_active_user_idx on public.tenant_memberships (user_id, tenant_id) where revoked_at is null;

create table public.tenant_member_invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  invited_by uuid not null references public.users(id) on delete restrict,
  invitee_email text not null check (invitee_email = lower(btrim(invitee_email))),
  role public.user_role not null check (role = 'coach_member'),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'expired')),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  declined_at timestamptz,
  expired_at timestamptz,
  responded_by uuid references public.users(id) on delete restrict,
  membership_id uuid references public.tenant_memberships(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tenant_member_invitations_expiry_future check (expires_at > created_at),
  constraint tenant_member_invitations_response_shape check (
    (status = 'pending' and accepted_at is null and declined_at is null and expired_at is null and responded_by is null and membership_id is null)
    or (status = 'accepted' and accepted_at is not null and declined_at is null and expired_at is null and responded_by is not null and membership_id is not null)
    or (status = 'declined' and accepted_at is null and declined_at is not null and expired_at is null and responded_by is not null and membership_id is null)
    or (status = 'expired' and accepted_at is null and declined_at is null and expired_at is not null and responded_by is null and membership_id is null)
  )
);
create index tenant_member_invitations_tenant_created_idx on public.tenant_member_invitations (tenant_id, created_at desc);
create index tenant_member_invitations_recipient_pending_idx on public.tenant_member_invitations (invitee_email, expires_at) where status = 'pending';

create trigger tenant_memberships_set_updated_at before update on public.tenant_memberships
for each row execute function app.set_updated_at();
create trigger tenant_member_invitations_set_updated_at before update on public.tenant_member_invitations
for each row execute function app.set_updated_at();

alter table public.tenant_memberships enable row level security;
alter table public.tenant_memberships force row level security;
alter table public.tenant_member_invitations enable row level security;
alter table public.tenant_member_invitations force row level security;
revoke all on public.tenant_memberships, public.tenant_member_invitations from public, anon, authenticated, service_role;
grant select on public.tenant_memberships, public.tenant_member_invitations to service_role;

-- `coach_member` access must resolve through an unrevoked membership at query time. Existing
-- coach owners retain their original one-row `users.tenant_id` authority; only delegated access
-- gets this additional live check, so revocation denies RLS reads immediately even before a JWT
-- naturally refreshes.
create or replace function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when app.current_user_role() = 'coach_member' then (
      select membership.tenant_id
      from public.tenant_memberships membership
      where membership.user_id = app.current_user_id()
        and membership.tenant_id = app.claim('tenant_id')::uuid
        and membership.role = 'coach_member'
        and membership.revoked_at is null
      limit 1
    )
    when app.is_platform_user() then coalesce(app.claim('impersonating_tenant'), app.claim('tenant_id'))::uuid
    else app.claim('tenant_id')::uuid
  end;
$$;

create function app.assert_tenant_membership_coach(p_expected_tenant uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare actor public.users%rowtype;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if p_expected_tenant is null then raise exception 'EXPECTED_TENANT_REQUIRED'; end if;
  select * into actor from public.users where id = p_actor_id for update;
  if actor.id is null or actor.role <> 'coach' or actor.tenant_id is distinct from p_expected_tenant then
    raise exception 'TENANT_MEMBERSHIP_COACH_REQUIRED';
  end if;
  perform app.assert_expected_tenant(p_expected_tenant, actor.tenant_id, 'tenant_membership_actor');
end;
$$;

create function public.create_tenant_member_invitation(
  p_expected_tenant uuid,
  p_actor_id uuid,
  p_invitee_email text,
  p_role public.user_role,
  p_token_hash text,
  p_expires_at timestamptz
)
returns table(invitation_id uuid, tenant_id uuid, invitee_email text, role public.user_role, expires_at timestamptz, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare invitation public.tenant_member_invitations%rowtype; tenant_row public.tenants%rowtype; actor public.users%rowtype; logged_id bigint;
begin
  perform app.assert_tenant_membership_coach(p_expected_tenant, p_actor_id);
  if p_role <> 'coach_member' then raise exception 'TENANT_MEMBERSHIP_ROLE_FORBIDDEN'; end if;
  if nullif(btrim(p_invitee_email), '') is null or lower(btrim(p_invitee_email)) !~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$' then
    raise exception 'TENANT_MEMBERSHIP_INVITEE_EMAIL_INVALID';
  end if;
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'TENANT_MEMBERSHIP_TOKEN_HASH_INVALID'; end if;
  if p_expires_at <= now() or p_expires_at > now() + interval '30 days' then raise exception 'TENANT_MEMBERSHIP_EXPIRY_INVALID'; end if;
  select * into tenant_row from public.tenants where id = p_expected_tenant for key share;
  if tenant_row.id is null then raise exception 'TENANT_MEMBERSHIP_TENANT_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, tenant_row.id, 'tenant_member_invitation');
  select * into actor from public.users where id = p_actor_id;
  if lower(actor.email) = lower(btrim(p_invitee_email)) then raise exception 'TENANT_MEMBERSHIP_SELF_INVITE_FORBIDDEN'; end if;
  insert into public.tenant_member_invitations (tenant_id, invited_by, invitee_email, role, token_hash, expires_at)
  values (p_expected_tenant, p_actor_id, lower(btrim(p_invitee_email)), p_role, p_token_hash, p_expires_at)
  returning * into invitation;
  logged_id := app.write_audit_row('tenant.membership.invited', p_actor_id, p_expected_tenant,
    'tenant_member_invitation', invitation.id::text, null,
    jsonb_build_object('role', invitation.role, 'invitee_email_hash', encode(extensions.digest(invitation.invitee_email, 'sha256'), 'hex'), 'expires_at', invitation.expires_at));
  return query select invitation.id, invitation.tenant_id, invitation.invitee_email, invitation.role, invitation.expires_at, logged_id;
end;
$$;

create function public.accept_tenant_member_invitation(p_token_hash text, p_actor_id uuid)
returns table(invitation_id uuid, tenant_id uuid, membership_id uuid, role public.user_role, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare invitation public.tenant_member_invitations%rowtype; recipient public.users%rowtype; membership public.tenant_memberships%rowtype; logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'TENANT_MEMBERSHIP_TOKEN_HASH_INVALID'; end if;
  select * into invitation from public.tenant_member_invitations where token_hash = p_token_hash for update;
  if invitation.id is null then raise exception 'TENANT_MEMBERSHIP_INVITATION_INVALID'; end if;
  if invitation.status = 'accepted' then raise exception 'TENANT_MEMBERSHIP_INVITATION_ALREADY_ACCEPTED'; end if;
  if invitation.status <> 'pending' then raise exception 'TENANT_MEMBERSHIP_INVITATION_UNAVAILABLE'; end if;
  if invitation.expires_at <= now() then
    update public.tenant_member_invitations set status = 'expired', expired_at = now() where id = invitation.id;
    perform app.write_audit_row('tenant.membership.expired', invitation.invited_by, invitation.tenant_id,
      'tenant_member_invitation', invitation.id::text, null, jsonb_build_object('expired_at', now()));
    raise exception 'TENANT_MEMBERSHIP_INVITATION_EXPIRED';
  end if;
  select * into recipient from public.users where id = p_actor_id for update;
  if recipient.id is null or lower(recipient.email) <> invitation.invitee_email then raise exception 'TENANT_MEMBERSHIP_INVITEE_REQUIRED'; end if;
  if recipient.tenant_id is not null and recipient.tenant_id is distinct from invitation.tenant_id then
    raise exception 'TENANT_MEMBERSHIP_ACCOUNT_ALREADY_ATTACHED';
  end if;
  if recipient.tenant_id is null and recipient.role <> 'affiliate' then raise exception 'TENANT_MEMBERSHIP_ACCOUNT_ROLE_REQUIRES_REVIEW'; end if;
  insert into public.tenant_memberships (tenant_id, user_id, role, invited_by)
  values (invitation.tenant_id, recipient.id, invitation.role, invitation.invited_by)
  on conflict (tenant_id, user_id) do update set role = excluded.role, invited_by = excluded.invited_by,
    accepted_at = now(), revoked_at = null, revoked_by = null, updated_at = now()
  returning * into membership;
  update public.users set role = invitation.role, tenant_id = invitation.tenant_id, updated_at = now()
  where id = recipient.id and (tenant_id is null or tenant_id = invitation.tenant_id);
  update public.tenant_member_invitations set status = 'accepted', accepted_at = now(), responded_by = recipient.id,
    membership_id = membership.id where id = invitation.id;
  logged_id := app.write_audit_row('tenant.membership.accepted', recipient.id, invitation.tenant_id,
    'tenant_membership', membership.id::text, null, jsonb_build_object('invitation_id', invitation.id, 'role', membership.role));
  return query select invitation.id, invitation.tenant_id, membership.id, membership.role, logged_id;
end;
$$;

create function public.decline_tenant_member_invitation(p_token_hash text, p_actor_id uuid)
returns table(invitation_id uuid, tenant_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare invitation public.tenant_member_invitations%rowtype; recipient public.users%rowtype; logged_id bigint;
begin
  perform app.assert_not_impersonating();
  perform app.assert_actor_not_impersonating(p_actor_id);
  if p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'TENANT_MEMBERSHIP_TOKEN_HASH_INVALID'; end if;
  select * into invitation from public.tenant_member_invitations where token_hash = p_token_hash for update;
  if invitation.id is null or invitation.status <> 'pending' then raise exception 'TENANT_MEMBERSHIP_INVITATION_UNAVAILABLE'; end if;
  if invitation.expires_at <= now() then
    update public.tenant_member_invitations set status = 'expired', expired_at = now() where id = invitation.id;
    raise exception 'TENANT_MEMBERSHIP_INVITATION_EXPIRED';
  end if;
  select * into recipient from public.users where id = p_actor_id for update;
  if recipient.id is null or lower(recipient.email) <> invitation.invitee_email then raise exception 'TENANT_MEMBERSHIP_INVITEE_REQUIRED'; end if;
  update public.tenant_member_invitations set status = 'declined', declined_at = now(), responded_by = recipient.id where id = invitation.id;
  logged_id := app.write_audit_row('tenant.membership.declined', recipient.id, invitation.tenant_id,
    'tenant_member_invitation', invitation.id::text, null, '{}'::jsonb);
  return query select invitation.id, invitation.tenant_id, logged_id;
end;
$$;

create function public.revoke_tenant_membership(p_expected_tenant uuid, p_actor_id uuid, p_membership_id uuid)
returns table(membership_id uuid, user_id uuid, tenant_id uuid, audit_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare membership public.tenant_memberships%rowtype; logged_id bigint;
begin
  perform app.assert_tenant_membership_coach(p_expected_tenant, p_actor_id);
  select * into membership from public.tenant_memberships where id = p_membership_id for update;
  if membership.id is null then raise exception 'TENANT_MEMBERSHIP_NOT_FOUND'; end if;
  perform app.assert_expected_tenant(p_expected_tenant, membership.tenant_id, 'tenant_membership_revoke');
  if membership.revoked_at is not null then raise exception 'TENANT_MEMBERSHIP_ALREADY_REVOKED'; end if;
  update public.tenant_memberships set revoked_at = now(), revoked_by = p_actor_id where id = membership.id;
  logged_id := app.write_audit_row('tenant.membership.revoked', p_actor_id, p_expected_tenant,
    'tenant_membership', membership.id::text, null, jsonb_build_object('user_id', membership.user_id, 'role', membership.role));
  return query select membership.id, membership.user_id, membership.tenant_id, logged_id;
end;
$$;

revoke execute on function app.assert_tenant_membership_coach(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.create_tenant_member_invitation(uuid,uuid,text,public.user_role,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.accept_tenant_member_invitation(text,uuid) from public, anon, authenticated;
revoke execute on function public.decline_tenant_member_invitation(text,uuid) from public, anon, authenticated;
revoke execute on function public.revoke_tenant_membership(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function app.assert_tenant_membership_coach(uuid,uuid) to service_role;
grant execute on function public.create_tenant_member_invitation(uuid,uuid,text,public.user_role,text,timestamptz) to service_role;
grant execute on function public.accept_tenant_member_invitation(text,uuid) to service_role;
grant execute on function public.decline_tenant_member_invitation(text,uuid) to service_role;
grant execute on function public.revoke_tenant_membership(uuid,uuid,uuid) to service_role;
