import { describe, expect, it, vi } from "vitest";

import type { DeletionSnapshot } from "./contracts";
import {
  recoverContactDeletions,
  type DeletionRecoveryClaim,
  type DeletionRecoveryDependencies,
} from "./recovery";

const claim: DeletionRecoveryClaim = {
  intentId: "intent-a",
  tenantId: "tenant-a",
  contactId: "contact-a",
  actorId: "actor-a",
  status: "claimed",
  providerEvidence: null,
  idempotencyDigest: "a".repeat(64),
  actorAuthorized: true,
  leaseToken: "11111111-1111-4111-8111-111111111111",
};

const snapshot: DeletionSnapshot = {
  tenantId: "tenant-a",
  contactId: "contact-a",
  contactIds: ["contact-a"],
  revision: "revision-a",
  counts: {
    mergedContacts: 0, identities: 1, contactNotes: 0, conversations: 1,
    messages: 1, messageTraces: 0, followups: 0, appointments: 0,
    unmatchedObjections: 0, mergeAuditsRedacted: 0,
    billableEventsDetached: 0, evalCasesSevered: 0,
  },
  identities: [{
    id: "identity-a", channel: "sms", provider: "ghl",
    normalizedIdentifier: "+15555550123", identifierLast4: "0123",
    providerContactId: "provider-contact-a", providerAccountId: "location-a",
    ghlInstallId: "install-a",
  }],
  billableEvents: [],
  evalCaseIds: [],
};

function harness(currentClaim: DeletionRecoveryClaim = claim) {
  let absent = true;
  let claimed = false;
  const dependencies: DeletionRecoveryDependencies = {
    claim: vi.fn(async () => claimed ? [] : (claimed = true, [currentClaim])),
    loadSnapshot: vi.fn(async () => structuredClone(snapshot)),
    renew: vi.fn(async () => undefined),
    checkpoint: vi.fn(async () => undefined),
    finalize: vi.fn(async () => undefined),
    mark: vi.fn(async () => undefined),
    provider: {
      readAbsent: vi.fn(async () => ({
        providerOperationId: "operation-a", absent,
        observedAt: "2026-08-27T12:00:00.000Z",
      })),
      deleteContact: vi.fn(async () => {
        absent = true;
        return { providerOperationId: "operation-a", acceptedAt: "2026-08-27T11:59:00.000Z" };
      }),
    },
    hashIdentifier: (value) => value === "+15555550123" ? "b".repeat(64) : "c".repeat(64),
    now: () => new Date("2026-08-27T12:00:00.000Z"),
    newLeaseToken: () => "11111111-1111-4111-8111-111111111111",
  };
  return { dependencies, setAbsent: (value: boolean) => { absent = value; } };
}

