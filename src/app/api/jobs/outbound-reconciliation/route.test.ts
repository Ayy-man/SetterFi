import { describe, expect, it, vi } from "vitest";

import { createOutboundReconciliationJobHandler } from "./handler";

const request = (secret = "secret") => new Request("https://setterfi.test/api/jobs/outbound-reconciliation", {
  headers: { authorization: `Bearer ${secret}` },
});

describe("outbound reconciliation job", () => {
  it("requires the live phase and cron secret", async () => {
    const run = vi.fn(async () => ({ claimed: 0, persisted: 0, alerted: 0, retryable: 0 }));
    expect((await createOutboundReconciliationJobHandler({
      enabled: () => false, secret: "secret", run,
    })(request())).status).toBe(404);
    expect((await createOutboundReconciliationJobHandler({
      enabled: () => true, secret: "secret", run,
    })(request("wrong"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports persisted, alerted, and retryable custody without provider-send counts", async () => {
    const run = vi.fn(async () => ({ claimed: 3, persisted: 1, alerted: 1, retryable: 1 }));
    const response = await createOutboundReconciliationJobHandler({
      enabled: () => true, secret: "secret", run,
    })(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      claimed: 3, persisted: 1, alerted: 1, retryable: 1,
    });
  });
});
