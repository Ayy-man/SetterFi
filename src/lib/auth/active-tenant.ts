import type { AppClaims } from "@/lib/auth/claims";
import { tenantMembershipLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ActiveTenantResolverDependencies = {
  enabled(): boolean;
  loadSelection(input: { actorId: string; claimTenantId: string }): Promise<string | null>;
};

/**
 * Resolves the workspace the server should serve for this request. The durable choice is additive:
 * no selection (or a disabled rollout gate) preserves the exact tenant carried by today's claim.
 */
export async function resolveActiveTenant(
  claims: Pick<AppClaims, "userId" | "tenantId">,
  dependencies: ActiveTenantResolverDependencies,
): Promise<string | null> {
  if (!claims.userId || !claims.tenantId || !dependencies.enabled()) return claims.tenantId;
  return (await dependencies.loadSelection({
    actorId: claims.userId,
    claimTenantId: claims.tenantId,
  })) ?? claims.tenantId;
}

async function loadPersistedSelection(input: { actorId: string; claimTenantId: string }) {
  const { data, error } = await createSupabaseServiceClient().rpc("resolve_active_tenant_selection", {
    p_actor_id: input.actorId,
    p_claim_tenant_id: input.claimTenantId,
  });
  const row = Array.isArray(data) ? data[0] as Record<string, unknown> | undefined : undefined;
  if (error || !row) throw new Error("ACTIVE_TENANT_RESOLUTION_FAILED");
  return typeof row.tenant_id === "string" && row.tenant_id ? row.tenant_id : null;
}

/** Server entry point used by tenant-aware handlers as they migrate off the one-tenant JWT claim. */
export function loadActiveTenant(claims: Pick<AppClaims, "userId" | "tenantId">) {
  return resolveActiveTenant(claims, {
    enabled: tenantMembershipLive,
    loadSelection: loadPersistedSelection,
  });
}
