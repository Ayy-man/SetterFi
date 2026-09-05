/**
 * Pure orchestration for one grounded agent turn.
 *
 * Provider and persistence I/O are injected or returned as commands. In particular this module
 * cannot import an outbound adapter, so a send command exists only after checks and moderation.
 */

import { createHash } from "node:crypto";
import { ruleSentences } from "@/lib/offer/rules";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import {
  retrieveForTurn,
  type RetrieveForTurnInput,
  type TurnRetrievalResult,
} from "@/lib/brain/retrieval";
import {
  CREDIT_RANGES,
  FUNDING_GOALS,
  FUNDING_TIMELINES,
  type CreditRange,
  type QualificationRule,
} from "@/lib/domain/qualification";
import {
  buildNumberSources,
  decideCheckAttempt,
  leadResponse,
  runOutputChecks,
  type OutputCheckContext,
} from "@/lib/engine/output-checks";
import {
  resolveInboundSafety,
  type InboundSafetyDecision,
  type InboundSafetyInput,
  type InboundSafetyPersistence,
} from "@/lib/engine/inbound-safety";
import { loadActiveModelPair, type ModelConfigRow } from "@/lib/engine/model-config";
import { moderateDraft, type ModeratorCall } from "@/lib/engine/moderator";
import { assemblePrompt, regenerationInstruction } from "@/lib/engine/prompt";
import { applyAutomatedExperienceDisclosure } from "@/lib/engine/renderer";
import {
  retrievePublishedEntries,
  verifyCitationDeclaration,
} from "@/lib/engine/retrieval";
import {
  MODERATOR_CLASSES,
  type BookingResponse,
  type CheckResult,
  type CheckViolation,
  type BrainSnapshot,
  type CoachOffer,
  type ComplianceRule,
  type EngineCommand,
  type EngineTrace,
  type EngineTurnResult,
  type ModeratorClass,
  type ModelReplyEnvelope,
  type PromptMessage,
  type QualificationQuestion,
  type RuntimeQualificationState,
  type QualificationValue,
} from "@/lib/engine/types";
import type { ModelDriver } from "@/lib/integrations/types";

export type EnginePipelineInput = {
  mode: "production" | "test" | "eval";
  channel: OutputCheckContext["channel"];
  brain: Parameters<typeof assemblePrompt>[0]["brain"];
  offer: Parameters<typeof assemblePrompt>[0]["offer"];
  conversation: Parameters<typeof assemblePrompt>[0]["state"];
  history: readonly PromptMessage[];
  leadMessage: { id: string; body: string };
  tagSecret: string;
  automatedExperienceDisclosure: string;
  heldReplies: Record<ModeratorClass, string>;
  linkWhitelist: readonly string[];
  roleBoundary: string;
  modelConfigs: readonly ModelConfigRow[];
  currentQuestion: QualificationQuestion | null;
  extractionCandidate: unknown;
  qualificationState?: RuntimeQualificationState;
  decision?: { outcome: "HARD_DQ"; reason: string } | null;
  booking?: BookingResponse;
  bookingSelection?:
    | { kind: "booked"; booking: NonNullable<BookingResponse> }
    | { kind: "invalid" };
  declaredEntryId?: string | null;
  runtimeBundle?: PublishedRuntimeBundle;
  inboundSafety?: InboundSafetyInput;
};

export type EnginePipelineDependencies = {
  model: ModelDriver;
  moderator: { moderate: ModeratorCall };
  retrieve?: (input: RetrieveForTurnInput) => Promise<TurnRetrievalResult>;
  persistInboundSafety?: InboundSafetyPersistence;
};

function paramsHash(params: Record<string, unknown>) {
  return createHash("sha256").update(JSON.stringify(params)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function engineOfferFromRuntimeBundle(bundle: PublishedRuntimeBundle): CoachOffer {
  const offer = bundle.offer;
  return {
    tenantId: offer.tenantId,
    version: offer.version,
    programName: offer.programName,
    products: offer.products,
    brandVoice: offer.brandVoice ?? "",
    voiceAnswers: [
      offer.voiceStyleAnswer,
      offer.voiceObjectionAnswer,
      offer.voiceFollowupAnswer,
    ].filter((value): value is string => Boolean(value)),
    qualificationRules: ruleSentences(offer.qualificationRules),
    voiceGuidelines: offer.voiceGuidelines,
    proof: offer.proof.map((entry) => `${entry.title}: ${entry.detail}`),
    assets: offer.assets.map(({ slug, url }) => ({ slug, url })),
    offerPrices: offer.offerPrices.map(({ id, label, amountCents }) => ({ id, label, amountCents })),
    creditMin: offer.creditMin,
    fundingGoalMinCents: offer.fundingGoalMinCents,
    bookingHorizonDays: offer.bookingHorizonDays,
  };
}

function publishedComplianceRules(bundle: PublishedRuntimeBundle): ComplianceRule[] {
  const entities = bundle.brain.payload.entities;
  if (!Array.isArray(entities)) return [];
  return entities.flatMap((candidate) => {
    if (!isRecord(candidate) || candidate.type !== "compliance_rule" || !isRecord(candidate.value)) {
      return [];
    }
    const id = typeof candidate.id === "string" ? candidate.id : "";
    const phrase = typeof candidate.value.phrase === "string" ? candidate.value.phrase.trim() : "";
    return /^[A-Z]{3,5}-\d{3}$/.test(id) && phrase
      ? [{ id: id as `${string}-${number}`, phrase }]
      : [];
  });
}

export function engineBrainFromRuntimeBundle(bundle: PublishedRuntimeBundle): BrainSnapshot {
  return {
    version: bundle.brainVersion,
    compiledPlatform: bundle.brain.compiledPlatform,
    platformFrame: "",
    mission: "",
    qualification: "",
    complianceRules: publishedComplianceRules(bundle),
    entries: [],
    knowledgeMode: bundle.brain.knowledgeMode,
  };
}

function modelReplyEnvelope(value: string): ModelReplyEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Object.keys(parsed).sort().join(",") !== "citation_entry_id,reply") {
    return null;
  }
  if (
    typeof parsed.reply !== "string" || !parsed.reply.trim() ||
    typeof parsed.citation_entry_id !== "string" || !parsed.citation_entry_id.trim()
  ) return null;
  return { reply: parsed.reply, citation_entry_id: parsed.citation_entry_id };
}

