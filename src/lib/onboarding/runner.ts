/**
 * Provider-neutral execution for one durable provisioning cycle.
 *
 * Executors return normalized outcomes and never see a persistence client. Claims, attempt-token
 * checks, and legal transitions remain in Plan 05-01's RPCs; this module only schedules independent
 * ready work, selects the demo arm first, and commits each outcome through that repository.
 */

import { randomUUID } from "node:crypto";

import { phase8AlertRuleEventsLive, type EnvironmentSource } from "@/lib/env-contract";
import {
  createLiveChannelNotificationPort,
  onboardingStalledEvent,
  type ChannelNotificationPort,
} from "@/lib/notifications/channel-events";
import type {
  StepAttempt,
  StepExecutor,
  StepOutcome,
  ProvisioningStep,
} from "@/lib/onboarding/contracts";
import {
  PROVISIONING_STEP_REGISTRY,
  selectRunnableProvisioningSteps,
  type ProvisioningStepDefinition,
} from "@/lib/onboarding/steps";
import type {
  ClaimedProvisioningStep,
  OnboardingStepRepository,
  ProvisioningCommitResult,
  ProvisioningStepSnapshot,
} from "@/lib/repositories/onboarding-steps";

export const ONBOARDING_ALERT_EVIDENCE_KEYS = [
  "onboarding.stalled_system:platform",
  "onboarding.stalled_coach:tenant",
  "onboarding.stalled_external:platform",
  "onboarding.stalled_external:tenant",
  "onboarding.paying_not_live:tenant",
] as const;

export type OnboardingAlertEvidenceKey = (typeof ONBOARDING_ALERT_EVIDENCE_KEYS)[number];

export type StepExecutorArms = {
  mockArm: StepExecutor;
  driverSelection: () => StepExecutor;
};

export type StepExecutorRegistry = Readonly<
  Partial<Record<ProvisioningStep, StepExecutorArms>>
>;

export type ProvisioningCycleResult = {
  stepKey: ProvisioningStep;
  kind: "committed" | "stale" | "not_claimed" | "executor_missing";
  outcome?: StepOutcome["kind"];
  exhausted?: boolean;
};

const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000] as const;

function stableJitterMs(idempotencyKey: string) {
  let hash = 2_166_136_261;
  for (const character of idempotencyKey) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 30_001;
}

export function boundedBackoffAt(
  idempotencyKey: string,
  attempt: number,
  now: Date,
) {
  const delay = BACKOFF_MS[Math.min(Math.max(attempt - 1, 0), BACKOFF_MS.length - 1)];
  return new Date(now.getTime() + delay + stableJitterMs(idempotencyKey)).toISOString();
}

/** Demo routing precedes driver selection, so a real selector cannot override tenant custody. */
export function resolveStepExecutor(attempt: StepAttempt, arms: StepExecutorArms) {
  return attempt.isDemo ? arms.mockArm : arms.driverSelection();
}

export function withOnboardingAlertEvidence(
  externalRef: Record<string, unknown> | undefined,
  key: OnboardingAlertEvidenceKey,
) {
  if (!ONBOARDING_ALERT_EVIDENCE_KEYS.includes(key)) {
    throw new Error("ONBOARDING_ALERT_EVIDENCE_KEY_UNREGISTERED");
  }
  return { ...externalRef, alert_evidence: [key] };
}

function runnableSnapshots(
  snapshots: readonly ProvisioningStepSnapshot[],
  definitions: readonly ProvisioningStepDefinition[],
  now: Date,
) {
  const byStep = new Map(snapshots.map((snapshot) => [snapshot.stepKey, snapshot]));
  const states = Object.fromEntries(snapshots.map((snapshot) => {
    const definition = definitions.find((candidate) => candidate.key === snapshot.stepKey)!;
    const retryDue = snapshot.state === "failed"
      && definition.retryClass === "automatic"
      && snapshot.attempts < definition.maxAttempts
      && Date.parse(snapshot.nextAttemptAt) <= now.getTime();
    const leaseExpired = snapshot.state === "running"
      && snapshot.leaseExpiresAt !== null
      && Date.parse(snapshot.leaseExpiresAt) <= now.getTime();
    return [snapshot.stepKey, retryDue || leaseExpired ? "pending" : snapshot.state];
  }));
  return selectRunnableProvisioningSteps(states, definitions).map((step) => byStep.get(step)!);
}

async function commitOutcome(
  repository: OnboardingStepRepository,
  attempt: ClaimedProvisioningStep,
  outcome: StepOutcome,
  definition: ProvisioningStepDefinition,
  now: Date,
): Promise<{ commit: ProvisioningCommitResult; exhausted?: boolean }> {
  if (outcome.kind === "done") {
    return {
      commit: await repository.completeStep({
        tenantId: attempt.tenantId,
        stepKey: attempt.stepKey,
        attemptId: attempt.attemptId,
        externalRef: outcome.externalRef,
      }),
    };
  }
  if (outcome.kind === "retryable_failure") {
    const exhausted = definition.retryClass !== "automatic"
      || attempt.attempts >= definition.maxAttempts;
    const externalRef = exhausted
      ? withOnboardingAlertEvidence(undefined, "onboarding.stalled_system:platform")
      : undefined;
    return {
      commit: await repository.failStep({
        tenantId: attempt.tenantId,
        stepKey: attempt.stepKey,
        attemptId: attempt.attemptId,
        errorCode: outcome.code,
        errorMessage: outcome.safeMessage,
        nextAttemptAt: boundedBackoffAt(attempt.idempotencyKey, attempt.attempts, now),
        externalRef,
      }),
      exhausted,
    };
  }
  if (outcome.kind === "blocked") {
    return {
      commit: await repository.transitionStep({
        tenantId: attempt.tenantId,
        stepKey: attempt.stepKey,
        attemptId: attempt.attemptId,
        targetState: "blocked",
        errorCode: outcome.code,
        errorMessage: outcome.safeMessage,
        blockedReason: outcome.safeMessage,
      }),
    };
  }
  return {
    commit: await repository.transitionStep({
      tenantId: attempt.tenantId,
      stepKey: attempt.stepKey,
      attemptId: attempt.attemptId,
      targetState: outcome.kind,
      awaitingParty: outcome.kind === "awaiting_provider" ? outcome.party : undefined,
      externalRef: "code" in outcome
        ? { awaiting_code: outcome.code }
        : outcome.externalRef,
    }),
  };
}

