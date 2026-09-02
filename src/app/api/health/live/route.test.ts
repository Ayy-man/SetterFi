import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("GET /api/health/live", () => {
  it("always returns the dependency-free liveness envelope without caching", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "alive" });
  });
});
