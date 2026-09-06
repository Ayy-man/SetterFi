import { describe, expect, it, vi } from "vitest";

import { BrainKnowledgeVariantError, type BrainKnowledgeVariantReceipt } from "@/lib/repositories/brain-knowledge-variants";

import { createBrainVariantAddHandler } from "./handler";

const admin = { userId: "platform-admin", role: "admin" as const };
const receipt: BrainKnowledgeVariantReceipt = {
  variant: { id: "variant-1", entryId: "entry-1", variant: "How much is it?", createdAt: "2026-09-07T10:00:00Z" },
  auditId: 41,
  auditAction: "brain.knowledge.variant_added",
};
const context = { params: Promise.resolve({ entryId: "entry-1" }) };

const json = (payload?: unknown) => new Request("http://localhost/api/admin/brain/knowledge/entry-1/variants", {
  method: "POST",
  headers: { "content-type": "application/json" },
  ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
});

function handler(add = vi.fn(async () => receipt)) {
  return { handle: createBrainVariantAddHandler({ enabled: () => true, session: async () => admin, add }), add };
}

describe("POST /api/admin/brain/knowledge/[entryId]/variants", () => {
  it("gates on Phase 2 and admin role before reading the body", async () => {
    const add = vi.fn();
    expect((await createBrainVariantAddHandler({ enabled: () => false, session: async () => admin, add })(json({ variant: "x" }), context)).status).toBe(404);
    expect((await createBrainVariantAddHandler({ enabled: () => true, session: async () => null, add })(json({ variant: "x" }), context)).status).toBe(403);
    expect((await createBrainVariantAddHandler({ enabled: () => true, session: async () => ({ userId: "s", role: "success" }), add })(json({ variant: "x" }), context)).status).toBe(403);
    expect(add).not.toHaveBeenCalled();
  });

  it("refuses anything but the exact { variant: string } body without touching the repository", async () => {
    const { handle, add } = handler();
    for (const payload of [undefined, "nope", {}, { variant: 3 }, { variant: "x", entryId: "e" }, [{ variant: "x" }]]) {
      const response = await handle(json(payload), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "BRAIN_VARIANT_BODY_INVALID" });
    }
    expect(add).not.toHaveBeenCalled();
  });

  it("adds under the session actor and the path's entry, and returns the stored variant with its audit id", async () => {
    const { handle, add } = handler();
    const response = await handle(json({ variant: " How much is it? " }), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(add).toHaveBeenCalledWith({ entryId: "entry-1", variant: " How much is it? ", actorId: admin.userId });
    expect(await response.json()).toEqual({ state: "added", ...receipt });
  });

  it("maps repository refusals to their status and hides anything else behind one code", async () => {
    for (const [code, status] of [
      ["BRAIN_KNOWLEDGE_ENTRY_NOT_FOUND", 404],
      ["BRAIN_VARIANT_TEXT_REQUIRED", 400],
      ["BRAIN_VARIANT_TOO_LONG", 400],
      ["BRAIN_VARIANT_MATCHES_QUESTION", 409],
      ["BRAIN_VARIANT_DUPLICATE", 409],
    ] as const) {
      const response = await handler(vi.fn(async () => { throw new BrainKnowledgeVariantError(code); })).handle(json({ variant: "x" }), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ state: "refused", code });
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const embedding = await handler(vi.fn(async () => { throw new BrainKnowledgeVariantError("BRAIN_VARIANT_EMBEDDING_INVALID"); })).handle(json({ variant: "x" }), context);
    expect(embedding.status).toBe(400);
    expect(await embedding.json()).toEqual({ state: "refused", code: "BRAIN_VARIANT_REFUSED" });
    const unknown = await handler(vi.fn(async () => { throw new Error("provider down"); })).handle(json({ variant: "x" }), context);
    expect(await unknown.json()).toEqual({ state: "refused", code: "BRAIN_VARIANT_REFUSED" });
    error.mockRestore();
  });
});
