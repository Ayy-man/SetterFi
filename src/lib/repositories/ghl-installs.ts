/**
 * The platform-wide grouping read over `ghl_installs`, which did not exist until now.
 *
 * Every other read of this table is scoped to one location (`createGhlSubAccountInstallCustody`) or
 * one tenant (`repositories/conversations.ts`), which is why `/admin/provisioning` could report that
 * an approval came back and never that a client's messaging app is actually connected — the panel
 * said so out loud. Secrets live in the separate `ghl_install_secrets` table, so this touches no
 * envelope; it reads metadata and nothing else.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

/** Message is a code, matching `SupportRepositoryError`. */
export class GhlInstallsRepositoryError extends Error {}

export type GhlInstallLocation = {
  locationId: string;
  installState: string;
  reauthorizationRequiredAt: string | null;
  updatedAt: string;
};

export type GhlInstallTenantGroup = {
  tenantId: string | null;
  tenantName: string | null;
  isDemo: boolean;
  connected: boolean;
  locations: GhlInstallLocation[];
};

/**
 * `token_ok` with no pending re-approval is the only state that can actually send a message.
 * `installed` means the row was written before the credential landed, and a row awaiting
 * re-approval has a credential the provider will no longer honour — neither is a connection.
 */
function locationIsUsable(location: GhlInstallLocation) {
  return location.installState === "token_ok" && !location.reauthorizationRequiredAt;
}

/**
 * The one-tenant read behind the coach's own messaging card.
 *
 * `listGhlInstallsByTenant` below is a platform-wide read and may never back a coach surface: it
 * would carry every other client's locations into a page one client is looking at. This asks the
 * same metadata table for one tenant and nothing else, and refuses to run without a tenant rather
 * than degrading into that unfiltered read.
 */
export async function listGhlInstallLocationsForTenant(
  tenantId: string,
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<GhlInstallLocation[]> {
  if (!tenantId) throw new GhlInstallsRepositoryError("GHL_INSTALLS_TENANT_REQUIRED");
  const { data, error } = await client
    .from("ghl_installs")
    .select("location_id,install_state,reauthorization_required_at,updated_at")
    .eq("tenant_id", tenantId)
    .order("updated_at", { ascending: false });
  if (error) throw new GhlInstallsRepositoryError("GHL_INSTALLS_READ_FAILED");
  const rows = (data ?? []) as {
    location_id: string;
    install_state: string | null;
    reauthorization_required_at: string | null;
    updated_at: string | null;
  }[];
  return rows.map((row) => ({
    locationId: String(row.location_id),
    installState: String(row.install_state ?? "unknown"),
    reauthorizationRequiredAt: row.reauthorization_required_at ?? null,
    updatedAt: String(row.updated_at ?? ""),
  }));
}

export async function listGhlInstallsByTenant(
  client: ServiceClient = createSupabaseServiceClient(),
): Promise<GhlInstallTenantGroup[]> {
  const { data, error } = await client
    .from("ghl_installs")
    .select("tenant_id,location_id,install_state,reauthorization_required_at,updated_at")
    .order("updated_at", { ascending: false });
  if (error) throw new GhlInstallsRepositoryError("GHL_INSTALLS_READ_FAILED");
  const rows = (data ?? []) as {
    tenant_id: string | null;
    location_id: string;
    install_state: string | null;
    reauthorization_required_at: string | null;
    updated_at: string | null;
  }[];

  const tenantIds = [...new Set(rows.map((row) => row.tenant_id).filter((id): id is string => Boolean(id)))];
  // Two reads and a map. No repository in this project uses an embedded join, and a read that
  // names no tenant at all should not go asking about none of them.
  const names = new Map<string, { name: string | null; isDemo: boolean }>();
  if (tenantIds.length > 0) {
    const { data: tenantRows, error: tenantError } = await client
      .from("tenants")
      .select("id,name,is_demo")
      .in("id", tenantIds);
    if (tenantError) throw new GhlInstallsRepositoryError("GHL_INSTALL_TENANTS_READ_FAILED");
    for (const row of (tenantRows ?? []) as { id: string; name: string | null; is_demo: boolean | null }[]) {
      names.set(String(row.id), { name: row.name ?? null, isDemo: Boolean(row.is_demo) });
    }
  }

  const grouped = new Map<string, GhlInstallTenantGroup>();
  for (const row of rows) {
    // Historical rows predate the reconcile refusal, so an unclaimed location is real and is
    // reported as one group rather than dropped — dropping it would make the table look tidier
    // than it is.
    const key = row.tenant_id ?? "";
    const tenant = row.tenant_id ? names.get(row.tenant_id) : undefined;
    const group = grouped.get(key) ?? {
      tenantId: row.tenant_id ?? null,
      tenantName: tenant?.name ?? null,
      isDemo: tenant?.isDemo ?? false,
      connected: false,
      locations: [],
    };
    const location: GhlInstallLocation = {
      locationId: String(row.location_id),
      installState: String(row.install_state ?? "unknown"),
      reauthorizationRequiredAt: row.reauthorization_required_at ?? null,
      updatedAt: String(row.updated_at ?? ""),
    };
    group.locations.push(location);
    group.connected = group.connected || locationIsUsable(location);
    grouped.set(key, group);
  }

  const groups = [...grouped.values()];
  // The unmatched group sorts last: it is a loose end, not a client.
  return [...groups.filter((group) => group.tenantId), ...groups.filter((group) => !group.tenantId)];
}
