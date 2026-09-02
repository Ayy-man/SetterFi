import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { claim, release, type AuditDependencies, type ConversationMutationRead } from "@/lib/audit";
import { createBookingService } from "@/lib/booking/service";
import type {
  BookingContext,
  BookingDomainEvent,
  BookingRepository,
  CalendarConnection,
  ProposedSlotSet,
} from "@/lib/booking/types";
import type { ConversationStateSnapshot } from "@/lib/conversation-state";
import { deriveTemplateTruth } from "@/components/workspace/live/view-models";
import { resolveDemoQualification } from "@/lib/domain/qualification";
import { runEngineTurn, type EnginePipelineInput } from "@/lib/engine/pipeline";
import type { BrainSnapshot, CoachOffer, EngineTurnResult, ModeratorClass } from "@/lib/engine/types";
import { createMockCalendarDriver } from "@/lib/integrations/calendar";
import { createMockStripeDriver } from "@/lib/integrations/stripe/mock";
import { resolveStripeDriver } from "@/lib/integrations/stripe/selector";
import { normalizeGhlInbound } from "@/lib/integrations/ghl";
import { normalizeMetaInbound } from "@/lib/integrations/meta";
import type { MessagingDriver } from "@/lib/integrations/types";
import { sendWithOutboundPolicy, type OutboundPolicyDependencies } from "@/lib/messaging/outbound-policy";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";
import {
  canonicalInboundEngineInput,
  processInboundReceipt,
  tenantReceiptEventId,
  type DurableInboundReceipt,
  type InboundProcessDependencies,
} from "@/lib/webhooks/process-inbound";

