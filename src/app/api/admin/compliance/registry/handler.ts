import { hasImpersonationMarker, parseAppClaims } from "@/lib/auth/claims";
import {
  complianceRegistryQuery,
  loadComplianceRegistryPage,
  type ComplianceRegistryRpcClient,
} from "@/lib/compliance/registry";
import { phase1Live, phase3Live } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const ADMIN_COMPLIANCE_ROLES = new Set(["owner", "admin", "success"]);

type RegistryDependencies = {
  enabled(): boolean;
  session(): Promise<{ tenantId: string | null } | null>;
  registry: ComplianceRegistryRpcClient;
};

export function createComplianceRegistryHandler(dependencies: RegistryDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const session = await dependencies.session();
    if (!session) {
      return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    }
    try {
      const url = new URL(request.url);
      const page = await loadComplianceRegistryPage(
        dependencies.registry,
        session.tenantId,
        complianceRegistryQuery(Object.fromEntries(url.searchParams.entries())),
      );
      return Response.json(page, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/admin/compliance/registry failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Compliance records are temporarily unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

async function loadComplianceReadSession(): Promise<{ tenantId: string | null } | null> {
  const server = await createSupabaseServerClient();
  const { data, error } = await server.auth.getClaims();
  if (error || !data?.claims) return null;
  const claims = parseAppClaims(data.claims);
  if (!claims.role || !claims.userId || !ADMIN_COMPLIANCE_ROLES.has(claims.role)) return null;
  if (!hasImpersonationMarker(claims)) return { tenantId: null };
  if (!claims.impersonationSessionId) return null;
  const service = createSupabaseServiceClient();
  const { data: row, error: sessionError } = await service.from("impersonation_sessions")
    .select("id,actor_id,tenant_id,reason,started_at,ended_at,expires_at")
    .eq("id", claims.impersonationSessionId)
    .eq("actor_id", claims.userId)
    .maybeSingle();
  if (sessionError || !row) return null;
  const context = impersonatedReadContext(data.claims, {
    id: row.id,
    actorId: row.actor_id,
    tenantId: row.tenant_id,
    reason: row.reason,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    expiresAt: row.expires_at,
  } satisfies ImpersonationSession);
  return { tenantId: context.tenantId };
}

export const GET = createComplianceRegistryHandler({
  enabled: () => phase1Live() && phase3Live(),
  session: loadComplianceReadSession,
  registry: {
    rpc: async (name, args) => {
      const { data, error } = await createSupabaseServiceClient().rpc(name, args);
      return { data, error };
    },
  },
});
