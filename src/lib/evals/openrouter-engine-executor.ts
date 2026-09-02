/** OpenRouter-backed executor for evidence-bound published-snapshot engine cases. */

import { runOutputChecks } from "@/lib/engine/output-checks";
import type { EnvironmentSource } from "@/lib/env-contract";
import type { SafetyCorpusCase } from "@/lib/evals/corpus";
import type { EngineCaseExecutor } from "@/lib/evals/runner";
import { createRealModelDriver } from "@/lib/integrations/openrouter";
import type { ModelDriver } from "@/lib/integrations/types";

export const ENGINE_EVAL_UNAVAILABLE = "ENGINE_EVAL_UNAVAILABLE" as const;

export type PublishedEngineSnapshot = {
  snapshotId: string;
  version: number;
  draftId: string;
  contentHash: string;
  compiledPlatform: string;
};

export type EngineModelConfiguration = {
  id: string;
  model: string;
  params: Readonly<Record<string, unknown>>;
};

export type OpenRouterEngineCaseExecutorSelection =
  | { state: "ready"; executor: EngineCaseExecutor }
  | { state: "unavailable"; code: typeof ENGINE_EVAL_UNAVAILABLE; reason: string };

function executionPassed(testCase: SafetyCorpusCase, actual: ReturnType<typeof runOutputChecks>) {
  if (testCase.expectation.verdict === "pass") return actual.passed;
  const ruleIds = new Set(actual.violations.map((violation) => violation.ruleId));
  return actual.violations.some((violation) => violation.class === testCase.expectation.class)
    && testCase.expectation.ruleIds.every((ruleId) => ruleIds.has(ruleId));
}

export function createOpenRouterEngineCaseExecutor(input: {
  snapshot: PublishedEngineSnapshot;
  configuration: EngineModelConfiguration;
  environment?: EnvironmentSource;
  createModel?: (apiKey: string) => ModelDriver;
}): OpenRouterEngineCaseExecutorSelection {
  const environment = input.environment ?? process.env;
  const selector = environment.SETTERFI_OPENROUTER_DRIVER?.trim();
  if (!selector || selector === "mock") {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "SETTERFI_OPENROUTER_DRIVER is not real." };
  }
  if (selector !== "real") {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "SETTERFI_OPENROUTER_DRIVER is invalid." };
  }
  const apiKey = environment.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    return { state: "unavailable", code: ENGINE_EVAL_UNAVAILABLE, reason: "OPENROUTER_API_KEY is missing." };
  }
  const model = (input.createModel ?? createRealModelDriver)(apiKey);
  const executor: EngineCaseExecutor = async (testCase) => {
    const generated = await model.generate([
      {
        role: "system",
        content: `${input.snapshot.compiledPlatform}\n\n${testCase.context.roleBoundary}`,
      },
      ...testCase.turns.map((turn) => ({
        role: turn.role === "lead" ? "user" as const : "assistant" as const,
        content: turn.content,
      })),
    ], { model: input.configuration.model, params: { ...input.configuration.params } });
    const actual = runOutputChecks(generated.draft, testCase.context);
    const ruleIds = [...new Set(actual.violations.map((violation) => violation.ruleId))];
    return {
      passed: executionPassed(testCase, actual),
      response: generated.draft,
      ruleIds,
      trace: {
        driverArm: "real",
        expected: testCase.expectation,
        actualPassed: actual.passed,
        checks: actual.checks,
        violations: actual.violations,
        publishedSnapshotId: input.snapshot.snapshotId,
        publishedVersion: input.snapshot.version,
        publishedContentHash: input.snapshot.contentHash,
        providerCostCredits: generated.provider.cost,
      },
      latencyMs: generated.provider.latencyMs,
      // Provider credits have no approved cents conversion, so the legacy cents field stays absent.
      costCents: null,
    };
  };
  return { state: "ready", executor };
}
