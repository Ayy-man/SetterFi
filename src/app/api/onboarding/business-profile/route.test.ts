import { describe, expect, it, vi } from "vitest";

import { createBusinessProfileHandlers } from "./handler";

const actor = { userId: "coach-1", tenantId: "tenant-1", role: "coach" as const, impersonatingTenant: null };
const body = { legalName: "Synthetic LLC", entityType: "llc", hasEin: true, websiteUrl: "https://example.test", addressLine1: "1 Test St", addressLine2: null, city: "Austin", region: "TX", postalCode: "78701", countryCode: "US" };

function dependencies() {
  return {
    enabled: () => true, session: vi.fn().mockResolvedValue(actor), load: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue({ profile: { id: "profile-1", ...body, updatedAt: "2026-09-07T00:00:00Z" }, audit: { id: "42", actionKey: "onboarding.business_profile.saved" as const } }),
  };
}

describe("onboarding business-profile route", () => {
  it("derives the mutation tenant and actor from claims, then returns its audit receipt", async () => {
    const deps = dependencies();
    const response = await createBusinessProfileHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) }));
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith({ ...body, tenantId: "tenant-1", actorId: "coach-1" });
    await expect(response.json()).resolves.toMatchObject({ audit: { id: "42", actionKey: "onboarding.business_profile.saved" } });
  });

  it.each([[null, 401], [{ ...actor, role: "admin" as const }, 403], [{ ...actor, impersonatingTenant: "tenant-1" }, 403]])(
    "refuses an unauthorized writer before any save", async (candidate, status) => {
      const deps = dependencies(); deps.session.mockResolvedValue(candidate);
      const response = await createBusinessProfileHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify(body) }));
      expect(response.status).toBe(status); expect(deps.save).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed data without reaching the RPC", async () => {
    const deps = dependencies();
    const response = await createBusinessProfileHandlers(deps).POST(new Request("https://setterfi.test", { method: "POST", body: JSON.stringify({ ...body, tenantId: "forged" }) }));
    expect(response.status).toBe(400); expect(deps.save).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Invalid business profile.", fields: ["tenantId"] });
  });

  it("names every field that stopped the save, so the form can mark them", async () => {
    const deps = dependencies();
    const response = await createBusinessProfileHandlers(deps).POST(new Request("https://setterfi.test", {
      method: "POST", body: JSON.stringify({ ...body, city: "  ", websiteUrl: "reidcapital", countryCode: "USA" }),
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid business profile.", fields: ["websiteUrl", "city", "countryCode"] });
  });

  it("accepts the read-only keys a loaded profile carries, since the form edits what it loaded", async () => {
    const deps = dependencies();
    const response = await createBusinessProfileHandlers(deps).POST(new Request("https://setterfi.test", {
      method: "POST", body: JSON.stringify({ id: "profile-1", updatedAt: "2026-09-04T00:00:00Z", ...body }),
    }));
    expect(response.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith({ ...body, tenantId: "tenant-1", actorId: "coach-1" });
  });
});
