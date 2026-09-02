import { describe, expect, it, vi } from "vitest";

import { createAccountTermsHandler } from "./handler";

const published = {
  state: "published" as const,
  versionKey: "2026-09-terms-v1",
  contentHash: "a".repeat(64),
  publishedAt: "2026-09-01T00:00:00.000Z",
  termsBody: "Approved account terms.",
  privacyBody: "Approved account privacy notice.",
};

describe("GET /api/account/terms", () => {
  it("stays unavailable until the account-terms gate is live", async () => {
    const load = vi.fn();
    const response = await createAccountTermsHandler({ enabled: () => false, load })();
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found." });
    expect(load).not.toHaveBeenCalled();
  });

  it("returns the exact published version", async () => {
    const response = await createAccountTermsHandler({
      enabled: () => true,
      load: async () => published,
    })();
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ terms: published });
  });

  it("makes draft-only and absent copy explicit instead of fabricating an agreement", async () => {
    const response = await createAccountTermsHandler({
      enabled: () => true,
      load: async () => ({ state: "none_published" }),
    })();
    await expect(response.json()).resolves.toEqual({ terms: { state: "none_published" } });
  });

  it("does not turn a failed registry read into a successful terms response", async () => {
    const response = await createAccountTermsHandler({
      enabled: () => true,
      load: async () => { throw new Error("database details"); },
    })();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Account terms are unavailable." });
  });
});
