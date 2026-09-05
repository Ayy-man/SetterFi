import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ChannelCapabilityFeed } from "@/lib/sends/channel-capabilities";
import type { SendToLeadResult } from "@/lib/sends/contracts";

import { materializeCadence, type MaterializeCadenceInput } from "./materialize";
import {
  handleInboundCadence,
  pauseCadenceForTakeover,
  resolveFollowupDestination,
  resumeCadenceAfterHandback,
  runDailyLifecycleSweep,
  runFollowupBatch,
  type ClaimedFollowup,
  type FollowupIdentityCandidate,
  type FollowupSchedulerRepository,
} from "./scheduler";

const TENANT_ID = "tenant-a";
const CONTACT_ID = "contact-a";
const CONVERSATION_ID = "conversation-a";
const FOLLOWUP_ID = "followup-a";
const NOW = "2026-08-01T12:00:00.000Z";

const windowBoundFeed: ChannelCapabilityFeed = {
  instagram: { windowed: true, postWindow: "none", templates: false },
};
const whatsappTemplateFeed: ChannelCapabilityFeed = {
  whatsapp: { windowed: true, postWindow: "template", templates: true },
};

const baseMaterialization: MaterializeCadenceInput = {
  tenantId: TENANT_ID,
  conversationId: CONVERSATION_ID,
  channel: "sms",
  cadenceAnchorAt: NOW,
  providerWindowExpiresAt: null,
  materializedAt: NOW,
  lastOutboundAt: null,
};

const baseFollowup: ClaimedFollowup = {
  id: FOLLOWUP_ID,
  tenantId: TENANT_ID,
  contactId: CONTACT_ID,
  conversationId: CONVERSATION_ID,
  channel: "instagram",
  purpose: "lead_magnet",
  cadenceAnchorAt: NOW,
  providerWindowExpiresAt: "2026-08-02T12:00:00.000Z",
  originalScheduledAt: NOW,
  deferredCount: 0,
  isTest: true,
  storedChannelClass: "durable",
};

function identity(
  overrides: Partial<FollowupIdentityCandidate> = {},
): FollowupIdentityCandidate {
  return {
    id: "identity-instagram",
    channel: "instagram",
    consentState: "conversation",
    consentSource: "inbound_message",
    consentExpiresAt: "2026-10-01T00:00:00.000Z",
    providerWindowExpiresAt: "2026-08-02T12:00:00.000Z",
    isConversationIdentity: true,
    capabilityFeed: windowBoundFeed,
    ...overrides,
  };
}

function sentResult(
  idempotencyKey: string,
  channel: "sms" | "instagram" | "messenger" | "whatsapp" = "instagram",
): SendToLeadResult {
  return {
    kind: "sent",
    channel,
    receipt: {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      conversationId: CONVERSATION_ID,
      identityId: "identity-sms",
      purpose: "follow_up",
      idempotencyKey,
      decidedAt: NOW,
      auditId: 41,
      providerMessageId: "provider-message-1",
      messageId: "message-1",
      persistedAt: NOW,
    },
  };
}

function repository(
  overrides: Partial<FollowupSchedulerRepository> = {},
): FollowupSchedulerRepository {
  return {
    claimDueFollowups: async () => [],
    loadClaimedFollowup: async () => null,
    loadIdentityCandidates: async () => [],
    loadApprovedFollowupContent: async () => ({
      kind: "freeform",
      body: "Synthetic follow-up fixture.",
    }),
    recordResolvedIdentity: async () => undefined,
    ensureLinkedConversationIntent: async () => ({ conversationId: "conversation-linked" }),
    completeFollowupAttempt: async () => ({ auditId: "audit-complete" }),
    markNurtureIfExhausted: async () => undefined,
    cancelContactFollowupsOnInbound: async () => ({ canceledCount: 0, auditId: null }),
    replaceFutureCadence: async () => undefined,
    closeStaleConversations: async () => ({ closedCount: 0 }),
    claimConversation: async () => ({ auditId: "audit-claim" }),
    releaseConversationWithCadence: async () => ({ auditId: "audit-release" }),
    ...overrides,
  };
}

