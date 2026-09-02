import { describe, expect, it } from "vitest";

import {
  mergeContacts,
  unmergeContact,
  type ContactMergeDependencies,
  type ContactMutationContact,
  type ContactMutationSnapshot,
} from "@/lib/services/contact-merge";

function contact(overrides: Partial<ContactMutationContact>): ContactMutationContact {
  return {
    id: "contact-winner",
    tenantId: "tenant-a",
    isTest: false,
    optedOut: false,
    qualification: {
      creditRange: "prime",
      fundingGoal: null,
      timeline: "1_3_months",
      businessStage: null,
      annualRevenueCents: 10_000_000,
      businessContext: "Synthetic winner context",
      dqReason: null,
    },
    outcome: "HARD_DQ",
    updatedAt: "2026-08-17T11:00:00.000Z",
    mergedIntoContactId: null,
    mergeAuditId: null,
    ...overrides,
  };
}

function initialSnapshot(): ContactMutationSnapshot {
  return {
    contacts: [
      contact({ id: "contact-winner" }),
      contact({
        id: "contact-loser",
        optedOut: true,
        qualification: {
          creditRange: null,
          fundingGoal: "50k_100k",
          timeline: null,
          businessStage: "operating",
          annualRevenueCents: null,
          businessContext: "Synthetic newer context",
          dqReason: "Synthetic reason",
        },
        outcome: "SOFT_DQ",
        updatedAt: "2026-08-17T12:00:00.000Z",
      }),
    ],
    identities: [
      { id: "identity-winner", contactId: "contact-winner" },
      { id: "identity-loser", contactId: "contact-loser" },
    ],
    conversations: [
      { id: "conversation-winner", contactId: "contact-winner" },
      { id: "conversation-loser", contactId: "contact-loser" },
    ],
    messages: [
      { id: "message-winner", conversationId: "conversation-winner" },
      { id: "message-loser", conversationId: "conversation-loser" },
    ],
    appointments: [
      { id: "appointment-winner", contactId: "contact-winner" },
      { id: "appointment-loser", contactId: "contact-loser" },
    ],
    billableEvents: [
      { id: "billable-winner", appointmentId: "appointment-winner" },
      { id: "billable-loser", appointmentId: "appointment-loser" },
    ],
  };
}

function auditContact(value: ContactMutationContact) {
  return {
    id: value.id,
    tenant_id: value.tenantId,
    is_test: value.isTest,
    opted_out: value.optedOut,
    credit_range: value.qualification.creditRange,
    funding_goal: value.qualification.fundingGoal,
    timeline: value.qualification.timeline,
    business_stage: value.qualification.businessStage,
    annual_revenue_cents: value.qualification.annualRevenueCents,
    business_context: value.qualification.businessContext,
    dq_reason: value.qualification.dqReason,
    outcome: value.outcome,
    updated_at: value.updatedAt,
    merged_into_contact_id: value.mergedIntoContactId,
    merge_audit_id: value.mergeAuditId,
  };
}

const mergeInput = {
  expectedTenantId: "tenant-a",
  winnerId: "contact-winner",
  loserId: "contact-loser",
  source: "human_asserted" as const,
  evidenceId: null,
  actorUserId: "actor-a",
  reason: "Merge the two synthetic contact records",
  idempotencyKey: "merge-a",
};

function dependencies() {
  const original = structuredClone(initialSnapshot());
  let snapshot = structuredClone(original);
  const audits = new Map<number, {
    id: number;
    tenantId: string;
    action: string;
    targetId: string;
    payload: Record<string, unknown>;
  }>();
  let mergeCalls = 0;
  let unmergeCalls = 0;
  const deps: ContactMergeDependencies = {
    merge: async () => {
      mergeCalls += 1;
      const winner = original.contacts[0];
      const loser = original.contacts[1];
      audits.set(81, {
        id: 81,
        tenantId: "tenant-a",
        action: "contact.merged",
        targetId: "contact-winner",
        payload: {
          prior: {
            winner: auditContact(winner),
            loser: auditContact(loser),
            identities: original.identities
              .filter((row) => row.contactId === "contact-loser")
              .map((row) => ({ id: row.id, contact_id: row.contactId })),
            conversations: original.conversations
              .filter((row) => row.contactId === "contact-loser")
              .map((row) => ({ id: row.id, contact_id: row.contactId })),
          },
        },
      });
      snapshot = {
        ...snapshot,
        contacts: snapshot.contacts.map((row) => {
          if (row.id === "contact-winner") {
            return {
              ...row,
              optedOut: true,
              qualification: {
                creditRange: "prime",
                fundingGoal: "50k_100k",
                timeline: "1_3_months",
                businessStage: "operating",
                annualRevenueCents: 10_000_000,
                businessContext: "Synthetic newer context",
                dqReason: "Synthetic reason",
              },
              outcome: "SOFT_DQ",
            };
          }
          return { ...row, mergedIntoContactId: "contact-winner", mergeAuditId: 81 };
        }),
        identities: snapshot.identities.map((row) =>
          row.id === "identity-loser" ? { ...row, contactId: "contact-winner" } : row
        ),
        conversations: snapshot.conversations.map((row) =>
          row.id === "conversation-loser" ? { ...row, contactId: "contact-winner" } : row
        ),
      };
      return {
        winner_id: "contact-winner",
        loser_id: "contact-loser",
        merge_audit_id: 81,
        moved_identity_count: 1,
        moved_conversation_count: 1,
      };
    },
    unmerge: async () => {
      unmergeCalls += 1;
      snapshot = structuredClone(original);
      audits.set(82, {
        id: 82,
        tenantId: "tenant-a",
        action: "contact.unmerged",
        targetId: "contact-loser",
        payload: { mergeAuditId: 81 },
      });
      return {
        winner_id: "contact-winner",
        loser_id: "contact-loser",
        unmerge_audit_id: 82,
        restored_identity_count: 1,
        restored_conversation_count: 1,
      };
    },
    loadSnapshot: async () => structuredClone(snapshot),
    loadAudit: async (_tenantId, auditId) => structuredClone(audits.get(auditId) ?? null),
  };
  return {
    deps,
    original,
    snapshot: () => structuredClone(snapshot),
    mergeCalls: () => mergeCalls,
    unmergeCalls: () => unmergeCalls,
  };
}

