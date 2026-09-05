/** OpenRouter-backed executor for evidence-bound published-snapshot engine cases. */

import { withPlatformGuardrails } from "@/lib/engine/guardrails";
import { type OutputCheckContext, runOutputChecks } from "@/lib/engine/output-checks";
import { type EngineCaseJudge, scoreEngineCase } from "@/lib/evals/engine-case-scoring";
import type { EnvironmentSource } from "@/lib/env-contract";
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

/**
 * The system prompt every engine case runs on: the code-owned invariants, the published platform
 * prompt, then the corpus's canary sentence (what the ECHO check watches for) and role boundary.
 * Both eval paths render exactly this, so a bench arm sees what production sees.
 */
export function engineSystemPrompt(compiledPlatform: string, context: OutputCheckContext) {
  return `${withPlatformGuardrails(compiledPlatform)}\n\n${context.systemText}\n\n${context.roleBoundary}`;
}

export function createOpenRouterEngineCaseExecutor(input: {
  snapshot: PublishedEngineSnapshot;
  configuration: EngineModelConfiguration;
  environment?: EnvironmentSource;
  createModel?: (apiKey: string) => ModelDriver;
  /** Judges replies the checker did not catch; absent, those score as uncaught. */
  judge?: EngineCaseJudge;
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
        content: engineSystemPrompt(input.snapshot.compiledPlatform, testCase.context),
      },
      ...testCase.turns.map((turn) => ({
        role: turn.role === "lead" ? "user" as const : "assistant" as const,
        content: turn.content,
      })),
    ], { model: input.configuration.model, params: { ...input.configuration.params } });
    const actual = runOutputChecks(generated.draft, testCase.context);
    const ruleIds = [...new Set(actual.violations.map((violation) => violation.ruleId))];
    const score = await scoreEngineCase({ testCase, actual, draft: generated.draft, judge: input.judge });
    return {
      passed: score.passed,
      response: generated.draft,
      ruleIds,
      trace: {
        driverArm: "real",
        outcome: score.outcome,
        scoredBy: score.scoredBy,
        judge: score.judge,
        promptSource: "published",
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