describe("materializeCadence", () => {
  it("materializes the five immutable durable positions from the lead-authored anchor", () => {
    const rows = materializeCadence(baseMaterialization);
    expect(rows.map((row) => [row.touchNo, row.purpose, row.scheduledAt])).toEqual([
      [1, "lead_magnet", "2026-08-01T14:00:00.000Z"],
      [2, "value_nudge", "2026-08-02T12:00:00.000Z"],
      [3, "proof_point", "2026-08-04T12:00:00.000Z"],
      [4, "new_angle", "2026-08-08T12:00:00.000Z"],
      [5, "last_touch", "2026-08-15T12:00:00.000Z"],
    ]);
  });

  it("materializes at most two window-bound positions inside the provider window", () => {
    const rows = materializeCadence({
      ...baseMaterialization,
      channel: "instagram",
      providerWindowExpiresAt: "2026-08-02T12:00:00.000Z",
      capabilityFeed: windowBoundFeed,
    });
    expect(rows.map((row) => [row.touchNo, row.scheduledAt, row.channelClass])).toEqual([
      [1, "2026-08-01T14:00:00.000Z", "window_bound"],
      [2, "2026-08-02T08:00:00.000Z", "window_bound"],
    ]);
  });

  it("ignores an advisory durable row when current WhatsApp capability is unknown", () => {
    expect(materializeCadence({
      ...baseMaterialization,
      channel: "whatsapp",
      storedChannelClass: "durable",
    })).toEqual([]);
  });

  it("changes WhatsApp from none to durable only when the current feed proves templates", () => {
    expect(materializeCadence({
      ...baseMaterialization,
      channel: "whatsapp",
      storedChannelClass: "none",
      capabilityFeed: whatsappTemplateFeed,
    })).toHaveLength(5);
  });

  it("uses only class-matched purpose overrides while timing stays platform-owned", () => {
    const rows = materializeCadence({
      ...baseMaterialization,
      purposeOverrides: [
        { channelClass: "durable", touchNo: 2, purpose: "training" },
        { channelClass: "window_bound", touchNo: 1, purpose: "last_touch" },
      ],
    });
    expect(rows[1]).toMatchObject({
      touchNo: 2,
      purpose: "training",
      scheduledAt: "2026-08-02T12:00:00.000Z",
    });
  });

  it("skips past positions on hand-back rather than reviving the missed queue", () => {
    const rows = materializeCadence({
      ...baseMaterialization,
      materializedAt: "2026-08-05T12:00:00.000Z",
      lastOutboundAt: "2026-08-05T11:40:00.000Z",
    });
    expect(rows.map((row) => row.touchNo)).toEqual([4, 5]);
  });

  it("applies the two-hour quiet gap only to a still-future absolute position", () => {
    const [first] = materializeCadence({
      ...baseMaterialization,
      lastOutboundAt: "2026-08-01T13:00:00.000Z",
    });
    expect(first.scheduledAt).toBe("2026-08-01T15:00:00.000Z");
  });
});

describe("resolveFollowupDestination", () => {
  it("keeps the open conversation identity ahead of a standing SMS fallback", () => {
    const destination = resolveFollowupDestination(baseFollowup, [
      identity({ id: "identity-sms", channel: "sms", consentState: "opted_in",
        consentSource: "web_form", providerWindowExpiresAt: null,
        isConversationIdentity: false, capabilityFeed: undefined }),
      identity(),
    ], NOW);
    expect(destination).toMatchObject({
      identityId: "identity-instagram",
      channel: "instagram",
      crossChannel: false,
    });
  });

  it("ranks standing SMS before WhatsApp template after the own window closes", () => {
    const destination = resolveFollowupDestination(baseFollowup, [
      identity({ providerWindowExpiresAt: "2026-08-01T11:59:59.000Z" }),
      identity({ id: "identity-whatsapp", channel: "whatsapp", consentState: "opted_in",
        consentSource: "platform_admin", providerWindowExpiresAt: null,
        isConversationIdentity: false, capabilityFeed: whatsappTemplateFeed }),
      identity({ id: "identity-sms", channel: "sms", consentState: "opted_in",
        consentSource: "lead_confirmed_sms", providerWindowExpiresAt: null,
        isConversationIdentity: false, capabilityFeed: undefined }),
    ], NOW);
    expect(destination).toMatchObject({ identityId: "identity-sms", channel: "sms" });
  });

  it("never reuses another channel's inbound consent as a standing fallback", () => {
    expect(resolveFollowupDestination(baseFollowup, [
      identity({ providerWindowExpiresAt: "2026-08-01T11:59:59.000Z" }),
      identity({ id: "identity-sms", channel: "sms", consentState: "conversation",
        consentSource: "inbound_message", providerWindowExpiresAt: null,
        isConversationIdentity: false, capabilityFeed: undefined }),
    ], NOW)).toBeNull();
  });
});

