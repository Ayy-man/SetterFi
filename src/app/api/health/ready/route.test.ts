import { describe, expect, it, vi } from "vitest";

import { createReadinessHandler } from "./handler";

const ready = {
  status: "ready" as const,
  configuration: true,
  database: true,
  automation: true,
  requiredProviders: true,
};

describe("GET /api/health/ready", () => {
  it("returns 200 only for a fully ready deployment and disables caching", async () => {
    const load = vi.fn().mockResolvedValue(ready);
    const response = await createReadinessHandler(load)();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(ready);
    expect(load).toHaveBeenCalledOnce();
  });

  it("returns 503 with only the stable boolean contract when a dependency is unavailable", async () => {
    const result = { ...ready, status: "unready" as const, automation: false };
    const response = await createReadinessHandler(async () => result)();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual(result);
    expect(Object.keys(body).sort()).toEqual([
      "automation",
      "configuration",
      "database",
      "requiredProviders",
      "status",
    ]);
    const serialized = JSON.stringify(body);
    for (const forbidden of ["env", "secret", "url", "count", "error", "time", "date", "job", "receipt"]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("redacts an unexpected probe exception into the same boolean-only 503 contract", async () => {
    const response = await createReadinessHandler(async () => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY=raw-secret https://private.example.test");
    })();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      status: "unready", configuration: false, database: false,
      automation: false, requiredProviders: false,
    });
    expect(JSON.stringify(body)).not.toContain("raw-secret");
  });
});
