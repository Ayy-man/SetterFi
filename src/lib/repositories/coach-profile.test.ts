import { describe, expect, it, vi } from "vitest";

import { readCoachOwnEmail } from "./coach-profile";

describe("readCoachOwnEmail", () => {
  it("reads the actor's own row, scoped by both the user id and the tenant id", async () => {
    const source = vi.fn(async () => ({ email: "coach@synthetic.test" }));
    await expect(
      readCoachOwnEmail({ userId: "user-1", tenantId: "tenant-1" }, source),
    ).resolves.toBe("coach@synthetic.test");
    expect(source).toHaveBeenCalledWith({ userId: "user-1", tenantId: "tenant-1" });
  });

  it("returns null for a missing or cross-tenant actor rather than throwing", async () => {
    await expect(
      readCoachOwnEmail({ userId: "user-1", tenantId: "tenant-1" }, async () => null),
    ).resolves.toBeNull();
  });

  it("refuses a row whose email is blank or the wrong shape", async () => {
    await expect(
      readCoachOwnEmail({ userId: "user-1", tenantId: "tenant-1" }, async () => ({ email: "" })),
    ).rejects.toThrow("COACH_OWN_PROFILE_INVALID");
    await expect(
      readCoachOwnEmail({ userId: "user-1", tenantId: "tenant-1" }, async () => ({ email: 7 })),
    ).rejects.toThrow("COACH_OWN_PROFILE_INVALID");
  });

  it("requires a non-blank actor id and tenant id before it reaches the network", async () => {
    const source = vi.fn();
    await expect(
      readCoachOwnEmail({ userId: "  ", tenantId: "tenant-1" }, source),
    ).rejects.toThrow("COACH_PROFILE_ACTOR_REQUIRED");
    await expect(
      readCoachOwnEmail({ userId: "user-1", tenantId: "  " }, source),
    ).rejects.toThrow("EXPECTED_TENANT_REQUIRED");
    expect(source).not.toHaveBeenCalled();
  });
});
