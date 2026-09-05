/**
 * Receipt-backed inbound orchestration.
 *
 * Provider routes own signature verification and durable receipt insertion. This module starts only
 * after a receipt exists, keeps the expected tenant explicit across every service-role boundary,
 * and performs the state check before it asks a caller to assemble an engine prompt.
 */

import { decideBeforePrompt, type ConversationStateSnapshot } from "@/lib/conversation-state";
import { createHash } from "node:crypto";
import {
  engineBrainFromRuntimeBundle,
  engineOfferFromRuntimeBundle,
  runEngineTurn,
  type EnginePipelineDependencies,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import { activeModelConfigurations } from "@/lib/engine/model-config";
import {
  MODERATOR_CLASSES,
  type BrainSnapshot,
  type CoachOffer,
  type EngineTurnResult,
  type ModeratorClass,
  type PromptMessage,
  type RuntimeQualificationState,
} from "@/lib/engine/types";
import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { brainObjectionsLive, environmentValue, phase2Live } from "@/lib/env-contract";
import {
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "@/lib/integrations/openrouter";
import { createMockGhlDriver, createRealGhlDriver } from "@/lib/integrations/ghl";
import { selectCalendarDriver, selectGhlMessagingDriver, selectModelDrivers } from "@/lib/integrations/selector";
import { encryptCredential } from "@/lib/integrations/credential-envelope";
import type {
  ModelDriver,
  ModeratorDriver,
  NormalizedInboundBatch,
  NormalizedInboundEvent,
  NormalizedInboundMessage,
} from "@/lib/integrations/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  persistInboundIdentity,
  type PersistInboundIdentityInput,
  type PersistedInboundIdentity,
} from "@/lib/identity";
import { sharedRateLimit } from "@/lib/shared-rate-limit";
import { writeMessageTrace, type MessageTrace } from "@/lib/repositories/traces";
import {
  recordConversationStepEvents,
  type ConversationStepEvidenceInput,
  type ConversationStepEvidenceReceipt,
} from "@/lib/repositories/measurement-evidence";
import { loadPublishedRuntimeBundle } from "@/lib/repositories/brain-runtime";
import { loadLiveLegacyOfferEngineInput } from "@/lib/webhooks/offer-engine-input";
import {
  applyPinnedKeywordGoal,
  type PinnedKeywordGoal,
} from "@/lib/keyword-goals/runtime";
import { createLiveSendToLeadGateway } from "@/lib/repositories/conversations";
import { tenantSimulates } from "@/lib/sends/simulated-tenant";
import {
  createBookingService,
  isProposedSlotFresh,
  MAX_PROPOSED_SLOT_AGE_MS,
} from "@/lib/booking/service";
import type {
  BookingRepository,
  BookingResult,
  CalendarConnection,
  MessagingChannel as CadenceMessagingChannel,
  ProposedSlotSet,
} from "@/lib/booking/types";
import { createMockCalendarDriver, createRealCalendarDriver, createSimulatedCalendarDriver } from "@/lib/integrations/calendar";
import { resolveGhlLocationAccessToken } from "@/lib/integrations/ghl-oauth-store";
import {
  createComplianceEventEmitter,
  createBookingEventEmitter,
  createNotificationRepository,
  conversationTripwireEscalatedEvent,
  suppressionProviderUnconfirmedEvent,
} from "@/lib/notifications/events";
import {
  isPersistedInboundSafetyReplay,
  type InboundSafetyInput,
  type InboundSafetyPersistence,
} from "@/lib/engine/inbound-safety";
import { processSuppressionControl, createMockSuppressionProviderPort, type SuppressionControlResult } from "@/lib/suppression/service";
import { createLiveSuppressionProviderPort } from "@/lib/suppression/provider";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";
import { normalizeSuppressionIdentifier } from "@/lib/suppression/normalize";
import { claimFairGhlLifecycleReceiptIds } from "@/lib/jobs/fair-scan";
import { sendToLead } from "@/lib/sends/send-to-lead";
import type { SendToLeadResult } from "@/lib/sends/contracts";
import { createLiveTenantAccessPort, type TenantAccessPort } from "@/lib/billing/tenant-access";
import {
  cancelInboundCadence,
  reanchorInboundCadence,
} from "@/lib/followups/scheduler";
import { createLiveFollowupSchedulerRepository } from "@/lib/repositories/followups";
import { loadChannelCapabilityFeed } from "@/lib/sends/channel-capabilities";
import type { CadencePurposeOverride } from "@/lib/followups/materialize";

export type InboundProvider = "ghl" | "meta_direct";

const HISTORY_ROW_LIMIT = 40;
const HISTORY_TURN_LIMIT = 20;
const INBOUND_LEASE_SECONDS = 300;
const INBOUND_MAX_ATTEMPTS = 8;

const EMPTY_QUALIFICATION_STATE: RuntimeQualificationState = {
  credit: null,
  goal: null,
  timeline: null,
  businessStage: null,
  annualRevenueCents: null,
  outcome: null,
  dqReason: null,
};

export function suppressionIdForIdentity(
  identity: { channel: Parameters<typeof normalizeSuppressionIdentifier>[0]; normalizedIdentifier: string },
  suppressions: readonly { id: string; channel: string; identifier_hash: string }[],
  hash: (identifier: string) => string = hashSuppressionIdentifier,
) {
  const normalized = normalizeSuppressionIdentifier(identity.channel, identity.normalizedIdentifier);
  if (!normalized) return null;
  const identifierHash = hash(normalized);
  return suppressions.find((row) =>
    row.channel === identity.channel && row.identifier_hash === identifierHash
  )?.id ?? null;
}

export type ApprovedPlatformAgentContent = {
  approved: boolean;
  automatedExperienceDisclosure: string;
  heldReplies: Record<ModeratorClass, string>;
  platformFrame: string;
  mission: string;
  qualification: string;
  roleBoundary: string;
};

/** Production requires approval; demo tenants may use only explicitly DRAFT-labelled seed copy. */
export function approvedPlatformAgentContent(
  value: unknown,
  options: { allowDraft?: boolean } = {},
): ApprovedPlatformAgentContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED");
  }
  const row = value as Record<string, unknown>;
  const held = row.heldReplies;
  if (
    (row.approved !== true && row.approved !== false) ||
    typeof row.automatedExperienceDisclosure !== "string" ||
    !row.automatedExperienceDisclosure.trim() ||
    typeof row.platformFrame !== "string" || !row.platformFrame.trim() ||
    typeof row.mission !== "string" || !row.mission.trim() ||
    typeof row.qualification !== "string" || !row.qualification.trim() ||
    typeof row.roleBoundary !== "string" || !row.roleBoundary.trim() ||
    !held ||
    typeof held !== "object" ||
    Array.isArray(held)
  ) {
    throw new Error("APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED");
  }
  const replies = held as Record<string, unknown>;
  if (MODERATOR_CLASSES.some((key) => typeof replies[key] !== "string" || !replies[key].trim())) {
    throw new Error("APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED");
  }
  const strings = [
    row.automatedExperienceDisclosure,
    row.platformFrame,
    row.mission,
    row.qualification,
    row.roleBoundary,
    ...MODERATOR_CLASSES.map((key) => replies[key]),
  ] as string[];
  if (row.approved !== true) {
    if (!options.allowDraft || strings.some((text) => !text.trim().startsWith("[DRAFT]"))) {
      throw new Error("APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED");
    }
  }
  return {
    approved: row.approved,
    automatedExperienceDisclosure: row.automatedExperienceDisclosure.trim(),
    platformFrame: row.platformFrame.trim(),
    mission: row.mission.trim(),
    qualification: row.qualification.trim(),
    roleBoundary: row.roleBoundary.trim(),
    heldReplies: Object.fromEntries(
      MODERATOR_CLASSES.map((key) => [key, (replies[key] as string).trim()]),
    ) as Record<ModeratorClass, string>,
  };
}

export async function loadApprovedPlatformAgentContent(tenantId: string) {
  const client = createSupabaseServiceClient();
  const [settingsResult, tenantResult] = await Promise.all([
    client
      .from("platform_settings")
      .select("agent_content, approved")
      .eq("singleton", true)
      .maybeSingle(),
    client.from("tenants").select("is_demo").eq("id", tenantId).single(),
  ]);
  if (settingsResult.error || !settingsResult.data) {
    throw new Error("APPROVED_PLATFORM_AGENT_CONTENT_REQUIRED");
  }
  if (tenantResult.error || !tenantResult.data) throw new Error("TENANT_CONTENT_SCOPE_REQUIRED");
  if (!settingsResult.data.approved && !tenantResult.data.is_demo) {
    throw new Error("PLATFORM_AGENT_CONTENT_UNAPPROVED_NON_DEMO");
  }
  return approvedPlatformAgentContent(
    { ...settingsResult.data.agent_content, approved: settingsResult.data.approved },
    { allowDraft: tenantResult.data.is_demo },
  );
}

type LegacyPreviewRuntime = { brain: BrainSnapshot; offer: CoachOffer };
type SelectedPreviewDrivers = { model: ModelDriver; moderator: ModeratorDriver };

export type LivePreviewHistoryEntry = Pick<PromptMessage, "role" | "content"> & {
  role: "user" | "assistant";
};

/**
 * Provider retries and rapid double-texts can leave consecutive rows with the same speaker. The
 * prompt contract is deliberately stricter: preserve all text, merge adjacent rows by speaker,
 * and retain only the newest bounded alternating tail.
 */
export function canonicalConversationHistory(
  rows: readonly LivePreviewHistoryEntry[],
  limit = HISTORY_TURN_LIMIT,
): LivePreviewHistoryEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > HISTORY_ROW_LIMIT) {
    throw new Error("INBOUND_HISTORY_LIMIT_INVALID");
  }
  const merged: LivePreviewHistoryEntry[] = [];
  for (const row of rows) {
    if ((row.role !== "user" && row.role !== "assistant") || !row.content.trim()) {
      throw new Error("INBOUND_HISTORY_ROW_INVALID");
    }
    const content = row.content.trim();
    const previous = merged.at(-1);
    if (previous?.role === row.role) {
      merged[merged.length - 1] = { role: row.role, content: `${previous.content}\n${content}` };
    } else {
      merged.push({ role: row.role, content });
    }
  }
  return merged.slice(-limit);
}

function historyWithCurrentLead(
  history: readonly LivePreviewHistoryEntry[],
  message: string,
): LivePreviewHistoryEntry[] {
  return canonicalConversationHistory([
    ...history,
    { role: "user", content: message },
  ]);
}

export type LivePreviewDependencies = {
  phase2Enabled(): boolean;
  loadContent(tenantId: string): Promise<ApprovedPlatformAgentContent>;
  loadRuntimeBundle(tenantId: string): Promise<PublishedRuntimeBundle>;
  loadLegacyRuntime(
    tenantId: string,
    content: ApprovedPlatformAgentContent,
  ): Promise<LegacyPreviewRuntime>;
  loadModelConfigs(): Promise<EnginePipelineInput["modelConfigs"]>;
  selectDrivers(
    configs: EnginePipelineInput["modelConfigs"],
  ): Promise<SelectedPreviewDrivers>;
  tagSecret(): string | null;
  retrieve?: EnginePipelineDependencies["retrieve"];
  persistInboundSafety?: InboundSafetyPersistence;
};

async function loadLegacyPreviewRuntime(
  tenantId: string,
  content: ApprovedPlatformAgentContent,
): Promise<LegacyPreviewRuntime> {
  const client = createSupabaseServiceClient();
  const [offer, entriesResult] = await Promise.all([
    loadLiveLegacyOfferEngineInput(tenantId),
    client
      .from("brain_knowledge_entries")
      .select("id, category, question, answer, status, version")
      .eq("status", "published"),
  ]);
  if (entriesResult.error) throw new Error("PUBLISHED_BRAIN_READ_FAILED");
  const brainVersion = Math.max(1, ...(entriesResult.data ?? []).map((row) => Number(row.version) || 1));
  return {
    brain: {
      version: brainVersion,
      platformFrame: content.platformFrame,
      mission: content.mission,
      qualification: content.qualification,
      complianceRules: [],
      entries: (entriesResult.data ?? []).map((row) => ({
        id: row.id,
        category: row.category,
        question: row.question,
        answer: row.answer,
        published: row.status === "published",
      })),
      knowledgeMode: "inline",
    },
    offer,
  };
}

