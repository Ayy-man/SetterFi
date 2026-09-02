import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  DeletionProviderEvidence,
  DeletionReadback,
  DeletionSnapshot,
} from "@/lib/deletion/contracts";
import {
  decodeDeletionPreviewToken,
  deletionCountsDigest,
  normalizeDeletionReason,
  previewLeadDeletion,
  type DeletionPreviewDependencies,
} from "@/lib/deletion/preview";
import {
  deleteLead,
  type DeleteLeadDependencies,
  type DeleteLeadInput,
} from "@/lib/deletion/service";

const NOW = new Date("2026-08-17T12:00:00.000Z");

function snapshot(overrides: Partial<DeletionSnapshot> = {}): DeletionSnapshot {
  return {
    tenantId: "tenant-a",
    contactId: "contact-a",
    contactIds: ["contact-a"],
    revision: "revision-1",
    counts: {
      mergedContacts: 0,
      identities: 2,
      contactNotes: 0,
      conversations: 1,
      messages: 3,
      messageTraces: 2,
      followups: 4,
      appointments: 1,
      unmatchedObjections: 0,
      mergeAuditsRedacted: 0,
      billableEventsDetached: 1,
      evalCasesSevered: 1,
    },
    identities: [
      {
        id: "identity-ghl",
        channel: "sms",
        provider: "ghl",
        normalizedIdentifier: "+15555550123",
        identifierLast4: "0123",
        providerContactId: "provider-contact-a",
        providerAccountId: "location-a",
        ghlInstallId: "install-a",
      },
      {
        id: "identity-meta",
        channel: "instagram",
        provider: "meta_direct",
        normalizedIdentifier: "meta-user-a",
        identifierLast4: null,
        providerContactId: null,
        providerAccountId: null,
        ghlInstallId: null,
      },
    ],
    billableEvents: [{ id: "billable-a", quantity: 1, appointmentId: "appointment-a" }],
    evalCaseIds: ["eval-a"],
    ...overrides,
  };
}

function previewDependencies(current = snapshot()): DeletionPreviewDependencies {
  return {
    previewRpc: async () => ({
      previewToken: "11111111-1111-4111-8111-111111111111",
      auditId: 41,
      conversations: current.counts.conversations,
      appointments: current.counts.appointments,
      identities: current.counts.identities,
      mergedContacts: current.counts.mergedContacts,
      contactNotes: current.counts.contactNotes,
      unmatchedObjections: current.counts.unmatchedObjections,
      mergeAuditsRedacted: current.counts.mergeAuditsRedacted,
      snapshotDigest: "a".repeat(64),
      providerTargetDigest: "b".repeat(64),
    }),
    loadSnapshot: async () => structuredClone(current),
    now: () => NOW,
  };
}

type DeletionHarness = {
  dependencies: DeleteLeadDependencies;
  state: {
    providerDeleteCalls: number;
    providerReadCalls: number;
    snapshotCalls: number;
    localDeleteCalls: number;
    localReadbackCalls: number;
    beginIntentCalls: number;
    checkpointIntentCalls: number;
    renewIntentCalls: number;
    releaseIntentCalls: number;
    providerAbsent: boolean;
    providerBecomesAbsentAfterDelete: boolean;
    providerOperationId: string | null;
    localDeleteFails: boolean;
    localReadbackFails: boolean;
    rpcArgs: Record<string, unknown> | null;
    beginIntentInput: Parameters<DeleteLeadDependencies["beginIntent"]>[0] | null;
    completed: {
      auditId: number;
      tombstoneCount: number;
      providerEvidence: { kind: "not_applicable" } | {
        kind: "confirmed_absent";
        receipts: Array<{ providerOperationId: string; acceptedAt: string; observedAt: string }>;
      };
    } | null;
    intentStatus: "claimed" | "provider_confirmed" | "completed";
    checkpointFails: boolean;
  };
};

