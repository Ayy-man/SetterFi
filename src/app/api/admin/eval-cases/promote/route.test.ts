import { describe, expect, it, vi } from "vitest";

import { promotionJsonHash } from "@/lib/repositories/eval-promotion";

import { createEvalPromotionHandler } from "./handler";

const actor = { userId: "admin-synthetic", role: "admin" as const };
const turns = [
  { role: "user" as const, content: "I need $50,000 with a 720 score." },
  { role: "assistant" as const, content: "The approved matrix qualifies this case." },
];
const body = {
  conversationId: "conversation-synthetic",
  messageId: "message-synthetic",
  contactId: "contact-synthetic",
  redactedTurns: turns,
  expectation: { outcome: "BOOK" },
  suite: "qualification_accuracy" as const,
  redactionManifest: { placeholders: [] },
  sourceHash: "a".repeat(64),
  confirmedRedactedHash: promotionJsonHash(turns),
  notes: "Synthetic regression case",
};

const post = (value: unknown) => new Request("https://setterfi.test/api/admin/eval-cases/promote", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});

function dependencies() {
  const session = vi.fn(async () => actor);
  const promote = vi.fn(async () => ({
    state: "promoted" as const,
    evalCaseId: "eval-case-synthetic",
    auditId: "41",
    actionKey: "eval.case.promoted" as const,
  }));
  return {
    session,
    promote,
    values: { enabled: () => true, session, promote },
  };
}

describe("platform eval promotion route", () => {
  it("uses only the server actor and returns the exact case plus audit receipt", async () => {
    const deps = dependencies();
    const response = await createEvalPromotionHandler(deps.values)(post(body));

    expect(response.status).toBe(200);
    expect(deps.promote).toHaveBeenCalledWith({ ...body, actorId: actor.userId });
    expect(await response.json()).toEqual({
      state: "promoted",
      evalCaseId: "eval-case-synthetic",
      auditId: "41",
      actionKey: "eval.case.promoted",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each(["actorId", "actorRole", "tenantId", "kind", "category", "isTest"])(
    "rejects caller authority field %s before promotion",
    async (field) => {
      const deps = dependencies();
      const response = await createEvalPromotionHandler(deps.values)(post({
        ...body,
        [field]: "caller-value",
      }));
      expect(response.status).toBe(409);
      expect(deps.promote).not.toHaveBeenCalled();
    },
  );

  it.each(["success", "build", "coach", "coach_member", "affiliate"] as const)(
    "refuses role %s from server session props",
    async (role) => {
      const deps = dependencies();
      const response = await createEvalPromotionHandler({
        ...deps.values,
        session: async () => ({ userId: "actor-synthetic", role }),
      })(post(body));
      expect(response.status).toBe(403);
      expect(deps.promote).not.toHaveBeenCalled();
    },
  );

  it("makes the off state inert before session or promotion work", async () => {
    const deps = dependencies();
    const response = await createEvalPromotionHandler({
      ...deps.values,
      enabled: () => false,
    })(post(body));
    expect(response.status).toBe(404);
    expect(deps.session).not.toHaveBeenCalled();
    expect(deps.promote).not.toHaveBeenCalled();
  });

  it("reports stale source, unconfirmed edits, and read-back mismatch as one value-free refusal", async () => {
    const deps = dependencies();
    deps.promote.mockRejectedValueOnce(new Error("EVAL_PROMOTION_READBACK_MISMATCH"));
    const response = await createEvalPromotionHandler(deps.values)(post(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      state: "refused",
      code: "EVAL_PROMOTION_REFUSED",
    });
  });
});
