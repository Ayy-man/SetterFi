/**
 * Library-only orchestration for leased follow-ups and cadence lifecycle.
 *
 * Postgres owns claims and terminal transitions, sendToLead owns permission and
 * dispatch, and this module owns their deterministic ordering. A stable
 * follow-up idempotency key makes a crash after dispatch safe to replay.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import type { OfferCadencePurpose } from "@/lib/offer/types";
import {
  resolveChannelCapability,
  type CadenceClass,
  type ChannelCapabilityFeed,
} from "@/lib/sends/channel-capabilities";
import type {
  SendContent,
  SendToLeadRequest,
  SendToLeadResult,
} from "@/lib/sends/contracts";

import {
  materializeCadence,
  type MaterializeCadenceInput,
  type MaterializedFollowup,
} from "./materialize";

const DAY_MS = 24 * 60 * 60 * 1_000;
const STANDING_CONSENT_SOURCES = new Set([
  "web_form",
  "lead_confirmed_sms",
  "verbal_recorded",
  "platform_admin",
]);

export type FollowupClaim = {
  followupId: string;
  leaseToken: string;
  dueAt: string;
  auditId: string;
};

export type ClaimedFollowup = {
  id: string;
  tenantId: string;
  contactId: string;
  conversationId: string;
  channel: MessagingChannel;
  purpose: OfferCadencePurpose;
  cadenceAnchorAt: string;
  providerWindowExpiresAt: string | null;
  originalScheduledAt: string | null;
  deferredCount: number;
  isTest: boolean;
  storedChannelClass: CadenceClass;
};

export type FollowupIdentityCandidate = {
  id: string;
  channel: MessagingChannel;
  consentState: "none" | "reply_only" | "conversation" | "opted_in" | "unverified" | "suppressed";
  consentSource: string | null;
  consentExpiresAt: string | null;
  providerWindowExpiresAt: string | null;
  isConversationIdentity: boolean;
  capabilityFeed?: ChannelCapabilityFeed;
};

export type FollowupDestination = {
  identityId: string;
  channel: MessagingChannel;
  crossChannel: boolean;
  providerWindowExpiresAt: string | null;
  capabilityFeed: ChannelCapabilityFeed;
};

export type FollowupCanceledReason =
  | "lead_reply"
  | "opted_out"
  | "no_consent"
  | "stale"
  | "window_closed"
  | "conversation_closed";

export type CompleteFollowupInput = {
  tenantId: string;
  followupId: string;
  leaseToken: string;
  outcome: "sent" | "canceled" | "deferred";
  scheduledAt: string | null;
  canceledReason: FollowupCanceledReason | null;
};

export type LinkedConversationIntent = {
  tenantId: string;
  contactId: string;
  originConversationId: string;
  originChannel: MessagingChannel;
  targetIdentityId: string;
  targetChannel: MessagingChannel;
  cadenceAnchorAt: string;
  idempotencyKey: string;
};

/**
 * What the copy gate hands back for one due touch. "unavailable" is a per-touch block rather than
 * a thrown error: the touch keeps its lease until it expires, the next batch re-claims it, and the
 * operator reads the reason off the job receipt instead of a failed run that stranded every other
 * touch the batch had already claimed.
 */
export type FollowupContentResult =
  | SendContent
  | { kind: "unavailable"; reason: FollowupBlockedReason };

export type FollowupBlockedReason = "approved_followup_copy_required";

