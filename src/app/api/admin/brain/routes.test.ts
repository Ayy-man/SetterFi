import { describe, expect, it, vi } from "vitest";

import type { ImportFlag } from "@/lib/brain/import/flags";
import type { BrainDraftRevision } from "@/lib/repositories/brain-publish";
import type { EvalRunReceipt, EvalSuiteName } from "@/lib/repositories/eval-runs";

import { createBrainDraftHandler } from "./draft/handler";
import { createBrainEvalHandler } from "./evals/handler";
import { createBrainImportAcceptHandler } from "./imports/[batchId]/items/[itemId]/accept/handler";
import { createBrainImportRejectHandler } from "./imports/[batchId]/items/[itemId]/reject/handler";
import { createBrainPublishHandler } from "./publish/handler";
import { createBrainRollbackHandler } from "./rollback/handler";

const actor = { userId: "platform-admin", role: "admin" as const };
const hash = "a".repeat(64);
const draft: BrainDraftRevision = {
  id: "draft-1",
  contentHash: hash,
  createdBy: actor.userId,
  payload: { entities: [], compiledPlatform: "", platformTokens: 0, knowledgeMode: "inline" },
};
const request = (path: string, body: unknown) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const acceptContext = {
  params: Promise.resolve({ batchId: "batch-1", itemId: "item-1" }),
};

function evalReceipt(options: { stale?: boolean; failed?: boolean } = {}): EvalRunReceipt {
  const suites: EvalSuiteName[] = [
    "compliance_guardrails",
    "pricing_discipline",
    "jailbreak_injection",
    "output_integrity",
  ];
  return {
    run: {
      id: "eval-1",
      brainDraftVersionId: options.stale ? "draft-old" : draft.id,
      contentHash: options.stale ? "b".repeat(64) : draft.contentHash,
      kind: "checker",
      modelConfigId: null,
      corpusRevision: "corpus-1",
      suitesComplete: true,
    },
    results: suites.map((suite, index) => ({
      id: `result-${index}`,
      runId: "eval-1",
      caseId: null,
      caseKey: `${suite}:case-1`,
      suite,
      passed: !(options.failed && suite === "pricing_discipline"),
      response: null,
      trace: options.failed && suite === "pricing_discipline" ? { ruleIds: ["NUM-001"] } : {},
      latencyMs: null,
      costCents: null,
    })),
  };
}

function publishDependencies(overrides: Partial<Parameters<typeof createBrainPublishHandler>[0]> = {}) {
  const receipt = {
    snapshot: {
      id: "snapshot-1",
      version: 1,
      contentHash: hash,
      sourceHash: "source-1",
      payload: draft.payload,
      compiledPlatform: "",
      platformTokens: 0,
      knowledgeMode: "inline" as const,
      evalRunId: "eval-1",
      rollbackOfSnapshotId: null,
    },
    audit: { id: 41, action: "brain.published" as const, payload: { reason: "reviewed" } },
  };
  return {
    enabled: () => true,
    session: async () => actor,
    loadDraft: async () => draft,
    loadEval: async () => evalReceipt(),
    corpusRevision: () => "corpus-1",
    publish: async () => ({
      status: "published" as const,
      diff: {
        status: "changed" as const,
        currentHash: "b".repeat(64),
        draftHash: hash,
        changes: [],
        impactKeys: [],
      },
      receipt,
    }),
    emitFailure: async () => ({ notificationIds: [] }),
    ...overrides,
  } satisfies Parameters<typeof createBrainPublishHandler>[0];
}

const publishBody = {
  draftId: draft.id,
  evalRunId: "eval-1",
  expectedCurrentVersion: 0,
  reason: "reviewed",
};

