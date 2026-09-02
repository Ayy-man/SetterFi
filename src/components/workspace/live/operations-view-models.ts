/**
 * Pure operator-screen projections for client custody and audit reconstruction.
 *
 * Reassignment copy depends on the persisted receipt, and audit rows expose only the six fields
 * the screen promises; the database payload never enters this type boundary.
 */

import type { UserRole } from "@/lib/auth/claims";
import type { SuccessClientBookRead } from "@/lib/repositories/support";
import { reassignmentControlState } from "./support-view-models";

export type ClientBookView = SuccessClientBookRead & {
  successOwnerLabel: string;
  supportStatusLabel: string;
  planDisplayLabel: string;
  dataLabel: "Demo" | null;
};

export function clientBookView(row: SuccessClientBookRead): ClientBookView {
  return {
    ...row,
    successOwnerLabel: row.successOwner?.name ?? row.successOwner?.id ?? "Unassigned",
    supportStatusLabel: row.supportStatus
      ? row.supportStatus.replaceAll("_", " ")
      : "No support request",
    planDisplayLabel: row.planLabel ?? "No plan",
    dataLabel: row.client.isDemo ? "Demo" : null,
  };
}

export type SuccessOwnerCandidate = { id: string; label: string };

export function successOwnerCandidates(input: {
  rows: readonly SuccessClientBookRead[];
  actorId: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
}): SuccessOwnerCandidate[] {
  const candidates = new Map<string, string>();
  for (const row of input.rows) {
    if (row.successOwner) {
      candidates.set(row.successOwner.id, row.successOwner.name ?? row.successOwner.id);
    }
  }
  if (input.actorRole === "success") candidates.set(input.actorId, "You");
  return [...candidates].map(([id, label]) => ({ id, label }));
}

export function reassignmentReceiptView(input: {
  expectedTenant: string;
  expectedAssignee: string;
  receipt: {
    state?: unknown;
    tenantId?: unknown;
    successOwner?: unknown;
    audit?: { id?: unknown; actionKey?: unknown } | null;
  } | null;
}) {
  return reassignmentControlState(input);
}

export type AuditLogRead = {
  id: string;
  action: string;
  actor: string;
  target: string;
  reason: string | null;
  at: string;
  testData: boolean | null;
};

export function auditLogView(row: AuditLogRead) {
  return {
    ...row,
    reasonLabel: row.reason?.trim() || "Reason unavailable",
    testDataLabel: row.testData === true
      ? "Test"
      : row.testData === false
        ? "Real"
        : "Unavailable: platform audit rows do not carry tenant test lineage",
  };
}
