import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { ConversationRead } from "@/lib/repositories/conversations";
import {
  deriveCandidateMergeTruth,
  deriveChannelTruths,
  deriveContactUndoTruth,
  deriveContactView,
  deriveConversationView,
  deriveMetaReviewTruth,
  deriveTemplateTruth,
  deriveTestingView,
} from "./view-models";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";

function conversation(overrides: Partial<ConversationRead> = {}): ConversationRead {
  return {
    id: "conversation-1",
    contactId: "contact-1",
    contactName: "Test Lead",
    channel: "sms",
    status: "agent",
    statusReason: null,
    takenOverBy: null,
    unreadByCoach: true,
    disclosurePending: false,
    currentStepAsks: 1,
    isDemo: true,
    isTest: true,
    lastActivityAt: "2026-08-17T00:00:00.000Z",
    qualification: { credit: "660-699", goal: "$25K-$50K", timeline: "This month", outcome: "BOOK" },
    appointment: null,
    messages: [],
    ...overrides,
  };
}

describe("deriveConversationView", () => {
  it("shows the persisted post-release disclosure once and preserves system delivery truth", () => {
    const disclosure = "For transparency, I’m the automated assistant helping the team.";
    const released = conversation({
      messages: [
        { id: "system-1", direction: "system", author: "system", body: "Conversation handed back", createdAt: "2026-08-17T00:00:01.000Z", delivered: true, simulated: false, },
        { id: "out-1", direction: "out", author: "agent", body: `${disclosure} How can I help?`, createdAt: "2026-08-17T00:00:02.000Z", delivered: true, simulated: false, },
      ],
    });

    const view = deriveConversationView(conversation({ status: "human", takenOverBy: "coach-1" }), { ok: true, conversation: released });

    expect(view.messages.filter((message) => message.body.startsWith(disclosure))).toHaveLength(1);
    expect(view.messages.find((message) => message.direction === "system")?.delivered).toBe(false);
  });

  it("restores the persisted row after a failed or mismatched read-back", () => {
    const original = conversation();
    expect(deriveConversationView(original, { ok: false, error: "Save failed" })).toMatchObject({ status: "agent", readBackError: "Save failed" });
    expect(deriveConversationView(original, { ok: true, conversation: conversation({ id: "other", status: "human", takenOverBy: "coach-1" }) })).toMatchObject({ status: "agent", readBackError: expect.any(String) });
  });
});

describe("honest row labels", () => {
  it("derives demo and test contact state from persisted fields", () => {
    expect(deriveContactView({
      id: "contact-1",
      name: "Test Lead",
      channels: [],
      credit: null,
      goal: null,
      timeline: null,
      outcome: null,
      pipelineStage: "new",
      lastActivityAt: "2026-08-17T00:00:00.000Z",
      isDemo: true,
      isTest: true,
    })).toMatchObject({ isDemo: true, isTest: true, primaryChannel: null });
  });

  it("never maps a mock or missing-key arm to a passed or live claim", () => {
    const view = deriveTestingView({
      moderatorUnavailableCount: 3,
      arms: [
        { id: "mock", label: "Default", role: "Generator", selector: "mock", hasUsableKey: false, persistedTrace: null },
        { id: "real", label: "Candidate", role: "Generator", selector: "real", hasUsableKey: false, persistedTrace: null },
      ],
    });
    expect(view.moderatorUnavailableCount).toBe(3);
    expect(view.arms.map((arm) => arm.state)).toEqual(["Mock", "Skipped"]);
    expect(JSON.stringify(view)).not.toMatch(/Passed|Live/);
  });

  it("renders Grounded only for a persisted trace with sources and passing checks", () => {
    const trace = {
      id: "trace-1",
      tenantId: "tenant-1",
      model: "model",
      ruleFired: "rule-1",
      retrievedEntryIds: ["entry-1"],
      checks: { sourceSupported: true },
      violations: [],
      moderatorState: "allowed" as const,
      createdAt: "2026-08-17T00:00:00.000Z",
    };
    const grounded = deriveTestingView({ moderatorUnavailableCount: 0, arms: [{ id: "real", label: "Candidate", role: "Generator", selector: "real", hasUsableKey: true, persistedTrace: trace }] });
    const ungrounded = deriveTestingView({ moderatorUnavailableCount: 0, arms: [{ id: "real", label: "Candidate", role: "Generator", selector: "real", hasUsableKey: true, persistedTrace: { ...trace, retrievedEntryIds: [] } }] });
    expect(grounded.arms[0].grounded).toBe(true);
    expect(ungrounded.arms[0].grounded).toBe(false);
  });
});

