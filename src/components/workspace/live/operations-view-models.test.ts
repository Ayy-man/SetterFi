import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { SuccessClientBookRead } from "@/lib/repositories/support";
import {
  auditLogView,
  clientBookView,
  reassignmentReceiptView,
  successOwnerCandidates,
  successOwnerDisplayLabel,
} from "./operations-view-models";

const client: SuccessClientBookRead = {
  client: { id: "tenant-1", name: "Demo client", isDemo: true },
  status: "active",
  successOwner: null,
  supportStatus: null,
  planId: null,
  planLabel: null,
  updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("operations view models", () => {
  it("labels unassigned, no-support, no-plan and demo client-book facts explicitly", () => {
    expect(clientBookView(client)).toMatchObject({
      successOwnerLabel: "Unassigned",
      supportStatusLabel: "No support request",
      planDisplayLabel: "No plan",
      dataLabel: "Demo",
    });
  });

  it("never prints the stored success-owner id where a person's name belongs", () => {
    const owner = { id: "88000000-0000-4000-8000-000000000001", name: null };
    const view = clientBookView({ ...client, successOwner: owner });

    expect(view.successOwnerLabel).toBe("Assigned owner");
    expect(
      view.successOwnerLabel,
      "an owner uuid under an assignee heading reads as a person's name",
    ).not.toContain(owner.id);
    expect(successOwnerDisplayLabel({ ...owner, name: "  Priya Natarajan  " }))
      .toBe("Priya Natarajan");
    // Owned but unnamed is not the same claim as unowned, and only the second one is a queue entry.
    expect(successOwnerDisplayLabel(null)).toBe("Unassigned");
  });

  it("offers no assignee option that would have to be labelled with an id", () => {
    const owner = { id: "88000000-0000-4000-8000-000000000001", name: null };
    expect(successOwnerCandidates({
      rows: [{ ...client, successOwner: owner }],
      actorId: "admin-1",
      actorRole: "admin",
    })).toEqual([]);
  });

  it("shows the persisted plan label when a tenant has a tier assigned", () => {
    expect(clientBookView({ ...client, planId: "tier-growth", planLabel: "Growth" }))
      .toMatchObject({ planDisplayLabel: "Growth" });
  });

  it("strips the seeded marker from the plan label, which the row's Demo label already carries", () => {
    const view = clientBookView({
      ...client,
      client: { ...client.client, isDemo: true },
      planId: "tier-growth",
      planLabel: "Growth (demo)",
    });

    expect(view.planDisplayLabel).toBe("Growth");
    expect(view.dataLabel).toBe("Demo");
  });

  it("derives reassignment candidates only from named persisted owners or the success actor", () => {
    expect(successOwnerCandidates({ rows: [client], actorId: "success-1", actorRole: "admin" })).toEqual([]);
    expect(successOwnerCandidates({ rows: [client], actorId: "success-1", actorRole: "success" })).toEqual([
      { id: "success-1", label: "You" },
    ]);
    expect(successOwnerCandidates({
      rows: [{ ...client, successOwner: { id: "success-2", name: "Mina" } }],
      actorId: "admin-1",
      actorRole: "admin",
    })).toEqual([{ id: "success-2", label: "Mina" }]);
  });

  it("cannot render Reassigned from an optimistic or mismatched response", () => {
    const receipt = {
      state: "Reassigned",
      tenantId: "tenant-1",
      successOwner: "success-1",
      audit: { id: 22, actionKey: "tenant.success_owner.reassigned" },
    };
    expect(reassignmentReceiptView({
      expectedTenant: "tenant-1",
      expectedAssignee: "success-1",
      receipt,
    }).kind).toBe("reassigned");
    expect(reassignmentReceiptView({
      expectedTenant: "tenant-2",
      expectedAssignee: "success-1",
      receipt,
    }).kind).toBe("pending");
    expect(reassignmentReceiptView({
      expectedTenant: "tenant-1",
      expectedAssignee: "success-1",
      receipt: { ...receipt, audit: null },
    }).kind).toBe("pending");
  });

  it("keeps unknown platform test lineage and missing reasons explicitly unavailable", () => {
    expect(auditLogView({
      id: "1",
      action: "brain.published",
      actor: "actor-1",
      target: "brain:snapshot-1",
      reason: null,
      at: "2026-08-18T00:00:00.000Z",
      testData: null,
    })).toMatchObject({
      reasonLabel: "Reason unavailable",
      testDataLabel: "Unavailable: platform audit rows do not carry tenant test lineage",
    });
  });

  it("renders only the closed audit projection and registry-gates reassignment microcopy", () => {
    const audit = readFileSync(new URL("./admin-audit-log.tsx", import.meta.url), "utf8");
    const clients = readFileSync(new URL("./success-client-book.tsx", import.meta.url), "utf8");
    expect(audit).not.toMatch(/payload|credential|secret/iu);
    expect(audit).toContain('resource="audit-log"');
    // The export resource is what `src/lib/exports/rendered-tables.ts:90` pins the client book to;
    // whether it is written as a prop object or as JSX attributes is the component's own business,
    // so this matches the name rather than the punctuation around it. The audit microcopy still has
    // to come from the registry key rather than a literal.
    expect(clients).toMatch(/resource[:=]\s*"success-client-book"/u);
    expect(clients).toContain('AUDIT_ACTIONS["tenant.success_owner.reassigned"]');
    expect(clients).toContain('action="tenant.success_owner.reassigned"');
    expect(clients).not.toContain(">Logged<");
  });
});