async function loadPreviewModelConfigs(): Promise<EnginePipelineInput["modelConfigs"]> {
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

async function selectPreviewDrivers(
  modelConfigs: EnginePipelineInput["modelConfigs"],
): Promise<SelectedPreviewDrivers> {
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

function livePreviewDependencies(): LivePreviewDependencies {
  return {
    phase2Enabled: () => phase2Live(),
    loadContent: loadApprovedPlatformAgentContent,
    loadRuntimeBundle: loadPublishedRuntimeBundle,
    loadLegacyRuntime: loadLegacyPreviewRuntime,
    loadModelConfigs: loadPreviewModelConfigs,
    selectDrivers: selectPreviewDrivers,
    tagSecret: () => environmentValue("SETTERFI_TAG_SECRET") ?? null,
  };
}

function publishedLinkWhitelist(bundle: PublishedRuntimeBundle) {
  const urls = [
    bundle.renderSources.bookingUrl,
    ...Object.values(bundle.renderSources.assetUrlsBySlug),
  ];
  return [...new Set(urls.flatMap((value) => {
    if (!value) return [];
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  }))];
}

/** Runs the real Phase 1 engine for platform/public previews without returning internal trace data to leads. */
export async function runLivePreviewTurn(input: {
  tenantId: string;
  message: string;
  history?: readonly (string | LivePreviewHistoryEntry)[];
  mode: "production" | "test";
  channel?: "sms" | "instagram" | "messenger" | "whatsapp";
  leadMessageId?: string;
  conversation?: {
    state: "agent";
    currentStep: string | null;
    currentStepAsks: number;
    disclosurePending: boolean;
  };
  inboundSafety?: InboundSafetyInput;
  persistInboundSafety?: InboundSafetyPersistence;
  qualificationState?: RuntimeQualificationState;
  bookingSelection?: EnginePipelineInput["bookingSelection"];
}, dependencies: LivePreviewDependencies = livePreviewDependencies()) {
  const phase2 = dependencies.phase2Enabled();
  const content = await dependencies.loadContent(input.tenantId);
  const [runtime, modelConfigs] = await Promise.all([
    phase2
      ? dependencies.loadRuntimeBundle(input.tenantId)
      : dependencies.loadLegacyRuntime(input.tenantId, content),
    dependencies.loadModelConfigs(),
  ]);
  const selected = await dependencies.selectDrivers(modelConfigs);
  const runtimeBundle = phase2 ? runtime as PublishedRuntimeBundle : undefined;
  const legacy = phase2 ? undefined : runtime as LegacyPreviewRuntime;
  const brain = runtimeBundle ? engineBrainFromRuntimeBundle(runtimeBundle) : legacy!.brain;
  const offer = runtimeBundle ? engineOfferFromRuntimeBundle(runtimeBundle) : legacy!.offer;
  const tagSecret = dependencies.tagSecret();
  if (!tagSecret) throw new Error("SETTERFI_TAG_SECRET_REQUIRED");
  return runEngineTurn({
    mode: input.mode,
    channel: input.channel ?? "sms",
    brain,
    offer,
    conversation: input.conversation ?? { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
    // The engine's prompt is [system, ...history] — the current inbound message reaches the
    // model only if it is the final user entry here. Without it the model answers a
    // conversation that ends with its own last reply and returns an empty completion.
    history: historyWithCurrentLead(
      (input.history ?? []).map((entry) => typeof entry === "string"
        ? { role: "user" as const, content: entry }
        : entry),
      input.message,
    ),
    leadMessage: { id: input.leadMessageId ?? "preview", body: input.message },
    tagSecret,
    automatedExperienceDisclosure: content.automatedExperienceDisclosure,
    heldReplies: content.heldReplies,
    linkWhitelist: runtimeBundle ? publishedLinkWhitelist(runtimeBundle) : [],
    roleBoundary: content.roleBoundary,
    modelConfigs,
    currentQuestion: null,
    extractionCandidate: null,
    qualificationState: input.qualificationState ?? EMPTY_QUALIFICATION_STATE,
    ...(input.bookingSelection ? { bookingSelection: input.bookingSelection } : {}),
    ...(input.inboundSafety ? { inboundSafety: input.inboundSafety } : {}),
    ...(runtimeBundle ? { runtimeBundle } : {}),
  }, {
    model: selected.model,
    moderator: selected.moderator,
    ...(dependencies.retrieve ? { retrieve: dependencies.retrieve } : {}),
    ...(input.persistInboundSafety ?? dependencies.persistInboundSafety
      ? { persistInboundSafety: input.persistInboundSafety ?? dependencies.persistInboundSafety }
      : {}),
  });
}

/**
 * Exported for the unit assertions on the objection mapping below; nothing else calls it from
 * outside this module. The flag arrives as a parameter so the tests never mutate `process.env`.
 */
export function traceForPersistence(
  result: EngineTurnResult,
  objectionsEnabled: () => boolean = brainObjectionsLive,
): MessageTrace {
  const outcome = result.trace.screen.verdict === "held"
    ? "held"
    : result.trace.moderator === "unavailable"
      ? "moderator_unavailable"
      : result.trace.attempts > 1
        ? "regenerated"
        : "successful";
  const matched = result.trace.objection;
  // `handlingOutcome` is the objection's handling label; `outcome` above is the turn's own
  // outcome, and they are not the same fact. A hard-gated objection is `held_safely` however the
  // turn ended, because the engine no longer lets a model compose that reply — the published
  // response is sent as written, so a gated turn is routinely `successful`. "Hard-gated but
  // answered" is therefore not a state the system can reach, rather than one it declines to
  // record, which is what the two database mechanisms behind this have always asserted.
  const objection = !matched || !objectionsEnabled()
    ? null
    : {
        snapshotId: matched.snapshotId,
        objectionId: matched.objectionId,
        hardGate: matched.hardGate,
        handlingOutcome: matched.hardGate || outcome === "held"
          ? ("held_safely" as const)
          : ("answered" as const),
      };
  return {
    outcome,
    objection,
    brainVersion: result.trace.brainVersion,
    offerVersion: result.trace.offerVersion,
    brainContentHash: result.trace.brainContentHash,
    offerContentHash: result.trace.offerContentHash,
    promptHash: result.trace.promptHash ?? "",
    ruleFired: result.trace.ruleFired,
    retrievedEntryIds: result.trace.sources.map((source) => source.entryId),
    retrievalCandidates: result.trace.sources.map((source) => ({
      entryId: source.entryId,
      similarity: source.similarity,
      categoryBoost: source.categoryBoost,
      score: source.score,
      categoryAgreement: source.categoryAgreement,
    })),
    declaredEntryId: result.trace.declaredEntryId,
    citationVerified: result.trace.declaredEntryVerified,
    droppedEntryIds: [...result.trace.droppedEntryIds],
    numberSources: result.trace.numberAllowlist as unknown as Array<Record<string, unknown>>,
    checks: result.trace.checks as unknown as Array<Record<string, unknown>>,
    violations: result.trace.violations as unknown as Array<Record<string, unknown>>,
    rejectedDrafts: [...result.trace.rejectedDrafts],
    model: result.trace.model,
    params: result.trace.paramsHash ? { hash: result.trace.paramsHash } : null,
    latencyMs: result.trace.latencyMs,
    usage: result.trace.usage,
    cost: result.trace.cost,
    moderatorState: result.trace.moderator === "not_run" ? null : result.trace.moderator,
    moderatorReason: result.trace.moderatorReason,
    moderatorClass: result.trace.moderatorClass,
    moderatorRuleId: result.trace.moderatorRuleId,
    moderatorModelConfigId: result.trace.moderatorModelConfigId,
  };
}

export type InboundPersistenceReceipt = ConversationStepEvidenceReceipt;

type OrdinaryInboundPersistenceDependencies = {
  readOutboundMessage(input: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
  }): Promise<{ messageId: string }>;
  consumeDisclosure(input: { tenantId: string; conversationId: string }): Promise<void>;
  writeTrace(
    tenantId: string,
    target: { kind: "existing_message"; conversationId: string; messageId: string },
    trace: MessageTrace,
  ): Promise<{ messageId: string; tenantId: string }>;
  recordStepEvents(input: ConversationStepEvidenceInput): Promise<ConversationStepEvidenceReceipt>;
};

type HeldInboundPersistenceDependencies = {
  readOutboundMessage(input: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
  }): Promise<{ messageId: string }>;
  transition(input: {
    tenantId: string;
    conversationId: string;
    messageId: string;
    reason: "output_check_failed" | "no_match_threshold";
  }): Promise<void>;
  writeTrace: OrdinaryInboundPersistenceDependencies["writeTrace"];
};

export async function persistHeldInboundResult(
  input: {
    tenantId: string;
    conversationId: string;
    providerMessageId: string;
    reason: "output_check_failed" | "no_match_threshold";
    result: EngineTurnResult;
  },
  dependencies: HeldInboundPersistenceDependencies,
) {
  const message = await dependencies.readOutboundMessage(input);
  await dependencies.transition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: message.messageId,
    reason: input.reason,
  });
  await dependencies.writeTrace(input.tenantId, {
    kind: "existing_message",
    conversationId: input.conversationId,
    messageId: message.messageId,
  }, traceForPersistence(input.result));
  return message;
}

export function stepEvidenceKeys(
  result: EngineTurnResult,
  preTurnCurrentStep: string | null,
) {
  if (result.commands.some((command) => command.kind === "transition")) {
    return { answeredStepKey: null, askedStepKey: null };
  }
  const answered = result.commands.find(
    (command) => command.kind === "advance_step" && command.valuePersisted,
  );
  const reasked = result.commands.find((command) => command.kind === "increment_step_asks");
  return {
    answeredStepKey: answered?.kind === "advance_step" ? answered.stepId : null,
    askedStepKey: reasked?.kind === "increment_step_asks"
      ? reasked.stepId
      : preTurnCurrentStep,
  };
}

/** Step evidence is deliberately the second statement after outbound and trace read-back. */
export async function persistOrdinaryInboundResult(
  input: {
    tenantId: string;
    conversationId: string;
    leadMessageId: string;
    providerMessageId: string;
    preTurnCurrentStep: string | null;
    result: EngineTurnResult;
  },
  dependencies: OrdinaryInboundPersistenceDependencies,
): Promise<InboundPersistenceReceipt> {
  const persist = input.result.commands.find((command) => command.kind === "persist_agent_turn");
  if (!persist) throw new Error("ENGINE_PERSIST_COMMAND_REQUIRED");
  const message = await dependencies.readOutboundMessage({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    providerMessageId: input.providerMessageId,
  });
  if (persist.disclosureConsumed) {
    await dependencies.consumeDisclosure({
      tenantId: input.tenantId,
      conversationId: input.conversationId,
    });
  }
  await dependencies.writeTrace(input.tenantId, {
    kind: "existing_message",
    conversationId: input.conversationId,
    messageId: message.messageId,
  }, traceForPersistence(input.result));
  const keys = stepEvidenceKeys(input.result, input.preTurnCurrentStep);
  return dependencies.recordStepEvents({
    expectedTenant: input.tenantId,
    conversationId: input.conversationId,
    leadMessageId: input.leadMessageId,
    agentMessageId: message.messageId,
    ...keys,
  });
}

export type ReconciledGhlInstall = {
  companyId: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
};

export function sealGhlInstallCredentials(
  install: ReconciledGhlInstall,
  encrypt: typeof encryptCredential = encryptCredential,
) {
  return {
    metadata: {
      company_id: install.companyId,
      token_expires_at: install.tokenExpiresAt,
      install_state: "installed",
      last_error: null,
    },
    secrets: {
      access_credential_envelope: encrypt(install.accessToken),
      refresh_credential_envelope: encrypt(install.refreshToken),
    },
  };
}

/**
 * Which tenant a reconciled INSTALL receipt belongs to, decided before anything is written.
 *
 * The tenant is the whole point of the row. `webhooks/ghl/route.ts` resolves an inbound message's
 * tenant from `ghl_installs.tenant_id` and `repositories/conversations.ts` resolves an outbound one
 * from the same column, so a reconcile that cannot name the tenant must refuse rather than store a
 * connection nothing can route in either direction. Refusing costs nothing: the caller marks the
 * receipt `failed`, and the worker's own read includes `failed`, so a tenant bound later still gets
 * reconciled on the next pass. And an approval does not get to move a location that already belongs
 * to another client, for the same reason `persistGhlSubAccountInstall` will not.
 */
export function resolveReconciledInstallTenant(input: {
  receiptTenantId: string | null | undefined;
  existingTenantId: string | null | undefined;
}): string {
  const blankToNull = (value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : null;
  };
  const receiptTenantId = blankToNull(input.receiptTenantId);
  const existingTenantId = blankToNull(input.existingTenantId);
  if (receiptTenantId && existingTenantId && receiptTenantId !== existingTenantId) {
    throw new Error("GHL_INSTALL_LOCATION_BOUND_ELSEWHERE");
  }
  const resolved = receiptTenantId ?? existingTenantId;
  if (!resolved) throw new Error("GHL_INSTALL_TENANT_UNRESOLVED");
  return resolved;
}

const INSTALL_RECONCILE_REFUSALS = new Set([
  "GHL_INSTALL_TENANT_UNRESOLVED",
  "GHL_INSTALL_LOCATION_BOUND_ELSEWHERE",
]);

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export async function markGhlUninstalled(
  locationId: string,
  client: ServiceClient = createSupabaseServiceClient(),
) {
  const { error } = await client.rpc("mark_ghl_uninstalled_atomic", {
    p_location_id: locationId,
  });
  if (error) throw new Error(`GHL_UNINSTALL_ATOMIC_WRITE_FAILED:${error.message}`);
}

function lifecycleLocation(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const normalized = (payload as { normalized?: unknown }).normalized;
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return null;
  const locationId = (normalized as { locationId?: unknown }).locationId;
  return typeof locationId === "string" && locationId.trim() ? locationId.trim() : null;
}

async function setLifecycleReceiptStatus(
  client: ServiceClient,
  receiptId: string,
  status: "processed" | "failed",
  error: string | null,
) {
  const { error: updateError } = await client.from("webhook_events").update({
    status,
    error,
    processed_at: status === "processed" ? new Date().toISOString() : null,
  }).eq("id", receiptId);
  if (updateError) throw new Error(`GHL_LIFECYCLE_STATUS_WRITE_FAILED:${updateError.message}`);
}

export async function processGhlUninstallReceipt(
  receipt: WebhookReceiptRead,
  client: ServiceClient = createSupabaseServiceClient(),
) {
  const locationId = lifecycleLocation(receipt.payload);
  if (receipt.eventType !== "UNINSTALL" || !locationId) {
    await setLifecycleReceiptStatus(client, receipt.id, "failed", "UNINSTALL_RECEIPT_INVALID");
    throw new Error("UNINSTALL_RECEIPT_INVALID");
  }
  try {
    await markGhlUninstalled(locationId, client);
    await setLifecycleReceiptStatus(client, receipt.id, "processed", null);
  } catch (error) {
    try {
      await setLifecycleReceiptStatus(client, receipt.id, "failed", "UNINSTALL_RECONCILE_FAILED");
    } catch {
      // Preserve the operation failure; the row remains received and is still selected next run.
    }
    throw error;
  }
}

/** Bounded lifecycle recovery writes INSTALL custody and durably retires UNINSTALL custody. */
export async function reconcileGhlInstallReceipts(limit: number) {
  const client = createSupabaseServiceClient();
  const receiptIds = await claimFairGhlLifecycleReceiptIds(client, limit);
  if (receiptIds.length === 0) return { checked: 0, processed: 0, failed: 0 };
  const { data, error } = await client
    .from("webhook_events")
    .select("id, tenant_id, event_type, payload")
    .eq("provider", "ghl")
    .in("event_type", ["INSTALL", "UNINSTALL"])
    .in("status", ["received", "failed"])
    .in("id", receiptIds);
  if (error) throw new Error(`GHL_RECONCILE_READ_FAILED:${error.message}`);
  const order = new Map(receiptIds.map((receiptId, index) => [receiptId, index]));
  const selected = [...(data ?? [])].sort((left, right) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
    (order.get(right.id) ?? Number.MAX_SAFE_INTEGER));
  let driver: ReturnType<typeof selectGhlMessagingDriver> | null = null;
  let processed = 0;
  let failed = 0;
  for (const row of selected) {
    if (row.event_type === "UNINSTALL") {
      const locationId = lifecycleLocation(row.payload);
      if (!locationId) {
        failed += 1;
        await setLifecycleReceiptStatus(client, row.id, "failed", "UNINSTALL_RECEIPT_INVALID");
        continue;
      }
      try {
        await markGhlUninstalled(locationId, client);
        await setLifecycleReceiptStatus(client, row.id, "processed", null);
        processed += 1;
      } catch {
        failed += 1;
        await setLifecycleReceiptStatus(client, row.id, "failed", "UNINSTALL_RECONCILE_FAILED");
      }
      continue;
    }
    const payload = row.payload as { normalized?: { eventId?: unknown; locationId?: unknown } };
    const eventId = payload.normalized?.eventId;
    const locationId = payload.normalized?.locationId;
    if (typeof eventId !== "string" || typeof locationId !== "string") {
      failed += 1;
      await setLifecycleReceiptStatus(client, row.id, "failed", "INSTALL_RECEIPT_INVALID");
      continue;
    }
    try {
      driver ??= selectGhlMessagingDriver({
        factories: { mock: createMockGhlDriver, real: createRealGhlDriver },
      });
      const install = await driver.reconcileInstall({ eventId, locationId });
      const sealed = sealGhlInstallCredentials(install);
      const { data: existing, error: existingError } = await client
        .from("ghl_installs")
        .select("id, tenant_id")
        .eq("location_id", locationId)
        .maybeSingle();
      if (existingError) throw new Error("INSTALL_TENANT_LOOKUP_FAILED");
      const tenantId = resolveReconciledInstallTenant({
        receiptTenantId: row.tenant_id,
        existingTenantId: existing?.tenant_id,
      });
      const { error: writeError } = await client.rpc("persist_ghl_install_credentials_atomic", {
        p_expected_tenant: tenantId,
        p_location_id: locationId,
        p_company_id: sealed.metadata.company_id,
        p_token_expires_at: sealed.metadata.token_expires_at,
        p_access_credential_envelope: sealed.secrets.access_credential_envelope,
        p_refresh_credential_envelope: sealed.secrets.refresh_credential_envelope,
      });
      if (writeError) throw new Error("INSTALL_ATOMIC_WRITE_FAILED");
      await setLifecycleReceiptStatus(client, row.id, "processed", null);
      processed += 1;
    } catch (error) {
      failed += 1;
      // A refusal names itself in the receipt, so an operator reading `webhook_events` can tell an
      // unresolved tenant apart from a provider failure without opening this file. `failed` is what
      // makes the receipt retryable, which is what a deferred tenant binding depends on.
      const message = error instanceof Error ? error.message : "";
      await setLifecycleReceiptStatus(
        client,
        row.id,
        "failed",
        INSTALL_RECONCILE_REFUSALS.has(message) ? message : "INSTALL_RECONCILE_FAILED",
      );
    }
  }
  return { checked: selected.length, processed, failed };
}