function citationRegenerationInstruction() {
  return "Regenerate the reply once as the required JSON object and declare one supplied entry_id. Do not repeat or quote the rejected wording.";
}

export function validateQualificationExtraction(
  question: QualificationQuestion,
  candidate: unknown,
): QualificationValue | null {
  if (!isRecord(candidate) || candidate.field !== question.field) return null;
  if (question.type === "credit_range") {
    return typeof candidate.value === "string" && CREDIT_RANGES.includes(candidate.value as CreditRange)
      ? { field: "credit", value: candidate.value }
      : null;
  }
  if (question.type === "funding_goal") {
    return typeof candidate.value === "string" && FUNDING_GOALS.includes(candidate.value as (typeof FUNDING_GOALS)[number])
      ? { field: "goal", value: candidate.value as (typeof FUNDING_GOALS)[number] }
      : null;
  }
  if (question.type === "funding_timeline") {
    return typeof candidate.value === "string" && FUNDING_TIMELINES.includes(candidate.value as (typeof FUNDING_TIMELINES)[number])
      ? { field: "timeline", value: candidate.value as (typeof FUNDING_TIMELINES)[number] }
      : null;
  }
  if (question.type === "annual_revenue_cents") {
    return Number.isSafeInteger(candidate.value) && Number(candidate.value) >= 0
      ? { field: "annualRevenue", value: Number(candidate.value) }
      : null;
  }
  return candidate.value === "startup" || candidate.value === "operating" || candidate.value === "unknown"
    ? { field: "businessStage", value: candidate.value }
    : null;
}

type RuntimeRuleFact = "credit" | "businessStage" | "annualRevenue" | "goal" | "timeline";
type RuntimeRuleEvaluation = "match" | "fail" | { unknown: RuntimeRuleFact };
type RuntimeQualificationDecision = {
  outcome: "BOOK" | "SOFT_DQ" | "HARD_DQ";
  ruleId: string;
  reason: string;
};

type RuntimeQualificationTurn = {
  commands: EngineCommand[];
  currentQuestion: QualificationQuestion | null;
  decision: RuntimeQualificationDecision | null;
  effectiveState: RuntimeQualificationState;
};

const CREDIT_BANDS: Record<CreditRange, readonly [number, number] | null> = {
  "below 600": [300, 599],
  "600–640": [600, 639],
  "640–680": [640, 679],
  "680–700": [680, 699],
  "700+": [700, 850],
  unknown: null,
};

function questionFor(field: RuntimeRuleFact): QualificationQuestion {
  if (field === "credit") return { id: "qualification:credit", field, type: "credit_range" };
  if (field === "businessStage") {
    return { id: "qualification:businessStage", field, type: "business_stage" };
  }
  if (field === "annualRevenue") {
    return { id: "qualification:annualRevenue", field, type: "annual_revenue_cents" };
  }
  if (field === "goal") return { id: "qualification:goal", field, type: "funding_goal" };
  return { id: "qualification:timeline", field, type: "funding_timeline" };
}

function evaluateRuntimeRule(
  rule: QualificationRule,
  state: RuntimeQualificationState,
): RuntimeRuleEvaluation {
  const { conditions } = rule;
  if (conditions.minScore !== undefined || conditions.maxScore !== undefined) {
    const band = state.credit ? CREDIT_BANDS[state.credit] : null;
    if (!band) return { unknown: "credit" };
    if (conditions.minScore !== undefined && band[1] < conditions.minScore) return "fail";
    if (conditions.maxScore !== undefined && band[0] > conditions.maxScore) return "fail";
    if (conditions.minScore !== undefined && band[0] < conditions.minScore) return { unknown: "credit" };
    if (conditions.maxScore !== undefined && band[1] > conditions.maxScore) return { unknown: "credit" };
  }
  if (conditions.businessStage !== undefined) {
    if (state.businessStage === null) return { unknown: "businessStage" };
    if (state.businessStage !== conditions.businessStage) return "fail";
  }
  if (conditions.minAnnualRevenue !== undefined) {
    if (state.annualRevenueCents === null) return { unknown: "annualRevenue" };
    if (state.annualRevenueCents < conditions.minAnnualRevenue * 100) return "fail";
  }
  if (conditions.fundingGoals !== undefined) {
    if (state.goal === null) return { unknown: "goal" };
    if (!conditions.fundingGoals.includes(state.goal)) return "fail";
  }
  if (conditions.timelines !== undefined) {
    if (state.timeline === null) return { unknown: "timeline" };
    if (!conditions.timelines.includes(state.timeline)) return "fail";
  }
  return "match";
}

export function resolveRuntimeQualification(
  rules: readonly QualificationRule[],
  state: RuntimeQualificationState,
): { question: QualificationQuestion | null; decision: RuntimeQualificationDecision | null } {
  for (const rule of rules) {
    const evaluation = evaluateRuntimeRule(rule, state);
    if (evaluation === "fail") continue;
    if (evaluation === "match") {
      return {
        question: null,
        decision: {
          outcome: rule.outcome,
          ruleId: rule.id,
          reason: `published_qualification_rule:${rule.id}`,
        },
      };
    }
    return { question: questionFor(evaluation.unknown), decision: null };
  }
  return { question: null, decision: null };
}

function creditRangeForScore(score: number): CreditRange | null {
  if (!Number.isInteger(score) || score < 300 || score > 850) return null;
  if (score < 600) return "below 600";
  if (score < 640) return "600–640";
  if (score < 680) return "640–680";
  if (score < 700) return "680–700";
  return "700+";
}

