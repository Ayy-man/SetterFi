import { describe, expect, it } from "vitest";

import { canonicalizeBrainDraft, contentHashForPayload } from "@/lib/brain/snapshot/canonicalize";

const BASE = { entities: [], compiledPlatform: "Platform", platformTokens: 1, knowledgeMode: "inline" as const };

describe("canonicalizeBrainDraft retrievalFloor", () => {
  it("leaves the payload and its hash untouched when no floor is given", () => {
    const payload = canonicalizeBrainDraft(BASE);
    expect("retrievalFloor" in payload).toBe(false);
    expect(contentHashForPayload(payload)).toBe(contentHashForPayload(canonicalizeBrainDraft({ ...BASE })));
  });

  it("carries a floor in [0, 1] into the hashed payload and refuses anything else", () => {
    const payload = canonicalizeBrainDraft({ ...BASE, retrievalFloor: 0.3 });
    expect(payload.retrievalFloor).toBe(0.3);
    expect(contentHashForPayload(payload)).not.toBe(contentHashForPayload(canonicalizeBrainDraft(BASE)));
    expect(() => canonicalizeBrainDraft({ ...BASE, retrievalFloor: -0.1 })).toThrow("BRAIN_CANONICAL_RETRIEVAL_FLOOR_INVALID");
    expect(() => canonicalizeBrainDraft({ ...BASE, retrievalFloor: Number.NaN })).toThrow("BRAIN_CANONICAL_RETRIEVAL_FLOOR_INVALID");
  });
});
