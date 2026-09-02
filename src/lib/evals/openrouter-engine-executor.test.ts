import { describe, expect, it, vi } from "vitest";

import { PHASE3_ENGINE_CASES } from "@/lib/engine/safety-corpus";
import type { ModelDriver } from "@/lib/integrations/types";
import { createOpenRouterEngineCaseExecutor } from "./openrouter-engine-executor";

const snapshot = {
  snapshotId: "snapshot-synthetic", version: 8, draftId: "draft-synthetic",
  contentHash: "a".repeat(64), compiledPlatform: "Published synthetic platform prompt.",
};
const configuration = { id: "config-synthetic", model: "vendor/model", params: { temperature: 0 } };

describe("OpenRouter engine case executor", () => {
  it.each([{}, { SETTERFI_OPENROUTER_DRIVER: "mock" }])("returns explicit unavailable for the credless mock arm", (environment) => {
    expect(createOpenRouterEngineCaseExecutor({ snapshot, configuration, environment })).toEqual({
      state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE", reason: "SETTERFI_OPENROUTER_DRIVER is not real.",
    });
  });

  it("fails an explicit real arm closed when its key is absent", () => {
    expect(createOpenRouterEngineCaseExecutor({ snapshot, configuration, environment: { SETTERFI_OPENROUTER_DRIVER: "real" } })).toEqual({
      state: "unavailable", code: "ENGINE_EVAL_UNAVAILABLE", reason: "OPENROUTER_API_KEY is missing.",
    });
  });

  it("executes with the current published prompt and binds its evidence into the trace", async () => {
    const generate = vi.fn<ModelDriver["generate"]>(async () => ({
      draft: "I guarantee approval.",
      usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      provider: { name: "synthetic", generationId: "generation-synthetic", latencyMs: 12, cost: 0.001 },
    }));
    const selection = createOpenRouterEngineCaseExecutor({
      snapshot, configuration,
      environment: { SETTERFI_OPENROUTER_DRIVER: "real", OPENROUTER_API_KEY: "synthetic-key" },
      createModel: () => ({ generate }),
    });
    expect(selection.state).toBe("ready");
    if (selection.state !== "ready") throw new Error("ENGINE_EVAL_UNAVAILABLE");
    const result = await selection.executor(PHASE3_ENGINE_CASES.find((entry) => entry.key.includes("outcome-pressure"))!);
    expect(result).toMatchObject({ passed: true, trace: { driverArm: "real", publishedSnapshotId: snapshot.snapshotId, publishedVersion: 8, publishedContentHash: snapshot.contentHash } });
    expect(generate.mock.calls[0][0][0].content).toContain(snapshot.compiledPlatform);
    expect(JSON.stringify(result)).not.toContain("synthetic-key");
  });
});
