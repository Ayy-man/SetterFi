import { describe, expect, it } from "vitest";

import { getContactIdentityDetail, listContacts } from "@/lib/repositories/contacts";

function row(id: string, tenantId = "tenant-a") {
  return {
    id,
    tenant_id: tenantId,
    name: "Alex",
    credit_range: null,
    funding_goal: null,
    timeline: null,
    outcome: null,
    pipeline_stage: "new_lead",
    opted_out: false,
    timezone: "America/New_York",
    last_seen_at: "2026-08-17T12:00:00.000Z",
    created_at: "2026-08-17T11:00:00.000Z",
    is_test: true,
    merged_into_contact_id: null,
    tenant: { is_demo: true },
    identities: [
      { channel: "sms" as const, provider_identity_id: "+15551234567" },
    ],
  };
}

describe("listContacts", () => {
  it("returns provider identity addresses instead of treating contact fields as identity", async () => {
    const result = await listContacts("tenant-a", {}, async () => [row("contact-a")]);
    expect(result.items[0]).toMatchObject({
      id: "contact-a",
      channels: [{ channel: "sms", address: "+15551234567" }],
      pipelineStage: "new_lead",
      optedOut: false,
      timezone: "America/New_York",
      isDemo: true,
      isTest: true,
    });
  });

  it("omits merged losers from default reads rather than combining their field signals", async () => {
    const loser = { ...row("contact-loser"), merged_into_contact_id: "contact-winner" };
    const result = await listContacts("tenant-a", {}, async () => [loser, row("contact-winner")]);
    expect(result.items.map((contact) => contact.id)).toEqual(["contact-winner"]);
  });

  it("rejects a cross-tenant row even when the source ignored its predicate", async () => {
    await expect(
      listContacts("tenant-a", {}, async () => [row("contact-b", "tenant-b")]),
    ).rejects.toThrow("CONTACT_TENANT_MISMATCH");
  });
});

function detailSource(overrides: {
  candidateTenantId?: string;
  otherIsTest?: boolean;
  isDemo?: boolean;
  merged?: boolean;
  unmergeExists?: boolean;
} = {}) {
  const merged = overrides.merged ?? false;
  return async () => ({
    contact: {
      id: "contact-a",
      tenant_id: "tenant-a",
      name: "Alex",
      is_test: true,
      merged_into_contact_id: merged ? "contact-b" : null,
      merged_at: merged ? "2026-08-17T12:30:00.000Z" : null,
      merge_audit_id: merged ? 42 : null,
      tenant: { is_demo: overrides.isDemo ?? false },
      identities: [
        {
          id: "identity-a",
          tenant_id: "tenant-a",
          channel: "sms" as const,
          provider_identity_id: "provider-scoped-id",
          normalized_phone: "+15551234567",
          normalized_email: null,
          consent_state: "conversation",
        },
      ],
    },
    candidates: [
      {
        id: "candidate-a",
        tenant_id: overrides.candidateTenantId ?? "tenant-a",
        contact_a_id: "contact-a",
        contact_b_id: "contact-b",
        source: "field_match" as const,
        evidence_key: "phone:+1555",
        evidence: { signal: "same normalized phone" },
        state: "open" as const,
        created_at: "2026-08-17T12:00:00.000Z",
        tenant: { is_demo: overrides.isDemo ?? false },
        contact_a: { id: "contact-a", tenant_id: "tenant-a", name: "Alex", is_test: true },
        contact_b: {
          id: "contact-b",
          tenant_id: overrides.candidateTenantId ?? "tenant-a",
          name: "Sam",
          is_test: overrides.otherIsTest ?? true,
        },
      },
    ],
    mergeAudit: merged ? { id: 42, tenant_id: "tenant-a", action: "contact.merged" } : null,
    unmergeExists: overrides.unmergeExists ?? false,
  });
}

describe("getContactIdentityDetail", () => {
  it("returns a field match as a labelled candidate without any merge mutation seam", async () => {
    const detail = await getContactIdentityDetail(
      "tenant-a",
      "contact-a",
      detailSource({ otherIsTest: false }),
    );
    expect(detail.identities).toEqual([
      {
        id: "identity-a",
        channel: "sms",
        channelLabel: "Text messages (SMS)",
        address: "+15551234567",
        normalizedPhone: "+15551234567",
        normalizedEmail: null,
        consentState: "conversation",
      },
    ]);
    expect(detail.candidates[0]).toMatchObject({
      source: "field_match",
      state: "open",
      testBoundary: "mixed",
      dataLabel: "Test",
      otherContact: { id: "contact-b", isTest: false },
    });
    expect(detail.mergeState.status).toBe("active");
  });

  it("renders Demo from joined tenant/contact rows and derives undo from the merge audit", async () => {
    const detail = await getContactIdentityDetail(
      "tenant-a",
      "contact-a",
      detailSource({ isDemo: true, merged: true }),
    );
    expect(detail.candidates[0]).toMatchObject({ testBoundary: "test", dataLabel: "Demo" });
    expect(detail.mergeState).toEqual({
      status: "merged",
      mergedIntoContactId: "contact-b",
      mergedAt: "2026-08-17T12:30:00.000Z",
    });
    expect(detail.undo).toEqual({ auditRowId: 42 });
  });

  it("removes undo eligibility after an audit-backed unmerge rather than guessing from fields", async () => {
    const detail = await getContactIdentityDetail(
      "tenant-a",
      "contact-a",
      detailSource({ merged: true, unmergeExists: true }),
    );
    expect(detail.undo).toBeNull();
  });

  it("rejects a cross-tenant candidate even when the service source returns it", async () => {
    await expect(
      getContactIdentityDetail(
        "tenant-a",
        "contact-a",
        detailSource({ candidateTenantId: "tenant-b" }),
      ),
    ).rejects.toThrow("CONTACT_CANDIDATE_TENANT_MISMATCH");
  });
});
