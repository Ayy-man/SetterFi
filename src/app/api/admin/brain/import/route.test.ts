import { describe, expect, it, vi } from "vitest";

import { createBrainImportHandler } from "./handler";

const actor = { userId: "platform-admin", role: "admin" as const };
const request = (body: unknown) => new Request("http://localhost/api/admin/brain/import", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

function complete() {
  return {
    status: "complete" as const,
    batchId: "batch-1",
    importedCount: 2,
    counts: { received: 2, normalized: 2, flagged: 0, unchanged: 0 },
    sourceHash: "a".repeat(64),
  };
}

describe("POST /api/admin/brain/import", () => {
  it("404s before auth, limiter, or provider work when Phase 2 is off", async () => {
    const session = vi.fn(async () => actor);
    const consume = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const run = vi.fn(async () => complete());
    const response = await createBrainImportHandler({ enabled: () => false, session, consume, run })(
      request({ source: "configured" }),
    );

    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("returns Retry-After before the configured provider is reached", async () => {
    const run = vi.fn(async () => complete());
    const response = await createBrainImportHandler({
      enabled: () => true,
      session: async () => actor,
      consume: async () => ({ allowed: false, retryAfter: 713 }),
      run,
    })(request({ source: "configured" }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("713");
    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    { source: "configured", rootId: "caller-root" },
    { source: "configured", path: "/tmp/provider.json" },
    { source: "configured", content: "caller-controlled" },
  ])("refuses provider path or content authority before limiter work", async (body) => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const run = vi.fn(async () => complete());
    const response = await createBrainImportHandler({
      enabled: () => true,
      session: async () => actor,
      consume,
      run,
    })(request(body));

    expect(response.status).toBe(400);
    expect(consume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps partial provider completion distinct from a successful import", async () => {
    const response = await createBrainImportHandler({
      enabled: () => true,
      session: async () => actor,
      consume: async () => ({ allowed: true, retryAfter: 0 }),
      run: async () => ({
        status: "failed",
        batchId: "batch-1",
        errorCode: "IMPORT_PROVIDER_FETCH_FAILED",
        receivedCount: 1,
      }),
    })(request({ source: "configured" }));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      status: "failed",
      errorCode: "IMPORT_PROVIDER_FETCH_FAILED",
      receivedCount: 1,
    });
  });

  it("refuses a read-only platform role before limiter or provider work", async () => {
    const consume = vi.fn(async () => ({ allowed: true, retryAfter: 0 }));
    const run = vi.fn(async () => complete());
    const response = await createBrainImportHandler({
      enabled: () => true,
      session: async () => ({ userId: "builder", role: "build" }),
      consume,
      run,
    })(request({ source: "configured" }));

    expect(response.status).toBe(403);
    expect(consume).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
