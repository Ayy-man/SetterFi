/**
 * Whether a tenant is the seeded demo workspace, read straight off `tenants.is_demo`.
 *
 * This is the one fact the demo Meta connect path is allowed to trust: every route that can
 * reach the mock Meta OAuth service (`connect`, `callback`, `assets`, `demo-login`) resolves it
 * here, from the acting tenant id the session already carries, rather than from anything the
 * client sends. A request cannot ask to be treated as the demo tenant; it either is one or it
 * is not, and this is the only place that decides.
 *
 * The service client is used deliberately: `POST /api/channels/meta/connect` and its siblings
 * already read and write `channel_connections` through the service client, and a route that
 * needs to know "is this the demo tenant" before it has picked a driver has no user-scoped
 * client to read through yet either. A failed read answers `false` -- "route to the real driver"
 * is the safe default, never "route to the mock one".
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export async function isDemoTenant(tenantId: string): Promise<boolean> {
  const expectedTenant = tenantId.trim();
  if (!expectedTenant) return false;
  try {
    const client = createSupabaseServiceClient();
    const { data, error } = await client
      .from("tenants")
      .select("is_demo")
      .eq("id", expectedTenant)
      .maybeSingle();
    if (error || !data) return false;
    return data.is_demo === true;
  } catch {
    return false;
  }
}
