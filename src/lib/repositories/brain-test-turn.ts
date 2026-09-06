/**
 * One admin test turn against a chosen coach and Brain revision.
 *
 * The turn runs the real engine (`runEngineTurn`) with the same drivers, approved platform content
 * and published offer a production turn would use. Nothing here applies the engine's commands:
 * no send, no conversation row, no qualification write. The commands are read only to describe
 * what the turn decided, which is what the Brain's evidence panel shows.
 */

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { activeModelConfigurations } from "@/lib/engine/model-config";
import { channelLengthLimits, type OutputCheckContext } from "@/lib/engine/output-checks";
import {
  engineBrainFromRuntimeBundle,
  engineOfferFromRuntimeBundle,
  runEngineTurn,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import {
  MODERATOR_CLASSES,
  type EngineTurnResult,
  type ModeratorClass,
  type ModeratorState,
  type PromptMessage,
} from "@/lib/engine/types";
import { environmentValue } from "@/lib/env-contract";
import {
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "@/lib/integrations/openrouter";
import { selectModelDrivers } from "@/lib/integrations/selector";
import type { ModelDriver, ModeratorDriver } from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  loadApprovedPlatformAgentContent,
  type ApprovedPlatformAgentContent,
} from "@/lib/webhooks/live-preview";

import {
  loadRevisionRuntime,
  type BrainRevision,
  type RevisionRuntime,
} from "./brain-revision-runtime";

export const TEST_TURN_CHANNELS = ["sms", "instagram", "messenger", "whatsapp", "webchat"] as const;
export type TestTurnChannel = (typeof TEST_TURN_CHANNELS)[number];
export const TEST_TURN_MESSAGE_MAX = 800;
export const TEST_TURN_HISTORY_MAX = 24;

export type TestTurnHistoryEntry = { role: "user" | "assistant"; content: string };

export type BrainTestTurnInput = {
  coachTenantId: string;
  revision: BrainRevision;
  channel: TestTurnChannel;
  message: string;
  history: readonly TestTurnHistoryEntry[];
};

export type BrainTestTurnEvidence = {
  citations: readonly { entryId: string; question: string; cited: boolean }[];
  qualification: {
    ruleId?: string;
    outcome?: "BOOK" | "SOFT_DQ" | "HARD_DQ";
    /** Qualification facts the turn established out of the inputs the published rules ask for. */
    step: number;
    of: number;
    nextStep: string | null;
  };
  safety: {
    /** Final state per output-check class, after any regeneration or truncation. */
    checks: readonly { class: string; passed: boolean; ruleId?: string }[];
    moderator: {
      verdict: ModeratorState;
      /** Wall time of the moderator calls this turn made; null when the moderator never ran. */
      ms: number | null;
      class: string | null;
      ruleId: string | null;
      reason: string | null;
    };
  };
  promptHash: string | null;
  tokens: { prompt: number; completion: number; total: number };
  channelLength: { chars: number; soft: number; hard: number };
};

export type BrainTestTurnResult = {
  reply: string;
  held: boolean;
  heldClass?: ModeratorClass;
  /** The engine's own reason for a held turn, whatever class it maps to. */
  heldReason: string | null;
  conversationState: EngineTurnResult["response"]["state"];
  evidence: BrainTestTurnEvidence;
  revision: {
    kind: BrainRevision;
    snapshotId: string;
    brainVersion: number;
    contentHash: string;
    offerVersion: number;
    draftId: string | null;
    retrievalMode: RevisionRuntime["retrievalMode"];
  };
  model: string | null;
  latencyMs: number | null;
  attempts: number;
};

type SelectedDrivers = { model: ModelDriver; moderator: ModeratorDriver };

export type BrainTestTurnDependencies = {
  loadRevision(input: { tenantId: string; revision: BrainRevision }): Promise<RevisionRuntime>;
  loadContent(tenantId: string): Promise<ApprovedPlatformAgentContent>;
  loadModelConfigs(): Promise<EnginePipelineInput["modelConfigs"]>;
  selectDrivers(configs: EnginePipelineInput["modelConfigs"]): Promise<SelectedDrivers>;
  tagSecret(): string | null;
  runTurn?: typeof runEngineTurn;
  now?: () => number;
};

function publishedLinkWhitelist(bundle: PublishedRuntimeBundle) {
  const urls = [bundle.renderSources.bookingUrl, ...Object.values(bundle.renderSources.assetUrlsBySlug)];
  return [...new Set(urls.flatMap((value) => {
    if (!value) return [];
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  }))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Entry id to the inbound question it answers, read off the revision's own payload. */
export function knowledgeQuestions(bundle: PublishedRuntimeBundle) {
  const entities = bundle.brain.payload.entities;
  const questions = new Map<string, string>();
  if (!Array.isArray(entities)) return questions;
  for (const entity of entities) {
    if (!isRecord(entity) || entity.type !== "knowledge_entry" || typeof entity.id !== "string" || !isRecord(entity.value)) continue;
    const question = entity.value.inboundMessage ?? entity.value.question;
    if (typeof question === "string" && question.trim()) questions.set(entity.id, question.trim());
  }
  return questions;
}

function moderatorClassOf(value: string | null | undefined): ModeratorClass | undefined {
  return value && (MODERATOR_CLASSES as readonly string[]).includes(value) ? value as ModeratorClass : undefined;
}

/**
 * Which held reply the lead received. Held outcomes are mapped from what the trace records rather
 * than from a list of known reasons, so a new held class the engine learns to emit arrives here
 * with its class (when the rule id or moderator names one) and its reason, never as a crash.
 */
export function heldClassOf(result: EngineTurnResult, heldReplies: Record<ModeratorClass, string>) {
  const { trace, response } = result;
  if (trace.screen.verdict !== "held") return undefined;
  if (trace.moderator === "blocked") return moderatorClassOf(trace.moderatorClass);
  const fromRule = moderatorClassOf(trace.ruleFired?.split("-")[0]);
  if (fromRule) return fromRule;
  const lastViolation = trace.violations.at(-1);
  if (lastViolation) return lastViolation.class;
  return MODERATOR_CLASSES.find((checkClass) => response.reply.includes(heldReplies[checkClass]));
}

export function mapTestTurnEvidence(input: {
  result: EngineTurnResult;
  bundle: PublishedRuntimeBundle;
  channel: TestTurnChannel;
  moderatorMs: number | null;
}): BrainTestTurnEvidence {
  const { trace, commands, response } = input.result;
  const questions = knowledgeQuestions(input.bundle);
  const cited = trace.declaredEntryVerified ? trace.declaredEntryId : null;
  const citations = trace.sources.map((source) => ({
    entryId: source.entryId,
    question: questions.get(source.entryId) ?? source.content.slice(0, 120),
    cited: source.entryId === cited,
  }));
  const outcome = commands.find((command) => command.kind === "record_qualification_outcome");
  const hardDq = commands.find((command) => command.kind === "record_hard_dq");
  const persisted = commands.filter((command) => command.kind === "persist_qualification").length;
  const advance = commands.find((command) => command.kind === "advance_step");
  const nextStep = advance && advance.kind === "advance_step" ? advance.nextStepId ?? null : null;
  const finalChecks = new Map<string, { class: string; passed: boolean; ruleId?: string }>();
  for (const check of trace.checks) {
    finalChecks.set(check.class, {
      class: check.class,
      passed: check.passed,
      ...(check.ruleIds[0] ? { ruleId: check.ruleIds[0] } : {}),
    });
  }
  const limits = channelLengthLimits(input.channel as OutputCheckContext["channel"]);
  return {
    citations,
    qualification: {
      ...(outcome?.kind === "record_qualification_outcome" ? { ruleId: outcome.ruleId, outcome: outcome.outcome } : {}),
      ...(hardDq?.kind === "record_hard_dq" ? { outcome: "HARD_DQ" as const } : {}),
      step: Math.min(persisted, input.bundle.renderSources.qualificationInputs.length),
      of: input.bundle.renderSources.qualificationInputs.length,
      nextStep,
    },
    safety: {
      checks: [...finalChecks.values()],
      moderator: {
        verdict: trace.moderator,
        ms: trace.moderator === "not_run" ? null : input.moderatorMs,
        class: trace.moderatorClass,
        ruleId: trace.moderatorRuleId,
        reason: trace.moderatorReason,
      },
    },
    promptHash: trace.promptHash,
    tokens: {
      prompt: trace.usage?.promptTokens ?? 0,
      completion: trace.usage?.completionTokens ?? 0,
      total: trace.usage?.totalTokens ?? 0,
    },
    channelLength: { chars: response.reply.length, soft: limits.soft, hard: limits.hard },
  };
}

export async function runBrainTestTurn(
  input: BrainTestTurnInput,
  dependencies: BrainTestTurnDependencies = liveBrainTestTurnDependencies(),
): Promise<BrainTestTurnResult> {
  const tenantId = input.coachTenantId.trim();
  const message = input.message.trim();
  if (!tenantId) throw new Error("TEST_TURN_TENANT_REQUIRED");
  if (!message || message.length > TEST_TURN_MESSAGE_MAX) throw new Error("TEST_TURN_MESSAGE_INVALID");
  if (input.history.length > TEST_TURN_HISTORY_MAX) throw new Error("TEST_TURN_HISTORY_INVALID");
  const tagSecret = dependencies.tagSecret();
  if (!tagSecret) throw new Error("SETTERFI_TAG_SECRET_REQUIRED");
  const [revision, content, modelConfigs] = await Promise.all([
    dependencies.loadRevision({ tenantId, revision: input.revision }),
    dependencies.loadContent(tenantId),
    dependencies.loadModelConfigs(),
  ]);
  const selected = await dependencies.selectDrivers(modelConfigs);
  const now = dependencies.now ?? (() => Date.now());
  let moderatorMs = 0;
  let moderatorCalls = 0;
  const moderator = {
    moderate: async (payload: Parameters<ModeratorDriver["moderate"]>[0]) => {
      const started = now();
      try {
        return await selected.moderator.moderate(payload);
      } finally {
        moderatorMs += now() - started;
        moderatorCalls += 1;
      }
    },
  };
  const history: PromptMessage[] = [
    ...input.history.map((entry) => ({ role: entry.role, content: entry.content })),
    // The engine's prompt is [system, ...history]; the message under test reaches the model only
    // as the final user entry.
    { role: "user" as const, content: message },
  ];
  const result = await (dependencies.runTurn ?? runEngineTurn)({
    mode: "test",
    channel: input.channel,
    brain: engineBrainFromRuntimeBundle(revision.bundle),
    offer: engineOfferFromRuntimeBundle(revision.bundle),
    conversation: { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
    history,
    leadMessage: { id: `admin-test:${revision.revision}`, body: message },
    tagSecret,
    automatedExperienceDisclosure: content.automatedExperienceDisclosure,
    heldReplies: content.heldReplies,
    linkWhitelist: publishedLinkWhitelist(revision.bundle),
    roleBoundary: content.roleBoundary,
    modelConfigs,
    currentQuestion: null,
    extractionCandidate: null,
    qualificationState: {
      credit: null,
      goal: null,
      timeline: null,
      businessStage: null,
      annualRevenueCents: null,
      outcome: null,
      dqReason: null,
    },
    runtimeBundle: revision.bundle,
  }, {
    model: selected.model,
    moderator,
    ...(revision.retrieve ? { retrieve: revision.retrieve } : {}),
  });
  const held = result.trace.screen.verdict === "held";
  const heldClass = heldClassOf(result, content.heldReplies);
  return {
    reply: result.response.reply,
    held,
    ...(heldClass ? { heldClass } : {}),
    heldReason: held ? result.trace.screen.reason : null,
    conversationState: result.response.state,
    evidence: mapTestTurnEvidence({
      result,
      bundle: revision.bundle,
      channel: input.channel,
      moderatorMs: moderatorCalls > 0 ? moderatorMs : null,
    }),
    revision: {
      kind: revision.revision,
      snapshotId: revision.bundle.snapshotId,
      brainVersion: revision.bundle.brainVersion,
      contentHash: revision.bundle.contentHash,
      offerVersion: revision.bundle.offerVersion,
      draftId: revision.draftId,
      retrievalMode: revision.retrievalMode,
    },
    model: result.trace.model,
    latencyMs: result.trace.latencyMs,
    attempts: result.trace.attempts,
  };
}

async function loadTestTurnModelConfigs(): Promise<EnginePipelineInput["modelConfigs"]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("model_configs")
    .select("id, role, openrouter_model, params, active");
  if (error) throw new Error("MODEL_CONFIG_READ_FAILED");
  return (data ?? []).map((row) => ({
    id: row.id,
    role: row.role as "generator" | "moderator",
    openrouterModel: row.openrouter_model,
    params: (row.params ?? {}) as Record<string, unknown>,
    active: row.active,
  }));
}

async function selectTestTurnDrivers(modelConfigs: EnginePipelineInput["modelConfigs"]): Promise<SelectedDrivers> {
  return selectModelDrivers({
    loadActiveConfigurations: async () => activeModelConfigurations(modelConfigs),
    factories: {
      mockModel: createMockModelDriver,
      mockModerator: createMockModeratorDriver,
      realModel: (_configuration, apiKey) => createRealModelDriver(apiKey),
      realModerator: (configuration, apiKey) => createRealModeratorDriver(apiKey, configuration),
    },
  });
}

export function liveBrainTestTurnDependencies(): BrainTestTurnDependencies {
  return {
    loadRevision: (input) => loadRevisionRuntime(input),
    loadContent: loadApprovedPlatformAgentContent,
    loadModelConfigs: loadTestTurnModelConfigs,
    selectDrivers: selectTestTurnDrivers,
    tagSecret: () => environmentValue("SETTERFI_TAG_SECRET") ?? null,
  };
}
