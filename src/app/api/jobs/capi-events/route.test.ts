import { describe, expect, it, vi } from "vitest";

import { createCapiEventsHandler } from "./handler";

describe("CAPI event job", () => {
  it("requires the cron secret and runs one bounded batch", async () => {
    const dispatch = vi.fn(async () => ({
      claimed: 3, sent: 1, mockSent: 0, excluded: 1, retried: 1, terminalFailed: 0,
    }));
    const execute = vi.fn(async (_key, work: () => Promise<unknown>) => work());
    const handler = createCapiEventsHandler({
      secret: "synthetic-secret", dispatch, execute: execute as never,
    });
    expect((await handler(new Request("https://example.test/api/jobs/capi-events"))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();

    const response = await handler(new Request("https://example.test/api/jobs/capi-events", {
      headers: { authorization: "Bearer synthetic-secret" },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ claimed: 3, sent: 1, excluded: 1 });
    expect(dispatch).toHaveBeenCalledWith(25);
    expect(execute).toHaveBeenCalledWith("capi-events", expect.any(Function));
  });

  it("fails closed when CRON_SECRET is absent", async () => {
    const dispatch = vi.fn();
    const handler = createCapiEventsHandler({ secret: null, dispatch });
    expect((await handler(new Request("https://example.test", {
      headers: { authorization: "Bearer anything" },
    }))).status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
