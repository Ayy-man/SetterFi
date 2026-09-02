-- Install grant duality: one agency, two marketplace apps, two independent grants.
--
-- The marketplace fact this exists for: app 1 (SetterFi Agent) is a Sub-Account-target app with
-- bulk install enabled, and when an *agency* user installs it HighLevel returns a grant with
-- "userType": "Company" and "isBulkInstallation": true — not the Location grant a sub-account
-- target sounds like it would return. That agency-level Company grant is the only shape that
-- carries the `oauth.*` scopes `POST /oauth/locationToken` needs, and that call is sent with
-- `X-Client-Id: <app 1's client id>` (src/lib/integrations/ghl.ts:395-404), so the Bearer it pairs
-- with must be app 1's Company token, not app 2's.
--
-- `company_id text unique` cannot hold both. App 1's Company grant and app 2's Company grant for
-- the same agency collide on one row, and they are different credentials with different client ids
-- and refresh tokens that rotate independently — overwriting one with the other loses an install
-- permanently, because a refresh token is spent the first time it is used.
--
-- Nothing here touches a grant, a policy, or an RLS setting. Both tables are already FORCE RLS
-- with service-role-only grants (20260825000002 and 20260820000001) and stay that way.

-- ---------------------------------------------------------------------------
-- 1. Which app's grant a row holds
-- ---------------------------------------------------------------------------

alter table public.ghl_agency_installs
  add column app text not null default 'provisioning';

-- Every row that exists today was written by the agency callback, which only ever exchanged app
-- 2's code, so the default backfills them correctly rather than guessing.
alter table public.ghl_agency_installs
  add constraint ghl_agency_installs_app_chk check (app in ('agent', 'provisioning'));

-- Dropped by name. If the constraint is called something else the migration fails loudly here,
-- which is the outcome we want: a silently-kept single-column unique would still collide the two
-- apps and nothing downstream would notice until an install overwrote the other one.
alter table public.ghl_agency_installs
  drop constraint ghl_agency_installs_company_id_key;

alter table public.ghl_agency_installs
  add constraint ghl_agency_installs_app_company_key unique (app, company_id);

-- ---------------------------------------------------------------------------
-- 2. The lease's identity, so an expired holder cannot commit over its successor
-- ---------------------------------------------------------------------------

alter table public.ghl_agency_installs add column refresh_lock_token uuid;
alter table public.ghl_install_secrets add column refresh_lock_token uuid;

-- ---------------------------------------------------------------------------
-- 3. Comments
-- ---------------------------------------------------------------------------

comment on column public.ghl_agency_installs.app is
  'Which marketplace app''s grant this row holds. An agency-level install of the sub-account-target agent app returns a Company grant of its own, with a different client id and an independently rotating refresh token, so it cannot share a row with the agency app''s grant for the same company.';
comment on column public.ghl_agency_installs.refresh_lock_token is
  'The lease''s identity, presented by whoever holds it. A holder whose sixty-second lease expired and whose row was re-claimed by another instance matches nothing on this column, so it cannot commit or release over the grant the winner actually persisted.';
comment on column public.ghl_install_secrets.refresh_lock_token is
  'The lease''s identity for the sub-account refresh token, mirroring ghl_agency_installs.refresh_lock_token.';