describe("runFollowupBatch", () => {
  it("lets concurrent batches claim one row and produce one effective send", async () => {
    let claimed = false;
    let effectiveSends = 0;
    let nurtureChecks = 0;
    const completions: string[] = [];
    const repo = repository({
      claimDueFollowups: async () => {
        if (claimed) return [];
        claimed = true;
        return [{ followupId: FOLLOWUP_ID, leaseToken: "lease-1", dueAt: NOW, auditId: "audit-1" }];
      },
      loadClaimedFollowup: async () => baseFollowup,
      loadIdentityCandidates: async () => [identity()],
      completeFollowupAttempt: async (input) => {
        completions.push(input.outcome);
        return { auditId: "audit-complete" };
      },
      markNurtureIfExhausted: async () => { nurtureChecks += 1; },
    });
    const sendToLead: Parameters<typeof runFollowupBatch>[1]["sendToLead"] = async (request) => {
      effectiveSends += 1;
      return sentResult(request.idempotencyKey);
    };
    const input = { tenantId: TENANT_ID, workerKey: "worker-a", now: NOW };
    const [left, right] = await Promise.all([
      runFollowupBatch(input, { repository: repo, sendToLead }),
      runFollowupBatch(input, { repository: repo, sendToLead }),
    ]);
    expect([...left, ...right]).toHaveLength(1);
    expect(effectiveSends).toBe(1);
    expect(completions).toEqual(["sent"]);
    expect(nurtureChecks).toBe(1);
  });

  it("replays one stable send key after a crash without a second effective dispatch", async () => {
    let claimAttempt = 0;
    let completionAttempt = 0;
    let effectiveSends = 0;
    const receipts = new Map<string, SendToLeadResult>();
    const repo = repository({
      claimDueFollowups: async () => {
        claimAttempt += 1;
        return [{ followupId: FOLLOWUP_ID, leaseToken: `lease-${claimAttempt}`,
          dueAt: NOW, auditId: `audit-${claimAttempt}` }];
      },
      loadClaimedFollowup: async () => baseFollowup,
      loadIdentityCandidates: async () => [identity()],
      completeFollowupAttempt: async () => {
        completionAttempt += 1;
        if (completionAttempt === 1) throw new Error("synthetic crash after dispatch");
        return { auditId: "audit-complete" };
      },
    });
    const sendToLead: Parameters<typeof runFollowupBatch>[1]["sendToLead"] = async (request) => {
      const prior = receipts.get(request.idempotencyKey);
      if (prior) return prior;
      effectiveSends += 1;
      const receipt = sentResult(request.idempotencyKey);
      receipts.set(request.idempotencyKey, receipt);
      return receipt;
    };
    const input = { tenantId: TENANT_ID, workerKey: "worker-a", now: NOW };
    await expect(runFollowupBatch(input, { repository: repo, sendToLead }))
      .rejects.toThrow(/synthetic crash/);
    await expect(runFollowupBatch(input, { repository: repo, sendToLead }))
      .resolves.toEqual([{ followupId: FOLLOWUP_ID, outcome: "sent", reason: null }]);
    expect(effectiveSends).toBe(1);
  });

  it("records the resolved identity and linked origin before cross-channel send", async () => {
    const events: string[] = [];
    let linkedInput: unknown;
    const repo = repository({
      claimDueFollowups: async () => [
        { followupId: FOLLOWUP_ID, leaseToken: "lease-1", dueAt: NOW, auditId: "audit-1" },
      ],
      loadClaimedFollowup: async () => ({
        ...baseFollowup,
        providerWindowExpiresAt: "2026-08-01T11:59:59.000Z",
      }),
      loadIdentityCandidates: async () => [
        identity({ providerWindowExpiresAt: "2026-08-01T11:59:59.000Z" }),
        identity({ id: "identity-sms", channel: "sms", consentState: "opted_in",
          consentSource: "web_form", providerWindowExpiresAt: null,
          isConversationIdentity: false, capabilityFeed: undefined }),
      ],
      recordResolvedIdentity: async () => { events.push("identity"); },
      ensureLinkedConversationIntent: async (input) => {
        events.push("linked");
        linkedInput = input;
        return { conversationId: "conversation-sms" };
      },
    });
    const sendToLead: Parameters<typeof runFollowupBatch>[1]["sendToLead"] = async (request) => {
      events.push("send");
      return sentResult(request.idempotencyKey, "sms");
    };
    await runFollowupBatch({ tenantId: TENANT_ID, workerKey: "worker-a", now: NOW }, {
      repository: repo,
      sendToLead,
    });
    expect(events.slice(0, 3)).toEqual(["identity", "linked", "send"]);
    expect(linkedInput).toMatchObject({
      originConversationId: CONVERSATION_ID,
      targetIdentityId: "identity-sms",
      originChannel: "instagram",
      targetChannel: "sms",
      cadenceAnchorAt: NOW,
    });
  });

  it("blocks a touch with no approved copy without completing it or failing the batch", async () => {
    const completions: string[] = [];
    let sends = 0;
    const repo = repository({
      claimDueFollowups: async () => [
        { followupId: FOLLOWUP_ID, leaseToken: "lease-1", dueAt: NOW, auditId: "audit-1" },
        { followupId: "followup-b", leaseToken: "lease-2", dueAt: NOW, auditId: "audit-2" },
      ],
      loadClaimedFollowup: async ({ followupId }) => ({ ...baseFollowup, id: followupId }),
      loadIdentityCandidates: async () => [identity()],
      loadApprovedFollowupContent: async ({ followupId }) => followupId === FOLLOWUP_ID
        ? { kind: "unavailable", reason: "approved_followup_copy_required" }
        : { kind: "freeform", body: "Synthetic follow-up fixture." },
      completeFollowupAttempt: async (input) => {
        completions.push(`${input.followupId}:${input.outcome}`);
        return { auditId: "audit-complete" };
      },
    });
    const sendToLead: Parameters<typeof runFollowupBatch>[1]["sendToLead"] = async (request) => {
      sends += 1;
      return sentResult(request.idempotencyKey);
    };
    const results = await runFollowupBatch(
      { tenantId: TENANT_ID, workerKey: "worker-a", now: NOW },
      { repository: repo, sendToLead },
    );
    expect(results).toEqual([
      { followupId: FOLLOWUP_ID, outcome: "blocked", reason: "approved_followup_copy_required" },
      { followupId: "followup-b", outcome: "sent", reason: null },
    ]);
    expect(sends).toBe(1);
    expect(completions).toEqual(["followup-b:sent"]);
  });

  it("cancels a window-bound deferral that would land after provider close", async () => {
    let completion: unknown;
    const repo = repository({
      claimDueFollowups: async () => [
        { followupId: FOLLOWUP_ID, leaseToken: "lease-1", dueAt: NOW, auditId: "audit-1" },
      ],
      loadClaimedFollowup: async () => baseFollowup,
      loadIdentityCandidates: async () => [identity({
        providerWindowExpiresAt: "2026-08-01T12:30:00.000Z",
      })],
      completeFollowupAttempt: async (input) => {
        completion = input;
        return { auditId: "audit-complete" };
      },
    });
    const sendToLead: Parameters<typeof runFollowupBatch>[1]["sendToLead"] = async (request) => ({
      kind: "deferred",
      reason: "quiet_hours",
      scheduledAt: "2026-08-01T13:00:00.000Z",
      timezoneSource: "contact",
      followupId: FOLLOWUP_ID,
      receipt: {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        identityId: "identity-instagram",
        purpose: "follow_up",
        idempotencyKey: request.idempotencyKey,
        decidedAt: NOW,
        auditId: 51,
      },
    });
    await runFollowupBatch({ tenantId: TENANT_ID, workerKey: "worker-a", now: NOW }, {
      repository: repo,
      sendToLead,
    });
    expect(completion).toMatchObject({ outcome: "canceled", canceledReason: "window_closed" });
  });
});

