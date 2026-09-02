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

/**
 * Who owns this client, in words a reader can act on.
 *
 * The projection carries the owner's `users.full_name` when the loader resolved one, and the id is
 * never a fallback for it: a uuid under an ASSIGNEE heading reads as a person to whoever is
 * scanning the drawer, and there is nothing they can do with it. An owner row whose name the join
 * could not resolve is still an owned client, so it says so rather than borrowing the unassigned
 * word and quietly moving the client into the queue of things nobody is holding.
 */
export function successOwnerDisplayLabel(
  owner: SuccessClientBookRead["successOwner"],
): string {
  if (!owner) return "Unassigned";
  return owner.name?.trim() || "Assigned owner";
}

export function clientBookView(row: SuccessClientBookRead): ClientBookView {
  return {
    ...row,
    successOwnerLabel: successOwnerDisplayLabel(row.successOwner),
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
  // Only owners the join actually named. An unnamed owner is not a choosable assignee: the option
  // would have to print the stored id at the reader, and picking "Assigned owner" twice over would
  // be two different people wearing one label.
  const candidates = new Map<string, string>();
  for (const row of input.rows) {
    const name = row.successOwner?.name?.trim();
    if (row.successOwner && name) candidates.set(row.successOwner.id, name);
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
