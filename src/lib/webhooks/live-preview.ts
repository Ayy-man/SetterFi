/**
 * Side-effect-free engine preview assembly.
 *
 * Production inbound orchestration owns sends, booking, billing, and channel persistence. Preview
 * callers deliberately stop at engine commands so a test turn cannot acquire a real-world effect
 * merely by importing the production webhook processor.
 */

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import {
  engineBrainFromRuntimeBundle,
  engineOfferFromRuntimeBundle,
  runEngineTurn,
  type EnginePipelineDependencies,
  type EnginePipelineInput,
} from "@/lib/engine/pipeline";
import { activeModelConfigurations } from "@/lib/engine/model-config";
import type { InboundSafetyInput, InboundSafetyPersistence } from "@/lib/engine/inbound-safety";
import {
  MODERATOR_CLASSES,
  type BrainSnapshot,
  type CoachOffer,
  type ModeratorClass,
  type RuntimeQualificationState,
} from "@/lib/engine/types";
import { environmentValue, phase2Live } from "@/lib/env-contract";
import {
  createMockModelDriver,
  createMockModeratorDriver,
  createRealModelDriver,
  createRealModeratorDriver,
} from "@/lib/integrations/openrouter";
import { selectModelDrivers } from "@/lib/integrations/selector";
import type { ModelDriver, ModeratorDriver } from "@/lib/integrations/types";
import { loadPublishedRuntimeBundle } from "@/lib/repositories/brain-runtime";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadLiveLegacyOfferEngineInput } from "@/lib/webhooks/offer-engine-input";

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

export type LivePreviewHistoryEntry = {
  role: "user" | "assistant";
  content: string;
};

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
  qualificationState?: RuntimeQualificationState;
  bookingSelection?: EnginePipelineInput["bookingSelection"];
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

/** Runs the real engine without importing any module that can send, book, or bill. */
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
    history: [
      ...(input.history ?? []).map((entry) => typeof entry === "string"
        ? { role: "user" as const, content: entry }
        : entry),
      { role: "user" as const, content: input.message },
    ],
    leadMessage: { id: input.leadMessageId ?? "preview", body: input.message },
    tagSecret,
    automatedExperienceDisclosure: content.automatedExperienceDisclosure,
    heldReplies: content.heldReplies,
    linkWhitelist: runtimeBundle ? publishedLinkWhitelist(runtimeBundle) : [],
    roleBoundary: content.roleBoundary,
    modelConfigs,
    currentQuestion: null,
    extractionCandidate: null,
    qualificationState: input.qualificationState ?? {
      credit: null,
      goal: null,
      timeline: null,
      businessStage: null,
      annualRevenueCents: null,
      outcome: null,
      dqReason: null,
    },
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
