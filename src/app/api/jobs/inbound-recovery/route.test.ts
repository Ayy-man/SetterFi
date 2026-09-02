import { beforeEach, describe, expect, it, vi } from "vitest";

import { createInboundRecoveryHandler } from "./handler";

describe("inbound recovery job", () => {
  beforeEach(() => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "true");
  });

  it("requires the cron secret and runs one bounded claim batch", async () => {
    const recover = vi.fn(async () => ({ claimed: 3, processed: 2, failed: 1 }));
    const handler = createInboundRecoveryHandler({ secret: "synthetic-secret", recover });
    const unauthorized = await handler(new Request("https://example.test/api/jobs/inbound-recovery"));
    expect(unauthorized.status).toBe(401);
    expect(recover).not.toHaveBeenCalled();

    const response = await handler(new Request("https://example.test/api/jobs/inbound-recovery", {
      headers: { authorization: "Bearer synthetic-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: 3, processed: 2, failed: 1 });
    expect(recover).toHaveBeenCalledWith(25);
  });

  it("stays dark when the live phase is disabled", async () => {
    vi.stubEnv("SETTERFI_PHASE1_LIVE", "false");
    const handler = createInboundRecoveryHandler({
      secret: "synthetic-secret",
      recover: vi.fn(),
    });
    expect((await handler(new Request("https://example.test"))).status).toBe(404);
  });
});