function parseMoneyAmount(body: string) {
  const match = body.trim().match(/^\$?([0-9]{1,3}(?:,[0-9]{3})*|[0-9]+)(?:\.([0-9]{1,2}))?\s*([km])?$/iu);
  if (!match) return null;
  const base = Number(match[1].replaceAll(",", "")) + Number(`0.${match[2] ?? "0"}`);
  const multiplier = match[3]?.toLowerCase() === "m" ? 1_000_000
    : match[3]?.toLowerCase() === "k" ? 1_000 : 1;
  const cents = Math.round(base * multiplier * 100);
  return Number.isSafeInteger(cents) && cents >= 0 ? cents : null;
}

export function extractRuntimeQualification(
  question: QualificationQuestion,
  body: string,
): QualificationValue | null {
  const normalized = body.trim().replaceAll("-", "–");
  if (question.type === "credit_range") {
    const canonical = CREDIT_RANGES.find((value) => value.toLowerCase() === normalized.toLowerCase());
    if (canonical) return { field: "credit", value: canonical };
    const numeric = normalized.match(/^(?:my (?:credit )?score is\s*)?(\d{3})\+?$/iu);
    const range = numeric ? creditRangeForScore(Number(numeric[1])) : null;
    return range ? { field: "credit", value: range } : null;
  }
  if (question.type === "funding_goal") {
    const canonical = FUNDING_GOALS.find((value) => value.toLowerCase() === normalized.toLowerCase());
    if (canonical) return { field: "goal", value: canonical };
    const cents = parseMoneyAmount(normalized.replace(/^(?:my )?(?:funding )?goal is\s*/iu, ""));
    if (cents === null) return null;
    if (cents < 5_000_000) return { field: "goal", value: "<$50K" };
    if (cents < 10_000_000) return { field: "goal", value: "$50K–100K" };
    if (cents < 15_000_000) return { field: "goal", value: "$100K–150K" };
    return { field: "goal", value: "$150K+" };
  }
  if (question.type === "funding_timeline") {
    const aliases: Record<string, (typeof FUNDING_TIMELINES)[number]> = {
      "asap": "ASAP–30d", "asap–30d": "ASAP–30d", "within 30 days": "ASAP–30d",
      "1–3mo": "1–3mo", "1 to 3 months": "1–3mo", "1–3 months": "1–3mo",
      "3–6mo": "3–6mo", "3 to 6 months": "3–6mo", "3–6 months": "3–6mo",
      "exploring": "exploring", "just exploring": "exploring",
    };
    const timeline = aliases[normalized.toLowerCase()];
    return timeline ? { field: "timeline", value: timeline } : null;
  }
  if (question.type === "business_stage") {
    const stage = normalized.toLowerCase();
    return stage === "startup" || stage === "operating" || stage === "unknown"
      ? { field: "businessStage", value: stage }
      : null;
  }
  const revenueBody = normalized.replace(/^(?:my )?(?:annual )?revenue is\s*/iu, "");
  const cents = parseMoneyAmount(revenueBody);
  return cents === null ? null : { field: "annualRevenue", value: cents };
}

function stateWithExtraction(
  state: RuntimeQualificationState,
  extraction: QualificationValue,
): RuntimeQualificationState {
  if (extraction.field === "credit") return { ...state, credit: extraction.value as CreditRange };
  if (extraction.field === "goal") return { ...state, goal: extraction.value };
  if (extraction.field === "timeline") return { ...state, timeline: extraction.value };
  if (extraction.field === "businessStage") return { ...state, businessStage: extraction.value };
  return { ...state, annualRevenueCents: extraction.value };
}

export function planRuntimeQualificationTurn(input: {
  rules: readonly QualificationRule[];
  state: RuntimeQualificationState;
  leadBody: string;
  persistedCurrentStep: string | null;
  currentStepAsks: number;
}): RuntimeQualificationTurn {
  const before = resolveRuntimeQualification(input.rules, input.state);
  if (input.state.outcome) {
    return { commands: [], currentQuestion: null, decision: null, effectiveState: input.state };
  }
  if (!before.question || before.decision) {
    return { commands: [], currentQuestion: before.question, decision: before.decision, effectiveState: input.state };
  }
  const extraction = extractRuntimeQualification(before.question, input.leadBody);
  if (!extraction) {
    const asks = input.persistedCurrentStep === before.question.id ? input.currentStepAsks : 0;
    return {
      commands: [{
        kind: "increment_step_asks",
        stepId: before.question.id,
        nextAskCount: Math.min(3, asks + 1),
      }],
      currentQuestion: before.question,
      decision: null,
      effectiveState: input.state,
    };
  }
  const effectiveState = stateWithExtraction(input.state, extraction);
  const after = resolveRuntimeQualification(input.rules, effectiveState);
  const commands: EngineCommand[] = [
    { kind: "persist_qualification", stepId: before.question.id, value: extraction },
    {
      kind: "advance_step",
      stepId: before.question.id,
      valuePersisted: true,
      nextAskCount: 0,
      nextStepId: after.question?.id ?? null,
    },
  ];
  return {
    commands,
    currentQuestion: after.question,
    decision: after.decision,
    effectiveState,
  };
}

export function qualificationCommands({
  question,
  candidate,
  currentStepAsks,
}: {
  question: QualificationQuestion | null;
  candidate: unknown;
  currentStepAsks: number;
}): EngineCommand[] {
  if (!question) return [];
  const extraction = validateQualificationExtraction(question, candidate);
  if (extraction) {
    return [
      { kind: "persist_qualification", stepId: question.id, value: extraction },
      { kind: "advance_step", stepId: question.id, valuePersisted: true, nextAskCount: 0 },
    ];
  }
  if (currentStepAsks >= 2) {
    return [{ kind: "advance_step", stepId: question.id, valuePersisted: false, nextAskCount: 0 }];
  }
  return [{ kind: "increment_step_asks", stepId: question.id, nextAskCount: currentStepAsks + 1 }];
}

