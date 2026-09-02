import { describe, expect, it } from "vitest";

import {
  canonicalizeBrainDraft,
  contentHashForPayload,
} from "@/lib/brain/snapshot/canonicalize";
import {
  BRAIN_OBJECTION_ENTITY_TYPE,
  BRAIN_OBJECTION_PAYLOAD_KEYS,
  brainObjectionDraftEntity,
} from "@/lib/brain/contracts";
import { diffBrainPayloads } from "@/lib/brain/snapshot/diff";
import { previewBrainPublish } from "@/lib/brain/snapshot/publish";

function draft(value = "Original", extras: Parameters<typeof canonicalizeBrainDraft>[0]["entities"] = []) {
  return canonicalizeBrainDraft({
    entities: [
      { type: "knowledge_entry", id: "entry-b", value: { answer: value, created_at: "ignored" } },
      { type: "compliance_rule", id: "CLAIM-001", value: { phrase: "guarantee", severity: "refuse" } },
      ...extras,
    ],
    compiledPlatform: "Platform\r\nBrain",
    platformTokens: 12,
    knowledgeMode: "inline",
    placeholderSchemaHash: "schema-a",
    placeholderResolutionHash: "resolution-a",
  });
}

describe("canonical Brain drafts", () => {
  it("hashes reordered keys and normalized line endings identically instead of minting a version", () => {
    const first = draft();
    const second = canonicalizeBrainDraft({
      entities: [
        { type: "compliance_rule", id: "CLAIM-001", value: { severity: "refuse", phrase: "guarantee" } },
        { type: "knowledge_entry", id: "entry-b", value: { created_at: "different", answer: "Original" } },
      ],
      compiledPlatform: "Platform\nBrain",
      platformTokens: 12,
      knowledgeMode: "inline",
      placeholderResolutionHash: "resolution-a",
      placeholderSchemaHash: "schema-a",
    });
    expect(contentHashForPayload(first)).toBe(contentHashForPayload(second));
  });

  it("changes the content hash for a material entity edit", () => {
    expect(contentHashForPayload(draft("Original"))).not.toBe(contentHashForPayload(draft("Edited")));
  });
});

describe("Brain snapshot diffs", () => {
  it("returns stable entity ids and only computed impact keys", () => {
    const current = draft();
    const next = canonicalizeBrainDraft({
      entities: [
        { type: "knowledge_entry", id: "entry-b", value: { answer: "Edited" } },
        { type: "placeholder_definition", id: "booking_link", value: { required: true } },
      ],
      compiledPlatform: "Platform\nBrain",
      platformTokens: 15,
      knowledgeMode: "retrieved",
      placeholderSchemaHash: "schema-b",
      placeholderResolutionHash: "resolution-a",
    });
    const result = diffBrainPayloads(current, next);
    expect(result.status).toBe("changed");
    if (result.status !== "changed") throw new Error("expected changed diff");
    expect(result.changes.map(({ kind, entityType, entityId }) => ({ kind, entityType, entityId }))).toEqual([
      { kind: "removed", entityType: "compliance_rule", entityId: "CLAIM-001" },
      { kind: "changed", entityType: "knowledge_entry", entityId: "entry-b" },
      { kind: "added", entityType: "placeholder_definition", entityId: "booking_link" },
    ]);
    expect(result.impactKeys).toEqual([
      "compliance_rules_changed",
      "placeholder_schema_changed",
      "knowledge_mode_changed",
    ]);
  });

  it("returns nothing_changed when the current and immutable draft hashes match", () => {
    const payload = draft();
    const hash = contentHashForPayload(payload);
    expect(previewBrainPublish({
      id: "snapshot-1",
      version: 1,
      contentHash: hash,
      sourceHash: hash,
      payload,
      compiledPlatform: payload.compiledPlatform,
      platformTokens: payload.platformTokens,
      knowledgeMode: payload.knowledgeMode,
      evalRunId: "eval-1",
      rollbackOfSnapshotId: null,
    }, { id: "draft-1", contentHash: hash, payload, createdBy: "actor-1" }).status).toBe("nothing_changed");
  });
});

