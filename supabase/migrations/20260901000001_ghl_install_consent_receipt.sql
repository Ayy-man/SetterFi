-- What the installer was offered, and what they chose.
--
-- `POST /oauth/token` answers with three booleans beside the tokens —
-- https://marketplace.gohighlevel.com/docs/ghl/oauth/get-access-token/ (checked 2026-08-22):
--
--   approveAllLocations       optional boolean, "only for company tokens"
--   isBulkInstallation        optional boolean
--   installToFutureLocations  optional boolean, "only for company tokens"
--
-- We stored none of them, so an install we did not watch happen could not be reconstructed from our
-- own rows: the client walked one, and nothing here could say what the consent screen offered him or
-- which way he answered. `installToFutureLocations = false` on a stored company grant — new
-- sub-accounts do not inherit the app — was observable only by asking the provider.
--
-- Nullable, with no backfill and no default. A row written before this migration genuinely does not
-- know, and `false` would be a fabricated answer to a question nobody asked it. `null` is also what
-- a location grant honestly holds for the two company-only flags. The three-state read is the
-- point: yes, no, or not recorded.
--
-- Both tables keep the posture they already have. `ghl_agency_installs` is FORCE RLS, service-role
-- only (20260825000002); `ghl_installs` keeps its existing tenant-scoped policies (20260820000001).
-- Nothing here touches a policy, a grant, or an RLS setting.

alter table public.ghl_agency_installs
  add column approve_all_locations boolean,
  add column is_bulk_installation boolean,
  add column install_to_future_locations boolean;

-- All three on the sub-account table too, and for one reason: the rule the writer follows is
-- "persist what the response carried", never "decide which fields a Location grant is allowed to
-- have". Two of them are documented company-only and will read null on a location row, which is the
-- honest value; if the provider ever does send one, it lands in a column instead of being dropped —
-- which is the failure this migration exists to close.
alter table public.ghl_installs
  add column approve_all_locations boolean,
  add column is_bulk_installation boolean,
  add column install_to_future_locations boolean;

comment on column public.ghl_agency_installs.approve_all_locations is
  'From the token response at install time: whether the installer approved all locations during a bulk installation. Null means the response did not carry it — not that the answer was no. Never refreshed: this is a record of one consent screen, not current provider config.';
comment on column public.ghl_agency_installs.is_bulk_installation is
  'From the token response at install time: whether the install was performed as a bulk installation. Null means the response did not carry it.';
comment on column public.ghl_agency_installs.install_to_future_locations is
  'From the token response at install time: whether the app installs itself into sub-accounts created later. False here is the reason a new sub-account has no agent, and without this column that fact was readable only from the provider.';
comment on column public.ghl_installs.approve_all_locations is
  'Mirrors ghl_agency_installs.approve_all_locations. Documented company-token-only, so a location grant normally leaves it null.';
comment on column public.ghl_installs.is_bulk_installation is
  'From the token response at install time: whether this location arrived through a bulk installation.';
comment on column public.ghl_installs.install_to_future_locations is
  'Mirrors ghl_agency_installs.install_to_future_locations. Documented company-token-only, so a location grant normally leaves it null.';