function baseTrace(input: EnginePipelineInput): EngineTrace {
  const bundle = input.runtimeBundle;
  return {
    brainVersion: bundle?.brainVersion ?? input.brain.version,
    offerVersion: bundle?.offerVersion ?? input.offer.version,
    brainContentHash: bundle?.contentHash ?? null,
    offerContentHash: bundle?.offer.contentHash ?? null,
    knowledgeMode: bundle?.brain.knowledgeMode ?? input.brain.knowledgeMode,
    promptHash: null,
    model: null,
    paramsHash: null,
    ruleFired: null,
    sources: [],
    declaredEntryId: input.declaredEntryId ?? null,
    declaredEntryVerified: false,
    retrievalTopThree: [],
    droppedEntryIds: [],
    numberAllowlist: [],
    objection: null,
    checks: [],
    violations: [],
    rejectedDrafts: [],
    attempts: 0,
    screen: { verdict: "continue", reason: null },
    latencyMs: null,
    usage: null,
    cost: null,
    moderator: "not_run",
    moderatorReason: null,
    moderatorClass: null,
    moderatorRuleId: null,
    moderatorModelConfigId: null,
  };
}

function assertHeldReplies(replies: Record<ModeratorClass, string>) {
  for (const checkClass of MODERATOR_CLASSES) {
    if (!replies[checkClass]?.trim()) throw new Error(`APPROVED_HELD_REPLY_REQUIRED:${checkClass}`);
  }
}

function addUsage(
  current: EngineTrace["usage"],
  next: NonNullable<EngineTrace["usage"]>,
) {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
  };
}

function heldResult({
  input,
  trace,
  commands,
  checkClass,
}: {
  input: EnginePipelineInput;
  trace: EngineTrace;
  commands: EngineCommand[];
  checkClass: ModeratorClass;
}): EngineTurnResult {
  const disclosed = applyAutomatedExperienceDisclosure({
    reply: input.heldReplies[checkClass],
    disclosurePending: input.conversation.disclosurePending,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
  });
  const effects: EngineCommand[] = [
    { kind: "send", body: disclosed.reply, approvedInput: true },
    { kind: "transition", state: "needs_human", reason: "output_check_failed" },
    { kind: "alert", eventKey: "conversation.needs_human" },
    { kind: "audit", actionKey: "conversation.escalated" },
  ];
  return {
    response: leadResponse({ reply: disclosed.reply, state: "needs_human", booking: null }),
    commands: [...commands, ...effects],
    trace: {
      ...trace,
      screen: { verdict: "held", reason: "output_check_failed" },
      ruleFired: trace.ruleFired ?? `${checkClass}-001`,
    },
  };
}

function confirmedBookingResult(
  input: EnginePipelineInput,
  booking: NonNullable<BookingResponse>,
): EngineTurnResult {
  const reply = `Your appointment is booked for ${booking.startAt} (${booking.timezone}).`;
  const disclosed = applyAutomatedExperienceDisclosure({
    reply,
    disclosurePending: input.conversation.disclosurePending,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
  });
  return {
    response: leadResponse({ reply: disclosed.reply, state: "closed", booking }),
    commands: [
      { kind: "record_booking_intent", booking },
      { kind: "persist_agent_turn", body: disclosed.reply, disclosureConsumed: disclosed.disclosureConsumed },
      { kind: "send", body: disclosed.reply, approvedInput: true },
    ],
    trace: {
      ...baseTrace(input),
      screen: { verdict: "continue", reason: "booking_confirmed" },
    },
  };
}

function inboundSafetyResult(
  input: EnginePipelineInput,
  decision: Exclude<InboundSafetyDecision, { kind: "continue" }>,
): EngineTurnResult {
  const trace = baseTrace(input);
  if (decision.kind === "no_outbound" || decision.kind === "copy_unapproved") {
    return {
      response: leadResponse({ reply: "", state: decision.state, booking: null }),
      commands: [],
      trace: {
        ...trace,
        screen: { verdict: "held", reason: decision.reason },
      },
    };
  }
  const disclosed = applyAutomatedExperienceDisclosure({
    reply: decision.body,
    disclosurePending: input.conversation.disclosurePending,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
  });
  return {
    response: leadResponse({ reply: disclosed.reply, state: decision.state, booking: null }),
    commands: [
      { kind: "persist_agent_turn", body: disclosed.reply, disclosureConsumed: disclosed.disclosureConsumed },
      { kind: "send", body: disclosed.reply, approvedInput: true },
    ],
    trace: {
      ...trace,
      screen: {
        verdict: decision.state === "agent" ? "continue" : "held",
        reason: decision.reason,
      },
    },
  };
}

/**
 * The deterministic turn for a hard-gated objection.
 *
 * Separate from the attempt loop on purpose: four of that loop's five concerns — generation,
 * regeneration, citation verification and usage accounting — do not exist for a gate. What must
 * not drift is the safety floor, so this calls the same `runOutputChecks`, the same
 * `decideCheckAttempt` and the same `moderateDraft` over the same context object, and escalates
 * through the same `heldResult`. Brain provenance is not an exemption from either check.
 */
