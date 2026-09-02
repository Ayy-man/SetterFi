import { describe, expect, it, vi } from "vitest";

import type { ProvisioningState, ProvisioningStep, StepOutcome } from "./contracts";
import {
  ONBOARDING_ALERT_EVIDENCE_KEYS,
  boundedBackoffAt,
  runProvisioningCycle,
  withOnboardingAlertEvidence,
  type StepExecutorArms,
} from "./runner";
import { PROVISIONING_STEP_REGISTRY } from "./steps";
import type {
  ClaimedProvisioningStep,
  FailProvisioningStepInput,
  OnboardingStepRepository,
  ProvisioningStepSnapshot,
  TransitionProvisioningStepInput,
} from "../repositories/onboarding-steps";

const TENANT = "51000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-08-17T12:00:00.000Z");

type MemoryStep = ProvisioningStepSnapshot & {
  activeAttemptId: string | null;
  externalRef?: Record<string, unknown>;
  errorCode?: string;
};

function snapshots(
  targetStates: Partial<Record<ProvisioningStep, ProvisioningState>>,
  attempts: Partial<Record<ProvisioningStep, number>> = {},
) {
  return PROVISIONING_STEP_REGISTRY.map<MemoryStep>((definition) => ({
    tenantId: TENANT,
    stepKey: definition.key,
    state: targetStates[definition.key] ?? "blocked",
    attempts: attempts[definition.key] ?? 0,
    nextAttemptAt: NOW.toISOString(),
    leaseExpiresAt: null,
    idempotencyKey: `${TENANT}:${definition.key}`,
    activeAttemptId: null,
  }));
}

function memoryRepository(initial: readonly MemoryStep[]) {
  const steps = new Map(initial.map((step) => [step.stepKey, { ...step }]));
  const claims: ClaimedProvisioningStep[] = [];
  const transitionCalls: TransitionProvisioningStepInput[] = [];
  const failCalls: FailProvisioningStepInput[] = [];

  function commit(stepKey: ProvisioningStep, attemptId: string | null) {
    const step = steps.get(stepKey)!;
    if (step.state === "running" && step.activeAttemptId !== attemptId) return "stale" as const;
    step.activeAttemptId = null;
    step.leaseExpiresAt = null;
    return "committed" as const;
  }

  const repository: OnboardingStepRepository = {
    listStepSnapshots: async () => [...steps.values()].map((step) => ({ ...step })),
    claimStep: async (input) => {
      const step = steps.get(input.stepKey)!;
      const expired = step.state === "running"
        && step.leaseExpiresAt !== null
        && Date.parse(step.leaseExpiresAt) <= NOW.getTime();
      if (!["pending", "failed"].includes(step.state) && !expired) return null;
      step.state = "running";
      step.attempts += 1;
      step.activeAttemptId = input.attemptId;
      step.leaseExpiresAt = new Date(NOW.getTime() + input.leaseSeconds * 1_000).toISOString();
      const claim = {
        tenantId: step.tenantId,
        stepKey: step.stepKey,
        attemptId: input.attemptId,
        idempotencyKey: step.idempotencyKey,
        attempts: step.attempts,
        leaseExpiresAt: step.leaseExpiresAt,
      };
      claims.push(claim);
      return claim;
    },
    completeStep: async (input) => {
      const result = commit(input.stepKey, input.attemptId);
      if (result === "committed") {
        const step = steps.get(input.stepKey)!;
        step.state = "done";
        step.externalRef = input.externalRef;
      }
      return result;
    },
    transitionStep: async (input) => {
      transitionCalls.push(input);
      const result = commit(input.stepKey, input.attemptId);
      if (result === "committed") {
        const step = steps.get(input.stepKey)!;
        step.state = input.targetState;
        step.externalRef = input.externalRef;
        step.errorCode = input.errorCode;
      }
      return result;
    },
    failStep: async (input) => {
      failCalls.push(input);
      const result = commit(input.stepKey, input.attemptId);
      if (result === "committed") {
        const step = steps.get(input.stepKey)!;
        step.state = "failed";
        step.nextAttemptAt = input.nextAttemptAt;
        step.externalRef = input.externalRef;
        step.errorCode = input.errorCode;
      }
      return result;
    },
  };
  return { repository, steps, claims, transitionCalls, failCalls };
}

function arms(outcome: StepOutcome): StepExecutorArms {
  const executor = async () => outcome;
  return { mockArm: executor, driverSelection: () => executor };
}

function targetHarness(
  target: ProvisioningStep = "ghl_location",
  state: ProvisioningState = "pending",
  attemptCount = 0,
) {
  const definition = PROVISIONING_STEP_REGISTRY.find((candidate) => candidate.key === target)!;
  const states: Partial<Record<ProvisioningStep, ProvisioningState>> = {
    account: "done",
    [target]: state,
  };
  for (const dependency of definition.dependencies) states[dependency] = "done";
  return memoryRepository(snapshots(states, { [target]: attemptCount }));
}