describe("Phase 2 Brain route gates", () => {
  it("404s item acceptance before auth or item reads", async () => {
    const session = vi.fn(async () => actor);
    const load = vi.fn();
    const accept = vi.fn();
    const response = await createBrainImportAcceptHandler({
      enabled: () => false,
      session,
      load,
      accept,
    })(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {}), acceptContext);
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });

  it("404s draft creation before auth or service work", async () => {
    const session = vi.fn(async () => actor);
    const create = vi.fn();
    const response = await createBrainDraftHandler({ enabled: () => false, session, create })(
      request("/api/admin/brain/draft", {}),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("404s eval execution before auth or runner work", async () => {
    const session = vi.fn(async () => actor);
    const run = vi.fn();
    const response = await createBrainEvalHandler({ enabled: () => false, session, run })(
      request("/api/admin/brain/evals", {}),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("404s publish before auth, reads, or transaction work", async () => {
    const session = vi.fn(async () => actor);
    const loadDraft = vi.fn();
    const publish = vi.fn();
    const response = await createBrainPublishHandler(publishDependencies({
      enabled: () => false,
      session,
      loadDraft,
      publish,
    }))(request("/api/admin/brain/publish", publishBody));
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(loadDraft).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("404s rollback before auth or transaction work", async () => {
    const session = vi.fn(async () => actor);
    const rollback = vi.fn();
    const response = await createBrainRollbackHandler({ enabled: () => false, session, rollback })(
      request("/api/admin/brain/rollback", {}),
    );
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });
});

describe("Brain review and publish boundaries", () => {
  it("refuses an unresolved blocking flag without acceptance or audit success", async () => {
    const flag: ImportFlag = {
      id: "flag-1",
      code: "unbound_figure",
      severity: "blocking",
      field: "responseTemplate",
      offset: 12,
      resolved: false,
      resolution: null,
    };
    const accept = vi.fn();
    const response = await createBrainImportAcceptHandler({
      enabled: () => true,
      session: async () => actor,
      load: async () => ({
        item: {
          sourceRef: "source-1",
          sourceEditedAt: null,
          categories: ["general"],
          category: "general",
          inboundMessage: "What is available?",
          responseTemplate: "A 25 percent example needs review.",
          matchKeywords: ["available"],
          flags: [flag],
          figures: [],
          sourceShapeValid: true,
        },
        embedding: Array.from({ length: 1_536 }, () => 0),
        brandNames: [],
      }),
      accept,
    })(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {
      sourceRef: "source-1",
      disposition: "shared",
      numberBindings: [],
      resolvedFlagIds: [],
      bareXResolutions: [],
    }), acceptContext);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      state: "refused",
      code: "BRAIN_IMPORT_BLOCKING_FLAGS_UNRESOLVED",
    });
    expect(accept).not.toHaveBeenCalled();
  });

  it("surfaces the specific refusal when a reviewer ticks a content flag on a shared row without editing", async () => {
    const flag: ImportFlag = {
      id: "proof_claim:responseTemplate:0",
      code: "proof_claim",
      severity: "blocking",
      field: "responseTemplate",
      offset: 0,
      resolved: false,
      resolution: null,
    };
    const accept = vi.fn();
    const stored = {
      item: {
        sourceRef: "source-1",
        sourceEditedAt: null,
        categories: ["Funding Qs"],
        category: "Funding Qs",
        inboundMessage: "Who have you helped?",
        responseTemplate: "Our clients got approved in weeks.",
        matchKeywords: [],
        flags: [flag],
        figures: [],
        sourceShapeValid: true,
      },
      embedding: Array.from({ length: 1_536 }, () => 0),
      brandNames: ["Legacy Strong"],
    };
    const handler = createBrainImportAcceptHandler({
      enabled: () => true,
      session: async () => actor,
      load: async () => stored,
      accept,
    });

    const ticked = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {
      sourceRef: "source-1",
      disposition: "shared",
      numberBindings: [],
      resolvedFlagIds: [flag.id],
      bareXResolutions: [],
    }), acceptContext);
    expect(ticked.status).toBe(409);
    await expect(ticked.json()).resolves.toEqual({ state: "refused", code: "BRAIN_IMPORT_CONTENT_FLAG_UNEDITED" });

    const stillFlagged = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {
      sourceRef: "source-1",
      disposition: "shared",
      numberBindings: [],
      resolvedFlagIds: [],
      bareXResolutions: [],
      edit: { responseTemplate: "Legacy Strong clients see results." },
    }), acceptContext);
    expect(stillFlagged.status).toBe(409);
    await expect(stillFlagged.json()).resolves.toEqual({ state: "refused", code: "BRAIN_IMPORT_CONTENT_FLAGS_REMAIN" });
    expect(accept).not.toHaveBeenCalled();

    accept.mockResolvedValue({ ok: true });
    const edited = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {
      sourceRef: "source-1",
      disposition: "shared",
      numberBindings: [],
      resolvedFlagIds: [],
      bareXResolutions: [],
      edit: { responseTemplate: "Approval timelines vary by lender." },
    }), acceptContext);
    expect(edited.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "shared",
      tenantId: null,
      afterPayload: expect.objectContaining({ responseTemplate: "Approval timelines vary by lender." }),
    }));
  });

  it("requires a tenant for tenant_specific and forwards it to the repository", async () => {
    const accept = vi.fn().mockResolvedValue({ ok: true });
    const handler = createBrainImportAcceptHandler({
      enabled: () => true,
      session: async () => actor,
      load: async () => ({
        item: {
          sourceRef: "source-1",
          sourceEditedAt: null,
          categories: ["Credit"],
          category: "Credit",
          inboundMessage: "Synthetic",
          responseTemplate: "Synthetic response",
          matchKeywords: [],
          flags: [],
          figures: [],
          sourceShapeValid: true,
        },
        embedding: Array.from({ length: 1_536 }, () => 0),
        brandNames: [],
      }),
      accept,
    });
    const body = {
      sourceRef: "source-1",
      disposition: "tenant_specific",
      numberBindings: [],
      resolvedFlagIds: [],
      bareXResolutions: [],
    };
    const missing = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/accept", body), acceptContext);
    expect(missing.status).toBe(409);
    await expect(missing.json()).resolves.toEqual({ state: "refused", code: "BRAIN_IMPORT_TENANT_REQUIRED" });
    expect(accept).not.toHaveBeenCalled();

    const routed = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/accept", {
      ...body,
      tenantId: "30000000-0000-4000-8000-000000000010",
    }), acceptContext);
    expect(routed.status).toBe(200);
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({
      disposition: "tenant_specific",
      tenantId: "30000000-0000-4000-8000-000000000010",
    }));
  });

  it("rejects an import row only with a reason, from the stored item, and returns the audit receipt", async () => {
    const reject = vi.fn().mockResolvedValue({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      decision: "rejected",
      auditId: 18,
      auditAction: "brain.import.rejected",
    });
    const handler = createBrainImportRejectHandler({
      enabled: () => true,
      session: async () => actor,
      load: async (batchId, itemId) => (batchId === "batch-1" && itemId === "item-1"
        ? { sourceRef: "source-1" }
        : null),
      reject,
    });

    const blank = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/reject", {
      sourceRef: "source-1",
      reason: "  ",
    }), acceptContext);
    expect(blank.status).toBe(400);
    expect(reject).not.toHaveBeenCalled();

    const stale = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/reject", {
      sourceRef: "source-other",
      reason: "Duplicate of an existing row.",
    }), acceptContext);
    expect(stale.status).toBe(404);
    expect(reject).not.toHaveBeenCalled();

    const response = await handler(request("/api/admin/brain/imports/batch-1/items/item-1/reject", {
      sourceRef: "source-1",
      reason: "Duplicate of an existing row.",
    }), acceptContext);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "rejected",
      receipt: expect.objectContaining({ auditId: 18, auditAction: "brain.import.rejected" }),
    });
    expect(reject).toHaveBeenCalledWith({
      batchId: "batch-1",
      itemId: "item-1",
      sourceRef: "source-1",
      reason: "Duplicate of an existing row.",
      actorId: actor.userId,
    });
  });

  it("404s and 403s rejection before any item read, like acceptance", async () => {
    const reject = vi.fn();
    const load = vi.fn();
    const off = await createBrainImportRejectHandler({
      enabled: () => false,
      session: async () => actor,
      load,
      reject,
    })(request("/api/admin/brain/imports/batch-1/items/item-1/reject", { sourceRef: "s", reason: "r" }), acceptContext);
    expect(off.status).toBe(404);
    const forbidden = await createBrainImportRejectHandler({
      enabled: () => true,
      session: async () => ({ userId: "builder", role: "build" }),
      load,
      reject,
    })(request("/api/admin/brain/imports/batch-1/items/item-1/reject", { sourceRef: "s", reason: "r" }), acceptContext);
    expect(forbidden.status).toBe(403);
    expect(load).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
  });

  it("refuses read-only platform roles before a Brain service call", async () => {
    const create = vi.fn();
    const response = await createBrainDraftHandler({
      enabled: () => true,
      session: async () => ({ userId: "builder", role: "build" }),
      create,
    })(request("/api/admin/brain/draft", { draft: {} }));
    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a stale-eval precondition separately from a blocked eval", async () => {
    const stalePublish = vi.fn();
    const stale = await createBrainPublishHandler(publishDependencies({
      loadEval: async () => evalReceipt({ stale: true }),
      publish: stalePublish,
    }))(request("/api/admin/brain/publish", publishBody));
    expect(stale.status).toBe(412);
    await expect(stale.json()).resolves.toMatchObject({ state: "not_run_for_this_version" });
    expect(stalePublish).not.toHaveBeenCalled();

    const blockedPublish = vi.fn();
    const blocked = await createBrainPublishHandler(publishDependencies({
      loadEval: async () => evalReceipt({ failed: true }),
      publish: blockedPublish,
    }))(request("/api/admin/brain/publish", publishBody));
    expect(blocked.status).toBe(409);
    await expect(blocked.json()).resolves.toMatchObject({
      state: "blocked",
      blockers: [{
        suite: "pricing_discipline",
        caseKey: "pricing_discipline:case-1",
        ruleId: "NUM-001",
        reason: "failed",
      }],
    });
    expect(blockedPublish).not.toHaveBeenCalled();
  });

  it("emits the platform failure event only for a typed transaction failure", async () => {
    const emitFailure = vi.fn(async () => ({ notificationIds: ["notification-1"] }));
    const failure = await createBrainPublishHandler(publishDependencies({
      publish: async () => { throw new Error("BRAIN_PUBLISH_FAILED:transaction"); },
      emitFailure,
    }))(request("/api/admin/brain/publish", publishBody));
    expect(failure.status).toBe(409);
    expect(emitFailure).toHaveBeenCalledWith(expect.objectContaining({
      key: "brain.publish_failed",
      tenantId: null,
      actorId: actor.userId,
      draftId: draft.id,
      errorCode: "BRAIN_PUBLISH_FAILED",
    }));

    const successEmitter = vi.fn(async () => ({ notificationIds: [] }));
    const success = await createBrainPublishHandler(publishDependencies({ emitFailure: successEmitter }))(
      request("/api/admin/brain/publish", publishBody),
    );
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toMatchObject({
      status: "published",
      receipt: {
        snapshot: { version: 1 },
        audit: { id: 41, action: "brain.published" },
      },
    });
    expect(successEmitter).not.toHaveBeenCalled();
  });

  it("requires a nonblank rollback reason before transaction work", async () => {
    const rollback = vi.fn();
    const response = await createBrainRollbackHandler({
      enabled: () => true,
      session: async () => actor,
      rollback,
    })(request("/api/admin/brain/rollback", {
      expectedCurrentVersion: 3,
      selectedVersion: 1,
      reason: "   ",
    }));
    expect(response.status).toBe(409);
    expect(rollback).not.toHaveBeenCalled();
  });
});
