/** Read-only, evidence-backed health detail for one client in the operator book. */

import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase8SupportLive } from "@/lib/env-contract";
import {
  loadTenantHealthDetail,
  TenantHealthDetailError,
  type TenantHealthDetail,
} from "@/lib/operations/tenant-health-detail";
import { loadSupportSession, type SupportSession } from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };

export type TenantHealthDetailRouteDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  read(input: { expectedTenant: string; actorId: string }): Promise<TenantHealthDetail>;
};

export function createTenantHealthDetailHandler(dependencies: TenantHealthDetailRouteDependencies) {
  return async function GET(_request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." }, { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    if (!session) return Response.json(
      { error: "Authentication required." }, { status: 401, headers: noStoreHeaders },
    );
    if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) return Response.json(
      { error: "Forbidden." }, { status: 403, headers: noStoreHeaders },
    );
    const { id } = await context.params;
    if (!id.trim()) return Response.json(
      { error: "Client health selector is invalid." }, { status: 400, headers: noStoreHeaders },
    );
    try {
      const health = await dependencies.read({ expectedTenant: id, actorId: session.userId });
      if (health.tenantId !== id) throw new TenantHealthDetailError("INVALID_PROJECTION");
      return Response.json({ health }, { headers: noStoreHeaders });
    } catch (error) {
      if (error instanceof TenantHealthDetailError && error.code === "ACCESS_REFUSED") {
        return Response.json({ error: "Client health was not found." }, { status: 404, headers: noStoreHeaders });
      }
      return Response.json(
        { error: "Client health is temporarily unavailable." }, { status: 503, headers: noStoreHeaders },
      );
    }
  };
}

export const GET = createTenantHealthDetailHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  read: (input) => loadTenantHealthDetail(input),
});
