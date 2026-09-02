-- Phase 9 remediation: OAuth install custody for the two marketplace apps.
--
-- Two holes close here. First, the install callback had nowhere to put a `state` it issued, so a
-- public redirect URL could not be told apart from a forged one. Second, the agency access token
-- lived in a static environment variable while the provider rotates it every ~24 hours and
-- invalidates the refresh token on every use, so the deployment silently stopped being able to
-- mint per-location tokens a day after someone pasted the value in.
--
-- Both new tables are service-role only. The agency install is platform plumbing with no browser
-- surface at all, so its envelopes and its metadata live in one forced-RLS table rather than the
-- split custody `ghl_installs` needs to keep a browser-readable metadata row.

-- ---------------------------------------------------------------------------
-- 1. Single-use, short-TTL OAuth state for both marketplace apps
-- ---------------------------------------------------------------------------

create table public.ghl_oauth_states (
  id uuid primary key default gen_random_uuid(),
  app text not null check (app in ('agent', 'provisioning')),
  state_hash text unique not null check (state_hash ~ '^[0-9a-f]{64}$'),
  tenant_id uuid references public.tenants(id) on delete cascade,
  actor_id uuid not null references public.users(id),
  return_path text not null check (return_path ~ '^/[^/]'),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ghl_oauth_states_expiry_chk check (
    expires_at > created_at and expires_at <= created_at + interval '10 minutes'
  ),
  constraint ghl_oauth_states_consumed_chk check (consumed_at is null or consumed_at >= created_at)
);
create index ghl_oauth_states_expiry_idx
  on public.ghl_oauth_states (expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- 2. The agency install, stored instead of pasted
-- ---------------------------------------------------------------------------

create table public.ghl_agency_installs (
  id uuid primary key default gen_random_uuid(),
  company_id text unique not null check (nullif(btrim(company_id), '') is not null),
  install_state public.install_state not null default 'installed',
  access_credential_envelope jsonb not null
    check (jsonb_typeof(access_credential_envelope) = 'object'),
  refresh_credential_envelope jsonb not null
    check (jsonb_typeof(refresh_credential_envelope) = 'object'),
  token_expires_at timestamptz not null,
  -- Held by whichever serverless instance is mid-refresh. The provider invalidates a refresh token
  -- the moment it is used, so two instances refreshing at once permanently loses the install.
  refresh_lock_expires_at timestamptz,
  reauthorization_required_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. The same two protections for sub-account installs
-- ---------------------------------------------------------------------------

alter table public.ghl_install_secrets add column refresh_lock_expires_at timestamptz;
alter table public.ghl_installs add column reauthorization_required_at timestamptz;
create index ghl_installs_reauthorization_idx
  on public.ghl_installs (reauthorization_required_at)
  where reauthorization_required_at is not null;

-- ---------------------------------------------------------------------------
-- 4. Registered audit actions
-- ---------------------------------------------------------------------------

insert into public.audit_actions
  (key, actor_kind, scope, reason_required, coach_visible, microcopy, aria_label)
values
  ('channel.messaging_install.started', 'human', 'platform', false, false,
    'Install start logged', 'Messaging install start recorded in the audit log'),
  ('channel.messaging_install.completed', 'system', 'tenant', false, true,
    'Connection logged', 'Messaging connection recorded in the audit log'),
  ('channel.messaging_install.reauthorization_required', 'system', 'tenant', false, true,
    'Reconnect needed logged', 'Messaging reconnection requirement recorded in the audit log'),
  ('platform.provisioning_install.completed', 'system', 'platform', false, false,
    'Install logged', 'Provisioning install recorded in the audit log'),
  ('platform.provisioning_install.reauthorization_required', 'system', 'platform', false, false,
    'Reconnect needed logged', 'Provisioning reconnection requirement recorded in the audit log');

-- ---------------------------------------------------------------------------
-- 5. Forced RLS, exact grants, triggers, and comments
-- ---------------------------------------------------------------------------

do $$
declare
  table_name text;
begin
  foreach table_name in array array['ghl_oauth_states', 'ghl_agency_installs'] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format('revoke all on public.%I from public, anon, authenticated', table_name);
    execute format('grant all on public.%I to service_role', table_name);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true)',
      table_name || '_service_all',
      table_name
    );
  end loop;
end
$$;

create trigger set_updated_at before update on public.ghl_agency_installs
  for each row execute function app.set_updated_at();

comment on table public.ghl_oauth_states is
  'Single-use, ten-minute OAuth state for the marketplace install callbacks. Only the SHA-256 hash is stored; the callback consumes a row atomically so a replayed redirect matches nothing.';
comment on table public.ghl_agency_installs is
  'Service-only agency install custody: V1 AES-256-GCM envelopes plus the expiry the resolver refreshes against. Replaces the static agency access token, which expired ~24 hours after it was pasted.';
comment on column public.ghl_agency_installs.refresh_lock_expires_at is
  'Compare-and-set lease. A refresh token is single-use, so exactly one instance may spend it; the lease expires so a crashed instance cannot wedge the install.';
comment on column public.ghl_agency_installs.reauthorization_required_at is
  'Set when the provider refuses the grant. The resolver fails closed from here rather than retrying a token the provider has already revoked.';
comment on column public.ghl_install_secrets.refresh_lock_expires_at is
  'Compare-and-set lease protecting the single-use sub-account refresh token, mirroring ghl_agency_installs.';
comment on column public.ghl_installs.reauthorization_required_at is
  'Set when the provider refuses this location grant; the install needs a human re-authorization before it can send again.';
