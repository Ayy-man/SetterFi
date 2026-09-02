/**
 * Closed contracts for preview-bound, immediate contact deletion.
 *
 * Raw identities stay inside the service boundary. Callers receive counts, provider capability
 * states, and evidence receipts, so a preview or retry payload cannot become a second PII store.
 */

import type { MessagingChannel } from "@/lib/booking/types";

export type DeletionCascadeCounts = {
  mergedContacts: number;
  identities: number;
  contactNotes: number;
  conversations: number;
  messages: number;
  messageTraces: number;
  followups: number;
  appointments: number;
  unmatchedObjections: number;
  mergeAuditsRedacted: number;
  billableEventsDetached: number;
  evalCasesSevered: number;
};

export type DeletionProviderEffect =
  | {
      kind: "provider_contact_delete";
      provider: "ghl";
      state: "pending";
      targetCount: number;
      label: "Connected contact provider";
    }
  | {
      kind: "thread_scope_limitation";
      provider: "meta";
      state: "outside_setterfi_scope";
      label: "Connected social inbox";
      explanation: "Messages in the connected social inbox remain outside SetterFi deletion.";
    };

export type DeletionPreview = {
  tenantId: string;
  contactId: string;
  actorId: string;
  token: string;
  expiresAt: string;
  reasonRequired: true;
  counts: DeletionCascadeCounts;
  providerEffects: DeletionProviderEffect[];
  receipt: {
    actionKey: "contact.delete.preview";
    auditId: number;
    previewedAt: string;
  };
};

export type DeletionPreviewTokenClaims = {
  version: 1;
  tenantId: string;
  contactId: string;
  actorId: string;
  rpcToken: string;
  countsDigest: string;
  providerTargetDigest: string;
  reasonRequired: true;
  issuedAt: string;
  expiresAt: string;
};

export type DeletionIdentity = {
  id: string;
  channel: MessagingChannel;
  provider: "ghl" | "meta_direct";
  normalizedIdentifier: string;
  identifierLast4: string | null;
  providerContactId: string | null;
  providerAccountId: string | null;
  ghlInstallId: string | null;
};

export type DeletionBillableFact = {
  id: string;
  quantity: number;
  appointmentId: string;
};

export type DeletionSnapshot = {
  tenantId: string;
  contactId: string;
  contactIds: string[];
  revision: string;
  counts: DeletionCascadeCounts;
  identities: DeletionIdentity[];
  billableEvents: DeletionBillableFact[];
  evalCaseIds: string[];
};

export type DeletionProviderEvidence =
  | { kind: "not_applicable" }
  | {
      kind: "confirmed_absent";
      receipts: Array<{
        providerOperationId: string;
        acceptedAt: string;
        observedAt: string;
      }>;
    };

export type DeletionRetryReceipt = {
  version: 1;
  tenantId: string;
  contactId: string;
  idempotencyDigest: string;
  providerDeleteReceipts: Array<{
    providerOperationId: string;
    acceptedAt: string;
  }>;
  providerEvidence: DeletionProviderEvidence | null;
};

export type DeletionIntentStatus = "claimed" | "provider_confirmed" | "completed";

export type DeletionIntent = {
  id: string;
  status: DeletionIntentStatus;
  providerEvidence: DeletionProviderEvidence | null;
};

export type DeletionAuditReadback = {
  id: number;
  tenantId: string;
  action: "contact.delete";
  targetId: string;
  reason: string;
  payload: Readonly<Record<string, unknown>>;
};

export type DeletionReadback = {
  contactAbsent: boolean;
  tombstones: Array<{
    tenantId: string;
    channel: MessagingChannel;
    identifierHash: string;
    identifierLast4: string | null;
    deletionAuditId: number;
  }>;
  evalCases: Array<{
    sourceTenantId: string | null;
    sourceConversationId: string | null;
    sourceMessageId: string | null;
    sourceContactId: string | null;
    provenanceSevered: boolean;
    quarantined: boolean;
  }>;
  billableEvents: Array<{
    id: string;
    appointmentId: string | null;
    appointmentDetachedAt: string | null;
    quantity: number;
  }>;
  audit: DeletionAuditReadback | null;
};

export type DeleteLeadResult =
  | {
      kind: "refused";
      stage: "gate" | "preview";
      reason: "contact_delete_disabled" | "preview_invalid" | "preview_stale";
    }
  | {
      kind: "incomplete";
      stage: "provider_delete" | "provider_readback" | "local_delete" | "local_readback";
      reason: string;
      retry: DeletionRetryReceipt | null;
    }
  | {
      kind: "deleted";
      auditId: number;
      providerEvidence: DeletionProviderEvidence;
      tombstoneCount: number;
      replayed: boolean;
    };