export type DurableInboundReceipt = {
  id: string;
  leaseToken: string;
  attemptNumber: number;
  tenantId: string;
  provider: InboundProvider;
  batch: NormalizedInboundBatch;
};

export type CanonicalInboundEngineInput = {
  tenantId: string;
  channel: NormalizedInboundMessage["identity"]["channel"];
  body: string;
  leadMessageId: string;
  contactId: string;
  conversationId: string;
  conversationState: "agent";
  currentStep: string | null;
  currentStepAsks: number;
  disclosurePending: boolean;
  history: readonly LivePreviewHistoryEntry[];
  inboundSafety: InboundSafetyInput;
  qualificationState: RuntimeQualificationState;
};

export type InboundConversationSnapshot = ConversationStateSnapshot & {
  currentStep?: string | null;
  disclosurePending?: boolean;
};

export type DurableInboundEngineTurn = {
  result: EngineTurnResult;
  preTurnCurrentStep: string | null;
  preTurnCurrentStepAsks: number;
  delivered: boolean;
  persisted: boolean;
};

function durableInboundEngineTurn(value: unknown): DurableInboundEngineTurn {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INBOUND_ENGINE_TURN_INVALID");
  }
  const row = value as Record<string, unknown>;
  const result = row.result_payload;
  const asks = row.pre_turn_current_step_asks;
  const step = row.pre_turn_current_step;
  if (!result || typeof result !== "object" || Array.isArray(result) ||
    !Array.isArray((result as { commands?: unknown }).commands) ||
    !(result as { response?: unknown }).response ||
    typeof (result as { response?: unknown }).response !== "object" ||
    !(result as { trace?: unknown }).trace || typeof (result as { trace?: unknown }).trace !== "object" ||
    (step !== null && typeof step !== "string") ||
    !Number.isInteger(asks) || Number(asks) < 0 || Number(asks) > 3) {
    throw new Error("INBOUND_ENGINE_TURN_INVALID");
  }
  const parsed = result as EngineTurnResult;
  // This also rejects a corrupted snapshot containing multiple sends before it can reach a gateway.
  outboundBody(parsed);
  return {
    result: parsed,
    preTurnCurrentStep: step as string | null,
    preTurnCurrentStepAsks: Number(asks),
    delivered: row.delivery_persisted === true,
    persisted: row.result_persisted === true,
  };
}

export function qualificationTurnRpcInput(input: {
  tenantId: string;
  conversationId: string;
  contactId: string;
  inboundMessageId: string;
  expectedCurrentStep: string | null;
  expectedCurrentStepAsks: number;
  result: EngineTurnResult;
}) {
  const persistedCommands = input.result.commands.filter(
    (command) => command.kind === "persist_qualification",
  );
  const advancedCommands = input.result.commands.filter((command) => command.kind === "advance_step");
  const incrementedCommands = input.result.commands.filter(
    (command) => command.kind === "increment_step_asks",
  );
  const hardDqCommands = input.result.commands.filter((command) => command.kind === "record_hard_dq");
  const outcomeCommands = input.result.commands.filter(
    (command) => command.kind === "record_qualification_outcome",
  );
  if ([persistedCommands, advancedCommands, incrementedCommands, hardDqCommands, outcomeCommands]
      .some((commands) => commands.length > 1) ||
    (advancedCommands.length > 0 && incrementedCommands.length > 0) ||
    (hardDqCommands.length > 0 && outcomeCommands.length > 0)) {
    throw new Error("QUALIFICATION_COMMAND_AMBIGUOUS");
  }
  const persisted = persistedCommands[0];
  const advanced = advancedCommands[0];
  const incremented = incrementedCommands[0];
  const hardDq = hardDqCommands[0];
  const outcome = outcomeCommands[0];
  if (!persisted && !advanced && !incremented && !hardDq && !outcome) return null;
  if (persisted && !advanced ||
    persisted && advanced && persisted.stepId !== advanced.stepId ||
    incremented && persisted) {
    throw new Error("QUALIFICATION_COMMAND_SHAPE_INVALID");
  }
  const stepId = advanced?.stepId ?? incremented?.stepId ?? persisted?.stepId ?? null;
  const nextStepId = advanced
    ? advanced.nextStepId ?? null
    : incremented
      ? incremented.stepId
      : null;
  const nextStepAsks = advanced?.nextAskCount ?? incremented?.nextAskCount ?? 0;
  const qualificationOutcome = hardDq ? "HARD_DQ" : outcome?.outcome ?? null;
  const ruleId = hardDq
    ? hardDq.reason.replace(/^published_qualification_rule:/u, "")
    : outcome?.ruleId ?? null;
  const dqReason = hardDq?.reason ?? (outcome?.outcome === "SOFT_DQ"
    ? `published_qualification_rule:${outcome.ruleId}`
    : null);
  return {
    p_expected_tenant: input.tenantId,
    p_conversation_id: input.conversationId,
    p_contact_id: input.contactId,
    p_inbound_message_id: input.inboundMessageId,
    p_expected_current_step: input.expectedCurrentStep,
    p_expected_current_step_asks: input.expectedCurrentStepAsks,
    p_step_id: stepId,
    p_next_step_id: nextStepId,
    p_next_step_asks: nextStepAsks,
    p_field: persisted?.value.field ?? null,
    p_value: persisted?.value.value ?? null,
    p_outcome: qualificationOutcome,
    p_dq_reason: dqReason,
    p_rule_id: ruleId,
  };
}

export type InboundProcessDependencies = {
  tenantAccess: TenantAccessPort;
  persistInbound(
    tenantId: string,
    input: PersistInboundIdentityInput,
  ): Promise<PersistedInboundIdentity>;
  loadConversation(tenantId: string, conversationId: string): Promise<InboundConversationSnapshot>;
  loadHistory(input: {
    tenantId: string;
    conversationId: string;
    inboundMessageId: string;
    limit: number;
  }): Promise<readonly LivePreviewHistoryEntry[]>;
  loadQualificationState(tenantId: string, contactId: string): Promise<RuntimeQualificationState>;
  loadPinnedKeywordGoal?(tenantId: string, conversationId: string): Promise<PinnedKeywordGoal | null>;
  loadEngineTurn(input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
  }): Promise<DurableInboundEngineTurn | null>;
  recordEngineTurn(input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
    preTurnCurrentStep: string | null;
    preTurnCurrentStepAsks: number;
    result: EngineTurnResult;
  }): Promise<DurableInboundEngineTurn>;
  markEngineTurnDelivered(input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
    outboundMessageId: string;
  }): Promise<void>;
  completeEngineTurn(input: {
    tenantId: string;
    conversationId: string;
    contactId: string;
    inboundMessageId: string;
    outboundMessageId: string;
  }): Promise<void>;
  resumeConversation(input: {
    tenantId: string;
    conversationId: string;
    from: "nurture" | "closed";
  }): Promise<InboundConversationSnapshot>;
  consumeRateLimit(input: {
    tenantId: string;
    conversationId: string;
  }): Promise<{ allowed: boolean; reason: string | null }>;
  processSuppression(input: {
    tenantId: string;
    event: NormalizedInboundMessage;
    inbound: PersistedInboundIdentity;
  }): Promise<SuppressionControlResult>;
  cancelCadence(input: {
    tenantId: string;
    contactId: string;
    inboundMessageId: string;
  }): Promise<void>;
  reanchorCadence(input: {
    tenantId: string;
    event: NormalizedInboundMessage;
    inbound: PersistedInboundIdentity;
  }): Promise<void>;
  loadInboundSafety(input: {
    tenantId: string;
    event: NormalizedInboundMessage;
    inbound: PersistedInboundIdentity;
  }): Promise<InboundSafetyInput>;
  loadContactIsTest(tenantId: string, contactId: string): Promise<boolean>;
  persistInboundSafety: InboundSafetyPersistence;
  runEngine(input: CanonicalInboundEngineInput): Promise<EngineTurnResult>;
  sendToLead(input: Parameters<typeof sendToLead>[0]): Promise<SendToLeadResult>;
  persistResult(input: {
    tenantId: string;
    event: NormalizedInboundMessage;
    inbound: PersistedInboundIdentity;
    result: EngineTurnResult;
    providerMessageId: string;
    preTurnCurrentStep: string | null;
    preTurnCurrentStepAsks: number;
  }): Promise<void | InboundPersistenceReceipt>;
  markReceipt(input: {
    receiptId: string;
    tenantId: string;
    status: "processed" | "skipped" | "failed";
    error: string | null;
  }): Promise<void>;
};

function assertTenant(expectedTenant: string, actualTenant: string, boundary: string) {
  if (!expectedTenant.trim() || actualTenant !== expectedTenant) {
    throw new Error(`INBOUND_TENANT_MISMATCH:${boundary}`);
  }
}

function outboundBody(result: EngineTurnResult) {
  const sends = result.commands.filter((command) => command.kind === "send");
  if (sends.length > 1) throw new Error("ENGINE_SEND_COMMAND_AMBIGUOUS");
  return sends[0]?.body ?? null;
}

export function canonicalInboundEngineInput(
  tenantId: string,
  event: NormalizedInboundMessage,
  inbound: PersistedInboundIdentity,
  conversation: InboundConversationSnapshot,
  history: readonly LivePreviewHistoryEntry[],
  inboundSafety: InboundSafetyInput,
  qualificationState: RuntimeQualificationState = EMPTY_QUALIFICATION_STATE,
): CanonicalInboundEngineInput {
  if (conversation.status !== "agent") throw new Error("INBOUND_CONVERSATION_NOT_AGENT");
  return {
    tenantId,
    channel: event.identity.channel,
    body: event.body,
    leadMessageId: inbound.messageId,
    contactId: inbound.contactId,
    conversationId: inbound.conversationId,
    conversationState: conversation.status,
    currentStep: conversation.currentStep ?? null,
    currentStepAsks: conversation.currentStepAsks,
    disclosurePending: conversation.disclosurePending ?? inbound.disclosurePending,
    history: canonicalConversationHistory(history),
    inboundSafety,
    qualificationState,
  };
}

type ProcessedInboundEvent =
  | { kind: "ignored" | "status"; eventId: string }
  | { kind: "control"; eventId: string; control: SuppressionControlResult; inbound: PersistedInboundIdentity }
  | {
      kind: "held";
      eventId: string;
      status: ConversationStateSnapshot["status"];
      inbound: PersistedInboundIdentity;
    }
  | {
      kind: "no_send" | "sent";
      eventId: string;
      result: EngineTurnResult;
      inbound: PersistedInboundIdentity;
    }
  | {
      kind: "refused";
      eventId: string;
      reason: string;
      result: EngineTurnResult;
      inbound: PersistedInboundIdentity;
    };