describe("runner scheduling", () => {
  it("lets only one concurrent worker commit a claimed attempt", async () => {
    const harness = targetHarness();
    const executors = { ghl_location: arms({ kind: "done" }) };
    const [first, second] = await Promise.all([
      runProvisioningCycle({ tenantId: TENANT, isDemo: false, executors, repository: harness.repository, now: NOW }),
      runProvisioningCycle({ tenantId: TENANT, isDemo: false, executors, repository: harness.repository, now: NOW }),
    ]);
    expect(harness.claims).toHaveLength(1);
    expect([...first, ...second].filter((result) => result.kind === "committed")).toHaveLength(1);
  });

  it("reclaims an expired lease with the same durable idempotency key", async () => {
    const harness = targetHarness("ghl_location", "running", 1);
    const step = harness.steps.get("ghl_location")!;
    step.leaseExpiresAt = new Date(NOW.getTime() - 1).toISOString();
    step.activeAttemptId = "stale-attempt";
    await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: { ghl_location: arms({ kind: "done" }) },
      repository: harness.repository,
      now: NOW,
    });
    expect(harness.claims[0]).toMatchObject({
      attempts: 2,
      idempotencyKey: `${TENANT}:ghl_location`,
    });
  });

  it("treats a stale completion as a refusal instead of overwriting the newer attempt", async () => {
    const harness = targetHarness();
    const staleArms: StepExecutorArms = {
      mockArm: async (attempt) => {
        harness.steps.get(attempt.stepKey)!.activeAttemptId = "newer-attempt";
        return { kind: "done" };
      },
      driverSelection: () => async () => ({ kind: "done" }),
    };
    const result = await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: true,
      executors: { ghl_location: staleArms },
      repository: harness.repository,
      now: NOW,
    });
    expect(result).toEqual([{ stepKey: "ghl_location", kind: "stale", outcome: "done", exhausted: undefined }]);
    expect(harness.steps.get("ghl_location")!.state).toBe("running");
  });

  it("never selects a terminal blocked step", async () => {
    const harness = targetHarness("ghl_location", "blocked");
    const result = await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: { ghl_location: arms({ kind: "done" }) },
      repository: harness.repository,
      now: NOW,
    });
    expect(result).toEqual([]);
    expect(harness.claims).toEqual([]);
  });

  it("stops with a named merged-phase prerequisite instead of disguising the missing seam", async () => {
    const harness = targetHarness("meta_connect");
    const missingSeam: StepExecutorArms = {
      mockArm: async () => {
        throw new Error("PHASE4_META_CONNECT_SEAM_MISSING");
      },
      driverSelection: () => async () => {
        throw new Error("PHASE4_META_CONNECT_SEAM_MISSING");
      },
    };
    await expect(runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: { meta_connect: missingSeam },
      repository: harness.repository,
      now: NOW,
    })).rejects.toThrow(/PHASE4_META_CONNECT_SEAM_MISSING/);
  });

  it("rests a platform-owned no-executor step honestly instead of dispatching it", async () => {
    const harness = memoryRepository(snapshots({ account: "done", billing: "pending" }));
    await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: {},
      repository: harness.repository,
      now: NOW,
    });
    expect(harness.steps.get("billing")).toMatchObject({
      state: "awaiting_platform",
      externalRef: { awaiting_code: "subscription_contract_unavailable" },
    });
    expect(harness.claims).toEqual([]);
  });

  it("starts independent lanes together and contains one executor failure to its own step", async () => {
    const harness = memoryRepository(snapshots({
      account: "done",
      meta_connect: "pending",
      offer_layer: "pending",
    }));
    const started: ProvisioningStep[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cycle = runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: {
        meta_connect: {
          mockArm: async () => ({ kind: "done" }),
          driverSelection: () => async (attempt) => {
            started.push(attempt.stepKey);
            await gate;
            throw new Error("synthetic provider detail");
          },
        },
        offer_layer: {
          mockArm: async () => ({ kind: "done" }),
          driverSelection: () => async (attempt) => {
            started.push(attempt.stepKey);
            await gate;
            return { kind: "done" };
          },
        },
      },
      repository: harness.repository,
      now: NOW,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started.sort()).toEqual(["meta_connect", "offer_layer"]);
    release();
    await cycle;
    expect(harness.steps.get("meta_connect")).toMatchObject({
      state: "failed",
      errorCode: "STEP_EXECUTOR_UNEXPECTED",
    });
    expect(harness.steps.get("offer_layer")!.state).toBe("done");
  });
});