describe("live import graph", () => {
  it("does not transitively import workspace fixtures from live pages or the shell", () => {
    const roots = [
      "src/app/(workspace)/coach/conversations/page.tsx",
      "src/app/(workspace)/coach/contacts/page.tsx",
      "src/app/(workspace)/coach/integrations/page.tsx",
      "src/app/(workspace)/admin/channel-health/page.tsx",
      "src/app/(workspace)/admin/brain/testing/page.tsx",
      "src/components/kit/app-shell.tsx",
    ].map((file) => resolve(process.cwd(), file));
    const visited = new Set<string>();
    const fixtureImports: string[] = [];

    function scan(file: string) {
      if (visited.has(file)) return;
      visited.add(file);
      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        return;
      }
      for (const match of source.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^"']+?\s+from\s+)?["']([^"']+)["']/g)) {
        const specifier = match[1];
        if (specifier.includes("workspace-fixtures")) fixtureImports.push(`${file}:${specifier}`);
        if (!specifier.startsWith(".") && !specifier.startsWith("@/")) continue;
        const base = specifier.startsWith("@/")
          ? resolve(process.cwd(), "src", specifier.slice(2))
          : resolve(dirname(file), specifier);
        for (const candidate of [`${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
          try {
            readFileSync(candidate);
            scan(candidate);
            break;
          } catch {
            // Try the next supported TypeScript resolution shape.
          }
        }
      }
    }

    roots.forEach(scan);
    expect(fixtureImports).toEqual([]);
  });
});

// Phase 4
function connection(overrides: Partial<ChannelConnectionView> = {}): ChannelConnectionView {
  return {
    id: "connection-1",
    channel: "instagram",
    channelLabel: "Instagram",
    state: "ready",
    externalAccountLabel: "Synthetic account",
    capabilities: { windowed: true, postWindow: "none", templates: false },
    receipts: {
      oauthCompletedAt: "2026-08-17T00:00:00.000Z",
      assetVerifiedAt: "2026-08-17T00:00:01.000Z",
      webhookSubscribedAt: "2026-08-17T00:00:02.000Z",
      signedRoundTripAt: null,
    },
    error: null,
    tokenExpiresAt: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

function template(overrides: Partial<MessageTemplateView> = {}): MessageTemplateView {
  return {
    id: "template-1",
    channel: "whatsapp",
    providerTemplateName: "synthetic_template",
    category: "utility",
    locale: "en_US",
    body: "Synthetic body",
    bodyHash: "hash",
    variables: [],
    status: "draft",
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    pausedAt: null,
    disabledAt: null,
    statusUpdatedAt: null,
    rejectionDetail: null,
    isDemo: false,
    dataLabel: null,
    ...overrides,
  };
}

describe("Phase 4 channel truth", () => {
  it("derives Connected and Live only from their required persisted receipts", () => {
    const connected = deriveChannelTruths([connection()], [], new Date("2026-08-17T00:00:00.000Z"));
    const unprovenLive = deriveChannelTruths([connection({ state: "live" })], [], new Date("2026-08-17T00:00:00.000Z"));
    const live = deriveChannelTruths([connection({ state: "live", receipts: { ...connection().receipts, signedRoundTripAt: "2026-08-17T00:00:03.000Z" } })], [], new Date("2026-08-17T00:00:00.000Z"));
    expect(connected[0].stateLabel).toBe("Connected");
    expect(unprovenLive[0].stateLabel).not.toBe("Live");
    expect(live[0].stateLabel).toBe("Live");
  });

  it("keeps provider and carrier waits honest without percentages or predicted dates", () => {
    const truths = deriveChannelTruths([
      connection({ state: "pending_review" }),
      connection({ id: "sms-1", channel: "sms", channelLabel: "Text messages (SMS)", state: "pending_review", capabilities: { windowed: false, postWindow: "none", templates: false } }),
    ], [], new Date("2026-08-17T12:00:00.000Z"), "2026-08-15T00:00:00.000Z");
    expect(truths.find((row) => row.channel === "instagram")?.stateLabel).toBe("Pending review");
    expect(truths.find((row) => row.channel === "sms")?.stateLabel).toBe("Registering · day 3");
    expect(JSON.stringify(truths)).not.toMatch(/%|complete by|estimated date/i);
  });

  it("counts the carrier clock from the A2P filing, not from when the row was created", () => {
    // The connection row predates the filing by a week; the counter must follow
    // the submission receipt so this card and the go-live checklist agree.
    const sms = connection({ id: "sms-1", channel: "sms", channelLabel: "Text messages (SMS)", state: "pending_review", createdAt: "2026-08-08T00:00:00.000Z", capabilities: { windowed: false, postWindow: "none", templates: false } });
    const truths = deriveChannelTruths([sms], [], new Date("2026-08-17T12:00:00.000Z"), "2026-08-15T00:00:00.000Z");
    expect(truths.find((row) => row.channel === "sms")?.stateLabel).toBe("Registering · day 3");
  });

  it("names no day at all when nothing has been filed yet", () => {
    const sms = connection({ id: "sms-1", channel: "sms", channelLabel: "Text messages (SMS)", state: "pending_review", capabilities: { windowed: false, postWindow: "none", templates: false } });
    const truths = deriveChannelTruths([sms], [], new Date("2026-08-17T12:00:00.000Z"), null);
    expect(truths.find((row) => row.channel === "sms")?.stateLabel)
      .toBe("Registering · carrier review takes 2–3 weeks");
  });

  it("renders terminal carrier rejection as permanently blocked", () => {
    const truths = deriveChannelTruths([
      connection({ channel: "sms", channelLabel: "Text messages (SMS)", state: "blocked_permanent", capabilities: { windowed: false, postWindow: "none", templates: false } }),
    ], []);
    expect(truths.find((row) => row.channel === "sms")).toMatchObject({ stateLabel: "Permanently blocked", tone: "bad" });
  });

  it("requires an approval timestamp and labels synthetic approval as Demo", () => {
    expect(deriveTemplateTruth(template({ status: "approved" })).label).toBe("Status unavailable");
    expect(deriveTemplateTruth(template({ status: "approved", approvedAt: "2026-08-17T00:00:00.000Z", isDemo: true, dataLabel: "Demo" }))).toEqual({ label: "Approved", tone: "good", isDemo: true });
  });

  it("never advances provider filing without a human-entered reference", () => {
    expect(deriveMetaReviewTruth(null).label).toBe("Not filed");
    expect(deriveMetaReviewTruth({ state: "approved", reference: null }).label).toBe("Not filed");
    expect(deriveMetaReviewTruth({ state: "under_review", reference: "synthetic-reference" }).label).toBe("Under review");
  });

  it("blocks merge during impersonation or across the test boundary", () => {
    const candidate = {
      id: "candidate-1",
      otherContact: { id: "contact-2", name: "Synthetic Other", isTest: false },
      source: "field_match" as const,
      evidenceKey: "normalized-email",
      evidence: {},
      state: "open" as const,
      createdAt: "2026-08-17T00:00:00.000Z",
      testBoundary: "real" as const,
      dataLabel: null,
    };
    expect(deriveCandidateMergeTruth(candidate, true).canMerge).toBe(false);
    expect(deriveCandidateMergeTruth({ ...candidate, testBoundary: "mixed" }, false).canMerge).toBe(false);
    expect(deriveCandidateMergeTruth(candidate, false).canMerge).toBe(true);
  });

  it("offers undo only from a merged detail carrying a reversible audit row", () => {
    const detail = {
      contactId: "contact-2",
      name: "Synthetic Other",
      isDemo: false,
      isTest: false,
      identities: [],
      candidates: [],
      mergeState: { status: "merged" as const, mergedIntoContactId: "contact-1", mergedAt: "2026-08-17T00:00:00.000Z" },
      undo: { auditRowId: 42 },
    };
    expect(deriveContactUndoTruth(detail, false)).toEqual({ contactId: "contact-2", winnerId: "contact-1", auditRowId: 42 });
    expect(deriveContactUndoTruth({ ...detail, undo: null }, false)).toBeNull();
    expect(deriveContactUndoTruth(detail, true)).toBeNull();
  });
});

// Phase 3
type DeletePreview = import("@/lib/deletion/contracts").DeletionPreview;
type DeleteResult = import("@/lib/deletion/contracts").DeleteLeadResult;

function deletionPreview(): DeletePreview {
  return {
    tenantId: "tenant-1",
    contactId: "contact-1",
    actorId: "actor-1",
    token: "synthetic-preview-token",
    expiresAt: "2026-08-17T00:15:00.000Z",
    reasonRequired: true,
    counts: {
      mergedContacts: 0,
      contactNotes: 0,
      identities: 2,
      conversations: 1,
      messages: 4,
      messageTraces: 4,
      followups: 2,
      appointments: 1,
      unmatchedObjections: 0,
      mergeAuditsRedacted: 0,
      billableEventsDetached: 1,
      evalCasesSevered: 1,
    },
    providerEffects: [{
      kind: "provider_contact_delete",
      provider: "ghl",
      state: "pending",
      targetCount: 1,
      label: "Connected contact provider",
    }],
    receipt: {
      actionKey: "contact.delete.preview",
      auditId: 41,
      previewedAt: "2026-08-17T00:00:00.000Z",
    },
  };
}

async function confirmingDeletion(reason = "Privacy request received") {
  const { deleteFlowState, INITIAL_DELETE_FLOW_STATE } = await import("./view-models");
  const previewed = deleteFlowState(INITIAL_DELETE_FLOW_STATE, {
    type: "preview_loaded",
    preview: deletionPreview(),
  });
  return deleteFlowState(previewed, { type: "reason_changed", reason });
}

describe("Phase 3 deleteFlowState", () => {
  it("cancels back to a clean idle state instead of retaining a destructive preview", async () => {
    const { deleteFlowState, INITIAL_DELETE_FLOW_STATE } = await import("./view-models");
    const state = await confirmingDeletion();
    expect(deleteFlowState(state, { type: "cancel" })).toEqual(INITIAL_DELETE_FLOW_STATE);
  });

  it("keeps confirmation open when the required reason is missing instead of starting deletion", async () => {
    const { deleteFlowState } = await import("./view-models");
    const state = await confirmingDeletion("   ");
    expect(deleteFlowState(state, { type: "submit" })).toMatchObject({
      kind: "confirming",
      reasonError: expect.stringContaining("reason"),
    });
  });

  it("discards a stale preview and requests a fresh one instead of retrying with old counts", async () => {
    const { deleteFlowState } = await import("./view-models");
    const deleting = deleteFlowState(await confirmingDeletion(), { type: "submit" });
    const stale = deleteFlowState(deleting, {
      type: "result",
      result: { kind: "refused", stage: "preview", reason: "preview_stale" },
    });
    expect(stale).toMatchObject({ kind: "failed", preview: null, retry: null });
    expect(deleteFlowState(stale, { type: "retry" }).kind).toBe("previewing");
  });

  it("names provider failure without claiming a local deletion", async () => {
    const { deleteFlowState } = await import("./view-models");
    const deleting = deleteFlowState(await confirmingDeletion(), { type: "submit" });
    const result: DeleteResult = {
      kind: "incomplete",
      stage: "provider_readback",
      reason: "PROVIDER_ABSENCE_UNCONFIRMED",
      retry: null,
    };
    expect(deleteFlowState(deleting, { type: "result", result })).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("could not be confirmed"),
      auditId: null,
    });
  });

  it("names local failure without rendering Deleted", async () => {
    const { deleteFlowState } = await import("./view-models");
    const deleting = deleteFlowState(await confirmingDeletion(), { type: "submit" });
    const result: DeleteResult = {
      kind: "incomplete",
      stage: "local_readback",
      reason: "TOMBSTONE_READBACK_MISSING",
      retry: null,
    };
    expect(deleteFlowState(deleting, { type: "result", result })).toMatchObject({
      kind: "failed",
      error: expect.stringContaining("tombstones"),
      auditId: null,
    });
  });

  it("retries a provider failure with its saved receipt instead of constructing new proof", async () => {
    const { deleteFlowState } = await import("./view-models");
    const deleting = deleteFlowState(await confirmingDeletion(), { type: "submit" });
    const retry = {
      version: 1 as const,
      tenantId: "tenant-1",
      contactId: "contact-1",
      idempotencyDigest: "synthetic-digest",
      providerDeleteReceipts: [{ providerOperationId: "operation-1", acceptedAt: "2026-08-17T00:00:01.000Z" }],
      providerEvidence: null,
    };
    const failed = deleteFlowState(deleting, {
      type: "result",
      result: { kind: "incomplete", stage: "provider_readback", reason: "WAITING", retry },
    });
    expect(deleteFlowState(failed, { type: "retry" })).toMatchObject({
      kind: "deleting",
      retry,
    });
  });

  it("enters Deleted only from the service result carrying audit and tombstone read-back", async () => {
    const { deleteFlowState } = await import("./view-models");
    const deleting = deleteFlowState(await confirmingDeletion(), { type: "submit" });
    const result: DeleteResult = {
      kind: "deleted",
      auditId: 73,
      providerEvidence: {
        kind: "confirmed_absent",
        receipts: [{
          providerOperationId: "operation-1",
          acceptedAt: "2026-08-17T00:00:01.000Z",
          observedAt: "2026-08-17T00:00:02.000Z",
        }],
      },
      tombstoneCount: 2,
      replayed: false,
    };
    expect(deleteFlowState(deleting, { type: "result", result })).toMatchObject({
      kind: "deleted",
      auditId: 73,
      tombstoneCount: 2,
    });
  });
});

describe("Phase 3 affirmative labels", () => {
  it("maps each label only from its named persisted receipt fields", async () => {
    const { complianceAffirmativeLabel } = await import("./view-models");
    expect(complianceAffirmativeLabel({
      kind: "provider_confirmation",
      providerSyncState: "confirmed",
      providerSyncedAt: "2026-08-17T00:00:00.000Z",
    })).toBe("Confirmed by provider");
    expect(complianceAffirmativeLabel({
      kind: "provider_confirmation",
      providerSyncState: "confirmed",
      providerSyncedAt: null,
    })).toBeNull();

    expect(complianceAffirmativeLabel({
      kind: "audit",
      auditId: "41",
      actionKey: "conversation.claimed",
      label: "Takeover logged",
    })).toBe("Logged");
    expect(complianceAffirmativeLabel({
      kind: "audit",
      auditId: null,
      actionKey: "conversation.claimed",
      label: "Takeover logged",
    })).toBeNull();

    expect(complianceAffirmativeLabel({
      kind: "escalation",
      needsHumanAt: "2026-08-17T00:00:00.000Z",
      auditId: 42,
      alertIntentId: "intent-1",
    })).toBe("Escalated");
    expect(complianceAffirmativeLabel({
      kind: "escalation",
      needsHumanAt: "2026-08-17T00:00:00.000Z",
      auditId: 42,
      alertIntentId: null,
    })).toBeNull();

    expect(complianceAffirmativeLabel({
      kind: "deletion",
      result: {
        kind: "deleted",
        auditId: 43,
        providerEvidence: { kind: "not_applicable" },
        tombstoneCount: 1,
        replayed: false,
      },
    })).toBe("Deleted");
    expect(complianceAffirmativeLabel({
      kind: "deletion",
      result: { kind: "refused", stage: "preview", reason: "preview_stale" },
    })).toBeNull();
  });
});

describe("Phase 3 resolved coach cadence", () => {
  it("uses all five fixed touches for freeform and template-send capabilities", async () => {
    const { resolvedCoachCadenceClass } = await import("./view-models");
    expect(resolvedCoachCadenceClass("sms", { postWindow: "freeform", templateSend: false })).toBe("durable");
    expect(resolvedCoachCadenceClass("whatsapp", { postWindow: "template", templateSend: true })).toBe("durable");
  });

  it("keeps closed and human-only post-window capabilities inside the active window", async () => {
    const { resolvedCoachCadenceClass } = await import("./view-models");
    expect(resolvedCoachCadenceClass("instagram", { postWindow: "none", templateSend: false })).toBe("window_bound");
    expect(resolvedCoachCadenceClass("messenger", { postWindow: "human_agent_only", templateSend: false })).toBe("window_bound");
  });

  it("promises no sends when there is no connected channel capability", async () => {
    const { resolvedCoachCadenceClass } = await import("./view-models");
    expect(resolvedCoachCadenceClass(null, null)).toBe("none");
  });
});
// End Phase 3

// Phase 6
describe("Phase 6 money truth", () => {
  it("omits margin entirely when cost evidence is absent or incomplete", async () => {
    const { deriveCostView } = await import("./view-models");
    const absent = deriveCostView(null);
    const incomplete = deriveCostView({
      rollupId: "rollup-1",
      tenantId: "tenant-1",
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-09-01T00:00:00.000Z",
      modelCostCents: 120,
      messagingCostCents: null,
      embeddingCostCents: 30,
      revenueCents: 1_000,
      complete: false,
      missingSources: ["messaging"],
      sourceEvidenceAt: "2026-08-18T00:00:00.000Z",
    });
    expect(absent).not.toHaveProperty("margin");
    expect(incomplete).not.toHaveProperty("margin");
    expect(JSON.stringify([absent, incomplete])).not.toMatch(/margin/i);
  });

  it("derives margin only from a complete source-backed rollup", async () => {
    const { deriveCostView } = await import("./view-models");
    expect(deriveCostView({
      rollupId: "rollup-2",
      tenantId: "tenant-1",
      windowStart: "2026-08-01T00:00:00.000Z",
      windowEnd: "2026-09-01T00:00:00.000Z",
      modelCostCents: 120,
      messagingCostCents: 80,
      embeddingCostCents: 30,
      revenueCents: 1_000,
      complete: true,
      missingSources: [],
      sourceEvidenceAt: "2026-08-18T00:00:00.000Z",
    })).toMatchObject({
      stateLabel: "Cost evidence complete",
      margin: { cents: 770, totalCostCents: 230 },
    });
  });

  it("gives success request evidence without controls, decisions, or economics", async () => {
    const { deriveSuccessCorrectionQueue } = await import("./view-models");
    const rows = deriveSuccessCorrectionQueue([{
      requestId: "request-1",
      tenantId: "tenant-1",
      billableEventId: "event-1",
      quantityDelta: -1,
      reason: "Synthetic duplicate booking",
      requestedAt: "2026-08-18T00:00:00.000Z",
      requestAuditId: 41,
      decision: "approved",
      decisionId: "decision-1",
      decisionAuditId: 42,
      offsetEventId: "offset-1",
    }]);
    // `dataLabel` is admissible under this guard's own authority. What the guard pins is that a
    // success person sees the request and none of the machinery around deciding it -- no controls,
    // no decision, no economics -- and provenance is none of those three. It carries "Demo" or
    // null, sourced from `tenants.is_demo`, so it says which tenant the row came from rather than
    // anything about what the correction is worth or who may act on it. The negative assertion
    // below still runs over the serialized row unchanged, so a decision or an economics field
    // arriving under this name would still fail here.
    expect(Object.keys(rows[0]).sort()).toEqual([
      "billableEventId", "dataLabel", "quantityDelta", "reason", "requestAuditId",
      "requestId", "requestedAt", "tenantId",
    ].sort());
    expect(JSON.stringify(rows)).not.toMatch(/approve|reject|decision|offset|price|revenue|cost|margin|commission/i);
  });

  it("requires persisted audit and event receipts before affirmative money labels", async () => {
    const { deriveCorrectionView, derivePayoutView, moneyReceiptLabel } = await import("./view-models");
    expect(moneyReceiptLabel(null, "Logged")).toBe("Pending");
    expect(moneyReceiptLabel({ auditId: 41 }, "Logged")).toBe("Logged");
    expect(moneyReceiptLabel({ auditId: 41 }, "Approved")).toBe("Pending");
    expect(moneyReceiptLabel({ auditId: 41, eventId: "event-1" }, "Approved")).toBe("Approved");
    expect(deriveCorrectionView({
      requestId: "request-1", tenantId: "tenant-1", billableEventId: "event-1",
      quantityDelta: -1, reason: "Synthetic correction", requestedAt: "now",
      requestAuditId: 41, decision: "approved", decisionId: "decision-1",
      decisionAuditId: 42, offsetEventId: null,
    }).stateLabel).toBe("pending");
    expect(derivePayoutView({
      payoutId: "payout-1", affiliateId: "affiliate-1", affiliateName: "Synthetic Partner",
      totalCents: 500, approvedEventId: "approved-event", approvedAuditId: 51,
      sentEventId: "sent-event", sentAuditId: 52, reference: "synthetic-reference",
      paidOn: "2026-08-18",
    })).toMatchObject({ stateLabel: "Recorded sent", reference: "synthetic-reference", paidOn: "2026-08-18" });
  });

  it("does not read legacy-dead commission or referral fields", () => {
    const source = readFileSync(resolve(process.cwd(), "src/components/workspace/live/view-models.ts"), "utf8");
    for (const forbidden of [
      /commission_ledger\.(?:status|paid_by|paid_at|updated_at)/,
      /referrals\.clawback/,
    ]) expect(source).not.toMatch(forbidden);
  });

  it("returns 403 for every success money page except read-only corrections", async () => {
    const { moneyPageAccessStatus } = await import("./view-models");
    expect(moneyPageAccessStatus("success", "corrections")).toBe(200);
    expect(moneyPageAccessStatus("success", "tiers")).toBe(403);
    expect(moneyPageAccessStatus("success", "billing")).toBe(403);
    expect(moneyPageAccessStatus("success", "affiliates")).toBe(403);
    for (const surface of ["tiers", "billing", "corrections", "affiliates"] as const) {
      expect(moneyPageAccessStatus("coach", surface)).toBe(403);
      expect(moneyPageAccessStatus("affiliate", surface)).toBe(403);
      expect(moneyPageAccessStatus("owner", surface)).toBe(200);
      expect(moneyPageAccessStatus("admin", surface)).toBe(200);
    }
  });

  it("keeps the Money page fixture-free and gates before actor or data access", () => {
    /*
     * The four Money surfaces are five tabs of `/admin/billing` now, and the tiers loader is still
     * its own file because the page and the loader are read separately. The old routes are kept as
     * redirects so a saved link still lands on its rows, which is asserted below rather than left
     * to a 404 nobody notices.
     */
    for (const surface of ["tiers", "corrections", "affiliates"]) {
      const redirect = resolve(process.cwd(), `src/app/(workspace)/admin/${surface}/page.tsx`);
      expect(existsSync(redirect)).toBe(true);
      expect(readFileSync(redirect, "utf8")).toContain("foldedRouteRedirect(");
    }
    for (const path of [
      "src/app/(workspace)/admin/tiers/render-tiers-page.tsx",
      "src/app/(workspace)/admin/billing/page.tsx",
    ].map((file) => resolve(process.cwd(), file))) {
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/workspace-fixtures|FixtureWorkspaceShell|WorkspaceScreen/);
      expect(source.indexOf("if (!phase6Live())")).toBeGreaterThan(-1);
      expect(source.indexOf("if (!phase6Live())")).toBeLessThan(source.indexOf("loadPlatformActor()"));
      expect(source).toContain("forbidden()");
    }
    expect(readFileSync(resolve(process.cwd(), "next.config.ts"), "utf8")).toContain("authInterrupts: true");
    expect(existsSync(resolve(process.cwd(), "src/app/forbidden.tsx"))).toBe(true);
    const feature = readFileSync(resolve(process.cwd(), "src/components/workspace/live/admin-money-shell.tsx"), "utf8");
    expect(feature).toContain("Billing is not enabled");
    expect(feature).toContain("if (!enabled || !authorized");
    expect(feature).not.toMatch(/workspace-fixtures|fixture-workspace/);
  });

  it("removes stale admin money fixture arms without touching coach or affiliate-role money", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/(workspace)/[role]/[[...screen]]/page.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "src/components/workspace/workspace-screens.tsx"))).toBe(false);
  });

  it("renders affirmative admin money copy only behind exact receipt checks", () => {
    const feature = ["tiers", "billing", "billing-costs", "corrections", "affiliates"]
      .map((surface) => readFileSync(resolve(process.cwd(), `src/components/workspace/live/admin-money-${surface}.tsx`), "utf8"))
      .join("\n");
    expect(feature).toContain("typeof result?.priceVersionId");
    expect(feature).toContain("typeof result?.decisionId");
    expect(feature).toContain('payout?.state !== "approved_for_payout"');
    expect(feature).toContain('payout?.state !== "sent"');
    expect(feature).toContain('return "margin" in view');
    expect(feature).toContain("This records an external payout; no transfer was made by SetterFi.");
  });
});
// End Phase 6
