/** Audited success-owner reassignment; the tenant comes from the path and the actor from session. */

import { phase8SupportLive } from "@/lib/env-contract";
import { hasImpersonationMarker } from "@/lib/auth/claims";
import { createSupportRepository } from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const noStoreHeaders = { "Cache-Control": "no-store" };
type Reassignment = {
  tenantId: string;
  successOwner: string;
  auditId: number;
  state: "Reassigned";
};

type SuccessOwnerDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  reassign(
    session: SupportSession,
    input: { expectedTenant: string; assigneeId: string; reason: string },
  ): Promise<Reassignment>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function createSuccessOwnerHandler(dependencies: SuccessOwnerDependencies) {
  return async function POST(
    request: Request,
    context: { params: Promise<{ id: string }> },
  ) {
    if (!dependencies.enabled()) return Response.json(
      { error: "Not found." },
      { status: 404, headers: noStoreHeaders },
    );
    const session = await dependencies.session();
    if (!session) return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: noStoreHeaders },
    );
    if (hasImpersonationMarker(session) || !["owner", "admin", "success"].includes(session.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body: unknown = await request.json();
      if (!isRecord(body) || Object.keys(body).sort().join(",") !== "assigneeId,reason"
        || typeof body.assigneeId !== "string" || !body.assigneeId.trim()
        || typeof body.reason !== "string" || !body.reason.trim()) {
        throw new Error("INVALID_BODY");
      }
      if (session.role === "success" && body.assigneeId !== session.userId) {
        return Response.json({ error: "Success users may take ownership only for themselves." }, {
          status: 403,
          headers: noStoreHeaders,
        });
      }
      const { id } = await context.params;
      if (!id.trim()) throw new Error("INVALID_BODY");
      const result = await dependencies.reassign(session, {
        expectedTenant: id,
        assigneeId: body.assigneeId,
        reason: body.reason,
      });
      if (result.tenantId !== id || result.successOwner !== body.assigneeId
        || !Number.isSafeInteger(result.auditId) || result.auditId <= 0
        || result.state !== "Reassigned") {
        throw new Error("REASSIGNMENT_READBACK_INVALID");
      }
      return Response.json({
        state: result.state,
        tenantId: result.tenantId,
        successOwner: result.successOwner,
        audit: { id: result.auditId, actionKey: "tenant.success_owner.reassigned" },
      }, { headers: noStoreHeaders });
    } catch (error) {
      const status = error instanceof SyntaxError || (error instanceof Error
        && error.message === "INVALID_BODY") ? 400 : 409;
      return Response.json({ error: status === 400
        ? "Reassignment request is invalid." : "Reassignment was refused." }, {
        status,
        headers: noStoreHeaders,
      });
    }
  };
}

const repository = createSupportRepository();
const service = createSupportService(repository);

export const POST = createSuccessOwnerHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  reassign: (session, input) => service.reassignSuccessOwner(session, input),
});
