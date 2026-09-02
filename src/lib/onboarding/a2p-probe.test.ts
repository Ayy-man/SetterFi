import { describe, expect, it, vi } from "vitest";

import {
  GhlProvisioningError,
  createMockGhlProvisioningDriver,
  createRealGhlProvisioningDriver,
} from "@/lib/integrations/ghl";

import type { A2pProbeResult, StepAttempt } from "./contracts";
import {
  ONBOARDING_ALERT_KEYS,
  executeA2pProbe,
  externalStallEvidence,
  probeKey,
  registrationState,
  selectDueA2pProbes,
} from "./a2p-probe";

const SUBMITTED = "2026-08-01T12:00:00.000Z";
const day = (value: number) => Date.parse(SUBMITTED) + (value - 1) * 86_400_000;
const TARGET_HASH = "a".repeat(64);

const attempt: StepAttempt = {
  tenantId: "tenant-synthetic",
  stepKey: "sms_live",
  attemptId: "attempt-synthetic",
  idempotencyKey: "tenant-synthetic:sms_live",
  isDemo: true,
};

function receiptPort() {
  const calls: unknown[] = [];
  return {
    calls,
    evidence: {
      async recordA2pProbeReceipt(input: unknown) {
        calls.push(input);
        return { receiptId: "receipt-synthetic" };
      },
    },
  };
}

function resultDriver(result: A2pProbeResult) {
  return {
    ...createMockGhlProvisioningDriver(),
    probeOwnedTarget: vi.fn(async () => result),
  };
}

