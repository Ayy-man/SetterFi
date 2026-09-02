import { describe, expect, it, vi } from "vitest";
import { createPlatformBillingCheckoutHandler } from "@/app/api/platform/billing/checkout/handler";

const request = (body: unknown) => new Request("https://app.test/api/platform/billing/checkout", { method: "POST", body: JSON.stringify(body) });
describe("platform billing checkout route", () => {
  it("requires owner/admin and passes actor, tenant and tier to persisted checkout", async () => {
    const checkout = vi.fn().mockResolvedValue({ checkoutSessionId: "row", idempotencyKey: "checkout:tenant:tier:price" });
    const handler = createPlatformBillingCheckoutHandler({ enabled: () => true, session: async () => ({ userId: "owner", role: "owner" }), checkout });
    expect((await handler(request({ tenantId: "tenant", tierId: "tier" }))).status).toBe(200);
    expect(checkout).toHaveBeenCalledWith(expect.objectContaining({ actorId: "owner", tenantId: "tenant", tierId: "tier" }));
  });

  it("refuses success and does not invoke checkout", async () => {
    const checkout = vi.fn();
    const response = await createPlatformBillingCheckoutHandler({ enabled: () => true, session: async () => ({ userId: "success", role: "success" }), checkout })(request({ tenantId: "tenant", tierId: "tier" }));
    expect(response.status).toBe(403);
    expect(checkout).not.toHaveBeenCalled();
  });
});
