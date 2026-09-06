/**
 * Shared value contracts for the Phase 1 engine.
 *
 * These types contain no persistence or provider behavior. The engine returns commands in these
 * shapes so the route/RPC lane can apply them atomically without importing a provider adapter here.
 */

import type {
  KnowledgeNumberBinding,
  PublishedCoachOffer,
  PublishedOfferAsset,
  PublishedOfferPrice,
} from "@/lib/brain/contracts";
import type {
  CreditRange,
  FundingGoal,
  FundingTimeline,
  QualificationOutcome,
} from "@/lib/domain/qualification";

export const OUTPUT_CHECK_CLASSES = ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN"] as const;
export type OutputCheckClass = (typeof OUTPUT_CHECK_CLASSES)[number];

export const MODERATOR_CLASSES = [...OUTPUT_CHECK_CLASSES, "JUDGE", "REVOKE"] as const;
export type ModeratorClass = (typeof MODERATOR_CLASSES)[number];

// REVOKE is an approved held-reply class, not a verdict a moderator may emit. Keeping the
// persisted evidence narrower makes the database contract match the moderator envelope.
export const MODERATOR_EVIDENCE_CLASSES = [...OUTPUT_CHECK_CLASSES, "JUDGE"] as const;
export type ModeratorEvidenceClass = (typeof MODERATOR_EVIDENCE_CLASSES)[number];

