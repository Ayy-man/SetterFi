import { describe, expect, it, vi } from "vitest";

import { redactEvalTurns } from "@/lib/evals/redaction";

import {
  promoteEvalCase,
  promotionJsonHash,
  type EvalPromotionDependencies,
  type EvalPromotionInput,
} from "./eval-promotion";

const sourceHash = "a".repeat(64);
const actorId = "actor-synthetic";
const tenantId = "tenant-synthetic";
const evalCaseId = "eval-case-synthetic";
const auditId = "41";
const redaction = redactEvalTurns([
  { role: "user", content: "I need $50,000 with a 720 score." },
  { role: "assistant", content: "The next step uses the approved qualification matrix." },
]);

function input(overrides: Partial<EvalPromotionInput> = {}): EvalPromotionInput {
  return {
    actorId,
    conversationId: "conversation-synthetic",
    messageId: "message-synthetic",
    contactId: "contact-synthetic",
    redactedTurns: redaction.redactedTurns,
    expectation: { outcome: "BOOK" },
    suite: "qualification_accuracy",
    redactionManifest: redaction.redactionManifest,
    sourceHash,
    confirmedRedactedHash: promotionJsonHash(redaction.redactedTurns),
    notes: "Synthetic regression case",
    ...overrides,
  };
}

function dependencies(overrides: Partial<EvalPromotionDependencies> = {}) {
  const rpc = vi.fn(async (args: Record<string, unknown>) => {
    void args;
    return [{
      eval_case_id: evalCaseId,
      audit_id: 41,
    }];
  });
  const values: EvalPromotionDependencies = {
    loadSourceTenant: async () => tenantId,
    rpc,
    loadCase: async () => ({
      id: evalCaseId,
      category: "qualification",
      suite: "qualification_accuracy",
      kind: "engine",
      sourceTenantId: tenantId,
      sourceConversationId: "conversation-synthetic",
      sourceMessageId: "message-synthetic",
      sourceContactId: "contact-synthetic",
      promotedBy: actorId,
      sourceHash,
      confirmedRedactedHash: promotionJsonHash(redaction.redactedTurns),
      promotionAuditId: auditId,
    }),
    loadAudit: async () => ({
      id: auditId,
      action: "eval.case.promoted",
      actorId,
      targetType: "eval_case",
      targetId: evalCaseId,
      payload: { source_hash: sourceHash },
    }),
    loadAction: async () => ({
      key: "eval.case.promoted",
      microcopy: "Eval case promotion logged",
      ariaLabel: "Eval case promotion recorded in the audit log",
    }),
    ...overrides,
  };
  return { values, rpc };
}

describe("audited eval promotion repository", () => {
  it("derives tenant, kind, category, and audit custody before reporting promotion", async () => {
    const deps = dependencies();

    await expect(promoteEvalCase(input(), deps.values)).resolves.toEqual({
      state: "promoted",
      evalCaseId,
      auditId,
      actionKey: "eval.case.promoted",
    });
    expect(deps.rpc).toHaveBeenCalledWith(expect.objectContaining({
      p_actor_id: actorId,
      p_expected_tenant: tenantId,
      p_suite: "qualification_accuracy",
      p_redacted_turns: redaction.redactedTurns,
    }));
    expect(deps.rpc.mock.calls[0][0]).not.toHaveProperty("p_kind");
    expect(deps.rpc.mock.calls[0][0]).not.toHaveProperty("p_category");
  });

  it("pins both legal suite-to-category mappings", async () => {
    const voice = dependencies({
      loadCase: async () => ({
        ...(await dependencies().values.loadCase(evalCaseId))!,
        category: "voice",
        suite: "voice_tone",
      }),
    });

    await expect(promoteEvalCase(input({ suite: "voice_tone" }), voice.values))
      .resolves.toMatchObject({ state: "promoted" });
  });

  it.each([
    { loadCase: async () => null },
    { loadAudit: async () => null },
  ])("returns one named mismatch when the case or audit cannot be read back", async (override) => {
    const deps = dependencies(override);
    await expect(promoteEvalCase(input(), deps.values))
      .rejects.toThrow("EVAL_PROMOTION_READBACK_MISMATCH");
  });

  it("refuses residual PII, stale confirmation, and a third suite before SQL", async () => {
    const deps = dependencies();
    await expect(promoteEvalCase(input({
      redactedTurns: [{ role: "user", content: "Call 415-555-0134" }],
      redactionManifest: { placeholders: [] },
    }), deps.values)).rejects.toThrow("EVAL_PROMOTION_RESIDUAL_PII");
    await expect(promoteEvalCase(input({ confirmedRedactedHash: "b".repeat(64) }), deps.values))
      .rejects.toThrow("EVAL_PROMOTION_UNCONFIRMED_EDIT");
    await expect(promoteEvalCase({ ...input(), suite: "pricing_discipline" as never }, deps.values))
      .rejects.toThrow("EVAL_PROMOTION_SUITE_INVALID");
    expect(deps.rpc).not.toHaveBeenCalled();
  });

  it("returns a value-free refusal when SQL detects stale source or audit rollback", async () => {
    const deps = dependencies({ rpc: async () => { throw new Error("EVAL_PROMOTION_REFUSED"); } });
    await expect(promoteEvalCase(input(), deps.values)).rejects.toThrow("EVAL_PROMOTION_REFUSED");
  });
});