// Phase 10: objections ride in the canonical payload's `entities` array, so the generic
// canonicalizer already covers them. What it cannot cover is the builder silently dropping a
// field — a payload missing `hardGate` hashes perfectly and publishes an ungated objection. These
// cases pin every field to the hash by changing one at a time.
function objectionDraft(overrides: Partial<Parameters<typeof brainObjectionDraftEntity>[0]> = {}) {
  return canonicalizeBrainDraft({
    entities: [
      brainObjectionDraftEntity({
        id: "81000000-0000-4000-8000-000000000001",
        label: "Too expensive",
        pattern: "expensive|costly",
        matchKeywords: ["price", "cost"],
        response: "Here is how the program is priced.",
        category: "pricing",
        hardGate: true,
        ...overrides,
      }),
    ],
    compiledPlatform: "Platform",
    platformTokens: 4,
    knowledgeMode: "inline",
  });
}

describe("objection entities in the canonical draft payload", () => {
  it("changes the content hash for every objection field, one field at a time", () => {
    const base = contentHashForPayload(objectionDraft());
    const mutations = [
      objectionDraft({ label: "Priced too high" }),
      objectionDraft({ pattern: "expensive|steep" }),
      objectionDraft({ response: "Here is how the program is priced today." }),
      objectionDraft({ category: "timing" }),
      objectionDraft({ hardGate: false }),
      objectionDraft({ matchKeywords: ["price", "cost", "budget"] }),
      objectionDraft({ matchKeywords: ["price"] }),
    ].map(contentHashForPayload);

    expect(mutations.every((hash) => hash !== base)).toBe(true);
    expect(new Set([base, ...mutations]).size).toBe(8);
  });

  it("drops a null pattern and a raised hard gate into the hashed value rather than omitting them", () => {
    const entity = brainObjectionDraftEntity({
      id: "81000000-0000-4000-8000-000000000002",
      label: "  Needs more time  ",
      pattern: "   ",
      response: "  Let us pick a date that works.  ",
      category: "timing",
    });
    expect(entity.type).toBe(BRAIN_OBJECTION_ENTITY_TYPE);
    expect(Object.keys(entity.value).sort()).toEqual([...BRAIN_OBJECTION_PAYLOAD_KEYS].sort());
    expect(entity.value).toEqual({
      label: "Needs more time",
      pattern: null,
      matchKeywords: [],
      response: "Let us pick a date that works.",
      category: "timing",
      hardGate: false,
    });
  });

  it("hashes reordered keywords, casing, whitespace, key order and entity order identically", () => {
    const canonical = contentHashForPayload(objectionDraft());
    expect(contentHashForPayload(objectionDraft({ matchKeywords: ["cost", "price"] })))
      .toBe(canonical);
    expect(contentHashForPayload(objectionDraft({ matchKeywords: ["  COST ", "Price", "price"] })))
      .toBe(canonical);

    const first = brainObjectionDraftEntity({
      id: "81000000-0000-4000-8000-000000000003",
      label: "Alpha", response: "Alpha response", category: "clarity", matchKeywords: ["a"],
    });
    const second = brainObjectionDraftEntity({
      id: "81000000-0000-4000-8000-000000000004",
      category: "partner", matchKeywords: ["b"], response: "Beta response", label: "Beta",
    });
    const forward = canonicalizeBrainDraft({
      entities: [first, second], compiledPlatform: "P", platformTokens: 1, knowledgeMode: "inline",
    });
    const reversed = canonicalizeBrainDraft({
      entities: [second, first], compiledPlatform: "P", platformTokens: 1, knowledgeMode: "inline",
    });
    expect(contentHashForPayload(forward)).toBe(contentHashForPayload(reversed));
  });

  it("refuses an objection the snapshot could not represent instead of hashing a broken one", () => {
    const valid = {
      id: "81000000-0000-4000-8000-000000000005",
      label: "Valid", response: "Valid response", category: "clarity",
    };
    expect(() => brainObjectionDraftEntity({ ...valid, label: "   " }))
      .toThrow(/BRAIN_OBJECTION_LABEL_REQUIRED/);
    expect(() => brainObjectionDraftEntity({ ...valid, response: "" }))
      .toThrow(/BRAIN_OBJECTION_RESPONSE_REQUIRED/);
    expect(() => brainObjectionDraftEntity({ ...valid, category: "trust" }))
      .toThrow(/BRAIN_OBJECTION_CATEGORY_INVALID/);
  });
});