async function processNormalizedMessage(
  tenantId: string,
  event: NormalizedInboundMessage,
  dependencies: InboundProcessDependencies,
  originReceipt: { receiptId: string; leaseToken: string; attemptNumber: number },
): Promise<ProcessedInboundEvent> {
  if (!dependencies.tenantAccess?.assertInboundAllowed) {
    throw new Error("PHASE6_TENANT_ACCESS_PORT_MISSING");
  }
  await dependencies.tenantAccess.assertInboundAllowed({ tenantId, identity: event.identity });
  const inbound = await dependencies.persistInbound(tenantId, {
    identity: event.identity,
    providerAccountId: event.identity.provider === "ghl" ? event.externalAccountId : null,
    providerWindow: event.providerWindow,
    providerMessageId: event.providerMessageId,
    body: event.body,
    contactName: null,
    attribution: event.attribution ?? null,
  });
  assertTenant(tenantId, inbound.tenantId, "inbound");

  // `messageInserted=false` means the inbox replay found the durable lead row. It does not mean
  // the interrupted engine/send/persistence work completed, so retries must continue from that
  // row instead of converting a failed receipt into a terminal skip.
  await dependencies.cancelCadence({
    tenantId,
    contactId: inbound.contactId,
    inboundMessageId: inbound.messageId,
  });

  const control = await dependencies.processSuppression({ tenantId, event, inbound });
  if (control.kind !== "none") return { kind: "control", eventId: event.eventId, control, inbound };

  await dependencies.reanchorCadence({ tenantId, event, inbound });

  let conversation = await dependencies.loadConversation(tenantId, inbound.conversationId);
  assertTenant(tenantId, conversation.tenantId, "conversation");
  let turn = await dependencies.loadEngineTurn({
    tenantId,
    conversationId: inbound.conversationId,
    contactId: inbound.contactId,
    inboundMessageId: inbound.messageId,
  });
  if (turn?.persisted) {
    return { kind: "no_send", eventId: event.eventId, result: turn.result, inbound };
  }
  // A completed booking is terminal. Reopening it would let any later lead message mint another
  // slot offer and a second appointment; an interrupted confirmation stays `agent` until its exact
  // outbound message is persisted and finalized, so it does not need this exception.
  if (!turn && conversation.status === "closed" && conversation.statusReason === "booked") {
    return { kind: "held", eventId: event.eventId, status: conversation.status, inbound };
  }
  let inboundSafety: InboundSafetyInput | null = null;
  let safetyReplay = false;
  if (!turn || !turn.delivered) {
    const decision = decideBeforePrompt(conversation);
    if (decision.kind === "hold") {
      if (!turn) {
        inboundSafety = await dependencies.loadInboundSafety({ tenantId, event, inbound });
        safetyReplay = isPersistedInboundSafetyReplay(inboundSafety);
      }
      if (!safetyReplay) {
        return { kind: "held", eventId: event.eventId, status: decision.status, inbound };
      }
    }
    if (decision.kind === "resume" && !safetyReplay) {
      conversation = await dependencies.resumeConversation({
        tenantId,
        conversationId: inbound.conversationId,
        from: decision.from,
      });
      assertTenant(tenantId, conversation.tenantId, "resume");
      if (conversation.status !== "agent" || conversation.statusReason !== null) {
        throw new Error("INBOUND_RESUME_READBACK_INVALID");
      }
    }
    // A prepared immutable turn already consumed generation quota. It still obeys a later
    // human/opt-out hold, but retrying its first delivery must not debit the bucket twice.
    const limit = turn || safetyReplay ? { allowed: true as const, reason: null } :
      await dependencies.consumeRateLimit({
        tenantId,
        conversationId: inbound.conversationId,
      });
    if (!limit.allowed) throw new Error(limit.reason ?? "INBOUND_RATE_LIMITED");
  }
  if (!turn) {
    inboundSafety ??= await dependencies.loadInboundSafety({ tenantId, event, inbound });
    assertTenant(tenantId, inboundSafety.state.tenantId, "inbound_safety");
    if (inboundSafety.state.conversationId !== inbound.conversationId) {
      throw new Error("INBOUND_SAFETY_CONVERSATION_MISMATCH");
    }
    const [history, qualificationState] = await Promise.all([
      dependencies.loadHistory({
        tenantId,
        conversationId: inbound.conversationId,
        inboundMessageId: inbound.messageId,
        limit: HISTORY_ROW_LIMIT,
      }),
      dependencies.loadQualificationState(tenantId, inbound.contactId),
    ]);
    let result = await dependencies.runEngine(
      canonicalInboundEngineInput(
        tenantId,
        event,
        inbound,
        safetyReplay
          ? { ...conversation, status: "agent", statusReason: null }
          : conversation,
        history,
        inboundSafety,
        qualificationState,
      ),
    );
    const hasBookingConfirmation = result.commands.some(
      (command) => command.kind === "record_booking_intent",
    );
    if (conversation.currentStep === null || hasBookingConfirmation) {
      result = applyPinnedKeywordGoal({
        result,
        goal: await dependencies.loadPinnedKeywordGoal?.(tenantId, inbound.conversationId) ?? null,
        firstQualificationTurn: conversation.currentStep === null,
      });
    }
    turn = await dependencies.recordEngineTurn({
      tenantId,
      conversationId: inbound.conversationId,
      contactId: inbound.contactId,
      inboundMessageId: inbound.messageId,
      preTurnCurrentStep: conversation.currentStep ?? null,
      preTurnCurrentStepAsks: conversation.currentStepAsks,
      result,
    });
  }
  const result = turn.result;
  const body = outboundBody(result);
  if (!body) return { kind: "no_send", eventId: event.eventId, result, inbound };
  const isTest = await dependencies.loadContactIsTest(tenantId, inbound.contactId);
  const sent = await dependencies.sendToLead({
    tenantId,
    contactId: inbound.contactId,
    conversationId: inbound.conversationId,
    nominatedIdentityId: null,
    purpose: "agent_reply",
    content: { kind: "freeform", body },
    idempotencyKey: `inbound:${event.identity.provider}:${event.providerMessageId}`,
    occurredAt: new Date().toISOString(),
    isTest,
    originReceipt,
  });
  if (sent.kind !== "sent") {
    if (sent.kind === "refused" && sent.reason === "provider_unconfirmed") {
      // The provider may have accepted this exact send, or local persistence may merely be
      // incomplete. Keep the inbound receipt retryable; a retry can resume accepted persistence,
      // while an indeterminate attempt stays fail-closed until evidence-backed reconciliation.
      throw new Error("OUTBOUND_SEND_PENDING_RECONCILIATION");
    }
    return { kind: "refused", eventId: event.eventId, reason: sent.reason, result, inbound };
  }
  await dependencies.markEngineTurnDelivered({
    tenantId,
    conversationId: inbound.conversationId,
    contactId: inbound.contactId,
    inboundMessageId: inbound.messageId,
    outboundMessageId: sent.receipt.messageId,
  });
  await dependencies.persistResult({
    tenantId,
    event,
    inbound,
    result,
    providerMessageId: sent.receipt.providerMessageId,
    preTurnCurrentStep: turn.preTurnCurrentStep,
    preTurnCurrentStepAsks: turn.preTurnCurrentStepAsks,
  });
  await dependencies.completeEngineTurn({
    tenantId,
    conversationId: inbound.conversationId,
    contactId: inbound.contactId,
    inboundMessageId: inbound.messageId,
    outboundMessageId: sent.receipt.messageId,
  });
  return { kind: "sent", eventId: event.eventId, result, inbound };
}

/**
 * Processes one durable normalized batch. Persistence and delivery retain provider facts, while
 * the engine receives only the canonical channel, body, and persisted row identifiers.
 */
export async function processInboundReceipt(
  receipt: DurableInboundReceipt,
  dependencies: InboundProcessDependencies,
) {
  const tenantId = receipt.tenantId.trim();
  if (!tenantId) throw new Error("EXPECTED_TENANT_REQUIRED");

  try {
    if (receipt.batch.events.length === 0) throw new Error("INBOUND_BATCH_EMPTY");
    const processed: ProcessedInboundEvent[] = [];
    for (const event of receipt.batch.events) {
      if (event.kind !== "message") {
        processed.push({ kind: event.kind, eventId: event.eventId });
        continue;
      }
      if (event.identity.provider !== receipt.provider) throw new Error("INBOUND_PROVIDER_MISMATCH");
      processed.push(await processNormalizedMessage(tenantId, event, dependencies, {
        receiptId: receipt.id,
        leaseToken: receipt.leaseToken,
        attemptNumber: receipt.attemptNumber,
      }));
    }
    await dependencies.markReceipt({
      receiptId: receipt.id,
      tenantId,
      status: "processed",
      error: null,
    });
    return { kind: "batch" as const, events: processed };
  } catch (error) {
    await dependencies.markReceipt({
      receiptId: receipt.id,
      tenantId,
      status: "failed",
      error: error instanceof Error ? error.message.slice(0, 240) : "INBOUND_PROCESSING_FAILED",
    });
    throw error;
  }
}

function normalizedBatch(value: unknown): NormalizedInboundBatch {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INBOUND_RECEIPT_INVALID");
  }
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0) throw new Error("INBOUND_RECEIPT_INVALID");
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("INBOUND_RECEIPT_INVALID");
    }
    const row = event as Record<string, unknown>;
    if (
      !["message", "ignored", "status"].includes(String(row.kind)) ||
      typeof row.eventId !== "string" || !row.eventId.trim() ||
      typeof row.externalAccountId !== "string" || !row.externalAccountId.trim()
    ) throw new Error("INBOUND_RECEIPT_INVALID");
  }
  return { events: events as NormalizedInboundEvent[] };
}

/**
 * Lead text that tries to move the agent off its role. A tripwire for the obvious shapes only: the
 * generator's platform invariants, the SCOPE check and the moderator carry the paraphrased rest.
 */
export const SCOPE_ATTACK_PATTERN = new RegExp([
  "\\b(?:poem|general assistant|essay|roleplay|jailbreak|developer mode|dan mode)\\b",
  "(?:ignore|disregard|forget|override|bypass)\\b.{0,40}\\b(?:instruction|rule|prompt|guideline|restriction)",
  "\\b(?:system|initial|hidden|secret|original)\\s+(?:prompt|instruction|message)",
  "\\b(?:reveal|show|print|repeat|display|leak)\\b.{0,30}\\b(?:prompt|instruction|configuration|rules)",
  "\\bwrite me\\b",
  "\\byou(?:’|')?re now\\b",
  "\\bfrom now on\\b",
  "\\b(?:act|behave|respond|answer)\\s+as\\b",
  "\\bpretend\\s+(?:to be|you|that)\\b",
  "\\bnew instructions?\\b",
  "\\bi am (?:the|your|an?) (?:admin|administrator|developer|owner|coach|operator)\\b",
  "\\btest mode\\b",
].join("|"), "iu");

function classifyInboundSafety(event: NormalizedInboundMessage, reply: string, approved: boolean) {
  const body = event.body.toLowerCase();
  const signalKey = `${event.identity.provider}:${event.eventId}`;
  if (/\b(password|social security|ssn|credit card number)\b/u.test(body)) {
    return { kind: "tripwire" as const, signalKey, class: "sensitive_data", severity: "escalate" as const, reply, replyApproved: approved };
  }
  if (/\b(guarantee|guaranteed|promise)\b.{0,30}\b(approval|funding|result|outcome)\b/u.test(body)) {
    return { kind: "tripwire" as const, signalKey, class: "guarantee", severity: "refuse" as const, reply, replyApproved: approved };
  }
  if (SCOPE_ATTACK_PATTERN.test(body)) {
    return { kind: "scope" as const, signalKey };
  }
  return { kind: "none" as const };
}

export async function loadRouteInboundSafety(
  tenantId: string,
  message: string,
  options: { classify?: boolean } = {},
) {
  const client = createSupabaseServiceClient();
  const [conversationResult, settingsResult] = await Promise.all([
    client.from("conversations")
      .select("tenant_id,id,status,status_reason,scope_attack_count,tripwire_count,tripwire_classes,last_scope_signal_key,last_tripwire_signal_key,current_step_asks,disclosure_pending")
      // The public preview must start in a live agent state. Selecting the latest arbitrary demo
      // conversation can instead inherit an opted-out or closed terminal state and produce an
      // empty reply for a brand-new visitor.
      .eq("tenant_id", tenantId).eq("is_test", true).eq("status", "agent").order("updated_at", { ascending: false })
      .limit(1).maybeSingle(),
    client.from("platform_settings").select("approved,agent_content").eq("singleton", true).single(),
  ]);
  if (conversationResult.error || !conversationResult.data || settingsResult.error || !settingsResult.data) {
    throw new Error("INBOUND_SAFETY_STATE_REQUIRED");
  }
  const row = conversationResult.data;
  const content = settingsResult.data.agent_content as Record<string, unknown>;
  const approved = settingsResult.data.approved === true;
  const agentContent = approvedPlatformAgentContent({ ...content, approved }, { allowDraft: true });
  const signal = options.classify === false
    ? { kind: "none" as const }
    : classifyInboundSafety({
        kind: "message",
        eventId: createHash("sha256").update(message, "utf8").digest("hex"),
        providerMessageId: "consumer-preview",
        body: message,
        externalAccountId: "consumer-preview",
        identity: {
          provider: "ghl",
          channel: "sms",
          externalId: "consumer-preview",
          normalizedPhone: null,
          normalizedEmail: null,
        },
        providerWindow: null,
      }, agentContent.heldReplies.CLAIM, approved);
  const persistInboundSafety: InboundSafetyPersistence = {
    applyScopeSignal: async ({ expectedTenantId, conversationId, signalKey }) => {
      const { data, error } = await client.rpc("apply_scope_signal", {
        p_expected_tenant: expectedTenantId, p_conversation_id: conversationId, p_signal_key: signalKey,
      });
      const result = Array.isArray(data) ? data[0] : data;
      if (error || !result) throw new Error("INBOUND_SCOPE_PERSIST_FAILED");
      return { persistedCount: Number(result.persisted_count), action: result.action };
    },
    applyTripwireSignal: async ({ expectedTenantId, conversationId, signalKey, class: className, severity }) => {
      const { data, error } = await client.rpc("apply_tripwire_signal", {
        p_expected_tenant: expectedTenantId, p_conversation_id: conversationId,
        p_signal_key: signalKey, p_class: className, p_severity: severity,
      });
      const result = Array.isArray(data) ? data[0] : data;
      if (error || !result) throw new Error("INBOUND_TRIPWIRE_PERSIST_FAILED");
      return { persistedCount: Number(result.persisted_count), action: result.action };
    },
  };
  return {
    conversation: {
      state: "agent" as const,
      currentStep: null,
      currentStepAsks: row.current_step_asks,
      disclosurePending: row.disclosure_pending,
    },
    inboundSafety: {
      state: {
        tenantId: row.tenant_id,
        conversationId: row.id,
        status: row.status,
        statusReason: row.status_reason,
        scopeAttackCount: row.scope_attack_count,
        tripwireCount: row.tripwire_count,
        tripwireClasses: row.tripwire_classes,
        lastScopeSignalKey: row.last_scope_signal_key,
        lastTripwireSignalKey: row.last_tripwire_signal_key,
      },
      content: {
        approved,
        scopeDeflection1: typeof content.scopeDeflection1 === "string" ? content.scopeDeflection1 : "",
        scopeDeflection2: typeof content.scopeDeflection2 === "string" ? content.scopeDeflection2 : "",
        scopeClosing: typeof content.scopeClosing === "string" ? content.scopeClosing : "",
      },
      signal,
    } satisfies InboundSafetyInput,
    persistInboundSafety,
  };
}

function cadenceMessagingChannel(value: string): CadenceMessagingChannel | null {
  return value === "sms" || value === "instagram" || value === "messenger" || value === "whatsapp"
    ? value
    : null;
}

async function loadLiveCadenceMaterialization(input: {
  tenantId: string;
  event: NormalizedInboundMessage;
  inbound: PersistedInboundIdentity;
}) {
  const channel = cadenceMessagingChannel(input.event.identity.channel);
  // Webchat has no provider follow-up contract. The lead reply still cancels existing contact
  // touches, but inventing a cross-channel destination here would violate consent and custody.
  if (!channel) return null;

  const client = createSupabaseServiceClient();
  const [offerResult, inboundResult, outboundResult, capabilityFeed] = await Promise.all([
    client.from("offer_layers").select("id,tenant_id").eq("tenant_id", input.tenantId)
      .eq("status", "published").order("version", { ascending: false }).limit(1).maybeSingle(),
    client.from("messages").select("id,tenant_id,conversation_id,created_at")
      .eq("tenant_id", input.tenantId).eq("conversation_id", input.inbound.conversationId)
      .eq("id", input.inbound.messageId).eq("direction", "in").single(),
    client.from("messages").select("created_at")
      .eq("tenant_id", input.tenantId).eq("conversation_id", input.inbound.conversationId)
      .eq("direction", "out").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    loadChannelCapabilityFeed(input.tenantId, input.inbound.conversationId, channel),
  ]);
  if (offerResult.error || !offerResult.data || offerResult.data.tenant_id !== input.tenantId) {
    throw new Error("PUBLISHED_CADENCE_OFFER_REQUIRED");
  }
  if (inboundResult.error || !inboundResult.data ||
    inboundResult.data.tenant_id !== input.tenantId ||
    inboundResult.data.conversation_id !== input.inbound.conversationId) {
    throw new Error("CADENCE_INBOUND_ANCHOR_REQUIRED");
  }
  if (outboundResult.error) throw new Error("CADENCE_OUTBOUND_ANCHOR_READ_FAILED");

  const { data: purposeRows, error: purposeError } = await client
    .from("offer_cadence_purposes")
    .select("channel_class,touch_no,purpose")
    .eq("tenant_id", input.tenantId)
    .eq("offer_id", offerResult.data.id)
    .order("channel_class")
    .order("touch_no");
  if (purposeError) throw new Error("PUBLISHED_CADENCE_PURPOSES_REQUIRED");
  const purposeOverrides = (purposeRows ?? []).map((row) => ({
    channelClass: row.channel_class,
    touchNo: row.touch_no,
    purpose: row.purpose,
  })) as CadencePurposeOverride[];

  return {
    tenantId: input.tenantId,
    conversationId: input.inbound.conversationId,
    channel,
    cadenceAnchorAt: inboundResult.data.created_at,
    providerWindowExpiresAt: input.inbound.providerWindowExpiresAt,
    materializedAt: new Date().toISOString(),
    lastOutboundAt: outboundResult.data?.created_at ?? null,
    capabilityFeed,
    purposeOverrides,
  };
}