function deletionHarness(current = snapshot()): DeletionHarness {
  const state: DeletionHarness["state"] = {
    providerDeleteCalls: 0,
    providerReadCalls: 0,
    snapshotCalls: 0,
    localDeleteCalls: 0,
    localReadbackCalls: 0,
    beginIntentCalls: 0,
    checkpointIntentCalls: 0,
    renewIntentCalls: 0,
    releaseIntentCalls: 0,
    providerAbsent: false,
    providerBecomesAbsentAfterDelete: true,
    providerOperationId: null,
    localDeleteFails: false,
    localReadbackFails: false,
    rpcArgs: null,
    beginIntentInput: null,
    completed: null,
    intentStatus: "claimed",
    checkpointFails: false,
  };
  const dependencies: DeleteLeadDependencies = {
    liveEnabled: true,
    loadSnapshot: async () => {
      state.snapshotCalls += 1;
      return structuredClone(current);
    },
    loadCompleted: async () => state.completed,
    beginIntent: async (input) => {
      state.beginIntentCalls += 1;
      state.beginIntentInput = structuredClone(input);
      return {
        id: "intent-a",
        status: state.intentStatus,
        providerEvidence: state.intentStatus === "claimed"
          ? null
          : {
              kind: "confirmed_absent",
              receipts: [{
                providerOperationId: "durable-operation",
                acceptedAt: "2026-08-17T12:01:00.000Z",
                observedAt: "2026-08-17T12:02:00.000Z",
              }],
            },
      };
    },
    renewIntent: async () => {
      state.renewIntentCalls += 1;
    },
    releaseIntent: async () => {
      state.releaseIntentCalls += 1;
    },
    checkpointIntent: async (input) => {
      state.checkpointIntentCalls += 1;
      if (state.checkpointFails) throw new Error("synthetic checkpoint failure");
      state.intentStatus = "provider_confirmed";
      return { id: "intent-a", status: "provider_confirmed", providerEvidence: input.providerEvidence };
    },
    provider: {
      deleteContact: async (input) => {
        state.providerDeleteCalls += 1;
        if (state.providerBecomesAbsentAfterDelete) state.providerAbsent = true;
        return {
          providerOperationId: state.providerOperationId ??
            createHash("sha256").update(input.providerContactId).digest("hex").slice(0, 20),
          acceptedAt: "2026-08-17T12:01:00.000Z",
        };
      },
      readAbsent: async (input) => {
        state.providerReadCalls += 1;
        return {
          providerOperationId: state.providerOperationId ??
            createHash("sha256").update(input.providerContactId).digest("hex").slice(0, 20),
          absent: state.providerAbsent,
          observedAt: "2026-08-17T12:02:00.000Z",
        };
      },
    },
    deleteRpc: async (args) => {
      state.localDeleteCalls += 1;
      if (state.localDeleteFails) throw new Error("synthetic local failure");
      state.rpcArgs = structuredClone(args);
      const providerReceipt = args.p_provider_receipt as {
        providerEvidence: DeletionProviderEvidence;
      };
      state.completed = {
        auditId: 73,
        tombstoneCount: (args.p_tombstone_hashes as string[]).length,
        providerEvidence: providerReceipt.providerEvidence,
      };
      return { deleted: true, audit_id: 73 };
    },
    loadReadback: async () => {
      state.localReadbackCalls += 1;
      if (state.localReadbackFails) throw new Error("synthetic readback failure");
      const args = state.rpcArgs;
      if (!args) throw new Error("RPC must run before readback");
      const channels = args.p_tombstone_channels as DeletionReadback["tombstones"][number]["channel"][];
      const hashes = args.p_tombstone_hashes as string[];
      const last4s = args.p_tombstone_last4s as Array<string | null>;
      return {
        contactAbsent: true,
        tombstones: hashes.map((identifierHash, index) => ({
          tenantId: "tenant-a",
          channel: channels[index],
          identifierHash,
          identifierLast4: last4s[index],
          deletionAuditId: 73,
        })),
        evalCases: current.evalCaseIds.map(() => ({
          sourceTenantId: null,
          sourceConversationId: null,
          sourceMessageId: null,
          sourceContactId: null,
          provenanceSevered: true,
          quarantined: true,
        })),
        billableEvents: current.billableEvents.map((row) => ({
          id: row.id,
          appointmentId: null,
          appointmentDetachedAt: "2026-08-17T12:03:00.000Z",
          quantity: row.quantity,
        })),
        audit: {
          id: 73,
          tenantId: "tenant-a",
          action: "contact.delete" as const,
          targetId: "contact-a",
          reason: "verified privacy request",
          payload: { provider_receipt: args.p_provider_receipt },
        },
      };
    },
    hashIdentifier: (value) => createHash("sha256").update(`synthetic-salt:${value}`).digest("hex"),
    now: () => NOW,
  };
  return { dependencies, state };
}

