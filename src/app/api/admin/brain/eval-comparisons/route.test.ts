import { describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";
import type { EvalComparisonResult } from "@/lib/evals/comparison";

import { createEvalComparisonHandler } from "./handler";

const HASH = "a".repeat(64);
const actor = { userId: "actor-1", role: "admin" as const };
const body = {
  draftId: "draft-1",
  contentHash: HASH,
  modelConfigAId: "config-a",
  modelConfigBId: "config-b",
};
const request = (value: unknown) => new Request(
  "https://setterfi.test/api/admin/brain/eval-comparisons",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  },
);

function comparison(): EvalComparisonResult {
  return {
    comparisonId: "comparison-1",
    status: "completed",
    state: "non_comparable",
    stateReason: "voice_tone:not_configured",
    driverArm: "mock",
    brainDraftVersionId: "draft-1",
    contentHash: HASH,
    brainVersion: null,
    offerVersion: null,
    rulesVersion: "rules-1",
    knowledgeMode: null,
    corpusRevision: "corpus-1",
    caseSetHash: "b".repeat(64),
    modelConfigAId: "config-a",
    modelConfigBId: "config-b",
    runAId: "run-a",
    runBId: "run-b",
    createdAt: "2026-08-18T00:00:00.000Z",
    finishedAt: "2026-08-18T00:01:00.000Z",
    suites: [],
  };
}

describe("eval comparison route", () => {
  it("404s before auth or comparison work while the nested eval flag is off", async () => {
    const session = vi.fn(async () => actor);
    const run = vi.fn();
    const response = await createEvalComparisonHandler({ enabled: () => false, session, run })(request(body));
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["success", "build", "coach"] as const)(
    "returns 403 to %s before comparison work",
    async (role) => {
      const run = vi.fn();
      const response = await createEvalComparisonHandler({
        enabled: () => true,
        session: async () => ({ userId: "actor-1", role }),
        run,
      })(request(body));
      expect(response.status).toBe(403);
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("derives actor and accepts only the four comparison identifiers", async () => {
    const run = vi.fn(async () => comparison());
    const response = await createEvalComparisonHandler({
      enabled: () => true,
      session: async () => actor,
      run,
    })(request(body));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledWith({ actorId: actor.userId, ...body });
    await expect(response.json()).resolves.toMatchObject({
      state: "non_comparable",
      comparison: { driverArm: "mock", stateReason: "voice_tone:not_configured" },
    });
  });

  it.each([
    { ...body, modelConfigBId: body.modelConfigAId, cases: [] },
    { ...body, versions: { brain: 4 } },
    { ...body, tenantId: "tenant-1" },
    { ...body, params: {} },
    { ...body, contentHash: "short" },
  ])("rejects caller evidence or parameters %# before execution", async (candidate) => {
    const run = vi.fn();
    const response = await createEvalComparisonHandler({
      enabled: () => true,
      session: async () => actor,
      run,
    })(request(candidate));
    expect(response.status).toBe(409);
    expect(run).not.toHaveBeenCalled();
  });

  it("names OPENROUTER_API_KEY without exposing a value when explicit real selection is unusable", async () => {
    const response = await createEvalComparisonHandler({
      enabled: () => true,
      session: async () => actor,
      run: async () => { throw new DriverConfigurationError("openrouter", ["OPENROUTER_API_KEY"]); },
    })(request(body));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      state: "refused",
      code: "DRIVER_CONFIGURATION_ERROR",
      driver: "openrouter",
      variableNames: ["OPENROUTER_API_KEY"],
    });
  });

  it("returns no comparison payload after evidence refusal", async () => {
    const response = await createEvalComparisonHandler({
      enabled: () => true,
      session: async () => actor,
      run: async () => { throw new Error("EVAL_COMPARISON_RESULT_KEY_MISMATCH"); },
    })(request(body));
    expect(response.status).toBe(409);
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toEqual({ state: "refused", code: "EVAL_COMPARISON_REFUSED" });
    expect(payload).not.toHaveProperty("comparison");
  });
});
