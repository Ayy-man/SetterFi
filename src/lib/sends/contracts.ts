/**
 * Closed contracts for every lead-facing outbound decision.
 *
 * Policy and persistence stay outside provider adapters so a provider acceptance cannot be
 * mistaken for a persisted send, a confirmed suppression, or a completed deletion.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import type { IdentityProvider } from "@/lib/integrations/types";

export const SEND_PURPOSES = [
  "agent_reply",
  "follow_up",
  "human_reply",
  "stop_confirmation",
  "help_confirmation",
  "start_confirmation",
] as const;

export type SendPurpose = (typeof SEND_PURPOSES)[number];

export const CONTROL_MESSAGE_PURPOSES = [
  "stop_confirmation",
  "help_confirmation",
  "start_confirmation",
] as const satisfies readonly SendPurpose[];

export type ControlMessagePurpose = (typeof CONTROL_MESSAGE_PURPOSES)[number];

export type SendContent =
  | { kind: "freeform"; body: string }
  | { kind: "approved_template"; templateKey: string; variables: Readonly<Record<string, string>> };

export type SendToLeadRequest = {
  tenantId: string;
  contactId: string;
  conversationId: string;
  nominatedIdentityId: string | null;
  purpose: SendPurpose;
  content: SendContent;
  idempotencyKey: string;
  occurredAt: string;
  isTest: boolean;
  /** Explicit human confirmation to send outside the resolved lead-local messaging window. */
  humanQuietHoursOverride?: boolean;
  /** Active database lease whose inbound worker owns this agent reply. */
  originReceipt?: {
    receiptId: string;
    leaseToken: string;
    attemptNumber: number;
  } | null;
};

export type DecisionReceipt = {
  tenantId: string;
  contactId: string;
  conversationId: string;
  identityId: string | null;
  purpose: SendPurpose;
  idempotencyKey: string;
  decidedAt: string;
  auditId: number | null;
};

export type PersistedSendReceipt = {
  providerMessageId: string;
  messageId: string;
  auditId: number;
  persistedAt: string;
};

export type SendRefusalReason =
  | "phase_disabled"
  | "invalid_request"
  | "test_recipient_not_verified"
  | "suppressed"
  | "no_consent_basis"
  | "copy_unapproved"
  | "template_not_approved"
  | "provider_unconfirmed";

export type SendDiscardReason =
  | "provider_window_closed"
  | "already_deferred"
  | "stale";

export type SendToLeadResult =
  | {
      kind: "sent";
      channel: MessagingChannel;
      receipt: DecisionReceipt & PersistedSendReceipt;
    }
  | {
      kind: "deferred";
      reason: "quiet_hours";
      scheduledAt: string;
      timezoneSource: "contact" | "npa" | "continental_intersection";
      followupId: string;
      receipt: DecisionReceipt & { auditId: number };
    }
  | {
      kind: "confirmation_required";
      reason: "quiet_hours";
      scheduledAt: string;
      timezoneSource: "contact" | "npa" | "continental_intersection";
      leadLocalTimes: readonly string[];
      allowedWindow: string;
      receipt: DecisionReceipt;
    }
  | {
      kind: "refused";
      reason: SendRefusalReason;
      receipt: DecisionReceipt;
    }
  | {
      kind: "discarded";
      reason: SendDiscardReason;
      followupId: string | null;
      receipt: DecisionReceipt;
    };

export type QuietHoursDecision =
  | { kind: "send_now" }
  | {
      kind: "defer_once";
      at: string;
      timezoneSource: "contact" | "npa" | "continental_intersection";
      leadLocalTimes: readonly string[];
      allowedWindow: string;
    }
  | { kind: "cancel_stale"; reason: "already_deferred" | "stale" };

export type QuietHoursInput = {
  tenantId: string;
  contactId: string;
  channel: MessagingChannel;
  purpose: SendPurpose;
  occurredAt: string;
  originalScheduledAt: string | null;
  deferredCount: number;
};

export type QuietHoursPort = {
  resolve(input: QuietHoursInput): Promise<QuietHoursDecision>;
};

export type MessagingDispatchInput = {
  tenantId: string;
  conversationId: string;
  identityId: string;
  channel: MessagingChannel;
  recipientExternalId: string;
  purpose: SendPurpose;
  content: SendContent;
  idempotencyKey: string;
};

export type MessagingDispatchReceipt = {
  providerMessageId: string;
  acceptedAt: string;
};

export type MessagingDispatchPort = {
  send(input: MessagingDispatchInput): Promise<MessagingDispatchReceipt>;
  /**
   * Whether a send for this tenant lands on the simulated driver rather than a provider. The
   * gateway asks before the test-recipient allowlist: a simulated send reaches nobody, so that
   * allowlist has nothing to protect there. Absent means never simulated.
   */
  simulates?(input: { tenantId: string }): Promise<boolean>;
};

export type SuppressionProviderInput = {
  tenantId: string;
  identityId: string;
  provider: IdentityProvider;
  channel: MessagingChannel;
  providerIdentityId: string;
  idempotencyKey: string;
};

export type SuppressionMutationReceipt = {
  providerOperationId: string;
  acceptedAt: string;
};

export type SuppressionReadBackReceipt = {
  providerOperationId: string;
  suppressed: boolean;
  observedAt: string;
};

export type SuppressionProviderPort = {
  suppress(input: SuppressionProviderInput): Promise<SuppressionMutationReceipt>;
  clear(input: SuppressionProviderInput): Promise<SuppressionMutationReceipt>;
  readBack(input: SuppressionProviderInput): Promise<SuppressionReadBackReceipt>;
};

export type DeletionProviderInput = {
  tenantId: string;
  contactId: string;
  providerContactId: string;
  providerAccountId: string;
  ghlInstallId: string;
  idempotencyKey: string;
};

export type DeletionMutationReceipt = {
  providerOperationId: string;
  acceptedAt: string;
};

export type DeletionReadBackReceipt = {
  providerOperationId: string;
  absent: boolean;
  observedAt: string;
};

export type DeletionProviderPort = {
  deleteContact(input: DeletionProviderInput): Promise<DeletionMutationReceipt>;
  readAbsent(input: DeletionProviderInput): Promise<DeletionReadBackReceipt>;
};