async function deletionInput(current = snapshot()): Promise<DeleteLeadInput> {
  const preview = await previewLeadDeletion(
    { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
    previewDependencies(current),
  );
  return {
    tenantId: "tenant-a",
    contactId: "contact-a",
    actorId: "actor-a",
    reason: "  verified privacy request  ",
    previewToken: preview.token,
    idempotencyKey: "delete-request-a",
  };
}

describe("lead deletion preview", () => {
  it("returns an exact preview bound to tenant, contact, actor, digest, and expiry", async () => {
    const preview = await previewLeadDeletion(
      { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
      previewDependencies(),
    );

    expect(preview).toMatchObject({
      tenantId: "tenant-a",
      contactId: "contact-a",
      actorId: "actor-a",
      reasonRequired: true,
      expiresAt: "2026-08-17T12:15:00.000Z",
      counts: snapshot().counts,
      receipt: { actionKey: "contact.delete.preview", auditId: 41 },
    });
    expect(decodeDeletionPreviewToken(preview.token)).toMatchObject({
      tenantId: "tenant-a",
      contactId: "contact-a",
      actorId: "actor-a",
      reasonRequired: true,
      rpcToken: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("describes provider work as pending and Meta as SetterFi scope rather than completion", async () => {
    const preview = await previewLeadDeletion(
      { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
      previewDependencies(),
    );

    expect(preview.providerEffects).toEqual([
      {
        kind: "provider_contact_delete",
        provider: "ghl",
        state: "pending",
        targetCount: 1,
        label: "Connected contact provider",
      },
      {
        kind: "thread_scope_limitation",
        provider: "meta",
        state: "outside_setterfi_scope",
        label: "Connected social inbox",
        explanation: "Messages in the connected social inbox remain outside SetterFi deletion.",
      },
    ]);
  });

  it("rejects a cross-tenant preview snapshot rather than trusting the caller", async () => {
    const deps = previewDependencies(snapshot({ tenantId: "tenant-b" }));
    await expect(previewLeadDeletion(
      { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
      deps,
    )).rejects.toThrow("DELETION_PREVIEW_SCOPE_MISMATCH");
  });

  it("invalidates the preview when RPC counts and the deletion snapshot differ", async () => {
    const deps = previewDependencies();
    deps.previewRpc = async () => ({
      previewToken: "11111111-1111-4111-8111-111111111111",
      auditId: 41,
      conversations: 99,
      appointments: 1,
      identities: 2,
      mergedContacts: 0,
      contactNotes: 0,
      unmatchedObjections: 0,
      mergeAuditsRedacted: 0,
      snapshotDigest: "a".repeat(64),
      providerTargetDigest: "b".repeat(64),
    });
    await expect(previewLeadDeletion(
      { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
      deps,
    )).rejects.toThrow("DELETION_PREVIEW_COUNTS_CHANGED");
  });

  it("changes the digest when the reviewed cascade revision changes", () => {
    expect(deletionCountsDigest(snapshot({ revision: "revision-1" }))).not.toBe(
      deletionCountsDigest(snapshot({ revision: "revision-2" })),
    );
  });

  it("binds a multi-target digest to account, install, and contact using bytewise frame order", async () => {
    const current = snapshot({
      counts: { ...snapshot().counts, identities: 3 },
      identities: [
        ...snapshot().identities,
        {
          id: "identity-ghl-b",
          channel: "sms",
          provider: "ghl",
          normalizedIdentifier: "+15555550999",
          identifierLast4: "0999",
          providerContactId: "provider-contact-b",
          providerAccountId: "z",
          ghlInstallId: "install-b",
        },
      ],
    });
    const harness = deletionHarness(current);
    const input = await deletionInput(current);
    await deleteLead(input, harness.dependencies);
    const frames = [
      ["location-a", "install-a", "provider-contact-a"],
      ["z", "install-b", "provider-contact-b"],
    ].map((parts) => parts.map((part) => `${Buffer.byteLength(part)}:${part}`).join(""))
      .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect(harness.state.beginIntentInput?.providerTargetDigest).toBe(
      createHash("sha256").update(frames.join("")).digest("hex"),
    );
  });

  it("discloses a merged winner's loser-only notes and appointments in the preview counts", async () => {
    const current = snapshot({
      contactIds: ["contact-a", "contact-loser"],
      counts: {
        ...snapshot().counts,
        mergedContacts: 1,
        contactNotes: 2,
        appointments: 2,
        billableEventsDetached: 2,
      },
    });
    const preview = await previewLeadDeletion(
      { tenantId: "tenant-a", contactId: "contact-a", actorId: "actor-a" },
      previewDependencies(current),
    );
    expect(preview.counts).toMatchObject({
      mergedContacts: 1,
      contactNotes: 2,
      appointments: 2,
      billableEventsDetached: 2,
    });
  });

  it("requires and trims the operator reason before execution", () => {
    expect(normalizeDeletionReason("  privacy request confirmed  ")).toBe(
      "privacy request confirmed",
    );
    expect(() => normalizeDeletionReason("   ")).toThrow("CONTACT_DELETE_REASON_REQUIRED");
  });

  it("rejects forged preview tokens with extra or malformed claims", async () => {
    const forged = Buffer.from(JSON.stringify({ version: 1, tenantId: "tenant-a" })).toString("base64url");
    expect(() => decodeDeletionPreviewToken(forged)).toThrow("DELETION_PREVIEW_TOKEN_INVALID");
    expect(() => decodeDeletionPreviewToken("not-json")).toThrow("DELETION_PREVIEW_TOKEN_INVALID");
  });
});

describe("receipt-backed lead deletion", () => {
  it("requires provider mutation and absence readback before the local RPC", async () => {
    const harness = deletionHarness();
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toMatchObject({
      kind: "deleted",
      auditId: 73,
      replayed: false,
      tombstoneCount: 2,
      providerEvidence: { kind: "confirmed_absent" },
    });
    expect(harness.state).toMatchObject({
      providerDeleteCalls: 1,
      providerReadCalls: 2,
      beginIntentCalls: 1,
      checkpointIntentCalls: 1,
      renewIntentCalls: 5,
      releaseIntentCalls: 1,
      localDeleteCalls: 1,
      localReadbackCalls: 1,
    });
  });

  it("durably authorizes the deletion intent before the irreversible provider mutation", async () => {
    const harness = deletionHarness();
    const order: string[] = [];
    const begin = harness.dependencies.beginIntent;
    const providerDelete = harness.dependencies.provider.deleteContact;
    harness.dependencies.beginIntent = async (input) => {
      order.push("intent");
      return begin(input);
    };
    harness.dependencies.provider.deleteContact = async (input) => {
      order.push("provider");
      return providerDelete(input);
    };

    await deleteLead(await deletionInput(), harness.dependencies);

    expect(order).toEqual(["intent", "provider"]);
    expect(harness.state.rpcArgs).toMatchObject({
      p_intent_id: "intent-a",
      p_provider_receipt: { intentId: "intent-a", idempotencyDigest: expect.any(String) },
    });
    expect(harness.state.rpcArgs).not.toHaveProperty("p_preview_token");
  });

  it("leaves the local contact intact when provider absence is not confirmed", async () => {
    const harness = deletionHarness();
    harness.state.providerAbsent = false;
    harness.state.providerBecomesAbsentAfterDelete = false;
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toMatchObject({
      kind: "incomplete",
      stage: "provider_readback",
      reason: "provider_absence_unconfirmed",
    });
    expect(harness.state.localDeleteCalls).toBe(0);
  });

  it("retries the idempotent provider mutation until absence can be checkpointed", async () => {
    const harness = deletionHarness();
    harness.state.providerAbsent = false;
    harness.state.providerBecomesAbsentAfterDelete = false;
    const input = await deletionInput();
    const first = await deleteLead(input, harness.dependencies);
    expect(first.kind).toBe("incomplete");
    if (first.kind !== "incomplete") throw new Error("expected an incomplete result");

    harness.state.providerBecomesAbsentAfterDelete = true;
    const second = await deleteLead({ ...input, retry: first.retry }, harness.dependencies);
    expect(second.kind).toBe("deleted");
    expect(harness.state.providerDeleteCalls).toBe(2);
    expect(harness.state.providerReadCalls).toBe(4);
    expect(harness.state.localDeleteCalls).toBe(1);
  });

  it("reads before deleting and skips a repeated mutation after a lost provider response", async () => {
    const harness = deletionHarness();
    harness.state.providerAbsent = true;

    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result.kind).toBe("deleted");
    expect(harness.state.providerReadCalls).toBe(2);
    expect(harness.state.providerDeleteCalls).toBe(0);
  });

  it("uses a unique lease token for each execution attempt", async () => {
    const harness = deletionHarness();
    const leaseTokens: string[] = [];
    const begin = harness.dependencies.beginIntent;
    harness.dependencies.beginIntent = async (input) => {
      leaseTokens.push(input.leaseToken);
      return begin(input);
    };
    harness.state.localDeleteFails = true;
    const input = await deletionInput();
    await deleteLead(input, harness.dependencies);
    await deleteLead(input, harness.dependencies);

    expect(leaseTokens).toHaveLength(2);
    expect(leaseTokens[0]).not.toBe(leaseTokens[1]);
    expect(leaseTokens.every((token) => /^[0-9a-f-]{36}$/.test(token))).toBe(true);
  });

  it("reuses provider evidence after a local failure and does not repeat the mutation", async () => {
    const harness = deletionHarness();
    harness.state.localDeleteFails = true;
    const input = await deletionInput();
    const first = await deleteLead(input, harness.dependencies);
    expect(first).toMatchObject({ kind: "incomplete", stage: "local_delete" });
    if (first.kind !== "incomplete") throw new Error("expected an incomplete result");

    harness.state.localDeleteFails = false;
    const second = await deleteLead({ ...input, retry: first.retry }, harness.dependencies);
    expect(second.kind).toBe("deleted");
    expect(harness.state.providerDeleteCalls).toBe(1);
    expect(harness.state.localDeleteCalls).toBe(2);
  });

  it("hashes identities before the RPC and keeps raw identity data out of durable payloads", async () => {
    const harness = deletionHarness();
    await deleteLead(await deletionInput(), harness.dependencies);

    const serialized = JSON.stringify(harness.state.rpcArgs);
    expect(serialized).not.toContain("+15555550123");
    expect(serialized).not.toContain("meta-user-a");
    expect(serialized).not.toContain("provider-contact-a");
    expect(harness.state.rpcArgs?.p_tombstone_hashes).toEqual([
      createHash("sha256").update("synthetic-salt:+15555550123").digest("hex"),
      createHash("sha256").update("synthetic-salt:meta-user-a").digest("hex"),
    ]);
    expect(harness.state.beginIntentInput?.reason).toBe("verified privacy request");
  });

  it("refuses a provider receipt that echoes a raw provider contact identifier", async () => {
    const harness = deletionHarness();
    harness.state.providerOperationId = "delete:provider-contact-a";
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toEqual({
      kind: "incomplete",
      stage: "provider_delete",
      reason: "provider_receipt_private",
      retry: null,
    });
    expect(harness.state.localDeleteCalls).toBe(0);
    expect(JSON.stringify(result)).not.toContain("provider-contact-a");
  });

  it("refuses a stale preview before provider or local mutation", async () => {
    const original = snapshot();
    const harness = deletionHarness(snapshot({ revision: "revision-2" }));
    harness.dependencies.beginIntent = async () => {
      throw new Error("CONTACT_DELETE_PREVIEW_STALE");
    };
    const result = await deleteLead(await deletionInput(original), harness.dependencies);

    expect(result).toEqual({ kind: "refused", stage: "preview", reason: "preview_stale" });
    expect(harness.state.providerDeleteCalls).toBe(0);
    expect(harness.state.localDeleteCalls).toBe(0);
  });

  it("finishes the claimed deletion instead of retaining local data when state changes after provider work", async () => {
    const original = snapshot();
    const harness = deletionHarness(original);
    let snapshotRead = 0;
    harness.dependencies.loadSnapshot = async () => {
      snapshotRead += 1;
      return snapshotRead === 1 ? original : snapshot({ revision: "revision-after-provider" });
    };
    const result = await deleteLead(await deletionInput(original), harness.dependencies);

    expect(result).toMatchObject({ kind: "deleted", providerEvidence: { kind: "confirmed_absent" } });
    expect(harness.state.providerDeleteCalls).toBe(1);
    expect(harness.state.localDeleteCalls).toBe(1);
  });

  it("resumes a provider-confirmed durable intent without repeating the external delete", async () => {
    const harness = deletionHarness();
    harness.state.intentStatus = "provider_confirmed";

    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result.kind).toBe("deleted");
    expect(harness.state.providerDeleteCalls).toBe(0);
    expect(harness.state.providerReadCalls).toBe(0);
    expect(harness.state.checkpointIntentCalls).toBe(0);
    expect(harness.state.localDeleteCalls).toBe(1);
  });

  it("resumes a provider-confirmed intent after the original preview display expiry", async () => {
    const harness = deletionHarness();
    harness.state.intentStatus = "provider_confirmed";
    harness.dependencies.now = () => new Date("2026-08-18T12:00:00.000Z");

    await expect(deleteLead(await deletionInput(), harness.dependencies))
      .resolves.toMatchObject({ kind: "deleted" });
    expect(harness.state.providerDeleteCalls).toBe(0);
  });

  it("returns a recoverable incomplete result when the provider checkpoint cannot commit", async () => {
    const harness = deletionHarness();
    harness.state.checkpointFails = true;

    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toMatchObject({
      kind: "incomplete",
      stage: "local_delete",
      reason: "provider_checkpoint_failed",
      retry: { providerEvidence: { kind: "confirmed_absent" } },
    });
    expect(harness.state.localDeleteCalls).toBe(0);
  });

  it("returns not-applicable provider evidence when no provider contact exists", async () => {
    const current = snapshot({
      counts: { ...snapshot().counts, identities: 1 },
      identities: [snapshot().identities[1]],
    });
    const harness = deletionHarness(current);
    const result = await deleteLead(await deletionInput(current), harness.dependencies);

    expect(result).toMatchObject({
      kind: "deleted",
      providerEvidence: { kind: "not_applicable" },
    });
    expect(harness.state.providerDeleteCalls).toBe(0);
    expect(harness.state.providerReadCalls).toBe(0);
  });

  it("finalizes a legal zero-identity contact with empty tombstone arrays", async () => {
    const current = snapshot({
      counts: { ...snapshot().counts, identities: 0 },
      identities: [],
    });
    const harness = deletionHarness(current);

    const result = await deleteLead(await deletionInput(current), harness.dependencies);

    expect(result).toMatchObject({
      kind: "deleted",
      tombstoneCount: 0,
      providerEvidence: { kind: "not_applicable" },
    });
    expect(harness.state.rpcArgs).toMatchObject({
      p_tombstone_channels: [],
      p_tombstone_hashes: [],
      p_tombstone_last4s: [],
    });
  });

  it("deduplicates identities that share one channel and normalized identifier", async () => {
    const duplicate = snapshot().identities[1];
    const current = snapshot({
      identities: [
        duplicate,
        { ...duplicate, id: "identity-meta-duplicate" },
      ],
    });
    const harness = deletionHarness(current);

    const result = await deleteLead(await deletionInput(current), harness.dependencies);

    expect(result).toMatchObject({ kind: "deleted", tombstoneCount: 1 });
    expect(harness.state.rpcArgs?.p_tombstone_channels).toEqual(["instagram"]);
    expect(harness.state.rpcArgs?.p_tombstone_hashes).toEqual([
      createHash("sha256").update("synthetic-salt:meta-user-a").digest("hex"),
    ]);
    expect(harness.state.localReadbackCalls).toBe(1);
  });

  it("replays a completed deletion before loading identity-bearing state", async () => {
    const harness = deletionHarness();
    const input = await deletionInput();
    const first = await deleteLead(input, harness.dependencies);
    const snapshotsAfterFirst = harness.state.snapshotCalls;
    const second = await deleteLead(input, harness.dependencies);

    expect(first.kind).toBe("deleted");
    expect(second).toMatchObject({ kind: "deleted", auditId: 73, replayed: true });
    expect(harness.state.snapshotCalls).toBe(snapshotsAfterFirst);
    expect(harness.state.providerDeleteCalls).toBe(1);
    expect(harness.state.localDeleteCalls).toBe(1);
  });

  it("reports an exact incomplete stage when post-delete readback cannot prove completion", async () => {
    const harness = deletionHarness();
    harness.state.localReadbackFails = true;
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toMatchObject({
      kind: "incomplete",
      stage: "local_readback",
      reason: "local_deletion_unconfirmed",
    });
  });

  it("does not report success when the surviving audit omits provider evidence", async () => {
    const harness = deletionHarness();
    const loadReadback = harness.dependencies.loadReadback;
    harness.dependencies.loadReadback = async (input) => {
      const readback = await loadReadback(input);
      if (!readback.audit) throw new Error("synthetic audit required");
      return { ...readback, audit: { ...readback.audit, payload: {} } };
    };
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toMatchObject({
      kind: "incomplete",
      stage: "local_readback",
      reason: "local_deletion_unconfirmed",
    });
  });

  it("keeps deletion inert while the live flag is off", async () => {
    const harness = deletionHarness();
    harness.dependencies.liveEnabled = false;
    const result = await deleteLead(await deletionInput(), harness.dependencies);

    expect(result).toEqual({ kind: "refused", stage: "gate", reason: "contact_delete_disabled" });
    expect(harness.state.snapshotCalls).toBe(0);
    expect(harness.state.providerDeleteCalls).toBe(0);
  });
});
