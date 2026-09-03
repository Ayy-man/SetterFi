import { describe, expect, it, vi } from "vitest";

import {
  COACH_QUESTION_ENABLED_ACTION,
  COACH_QUESTION_ORDER_ACTION,
  createCoachQuestionHandlers,
} from "./handler";

const actor = {
  userId: "coach-1",
  role: "coach" as const,
  tenantId: "tenant-session",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

const questions = [
  { id: "q-1", text: "What's the funding for?", tag: "funding purpose", enabled: true, position: 0 },
  { id: "q-2", text: "Roughly how much?", tag: "funding amount", enabled: false, position: 1 },
];

function request(method: "PUT" | "PATCH", body: unknown) {
  return new Request("https://setterfi.test/api/coach/questions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    session: vi.fn(async () => actor),
    read: vi.fn(async () => questions),
    reorder: vi.fn(async () => ({ questions, auditId: "91" })),
    toggle: vi.fn(async () => ({ questions, auditId: "92" })),
    ...overrides,
  };
}

describe("coach question route", () => {
  it("passes the signed coach's own claims to the repository on every call", async () => {
    const deps = dependencies();
    const handlers = createCoachQuestionHandlers(deps);

    const read = await handlers.GET();
    expect(read.status).toBe(200);
    expect(deps.read).toHaveBeenCalledWith({ userId: "coach-1", tenantId: "tenant-session" });
    await expect(read.json()).resolves.toEqual({ questions });

    const reordered = await handlers.PUT(request("PUT", { questionIds: ["q-2", "q-1"] }));
    expect(reordered.status).toBe(200);
    expect(deps.reorder).toHaveBeenCalledWith(
      { userId: "coach-1", tenantId: "tenant-session" },
      ["q-2", "q-1"],
    );
    await expect(reordered.json()).resolves.toEqual({
      questions,
      audit: { auditId: "91", actionKey: COACH_QUESTION_ORDER_ACTION },
    });

    const toggled = await handlers.PATCH(request("PATCH", { questionId: "q-1", enabled: false }));
    expect(toggled.status).toBe(200);
    expect(deps.toggle).toHaveBeenCalledWith(
      { userId: "coach-1", tenantId: "tenant-session" },
      "q-1",
      false,
    );
    await expect(toggled.json()).resolves.toEqual({
      questions,
      audit: { auditId: "92", actionKey: COACH_QUESTION_ENABLED_ACTION },
    });
  });

  it("refuses anyone who is not a coach in their own session", async () => {
    const platform = createCoachQuestionHandlers(
      dependencies({ session: vi.fn(async () => ({ ...actor, role: "platform_admin" as const })) }),
    );
    expect((await platform.GET()).status).toBe(403);

    const viewingAs = dependencies({
      session: vi.fn(async () => ({ ...actor, impersonatingTenant: "tenant-other" })),
    });
    const impersonated = createCoachQuestionHandlers(viewingAs);
    expect((await impersonated.PUT(request("PUT", { questionIds: ["q-1"] }))).status).toBe(403);
    expect(viewingAs.reorder).not.toHaveBeenCalled();

    const anonymous = createCoachQuestionHandlers(
      dependencies({ session: vi.fn(async () => null) }),
    );
    expect((await anonymous.PATCH(request("PATCH", { questionId: "q-1", enabled: true }))).status)
      .toBe(403);
  });

  it("rejects a malformed order or toggle before it reaches the repository", async () => {
    const deps = dependencies();
    const handlers = createCoachQuestionHandlers(deps);

    for (const body of [{}, { questionIds: [] }, { questionIds: ["q-1", "q-1"] },
      { questionIds: ["q-1"], extra: 1 }, { questionIds: [7] }]) {
      expect((await handlers.PUT(request("PUT", body))).status).toBe(409);
    }
    for (const body of [{}, { questionId: "q-1" }, { questionId: "q-1", enabled: "yes" },
      { questionId: "", enabled: true }]) {
      expect((await handlers.PATCH(request("PATCH", body))).status).toBe(409);
    }
    expect(deps.reorder).not.toHaveBeenCalled();
    expect(deps.toggle).not.toHaveBeenCalled();
  });

  it("says the read failed rather than answering with an empty list", async () => {
    const failure = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handlers = createCoachQuestionHandlers(dependencies({
      read: vi.fn(async () => {
        throw new Error("COACH_QUESTION_READ_FAILED");
      }),
    }));
    const response = await handlers.GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ code: "COACH_QUESTION_READ_FAILED" });
    failure.mockRestore();
  });
});