export type FollowupSchedulerRepository = {
  claimDueFollowups(input: {
    tenantId: string;
    workerKey: string;
    limit: number;
    leaseSeconds: number;
    now: string;
  }): Promise<readonly FollowupClaim[]>;
  loadClaimedFollowup(input: {
    tenantId: string;
    followupId: string;
    leaseToken: string;
  }): Promise<ClaimedFollowup | null>;
  loadIdentityCandidates(input: {
    tenantId: string;
    contactId: string;
    conversationId: string;
  }): Promise<readonly FollowupIdentityCandidate[]>;
  loadApprovedFollowupContent(input: {
    tenantId: string;
    followupId: string;
    purpose: OfferCadencePurpose;
    destination: FollowupDestination;
  }): Promise<FollowupContentResult>;
  recordResolvedIdentity(input: {
    tenantId: string;
    followupId: string;
    leaseToken: string;
    identityId: string;
  }): Promise<void>;
  ensureLinkedConversationIntent(input: LinkedConversationIntent): Promise<{ conversationId: string }>;
  completeFollowupAttempt(input: CompleteFollowupInput): Promise<{ auditId: string }>;
  markNurtureIfExhausted(input: {
    tenantId: string;
    conversationId: string;
    occurredAt: string;
  }): Promise<void>;
  cancelContactFollowupsOnInbound(input: {
    tenantId: string;
    contactId: string;
    inboundMessageId: string;
  }): Promise<{ canceledCount: number; auditId: string | null }>;
  replaceFutureCadence(input: {
    tenantId: string;
    conversationId: string;
    materializedAt: string;
    followups: readonly MaterializedFollowup[];
  }): Promise<void>;
  closeStaleConversations(input: {
    tenantId: string;
    lastLeadInboundBefore: string;
    occurredAt: string;
  }): Promise<{ closedCount: number }>;
  claimConversation(input: {
    tenantId: string;
    conversationId: string;
    actorId: string;
    expectedStatus: "agent" | "needs_human" | "human" | "nurture" | "closed" | "opted_out";
    expectedHolderId: string | null;
    confirmDisplace: boolean;
  }): Promise<{ auditId: string }>;
  /** The release RPC and replacement of every paused/scheduled row commit atomically. */
  releaseConversationWithCadence(input: {
    tenantId: string;
    conversationId: string;
    actorId: string;
    expectedHolderId: string;
    materializedAt: string;
    followups: readonly MaterializedFollowup[];
  }): Promise<{ auditId: string }>;
};

export type SendToLead = (request: SendToLeadRequest) => Promise<SendToLeadResult>;

export type FollowupRunResult = {
  followupId: string;
  outcome: "sent" | "deferred" | "canceled" | "retryable" | "blocked" | "claim_missing";
  reason: string | null;
};

function activeConsent(candidate: FollowupIdentityCandidate, now: number) {
  if (candidate.consentState !== "conversation" && candidate.consentState !== "opted_in") {
    return false;
  }
  return candidate.consentExpiresAt === null || Date.parse(candidate.consentExpiresAt) > now;
}

function capabilityIsDurable(candidate: FollowupIdentityCandidate) {
  const capability = resolveChannelCapability(candidate.channel, candidate.capabilityFeed ?? {});
  return capability.postWindow === "freeform" ||
    (capability.postWindow === "template" && capability.templateSend);
}

function canDeliverOnOwnChannel(candidate: FollowupIdentityCandidate, now: number) {
  return capabilityIsDurable(candidate) ||
    (candidate.providerWindowExpiresAt !== null &&
      Date.parse(candidate.providerWindowExpiresAt) > now);
}

function fallbackRank(candidate: FollowupIdentityCandidate) {
  if (candidate.channel === "sms" && capabilityIsDurable(candidate)) return 0;
  const capability = resolveChannelCapability(candidate.channel, candidate.capabilityFeed ?? {});
  if (candidate.channel === "whatsapp" && capability.postWindow === "template" &&
    capability.templateSend) return 1;
  return Number.POSITIVE_INFINITY;
}

export function resolveFollowupDestination(
  followup: ClaimedFollowup,
  candidates: readonly FollowupIdentityCandidate[],
  occurredAt: string,
): FollowupDestination | null {
  const now = Date.parse(occurredAt);
  if (!Number.isFinite(now)) throw new Error("FOLLOWUP_OCCURRED_AT_INVALID");

  const own = candidates
    .filter((candidate) => candidate.isConversationIdentity &&
      candidate.channel === followup.channel && activeConsent(candidate, now) &&
      canDeliverOnOwnChannel(candidate, now))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (own) {
    return {
      identityId: own.id,
      channel: own.channel,
      crossChannel: false,
      providerWindowExpiresAt: own.providerWindowExpiresAt,
      capabilityFeed: own.capabilityFeed ?? {},
    };
  }

  const fallback = candidates
    .filter((candidate) => !candidate.isConversationIdentity && activeConsent(candidate, now) &&
      candidate.consentSource !== null && STANDING_CONSENT_SOURCES.has(candidate.consentSource) &&
      Number.isFinite(fallbackRank(candidate)))
    .sort((left, right) => fallbackRank(left) - fallbackRank(right) ||
      left.id.localeCompare(right.id))[0];
  if (!fallback) return null;
  return {
    identityId: fallback.id,
    channel: fallback.channel,
    crossChannel: true,
    providerWindowExpiresAt: fallback.providerWindowExpiresAt,
    capabilityFeed: fallback.capabilityFeed ?? {},
  };
}