async function hardGatedObjectionTurn({
  input,
  gated,
  trace,
  commands,
  brain,
  citations,
  numberSources,
  checkContext,
  prompt,
  retrieval,
  moderator,
  moderatorModelConfigId,
  qualificationDecision,
}: {
  input: EnginePipelineInput;
  gated: NonNullable<TurnRetrievalResult["objection"]>;
  trace: EngineTrace;
  commands: EngineCommand[];
  brain: BrainSnapshot;
  citations: EngineTrace["sources"];
  numberSources: EngineTrace["numberAllowlist"];
  checkContext: OutputCheckContext;
  prompt: ReturnType<typeof assemblePrompt>;
  retrieval: TurnRetrievalResult | null;
  moderator: { moderate: ModeratorCall };
  moderatorModelConfigId: string;
  qualificationDecision: RuntimeQualificationDecision | null;
}): Promise<EngineTurnResult> {
  // `model` and `paramsHash` stay null because no generator ran: naming the configured model on a
  // turn that never called it is the dishonest-state class the platform rules forbid.
  // `declaredEntryVerified` stays false because nothing was cited — this turn's provenance is
  // `trace.objection`, which names an immutable snapshot row, and that is the stronger receipt.
  const gateTrace: EngineTrace = {
    ...trace,
    promptHash: prompt.hash,
    model: null,
    paramsHash: null,
    sources: citations,
    declaredEntryId: null,
    declaredEntryVerified: false,
    retrievalTopThree: citations.slice(0, 3),
    droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
    numberAllowlist: numberSources,
    attempts: 0,
    latencyMs: null,
    usage: null,
    cost: null,
  };

  let body = gated.response;
  const first = runOutputChecks(body, checkContext);
  let checks: CheckResult[] = [...first.checks];
  let violations: CheckViolation[] = [...first.violations];
  // `attempt: 2` is what makes `regenerate` unreachable: there is nothing to regenerate, because
  // asking a model to rewrite a published compliance answer is the composition this path exists
  // to prevent.
  const decision = decideCheckAttempt({
    draft: body,
    attempt: 2,
    result: first,
    channel: input.channel,
  });
  // A hard-cap LEN breach also lands here: the published text is an essay for this channel, and
  // its first sentence is not the answer the lead was owed, so it holds with class LEN.
  if (decision.action === "hold") {
    return heldResult({
      input,
      commands,
      checkClass: first.violations[0]?.class ?? "JUDGE",
      trace: {
        ...gateTrace,
        ruleFired: first.violations[0]?.ruleId ?? null,
        checks,
        violations,
        rejectedDrafts: [gated.response],
      },
    });
  }
  if (decision.action === "pass_truncated") {
    // Truncation only drops trailing sentences from admin-published text; it never composes.
    body = decision.draft;
    const truncated = runOutputChecks(body, checkContext);
    checks = [...checks, ...truncated.checks];
    violations = [...violations, ...truncated.violations];
    if (!truncated.passed) {
      return heldResult({
        input,
        commands,
        checkClass: truncated.violations[0].class,
        trace: {
          ...gateTrace,
          ruleFired: truncated.violations[0].ruleId,
          checks,
          violations,
          rejectedDrafts: [gated.response],
        },
      });
    }
  }

  const moderation = await moderateDraft({
    driver: moderator,
    inputs: {
      draft: body,
      leadMessage: input.leadMessage.body,
      numberAllowlist: numberSources.map((source) =>
        `${source.kind}:${source.value}:${source.sourceType}:${source.sourceId}`,
      ),
      complianceLexicon: brain.complianceRules.map((rule) => rule.phrase),
      linkWhitelist: [...input.linkWhitelist],
      roleBoundary: input.roleBoundary,
    },
    mode: input.mode,
  });
  if (moderation.kind === "blocked") {
    return heldResult({
      input,
      commands,
      checkClass: moderation.verdict.class,
      trace: {
        ...gateTrace,
        ruleFired: moderation.verdict.rule_id ?? `${moderation.verdict.class}-001`,
        checks,
        violations,
        rejectedDrafts: [body],
        moderator: "blocked",
        moderatorReason: moderation.verdict.reason,
        moderatorClass: moderation.verdict.class,
        moderatorRuleId: moderation.verdict.rule_id ?? null,
        moderatorModelConfigId,
      },
    });
  }
  if (moderation.kind === "refused") {
    return heldResult({
      input,
      commands: [...commands, {
        kind: "increment_moderator_unavailable",
        counter: "model_configs.moderator_unavailable_count",
        by: moderation.moderatorUnavailableIncrement,
      }],
      checkClass: "JUDGE",
      trace: {
        ...gateTrace,
        checks,
        violations,
        rejectedDrafts: [body],
        moderator: "unavailable",
        moderatorReason: moderation.trace.reason,
        moderatorClass: null,
        moderatorRuleId: null,
        moderatorModelConfigId,
      },
    });
  }

  const disclosed = applyAutomatedExperienceDisclosure({
    reply: body,
    disclosurePending: input.conversation.disclosurePending,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
  });
  // `approvedInput: true` because the body came out of the published snapshot rather than model
  // composition, which is exactly what that marker distinguishes at its other two sites.
  const effects: EngineCommand[] = [
    { kind: "persist_agent_turn", body: disclosed.reply, disclosureConsumed: disclosed.disclosureConsumed },
    { kind: "send", body: disclosed.reply, approvedInput: true },
  ];
  const terminalCommands: EngineCommand[] = qualificationDecision?.outcome === "HARD_DQ"
    ? [{ kind: "record_hard_dq", reason: qualificationDecision.reason }]
    : qualificationDecision
      ? [{
          kind: "record_qualification_outcome",
          outcome: qualificationDecision.outcome,
          ruleId: qualificationDecision.ruleId,
        }]
      : [];
  return {
    response: leadResponse({
      reply: disclosed.reply,
      state: qualificationDecision?.outcome === "HARD_DQ"
        ? "closed"
        : qualificationDecision?.outcome === "SOFT_DQ"
          ? "nurture"
          : "agent",
      booking: null,
    }),
    commands: [...commands, ...terminalCommands, ...effects],
    trace: {
      ...gateTrace,
      checks,
      violations,
      rejectedDrafts: [],
      ruleFired: violations[0]?.ruleId ?? null,
      moderator: "allowed",
      moderatorReason: moderation.verdict.reason,
      moderatorClass: moderation.verdict.class,
      moderatorRuleId: moderation.verdict.rule_id ?? null,
      moderatorModelConfigId,
    },
  };
}

