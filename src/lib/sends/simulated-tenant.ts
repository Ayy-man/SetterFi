/**
 * The one fact behind every simulated arm: simulated sends are switched on, and this tenant is
 * a demo tenant. It is read from the tenant row each time rather than trusted from a caller, so
 * it is the same fact the analytics exclusion and the demo login already use.
 */

import { simulatedSendsLive } from "@/lib/env-contract";
import type { createSupabaseServiceClient } from "@/lib/supabase/server";

type TenantClient = Pick<ReturnType<typeof createSupabaseServiceClient>, "from">;

export async function tenantSimulates(client: TenantClient, tenantId: string) {
  if (!simulatedSendsLive()) return false;
  const { data, error } = await client.from("tenants").select("is_demo").eq("id", tenantId).single();
  if (error || !data) throw new Error("PROVIDER_ROUTE_SCOPE_FAILED");
  return data.is_demo === true;
}
