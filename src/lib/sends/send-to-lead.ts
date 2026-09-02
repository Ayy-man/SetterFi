/**
 * Single ordered gateway for every lead-facing outbound purpose.
 *
 * Repository and provider effects are injected because Plan 03-07 owns live adoption. The order
 * here is the contract: test isolation, tombstones, live suppression, consent, capability/window,
 * quiet hours, physical dispatch, and evidence read-back.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import { DriverConfigurationError } from "@/lib/env-contract";
import type { IdentityProvider } from "@/lib/integrations/types";
import {
  resolveChannelCapability,
  type ChannelCapabilityFeed,
} from "@/lib/sends/channel-capabilities";
import type {
  ControlMessagePurpose,
  MessagingDispatchPort,
  MessagingDispatchReceipt,
  PersistedSendReceipt,
  QuietHoursPort,
  SendContent,
  SendRefusalReason,
  SendToLeadRequest,
  SendToLeadResult,
} from "@/lib/sends/contracts";
import {
  approvedControlCopy,
  evaluateSendPermission,
  isControlPurpose,
  resolveConsentBasis,
  type ConsentFacts,
} from "@/lib/sends/permission";
import { hashSuppressionIdentifier } from "@/lib/suppression/identifier-hash";

export type SendTarget = {
  tenantId: string;
  contactId: string;
  identityId: string;
  provider: IdentityProvider;
  channel: MessagingChannel;
  recipientExternalId: string;
  normalizedIdentifier: string;
};

export type SendEligibility = ConsentFacts & {
  providerWindowOpen: boolean;
  capabilityFeed: ChannelCapabilityFeed;
  templateApproved: boolean;
  originalScheduledAt: string | null;
  deferredCount: number;
  followupId: string | null;
};

export type SendAttemptClaim =
  | { kind: "claimed"; claimToken: string; dispatchContent: SendContent }
  | { kind: "resume_accepted"; claimToken: string; dispatch: MessagingDispatchReceipt }
  | { kind: "replay"; result: SendToLeadResult }
  | { kind: "in_progress" }
  | { kind: "indeterminate" };

export type SendPersistencePort = {
  loadReplay(input: {
    request: SendToLeadRequest;
    target: SendTarget;
    content: SendContent;
  }): Promise<SendToLeadResult | null>;
  resolveTarget(request: SendToLeadRequest): Promise<SendTarget | null>;
  isTestRecipientVerified(input: {
    tenantId: string;
    channel: MessagingChannel;
    identifierHash: string;
  }): Promise<boolean>;
  hasDeletionTombstone(input: {
    tenantId: string;
    channel: MessagingChannel;
    identifierHash: string;
  }): Promise<boolean>;
  hasLiveSuppression(input: {
    tenantId: string;
    channel: MessagingChannel;
    identifierHash: string;
    contactId: string;
  }): Promise<boolean>;
  loadEligibility(request: SendToLeadRequest, target: SendTarget): Promise<SendEligibility | null>;
  loadControlCopy(purpose: ControlMessagePurpose): Promise<{ approved: boolean; body: string } | null>;
  recordRefusal(input: {
    request: SendToLeadRequest;
    target: SendTarget | null;
    reason: SendRefusalReason;
  }): Promise<number | null>;
  persistDeferred(input: {
    request: SendToLeadRequest;
    target: SendTarget;
    eligibility: SendEligibility;
    scheduledAt: string;
  }): Promise<{ followupId: string; auditId: number } | null>;
  persistDiscarded(input: {
    request: SendToLeadRequest;
    target: SendTarget;
    eligibility: SendEligibility;
    reason: "provider_window_closed" | "already_deferred" | "stale";
  }): Promise<{ followupId: string | null; auditId: number | null }>;
  claimDispatch(input: {
    request: SendToLeadRequest;
    target: SendTarget;
    content: SendContent;
    campaignInitiated: boolean;
  }): Promise<SendAttemptClaim>;
  recordProviderAcceptance(input: {
    request: SendToLeadRequest;
    claimToken: string;
    dispatch: MessagingDispatchReceipt;
  }): Promise<boolean>;
  markDispatchIndeterminate(input: {
    request: SendToLeadRequest;
    claimToken: string;
    errorCode: string;
  }): Promise<void>;
  releaseUndispatchedClaim(input: {
    request: SendToLeadRequest;
    claimToken: string;
  }): Promise<void>;
  persistSend(input: {
    request: SendToLeadRequest;
    target: SendTarget;
    content: SendContent;
    dispatch: MessagingDispatchReceipt;
    claimToken: string;
  }): Promise<PersistedSendReceipt | null>;
};

export type SendToLeadDependencies = {
  phaseEnabled(tenantId: string): boolean;
  persistence: SendPersistencePort;
  quietHours: QuietHoursPort;
  dispatch: MessagingDispatchPort;
  hashIdentifier?: typeof hashSuppressionIdentifier;
  now?: () => string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validRequest(request: SendToLeadRequest) {
  return UUID_PATTERN.test(request.tenantId) && UUID_PATTERN.test(request.contactId) &&
    UUID_PATTERN.test(request.conversationId) &&
    (request.nominatedIdentityId === null || UUID_PATTERN.test(request.nominatedIdentityId)) &&
    Boolean(request.idempotencyKey.trim()) && request.idempotencyKey.length <= 200 &&
    Number.isFinite(Date.parse(request.occurredAt)) &&
    (request.humanQuietHoursOverride !== true || request.purpose === "human_reply") &&
    (request.content.kind === "freeform"
      ? Boolean(request.content.body.trim())
      : Boolean(request.content.templateKey.trim()));
}

function baseReceipt(
  request: SendToLeadRequest,
  target: SendTarget | null,
  decidedAt: string,
  auditId: number | null,
) {
  return {
    tenantId: request.tenantId,
    contactId: request.contactId,
    conversationId: request.conversationId,
    identityId: target?.identityId ?? null,
    purpose: request.purpose,
    idempotencyKey: request.idempotencyKey,
    decidedAt,
    auditId,
  };
}

async function refused(
  request: SendToLeadRequest,
  target: SendTarget | null,
  reason: SendRefusalReason,
  dependencies: SendToLeadDependencies,
): Promise<SendToLeadResult> {
  let auditId: number | null = null;
  try {
    auditId = await dependencies.persistence.recordRefusal({ request, target, reason });
  } catch {
    // A refusal remains closed when its evidence write fails; null prevents honest UI from
    // rendering "Logged" while Plan 03-07's reconciliation path repairs the missing receipt.
  }
  return {
    kind: "refused",
    reason,
    receipt: baseReceipt(request, target, (dependencies.now ?? (() => new Date().toISOString()))(), auditId),
  };
}

export async function sendToLead(
  request: SendToLeadRequest,
  dependencies: SendToLeadDependencies,
): Promise<SendToLeadResult> {
  const now = dependencies.now ?? (() => new Date().toISOString());
  const enabled = dependencies.phaseEnabled(request.tenantId);
  if (!enabled) return refused(request, null, "phase_disabled", dependencies);
  if (!validRequest(request)) return refused(request, null, "invalid_request", dependencies);

  const target = await dependencies.persistence.resolveTarget(request);
  const targetValid = target !== null && target.tenantId === request.tenantId &&
    target.contactId === request.contactId &&
    (request.nominatedIdentityId === null || target.identityId === request.nominatedIdentityId);
  if (!target || !targetValid) return refused(request, target, "invalid_request", dependencies);

  if (!isControlPurpose(request.purpose)) {
    const replay = await dependencies.persistence.loadReplay({ request, target, content: request.content });
    if (replay) return replay;
  }

  const hash = (dependencies.hashIdentifier ?? hashSuppressionIdentifier)(target.normalizedIdentifier);
  if (request.isTest) {
    const verified = await dependencies.persistence.isTestRecipientVerified({
      tenantId: request.tenantId,
      channel: target.channel,
      identifierHash: hash,
    });
    if (!verified) return refused(request, target, "test_recipient_not_verified", dependencies);
  }

  const tombstoned = await dependencies.persistence.hasDeletionTombstone({
    tenantId: request.tenantId,
    channel: target.channel,
    identifierHash: hash,
  });
  if (tombstoned && !isControlPurpose(request.purpose)) {
    return refused(request, target, "suppressed", dependencies);
  }
  const locallySuppressed = await dependencies.persistence.hasLiveSuppression({
    tenantId: request.tenantId,
    channel: target.channel,
    identifierHash: hash,
    contactId: request.contactId,
  });
  if (locallySuppressed && !isControlPurpose(request.purpose)) {
    return refused(request, target, "suppressed", dependencies);
  }

  const eligibility = await dependencies.persistence.loadEligibility(request, target);
  if (!eligibility) return refused(request, target, "invalid_request", dependencies);
  let content = request.content;
  let controlCopyApproved = true;
  if (isControlPurpose(request.purpose)) {
    const body = approvedControlCopy(
      await dependencies.persistence.loadControlCopy(request.purpose as ControlMessagePurpose),
    );
    controlCopyApproved = body !== null;
    if (body) content = { kind: "freeform", body };
  }

  if (isControlPurpose(request.purpose)) {
    const replay = await dependencies.persistence.loadReplay({ request, target, content });
    if (replay) return replay;
  }

  const consentBasis = resolveConsentBasis(request.purpose, eligibility, request.occurredAt);
  if (!isControlPurpose(request.purpose) && consentBasis === null) {
    return refused(request, target, "no_consent_basis", dependencies);
  }

  const quietHours = isControlPurpose(request.purpose)
    ? { kind: "send_now" as const }
    : await dependencies.quietHours.resolve({
        tenantId: request.tenantId,
        contactId: request.contactId,
        channel: target.channel,
        purpose: request.purpose,
        occurredAt: request.occurredAt,
        originalScheduledAt: eligibility.originalScheduledAt,
        deferredCount: eligibility.deferredCount,
      });
  const capability = resolveChannelCapability(target.channel, eligibility.capabilityFeed);
  const permission = evaluateSendPermission({
    phaseEnabled: enabled,
    requestValid: true,
    targetValid,
    isTest: request.isTest,
    testRecipientVerified: true,
    tombstoned,
    locallySuppressed,
    purpose: request.purpose,
    content,
    controlCopyApproved,
    consentBasis,
    providerWindowOpen: eligibility.providerWindowOpen,
    capability,
    templateApproved: eligibility.templateApproved,
    quietHours: request.purpose === "human_reply" && request.humanQuietHoursOverride === true &&
        quietHours.kind === "defer_once"
      ? { kind: "send_now" }
      : quietHours,
  });

  if (permission.kind === "refused") {
    return refused(request, target, permission.reason, dependencies);
  }
  if (permission.kind === "deferred") {
    if (request.purpose === "human_reply") {
      if (quietHours.kind !== "defer_once") {
        return refused(request, target, "provider_unconfirmed", dependencies);
      }
      return {
        kind: "confirmation_required",
        reason: "quiet_hours",
        scheduledAt: quietHours.at,
        timezoneSource: quietHours.timezoneSource,
        leadLocalTimes: quietHours.leadLocalTimes,
        allowedWindow: quietHours.allowedWindow,
        receipt: baseReceipt(request, target, now(), null),
      };
    }
    const persisted = await dependencies.persistence.persistDeferred({
      request,
      target,
      eligibility,
      scheduledAt: permission.at,
    });
    if (!persisted) return refused(request, target, "provider_unconfirmed", dependencies);
    return {
      kind: "deferred",
      reason: "quiet_hours",
      scheduledAt: permission.at,
      timezoneSource: permission.timezoneSource,
      followupId: persisted.followupId,
      receipt: baseReceipt(request, target, now(), persisted.auditId) as ReturnType<typeof baseReceipt> & { auditId: number },
    };
  }
  if (permission.kind === "discarded") {
    const persisted = await dependencies.persistence.persistDiscarded({
      request,
      target,
      eligibility,
      reason: permission.reason,
    });
    return {
      kind: "discarded",
      reason: permission.reason,
      followupId: persisted.followupId,
      receipt: baseReceipt(request, target, now(), persisted.auditId),
    };
  }

  const claim = await dependencies.persistence.claimDispatch({
    request,
    target,
    content,
    campaignInitiated: !isControlPurpose(request.purpose) && consentBasis !== "reply_in_turn",
  });
  if (claim.kind === "replay") return claim.result;
  if (claim.kind === "in_progress" || claim.kind === "indeterminate") {
    return refused(request, target, "provider_unconfirmed", dependencies);
  }

  let dispatch: MessagingDispatchReceipt;
  if (claim.kind === "resume_accepted") {
    dispatch = claim.dispatch;
  } else {
    try {
      dispatch = await dependencies.dispatch.send({
        tenantId: request.tenantId,
        conversationId: request.conversationId,
        identityId: target.identityId,
        channel: target.channel,
        recipientExternalId: target.recipientExternalId,
        purpose: request.purpose,
        content: claim.dispatchContent,
        idempotencyKey: request.idempotencyKey,
      });
    } catch (error) {
      if (error instanceof DriverConfigurationError) {
        await dependencies.persistence.releaseUndispatchedClaim({
          request,
          claimToken: claim.claimToken,
        });
        throw error;
      }
      await dependencies.persistence.markDispatchIndeterminate({
        request,
        claimToken: claim.claimToken,
        errorCode: error instanceof Error ? error.message.slice(0, 200) : "PROVIDER_SEND_UNKNOWN_ERROR",
      });
      return refused(request, target, "provider_unconfirmed", dependencies);
    }
    const accepted = await dependencies.persistence.recordProviderAcceptance({
      request,
      claimToken: claim.claimToken,
      dispatch,
    });
    if (!accepted) return refused(request, target, "provider_unconfirmed", dependencies);
  }
  let persisted: PersistedSendReceipt | null;
  try {
    persisted = await dependencies.persistence.persistSend({
      request,
      target,
      content: claim.kind === "claimed" ? claim.dispatchContent : content,
      dispatch,
      claimToken: claim.claimToken,
    });
  } catch {
    persisted = null;
  }
  if (!persisted || persisted.providerMessageId !== dispatch.providerMessageId ||
    !persisted.messageId || persisted.auditId <= 0 || !Number.isFinite(Date.parse(persisted.persistedAt))) {
    return refused(request, target, "provider_unconfirmed", dependencies);
  }
  return {
    kind: "sent",
    channel: target.channel,
    receipt: {
      ...baseReceipt(request, target, now(), persisted.auditId),
      ...persisted,
    },
  };
}