describe("runner outcomes and retry policy", () => {
  it.each<[StepOutcome, ProvisioningState]>([
    [{ kind: "done", externalRef: { provider_ref: "synthetic" } }, "done"],
    [{ kind: "awaiting_coach", code: "coach_action_required" }, "awaiting_coach"],
    [{ kind: "awaiting_platform", code: "platform_action_required" }, "awaiting_platform"],
    [{ kind: "awaiting_provider", party: "meta", externalRef: { connection_id: "synthetic" } }, "awaiting_provider"],
    [{ kind: "blocked", code: "TERMINAL", safeMessage: "Permanently unavailable." }, "blocked"],
    [{ kind: "retryable_failure", code: "RETRY", safeMessage: "Try later." }, "failed"],
  ])("commits normalized outcome $kind through the state repository", async (outcome, state) => {
    const harness = targetHarness();
    await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: { ghl_location: arms(outcome) },
      repository: harness.repository,
      now: NOW,
    });
    expect(harness.steps.get("ghl_location")!.state).toBe(state);
    if (outcome.kind === "awaiting_coach" || outcome.kind === "awaiting_platform") {
      expect(harness.steps.get("ghl_location")!.externalRef).toEqual({ awaiting_code: outcome.code });
    }
    if (outcome.kind === "blocked" || outcome.kind === "retryable_failure") {
      expect(harness.steps.get("ghl_location")!.errorCode).toBe(outcome.code);
    }
  });

  it("leaves exhausted automatic work failed with persisted system-stall evidence", async () => {
    const harness = targetHarness("ghl_location", "pending", 4);
    const executors = { ghl_location: arms({
      kind: "retryable_failure" as const,
      code: "RETRY",
      safeMessage: "Try later.",
    }) };
    const first = await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors,
      repository: harness.repository,
      now: NOW,
    });
    const second = await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors,
      repository: harness.repository,
      now: new Date(NOW.getTime() + 24 * 60 * 60_000),
    });
    expect(first[0]).toMatchObject({ kind: "committed", exhausted: true });
    expect(harness.steps.get("ghl_location")).toMatchObject({
      state: "failed",
      attempts: 5,
      externalRef: { alert_evidence: ["onboarding.stalled_system:platform"] },
    });
    expect(second).toEqual([]);
  });

  it("emits onboarding stalled after, and only after, automatic retries are exhausted and committed", async () => {
    const harness = targetHarness("ghl_location", "pending", 4);
    const emit = vi.fn(async () => ({ notificationIds: ["notification-1"] }));
    await runProvisioningCycle({
      tenantId: TENANT,
      isDemo: false,
      executors: { ghl_location: arms({
        kind: "retryable_failure",
        code: "RETRY",
        safeMessage: "Try later.",
      }) },
      repository: harness.repository,
      now: NOW,
      notifications: { emit },
      environment: {
        SETTERFI_PHASE8_LIVE: "true",
        SETTERFI_PHASE8_ALERTS_LIVE: "true",
        SETTERFI_PHASE8_ALERT_RULE_EVENTS_LIVE: "true",
      },
    });
    expect(harness.steps.get("ghl_location")!.state).toBe("failed");
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      key: "onboarding.stalled",
      stepKey: "ghl_location",
    }));
  });

  it("derives stable bounded backoff from the durable idempotency key", () => {
    const values = [1, 2, 3, 4, 5, 20].map((attempt) =>
      boundedBackoffAt(`${TENANT}:ghl_location`, attempt, NOW),
    );
    expect(values[0]).toBe(boundedBackoffAt(`${TENANT}:ghl_location`, 1, NOW));
    const minimums = [
      60_000,
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      6 * 60 * 60_000,
      6 * 60 * 60_000,
    ];
    values.forEach((value, index) => {
      expect(Date.parse(value) - NOW.getTime()).toBeGreaterThanOrEqual(minimums[index]);
      expect(Date.parse(value) - NOW.getTime()).toBeLessThanOrEqual(minimums[index] + 30_000);
    });
  });

  it("forces the mock arm for a demo tenant even when the real selector name is set", async () => {
    const harness = targetHarness();
    const previous = process.env.SETTERFI_GHL_PROVISIONING_DRIVER;
    process.env.SETTERFI_GHL_PROVISIONING_DRIVER = "real";
    let realSelected = false;
    const mockArm = async () => ({ kind: "done" as const, externalRef: { arm: "mock" } });
    try {
      await runProvisioningCycle({
        tenantId: TENANT,
        isDemo: true,
        executors: {
          ghl_location: {
            mockArm,
            driverSelection: () => {
              realSelected = true;
              return async () => ({ kind: "blocked", code: "REAL", safeMessage: "Real arm." });
            },
          },
        },
        repository: harness.repository,
        now: NOW,
      });
    } finally {
      if (previous === undefined) delete process.env.SETTERFI_GHL_PROVISIONING_DRIVER;
      else process.env.SETTERFI_GHL_PROVISIONING_DRIVER = previous;
    }
    expect(realSelected).toBe(false);
    expect(harness.steps.get("ghl_location")!.externalRef).toEqual({ arm: "mock" });
  });

  it("exposes exactly the five existing alert evidence keys", () => {
    expect(ONBOARDING_ALERT_EVIDENCE_KEYS).toEqual([
      "onboarding.stalled_system:platform",
      "onboarding.stalled_coach:tenant",
      "onboarding.stalled_external:platform",
      "onboarding.stalled_external:tenant",
      "onboarding.paying_not_live:tenant",
    ]);
    for (const key of ONBOARDING_ALERT_EVIDENCE_KEYS) {
      expect(withOnboardingAlertEvidence({ source: "synthetic" }, key)).toEqual({
        source: "synthetic",
        alert_evidence: [key],
      });
    }
  });
});