export async function runEngineTurn(
  input: EnginePipelineInput,
  dependencies: EnginePipelineDependencies,
): Promise<EngineTurnResult> {
  if (input.mode === "production" && !input.inboundSafety) {
    throw new Error("INBOUND_SAFETY_STATE_REQUIRED");
  }
  if (input.inboundSafety) {
    const expectedTenantId = input.runtimeBundle?.offer.tenantId ?? input.offer.tenantId;
    if (input.inboundSafety.state.tenantId !== expectedTenantId) {
      throw new Error("INBOUND_SAFETY_TENANT_MISMATCH");
    }
    const safetyDecision = await resolveInboundSafety(
      input.inboundSafety,
      dependencies.persistInboundSafety,
    );
    if (safetyDecision.kind !== "continue") return inboundSafetyResult(input, safetyDecision);
  }
  assertHeldReplies(input.heldReplies);
  let trace = baseTrace(input);
  if (input.conversation.state !== "agent") {
    return {
      response: leadResponse({ reply: "", state: input.conversation.state, booking: null }),
      commands: [],
      trace: {
        ...trace,
        screen: { verdict: "held", reason: `conversation_${input.conversation.state}` },
      },
    };
  }
  if (input.bookingSelection?.kind === "invalid") {
    return heldResult({
      input,
      commands: [],
      checkClass: "JUDGE",
      trace: {
        ...trace,
        screen: { verdict: "held", reason: "booking_selection_invalid" },
      },
    });
  }
  if (input.bookingSelection?.kind === "booked") {
    return confirmedBookingResult(input, input.bookingSelection.booking);
  }

  const runtimeBacked = Boolean(input.runtimeBundle);
  if (runtimeBacked && !input.qualificationState) {
    throw new Error("RUNTIME_QUALIFICATION_STATE_REQUIRED");
  }
  const runtimeQualification = input.runtimeBundle && input.qualificationState
    ? planRuntimeQualificationTurn({
        rules: input.runtimeBundle.qualification,
        state: input.qualificationState,
        leadBody: input.leadMessage.body,
        persistedCurrentStep: input.conversation.currentStep,
        currentStepAsks: input.conversation.currentStepAsks,
      })
    : null;
  const qualification = runtimeQualification?.commands ?? qualificationCommands({
    question: input.currentQuestion,
    candidate: input.extractionCandidate,
    currentStepAsks: input.conversation.currentStepAsks,
  });
  const brain = input.runtimeBundle ? engineBrainFromRuntimeBundle(input.runtimeBundle) : input.brain;
  const offer = input.runtimeBundle ? engineOfferFromRuntimeBundle(input.runtimeBundle) : input.offer;
  const retrieval = input.runtimeBundle
    ? await (dependencies.retrieve ?? ((retrievalInput) => retrieveForTurn(retrievalInput)))({
        snapshotId: input.runtimeBundle.snapshotId,
        inboundMessage: input.leadMessage.body,
        categoryHint: null,
        offer: input.runtimeBundle.offer,
        renderSources: input.runtimeBundle.renderSources,
      })
    : null;
  // Identity only, and no branch on it. What a hard gate does to the reply is 10-03's deliverable;
  // 10-02 changes what is recorded about a turn and nothing about what the turn says. Every
  // post-retrieval return already spreads `...trace`, so this one assignment is the whole change.
  trace = {
    ...trace,
    objection: retrieval?.objection
      ? {
          snapshotId: retrieval.objection.snapshotId,
          objectionId: retrieval.objection.objectionId,
          hardGate: retrieval.objection.hardGate,
        }
      : null,
  };
  const citations = retrieval
    ? retrieval.included.map((candidate) => ({
        entryId: candidate.entryId,
        content: candidate.content,
        similarity: candidate.similarity,
        categoryBoost: candidate.categoryBoost as 0 | 0.05,
        score: candidate.score,
        categoryAgreement: candidate.categoryBoost === 0.05,
      }))
    : retrievePublishedEntries({ query: input.leadMessage.body, entries: brain.entries });
  const numberBrainEntries = retrieval
    ? citations.map((citation) => ({
        id: citation.entryId,
        category: "retrieved",
        question: "",
        answer: citation.content,
        published: true,
      }))
    : brain.entries;
  const numberSources = buildNumberSources({
    offer,
    brainEntries: numberBrainEntries,
    leadMessages: [
      ...input.history
      .filter((message) => message.role === "user")
      .map((message, index) => ({ id: `history-${index}`, body: message.content })),
      input.leadMessage,
    ],
  });
  // The `!hardGate` filter is load-bearing: a hard-gated response IS the reply, so the model must
  // never see it. Everything else the snapshot matched becomes a declarable candidate.
  const promptObjections = (retrieval?.objectionCandidates ?? [])
    .filter((candidate) => !candidate.hardGate)
    .map(({ objectionId, label, response }) => ({ objectionId, label, response }));
  const promptState = runtimeQualification
    ? {
        ...input.conversation,
        currentStep: runtimeQualification.currentQuestion?.id ?? null,
        currentStepAsks: input.conversation.currentStep === runtimeQualification.currentQuestion?.id
          ? input.conversation.currentStepAsks
          : 0,
      }
    : input.conversation;
  const prompt = assemblePrompt({
    brain,
    offer,
    state: promptState,
    history: input.history,
    tagSecret: input.tagSecret,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
    ...(retrieval ? { candidates: citations } : {}),
    ...(promptObjections.length ? { objections: promptObjections } : {}),
  });
  // Loop-invariant: every field is fixed before the first attempt, and the loop reassigns
  // `messages`, never `prompt.messages`. Hoisting it is what lets the gate path below run the
  // identical floor over a published response without duplicating how that floor is built.
  const checkContext: OutputCheckContext = {
    numberSources,
    complianceRules: brain.complianceRules,
    linkWhitelist: input.linkWhitelist,
    systemText: prompt.messages[0].content,
    echoExemptions: numberBrainEntries.map((entry) => entry.answer),
    roleBoundary: input.roleBoundary,
    channel: input.channel,
  };

  // A hard-gated objection answers from the published snapshot. The gate is the retrieval result,
  // never an env read: `retrieveForTurn` populates `objection` only when the objection flag is on,
  // so a flag-off turn cannot reach this branch and this module stays free of flag reads.
  const models = loadActiveModelPair(input.modelConfigs);
  const gated = retrieval?.objection && retrieval.objection.hardGate ? retrieval.objection : null;
  if (gated) {
    return hardGatedObjectionTurn({
      input,
      gated,
      trace,
      commands: qualification,
      brain,
      citations,
      numberSources,
      checkContext,
      prompt,
      retrieval,
      moderator: dependencies.moderator,
      moderatorModelConfigId: models.moderator.id,
      qualificationDecision: runtimeQualification?.decision ?? null,
    });
  }

  let messages = [...prompt.messages];
  let attempts = 0;
  let regenerationUsed = false;
  let rejectedDrafts: string[] = [];
  let allChecks: CheckResult[] = [];
  let allViolations: CheckViolation[] = [];
  let usage: EngineTrace["usage"] = null;
  let moderatorState: EngineTrace["moderator"] = "not_run";
  let moderatorReason: string | null = null;
  let moderatorClass: EngineTrace["moderatorClass"] = null;
  let moderatorRuleId: string | null = null;
  let moderatorModelConfigId: string | null = null;
  let finalDraft = "";
  let declaredEntryId = input.runtimeBundle ? null : input.declaredEntryId ?? null;
  let declaredEntryVerified = false;
  let lastLatency: number | null = null;
  let lastCost: number | null = null;

  while (attempts < 2) {
    attempts += 1;
    const generated = await dependencies.model.generate(messages, {
      model: models.generator.openrouterModel,
      params: models.generator.params,
    });
    const envelope = input.runtimeBundle ? modelReplyEnvelope(generated.draft) : null;
    let candidate = input.runtimeBundle ? envelope?.reply ?? generated.draft : generated.draft;
    declaredEntryId = input.runtimeBundle ? envelope?.citation_entry_id ?? null : declaredEntryId;
    declaredEntryVerified = input.runtimeBundle
      ? verifyCitationDeclaration(
          declaredEntryId,
          [...prompt.promptCandidateIds, ...prompt.promptObjectionIds],
        )
      : Boolean(declaredEntryId && citations.some((entry) => entry.entryId === declaredEntryId));
    // 10-02 recorded the top-ranked match. With up to three in the prompt the model can answer
    // from the second, and recording the first would name the wrong objection in the usage
    // rollup with nobody ever reconciling it. A citation of a knowledge entry leaves the match
    // as it was: the recorded fact is "this objection was raised", not "this objection was cited".
    const citedObjection = promptObjections.length > 0 && declaredEntryVerified
      ? retrieval?.objectionCandidates?.find(
          (candidate) => candidate.objectionId === declaredEntryId,
        ) ?? null
      : null;
    if (citedObjection) {
      trace = {
        ...trace,
        objection: {
          snapshotId: citedObjection.snapshotId,
          objectionId: citedObjection.objectionId,
          hardGate: citedObjection.hardGate,
        },
      };
    }
    usage = addUsage(usage, generated.usage);
    lastLatency = generated.provider.latencyMs;
    lastCost = generated.provider.cost;
    let checked = runOutputChecks(candidate, checkContext);
    allChecks = [...allChecks, ...checked.checks];
    allViolations = [...allViolations, ...checked.violations];
    const checkDecision = decideCheckAttempt({
      draft: candidate,
      attempt: regenerationUsed ? 2 : 1,
      result: checked,
      channel: input.channel,
    });
    if (checkDecision.action === "regenerate") {
      rejectedDrafts = [...rejectedDrafts, candidate];
      regenerationUsed = true;
      messages = [...prompt.messages, {
        role: "system",
        content: regenerationInstruction(checkDecision.ruleIds, checkDecision.classes),
      }];
      continue;
    }
    // A second draft still over the channel's hard cap holds with class LEN rather than being
    // truncated: `decideCheckAttempt` only offers `pass_truncated` for a soft breach, and the
    // trace below records the LEN check, its hard-cap evidence and rule id like any other hold.
    if (checkDecision.action === "hold") {
      const checkClass = checked.violations[0]?.class ?? "JUDGE";
      return heldResult({
        input,
        commands: qualification,
        checkClass,
        trace: {
          ...trace,
          promptHash: prompt.hash,
          model: models.generator.openrouterModel,
          paramsHash: paramsHash(models.generator.params),
          ruleFired: checked.violations[0]?.ruleId ?? null,
          sources: citations,
          declaredEntryId,
          declaredEntryVerified,
          retrievalTopThree: citations.slice(0, 3),
          droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
          numberAllowlist: numberSources,
          checks: allChecks,
          violations: allViolations,
          rejectedDrafts: [...rejectedDrafts, candidate],
          attempts,
          latencyMs: lastLatency,
          usage,
          cost: lastCost,
          moderator: moderatorState,
          moderatorReason,
          moderatorClass,
          moderatorRuleId,
          moderatorModelConfigId,
        },
      });
    }
    if (checkDecision.action === "pass_truncated") {
      candidate = checkDecision.draft;
      checked = runOutputChecks(candidate, checkContext);
      allChecks = [...allChecks, ...checked.checks];
      allViolations = [...allViolations, ...checked.violations];
      if (!checked.passed) {
        return heldResult({ input, commands: qualification, checkClass: checked.violations[0].class, trace: {
          ...trace,
          promptHash: prompt.hash,
          model: models.generator.openrouterModel,
          paramsHash: paramsHash(models.generator.params),
          ruleFired: checked.violations[0].ruleId,
          sources: citations,
          declaredEntryId,
          declaredEntryVerified: false,
          retrievalTopThree: citations.slice(0, 3),
          droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
          numberAllowlist: numberSources,
          checks: allChecks,
          violations: allViolations,
          rejectedDrafts: [...rejectedDrafts, generated.draft],
          attempts,
          latencyMs: lastLatency,
          usage,
          cost: lastCost,
          moderator: moderatorState,
          moderatorReason,
          moderatorClass,
          moderatorRuleId,
          moderatorModelConfigId,
        } });
      }
    }

    if (input.runtimeBundle && !declaredEntryVerified) {
      if (!regenerationUsed) {
        rejectedDrafts = [...rejectedDrafts, candidate];
        regenerationUsed = true;
        messages = [...prompt.messages, { role: "system", content: citationRegenerationInstruction() }];
        continue;
      }
      return heldResult({
        input,
        commands: qualification,
        checkClass: "JUDGE",
        trace: {
          ...trace,
          promptHash: prompt.hash,
          model: models.generator.openrouterModel,
          paramsHash: paramsHash(models.generator.params),
          sources: citations,
          declaredEntryId,
          declaredEntryVerified: false,
          retrievalTopThree: citations.slice(0, 3),
          droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
          numberAllowlist: numberSources,
          checks: allChecks,
          violations: allViolations,
          rejectedDrafts: [...rejectedDrafts, candidate],
          attempts,
          latencyMs: lastLatency,
          usage,
          cost: lastCost,
          moderator: moderatorState,
          moderatorReason,
          moderatorClass,
          moderatorRuleId,
          moderatorModelConfigId,
        },
      });
    }

    const moderation = await moderateDraft({
      driver: dependencies.moderator,
      inputs: {
        draft: candidate,
        leadMessage: input.leadMessage.body,
        numberAllowlist: numberSources.map((source) =>
          `${source.kind}:${source.value}:${source.sourceType}:${source.sourceId}`,
        ),
        complianceLexicon: brain.complianceRules.map((rule) => rule.phrase),
        linkWhitelist: [...input.linkWhitelist],
        roleBoundary: input.roleBoundary,
      },
      mode: input.mode,
    });
    if (moderation.kind === "blocked") {
      moderatorState = "blocked";
      moderatorReason = moderation.verdict.reason;
      moderatorClass = moderation.verdict.class;
      moderatorRuleId = moderation.verdict.rule_id ?? null;
      moderatorModelConfigId = models.moderator.id;
      if (!regenerationUsed) {
        rejectedDrafts = [...rejectedDrafts, candidate];
        regenerationUsed = true;
        messages = [...prompt.messages, {
          role: "system",
          content: regenerationInstruction(
            [moderation.verdict.rule_id ?? `${moderation.verdict.class}-001`],
            [moderation.verdict.class],
          ),
        }];
        continue;
      }
      return heldResult({
        input,
        commands: qualification,
        checkClass: moderation.verdict.class,
        trace: {
          ...trace,
          promptHash: prompt.hash,
          model: models.generator.openrouterModel,
          paramsHash: paramsHash(models.generator.params),
          ruleFired: moderation.verdict.rule_id ?? `${moderation.verdict.class}-001`,
          sources: citations,
          declaredEntryId,
          declaredEntryVerified,
          retrievalTopThree: citations.slice(0, 3),
          droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
          numberAllowlist: numberSources,
          checks: allChecks,
          violations: allViolations,
          rejectedDrafts: [...rejectedDrafts, candidate],
          attempts,
          latencyMs: lastLatency,
          usage,
          cost: lastCost,
          moderator: moderatorState,
          moderatorReason,
          moderatorClass,
          moderatorRuleId,
          moderatorModelConfigId,
        },
      });
    }
    if (moderation.kind === "refused") {
      return heldResult({
        input,
        commands: [...qualification, {
          kind: "increment_moderator_unavailable",
          counter: "model_configs.moderator_unavailable_count",
          by: moderation.moderatorUnavailableIncrement,
        }],
        checkClass: "JUDGE",
        trace: {
          ...trace,
          promptHash: prompt.hash,
          model: models.generator.openrouterModel,
          paramsHash: paramsHash(models.generator.params),
          sources: citations,
          declaredEntryId,
          declaredEntryVerified: false,
          retrievalTopThree: citations.slice(0, 3),
          droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
          numberAllowlist: numberSources,
          checks: allChecks,
          violations: allViolations,
          rejectedDrafts: [...rejectedDrafts, candidate],
          attempts,
          latencyMs: lastLatency,
          usage,
          cost: lastCost,
          moderator: "unavailable",
          moderatorReason: moderation.trace.reason,
          moderatorClass: null,
          moderatorRuleId: null,
          moderatorModelConfigId: models.moderator.id,
        },
      });
    }
    moderatorState = "allowed";
    moderatorReason = moderation.verdict.reason;
    moderatorClass = moderation.verdict.class;
    moderatorRuleId = moderation.verdict.rule_id ?? null;
    moderatorModelConfigId = models.moderator.id;
    finalDraft = candidate;
    break;
  }

  if (!finalDraft) throw new Error("ENGINE_ATTEMPT_EXHAUSTED_WITHOUT_RESULT");
  const disclosed = applyAutomatedExperienceDisclosure({
    reply: finalDraft,
    disclosurePending: input.conversation.disclosurePending,
    automatedExperienceDisclosure: input.automatedExperienceDisclosure,
  });
  const decision = runtimeQualification?.decision ?? input.decision ?? null;
  const booking = runtimeBacked
    ? null
    : input.currentQuestion === null ? input.booking ?? null : null;
  const state = booking || decision?.outcome === "HARD_DQ"
    ? "closed"
    : decision?.outcome === "SOFT_DQ"
      ? "nurture"
      : "agent";
  const commands: EngineCommand[] = [...qualification];
  if (decision?.outcome === "HARD_DQ") {
    commands.push({ kind: "record_hard_dq", reason: decision.reason });
  }
  if (runtimeQualification?.decision && runtimeQualification.decision.outcome !== "HARD_DQ") {
    commands.push({
      kind: "record_qualification_outcome",
      outcome: runtimeQualification.decision.outcome,
      ruleId: runtimeQualification.decision.ruleId,
    });
  }
  if (booking) commands.push({ kind: "record_booking_intent", booking });
  commands.push(
    { kind: "persist_agent_turn", body: disclosed.reply, disclosureConsumed: disclosed.disclosureConsumed },
    { kind: "send", body: disclosed.reply, approvedInput: false },
  );
  return {
    response: leadResponse({ reply: disclosed.reply, state, booking }),
    commands,
    trace: {
      ...trace,
      promptHash: prompt.hash,
      model: models.generator.openrouterModel,
      paramsHash: paramsHash(models.generator.params),
      ruleFired: allViolations[0]?.ruleId ?? null,
      sources: citations,
      declaredEntryId,
      declaredEntryVerified,
      retrievalTopThree: citations.slice(0, 3),
      droppedEntryIds: retrieval?.dropped.map((entry) => entry.entryId) ?? [],
      numberAllowlist: numberSources,
      checks: allChecks,
      violations: allViolations,
      rejectedDrafts,
      attempts,
      latencyMs: lastLatency,
      usage,
      cost: lastCost,
      moderator: moderatorState,
      moderatorReason,
      moderatorClass,
      moderatorRuleId,
      moderatorModelConfigId,
    },
  };
}
