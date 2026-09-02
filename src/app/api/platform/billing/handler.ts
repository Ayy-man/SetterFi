import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { createLiveBillingOperations, type BillingOperations } from "@/lib/billing/operations";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";
import { phase6Live } from "@/lib/env-contract";

const headers = { "Cache-Control": "no-store" };
type Operations = Pick<BillingOperations,
  "listCorrections" | "updateTier" | "setTenantOverride" | "decideCorrection" | "setTenantStatus">;
type Dependencies = { enabled(): boolean; session(): Promise<PlatformActor | null>; operations: Operations };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("INVALID_BODY");
  return value;
}
function optionalText(value: unknown) {
  if (value === null) return null;
  return text(value);
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value)) throw new Error("INVALID_BODY");
  return value as number;
}

export function createPlatformBillingHandlers(dependencies: Dependencies) {
  async function actor() {
    if (!dependencies.enabled()) return { response: Response.json({ error: "Not found." }, { status: 404, headers }) };
    const session = await dependencies.session();
    if (!session || !["owner", "admin", "success"].includes(session.role)) {
      return { response: Response.json({ error: "Forbidden." }, { status: 403, headers }) };
    }
    return { session };
  }
  return {
    GET: async () => {
      const auth = await actor();
      if (auth.response) return auth.response;
      return Response.json({ corrections: await dependencies.operations.listCorrections() }, { headers });
    },
    POST: async (request: Request) => {
      const auth = await actor();
      if (auth.response) return auth.response;
      if (!auth.session || !["owner", "admin"].includes(auth.session.role)) {
        return Response.json({ error: "Forbidden." }, { status: 403, headers });
      }
      try {
        const body: unknown = await request.json();
        if (!record(body) || typeof body.action !== "string") throw new Error("INVALID_BODY");
        let result: unknown;
        if (body.action === "update_tier") {
          result = await dependencies.operations.updateTier({
            actorId: auth.session.userId, tierId: text(body.tierId),
            priceCents: integer(body.priceCents), callAllowance: integer(body.callAllowance),
            fairUseCap: body.fairUseCap === null ? null : integer(body.fairUseCap),
            fairUseNote: optionalText(body.fairUseNote), reason: text(body.reason),
          });
        } else if (body.action === "set_tenant_override") {
          result = await dependencies.operations.setTenantOverride({
            actorId: auth.session.userId, tenantId: text(body.tenantId),
            priceCents: integer(body.priceCents), effectiveAt: text(body.effectiveAt),
            endsAt: body.endsAt === null ? null : text(body.endsAt), reason: text(body.reason),
          });
        } else if (body.action === "decide_correction") {
          if (body.decision !== "approved" && body.decision !== "rejected") throw new Error("INVALID_BODY");
          result = await dependencies.operations.decideCorrection({
            actorId: auth.session.userId, tenantId: text(body.tenantId),
            requestId: text(body.requestId), decision: body.decision, reason: text(body.reason),
          });
        } else if (body.action === "set_tenant_status") {
          if (!["active", "overdue", "suspended"].includes(String(body.status))) throw new Error("INVALID_BODY");
          result = await dependencies.operations.setTenantStatus({
            actorId: auth.session.userId, tenantId: text(body.tenantId),
            status: body.status as "active" | "overdue" | "suspended", reason: text(body.reason),
            occurredAt: new Date().toISOString(),
          });
        } else throw new Error("INVALID_ACTION");
        return Response.json({ result }, { headers });
      } catch {
        return Response.json({ error: "Billing operation was refused." }, { status: 409, headers });
      }
    },
  };
}

const operations = createLiveBillingOperations(createLiveBillingNotificationPort());
const handlers = createPlatformBillingHandlers({ enabled: phase6Live, session: loadPlatformActor, operations });
export const GET = handlers.GET;
export const POST = handlers.POST;
