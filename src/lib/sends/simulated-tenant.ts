/**
 * The one fact behind every simulated arm: simulated sends are switched on, and this tenant is
 * a demo tenant. It is read from the tenant row each time rather than trusted from a caller, so
 * it is the same fact the analytics exclusion and the demo login already use.
 */

import { simulatedSendsLive } from "@/lib/env-contract";
import type { createSupabaseServiceClient } from "@/lib/supabase/server";

type TenantClient = Pick<ReturnType<typeof createSupabaseServiceClient>, "from">;

/**
 * A transport or query failure and a missing tenant row are different facts and throw different
 * codes: `SIMULATED_TENANT_READ_FAILED` means the answer is unknown (retry or look at Supabase),
 * `PROVIDER_ROUTE_SCOPE_FAILED` means the tenant genuinely does not exist and the send has no
 * scope. PostgREST reports "no row" from `.single()` as error PGRST116, so that one is classed
 * with the missing-row branch rather than the transport one.
 */
export async function tenantSimulates(client: TenantClient, tenantId: string) {
  if (!simulatedSendsLive()) return false;
  const { data, error } = await client.from("tenants").select("is_demo").eq("id", tenantId).maybeSingle();
  if (error) throw new Error("SIMULATED_TENANT_READ_FAILED");
  if (!data) throw new Error("PROVIDER_ROUTE_SCOPE_FAILED");
  return data.is_demo === true;
}