const DISCLOSURE = "Automated demo disclosure.";
const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"]
    .map((key) => [key, `Held ${key}.`]),
) as Record<ModeratorClass, string>;
const BRAIN: BrainSnapshot = {
  version: 1,
  platformFrame: "Use only grounded statements.",
  mission: "Qualify the lead.",
  qualification: "Follow the typed qualification state.",
  complianceRules: [{ id: "CLAIM-001", phrase: "guarantee" }],
  entries: [{
    id: "brain-entry-1",
    category: "process",
    question: "How does the process work?",
    answer: "The process starts with an assessment of the lead's actual file.",
    published: true,
  }],
  knowledgeMode: "inline",
};
const OFFER: CoachOffer = {
  tenantId: "tenant-a",
  version: 1,
  programName: "Demo program",
  products: [],
  brandVoice: "professional",
  voiceAnswers: [],
  proof: [],
  assets: [],
  offerPrices: [],
  creditMin: 640,
  fundingGoalMinCents: null,
  bookingHorizonDays: 21,
};
const INBOUND_SAFETY: NonNullable<EnginePipelineInput["inboundSafety"]> = {
  state: {
    tenantId: "tenant-a",
    conversationId: "conversation-1",
    status: "agent",
    scopeAttackCount: 0,
    tripwireCount: 0,
    tripwireClasses: [],
  },
  content: {
    approved: true,
    scopeDeflection1: "Approved first scope response.",
    scopeDeflection2: "Approved second scope response.",
    scopeClosing: "Approved scope closing response.",
  },
  signal: { kind: "none" },
};
const ENGINE_INPUT: EnginePipelineInput = {
  mode: "production",
  channel: "sms",
  brain: BRAIN,
  offer: OFFER,
  conversation: { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
  history: [{ role: "user", content: "How does the process work?" }],
  leadMessage: { id: "lead-message-1", body: "How does the process work?" },
  tagSecret: "test-only-tag-secret",
  automatedExperienceDisclosure: DISCLOSURE,
  heldReplies: HELD,
  linkWhitelist: [],
  roleBoundary: "funding qualification only",
  modelConfigs: [
    { id: "generator", role: "generator", openrouterModel: "anthropic/generator", params: {}, active: true },
    { id: "moderator", role: "moderator", openrouterModel: "openai/moderator", params: {}, active: true },
  ],
  currentQuestion: null,
  extractionCandidate: null,
  decision: null,
  booking: { id: "booking-1", startAt: "2026-08-20T14:00:00.000Z", timezone: "America/New_York" },
  declaredEntryId: "brain-entry-1",
  inboundSafety: INBOUND_SAFETY,
};

function modelDependencies() {
  return {
    model: {
      generate: vi.fn(async () => ({
        draft: BRAIN.entries[0].answer,
        usage: { promptTokens: 7, completionTokens: 8, totalTokens: 15 },
        provider: { name: "mock", generationId: "generation-1", latencyMs: 4, cost: 0 },
      })),
    },
    moderator: {
      moderate: vi.fn(async () => ({
        verdict: "allow" as const,
        class: "JUDGE" as const,
        reason: "grounded",
      })),
    },
  };
}

function receipt(overrides: {
  id?: string;
  eventId?: string;
  providerMessageId?: string;
} = {}): DurableInboundReceipt {
  return {
    id: overrides.id ?? "receipt-1",
    leaseToken: "00000000-0000-4000-8000-000000000001",
    attemptNumber: 1,
    tenantId: "tenant-a",
    provider: "ghl",
    batch: {
      events: [{
        kind: "message",
        eventId: overrides.eventId ?? "event-1",
        providerMessageId: overrides.providerMessageId ?? "provider-message-1",
        body: "How does the process work?",
        externalAccountId: "location-1",
        identity: {
          provider: "ghl",
          channel: "sms",
          externalId: "provider-contact-1",
          normalizedPhone: null,
          normalizedEmail: null,
        },
        providerWindow: null,
      }],
    },
  };
}

function inboundHarness() {
  const storedMessageKeys = new Set<string>();
  const contacts = new Set<string>();
  const conversations = new Set<string>();
  const marks: Array<{ status: string; error: string | null }> = [];
  const persistedResults: Parameters<InboundProcessDependencies["persistResult"]>[0][] = [];
  let unreadByCoach = false;
  let conversation: ConversationStateSnapshot = {
    id: "conversation-1",
    tenantId: "tenant-a",
    status: "agent",
    statusReason: null,
    currentStepAsks: 0,
    unreadByCoach: false,
  };
  const engines = modelDependencies();
  const durableTurns = new Map<string, {
    result: EngineTurnResult;
    preTurnCurrentStep: string | null;
    preTurnCurrentStepAsks: number;
    delivered: boolean;
    persisted: boolean;
  }>();
  const dependencies: InboundProcessDependencies = {
    tenantAccess: { assertInboundAllowed: async () => ({ allowed: true, existingConversation: false }) },
    persistInbound: async (tenantId, input) => {
      const key = `${tenantId}:${input.identity.provider}:${input.providerMessageId}`;
      const messageInserted = !storedMessageKeys.has(key);
      storedMessageKeys.add(key);
      contacts.add(`${tenantId}:${input.identity.externalId}`);
      conversations.add(`${tenantId}:${input.identity.externalId}:${input.identity.channel}`);
      if (messageInserted && conversation.status === "human") unreadByCoach = true;
      return {
        tenantId,
        contactId: `contact:${tenantId}`,
        conversationId: conversation.id,
        messageId: `message:${key}`,
        messageInserted,
        disclosurePending: false,
        providerWindowExpiresAt: input.providerWindow?.expiresAt ?? null,
      };
    },
    loadConversation: async () => ({ ...conversation, tenantId: conversation.tenantId }),
    loadHistory: async () => [],
    loadQualificationState: async () => ({
      credit: null,
      goal: null,
      timeline: null,
      businessStage: null,
      annualRevenueCents: null,
      outcome: null,
      dqReason: null,
    }),
    loadEngineTurn: async ({ inboundMessageId }) => durableTurns.get(inboundMessageId) ?? null,
    recordEngineTurn: async (input) => {
      const existing = durableTurns.get(input.inboundMessageId);
      if (existing) return existing;
      const recorded = {
        result: input.result,
        preTurnCurrentStep: input.preTurnCurrentStep,
        preTurnCurrentStepAsks: input.preTurnCurrentStepAsks,
        delivered: false,
        persisted: false,
      };
      durableTurns.set(input.inboundMessageId, recorded);
      return recorded;
    },
    markEngineTurnDelivered: async ({ inboundMessageId }) => {
      const existing = durableTurns.get(inboundMessageId);
      if (existing) durableTurns.set(inboundMessageId, { ...existing, delivered: true });
    },
    completeEngineTurn: async ({ inboundMessageId }) => {
      const existing = durableTurns.get(inboundMessageId);
      if (existing) durableTurns.set(inboundMessageId, { ...existing, persisted: true });
    },
    resumeConversation: async () => {
      conversation = { ...conversation, status: "agent", statusReason: null };
      return conversation;
    },
    consumeRateLimit: async () => ({ allowed: true, reason: null }),
    processSuppression: async () => ({ kind: "none" }),
    cancelCadence: async () => undefined,
    reanchorCadence: async () => undefined,
    loadInboundSafety: async () => INBOUND_SAFETY,
    loadContactIsTest: async () => false,
    persistInboundSafety: {
      applyScopeSignal: async () => ({ persistedCount: 1, action: "deflect_1" }),
      applyTripwireSignal: async () => ({ persistedCount: 1, action: "refused" }),
    },
    runEngine: async () => runEngineTurn(ENGINE_INPUT, engines),
    sendToLead: async (request) => ({
      kind: "sent",
      channel: "sms",
      receipt: {
        tenantId: request.tenantId,
        contactId: request.contactId,
        conversationId: request.conversationId,
        identityId: "identity-1",
        purpose: request.purpose,
        idempotencyKey: request.idempotencyKey,
        decidedAt: "2026-08-17T00:00:00.000Z",
        auditId: 1,
        providerMessageId: "provider-outbound-1",
        messageId: "message-outbound-1",
        persistedAt: "2026-08-17T00:00:00.000Z",
      },
    }),
    persistResult: async (input) => void persistedResults.push(input),
    markReceipt: async (input) => void marks.push({ status: input.status, error: input.error }),
  };
  return {
    dependencies,
    engines,
    marks,
    persistedResults,
    contacts,
    conversations,
    unread: () => unreadByCoach,
    setConversation: (next: ConversationStateSnapshot) => { conversation = next; },
  };
}

function handoffHarness() {
  let state: ConversationMutationRead = {
    id: "conversation-1",
    tenantId: "tenant-a",
    status: "agent",
    statusReason: null,
    takenOverBy: null,
    disclosurePending: false,
    currentStepAsks: 0,
  };
  let auditId = 0;
  const actions = new Map<string, keyof typeof AUDIT_ACTIONS>();
  const dependencies: AuditDependencies = {
    rpc: async (name, args) => {
      if (name === "claim_conversation") {
        state = {
          ...state,
          status: "human",
          statusReason: "lead_requested_human",
          takenOverBy: String(args.p_actor_id),
        };
        actions.set(String(++auditId), "conversation.takeover.claimed");
        return auditId;
      }
      if (name === "release_conversation") {
        state = {
          ...state,
          status: "agent",
          statusReason: null,
          takenOverBy: null,
          disclosurePending: true,
        };
        actions.set(String(++auditId), "conversation.takeover.released");
        return auditId;
      }
      throw new Error(`UNEXPECTED_RPC:${name}`);
    },
    loadConversation: async () => state,
    loadContactStage: async () => ({
      id: "contact-1",
      tenantId: "tenant-a",
      pipelineStage: "qualified",
      stageSetBy: "system",
      stageSetAt: "2026-08-17T00:00:00.000Z",
    }),
    loadAuditReceipt: async (id, tenantId, action) => {
      if (tenantId !== "tenant-a" || actions.get(id) !== action) return null;
      return {
        auditId: id,
        actionKey: action,
        label: AUDIT_ACTIONS[action].microcopy,
        ariaLabel: AUDIT_ACTIONS[action].ariaLabel,
      };
    },
  };
  return { dependencies, state: () => state };
}

describe("Phase 1 goal-backward demo contract", () => {
  it("keeps one identity/thread on replay, grounds BOOK and DQ, holds takeover, and discloses after release", async () => {
    const inbound = inboundHarness();
    const first = await processInboundReceipt(receipt(), inbound.dependencies);
    expect(first).toMatchObject({ kind: "batch", events: [{ kind: "sent" }] });
    const firstEvent = first.events[0];
    if (firstEvent.kind !== "sent") throw new Error("expected sent result");
    expect(Object.keys(firstEvent.result.response).sort()).toEqual(["booking", "reply", "state"]);
    expect(firstEvent.result.response.booking).toEqual(ENGINE_INPUT.booking);
    expect(firstEvent.result.trace.declaredEntryVerified).toBe(true);
    expect(firstEvent.result.trace.checks).toHaveLength(6);
    expect(firstEvent.result.trace).toMatchObject({
      model: "anthropic/generator",
      moderator: "allowed",
      moderatorReason: "grounded",
    });

    const replay = await processInboundReceipt(receipt(), inbound.dependencies);
    expect(replay).toMatchObject({ kind: "batch", events: [{ kind: "no_send" }] });
    expect(inbound.contacts).toHaveLength(1);
    expect(inbound.conversations).toHaveLength(1);
    expect(inbound.engines.model.generate).toHaveBeenCalledTimes(1);
    expect(tenantReceiptEventId({ tenantId: "tenant-a", eventId: "same", providerMessageId: "same" }))
      .not.toBe(tenantReceiptEventId({ tenantId: "tenant-b", eventId: "same", providerMessageId: "same" }));

    const book = resolveDemoQualification({
      score: 720,
      businessStage: "operating",
      annualRevenue: 120_000,
      fundingGoal: "$50K–100K",
      timeline: "ASAP–30d",
    });
    const dq = resolveDemoQualification({
      score: 580,
      businessStage: "operating",
      annualRevenue: null,
      fundingGoal: "<$50K",
      timeline: "exploring",
    });
    expect(book).toMatchObject({ id: "strong-credit", outcome: "BOOK" });
    expect(dq).toMatchObject({ id: "low-credit", outcome: "HARD_DQ" });
    const storedDq = { outcome: dq?.outcome, reason: dq?.id };
    expect(storedDq).toEqual({ outcome: "HARD_DQ", reason: "low-credit" });

    const handoff = handoffHarness();
    const claimed = await claim("tenant-a", {
      conversationId: "conversation-1",
      actorId: "coach-1",
      expectedStatus: "agent",
      expectedHolderId: null,
      confirmDisplace: false,
    }, handoff.dependencies);
    expect(claimed.audit.actionKey).toBe("conversation.takeover.claimed");
    inbound.setConversation({
      id: "conversation-1",
      tenantId: "tenant-a",
      status: "human",
      statusReason: "lead_requested_human",
      currentStepAsks: 0,
      unreadByCoach: false,
    });
    const held = await processInboundReceipt(receipt({
      id: "receipt-2",
      eventId: "event-2",
      providerMessageId: "provider-message-2",
    }), inbound.dependencies);
    expect(held).toMatchObject({ kind: "batch", events: [{ kind: "held" }] });
    expect(inbound.unread()).toBe(true);
    expect(inbound.engines.model.generate).toHaveBeenCalledTimes(1);

    const released = await release("tenant-a", {
      conversationId: "conversation-1",
      actorId: "coach-1",
      expectedHolderId: "coach-1",
    }, handoff.dependencies);
    expect(released.audit.actionKey).toBe("conversation.takeover.released");
    expect(released.conversation.disclosurePending).toBe(true);
    const disclosed = await runEngineTurn({
      ...ENGINE_INPUT,
      booking: null,
      conversation: { ...ENGINE_INPUT.conversation, disclosurePending: true },
    }, modelDependencies());
    expect(disclosed.response.reply).toBe(`${DISCLOSURE}\n\n${BRAIN.entries[0].answer}`);
    expect(disclosed.commands).toContainEqual({
      kind: "persist_agent_turn",
      body: `${DISCLOSURE}\n\n${BRAIN.entries[0].answer}`,
      disclosureConsumed: true,
    });
  });

  it("books provider-first, re-offers a conflicting slot, and never bills or notifies a test appointment", async () => {
    const context: BookingContext = {
      tenantId: "tenant-a",
      conversationId: "conversation-1",
      contactId: "contact-1",
      providerContactId: "provider-contact-1",
      leadName: "Demo lead",
      channel: "sms",
      leadTimezone: "America/New_York",
      qualification: { creditBand: "700+", fundingGoal: "$50K–100K", timeline: "ASAP–30d" },
      isTest: true,
    };
    const calendarConnection: CalendarConnection = {
      id: "calendar-1",
      tenantId: "tenant-a",
      provider: "ghl",
      externalCalendarId: "provider-calendar-1",
      externalLocationId: "provider-location-1",
      timezone: "America/New_York",
      bookingUrl: null,
    };
    let proposal: ProposedSlotSet | null = null;
    let appointmentWrites = 0;
    let providerExternalId: string | null = null;
    let bookingCompleted = false;
    const events: BookingDomainEvent[] = [];
    const repository: BookingRepository = {
      getBookingContext: async () => context,
      getPrimaryCalendar: async () => calendarConnection,
      getProposedSlots: async () => proposal,
      recordProposedSlots: async (input) => {
        proposal = input.proposal;
        return proposal;
      },
      recordCalendarSlotFetch: async () => undefined,
      recordProviderAppointment: async () => {
        appointmentWrites += 1;
        return { appointmentId: "appointment-1", billableEventId: null, auditId: 1 };
      },
      claimBookingIntent: async () => bookingCompleted
        ? {
            kind: "completed",
            intentId: "intent-1",
            providerExternalId: providerExternalId!,
            appointment: { appointmentId: "appointment-1", billableEventId: null, auditId: null },
          }
        : providerExternalId
          ? { kind: "provider_created", intentId: "intent-1", providerExternalId }
          : { kind: "claimed", intentId: "intent-1", claimToken: "claim-1", recoveryRequired: false },
      renewBookingIntentLease: async () => true,
      recordBookingIntentProvider: async (input) => { providerExternalId = input.providerExternalId; },
      completeBookingIntent: async () => { bookingCompleted = true; },
      releaseBookingIntent: async () => undefined,
      checkpointBookingConflict: async () => undefined,
      recordBookingLinkSent: async () => undefined,
    };
    const service = createBookingService({
      calendar: createMockCalendarDriver(),
      repository,
      emitDomainEvent: async (event) => void events.push(event),
      now: () => new Date("2026-08-20T12:00:00.000Z"),
    });
    const offered = await service.proposeSlots({
      tenantId: "tenant-a",
      conversationId: "conversation-1",
      rangeStartAt: "2026-08-20T14:00:00.000Z",
      rangeEndAt: "2026-08-20T16:00:00.000Z",
    });
    if (offered.kind !== "offered") throw new Error("expected offered slots");
    const selectedSlotId = offered.proposal.slots[0].id;
    const booked = await service.bookDirectAppointment({
      tenantId: "tenant-a",
      conversationId: "conversation-1",
      selectedSlotId,
    });
    expect(booked).toMatchObject({
      kind: "booked",
      appointment: { billableEventId: null },
      slot: { timezone: "America/New_York" },
    });
    if (booked.kind !== "booked") throw new Error("expected booked appointment");
    expect(booked.providerExternalId).toMatch(/^mock-appointment-/);
    const replay = await service.bookDirectAppointment({
      tenantId: "tenant-a",
      conversationId: "conversation-1",
      selectedSlotId,
    });
    expect(replay).toMatchObject({ kind: "booked", providerExternalId: booked.providerExternalId });
    expect(appointmentWrites).toBe(1);
    expect(events).toEqual([]);
  });

  it("keeps the seed/reset target and cleanup plan fail-closed", () => {
    const seed = readFileSync(new URL("../../scripts/seed-phase1-demo.mjs", import.meta.url), "utf8");
    const reset = readFileSync(new URL("../../scripts/reset-phase1-demo.mjs", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../../scripts/run-phase1-demo.mjs", import.meta.url), "utf8");
    expect(seed).toContain('LOCAL_API_URL = "http://127.0.0.1:54321"');
    expect(seed).toContain("HOSTED_DEMO_TARGET_REFUSED");
    expect(seed).toContain("verifyHostedDemoTenant");
    expect(seed).not.toContain("SETTERFI_GHL_TEST_CONTACT_ID,");
    expect(reset.indexOf("cancelAppointment"))
      .toBeLessThan(reset.indexOf("const database = new pg.Client"));
    expect(reset).toContain("DEMO_RESET_REFUSED_BILLABLE_EVIDENCE_PRESENT");
    expect(reset).toContain("DEMO_RESET_READBACK_NOT_CLEAN");
    expect(runner).not.toContain("workspace-fixtures");
  });

  // Phase 4 gate
  it("gives the engine identical provider-blind input after GHL and Meta normalization", () => {
    const ghl = normalizeGhlInbound({
      webhookId: "ghl-event-1",
      locationId: "ghl-location-1",
      contactId: "ghl-contact-1",
      messageId: "ghl-message-1",
      messageType: "IG",
      body: "Synthetic inbound",
    }).events[0];
    const meta = normalizeMetaInbound({
      object: "instagram",
      entry: [{
        id: "instagram-account-1",
        messaging: [{
          sender: { id: "meta-contact-1" },
          recipient: { id: "instagram-account-1" },
          timestamp: Date.parse("2026-08-17T00:00:00.000Z"),
          message: { mid: "meta-message-1", text: "Synthetic inbound" },
        }],
      }],
    }).events[0];
    if (ghl.kind !== "message" || meta.kind !== "message") {
      throw new Error("expected normalized inbound messages");
    }
    const inbound = {
      tenantId: "tenant-a",
      contactId: "contact-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      messageInserted: true,
      disclosurePending: false,
      providerWindowExpiresAt: null,
    };
    const conversation: ConversationStateSnapshot = {
      id: "conversation-1",
      tenantId: "tenant-a",
      status: "agent",
      statusReason: null,
      currentStepAsks: 2,
      unreadByCoach: false,
    };

    const ghlInput = canonicalInboundEngineInput(
      "tenant-a", ghl, inbound, conversation, [], INBOUND_SAFETY,
    );
    const metaInput = canonicalInboundEngineInput(
      "tenant-a", meta, inbound, conversation, [], INBOUND_SAFETY,
    );
    expect(metaInput).toEqual(ghlInput);
    expect(JSON.stringify(metaInput)).not.toMatch(/ghl|meta_direct|provider/i);
  });

  it("refuses expired Meta freeform before I/O and sends only an approved template", async () => {
    const send = vi.fn(async () => ({ providerMessageId: "provider-message-1" }));
    const driver: MessagingDriver = {
      provider: "meta_direct",
      verifyWebhook: vi.fn(async () => true),
      normalizeInbound: vi.fn(async () => ({ events: [] })),
      capabilities: () => ({ windowed: true, postWindow: "template", templates: true }),
      send,
    };
    const dependencies: Partial<Omit<OutboundPolicyDependencies, "driver">> = {
      authorizeExisting: vi.fn(async () => ({ allowed: true as const })),
      resolveCapabilityWindow: vi.fn(async () => ({
        provider: "meta_direct" as const,
        capabilities: driver.capabilities("whatsapp"),
        providerWindowExpiresAt: "2026-08-16T00:00:00.000Z",
      })),
      loadTemplate: vi.fn(async ({ tenantId, templateId }) => ({
        id: templateId,
        tenantId,
        channel: "whatsapp" as const,
        provider: "meta_direct" as const,
        providerTemplateName: "SETTERFI_DEMO_PLACEHOLDER_APPROVED",
        locale: "en_US",
        bodyHash: "a".repeat(64),
        status: "approved" as const,
      })),
      recordWindowRefusal: vi.fn(async () => undefined),
      emitWindowExpired: vi.fn(async () => undefined),
      now: () => new Date("2026-08-17T00:00:00.000Z"),
    };
    const base = {
      tenantId: "tenant-a",
      conversationId: "conversation-1",
      channel: "whatsapp" as const,
      recipientExternalId: "synthetic-recipient",
      body: "SETTERFI_DEMO_PLACEHOLDER_OUTBOUND",
      isTest: true,
    };

    await expect(sendWithOutboundPolicy(base, driver, dependencies)).resolves.toEqual({
      kind: "refused",
      reason: "PROVIDER_WINDOW_EXPIRED",
    });
    expect(send).not.toHaveBeenCalled();

    const templated = await sendWithOutboundPolicy({
      ...base,
      template: { id: "template-1", variables: {} },
    }, driver, dependencies);
    expect(templated).toMatchObject({
      kind: "sent",
      providerMessageId: "provider-message-1",
      command: {
        kind: "approved_template",
        providerTemplateName: "SETTERFI_DEMO_PLACEHOLDER_APPROVED",
      },
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("renders approved demo templates as Demo and withholds unsupported approval truth", () => {
    const template: MessageTemplateView = {
      id: "template-1",
      channel: "whatsapp",
      providerTemplateName: "SETTERFI_DEMO_PLACEHOLDER_APPROVED",
      category: "utility",
      locale: "en_US",
      body: "SETTERFI_DEMO_PLACEHOLDER_APPROVED_BODY",
      bodyHash: "a".repeat(64),
      variables: [],
      status: "approved",
      submittedAt: "2026-08-17T00:00:00.000Z",
      approvedAt: "2026-08-17T00:01:00.000Z",
      rejectedAt: null,
      pausedAt: null,
      disabledAt: null,
      statusUpdatedAt: "2026-08-17T00:01:00.000Z",
      rejectionDetail: null,
      isDemo: true,
      dataLabel: "Demo",
    };
    expect(deriveTemplateTruth(template)).toEqual({ label: "Approved", tone: "good", isDemo: true });
    expect(deriveTemplateTruth({ ...template, approvedAt: null })).toEqual({
      label: "Status unavailable",
      tone: "pending",
      isDemo: true,
    });
  });

  it("pins the Phase 4 demo and real-arm safety contract in source", () => {
    const seed = readFileSync(new URL("../../scripts/seed-phase1-demo.mjs", import.meta.url), "utf8");
    const reset = readFileSync(new URL("../../scripts/reset-phase1-demo.mjs", import.meta.url), "utf8");
    const runner = readFileSync(new URL("../../scripts/run-phase1-demo.mjs", import.meta.url), "utf8");
    const runbook = readFileSync(new URL("../../scripts/phase4-demo-runbook.md", import.meta.url), "utf8");
    const metaReal = readFileSync(new URL("./integrations/meta.real.test.ts", import.meta.url), "utf8");
    const roundTrip = readFileSync(
      new URL("../app/api/webhooks/meta/real-roundtrip.test.ts", import.meta.url),
      "utf8",
    );

    expect(seed).toContain("PHASE4_TEMPLATE_ROWS");
    expect(seed).toContain("SETTERFI_DEMO_PLACEHOLDER_");
    expect(seed).toContain("is_demo: true");
    expect(seed).toContain('status: "approved"');
    expect(seed.match(/suffix: "CANDIDATE_/g)).toHaveLength(4);
    expect(seed).not.toContain("legacy-strong-notion");
    expect(reset).toContain("guardedDelete");
    expect(reset).not.toMatch(/database\.query\(\s*`DELETE FROM/);
    expect(runner.indexOf("assertDemoPortFree()"))
      .toBeLessThan(runner.indexOf("server = spawn(process.execPath"));
    expect(runbook).toMatch(/connect[\s\S]*signed inbound[\s\S]*provider-blind[\s\S]*window[\s\S]*switch[\s\S]*merge/i);
    for (const envName of [
      "SETTERFI_META_DRIVER",
      "META_SYSTEM_USER_TOKEN",
      "META_WABA_ID",
      "META_WHATSAPP_PHONE_NUMBER_ID",
    ]) {
      expect(metaReal).toContain(envName);
      expect(roundTrip).toContain(envName);
    }
    expect(roundTrip).toContain("providerMessageId");
    expect(roundTrip).toContain("signedReceipt");
    expect(roundTrip).toContain("persistedReadback");
  });
});

describe("Phase 6 demo contract", () => {
  const seed = readFileSync(new URL("../../scripts/seed-phase6-demo.mjs", import.meta.url), "utf8");
  const reset = readFileSync(new URL("../../scripts/reset-phase6-demo.mjs", import.meta.url), "utf8");
  const runner = readFileSync(new URL("../../scripts/run-phase6-demo.mjs", import.meta.url), "utf8");

  it("forces labelled demo tenants through the mock Stripe arm", () => {
    const real = vi.fn(() => {
      throw new Error("REAL_STRIPE_FACTORY_MUST_NOT_RUN");
    });
    const mock = vi.fn(() => createMockStripeDriver());
    const driver = resolveStripeDriver({
      isDemo: true,
      environment: { SETTERFI_STRIPE_DRIVER: "real" },
      factories: { mock, real },
    });
    expect(driver).toBeTruthy();
    expect(mock).toHaveBeenCalledOnce();
    expect(real).not.toHaveBeenCalled();
  });

  it("keeps the seed synthetic, demo-labelled, idempotent, and unapproved", () => {
    expect(seed).toContain("seedPhase5Demo");
    expect(seed).toContain("complete_onboarding_signup");
    expect(seed).toContain("is_demo = true");
    expect(seed).toContain("SETTERFI_DEMO_PLACEHOLDER_");
    expect(seed).not.toMatch(/approved\\s*=\\s*true/i);
    expect(seed).not.toMatch(/\\+?1[\\s().-]*\\d{3}[\\s).-]*\\d{3}[\\s.-]*\\d{4}/);
    expect(seed).toContain("on conflict (id) do nothing");
    expect(runner).toContain("real_stripe_calls=0");
  });

  it("scopes reset mutations to fixed Phase 6 identities", () => {
    expect(reset).toContain("PHASE6_DEMO_RESET_ANCESTRY_REFUSED");
    expect(reset).toContain("PHASE6_DEMO_IDS");
    expect(reset).not.toMatch(/\\btruncate\\b/i);
    expect(reset).not.toMatch(/supabase\\s+db\\s+reset/i);
    expect(reset).not.toMatch(/delete from public\\.tenants\\s*;/i);
  });

  it("keeps demo rows labelled and outside the real Stripe arm", () => {
    expect(seed).toContain("is_test, adjusts_event_id");
    expect(seed).toContain("values ($1, $2, -1");
    expect(seed).toContain('source":"SETTERFI_DEMO_PLACEHOLDER_COMPLETE');
    expect(seed).not.toContain("createRealStripeDriver");
  });
});

describe("demo gaps seed contract", () => {
  const seed = readFileSync(new URL("../../scripts/seed-demo-gaps.mjs", import.meta.url), "utf8");

  it("refuses to write without an explicit confirmation and a known demo ancestry", () => {
    expect(seed).toContain("DEMO_GAPS_CONFIRM_REQUIRED");
    expect(seed).toContain("DEMO_GAPS_TENANT_ANCESTRY_REFUSED");
    expect(seed).toContain("resolveDemoTarget");
    expect(seed).not.toMatch(/\btruncate\b/i);
    expect(seed).not.toMatch(/supabase\s+db\s+reset/i);
  });

  it("keeps the SMS lane registering and never marks it complete", async () => {
    const seeder = await import("../../scripts/seed-demo-gaps.mjs");
    const rows = seeder.provisioningStepRows("tenant", new Date("2026-08-22T00:00:00.000Z"));
    const sms = rows.find((row: { step_key: string }) => row.step_key === "sms_live");
    expect(sms).toMatchObject({ state: "awaiting_provider", awaiting_party: "carrier", completed_at: null });
    expect(rows.some((row: { step_key: string }) => row.step_key === "go_live")).toBe(false);
    expect(seeder.COMPLETED_STEP_KEYS).not.toContain("sms_live");
    expect(seed).toContain("DEMO_GAPS_READBACK_SMS_MUST_NOT_BE_COMPLETE");
  });

  it("carries a real A2P start date rather than a percentage or a predicted date", async () => {
    const seeder = await import("../../scripts/seed-demo-gaps.mjs");
    const now = new Date("2026-08-22T00:00:00.000Z");
    const submitted = seeder.a2pSubmittedAt(now);
    // read_coach_a2p_registration only accepts a full ISO stamp for the day counter.
    expect(submitted).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(submitted)).toBeLessThan(now.getTime());
  });

  it("never writes billable events, which would brick the phase 1 demo reset guard", () => {
    expect(seed).not.toMatch(/from\("billable_events"\)\s*\.\s*(insert|upsert)/);
    expect(seed).toContain("billable_events_written=0");
  });

  it("labels every synthetic value and leaves is_test to the database trigger", () => {
    expect(seed).toContain("SETTERFI_DEMO_PLACEHOLDER_");
    expect(seed).toContain("example.invalid");
    expect(seed).not.toMatch(/is_test\s*:/);
    expect(seed).not.toMatch(/\+?1[\s().-]*\d{3}[\s).-]*\d{3}[\s.-]*\d{4}/);
  });

  it("rolls the billing period so a demo never shows a lapsed subscription", async () => {
    const seeder = await import("../../scripts/seed-demo-gaps.mjs");
    const now = new Date("2026-09-14T09:30:00.000Z");
    const period = seeder.billingPeriodFor(now);
    expect(period).toEqual({ start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" });
    expect(seeder.periodCovers(
      { current_period_start: period.start, current_period_end: period.end }, now,
    )).toBe(true);
    // An August period read in September must be rewritten, not left on screen.
    expect(seeder.periodCovers(
      { current_period_start: "2026-08-01T00:00:00.000Z", current_period_end: "2026-09-01T00:00:00.000Z" }, now,
    )).toBe(false);
  });

  it("gives the affiliate portal both coarse statuses it can render", async () => {
    const seeder = await import("../../scripts/seed-demo-gaps.mjs");
    const fixtures = seeder.referredBusinessFixtures();
    expect(fixtures).toHaveLength(3);
    // affiliate_referral_projection maps churned to 'inactive' and active to 'active'.
    expect(fixtures.filter((row: { finalStatus: string }) => row.finalStatus === "active")).toHaveLength(2);
    expect(fixtures.some((row: { finalStatus: string }) => row.finalStatus === "churned")).toBe(true);
  });

  it("creates referrals through the signup path the trigger allows", () => {
    expect(seed).toContain("complete_onboarding_signup");
    expect(seed).not.toMatch(/from\("referrals"\)\s*\.\s*(insert|upsert)/);
    // The staging affiliate's referral code is random, so it must be read rather than assumed.
    expect(seed).toContain('.eq("user_id", affiliateUser.id)');
  });
});
