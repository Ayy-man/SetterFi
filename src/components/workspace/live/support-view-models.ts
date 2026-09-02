/**
 * Pure support-screen truth derived from the persisted role-specific projections.
 *
 * The coach projection deliberately has no internal-note field, while platform rows retain it.
 * Disabled, loading, error and empty states stay distinct so a missing response cannot look like
 * an empty support book.
 */

import type {
  CoachSupportThreadRead,
  PlatformSupportThreadRead,
  SupportStatus,
} from "@/lib/repositories/support";

export type SupportLoadState<Row> =
  | { kind: "disabled"; message: "Phase 8 support is not enabled" }
  | { kind: "loading"; message: "Loading support threads" }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: "No support threads match this view" }
  | { kind: "ready"; rows: readonly Row[] };

export function supportLoadState<Row>(input: {
  enabled: boolean;
  loading: boolean;
  error: string | null;
  rows: readonly Row[];
}): SupportLoadState<Row> {
  if (!input.enabled) {
    return { kind: "disabled", message: "Phase 8 support is not enabled" };
  }
  if (input.loading) return { kind: "loading", message: "Loading support threads" };
  if (input.error) return { kind: "error", message: input.error };
  if (input.rows.length === 0) {
    return { kind: "empty", message: "No support threads match this view" };
  }
  return { kind: "ready", rows: input.rows };
}

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  open: "Open",
  waiting_on_coach: "Waiting on coach",
  resolved: "Resolved",
};

export type CoachSupportThreadView = {
  id: string;
  subject: string;
  status: SupportStatus;
  statusLabel: string;
  assignedLabel: string;
  dataLabel: "Test" | null;
  updatedAt: string;
  messages: CoachSupportThreadRead["messages"];
};

/** Internal notes cannot enter this function because the coach message type cannot represent one. */
export function coachSupportThreadView(
  thread: CoachSupportThreadRead,
): CoachSupportThreadView {
  return {
    id: thread.id,
    subject: thread.subject,
    status: thread.status,
    statusLabel: SUPPORT_STATUS_LABELS[thread.status],
    assignedLabel: thread.assignedTo ?? "Unassigned",
    dataLabel: thread.isTest ? "Test" : null,
    updatedAt: thread.updatedAt,
    messages: thread.messages,
  };
}

export type PlatformSupportThreadView = PlatformSupportThreadRead & {
  statusLabel: string;
  assignedLabel: string;
  successOwnerLabel: string;
  dataLabel: "Demo" | "Test" | null;
};

export function platformSupportThreadView(
  thread: PlatformSupportThreadRead,
): PlatformSupportThreadView {
  return {
    ...thread,
    statusLabel: SUPPORT_STATUS_LABELS[thread.status],
    assignedLabel: thread.assignedTo?.name ?? thread.assignedTo?.id ?? "Unassigned",
    successOwnerLabel: thread.successOwner?.name ?? thread.successOwner?.id ?? "Unassigned",
    dataLabel: thread.isTest ? "Test" : thread.tenantIsDemo ? "Demo" : null,
  };
}

export function reassignmentControlState(input: {
  expectedTenant: string;
  expectedAssignee: string;
  receipt: {
    state?: unknown;
    tenantId?: unknown;
    successOwner?: unknown;
    audit?: { id?: unknown; actionKey?: unknown } | null;
  } | null;
}) {
  const auditId = input.receipt?.audit?.id;
  const logged = input.receipt?.state === "Reassigned"
    && input.receipt.tenantId === input.expectedTenant
    && input.receipt.successOwner === input.expectedAssignee
    && typeof auditId === "number"
    && Number.isSafeInteger(auditId)
    && auditId > 0
    && input.receipt.audit?.actionKey === "tenant.success_owner.reassigned";
  return logged
    ? { kind: "reassigned" as const, label: "Reassigned", auditId }
    : { kind: "pending" as const, label: "Owner unchanged", auditId: null };
}
