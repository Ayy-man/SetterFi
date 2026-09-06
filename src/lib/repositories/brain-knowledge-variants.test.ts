import { describe, expect, it, vi } from "vitest";

import { createMockEmbeddingsDriver } from "@/lib/integrations/embeddings/mock";

import {
  addBrainKnowledgeEntryVariant,
  BrainKnowledgeVariantError,
  validateBrainVariantText,
  type BrainKnowledgeVariantDependencies,
} from "./brain-knowledge-variants";

const ENTRY = { id: "entry-1", question: "What does the programme cost?", variants: ["how much is it"] };

function deps(overrides: Partial<BrainKnowledgeVariantDependencies> = {}) {
  const stored = { id: "variant-9", entryId: ENTRY.id, variant: "Is there a price list?", createdAt: "2026-09-07T10:00:00Z" };
  const all: BrainKnowledgeVariantDependencies = {
    loadEntry: vi.fn(async () => ENTRY),
    embeddings: () => createMockEmbeddingsDriver(),
    callAdd: vi.fn(async () => ({ variant_id: "variant-9", audit_id: 77 })),
    readVariant: vi.fn(async () => stored),
    ...overrides,
  };
  return all;
}

describe("validateBrainVariantText", () => {
  it("trims, bounds, and refuses restatements of the question or an existing variant", () => {
    expect(validateBrainVariantText("  Is there a price list?  ", ENTRY)).toBe("Is there a price list?");
    for (const [raw, code] of [
      ["   ", "BRAIN_VARIANT_TEXT_REQUIRED"],
      ["x".repeat(501), "BRAIN_VARIANT_TOO_LONG"],
      ["what does the programme cost?", "BRAIN_VARIANT_MATCHES_QUESTION"],
      ["How much is it", "BRAIN_VARIANT_DUPLICATE"],
    ] as const) {
      expect(() => validateBrainVariantText(raw, ENTRY)).toThrow(code);
    }
    expect(validateBrainVariantText("x".repeat(500), ENTRY)).toHaveLength(500);
  });
});

describe("addBrainKnowledgeEntryVariant", () => {
  it("embeds the variant text only, calls the RPC under the actor, and returns the read-back row with its audit id", async () => {
    const d = deps();
    const receipt = await addBrainKnowledgeEntryVariant({ entryId: ENTRY.id, variant: " Is there a price list? ", actorId: "admin-1" }, d);
    expect(d.callAdd).toHaveBeenCalledTimes(1);
    const args = vi.mocked(d.callAdd).mock.calls[0][0];
    expect(args).toMatchObject({ p_actor_id: "admin-1", p_entry_id: ENTRY.id, p_variant: "Is there a price list?" });
    expect(args.p_embedding).toHaveLength(1536);
    const expected = await createMockEmbeddingsDriver().embed([{ id: "v", text: "Is there a price list?" }]);
    expect(args.p_embedding).toEqual(expected[0].vector);
    expect(receipt).toEqual({
      variant: { id: "variant-9", entryId: ENTRY.id, variant: "Is there a price list?", createdAt: "2026-09-07T10:00:00Z" },
      auditId: 77,
      auditAction: "brain.knowledge.variant_added",
    });
  });

  it("refuses before embedding when the entry is missing or the text fails the rule", async () => {
    const missing = deps({ loadEntry: vi.fn(async () => null) });
    await expect(addBrainKnowledgeEntryVariant({ entryId: "nope", variant: "x", actorId: "a" }, missing))
      .rejects.toThrow("BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND");
    const duplicate = deps();
    await expect(addBrainKnowledgeEntryVariant({ entryId: ENTRY.id, variant: "how much is it", actorId: "a" }, duplicate))
      .rejects.toThrow("BRAIN_VARIANT_DUPLICATE");
    expect(duplicate.callAdd).not.toHaveBeenCalled();
  });

  it("maps a database refusal onto the typed code and refuses a read-back that does not match", async () => {
    const refused = deps({ callAdd: vi.fn(async () => { throw new Error("BRAIN_VARIANT_DUPLICATE: raced"); }) });
    await expect(addBrainKnowledgeEntryVariant({ entryId: ENTRY.id, variant: "Price?", actorId: "a" }, refused))
      .rejects.toBeInstanceOf(BrainKnowledgeVariantError);
    const drifted = deps({ readVariant: vi.fn(async () => ({ id: "variant-9", entryId: "other", variant: "Price?", createdAt: "t" })) });
    await expect(addBrainKnowledgeEntryVariant({ entryId: ENTRY.id, variant: "Price?", actorId: "a" }, drifted))
      .rejects.toThrow("BRAIN_VARIANT_READBACK_MISMATCH");
  });
});