export const CONVERSATION_STATES = [
  "agent",
  "needs_human",
  "human",
  "nurture",
  "closed",
  "scope_blocked",
  "opted_out",
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * What a runtime-backed entry knows about its own figures. `answer` is the tenant-rendered text;
 * `responseTemplate` is the immutable text the bindings were reviewed against. Absent on the
 * Phase 1 legacy path, where an entry has no review record and every number in it grounds itself.
 */
export type BrainEntryProvenance = {
  responseTemplate: string;
  numberBindings: readonly KnowledgeNumberBinding[];
  rewriteHash: string | null;
};

export type PublishedBrainEntry = {
  id: string;
  category: string;
  question: string;
  answer: string;
  published: boolean;
  provenance?: BrainEntryProvenance;
};

export type BrainSnapshot = {
  version: number;
  compiledPlatform?: string;
  platformFrame: string;
  mission: string;
  qualification: string;
  complianceRules: readonly ComplianceRule[];
  entries: readonly PublishedBrainEntry[];
  knowledgeMode: "inline" | "retrieved";
  /** Per-snapshot override of the retrieval similarity floor; see `@/lib/brain/retrieval`. */
  retrievalFloor?: number;
};

export type OfferPrice = {
  id: string;
  label: string;
  amountCents: number;
};

export type CoachOffer = Pick<
  PublishedCoachOffer,
  | "tenantId"
  | "version"
  | "programName"
  | "creditMin"
  | "fundingGoalMinCents"
  | "bookingHorizonDays"
> & {
  products: readonly string[];
  brandVoice: string;
  voiceAnswers: readonly string[];
  /** The coach's own rules, each already one sentence; see `@/lib/offer/rules`. */
  qualificationRules: readonly string[];
  /** The coach's paragraph on how the agent should sound, or null when none was written. */
  voiceGuidelines: string | null;
  proof: readonly string[];
  assets: readonly Pick<PublishedOfferAsset, "slug" | "url">[];
  offerPrices: readonly Pick<PublishedOfferPrice, "id" | "label" | "amountCents">[];
};

export type ConversationPromptState = {
  state: ConversationState;
  currentStep: string | null;
  currentStepAsks: number;
  disclosurePending: boolean;
};

export type ComplianceRule = {
  id: `${string}-${number}`;
  phrase: string;
};

export type NumberKind = "currency" | "percentage" | "score";
export type NumberSourceType =
  | "offer_price"
  | "qualification_threshold"
  | "brain_entry"
  | "lead_message";

export type NumberSource = {
  kind: NumberKind;
  value: number;
  sourceType: NumberSourceType;
  sourceId: string;
};

export type CheckViolation = {
  class: OutputCheckClass;
  ruleId: string;
  evidence: string;
};

export type CheckResult = {
  class: OutputCheckClass;
  passed: boolean;
  ruleIds: readonly string[];
  evidence: readonly string[];
};

export type ModeratorState = "allowed" | "blocked" | "unavailable" | "not_run";

export type RetrievalCitation = {
  entryId: string;
  content: string;
  similarity: number;
  categoryBoost: 0 | 0.05;
  score: number;
  categoryAgreement: boolean;
};

export type ModelReplyEnvelope = {
  reply: string;
  citation_entry_id: string;
};

/**
 * Identity only. No `label`, no `response` — the objection's text belongs to the retrieval result
 * that 10-03 will consume, and keeping it out of the trace is what stops anything downstream
 * treating an objection body as a retrieved knowledge answer.
 */
export type ObjectionMatch = {
  snapshotId: string;
  objectionId: string;
  hardGate: boolean;
};

export type EngineTrace = {
  brainVersion: number;
  offerVersion: number;
  brainContentHash: string | null;
  offerContentHash: string | null;
  knowledgeMode: "inline" | "retrieved";
  promptHash: string | null;
  model: string | null;
  paramsHash: string | null;
  ruleFired: string | null;
  sources: readonly RetrievalCitation[];
  declaredEntryId: string | null;
  declaredEntryVerified: boolean;
  retrievalTopThree: readonly RetrievalCitation[];
  droppedEntryIds: readonly string[];
  numberAllowlist: readonly NumberSource[];
  objection: ObjectionMatch | null;
  checks: readonly CheckResult[];
  violations: readonly CheckViolation[];
  rejectedDrafts: readonly string[];
  attempts: number;
  screen: { verdict: "continue" | "held"; reason: string | null };
  latencyMs: number | null;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
  cost: number | null;
  moderator: ModeratorState;
  moderatorReason: string | null;
  moderatorClass: ModeratorEvidenceClass | null;
  moderatorRuleId: string | null;
  moderatorModelConfigId: string | null;
};

export type BookingResponse = {
  id: string;
  startAt: string;
  timezone: string;
} | null;

export type LeadResponse = {
  reply: string;
  state: ConversationState;
  booking: BookingResponse;
};

export type QualificationQuestion =
  | { id: string; field: "credit"; type: "credit_range" }
  | { id: string; field: "goal"; type: "funding_goal" }
  | { id: string; field: "timeline"; type: "funding_timeline" }
  | { id: string; field: "businessStage"; type: "business_stage" }
  | { id: string; field: "annualRevenue"; type: "annual_revenue_cents" };

export type QualificationValue =
  | { field: "credit"; value: string }
  | { field: "goal"; value: FundingGoal }
  | { field: "timeline"; value: FundingTimeline }
  | { field: "businessStage"; value: "startup" | "operating" | "unknown" }
  | { field: "annualRevenue"; value: number };

export type RuntimeQualificationState = {
  credit: CreditRange | null;
  goal: FundingGoal | null;
  timeline: FundingTimeline | null;
  businessStage: "startup" | "operating" | "unknown" | null;
  annualRevenueCents: number | null;
  outcome: QualificationOutcome | null;
  dqReason: string | null;
};

export type EngineCommand =
  | { kind: "persist_qualification"; stepId: string; value: QualificationValue }
  | {
      kind: "advance_step";
      stepId: string;
      valuePersisted: boolean;
      nextAskCount: 0;
      nextStepId?: string | null;
    }
  | { kind: "increment_step_asks"; stepId: string; nextAskCount: number }
  | { kind: "record_hard_dq"; reason: string }
  | { kind: "record_qualification_outcome"; outcome: "BOOK" | "SOFT_DQ"; ruleId: string }
  | { kind: "record_booking_intent"; booking: NonNullable<BookingResponse> }
  | {
      kind: "record_booking_slot_offer";
      slotIds: readonly string[];
      proposedAt: string;
      expiresAt: string;
    }
  | { kind: "persist_agent_turn"; body: string; disclosureConsumed: boolean }
  | { kind: "send"; body: string; approvedInput: boolean }
  | {
      kind: "transition";
      state: "needs_human";
      reason: "output_check_failed" | "no_match_threshold";
    }
  | { kind: "alert"; eventKey: "conversation.needs_human" }
  | { kind: "audit"; actionKey: "conversation.escalated" }
  | { kind: "increment_moderator_unavailable"; counter: "model_configs.moderator_unavailable_count"; by: 1 };

export type EngineTurnResult = {
  response: LeadResponse;
  commands: readonly EngineCommand[];
  trace: EngineTrace;
};