describe("durable contact deletion recovery", () => {
  it("requires operator adoption before any provider work when the original actor is invalid", async () => {
    const test = harness({ ...claim, actorAuthorized: false });
    const result = await recoverContactDeletions(10, test.dependencies);
    expect(result).toEqual({ claimed: 1, completed: 0, retried: 0, operatorRequired: 1 });
    expect(test.dependencies.provider.readAbsent).not.toHaveBeenCalled();
    expect(test.dependencies.mark).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "operator_required",
    }));
  });

  it("read-checks first and does not repeat a provider mutation when the contact is already absent", async () => {
    const test = harness();
    const result = await recoverContactDeletions(10, test.dependencies);
    expect(result.completed).toBe(1);
    expect(test.dependencies.provider.readAbsent).toHaveBeenCalledTimes(1);
    expect(test.dependencies.provider.deleteContact).not.toHaveBeenCalled();
    expect(test.dependencies.renew).toHaveBeenCalledTimes(3);
    expect(test.dependencies.checkpoint).toHaveBeenCalledTimes(1);
    expect(test.dependencies.finalize).toHaveBeenCalledWith(expect.objectContaining({
      leaseToken: "11111111-1111-4111-8111-111111111111",
      hashes: ["b".repeat(64)],
    }));
  });

  it("deletes once only after a present readback, then requires an absent readback", async () => {
    const test = harness();
    test.setAbsent(false);
    await recoverContactDeletions(10, test.dependencies);
    expect(test.dependencies.provider.deleteContact).toHaveBeenCalledTimes(1);
    expect(test.dependencies.provider.readAbsent).toHaveBeenCalledTimes(2);
    expect(test.dependencies.renew).toHaveBeenCalledTimes(5);
  });

  it("finalizes durable provider evidence without re-running provider work after a crash", async () => {
    const evidence = { kind: "not_applicable" as const };
    const test = harness({
      ...claim, status: "provider_confirmed", actorAuthorized: true, providerEvidence: evidence,
    });
    const result = await recoverContactDeletions(10, test.dependencies);
    expect(result.completed).toBe(1);
    expect(test.dependencies.provider.readAbsent).not.toHaveBeenCalled();
    expect(test.dependencies.checkpoint).not.toHaveBeenCalled();
    expect(test.dependencies.finalize).toHaveBeenCalledTimes(1);
  });

  it("requires operator adoption when a provider-confirmed intent lost its human actor", async () => {
    const test = harness({
      ...claim, actorId: null, status: "provider_confirmed", actorAuthorized: false,
      providerEvidence: { kind: "not_applicable" },
    });
    const result = await recoverContactDeletions(10, test.dependencies);
    expect(result.operatorRequired).toBe(1);
    expect(test.dependencies.finalize).not.toHaveBeenCalled();
    expect(test.dependencies.mark).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "operator_required",
    }));
  });

  it("requires operator adoption when a provider-confirmed intent's actor was demoted", async () => {
    const test = harness({
      ...claim, status: "provider_confirmed", actorAuthorized: false,
      providerEvidence: { kind: "not_applicable" },
    });
    const result = await recoverContactDeletions(10, test.dependencies);
    expect(result.operatorRequired).toBe(1);
    expect(test.dependencies.finalize).not.toHaveBeenCalled();
  });

  it("keeps colon-bearing account/install tuples distinct and orders their framed bytes", async () => {
    const test = harness();
    test.dependencies.loadSnapshot = vi.fn(async () => ({
      ...structuredClone(snapshot),
      identities: [
        { ...snapshot.identities[0], id: "identity-1", providerAccountId: "a:b", ghlInstallId: "c", providerContactId: "d" },
        { ...snapshot.identities[0], id: "identity-2", providerAccountId: "a", ghlInstallId: "b:c", providerContactId: "d" },
      ],
    }));
    await recoverContactDeletions(10, test.dependencies);
    expect(test.dependencies.provider.readAbsent).toHaveBeenCalledTimes(2);
    expect(test.dependencies.finalize).toHaveBeenCalledTimes(1);
  });

  it("claims and completes one leased intent at a time", async () => {
    const test = harness();
    const second = {
      ...claim,
      intentId: "intent-b",
      contactId: "contact-b",
      leaseToken: "22222222-2222-4222-8222-222222222222",
    };
    const claims = [[claim], [second], []];
    test.dependencies.claim = vi.fn(async () => claims.shift() ?? []);
    test.dependencies.loadSnapshot = vi.fn(async (_tenantId, contactId) => ({
      ...structuredClone(snapshot), contactId, contactIds: [contactId],
    }));

    const result = await recoverContactDeletions(10, test.dependencies);

    expect(result).toEqual({ claimed: 2, completed: 2, retried: 0, operatorRequired: 0 });
    expect(test.dependencies.claim).toHaveBeenNthCalledWith(1, 1);
    expect(test.dependencies.claim).toHaveBeenNthCalledWith(2, 1);
    expect(test.dependencies.finalize).toHaveBeenNthCalledWith(
      2, expect.objectContaining({ leaseToken: second.leaseToken }),
    );
  });
});
