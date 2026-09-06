import { describe, expect, it, vi } from "vitest";

import { DEFAULT_RETRIEVAL_SIMILARITY_FLOOR } from "@/lib/brain/retrieval";

import {
  createOwnerBrainApi,
  DEFAULT_RETRIEVAL_FLOOR,
  narrowKnowledgeVariant,
  OwnerBrainApiError,
  ownerBrainApiFailure,
  parseRetrievalFloorInput,
  payloadRetrievalFloor,
} from "./owner-brain-api";

describe("retrieval floor", () => {
  it("mirrors the engine's default and reads a stored floor only when it is in range", () => {
    expect(DEFAULT_RETRIEVAL_FLOOR).toBe(DEFAULT_RETRIEVAL_SIMILARITY_FLOOR);
    expect(payloadRetrievalFloor({ retrievalFloor: 0.4 })).toBe(0.4);
    expect(payloadRetrievalFloor({ retrievalFloor: 0 })).toBe(0);
    for (const payload of [null, undefined, {}, { retrievalFloor: "0.4" }, { retrievalFloor: 1.5 }, { retrievalFloor: Number.NaN }]) {
      expect(payloadRetrievalFloor(payload)).toBeNull();
    }
  });

  it("parses the owner's input as absent, a number in range, or a refusal", () => {
    expect(parseRetrievalFloorInput("")).toEqual({ value: null, error: null });
    expect(parseRetrievalFloorInput("  ")).toEqual({ value: null, error: null });
    expect(parseRetrievalFloorInput(" 0.4 ")).toEqual({ value: 0.4, error: null });
    expect(parseRetrievalFloorInput("1")).toEqual({ value: 1, error: null });
    for (const raw of ["-0.1", "1.01", "abc", "0.3x"]) {
      const parsed = parseRetrievalFloorInput(raw);
      expect(parsed.value).toBeNull();
      expect(parsed.error).toMatch(/between 0 and 1/);
    }
  });
});

const stored = { id: "variant-1", entryId: "entry-1", variant: "How much is it?", createdAt: "2026-09-07T10:00:00Z" };

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("narrowKnowledgeVariant", () => {
  it("reads the stored row off the route's receipt and refuses a receipt without one", () => {
    expect(narrowKnowledgeVariant({ state: "added", variant: stored, auditId: 4 })).toEqual(stored);
    expect(narrowKnowledgeVariant({ variant: { ...stored, createdAt: undefined } })).toEqual({ ...stored, createdAt: "" });
    for (const payload of [null, {}, { variant: {} }, { variant: { id: "v" } }]) {
      expect(() => narrowKnowledgeVariant(payload)).toThrow("BRAIN_VARIANT_RECEIPT_INVALID");
    }
  });
});

describe("addKnowledgeVariant", () => {
  it("posts the phrasing to the entry's route and returns the narrowed row", async () => {
    const fetcher = respond(200, { state: "added", variant: stored, auditId: 4 });
    const api = createOwnerBrainApi(fetcher);
    await expect(api.addKnowledgeVariant({ entryId: "entry 1", variant: "How much is it?" })).resolves.toEqual(stored);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/api/admin/brain/knowledge/entry%201/variants");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ variant: "How much is it?" });
  });

  it("surfaces the route's refusal code as a typed failure with owner-readable copy", async () => {
    const api = createOwnerBrainApi(respond(409, { state: "refused", code: "BRAIN_VARIANT_DUPLICATE" }));
    const failure = await api.addKnowledgeVariant({ entryId: "entry-1", variant: "x" }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OwnerBrainApiError);
    expect((failure as OwnerBrainApiError).status).toBe(409);
    expect(ownerBrainApiFailure(failure)).toBe("This entry already carries that phrasing.");
    expect(ownerBrainApiFailure(new OwnerBrainApiError(400, "BRAIN_VARIANT_TOO_LONG"))).toContain("500 characters");
  });
});
