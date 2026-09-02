import { describe, expect, it, vi } from "vitest";

import { createCoachKeywordGoalHandlers } from "./handler";

const actor = {
  userId: "coach-1",
  role: "coach" as const,
  tenantId: "tenant-session",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

const goal = {
  id: "11111111-1111-4111-8111-111111111111",
  keyword: "FUNDING",
  normalizedKeyword: "funding",
  goal: "resource" as const,
  resourceUrl: "https://example.com/funding",
  resourceMessage: "Here is the guide.",
  postBookingUrl: "https://example.com/thanks",
  postBookingMessage: "You are booked.",
  active: true,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function request(method: "PUT" | "DELETE", body: unknown) {
  return new Request("https://setterfi.test/api/coach/keyword-goals", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    session: vi.fn(async () => actor),
    list: vi.fn(async () => [goal]),
    save: vi.fn(async () => ({ goal, auditId: "41" })),
    deactivate: vi.fn(async () => ({ goal: { ...goal, active: false }, auditId: "42" })),
    ...overrides,
  };
}

describe("coach keyword goal route", () => {
  it("derives tenant and actor from the signed coach for reads and writes", async () => {
    const deps = dependencies();
    const handlers = createCoachKeywordGoalHandlers(deps);

    const getResponse = await handlers.GET();
    expect(getResponse.status).toBe(200);
    expect(deps.list).toHaveBeenCalledWith(actor.tenantId);

    const putResponse = await handlers.PUT(request("PUT", {
      id: null,
      keyword: "FUNDING",
      goal: "resource",
      resourceUrl: "https://example.com/funding",
      resourceMessage: "Here is the guide.",
      postBookingUrl: "https://example.com/thanks",
      postBookingMessage: "You are booked.",
    }));
    expect(putResponse.status).toBe(200);
    expect(deps.save).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      id: null,
      keyword: "FUNDING",
      goal: "resource",
      resourceUrl: "https://example.com/funding",
      resourceMessage: "Here is the guide.",
      postBookingUrl: "https://example.com/thanks",
      postBookingMessage: "You are booked.",
    });
    await expect(putResponse.json()).resolves.toMatchObject({
      goal: { id: goal.id },
      audit: { auditId: "41", actionKey: "keyword_goal.saved" },
    });
  });

  it("deactivates through an audited tenant-bound contract", async () => {
    const deps = dependencies();
    const response = await createCoachKeywordGoalHandlers(deps).DELETE(request("DELETE", {
      id: goal.id,
    }));
    expect(response.status).toBe(200);
    expect(deps.deactivate).toHaveBeenCalledWith({
      tenantId: actor.tenantId,
      actorId: actor.userId,
      id: goal.id,
    });
    await expect(response.json()).resolves.toMatchObject({
      goal: { active: false },
      audit: { auditId: "42", actionKey: "keyword_goal.deactivated" },
    });
  });

  it.each([
    {
      id: null, keyword: "FUNDING", goal: "resource", resourceUrl: null,
      resourceMessage: null, postBookingUrl: null, postBookingMessage: null,
    },
    {
      id: null, keyword: "FUNDING", goal: "book", resourceUrl: "https://example.com/guide",
      resourceMessage: null, postBookingUrl: null, postBookingMessage: null,
    },
    {
      id: null, keyword: "FUNDING", goal: "resource", resourceUrl: "http://example.com/guide",
      resourceMessage: null, postBookingUrl: null, postBookingMessage: null,
    },
    {
      id: null, keyword: "FUNDING", goal: "book", resourceUrl: null,
      resourceMessage: null, postBookingUrl: "javascript:alert(1)", postBookingMessage: null,
    },
    {
      id: null, keyword: "FUNDING", goal: "book", resourceUrl: null,
      resourceMessage: null, postBookingUrl: null, postBookingMessage: "x".repeat(1001),
    },
    {
      tenantId: "tenant-request", id: null, keyword: "FUNDING", goal: "book",
      resourceUrl: null, resourceMessage: null, postBookingUrl: null, postBookingMessage: null,
    },
  ])("refuses malformed or caller-scoped writes without partial work", async (body) => {
    const deps = dependencies();
    const response = await createCoachKeywordGoalHandlers(deps).PUT(request("PUT", body));
    expect(response.status).toBe(409);
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("refuses platform and impersonated actors before any repository work", async () => {
    for (const sessionActor of [
      { ...actor, role: "admin" as const },
      { ...actor, impersonatingTenant: "tenant-session", impersonationSessionId: "view-1" },
    ]) {
      const deps = dependencies({ session: vi.fn(async () => sessionActor) });
      const handlers = createCoachKeywordGoalHandlers(deps);
      expect((await handlers.GET()).status).toBe(403);
      expect((await handlers.PUT(request("PUT", {}))).status).toBe(403);
      expect((await handlers.DELETE(request("DELETE", {}))).status).toBe(403);
      expect(deps.list).not.toHaveBeenCalled();
      expect(deps.save).not.toHaveBeenCalled();
      expect(deps.deactivate).not.toHaveBeenCalled();
    }
  });
});
