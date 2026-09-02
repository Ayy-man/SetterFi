import { describe, expect, it } from "vitest";

import { parseOfferChangeTrail } from "@/lib/offer/change-trail";

const row = {
  change_id: "change-1",
  event: "draft_saved",
  changed_keys: ["programName", "proof"],
  content_hash: "a".repeat(64),
  changed_at: "2026-09-29T12:00:00.000Z",
  actor_id: "coach-1",
  actor_name: "Synthetic Coach",
  audit_id: 42,
};

describe("offer change trail parser", () => {
  it("preserves value-free changed-key evidence and explicit empty histories", () => {
    expect(parseOfferChangeTrail([row])).toEqual([{
      changeId: "change-1", event: "draft_saved", changedKeys: ["programName", "proof"],
      contentHash: "a".repeat(64), changedAt: "2026-09-29T12:00:00.000Z",
      actorId: "coach-1", actorName: "Synthetic Coach", auditId: "42",
    }]);
    expect(parseOfferChangeTrail([])).toEqual([]);
  });

  it.each([
    { ...row, event: "invented" },
    { ...row, changed_keys: ["programName", 4] },
    { ...row, content_hash: "not-a-hash" },
    { ...row, actor_name: 42 },
  ])("refuses incomplete or invented database rows", (invalid) => {
    expect(() => parseOfferChangeTrail([invalid])).toThrow("OFFER_CHANGE_TRAIL_READ_INVALID");
  });
});
