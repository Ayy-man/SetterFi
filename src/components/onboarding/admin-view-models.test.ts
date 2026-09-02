import { describe, expect, it } from "vitest";

import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import type { ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import {
  deriveAdminProvisioningView,
  loggedActionReceipt,
} from "./admin-view-models";

const NOW = new Date("2026-08-18T12:00:00.000Z");

function row(overrides: Partial<ProvisioningTrackerRow> = {}): ProvisioningTrackerRow {
  return {
    signupIntentId: "intent-1",
    tenantId: "tenant-1",
    businessName: "Synthetic Funding Co",
    signupState: "completed",
    currentStep: "calendar_connect",
    state: "awaiting_coach",
    attempts: 1,
    errorCode: null,
    blockingParty: "coach",
    blockingProvider: null,
    stalledSince: "2026-08-18T11:00:00.000Z",
    isDemo: false,
    contentScreenId: null,
    contentScreenState: null,
    ...overrides,
  };
}

function view(candidate: ProvisioningTrackerRow) {
  return deriveAdminProvisioningView({ enabled: true, authorized: true, rows: [candidate], now: NOW });
}

describe("Phase 5 admin provisioning view model", () => {
  it("keeps tenantless signup failures visible without inventing a tenant", () => {
    const result = view(row({ tenantId: null, businessName: null, currentStep: null, state: "failed", blockingParty: "system" }));
    expect(result.groups.platform[0]).toMatchObject({
      tenantId: null,
      title: "Unnamed signup",
      stepLabel: "Tenant creation",
      actions: [],
    });
  });

  it.each([
    ["coach", "2026-08-15T11:59:59.000Z", true],
    ["platform", "2026-08-18T11:29:59.000Z", true],
    ["system", "2026-08-18T11:30:01.000Z", false],
  ] as const)("groups %s work and applies its clock", (blockingParty, stalledSince, stalled) => {
    const result = view(row({ blockingParty, stalledSince, state: blockingParty === "coach" ? "awaiting_coach" : "running" }));
    const group = blockingParty === "coach" ? result.groups.coach : result.groups.platform;
    expect(group[0].stalled).toBe(stalled);
  });

  it("uses provider clocks without mixing provider work into platform work", () => {
    const provider = view(row({
      currentStep: "meta_connect",
      state: "awaiting_provider",
      blockingParty: "provider",
      blockingProvider: "meta",
      stalledSince: "2026-08-15T11:59:59.000Z",
    }));
    expect(provider.groups.provider[0]).toMatchObject({ providerLabel: "meta", stalled: true });
    expect(provider.groups.platform).toHaveLength(0);
  });

  it("returns an honest flag-off descriptor with no fixture rows", () => {
    const result = deriveAdminProvisioningView({ enabled: false, authorized: true, rows: [row()] });
    expect(result.rows).toHaveLength(0);
    expect(result.emptyMessage).toContain("not enabled");
    expect(result.emptyMessage).toContain("No live state is inferred from fixtures");
  });

  it("makes a terminal carrier rejection permanently blocked with no progress language or retry", () => {
    const terminal = view(row({
      currentStep: "a2p_campaign",
      state: "blocked",
      blockingParty: "provider",
      blockingProvider: "carrier",
      stalledSince: "2026-07-01T00:00:00.000Z",
    })).rows[0];
    const serialized = JSON.stringify(terminal);
    expect(terminal).toMatchObject({ stateLabel: "Permanently blocked", terminal: true, stalledLabel: null, actions: [] });
    expect(serialized).not.toMatch(/done|pending|timer|retry/i);
  });

  it("keeps offer review platform-owned and distinct", () => {
    const offer = view(row({ currentStep: "offer_layer", state: "awaiting_platform", blockingParty: "platform" })).rows[0];
    expect(offer.group).toBe("platform");
    expect(offer.stateLabel).toBe("Offer held for platform review");
    expect(offer.detail).toContain("platform must clear the offer");
  });

  it("shows the Brain precondition as first-class platform state", () => {
    const result = view(row({
      currentStep: "go_live",
      state: "awaiting_platform",
      blockingParty: "platform",
      errorCode: "platform_brain_publish_pending",
    }));
    expect(result.brainMissing).toBe(true);
    expect(result.rows[0].safeError).toBe("platform_brain_publish_pending");
  });

  it("uses exact honest A2P copy without percentages or predicted dates", () => {
    const registering = view(row({
      currentStep: "a2p_campaign",
      state: "awaiting_provider",
      blockingParty: "provider",
      blockingProvider: "carrier",
      stalledSince: "2026-08-13T12:00:00.000Z",
    })).rows[0];
    expect(registering.stateLabel).toBe("Registering · day 6");
    expect(registering.detail).toContain("2–3 weeks");
    expect(`${registering.stateLabel} ${registering.detail}`).not.toMatch(/%|predicted|all set|1–2 weeks/i);
  });

  it("adds platform follow-up only after day 21 and never turns carrier review into completion", () => {
    const day21 = view(row({
      currentStep: "sms_live",
      state: "awaiting_provider",
      blockingParty: "provider",
      blockingProvider: "carrier",
      stalledSince: "2026-07-29T12:00:00.000Z",
    })).rows[0];
    const afterDay21 = view(row({
      currentStep: "sms_live",
      state: "awaiting_provider",
      blockingParty: "provider",
      blockingProvider: "carrier",
      stalledSince: "2026-07-28T12:00:00.000Z",
    })).rows[0];
    expect(day21.stateLabel).toBe("Registering · day 21");
    expect(day21.stalledLabel).toBeNull();
    expect(afterDay21).toMatchObject({ stateLabel: "Registering · day 22", stalled: true, stalledLabel: "Carrier window passed" });
    expect(afterDay21.stateLabel).not.toMatch(/done|complete/i);
  });

  it("returns no rows when the platform role was denied", () => {
    const result = deriveAdminProvisioningView({ enabled: true, authorized: false, rows: [row()] });
    expect(result.rows).toHaveLength(0);
    expect(result.emptyMessage).toContain("cannot view provisioning");
  });

  it("labels demo rows, excludes them from the real aggregate, and keeps tenantless classification honest", () => {
    const result = deriveAdminProvisioningView({
      enabled: true,
      authorized: true,
      now: NOW,
      rows: [
        row({ signupIntentId: "real", isDemo: false }),
        row({ signupIntentId: "demo", isDemo: true }),
        row({ signupIntentId: "tenantless", tenantId: null, isDemo: null }),
      ],
    });
    expect(result).toMatchObject({ realRowCount: 1, demoRowCount: 1 });
    expect(result.rows.map((candidate) => candidate.dataClassification)).toEqual([
      "Real", "Demo", "Not available",
    ]);
  });

  it("offers content confirmation only against an eligible persisted screen id", () => {
    const eligible = view(row({
      currentStep: "a2p_campaign",
      state: "awaiting_platform",
      blockingParty: "platform",
      contentScreenId: "screen-1",
      contentScreenState: "awaiting_admin",
    })).rows[0];
    expect(eligible.actions).toContainEqual({
      kind: "confirm_content",
      label: "Confirm content",
      actionKey: "onboarding.a2p_filing_confirmed",
      tenantId: "tenant-1",
      screenId: "screen-1",
    });
    expect(view(row({ contentScreenId: "screen-1", contentScreenState: "flagged" })).rows[0].actions)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: "confirm_content" })]));
  });

  it("renders Logged only from a complete registry-backed receipt", () => {
    expect(loggedActionReceipt({ actionKey: "onboarding.step_retried" })).toBeNull();
    expect(loggedActionReceipt({ auditId: "", actionKey: "onboarding.step_retried" })).toBeNull();
    expect(loggedActionReceipt({ auditId: "audit-1", actionKey: "invented.action" })).toBeNull();
    expect(loggedActionReceipt({ auditId: "audit-1", actionKey: "onboarding.step_retried" })).toMatchObject({
      microcopy: "Retry logged",
      ariaLabel: "Provisioning retry recorded in the audit log",
    });
  });

  /**
   * Provisioning read "No wait recorded" on every waiting row while the tracker held the clock,
   * because a Postgres timestamptz carries six fractional digits and the day counter refused more
   * than three. The kit takes any precision now; this holds the whole path honest, from the
   * tracker column through to a countable number of days.
   */
  it("hands the day counter a start time it can count from", () => {
    const waiting = view(row({ stalledSince: "2026-08-24T19:42:59.815143+00:00" })).rows[0].waitingSince;
    expect(waiting).toBe("2026-08-24T19:42:59.815143+00:00");
    expect(elapsedWorkspaceDays(waiting!, new Date("2026-08-29T12:00:00.000Z"))).toBe(5);
    expect(view(row({ stalledSince: null })).rows[0].waitingSince).toBeNull();
  });

  it("offers retry and unblock only for legal non-terminal states", () => {
    expect(view(row({ state: "failed" })).rows[0].actions[0]).toMatchObject({ kind: "retry", actionKey: "onboarding.step_retried" });
    expect(view(row({ state: "blocked", currentStep: "calendar_connect" })).rows[0].actions[0]).toMatchObject({ kind: "unblock", actionKey: "onboarding.step_unblocked", requiresReason: true });
    expect(view(row({ state: "running" })).rows[0].actions).toEqual([]);
  });
});