describe("contact merge services", () => {
  it("proves opt-out OR, newest non-null qualification, outcome precedence, and untouched ledgers", async () => {
    const state = dependencies();
    const result = await mergeContacts(mergeInput, state.deps);
    expect(result).toEqual({
      winnerId: "contact-winner",
      loserId: "contact-loser",
      mergeAuditId: 81,
      movedIdentityCount: 1,
      movedConversationCount: 1,
    });
    const after = state.snapshot();
    expect(after.contacts[0]).toMatchObject({
      optedOut: true,
      qualification: {
        creditRange: "prime",
        fundingGoal: "50k_100k",
        timeline: "1_3_months",
        businessStage: "operating",
        annualRevenueCents: 10_000_000,
        businessContext: "Synthetic newer context",
        dqReason: "Synthetic reason",
      },
      outcome: "SOFT_DQ",
    });
    expect(after.messages).toEqual(state.original.messages);
    expect(after.appointments).toEqual(state.original.appointments);
    expect(after.billableEvents).toEqual(state.original.billableEvents);
  });

  it("restores the exact audit before-image and relation ownership on unmerge", async () => {
    const state = dependencies();
    await mergeContacts(mergeInput, state.deps);
    const result = await unmergeContact({
      expectedTenantId: "tenant-a",
      mergeAuditId: 81,
      actorUserId: "actor-a",
      reason: "Undo the synthetic merge",
      idempotencyKey: "unmerge-a",
    }, state.deps);
    expect(result).toEqual({
      winnerId: "contact-winner",
      loserId: "contact-loser",
      unmergeAuditId: 82,
      restoredIdentityCount: 1,
      restoredConversationCount: 1,
    });
    expect(state.snapshot()).toEqual(state.original);
  });

  it("refuses a test-to-real merge before the RPC can combine their histories", async () => {
    const state = dependencies();
    const current = state.snapshot();
    const mismatched = {
      ...current,
      contacts: current.contacts.map((row) =>
        row.id === "contact-loser" ? { ...row, isTest: true } : row
      ),
    };
    state.deps.loadSnapshot = async () => structuredClone(mismatched);
    await expect(mergeContacts(mergeInput, state.deps)).rejects.toMatchObject({
      code: "TEST_BOUNDARY_MISMATCH",
    });
    expect(state.mergeCalls()).toBe(0);
  });

  it("redacts PII from replay mismatch errors", async () => {
    const state = dependencies();
    state.deps.merge = async () => {
      throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH alex@example.test +15551234567");
    };
    const error = await mergeContacts(mergeInput, state.deps).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect((error as Error).message).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("returns a stable unmerge conflict without leaking the conflicting identity", async () => {
    const state = dependencies();
    await mergeContacts(mergeInput, state.deps);
    state.deps.unmerge = async () => {
      throw new Error("CONTACT_UNMERGE_IDENTITY_CONFLICT +15551234567");
    };
    const error = await unmergeContact({
      expectedTenantId: "tenant-a",
      mergeAuditId: 81,
      actorUserId: "actor-a",
      reason: "Undo the synthetic merge",
      idempotencyKey: "unmerge-a",
    }, state.deps).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "UNMERGE_CONFLICT" });
    expect((error as Error).message).toBe("UNMERGE_CONFLICT");
    expect(state.unmergeCalls()).toBe(0);
  });
});