describe("A2P registration lifecycle", () => {
  it.each([1, 20, 21, 22])("renders honest elapsed registration day %i", (currentDay) => {
    expect(registrationState({ submittedAt: SUBMITTED, now: day(currentDay) })).toEqual({
      kind: "registering",
      label: `Registering · day ${currentDay}`,
      detail: "Carrier review usually takes 2–3 weeks.",
      day: currentDay,
      stalled: currentDay >= 21,
      showTimer: true,
      canRetry: false,
    });
  });

  it("emits the existing external-stall keys once from day 21", () => {
    expect(externalStallEvidence({ submittedAt: SUBMITTED, now: day(20), alreadyFlagged: false }))
      .toEqual({ emit: false, keys: [] });
    expect(externalStallEvidence({ submittedAt: SUBMITTED, now: day(21), alreadyFlagged: false }))
      .toEqual({
        emit: true,
        keys: ["onboarding.stalled_external:platform", "onboarding.stalled_external:tenant"],
      });
    expect(externalStallEvidence({ submittedAt: SUBMITTED, now: day(22), alreadyFlagged: true }))
      .toEqual({ emit: false, keys: [] });
    expect(ONBOARDING_ALERT_KEYS).toEqual([
      "onboarding.stalled_system:platform",
      "onboarding.stalled_coach:tenant",
      "onboarding.stalled_external:platform",
      "onboarding.stalled_external:tenant",
      "onboarding.paying_not_live:tenant",
    ]);
  });

  it("selects only due awaiting-provider rows with configured digests", () => {
    const base = {
      tenantId: "tenant-synthetic",
      state: "awaiting_provider" as const,
      submittedAt: SUBMITTED,
      targetHash: TARGET_HASH,
      nextProbeAt: "2026-08-17T11:00:00.000Z",
      terminalReceiptAt: null,
    };
    expect(selectDueA2pProbes([
      base,
      { ...base, tenantId: "done", state: "done" },
      { ...base, tenantId: "terminal", terminalReceiptAt: "2026-08-17T10:00:00.000Z" },
      { ...base, tenantId: "future", nextProbeAt: "2026-08-18T11:00:00.000Z" },
      { ...base, tenantId: "plaintext", targetHash: "forbidden" },
    ], Date.parse("2026-08-17T12:00:00.000Z"))).toEqual([base]);
  });

  it("uses a persisted daily probe key so duplicate job delivery replays safely", () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    expect(probeKey("tenant-synthetic", now)).toBe("tenant-synthetic:sms_live:2026-08-17");
    expect(probeKey("tenant-synthetic", now + 60_000)).toBe(probeKey("tenant-synthetic", now));
  });

  it("records delivered evidence and completes sms_live", async () => {
    const receipt = receiptPort();
    const result: A2pProbeResult = {
      kind: "delivered",
      probedAt: "2026-08-17T12:00:00.000Z",
      providerReference: "provider-reference-synthetic",
      targetHash: TARGET_HASH,
    };
    await expect(executeA2pProbe(attempt, {
      targetHash: TARGET_HASH,
      probeKey: "probe-synthetic",
    }, { driver: resultDriver(result), evidence: receipt.evidence })).resolves.toMatchObject({
      kind: "done",
      externalRef: { receiptId: "receipt-synthetic", result: "delivered" },
    });
    expect(receipt.calls).toHaveLength(1);
  });

  it("emits A2P cleared only after the carrier-delivered receipt is durable", async () => {
    const receipt = receiptPort();
    const emit = vi.fn(async () => ({ notificationIds: ["notification-1"] }));
    const result: A2pProbeResult = {
      kind: "delivered",
      probedAt: "2026-08-17T12:00:00.000Z",
      providerReference: "provider-reference-synthetic",
      targetHash: TARGET_HASH,
    };
    await executeA2pProbe(attempt, {
      targetHash: TARGET_HASH,
      probeKey: "probe-synthetic",
    }, {
      driver: resultDriver(result),
      evidence: receipt.evidence,
      notifications: { emit },
      environment: {
        SETTERFI_PHASE8_LIVE: "true",
        SETTERFI_PHASE8_ALERTS_LIVE: "true",
        SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE: "true",
      },
    });
    expect(receipt.calls).toHaveLength(1);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: "onboarding.a2p_cleared",
      probeReceiptId: "receipt-synthetic",
    }));
  });

  it.each(["inconclusive", "retryable_failure"] as const)(
    "keeps %s probe evidence awaiting provider",
    async (kind) => {
      const receipt = receiptPort();
      const result: A2pProbeResult = {
        kind,
        probedAt: "2026-08-17T12:00:00.000Z",
        code: `SYNTHETIC_${kind.toUpperCase()}`,
        targetHash: TARGET_HASH,
      };
      await expect(executeA2pProbe(attempt, {
        targetHash: TARGET_HASH,
        probeKey: "probe-synthetic",
      }, { driver: resultDriver(result), evidence: receipt.evidence })).resolves.toMatchObject({
        kind: "awaiting_provider",
        party: "carrier",
        externalRef: { result: kind },
      });
    },
  );

  it("permanently blocks terminal refusal with no retry or timer affordance", async () => {
    const receipt = receiptPort();
    const result: A2pProbeResult = {
      kind: "terminal_refusal",
      probedAt: "2026-08-17T12:00:00.000Z",
      code: "CARRIER_TERMINAL_SYNTHETIC",
      safeMessage: "Synthetic permanent carrier refusal.",
      targetHash: TARGET_HASH,
    };
    await expect(executeA2pProbe(attempt, {
      targetHash: TARGET_HASH,
      probeKey: "probe-synthetic",
    }, { driver: resultDriver(result), evidence: receipt.evidence })).resolves.toEqual({
      kind: "blocked",
      code: "CARRIER_TERMINAL_SYNTHETIC",
      safeMessage: "Synthetic permanent carrier refusal.",
    });
    expect(registrationState({
      submittedAt: SUBMITTED,
      now: day(22),
      terminalRefusal: { safeMessage: "Synthetic permanent carrier refusal." },
    })).toEqual({
      kind: "permanently_blocked",
      label: "Text messages aren't available for this account.",
      detail: "Synthetic permanent carrier refusal.",
      showTimer: false,
      canRetry: false,
    });
    expect(receipt.calls).toEqual([expect.objectContaining({
      result: "terminal_rejection",
      providerReference: "CARRIER_TERMINAL_SYNTHETIC",
    })]);
  });

  it("refuses a target mismatch before any receipt is persisted", async () => {
    const receipt = receiptPort();
    const driver = createRealGhlProvisioningDriver({
      agencyAccessToken: "configured",
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, {
      environment: {
        SETTERFI_A2P_PROBE_TARGET: "owned-target-synthetic",
        SETTERFI_A2P_PROBE_TARGET_HASH: TARGET_HASH,
      },
    });
    await expect(executeA2pProbe(attempt, {
      targetHash: "b".repeat(64),
      probeKey: "probe-synthetic",
    }, { driver, evidence: receipt.evidence })).resolves.toMatchObject({
      kind: "blocked",
      code: "GHL_A2P_PROBE_TARGET_MISMATCH",
    });
    expect(receipt.calls).toEqual([]);
  });

  it("classifies provider retry errors without converting them into delivery evidence", async () => {
    const receipt = receiptPort();
    const driver = {
      ...createMockGhlProvisioningDriver(),
      probeOwnedTarget: async (): Promise<A2pProbeResult> => {
        throw new GhlProvisioningError("PROBE_RETRYABLE_SYNTHETIC", "retryable");
      },
    };
    await expect(executeA2pProbe(attempt, {
      targetHash: TARGET_HASH,
      probeKey: "probe-synthetic",
    }, { driver, evidence: receipt.evidence })).resolves.toEqual({
      kind: "retryable_failure",
      code: "PROBE_RETRYABLE_SYNTHETIC",
      safeMessage: "The owned-target probe will be tried again.",
    });
    expect(receipt.calls).toEqual([]);
  });
});