/**
 * A slot id travels through the lead's reply and back into the proposal read-back, so it is held
 * to a provider-id shape: letters, digits and ._~- only. The simulated calendar mints its slot ids
 * to pass this same check; only its appointment ids carry the `simulated:` prefix.
 */
export function validProviderSlotId(value: string) {
  return /^[A-Za-z0-9._~-]{1,200}$/u.test(value);
}

function proposedSlotSet(value: unknown): ProposedSlotSet | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.calendarConnectionId !== "string" ||
    typeof row.rangeStartAt !== "string" || typeof row.rangeEndAt !== "string" ||
    typeof row.proposedAt !== "string" || typeof row.presentationTimezone !== "string" ||
    !Array.isArray(row.slots)) return null;
  const slots = row.slots.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const slot = candidate as Record<string, unknown>;
    return typeof slot.id === "string" && validProviderSlotId(slot.id) &&
      typeof slot.startAt === "string" &&
      typeof slot.endAt === "string" && typeof slot.timezone === "string" &&
      typeof slot.display === "string"
      ? [{
          id: slot.id,
          startAt: slot.startAt,
          endAt: slot.endAt,
          timezone: slot.timezone,
          display: slot.display,
        }]
      : [];
  });
  if (slots.length !== row.slots.length) return null;
  return {
    calendarConnectionId: row.calendarConnectionId,
    rangeStartAt: row.rangeStartAt,
    rangeEndAt: row.rangeEndAt,
    proposedAt: row.proposedAt,
    presentationTimezone: row.presentationTimezone,
    slots,
  };
}