async function runClaimedStep({
  tenantId,
  isDemo,
  snapshot,
  definition,
  arms,
  repository,
  now,
  leaseSeconds,
  notifications,
  environment,
}: {
  tenantId: string;
  isDemo: boolean;
  snapshot: ProvisioningStepSnapshot;
  definition: ProvisioningStepDefinition;
  arms: StepExecutorArms | undefined;
  repository: OnboardingStepRepository;
  now: Date;
  leaseSeconds: number;
  notifications: ChannelNotificationPort | undefined;
  environment: EnvironmentSource | undefined;
}): Promise<ProvisioningCycleResult> {
  if (!arms) return { stepKey: snapshot.stepKey, kind: "executor_missing" };
  const claim = await repository.claimStep({
    tenantId,
    stepKey: snapshot.stepKey,
    attemptId: randomUUID(),
    leaseSeconds,
  });
  if (!claim) return { stepKey: snapshot.stepKey, kind: "not_claimed" };
  const attempt: StepAttempt = {
    tenantId: claim.tenantId,
    stepKey: claim.stepKey,
    attemptId: claim.attemptId,
    idempotencyKey: claim.idempotencyKey,
    isDemo,
  };
  let outcome: StepOutcome;
  try {
    outcome = await resolveStepExecutor(attempt, arms)(attempt);
  } catch (error) {
    if (
      error instanceof Error
      && /^(?:PHASE3|PHASE4)_[A-Z0-9_]+_MISSING$/.test(error.message)
    ) throw error;
    outcome = {
      kind: "retryable_failure",
      code: "STEP_EXECUTOR_UNEXPECTED",
      safeMessage: "The setup worker could not finish this step.",
    };
  }
  const committed = await commitOutcome(repository, claim, outcome, definition, now);
  if (
    committed.commit === "committed"
    && committed.exhausted === true
    && phase8AlertRuleEventsLive(environment)
  ) {
    const events = notifications ?? createLiveChannelNotificationPort();
    await events.emit(onboardingStalledEvent({
      tenantId: claim.tenantId,
      stepKey: claim.stepKey,
      attemptId: claim.attemptId,
      occurredAt: now.toISOString(),
      isTest: isDemo,
    }));
  }
  return {
    stepKey: snapshot.stepKey,
    kind: committed.commit,
    outcome: outcome.kind,
    exhausted: committed.exhausted,
  };
}

async function restNonExecutorSteps(
  snapshots: readonly ProvisioningStepSnapshot[],
  definitions: readonly ProvisioningStepDefinition[],
  repository: OnboardingStepRepository,
) {
  const states = new Map(snapshots.map((snapshot) => [snapshot.stepKey, snapshot.state]));
  await Promise.all(definitions.filter((definition) =>
    definition.executorSymbol === null
      && definition.restingState
      && states.get(definition.key) === "pending"
      && definition.dependencies.every((dependency) => states.get(dependency) === "done")
  ).map((definition) => repository.transitionStep({
    tenantId: snapshots.find((snapshot) => snapshot.stepKey === definition.key)!.tenantId,
    stepKey: definition.key,
    attemptId: null,
    targetState: definition.restingState!,
    externalRef: definition.restingCode ? { awaiting_code: definition.restingCode } : undefined,
  })));
}

export async function runProvisioningCycle({
  tenantId,
  isDemo,
  executors,
  repository,
  now = new Date(),
  leaseSeconds = 900,
  registry = PROVISIONING_STEP_REGISTRY,
  notifications,
  environment,
}: {
  tenantId: string;
  isDemo: boolean;
  executors: StepExecutorRegistry;
  repository: OnboardingStepRepository;
  now?: Date;
  leaseSeconds?: number;
  registry?: readonly ProvisioningStepDefinition[];
  notifications?: ChannelNotificationPort;
  environment?: EnvironmentSource;
}): Promise<ProvisioningCycleResult[]> {
  const snapshots = await repository.listStepSnapshots(tenantId);
  if (snapshots.some((snapshot) => snapshot.tenantId !== tenantId)) {
    throw new Error("PROVISIONING_STEP_TENANT_MISMATCH");
  }
  await restNonExecutorSteps(snapshots, registry, repository);
  const runnable = runnableSnapshots(snapshots, registry, now);
  return Promise.all(runnable.map((snapshot) => runClaimedStep({
    tenantId,
    isDemo,
    snapshot,
    definition: registry.find((candidate) => candidate.key === snapshot.stepKey)!,
    arms: executors[snapshot.stepKey],
    repository,
    now,
    leaseSeconds,
    notifications,
    environment,
  })));
}