describe("cadence lifecycle", () => {
  it("cancels and reanchors only lead-authored inbound rather than receipts or echoes", async () => {
    let cancellations = 0;
    let replacements = 0;
    const repo = repository({
      cancelContactFollowupsOnInbound: async () => {
        cancellations += 1;
        return { canceledCount: 3, auditId: "audit-cancel" };
      },
      replaceFutureCadence: async () => { replacements += 1; },
    });
    const event = {
      kind: "lead_message" as const,
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      inboundMessageId: "message-inbound",
      materialization: baseMaterialization,
    };
    await expect(handleInboundCadence(event, repo)).resolves.toMatchObject({
      kind: "reanchored",
      canceledCount: 3,
    });
    await expect(handleInboundCadence({ ...event, kind: "echo" }, repo)).resolves.toEqual({
      kind: "ignored",
    });
    expect({ cancellations, replacements }).toEqual({ cancellations: 1, replacements: 1 });
  });

  it("runs the 30-day stale sweep unconditionally from the supplied clock", async () => {
    let sweepInput: unknown;
    const repo = repository({
      closeStaleConversations: async (input) => {
        sweepInput = input;
        return { closedCount: 2 };
      },
    });
    await expect(runDailyLifecycleSweep({ tenantId: TENANT_ID, now: NOW }, repo))
      .resolves.toEqual({ closedCount: 2 });
    expect(sweepInput).toEqual({
      tenantId: TENANT_ID,
      lastLeadInboundBefore: "2026-07-02T12:00:00.000Z",
      occurredAt: NOW,
    });
  });

  it("delegates takeover to the pause-aware RPC boundary", async () => {
    let claimed: unknown;
    const repo = repository({
      claimConversation: async (input) => {
        claimed = input;
        return { auditId: "audit-claim" };
      },
    });
    const input = {
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      actorId: "coach-a",
      expectedStatus: "agent" as const,
      expectedHolderId: null,
      confirmDisplace: false,
    };
    await expect(pauseCadenceForTakeover(input, repo)).resolves.toEqual({ auditId: "audit-claim" });
    expect(claimed).toEqual(input);
  });

  it("recomputes only future absolute positions after hand-back", async () => {
    let replacement: { followups: readonly { touchNo: number }[] } | undefined;
    const repo = repository({
      releaseConversationWithCadence: async (input) => {
        replacement = input;
        return { auditId: "audit-release" };
      },
    });
    const result = await resumeCadenceAfterHandback({
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      actorId: "coach-a",
      expectedHolderId: "coach-a",
      materialization: {
        ...baseMaterialization,
        materializedAt: "2026-08-05T12:00:00.000Z",
      },
    }, repo);
    expect(result.auditId).toBe("audit-release");
    expect(replacement?.followups.map((row) => row.touchNo)).toEqual([4, 5]);
  });
});

describe("Phase 6 billing-status claim contract", () => {
  it("keeps the Phase 3 claim seam and excludes only suspended tenants in live SQL", () => {
    const scheduler = readFileSync(new URL("./scheduler.ts", import.meta.url), "utf8");
    expect(scheduler, "PHASE3_FOLLOWUP_CLAIM_CONTRACT_MISSING").toContain("claimDueFollowups");
    const migration = readFileSync(
      new URL("../../../supabase/migrations/20260822000001_phase6_money.sql", import.meta.url),
      "utf8",
    );
    expect(migration, "PHASE3_FOLLOWUP_CLAIM_CONTRACT_MISSING")
      .toContain("tenant.status <> 'suspended'");
  });
});