function liveBookingRepository(
  client: ReturnType<typeof createSupabaseServiceClient>,
): BookingRepository {
  return {
    getBookingContext: async (tenantId, conversationId) => {
      const { data: conversation, error: conversationError } = await client.from("conversations")
        .select("id,tenant_id,contact_id,channel,is_test")
        .eq("tenant_id", tenantId).eq("id", conversationId).single();
      if (conversationError || !conversation) throw new Error("BOOKING_CONTEXT_CONVERSATION_REQUIRED");
      const [{ data: contact, error: contactError }, { data: identity, error: identityError }] =
        await Promise.all([
          client.from("contacts")
            .select("id,tenant_id,name,timezone,credit_range,funding_goal,timeline,is_test")
            .eq("tenant_id", tenantId).eq("id", conversation.contact_id).single(),
          client.from("contact_identities")
            .select("provider_identity_id")
            .eq("tenant_id", tenantId).eq("contact_id", conversation.contact_id)
            .eq("provider", "ghl").limit(1).maybeSingle(),
        ]);
      if (contactError || !contact || identityError || !identity?.provider_identity_id) {
        throw new Error("BOOKING_CONTEXT_IDENTITY_REQUIRED");
      }
      const channel = cadenceMessagingChannel(conversation.channel);
      if (!channel) throw new Error("BOOKING_CONTEXT_CHANNEL_UNSUPPORTED");
      const isTest = contact.is_test || conversation.is_test;
      return {
        tenantId,
        conversationId,
        contactId: contact.id,
        providerContactId: identity.provider_identity_id,
        leadName: contact.name ?? "Lead",
        channel,
        leadTimezone: contact.timezone,
        qualification: {
          creditBand: contact.credit_range,
          fundingGoal: contact.funding_goal,
          timeline: contact.timeline,
        },
        isTest,
        simulated: isTest && await tenantSimulates(client, tenantId),
      };
    },
    getPrimaryCalendar: async (tenantId) => {
      const { data, error } = await client.from("calendar_connections")
        .select("id,tenant_id,provider,external_calendar_id,external_location_id,timezone,booking_url,state")
        .eq("tenant_id", tenantId).eq("is_primary", true).eq("state", "ready").maybeSingle();
      if (error) throw new Error("BOOKING_PRIMARY_CALENDAR_READ_FAILED");
      if (!data) return null;
      if (!data.external_location_id) throw new Error("BOOKING_CALENDAR_LOCATION_REQUIRED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        provider: data.provider,
        externalCalendarId: data.external_calendar_id,
        externalLocationId: data.external_location_id,
        timezone: data.timezone,
        bookingUrl: data.booking_url,
      } as CalendarConnection;
    },
    getProposedSlots: async (tenantId, conversationId) => {
      const { data, error } = await client.from("conversations")
        .select("proposed_slots")
        .eq("tenant_id", tenantId).eq("id", conversationId).single();
      if (error || !data) throw new Error("BOOKING_PROPOSAL_READ_FAILED");
      const proposal = proposedSlotSet(data.proposed_slots);
      if (data.proposed_slots && !proposal) throw new Error("BOOKING_PROPOSAL_INVALID");
      return proposal;
    },
    recordProposedSlots: async ({ tenantId, conversationId, proposal }) => {
      const { data, error } = await client.rpc("record_booking_proposed_slots", {
        p_expected_tenant: tenantId,
        p_conversation_id: conversationId,
        p_proposal: proposal,
        p_proposed_at: proposal.proposedAt,
      });
      if (error) throw new Error("BOOKING_PROPOSAL_WRITE_FAILED");
      const selected = proposedSlotSet(data);
      if (!selected) throw new Error("BOOKING_PROPOSAL_READBACK_INVALID");
      return selected;
    },
    recordCalendarSlotFetch: async (input) => {
      const { data, error } = await client.from("calendar_connections").update({
        last_slot_fetch_at: input.fetchedAt,
        last_slot_fetch_ok: input.ok,
        last_error: input.error,
      }).eq("tenant_id", input.tenantId).eq("id", input.calendarConnectionId)
        .select("id").single();
      if (error || !data) throw new Error("BOOKING_CALENDAR_HEALTH_WRITE_FAILED");
    },
    recordProviderAppointment: async (input) => {
      const { data, error } = await client.rpc("record_provider_appointment", {
        p_expected_tenant: input.tenantId,
        p_contact_id: input.contactId,
        p_conversation_id: input.conversationId,
        p_calendar_connection_id: input.calendarConnectionId,
        p_provider: input.provider,
        p_external_id: input.externalId,
        p_start_at: input.startAt,
        p_end_at: input.endAt,
        p_timezone: input.timezone,
        p_created_source: input.source,
        p_attributed_to_agent: input.attributedToAgent,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.appointment_id) throw new Error("BOOKING_APPOINTMENT_WRITE_FAILED");
      return {
        appointmentId: row.appointment_id,
        billableEventId: row.billable_event_id ?? null,
        auditId: row.audit_id === null ? null : Number(row.audit_id),
      };
    },
    claimBookingIntent: async (input) => {
      const { data, error } = await client.rpc("claim_booking_intent", {
        p_idempotency_key: input.idempotencyKey,
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_contact_id: input.contactId,
        p_calendar_connection_id: input.calendarConnectionId,
        p_selected_slot_id: input.selectedSlotId,
        p_start_at: input.startAt,
        p_end_at: input.endAt,
        p_timezone: input.timezone,
        p_now: input.now,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row?.intent_id || typeof row.intent_state !== "string") {
        throw new Error("BOOKING_INTENT_CLAIM_FAILED");
      }
      if (row.intent_state === "busy") return { kind: "busy", intentId: row.intent_id };
      if (row.intent_state === "provider_created" && row.provider_external_id) {
        return { kind: "provider_created", intentId: row.intent_id, providerExternalId: row.provider_external_id };
      }
      if (row.intent_state === "completed" && row.provider_external_id && row.appointment_id) {
        return {
          kind: "completed",
          intentId: row.intent_id,
          providerExternalId: row.provider_external_id,
          appointment: {
            appointmentId: row.appointment_id,
            billableEventId: row.billable_event_id ?? null,
            auditId: row.appointment_audit_id === null ? null : Number(row.appointment_audit_id),
          },
        };
      }
      if (row.intent_state !== "claimed" || !row.claim_token) {
        throw new Error("BOOKING_INTENT_CLAIM_INVALID");
      }
      return {
        kind: "claimed",
        intentId: row.intent_id,
        claimToken: row.claim_token,
        recoveryRequired: row.recovery_required === true,
      };
    },
    renewBookingIntentLease: async (input) => {
      const { data, error } = await client.rpc("renew_booking_intent_lease", {
        p_intent_id: input.intentId,
        p_claim_token: input.claimToken,
        p_expected_tenant: input.tenantId,
        p_now: input.now,
      });
      if (error || typeof data !== "boolean") throw new Error("BOOKING_INTENT_LEASE_RENEW_FAILED");
      return data;
    },
    recordBookingIntentProvider: async (input) => {
      const { error } = await client.rpc("record_booking_intent_provider", {
        p_intent_id: input.intentId,
        p_claim_token: input.claimToken,
        p_expected_tenant: input.tenantId,
        p_provider_external_id: input.providerExternalId,
        p_recovered: input.recovered,
      });
      if (error) throw new Error("BOOKING_INTENT_PROVIDER_WRITE_FAILED");
    },
    completeBookingIntent: async (input) => {
      const { error } = await client.rpc("complete_booking_intent", {
        p_intent_id: input.intentId,
        p_expected_tenant: input.tenantId,
        p_provider_external_id: input.providerExternalId,
        p_appointment_id: input.appointment.appointmentId,
        p_billable_event_id: input.appointment.billableEventId,
        p_appointment_audit_id: input.appointment.auditId,
      });
      if (error) throw new Error("BOOKING_INTENT_COMPLETE_FAILED");
    },
    releaseBookingIntent: async (input) => {
      const { error } = await client.rpc("release_booking_intent", {
        p_intent_id: input.intentId,
        p_claim_token: input.claimToken,
        p_expected_tenant: input.tenantId,
        p_error: input.error,
      });
      if (error) throw new Error("BOOKING_INTENT_RELEASE_FAILED");
    },
    checkpointBookingConflict: async (input) => {
      const { error } = await client.rpc("checkpoint_booking_slot_conflict", {
        p_expected_tenant: input.tenantId,
        p_emission_id: input.emissionId,
        p_inbound_message_id: input.inboundMessageId,
        p_booking_intent_id: input.intentId,
        p_claim_token: input.claimToken,
        p_error: input.error,
        p_now: input.now,
      });
      if (error) throw new Error("BOOKING_SLOT_CONFLICT_CHECKPOINT_FAILED");
    },
    recordBookingLinkSent: async (input) => {
      const { data, error } = await client.from("conversations")
        .update({ booking_link_sent_at: input.sentAt })
        .eq("tenant_id", input.tenantId).eq("id", input.conversationId)
        .select("id").single();
      if (error || !data) throw new Error("BOOKING_LINK_WRITE_FAILED");
    },
  };
}

function liveBookingService(client: ReturnType<typeof createSupabaseServiceClient>) {
  return createBookingService({
    simulatedCalendar: createSimulatedCalendarDriver(),
    calendar: selectCalendarDriver({
      factories: {
        mock: createMockCalendarDriver,
        real: () => createRealCalendarDriver({
          getLocationAccessToken: resolveGhlLocationAccessToken,
        }),
      },
    }),
    repository: liveBookingRepository(client),
    emitDomainEvent: async (event) => {
      await createBookingEventEmitter(createNotificationRepository())(event);
    },
  });
}

export function withBookingSlotOffer(
  result: EngineTurnResult,
  proposal: ProposedSlotSet,
): EngineTurnResult {
  const offered = proposal.slots.slice(0, 5);
  if (offered.length === 0) throw new Error("BOOKING_SLOT_PROPOSAL_EMPTY");
  if (offered.some((slot) => !validProviderSlotId(slot.id))) {
    throw new Error("BOOKING_SLOT_PROPOSAL_INVALID");
  }
  const slots = offered.map((slot) => `${slot.display} — [slot_id:${slot.id}]`).join("\n");
  const body = `${result.response.reply}\n\nReply with the exact slot ID:\n${slots}`;
  const expiresAt = new Date(Date.parse(proposal.proposedAt) + MAX_PROPOSED_SLOT_AGE_MS).toISOString();
  return {
    ...result,
    response: { ...result.response, reply: body },
    commands: [
      ...result.commands.map((command) => command.kind === "persist_agent_turn" || command.kind === "send"
        ? { ...command, body }
        : command),
      {
        kind: "record_booking_slot_offer",
        slotIds: offered.map((slot) => slot.id),
        proposedAt: proposal.proposedAt,
        expiresAt,
      },
    ],
  };
}

export const BOOKING_NO_SLOTS_REPLY =
  "I couldn't find an available appointment time in the current booking window. I've flagged this for follow-up so we can help with scheduling.";

export function withNoBookingSlotsFallback(result: EngineTurnResult): EngineTurnResult {
  const commands = result.commands
    .filter((command) => command.kind !== "record_booking_slot_offer" &&
      command.kind !== "transition" && command.kind !== "alert" && command.kind !== "audit")
    .map((command) => command.kind === "persist_agent_turn" || command.kind === "send"
      ? { ...command, body: BOOKING_NO_SLOTS_REPLY }
      : command);
  return {
    ...result,
    response: { reply: BOOKING_NO_SLOTS_REPLY, state: "needs_human", booking: null },
    commands: [
      ...commands,
      { kind: "transition", state: "needs_human", reason: "no_match_threshold" },
      { kind: "alert", eventKey: "conversation.needs_human" },
      { kind: "audit", actionKey: "conversation.escalated" },
    ],
    trace: {
      ...result.trace,
      screen: { verdict: "held", reason: "booking_no_slots" },
      ruleFired: result.trace.ruleFired ?? "booking-no-slots-001",
    },
  };
}

export async function resolveLiveBookingSelection(input: {
  client: ReturnType<typeof createSupabaseServiceClient>;
  service: ReturnType<typeof createBookingService>;
  engineInput: CanonicalInboundEngineInput;
}) {
  if (input.engineInput.qualificationState.outcome !== "BOOK") {
    return { kind: "none" as const };
  }
  const { data, error } = await input.client.rpc("claim_booking_slot_selection", {
    p_expected_tenant: input.engineInput.tenantId,
    p_conversation_id: input.engineInput.conversationId,
    p_contact_id: input.engineInput.contactId,
    p_inbound_message_id: input.engineInput.leadMessageId,
    p_exact_slot_id: input.engineInput.body.trim(),
    p_now: new Date().toISOString(),
  });
  const claim = Array.isArray(data) ? data[0] : data;
  if (error || !claim || typeof claim.selection_state !== "string") {
    throw new Error("BOOKING_SLOT_SELECTION_CLAIM_FAILED");
  }
  if (claim.selection_state === "invalid") return { kind: "invalid" as const };
  if (claim.selection_state === "busy") throw new Error("BOOKING_SLOT_SELECTION_BUSY");
  if (claim.selection_state === "no_offer") return { kind: "offer" as const };
  if (claim.selection_state === "reoffer") {
    const { data: conversation, error: proposalError } = await input.client.from("conversations")
      .select("proposed_slots").eq("tenant_id", input.engineInput.tenantId)
      .eq("id", input.engineInput.conversationId).single();
    const proposal = proposedSlotSet(conversation?.proposed_slots);
    if (proposalError || !proposal || !isProposedSlotFresh(proposal, new Date())) {
      throw new Error("BOOKING_SLOT_REOFFER_PROPOSAL_REQUIRED");
    }
    return { kind: "reoffer" as const, proposal };
  }
  if (claim.selection_state === "conflict_pending") {
    const { data: conversation, error: proposalError } = await input.client.from("conversations")
      .select("proposed_slots").eq("tenant_id", input.engineInput.tenantId)
      .eq("id", input.engineInput.conversationId).single();
    const priorProposal = proposedSlotSet(conversation?.proposed_slots);
    if (proposalError || !priorProposal) throw new Error("BOOKING_REOFFER_PENDING:PROPOSAL_REQUIRED");
    const refreshed = await input.service.fetchReplacementSlots({
      tenantId: input.engineInput.tenantId,
      conversationId: input.engineInput.conversationId,
      rangeStartAt: priorProposal.rangeStartAt,
      rangeEndAt: priorProposal.rangeEndAt,
    });
    if (refreshed.kind !== "offered") {
      if (refreshed.kind === "unavailable" && refreshed.reason === "no_slots") {
        return { kind: "no_slots" as const, conflictPending: true };
      }
      const reason = refreshed.kind === "unhealthy" ? refreshed.health.error : refreshed.reason;
      throw new Error(`BOOKING_REOFFER_PENDING:${reason}`);
    }
    const { data: reofferData, error: reofferError } = await input.client.rpc(
      "record_booking_slot_conflict_reoffer",
      {
        p_expected_tenant: input.engineInput.tenantId,
        p_emission_id: claim.emission_id,
        p_inbound_message_id: input.engineInput.leadMessageId,
        p_proposal: refreshed.proposal,
        p_proposed_at: refreshed.proposal.proposedAt,
        p_now: new Date().toISOString(),
      },
    );
    const persistedProposal = proposedSlotSet(reofferData);
    if (reofferError || !persistedProposal) {
      throw new Error("BOOKING_REOFFER_PENDING:ATTACH_FAILED");
    }
    return { kind: "reoffer" as const, proposal: persistedProposal };
  }
  if ((claim.selection_state !== "claimed" && claim.selection_state !== "replay") ||
    typeof claim.emission_id !== "string" || typeof claim.selected_slot_id !== "string") {
    throw new Error("BOOKING_SLOT_SELECTION_CLAIM_INVALID");
  }
  const booked: BookingResult = await input.service.bookDirectAppointment({
    tenantId: input.engineInput.tenantId,
    conversationId: input.engineInput.conversationId,
    selectedSlotId: claim.selected_slot_id,
    conflictContext: {
      emissionId: claim.emission_id,
      inboundMessageId: input.engineInput.leadMessageId,
    },
  });
  if (booked.kind === "in_progress") throw new Error(`BOOKING_IN_PROGRESS:${booked.intentId}`);
  if (booked.kind === "no_slots") {
    return { kind: "no_slots" as const, conflictPending: true };
  }
  if (booked.kind === "reoffer_pending") {
    throw new Error(`BOOKING_REOFFER_PENDING:${booked.error}`);
  }
  if (booked.kind === "provider_error") throw new Error(`BOOKING_PROVIDER_ERROR:${booked.error}`);
  if (booked.kind === "reoffer") {
    if (booked.reason === "slot_conflict") {
      const { data: reofferData, error: reofferError } = await input.client.rpc(
        "record_booking_slot_conflict_reoffer",
        {
          p_expected_tenant: input.engineInput.tenantId,
          p_emission_id: claim.emission_id,
          p_inbound_message_id: input.engineInput.leadMessageId,
          p_proposal: booked.proposal,
          p_proposed_at: booked.proposal.proposedAt,
          p_now: new Date().toISOString(),
        },
      );
      const persistedProposal = proposedSlotSet(reofferData);
      if (reofferError || !persistedProposal) {
        throw new Error("BOOKING_SLOT_CONFLICT_REOFFER_WRITE_FAILED");
      }
      return { kind: "reoffer" as const, proposal: persistedProposal };
    }
    const { error: releaseError } = await input.client.rpc("release_booking_slot_selection_for_reoffer", {
      p_expected_tenant: input.engineInput.tenantId,
      p_emission_id: claim.emission_id,
      p_inbound_message_id: input.engineInput.leadMessageId,
      p_now: new Date().toISOString(),
    });
    if (releaseError) throw new Error("BOOKING_SLOT_REOFFER_RELEASE_FAILED");
    return { kind: "reoffer" as const, proposal: booked.proposal };
  }
  if (booked.kind === "unavailable") return { kind: "invalid" as const };
  const { error: completeError } = await input.client.rpc("complete_booking_slot_selection", {
    p_expected_tenant: input.engineInput.tenantId,
    p_emission_id: claim.emission_id,
    p_inbound_message_id: input.engineInput.leadMessageId,
    p_appointment_id: booked.appointment.appointmentId,
    p_now: new Date().toISOString(),
  });
  if (completeError) throw new Error("BOOKING_SLOT_SELECTION_COMPLETE_FAILED");
  return {
    kind: "booked" as const,
    booking: {
      id: booked.appointment.appointmentId,
      startAt: booked.slot.startAt,
      timezone: booked.slot.timezone,
    },
  };
}

function liveInboundDependencies(
  finishReceipt: (status: "processed" | "failed" | "skipped", error: string | null) => Promise<void>,
): InboundProcessDependencies {
  const client = createSupabaseServiceClient();
  const liveGateway = createLiveSendToLeadGateway();
  let bookingService: ReturnType<typeof createBookingService> | null = null;
  const getBookingService = () => bookingService ??= liveBookingService(client);
  const emitComplianceEvent = createComplianceEventEmitter(createNotificationRepository());
  const persistInboundSafety: InboundSafetyPersistence = {
    applyScopeSignal: async ({ expectedTenantId, conversationId, signalKey }) => {
      const { data, error } = await client.rpc("apply_scope_signal", {
        p_expected_tenant: expectedTenantId,
        p_conversation_id: conversationId,
        p_signal_key: signalKey,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw new Error("INBOUND_SCOPE_PERSIST_FAILED");
      return { persistedCount: Number(row.persisted_count), action: row.action };
    },
    applyTripwireSignal: async ({ expectedTenantId, conversationId, signalKey, class: className, severity }) => {
      const { data, error } = await client.rpc("apply_tripwire_signal", {
        p_expected_tenant: expectedTenantId,
        p_conversation_id: conversationId,
        p_signal_key: signalKey,
        p_class: className,
        p_severity: severity,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw new Error("INBOUND_TRIPWIRE_PERSIST_FAILED");
      const result = { persistedCount: Number(row.persisted_count), action: row.action };
      if (result.action === "escalated" && Array.isArray(row.audit_ids) && row.audit_ids.length > 0) {
        const { data: conversation } = await client.from("conversations").select("is_test")
          .eq("tenant_id", expectedTenantId).eq("id", conversationId).single();
        await emitComplianceEvent(conversationTripwireEscalatedEvent({
          tenantId: expectedTenantId,
          conversationId,
          tripwireClass: className,
          occurredAt: new Date().toISOString(),
          isTest: conversation?.is_test ?? false,
        }));
      }
      return result;
    },
  };
  return {
    tenantAccess: createLiveTenantAccessPort(),
    persistInbound: async (tenantId, input) => {
      const inbound = await persistInboundIdentity(tenantId, input);
      if (inbound.messageInserted) {
        const { error } = await client.from("conversations")
          .update({ unread_by_coach: true })
          .eq("tenant_id", tenantId)
          .eq("id", inbound.conversationId)
          .eq("status", "human");
        if (error) throw new Error("HELD_INBOUND_UNREAD_PERSIST_FAILED");
      }
      return inbound;
    },
    loadConversation: async (tenantId, conversationId) => {
      const { data, error } = await client
        .from("conversations")
        .select("id, tenant_id, status, status_reason, current_step, current_step_asks, disclosure_pending, unread_by_coach")
        .eq("id", conversationId)
        .eq("tenant_id", tenantId)
        .single();
      if (error || !data) throw new Error("CONVERSATION_READBACK_FAILED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        status: data.status,
        statusReason: data.status_reason,
        currentStep: data.current_step,
        currentStepAsks: data.current_step_asks,
        disclosurePending: data.disclosure_pending,
        unreadByCoach: data.unread_by_coach,
      } as InboundConversationSnapshot;
    },
    loadHistory: async ({ tenantId, conversationId, inboundMessageId, limit }) => {
      const { data, error } = await client.rpc("load_inbound_conversation_history", {
        p_expected_tenant: tenantId,
        p_conversation_id: conversationId,
        p_inbound_message_id: inboundMessageId,
        p_limit: limit,
      });
      if (error || !Array.isArray(data)) throw new Error("INBOUND_HISTORY_READ_FAILED");
      return canonicalConversationHistory(data.map((row: Record<string, unknown>) => ({
        role: row.role as "user" | "assistant",
        content: String(row.content ?? ""),
      })));
    },
    loadQualificationState: async (tenantId, contactId) => {
      const { data, error } = await client.from("contacts")
        .select("tenant_id,credit_range,funding_goal,timeline,business_stage,annual_revenue_cents,outcome,dq_reason")
        .eq("tenant_id", tenantId).eq("id", contactId).single();
      if (error || !data || data.tenant_id !== tenantId) {
        throw new Error("QUALIFICATION_STATE_READ_FAILED");
      }
      return {
        credit: data.credit_range,
        goal: data.funding_goal,
        timeline: data.timeline,
        businessStage: data.business_stage,
        annualRevenueCents: data.annual_revenue_cents === null
          ? null
          : Number(data.annual_revenue_cents),
        outcome: data.outcome,
        dqReason: data.dq_reason,
      } as RuntimeQualificationState;
    },
    loadPinnedKeywordGoal: async (tenantId, conversationId) => {
      const { data: conversation, error: conversationError } = await client.from("conversations")
        .select("tenant_id,keyword_goal_id")
        .eq("tenant_id", tenantId).eq("id", conversationId).single();
      if (conversationError || !conversation || conversation.tenant_id !== tenantId) {
        throw new Error("KEYWORD_GOAL_CONVERSATION_READ_FAILED");
      }
      if (!conversation.keyword_goal_id) return null;
      const { data: goal, error: goalError } = await client.from("keyword_goals")
        .select("id,tenant_id,goal,resource_url,resource_message,post_booking_url,post_booking_message,active")
        .eq("tenant_id", tenantId).eq("id", conversation.keyword_goal_id).eq("active", true)
        .maybeSingle();
      if (goalError) throw new Error("KEYWORD_GOAL_READ_FAILED");
      if (!goal) return null;
      return {
        id: goal.id,
        goal: goal.goal as "resource" | "book",
        resourceUrl: goal.resource_url,
        resourceMessage: goal.resource_message,
        postBookingUrl: goal.post_booking_url,
        postBookingMessage: goal.post_booking_message,
      };
    },
    loadEngineTurn: async ({ tenantId, conversationId, contactId, inboundMessageId }) => {
      const { data, error } = await client.rpc("load_inbound_engine_turn", {
        p_expected_tenant: tenantId,
        p_conversation_id: conversationId,
        p_contact_id: contactId,
        p_inbound_message_id: inboundMessageId,
      });
      if (error || !Array.isArray(data)) throw new Error("INBOUND_ENGINE_TURN_READ_FAILED");
      if (data.length === 0) return null;
      if (data.length !== 1) throw new Error("INBOUND_ENGINE_TURN_READ_INVALID");
      return durableInboundEngineTurn(data[0]);
    },
    recordEngineTurn: async (input) => {
      const { data, error } = await client.rpc("record_inbound_engine_turn", {
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_contact_id: input.contactId,
        p_inbound_message_id: input.inboundMessageId,
        p_pre_turn_current_step: input.preTurnCurrentStep,
        p_pre_turn_current_step_asks: input.preTurnCurrentStepAsks,
        p_result_payload: input.result,
      });
      if (error || !Array.isArray(data) || data.length !== 1) {
        throw new Error("INBOUND_ENGINE_TURN_WRITE_FAILED");
      }
      return durableInboundEngineTurn(data[0]);
    },
    markEngineTurnDelivered: async (input) => {
      const { data, error } = await client.rpc("mark_inbound_engine_turn_delivered", {
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_contact_id: input.contactId,
        p_inbound_message_id: input.inboundMessageId,
        p_outbound_message_id: input.outboundMessageId,
        p_now: new Date().toISOString(),
      });
      if (error || typeof data !== "boolean") {
        throw new Error("INBOUND_ENGINE_TURN_DELIVERY_FAILED");
      }
    },
    completeEngineTurn: async (input) => {
      const { data, error } = await client.rpc("complete_inbound_engine_turn", {
        p_expected_tenant: input.tenantId,
        p_conversation_id: input.conversationId,
        p_contact_id: input.contactId,
        p_inbound_message_id: input.inboundMessageId,
        p_outbound_message_id: input.outboundMessageId,
        p_now: new Date().toISOString(),
      });
      if (error || typeof data !== "boolean") throw new Error("INBOUND_ENGINE_TURN_COMPLETE_FAILED");
    },
    resumeConversation: async ({ tenantId, conversationId }) => {
      const { data, error } = await client
        .from("conversations")
        .update({ status: "agent", status_reason: null, unread_by_coach: true })
        .eq("id", conversationId)
        .eq("tenant_id", tenantId)
        .select("id, tenant_id, status, status_reason, current_step, current_step_asks, disclosure_pending, unread_by_coach")
        .single();
      if (error || !data) throw new Error("CONVERSATION_RESUME_FAILED");
      return {
        id: data.id,
        tenantId: data.tenant_id,
        status: data.status,
        statusReason: data.status_reason,
        currentStep: data.current_step,
        currentStepAsks: data.current_step_asks,
        disclosurePending: data.disclosure_pending,
        unreadByCoach: data.unread_by_coach,
      } as InboundConversationSnapshot;
    },
    consumeRateLimit: async ({ tenantId, conversationId }) => {
      const result = await sharedRateLimit(
        `tenant:${encodeURIComponent(tenantId)}:route:inbound:${encodeURIComponent(conversationId)}`,
        { limit: 30, windowMs: 60_000 },
        { client: { rpc: async (name, args) => {
          const { data, error } = await client.rpc(name, args);
          return { data, error };
        } } },
      );
      return { allowed: result.allowed, reason: result.reason };
    },
    cancelCadence: async ({ tenantId, contactId, inboundMessageId }) => {
      await cancelInboundCadence({
        kind: "lead_message",
        tenantId,
        contactId,
        inboundMessageId,
      }, createLiveFollowupSchedulerRepository());
    },
    reanchorCadence: async (input) => {
      const materialization = await loadLiveCadenceMaterialization(input);
      if (!materialization) return;
      await reanchorInboundCadence(materialization, createLiveFollowupSchedulerRepository());
    },
    processSuppression: async ({ tenantId, event, inbound }) => {
      if (event.identity.channel === "webchat") return { kind: "none" };
      const [identityResult, contactResult] = await Promise.all([
        client.from("contact_identities")
          .select("id,tenant_id,contact_id,provider,channel,provider_identity_id,normalized_phone,normalized_email")
          .eq("tenant_id", tenantId).eq("contact_id", inbound.contactId).order("id"),
        client.from("contacts").select("tenant_id,is_test")
          .eq("tenant_id", tenantId).eq("id", inbound.contactId).single(),
      ]);
      const { data: identities, error: identityError } = identityResult;
      if (identityError) throw new Error("SUPPRESSION_IDENTITIES_READ_FAILED");
      if (contactResult.error || !contactResult.data || contactResult.data.tenant_id !== tenantId) {
        throw new Error("SUPPRESSION_CONTACT_SCOPE_FAILED");
      }
      const isTest = contactResult.data.is_test;
      const { data: suppressions, error: suppressionError } = await client.from("suppression_entries")
        .select("id,channel,identifier_hash").eq("tenant_id", tenantId).eq("contact_id", inbound.contactId);
      if (suppressionError) throw new Error("SUPPRESSION_STATE_READ_FAILED");
      const mapped = (identities ?? []).map((identity) => {
        const normalizedIdentifier = identity.normalized_phone ?? identity.normalized_email ??
          identity.provider_identity_id;
        return {
          tenantId: identity.tenant_id,
          contactId: identity.contact_id,
          identityId: identity.id,
          channel: identity.channel,
          recipientExternalId: identity.provider_identity_id,
          normalizedIdentifier,
          providerIdentityId: identity.provider_identity_id,
          provider: identity.provider,
          suppressionId: suppressionIdForIdentity(
            { channel: identity.channel, normalizedIdentifier },
            suppressions ?? [],
          ),
        };
      });
      const inboundIdentity = mapped.find((identity) =>
        identity.channel === event.identity.channel &&
        identity.providerIdentityId === event.identity.externalId
      );
      if (!inboundIdentity) throw new Error("INBOUND_IDENTITY_READBACK_FAILED");
      const control = await processSuppressionControl({
        tenantId,
        contactId: inbound.contactId,
        conversationId: inbound.conversationId,
        inboundIdentityId: inboundIdentity.identityId,
        channel: event.identity.channel,
        body: event.body,
        providerMessageId: event.providerMessageId,
        occurredAt: new Date().toISOString(),
        isTest,
      }, {
        repository: {
          loadContactIdentities: async () => mapped,
          recordKeywordSuppression: async (input) => {
            const { data, error } = await client.rpc("record_keyword_suppression", {
              p_expected_tenant: input.tenantId,
              p_contact_id: input.contactId,
              p_channels: input.channels,
              p_identifier_hashes: input.identifierHashes,
              p_identifier_last4s: input.identifierLast4s,
              p_source: input.source,
              p_confirmation_key: input.confirmationKey,
            });
            const row = Array.isArray(data) ? data[0] : data;
            if (error || !row) throw new Error("SUPPRESSION_WRITE_FAILED");
            return { suppressionIds: row.suppression_ids, confirmationReserved: row.confirmation_reserved, auditId: Number(row.audit_id) };
          },
          recordProviderResult: async (input) => {
            const { data, error } = await client.rpc("record_provider_suppression_result", {
              p_expected_tenant: input.tenantId, p_suppression_id: input.suppressionId,
              p_confirmed: input.confirmed, p_error: input.error,
            });
            if (error || typeof data !== "number") throw new Error("SUPPRESSION_PROVIDER_RESULT_FAILED");
            return data;
          },
          clearIdentitySuppression: async (input) => {
            const { data, error } = await client.rpc("clear_identity_suppression", {
              p_expected_tenant: input.tenantId, p_contact_id: input.contactId,
              p_identity_id: input.identityId, p_identifier_hash: input.identifierHash,
              p_provider_confirmed: input.providerConfirmed,
            });
            if (error || typeof data !== "number") throw new Error("SUPPRESSION_CLEAR_FAILED");
            return data;
          },
          markStopConfirmationSent: async (input) => {
            const { data, error } = await client.from("contacts").update({ stop_confirmation_sent_at: input.sentAt })
              .eq("tenant_id", input.tenantId).eq("id", input.contactId)
              .eq("stop_confirmation_key", input.confirmationKey).is("stop_confirmation_sent_at", null)
              .select("id").maybeSingle();
            if (error) throw new Error("STOP_CONFIRMATION_READBACK_FAILED");
            return Boolean(data);
          },
        },
        provider: isTest
          ? createMockSuppressionProviderPort()
          : createLiveSuppressionProviderPort(),
        gateway: { send: liveGateway },
      });
      if (control.kind === "stop" && control.provider === "unconfirmed") {
        const { data: pending } = await client.from("suppression_entries").select("id")
          .eq("tenant_id", tenantId).eq("contact_id", inbound.contactId)
          .neq("provider_sync_state", "confirmed");
        for (const row of pending ?? []) {
          await emitComplianceEvent(suppressionProviderUnconfirmedEvent({
            tenantId,
            suppressionId: row.id,
            occurredAt: new Date().toISOString(),
            isTest,
          }));
        }
      }
      return control;
    },
    loadInboundSafety: async ({ tenantId, event, inbound }) => {
      const [conversationResult, settingsResult] = await Promise.all([
        client.from("conversations")
          .select("tenant_id,id,status,status_reason,scope_attack_count,tripwire_count,tripwire_classes,last_scope_signal_key,last_tripwire_signal_key")
          .eq("tenant_id", tenantId).eq("id", inbound.conversationId).single(),
        client.from("platform_settings").select("approved,agent_content").eq("singleton", true).single(),
      ]);
      if (conversationResult.error || !conversationResult.data || settingsResult.error || !settingsResult.data) {
        throw new Error("INBOUND_SAFETY_STATE_REQUIRED");
      }
      const content = settingsResult.data.agent_content as Record<string, unknown>;
      const safetyContent = {
        approved: settingsResult.data.approved === true,
        scopeDeflection1: typeof content.scopeDeflection1 === "string" ? content.scopeDeflection1 : "",
        scopeDeflection2: typeof content.scopeDeflection2 === "string" ? content.scopeDeflection2 : "",
        scopeClosing: typeof content.scopeClosing === "string" ? content.scopeClosing : "",
      };
      return {
        state: {
          tenantId: conversationResult.data.tenant_id,
          conversationId: conversationResult.data.id,
          status: conversationResult.data.status,
          statusReason: conversationResult.data.status_reason,
          scopeAttackCount: conversationResult.data.scope_attack_count,
          tripwireCount: conversationResult.data.tripwire_count,
          tripwireClasses: conversationResult.data.tripwire_classes,
          lastScopeSignalKey: conversationResult.data.last_scope_signal_key,
          lastTripwireSignalKey: conversationResult.data.last_tripwire_signal_key,
        },
        content: safetyContent,
        signal: classifyInboundSafety(event, approvedPlatformAgentContent({
          ...content,
          approved: settingsResult.data.approved,
        }, { allowDraft: true }).heldReplies.CLAIM, settingsResult.data.approved === true),
      };
    },
    loadContactIsTest: async (tenantId, contactId) => {
      const { data, error } = await client.from("contacts").select("tenant_id,is_test")
        .eq("tenant_id", tenantId).eq("id", contactId).single();
      if (error || !data || data.tenant_id !== tenantId) throw new Error("OUTBOUND_CONTACT_SCOPE_FAILED");
      return data.is_test;
    },
    persistInboundSafety,
    runEngine: async (input) => {
      const selection = input.qualificationState.outcome === "BOOK"
        ? await resolveLiveBookingSelection({ client, service: getBookingService(), engineInput: input })
        : { kind: "none" as const };
      const result = await runLivePreviewTurn({
        tenantId: input.tenantId,
        message: input.body,
        mode: "production",
        channel: input.channel === "webchat" ? "sms" : input.channel,
        leadMessageId: input.leadMessageId,
        conversation: {
          state: input.conversationState,
          currentStep: input.currentStep,
          currentStepAsks: input.currentStepAsks,
          disclosurePending: input.disclosurePending,
        },
        history: input.history,
        inboundSafety: input.inboundSafety,
        qualificationState: input.qualificationState,
        ...(selection.kind === "booked"
          ? { bookingSelection: { kind: "booked" as const, booking: selection.booking } }
          : selection.kind === "invalid"
            ? { bookingSelection: { kind: "invalid" as const } }
            : {}),
      }, { ...livePreviewDependencies(), persistInboundSafety });
      if (selection.kind === "no_slots") return withNoBookingSlotsFallback(result);
      if (selection.kind === "invalid" || selection.kind === "booked") return result;
      const bookingHandoff = result.commands.some(
        (command) => command.kind === "record_qualification_outcome" && command.outcome === "BOOK",
      );
      if (selection.kind !== "offer" && selection.kind !== "reoffer" && !bookingHandoff) return result;
      const bundle = await loadPublishedRuntimeBundle(input.tenantId);
      if (bundle.offer.bookingMode !== "direct") return result;
      let proposal = selection.kind === "reoffer" ? selection.proposal : null;
      if (!proposal) {
        const rangeStart = new Date();
        const rangeEnd = new Date(rangeStart.getTime() + bundle.offer.bookingHorizonDays * 86_400_000);
        const proposed = await getBookingService().proposeSlots({
          tenantId: input.tenantId,
          conversationId: input.conversationId,
          rangeStartAt: rangeStart.toISOString(),
          rangeEndAt: rangeEnd.toISOString(),
        });
        if (proposed.kind === "unavailable" && proposed.reason === "no_slots") {
          return withNoBookingSlotsFallback(result);
        }
        if (proposed.kind !== "offered") {
          throw new Error(`BOOKING_SLOT_PROPOSAL_${proposed.kind.toUpperCase()}`);
        }
        proposal = proposed.proposal;
      }
      return withBookingSlotOffer(result, proposal);
    },
    sendToLead: liveGateway,
    persistResult: async ({
      tenantId,
      inbound,
      result,
      providerMessageId,
      preTurnCurrentStep,
      preTurnCurrentStepAsks,
    }) => {
      const sendCommand = result.commands.find((command) => command.kind === "send");
      if (!sendCommand) throw new Error("ENGINE_SEND_COMMAND_REQUIRED");
      const transition = result.commands.find((command) => command.kind === "transition");
      const qualification = qualificationTurnRpcInput({
        tenantId,
        conversationId: inbound.conversationId,
        contactId: inbound.contactId,
        inboundMessageId: inbound.messageId,
        expectedCurrentStep: preTurnCurrentStep,
        expectedCurrentStepAsks: preTurnCurrentStepAsks,
        result,
      });
      if (qualification) {
        const { data, error } = await client.rpc("apply_qualification_turn", qualification);
        const row = Array.isArray(data) ? data[0] : data;
        if (error || !row || typeof row.replayed !== "boolean") {
          throw new Error("QUALIFICATION_TURN_PERSIST_FAILED");
        }
      }
      if (transition) {
        await persistHeldInboundResult({
          tenantId,
          conversationId: inbound.conversationId,
          providerMessageId,
          reason: transition.reason,
          result,
        }, {
          readOutboundMessage: async (input) => {
            const { data: message, error: messageError } = await client.from("messages")
              .select("id")
              .eq("tenant_id", input.tenantId)
              .eq("conversation_id", input.conversationId)
              .eq("provider_message_id", input.providerMessageId)
              .single();
            if (messageError || !message) throw new Error("OUTBOUND_MESSAGE_READBACK_FAILED");
            return { messageId: message.id };
          },
          transition: async (input) => {
            const { data, error } = await client.rpc("enter_needs_human_with_message", {
              p_expected_tenant: input.tenantId,
              p_conversation_id: input.conversationId,
              p_message_id: input.messageId,
              p_reason: input.reason,
            });
            const receipt = Array.isArray(data) ? data[0] : data;
            if (error || !receipt || receipt.message_id !== input.messageId) {
              throw new Error("NEEDS_HUMAN_EXISTING_MESSAGE_FAILED");
            }
          },
          writeTrace: writeMessageTrace,
        });
        return;
      }
      const persisted = await persistOrdinaryInboundResult({
        tenantId,
        conversationId: inbound.conversationId,
        leadMessageId: inbound.messageId,
        providerMessageId,
        preTurnCurrentStep,
        result,
      }, {
        readOutboundMessage: async (input) => {
          const { data: message, error: messageError } = await client.from("messages")
            .select("id")
            .eq("tenant_id", input.tenantId)
            .eq("conversation_id", input.conversationId)
            .eq("provider_message_id", input.providerMessageId)
            .single();
          if (messageError || !message) throw new Error("OUTBOUND_MESSAGE_READBACK_FAILED");
          return { messageId: message.id };
        },
        consumeDisclosure: async (input) => {
          const { data: conversation, error: disclosureError } = await client.from("conversations")
            .update({ disclosure_pending: false })
            .eq("tenant_id", input.tenantId)
            .eq("id", input.conversationId)
            .eq("disclosure_pending", true)
            .select("disclosure_pending")
            .maybeSingle();
          if (disclosureError) {
            throw new Error("DISCLOSURE_CONSUMPTION_PERSIST_FAILED");
          }
          if (!conversation) {
            const { data: replay, error: replayError } = await client.from("conversations")
              .select("disclosure_pending").eq("tenant_id", input.tenantId)
              .eq("id", input.conversationId).single();
            if (replayError || replay?.disclosure_pending !== false) {
              throw new Error("DISCLOSURE_CONSUMPTION_PERSIST_FAILED");
            }
          }
        },
        writeTrace: writeMessageTrace,
        recordStepEvents: recordConversationStepEvents,
      });
      const slotOffer = result.commands.find((command) => command.kind === "record_booking_slot_offer");
      if (slotOffer) {
        const { error } = await client.rpc("record_booking_slot_emission", {
          p_expected_tenant: tenantId,
          p_conversation_id: inbound.conversationId,
          p_contact_id: inbound.contactId,
          p_outbound_message_id: persisted.agentMessageId,
          p_slot_ids: slotOffer.slotIds,
          p_proposed_at: slotOffer.proposedAt,
          p_expires_at: slotOffer.expiresAt,
        });
        if (error) throw new Error("BOOKING_SLOT_EMISSION_WRITE_FAILED");
      }
      const booked = result.commands.find((command) => command.kind === "record_booking_intent");
      if (booked) {
        const { error } = await client.rpc("finalize_booking_slot_confirmation", {
          p_expected_tenant: tenantId,
          p_conversation_id: inbound.conversationId,
          p_inbound_message_id: inbound.messageId,
          p_outbound_message_id: persisted.agentMessageId,
          p_appointment_id: booked.booking.id,
          p_now: new Date().toISOString(),
        });
        if (error) throw new Error("BOOKING_SLOT_CONFIRMATION_FINALIZE_FAILED");
      }
      return persisted;
    },
    markReceipt: async ({ status, error }) => finishReceipt(status, error),
  };
}

export type ClaimedWebhookReceipt = WebhookReceiptRead & {
  attemptNumber: number;
  leaseToken: string;
  leaseExpiresAt: string;
};

type InboundReceiptRecoveryDependencies = {
  claim(input: { receiptId: string | null; limit: number }): Promise<readonly ClaimedWebhookReceipt[]>;
  finish(input: {
    receiptId: string;
    leaseToken: string;
    attemptNumber: number;
    status: "processed" | "failed" | "skipped";
    error: string | null;
    retryAt: string | null;
  }): Promise<boolean>;
  defer(input: {
    receiptId: string;
    leaseToken: string;
    attemptNumber: number;
    error: string;
    retryAt: string;
  }): Promise<boolean>;
};

export function nonBudgetInboundFailure(error: string | null) {
  const code = error?.split(":", 1)[0] ?? "";
  return code === "BOOKING_SLOT_SELECTION_BUSY" || code === "BOOKING_IN_PROGRESS" ||
    code === "BOOKING_REOFFER_PENDING";
}

function retryAt(attemptNumber: number, now = Date.now()) {
  const delayMs = Math.min(15 * 60_000, 15_000 * 2 ** Math.max(0, attemptNumber - 1));
  return new Date(now + delayMs).toISOString();
}

function claimedReceipt(row: Record<string, unknown>): ClaimedWebhookReceipt {
  const provider = row.provider;
  const status = row.status;
  if ((provider !== "ghl" && provider !== "meta") ||
    !["received", "processed", "failed", "skipped"].includes(String(status)) ||
    typeof row.receipt_id !== "string" || typeof row.provider_event_id !== "string" ||
    typeof row.tenant_id !== "string" || typeof row.event_type !== "string" ||
    !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) ||
    typeof row.attempt_number !== "number" || typeof row.lease_token !== "string" ||
    typeof row.lease_expires_at !== "string") {
    throw new Error("INBOUND_RECEIPT_CLAIM_INVALID");
  }
  return {
    id: row.receipt_id,
    inserted: false,
    provider,
    providerEventId: row.provider_event_id,
    tenantId: row.tenant_id,
    eventType: row.event_type,
    payload: row.payload as Record<string, unknown>,
    status: status as WebhookReceiptRead["status"],
    attemptNumber: row.attempt_number,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function liveInboundReceiptRecoveryDependencies(): InboundReceiptRecoveryDependencies {
  const client = createSupabaseServiceClient();
  return {
    claim: async ({ receiptId, limit }) => {
      const { data, error } = await client.rpc("claim_inbound_webhook_receipts", {
        p_limit: limit,
        p_lease_seconds: INBOUND_LEASE_SECONDS,
        p_now: new Date().toISOString(),
        p_receipt_id: receiptId,
      });
      if (error || !Array.isArray(data)) throw new Error("INBOUND_RECEIPT_CLAIM_FAILED");
      return data.map((row: Record<string, unknown>) => claimedReceipt(row));
    },
    finish: async (input) => {
      const { data, error } = await client.rpc("finish_inbound_webhook_receipt", {
        p_receipt_id: input.receiptId,
        p_lease_token: input.leaseToken,
        p_attempt_number: input.attemptNumber,
        p_status: input.status,
        p_error: input.error,
        p_retry_at: input.retryAt,
      });
      if (error || typeof data !== "boolean") throw new Error("INBOUND_RECEIPT_FINISH_FAILED");
      return data;
    },
    defer: async (input) => {
      const { data, error } = await client.rpc("defer_inbound_webhook_receipt", {
        p_receipt_id: input.receiptId,
        p_lease_token: input.leaseToken,
        p_attempt_number: input.attemptNumber,
        p_error: input.error,
        p_retry_at: input.retryAt,
      });
      if (error || typeof data !== "boolean") throw new Error("INBOUND_RECEIPT_DEFER_FAILED");
      return data;
    },
  };
}

async function processClaimedLiveWebhookReceipt(
  receipt: ClaimedWebhookReceipt,
  dependencies: InboundReceiptRecoveryDependencies,
) {
  const finish = async (
    status: "processed" | "failed" | "skipped",
    error: string | null,
  ) => {
    if (status === "failed" && nonBudgetInboundFailure(error)) {
      const deferred = await dependencies.defer({
        receiptId: receipt.id,
        leaseToken: receipt.leaseToken,
        attemptNumber: receipt.attemptNumber,
        error: error ?? "INBOUND_DEPENDENCY_BUSY",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
      });
      if (!deferred) throw new Error("INBOUND_RECEIPT_LEASE_LOST");
      return;
    }
    const terminalFailure = status === "failed" && receipt.attemptNumber >= INBOUND_MAX_ATTEMPTS;
    const finished = await dependencies.finish({
      receiptId: receipt.id,
      leaseToken: receipt.leaseToken,
      attemptNumber: receipt.attemptNumber,
      status,
      error: terminalFailure
        ? `INBOUND_ATTEMPT_BUDGET_EXHAUSTED:${error ?? "INBOUND_PROCESSING_FAILED"}`
        : error,
      retryAt: status === "failed" && receipt.attemptNumber < INBOUND_MAX_ATTEMPTS
        ? retryAt(receipt.attemptNumber)
        : terminalFailure
          ? new Date("9999-12-31T23:59:59.999Z").toISOString()
          : null,
    });
    if (!finished) throw new Error("INBOUND_RECEIPT_LEASE_LOST");
  };

  // Lifecycle receipts carry an install envelope, not a normalized message batch. UNINSTALL is
  // named here explicitly so it can never fall through to the inbound engine.
  if (!receipt.tenantId || receipt.eventType === "INSTALL" || receipt.eventType === "UNINSTALL") {
    return null;
  }
  let batch: NormalizedInboundBatch;
  try {
    batch = normalizedBatch(receipt.payload.normalized);
  } catch (error) {
    await finish("failed", "INBOUND_RECEIPT_INVALID");
    throw error;
  }
  return processInboundReceipt({
    id: receipt.id,
    leaseToken: receipt.leaseToken,
    attemptNumber: receipt.attemptNumber,
    tenantId: receipt.tenantId,
    provider: receipt.provider === "ghl" ? "ghl" : "meta_direct",
    batch,
  }, liveInboundDependencies(finish));
}

/** What one processed receipt did per event, as the processor itself reports it. */
export type ProcessedInboundBatch = Awaited<ReturnType<typeof processInboundReceipt>>;

/**
 * Live composition first acquires database custody, so request callbacks and recovery workers race
 * safely. Resolves to the processor's own per-event outcome, or null when the receipt was not ours
 * to claim or carried a lifecycle envelope rather than a message batch.
 */
export async function processLiveWebhookReceipt(
  receipt: WebhookReceiptRead,
  dependencies: InboundReceiptRecoveryDependencies = liveInboundReceiptRecoveryDependencies(),
): Promise<ProcessedInboundBatch | null> {
  const [claimed] = await dependencies.claim({ receiptId: receipt.id, limit: 1 });
  if (!claimed) return null;
  return (await processClaimedLiveWebhookReceipt(claimed, dependencies)) ?? null;
}

/** Independently retries ordinary GHL and Meta receipts after request-scoped work exits. */
export async function recoverInboundWebhookReceipts(
  limit: number,
  dependencies: InboundReceiptRecoveryDependencies = liveInboundReceiptRecoveryDependencies(),
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("INBOUND_RECOVERY_LIMIT_INVALID");
  }
  const claims = await dependencies.claim({ receiptId: null, limit });
  let processed = 0;
  let failed = 0;
  for (const receipt of claims) {
    try {
      await processClaimedLiveWebhookReceipt(receipt, dependencies);
      processed += 1;
    } catch {
      failed += 1;
    }
  }
  return { claimed: claims.length, processed, failed };
}

/** The receipt key remains tenant-scoped even though the provider inbox has a global unique key. */
export function tenantReceiptEventId(input: {
  tenantId: string | null;
  eventId: string;
  providerMessageId: string | null;
  unresolvedScope?: string | null;
}) {
  const scope = input.tenantId?.trim() || `unmatched:${input.unresolvedScope?.trim() || "unknown"}`;
  return [scope, input.eventId.trim(), input.providerMessageId?.trim() || "no-message"].join(":");
}

export type WebhookReceiptWrite = {
  provider: "ghl" | "meta";
  providerEventId: string;
  tenantId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
};

export type WebhookReceiptRead = WebhookReceiptWrite & {
  id: string;
  inserted: boolean;
  status: "received" | "processed" | "failed" | "skipped";
};

type ReceiptResult = {
  data: Record<string, unknown> | null;
  error: { message: string } | null;
};

type ReceiptFilter = {
  eq(column: string, value: string): ReceiptFilter;
  maybeSingle(): Promise<ReceiptResult>;
};

type ReceiptMutationFilter = {
  eq(column: string, value: string): ReceiptMutationFilter;
  is(column: string, value: null): ReceiptMutationFilter;
  select(columns: string): { maybeSingle(): Promise<ReceiptResult> };
};

type ReceiptClient = {
  from(name: "webhook_events"): {
    upsert(
      row: Record<string, unknown>,
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): {
      select(columns: string): {
        maybeSingle(): Promise<ReceiptResult>;
      };
    };
    update(row: Record<string, unknown>): ReceiptMutationFilter;
    select(columns: string): ReceiptFilter;
  };
};

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .filter((key) => row[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("WEBHOOK_RECEIPT_PAYLOAD_INVALID");
  return serialized;
}

/** Durable provider inbox repository. Its read-back reasserts tenant scope after BYPASSRLS. */
export async function persistWebhookReceipt(
  input: WebhookReceiptWrite,
  client: ReceiptClient = createSupabaseServiceClient() as unknown as ReceiptClient,
): Promise<WebhookReceiptRead> {
  const providerEventId = input.providerEventId.trim();
  const eventType = input.eventType.trim();
  if (!providerEventId) throw new Error("WEBHOOK_EVENT_ID_REQUIRED");
  if (!eventType) throw new Error("WEBHOOK_EVENT_TYPE_REQUIRED");
  const payloadIdentity = canonicalJson(input.payload);
  const row = {
    provider: input.provider,
    provider_event_id: providerEventId,
    tenant_id: input.tenantId,
    event_type: eventType,
    signature_verified: true,
    payload: input.payload,
    status: "received",
  };
  const inserted = await client
    .from("webhook_events")
    .upsert(row, { onConflict: "provider,provider_event_id", ignoreDuplicates: true })
    .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
    .maybeSingle();
  if (inserted.error) throw new Error(`WEBHOOK_RECEIPT_WRITE_FAILED:${inserted.error.message}`);

  let persisted = inserted.data;
  let wasInserted = Boolean(persisted);
  if (!persisted) {
    const existing = await client
      .from("webhook_events")
      .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
      .eq("provider", input.provider)
      .eq("provider_event_id", providerEventId)
      .maybeSingle();
    if (existing.error || !existing.data) {
      throw new Error(`WEBHOOK_RECEIPT_READ_FAILED:${existing.error?.message ?? "empty"}`);
    }
    persisted = existing.data;
    wasInserted = false;
  }
  if (!persisted) throw new Error("WEBHOOK_RECEIPT_READ_FAILED:empty");
  if (persisted.provider !== input.provider || persisted.provider_event_id !== providerEventId) {
    throw new Error("WEBHOOK_RECEIPT_TENANT_MISMATCH");
  }
  if (
    persisted.event_type !== eventType
    || canonicalJson(persisted.payload) !== payloadIdentity
  ) {
    throw new Error("WEBHOOK_RECEIPT_IDENTITY_MISMATCH");
  }
  if (persisted.tenant_id !== input.tenantId) {
    const canPromoteInstallTenant = input.provider === "ghl"
      && eventType === "INSTALL"
      && persisted.tenant_id === null
      && input.tenantId !== null;
    if (!canPromoteInstallTenant) throw new Error("WEBHOOK_RECEIPT_TENANT_MISMATCH");
    const promoted = await client.from("webhook_events")
      .update({ tenant_id: input.tenantId })
      .eq("id", String(persisted.id))
      .is("tenant_id", null)
      .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
      .maybeSingle();
    if (promoted.error) {
      throw new Error(`WEBHOOK_RECEIPT_TENANT_PROMOTION_FAILED:${promoted.error.message}`);
    }
    if (promoted.data) {
      persisted = promoted.data;
    } else {
      const raced = await client.from("webhook_events")
        .select("id, provider, provider_event_id, tenant_id, event_type, payload, status")
        .eq("provider", input.provider)
        .eq("provider_event_id", providerEventId)
        .maybeSingle();
      if (raced.error || !raced.data) {
        throw new Error(`WEBHOOK_RECEIPT_READ_FAILED:${raced.error?.message ?? "empty"}`);
      }
      persisted = raced.data;
    }
    if (persisted.tenant_id !== input.tenantId) {
      throw new Error("WEBHOOK_RECEIPT_TENANT_MISMATCH");
    }
  }
  if (!persisted.payload || typeof persisted.payload !== "object" || Array.isArray(persisted.payload)) {
    throw new Error("WEBHOOK_RECEIPT_READ_FAILED:payload");
  }
  return {
    id: String(persisted.id),
    provider: persisted.provider as WebhookReceiptRead["provider"],
    providerEventId: String(persisted.provider_event_id),
    tenantId: persisted.tenant_id === null ? null : String(persisted.tenant_id),
    eventType: String(persisted.event_type),
    payload: persisted.payload as Record<string, unknown>,
    status: persisted.status as WebhookReceiptRead["status"],
    inserted: wasInserted,
  };
}
