import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { createLiveBillingOperations, type BillingOperations } from "@/lib/billing/operations";
import { createLiveBillingNotificationPort } from "@/lib/notifications/billing-events";
import { phase6StripeLive } from "@/lib/env-contract";

const headers = { "Cache-Control": "no-store" };
type Dependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  checkout: BillingOperations["checkout"];
};

export function createPlatformBillingCheckoutHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
    const actor = await dependencies.session();
    if (!actor || !["owner", "admin"].includes(actor.role)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers });
    }
    try {
      const body = await request.json() as Record<string, unknown>;
      if (typeof body.tenantId !== "string" || !body.tenantId.trim()
        || typeof body.tierId !== "string" || !body.tierId.trim()) throw new Error("INVALID_BODY");
      const checkout = await dependencies.checkout({
        actorId: actor.userId, tenantId: body.tenantId, tierId: body.tierId,
        baseUrl: new URL(request.url).origin,
      });
      return Response.json({ checkout }, { headers });
    } catch {
      return Response.json({ error: "Checkout was refused." }, { status: 409, headers });
    }
  };
}

const operations = createLiveBillingOperations(createLiveBillingNotificationPort());
export const POST = createPlatformBillingCheckoutHandler({
  enabled: phase6StripeLive,
  session: loadPlatformActor,
  checkout: operations.checkout,
});
