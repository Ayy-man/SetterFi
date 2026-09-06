import { describe, expect, it, vi } from "vitest";

import { createBrainDraftHandler } from "./handler";

const admin = { userId: "platform-admin", role: "admin" as const };
const base = { entities: [], compiledPlatform: "{}", platformTokens: 1, knowledgeMode: "inline" as const };
const revision = { id: "draft-1", contentHash: "a".repeat(64), createdBy: admin.userId, payload: base };

const post = (draft: unknown) => new Request("http://localhost/api/admin/brain/draft", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ draft }),
});

function handler() {
  const create = vi.fn(async () => revision);
  return { handle: createBrainDraftHandler({ enabled: () => true, session: async () => admin, create }), create };
}

describe("POST /api/admin/brain/draft, retrieval floor", () => {
  it("carries an absent floor as absent and a floor in [0, 1] through to the revision", async () => {
    const { handle, create } = handler();
    expect((await handle(post(base))).status).toBe(200);
    expect(create).toHaveBeenLastCalledWith({ actorId: admin.userId, draft: base });
    for (const retrievalFloor of [0, 0.25, 0.4, 1]) {
      expect((await handle(post({ ...base, retrievalFloor }))).status).toBe(200);
      expect(create).toHaveBeenLastCalledWith({ actorId: admin.userId, draft: { ...base, retrievalFloor } });
    }
  });

  it("refuses a floor outside [0, 1], a non-number, or a null without calling the service", async () => {
    const { handle, create } = handler();
    for (const retrievalFloor of [-0.01, 1.01, "0.3", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = await handle(post({ ...base, retrievalFloor }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "BRAIN_DRAFT_REFUSED" });
    }
    expect(create).not.toHaveBeenCalled();
  });
});