function completionForResult(
  followup: ClaimedFollowup,
  leaseToken: string,
  result: SendToLeadResult,
  destination: FollowupDestination,
): CompleteFollowupInput | null {
  const common = {
    tenantId: followup.tenantId,
    followupId: followup.id,
    leaseToken,
  };
  if (result.kind === "sent") {
    if (result.channel !== destination.channel) return null;
    return { ...common, outcome: "sent", scheduledAt: null, canceledReason: null };
  }
  if (result.kind === "deferred") {
    const closesBeforeDeferral = !capabilityIsDurable({
      id: destination.identityId,
      channel: destination.channel,
      consentState: "opted_in",
      consentSource: "platform_admin",
      consentExpiresAt: null,
      providerWindowExpiresAt: destination.providerWindowExpiresAt,
      isConversationIdentity: !destination.crossChannel,
      capabilityFeed: destination.capabilityFeed,
    }) && destination.providerWindowExpiresAt !== null &&
      Date.parse(result.scheduledAt) >= Date.parse(destination.providerWindowExpiresAt);
    return closesBeforeDeferral
      ? { ...common, outcome: "canceled", scheduledAt: null, canceledReason: "window_closed" }
      : { ...common, outcome: "deferred", scheduledAt: result.scheduledAt, canceledReason: null };
  }
  if (result.kind === "discarded") {
    return {
      ...common,
      outcome: "canceled",
      scheduledAt: null,
      canceledReason: result.reason === "provider_window_closed" ? "window_closed" : "stale",
    };
  }
  if (result.reason === "no_consent_basis") {
    return { ...common, outcome: "canceled", scheduledAt: null, canceledReason: "no_consent" };
  }
  if (result.reason === "suppressed") {
    return { ...common, outcome: "canceled", scheduledAt: null, canceledReason: "opted_out" };
  }
  return null;
}

async function runClaim(
  claim: FollowupClaim,
  tenantId: string,
  occurredAt: string,
  repository: FollowupSchedulerRepository,
  sendToLead: SendToLead,
): Promise<FollowupRunResult> {
  const followup = await repository.loadClaimedFollowup({
    tenantId,
    followupId: claim.followupId,
    leaseToken: claim.leaseToken,
  });
  if (!followup) {
    return { followupId: claim.followupId, outcome: "claim_missing", reason: null };
  }

  const candidates = await repository.loadIdentityCandidates({
    tenantId: followup.tenantId,
    contactId: followup.contactId,
    conversationId: followup.conversationId,
  });
  const destination = resolveFollowupDestination(followup, candidates, occurredAt);
  if (!destination) {
    await repository.completeFollowupAttempt({
      tenantId: followup.tenantId,
      followupId: followup.id,
      leaseToken: claim.leaseToken,
      outcome: "canceled",
      scheduledAt: null,
      canceledReason: "no_consent",
    });
    await repository.markNurtureIfExhausted({
      tenantId: followup.tenantId,
      conversationId: followup.conversationId,
      occurredAt,
    });
    return { followupId: followup.id, outcome: "canceled", reason: "no_consent" };
  }

  await repository.recordResolvedIdentity({
    tenantId: followup.tenantId,
    followupId: followup.id,
    leaseToken: claim.leaseToken,
    identityId: destination.identityId,
  });
  const idempotencyKey = `followup:${followup.id}`;
  const conversationId = destination.crossChannel
    ? (await repository.ensureLinkedConversationIntent({
        tenantId: followup.tenantId,
        contactId: followup.contactId,
        originConversationId: followup.conversationId,
        originChannel: followup.channel,
        targetIdentityId: destination.identityId,
        targetChannel: destination.channel,
        cadenceAnchorAt: followup.cadenceAnchorAt,
        idempotencyKey,
      })).conversationId
    : followup.conversationId;
  const content = await repository.loadApprovedFollowupContent({
    tenantId: followup.tenantId,
    followupId: followup.id,
    purpose: followup.purpose,
    destination,
  });
  if (content.kind === "unavailable") {
    // The row stays scheduled and claimed; the lease lapses and the next batch tries again. The
    // status enum has no "blocked" member and cancelling would misreport missing copy as a lead
    // outcome, so the attempt counter on the row and the receipt counters carry the evidence.
    return { followupId: followup.id, outcome: "blocked", reason: content.reason };
  }
  const result = await sendToLead({
    tenantId: followup.tenantId,
    contactId: followup.contactId,
    conversationId,
    nominatedIdentityId: destination.identityId,
    purpose: "follow_up",
    content,
    idempotencyKey,
    occurredAt,
    isTest: followup.isTest,
  });
  const completion = completionForResult(followup, claim.leaseToken, result, destination);
  if (!completion) {
    return {
      followupId: followup.id,
      outcome: "retryable",
      reason: result.kind === "refused" ? result.reason : "unhandled_result",
    };
  }

  await repository.completeFollowupAttempt(completion);
  if (completion.outcome !== "deferred") {
    await repository.markNurtureIfExhausted({
      tenantId: followup.tenantId,
      conversationId: followup.conversationId,
      occurredAt,
    });
  }
  return {
    followupId: followup.id,
    outcome: completion.outcome === "sent" ? "sent" :
      completion.outcome === "deferred" ? "deferred" : "canceled",
    reason: completion.canceledReason,
  };
}

