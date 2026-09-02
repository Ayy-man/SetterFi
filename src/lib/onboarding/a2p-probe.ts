/**
 * Honest A2P probe scheduling and terminal-state reduction.
 *
 * The caller can supply only the configured target digest. The provisioning driver is solely
 * responsible for reading the plaintext owned target at call time, so a lead number cannot enter
 * this lifecycle or its persisted receipt.
 */

import { GhlProvisioningError } from "@/lib/integrations/ghl";
import { phase8AlertRuleEventsLive, type EnvironmentSource } from "@/lib/env-contract";
import {
  a2pClearedEvent,
  createLiveChannelNotificationPort,
  type ChannelNotificationPort,
} from "@/lib/notifications/channel-events";
import type { OnboardingEvidenceRepository } from "@/lib/repositories/onboarding-evidence";

import { a2pRegistrationDay } from "./a2p-clock";
import type { A2pProbeResult, StepAttempt, StepOutcome } from "./contracts";
import type { GhlProvisioningDriver, ProvisioningContext } from "./provider-contracts";

export const ONBOARDING_ALERT_KEYS = [
  "onboarding.stalled_system:platform",
  "onboarding.stalled_coach:tenant",
  "onboarding.stalled_external:platform",
  "onboarding.stalled_external:tenant",
  "onboarding.paying_not_live:tenant",
] as const;

export type OnboardingAlertKey = (typeof ONBOARDING_ALERT_KEYS)[number];

export type A2pProbeCandidate = {
  tenantId: string;
  state: "awaiting_provider" | "done" | "blocked";
  submittedAt: string;
  targetHash: string;
  nextProbeAt: string;
  terminalReceiptAt: string | null;
};

export type A2pRegistrationState =
  | {
      kind: "registering";
      label: string;
      detail: "Carrier review usually takes 2–3 weeks.";
      day: number;
      stalled: boolean;
      showTimer: true;
      canRetry: false;
    }
  | {
      kind: "permanently_blocked";
      label: "Text messages aren't available for this account.";
      detail: string;
      showTimer: false;
      canRetry: false;
    };

function instant(value: string, code: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(code);
  return parsed;
}

export function registrationDay(submittedAt: string, now: number) {
  // Validated here so a malformed receipt still fails loudly on this path; the
  // arithmetic itself belongs to the shared clock in a2p-clock.
  instant(submittedAt, "A2P_SUBMISSION_TIMESTAMP_INVALID");
  const day = a2pRegistrationDay(submittedAt, now);
  if (day === null) throw new Error("A2P_SUBMISSION_TIMESTAMP_INVALID");
  return day;
}

export function registrationState(input: {
  submittedAt: string;
  now: number;
  terminalRefusal?: { safeMessage: string } | null;
}): A2pRegistrationState {
  if (input.terminalRefusal) {
    return {
      kind: "permanently_blocked",
      label: "Text messages aren't available for this account.",
      detail: input.terminalRefusal.safeMessage,
      showTimer: false,
      canRetry: false,
    };
  }
  const day = registrationDay(input.submittedAt, input.now);
  return {
    kind: "registering",
    label: `Registering · day ${day}`,
    detail: "Carrier review usually takes 2–3 weeks.",
    day,
    stalled: day >= 21,
    showTimer: true,
    canRetry: false,
  };
}

export function selectDueA2pProbes(candidates: readonly A2pProbeCandidate[], now: number) {
  return candidates.filter((candidate) =>
    candidate.state === "awaiting_provider"
    && candidate.terminalReceiptAt === null
    && instant(candidate.nextProbeAt, "A2P_NEXT_PROBE_TIMESTAMP_INVALID") <= now
    && /^[0-9a-f]{64}$/.test(candidate.targetHash));
}

export function probeKey(tenantId: string, now: number) {
  const date = new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("A2P_PROBE_TIME_INVALID");
  return `${tenantId}:sms_live:${date.toISOString().slice(0, 10)}`;
}

export function externalStallEvidence(input: {
  submittedAt: string;
  now: number;
  alreadyFlagged: boolean;
}): { emit: boolean; keys: readonly OnboardingAlertKey[] } {
  const emit = registrationDay(input.submittedAt, input.now) >= 21 && !input.alreadyFlagged;
  return {
    emit,
    keys: emit
      ? ["onboarding.stalled_external:platform", "onboarding.stalled_external:tenant"]
      : [],
  };
}

export type A2pProbeDependencies = {
  driver: GhlProvisioningDriver;
  evidence: Pick<OnboardingEvidenceRepository, "recordA2pProbeReceipt">;
  notifications?: ChannelNotificationPort;
  environment?: EnvironmentSource;
};

function context(attempt: StepAttempt): ProvisioningContext {
  return {
    tenantId: attempt.tenantId,
    stepKey: attempt.stepKey,
    idempotencyKey: attempt.idempotencyKey,
  };
}

function providerReference(result: A2pProbeResult) {
  if (result.kind === "delivered") return result.providerReference;
  if (result.kind === "terminal_refusal") {
    // Plan 01 requires a stable terminal reference, while Plan 02 exposes only the normalized
    // carrier code. Persisting that code as the reference preserves replay identity without raw data.
    return result.code;
  }
  return null;
}

export async function executeA2pProbe(
  attempt: StepAttempt,
  input: { targetHash: string; probeKey: string },
  dependencies: A2pProbeDependencies,
): Promise<StepOutcome> {
  if (attempt.stepKey !== "sms_live") throw new Error("A2P_PROBE_STEP_INVALID");
  if (!/^[0-9a-f]{64}$/.test(input.targetHash)) {
    return {
      kind: "blocked",
      code: "A2P_PROBE_TARGET_HASH_INVALID",
      safeMessage: "The owned probe target configuration requires review.",
    };
  }
  let result: A2pProbeResult;
  try {
    result = await dependencies.driver.probeOwnedTarget(context(attempt), input);
  } catch (error) {
    if (!(error instanceof GhlProvisioningError)) throw error;
    return {
      kind: error.classification === "retryable" ? "retryable_failure" : "blocked",
      code: error.code,
      safeMessage: error.classification === "retryable"
        ? "The owned-target probe will be tried again."
        : "The owned probe target configuration requires review.",
    };
  }

  const receiptResult = result.kind === "terminal_refusal" ? "terminal_rejection" : result.kind;
  const receipt = await dependencies.evidence.recordA2pProbeReceipt({
    tenantId: attempt.tenantId,
    probeKey: input.probeKey,
    targetHash: result.targetHash,
    result: receiptResult,
    providerReference: providerReference(result),
    providerCode: result.kind === "delivered" ? "DELIVERED" : result.code,
    observedAt: result.probedAt,
  });
  const externalRef = {
    receiptId: receipt.receiptId,
    probeKey: input.probeKey,
    result: receiptResult,
    targetHash: result.targetHash,
  };
  if (result.kind === "delivered") {
    if (phase8AlertRuleEventsLive(dependencies.environment)) {
      const notifications = dependencies.notifications ?? createLiveChannelNotificationPort();
      await notifications.emit(a2pClearedEvent({
        tenantId: attempt.tenantId,
        probeReceiptId: receipt.receiptId,
        occurredAt: result.probedAt,
        isTest: attempt.isDemo,
      }));
    }
    return { kind: "done", externalRef };
  }
  if (result.kind === "terminal_refusal") {
    return {
      kind: "blocked",
      code: result.code,
      safeMessage: result.safeMessage,
    };
  }
  return { kind: "awaiting_provider", party: "carrier", externalRef };
}
