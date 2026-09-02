alter table public.platform_measurement_preview_snapshots force row level security;

create policy platform_measurement_preview_snapshots_admin_read
  on public.platform_measurement_preview_snapshots
  for select to authenticated
  using (app.is_platform_admin());

revoke all on table public.platform_measurement_preview_snapshots from anon, authenticated;