export async function runFollowupBatch(
  input: {
    tenantId: string;
    workerKey: string;
    now: string;
    limit?: number;
    leaseSeconds?: number;
  },
  dependencies: { repository: FollowupSchedulerRepository; sendToLead: SendToLead },
) {
  const claims = await dependencies.repository.claimDueFollowups({
    tenantId: input.tenantId,
    workerKey: input.workerKey,
    limit: input.limit ?? 50,
    leaseSeconds: input.leaseSeconds ?? 120,
    now: input.now,
  });
  const results: FollowupRunResult[] = [];
  for (const claim of claims) {
    results.push(await runClaim(
      claim,
      input.tenantId,
      input.now,
      dependencies.repository,
      dependencies.sendToLead,
    ));
  }
  return results;
}

export type InboundCadenceEvent = {
  kind: "lead_message" | "reaction" | "read_receipt" | "delivery_status" | "echo" | "provider_ack";
  tenantId: string;
  contactId: string;
  inboundMessageId: string;
  materialization: MaterializeCadenceInput;
};

export async function cancelInboundCadence(
  event: Pick<InboundCadenceEvent, "kind" | "tenantId" | "contactId" | "inboundMessageId">,
  repository: FollowupSchedulerRepository,
) {
  if (event.kind !== "lead_message") return { kind: "ignored" as const };
  const cancellation = await repository.cancelContactFollowupsOnInbound({
    tenantId: event.tenantId,
    contactId: event.contactId,
    inboundMessageId: event.inboundMessageId,
  });
  return { kind: "canceled" as const, ...cancellation };
}

export async function reanchorInboundCadence(
  materialization: MaterializeCadenceInput,
  repository: FollowupSchedulerRepository,
) {
  const followups = materializeCadence(materialization);
  await repository.replaceFutureCadence({
    tenantId: materialization.tenantId,
    conversationId: materialization.conversationId,
    materializedAt: materialization.materializedAt,
    followups,
  });
  return { kind: "reanchored" as const, followups };
}

export async function handleInboundCadence(
  event: InboundCadenceEvent,
  repository: FollowupSchedulerRepository,
) {
  if (event.kind !== "lead_message") return { kind: "ignored" as const };
  const cancellation = await cancelInboundCadence(event, repository);
  const reanchored = await reanchorInboundCadence(event.materialization, repository);
  return { ...cancellation, kind: "reanchored" as const, followups: reanchored.followups };
}

export async function runDailyLifecycleSweep(
  input: { tenantId: string; now: string },
  repository: FollowupSchedulerRepository,
) {
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) throw new Error("LIFECYCLE_SWEEP_INSTANT_INVALID");
  return repository.closeStaleConversations({
    tenantId: input.tenantId,
    lastLeadInboundBefore: new Date(now - 30 * DAY_MS).toISOString(),
    occurredAt: input.now,
  });
}

export async function pauseCadenceForTakeover(
  input: Parameters<FollowupSchedulerRepository["claimConversation"]>[0],
  repository: FollowupSchedulerRepository,
) {
  return repository.claimConversation(input);
}

export async function resumeCadenceAfterHandback(
  input: {
    tenantId: string;
    conversationId: string;
    actorId: string;
    expectedHolderId: string;
    materialization: MaterializeCadenceInput;
  },
  repository: FollowupSchedulerRepository,
) {
  const followups = materializeCadence(input.materialization);
  const receipt = await repository.releaseConversationWithCadence({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    actorId: input.actorId,
    expectedHolderId: input.expectedHolderId,
    materializedAt: input.materialization.materializedAt,
    followups,
  });
  return { ...receipt, followups };
}
