/**
 * Service-role persistence for the Phase 5 provisioning worker and platform tracker.
 *
 * Step mutations stay behind the migration's leased RPCs so a stale worker cannot write around
 * the database transition graph. The tracker remains a separate, redacted read and rejects a
 * non-platform role before a service client or query is created.
 */

import { PLATFORM_ROLES, type UserRole } from "@/lib/auth/claims";
import {
  AWAITING_PARTIES,
  PROVISIONING_STATES,
  PROVISIONING_STEPS,
  type AwaitingParty,
  type ProvisioningState,
  type ProvisioningStep,
  type ProvisioningTrackerRow,
} from "@/lib/onboarding/contracts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type ProvisioningStepSnapshot = {
  tenantId: string;
  stepKey: ProvisioningStep;
  state: ProvisioningState;
  attempts: number;
  nextAttemptAt: string;
  leaseExpiresAt: string | null;
  idempotencyKey: string;
};

export type ClaimedProvisioningStep = {
  tenantId: string;
  stepKey: ProvisioningStep;
  attemptId: string;
  idempotencyKey: string;
  attempts: number;
  leaseExpiresAt: string;
};

export type TransitionProvisioningStepInput = {
  tenantId: string;
  stepKey: ProvisioningStep;
  attemptId: string | null;
  targetState: Extract<
    ProvisioningState,
    "awaiting_coach" | "awaiting_platform" | "awaiting_provider" | "blocked"
  >;
  awaitingParty?: AwaitingParty;
  errorCode?: string;
  errorMessage?: string;
  externalRef?: Record<string, unknown>;
  blockedReason?: string;
  nextAttemptAt?: string;
};

export type FailProvisioningStepInput = {
  tenantId: string;
  stepKey: ProvisioningStep;
  attemptId: string;
  errorCode: string;
  errorMessage: string;
  nextAttemptAt: string;
  externalRef?: Record<string, unknown>;
};

export type ProvisioningCommitResult = "committed" | "stale";

export type OnboardingStepRepository = {
  listStepSnapshots(tenantId: string): Promise<readonly ProvisioningStepSnapshot[]>;
  claimStep(input: {
    tenantId: string;
    stepKey: ProvisioningStep;
    attemptId: string;
    leaseSeconds: number;
  }): Promise<ClaimedProvisioningStep | null>;
  completeStep(input: {
    tenantId: string;
    stepKey: ProvisioningStep;
    attemptId: string;
    externalRef?: Record<string, unknown>;
  }): Promise<ProvisioningCommitResult>;
  transitionStep(input: TransitionProvisioningStepInput): Promise<ProvisioningCommitResult>;
  failStep(input: FailProvisioningStepInput): Promise<ProvisioningCommitResult>;
};

type TrackerRow = {
  signup_intent_id: unknown;
  tenant_id: unknown;
  business_name: unknown;
  signup_state: unknown;
  step_key: unknown;
  state: unknown;
  attempts: unknown;
  error_code: unknown;
  blocking_party: unknown;
  blocking_provider: unknown;
  stalled_since: unknown;
  is_demo: unknown;
  content_screen_id: unknown;
  content_screen_state: unknown;
};

type TrackerSource = () => Promise<readonly TrackerRow[]>;

const TRACKER_SIGNUP_STATES = ["started", "completed", "failed"] as const;
const TRACKER_BLOCKING_PARTIES = ["coach", "platform", "provider", "system"] as const;
const TRACKER_CONTENT_STATES = ["clean", "flagged", "awaiting_admin", "confirmed"] as const;

function rows(value: unknown, code: string) {
  if (!Array.isArray(value)) throw new Error(code);
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(code);
    }
    return candidate as Record<string, unknown>;
  });
}

function requiredText(value: unknown, code: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}

function nullableText(value: unknown, code: string) {
  if (value === null) return null;
  return requiredText(value, code);
}

function member<T extends string>(value: unknown, values: readonly T[], code: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(code);
  return value as T;
}

function nullableBoolean(value: unknown, code: string) {
  if (value === null || typeof value === "boolean") return value;
  throw new Error(code);
}

function mapTrackerRow(row: TrackerRow): ProvisioningTrackerRow {
  return {
    signupIntentId: requiredText(row.signup_intent_id, "PROVISIONING_TRACKER_ROW_INVALID"),
    tenantId: nullableText(row.tenant_id, "PROVISIONING_TRACKER_ROW_INVALID"),
    businessName: nullableText(row.business_name, "PROVISIONING_TRACKER_ROW_INVALID"),
    signupState: member(
      row.signup_state,
      TRACKER_SIGNUP_STATES,
      "PROVISIONING_TRACKER_ROW_INVALID",
    ),
    currentStep: row.step_key === null
      ? null
      : member(row.step_key, PROVISIONING_STEPS, "PROVISIONING_TRACKER_ROW_INVALID"),
    state: member(row.state, PROVISIONING_STATES, "PROVISIONING_TRACKER_ROW_INVALID"),
    attempts: Number(row.attempts),
    errorCode: nullableText(row.error_code, "PROVISIONING_TRACKER_ROW_INVALID"),
    blockingParty: member(
      row.blocking_party,
      TRACKER_BLOCKING_PARTIES,
      "PROVISIONING_TRACKER_ROW_INVALID",
    ),
    blockingProvider: row.blocking_provider === null
      ? null
      : member(row.blocking_provider, AWAITING_PARTIES, "PROVISIONING_TRACKER_ROW_INVALID"),
    stalledSince: nullableText(row.stalled_since, "PROVISIONING_TRACKER_ROW_INVALID"),
    isDemo: nullableBoolean(row.is_demo, "PROVISIONING_TRACKER_ROW_INVALID"),
    contentScreenId: nullableText(row.content_screen_id, "PROVISIONING_TRACKER_ROW_INVALID"),
    contentScreenState: row.content_screen_state === null
      ? null
      : member(
          row.content_screen_state,
          TRACKER_CONTENT_STATES,
          "PROVISIONING_TRACKER_ROW_INVALID",
        ),
  };
}

async function loadTrackerRows(): Promise<readonly TrackerRow[]> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("provisioning_tracker_rows")
    .select(`
      signup_intent_id, tenant_id, business_name, signup_state, step_key, state, attempts,
      error_code, blocking_party, blocking_provider, stalled_since, is_demo,
      content_screen_id, content_screen_state
    `)
    .order("stalled_since", { ascending: true });
  if (error) throw new Error(`PROVISIONING_TRACKER_READ_FAILED:${error.message}`);
  return (data ?? []) as unknown as TrackerRow[];
}

/** Platform role validation deliberately precedes the service-role tracker query. */
export async function listProvisioningTrackerRows(
  expectedRole: UserRole | null,
  source: TrackerSource = loadTrackerRows,
): Promise<ProvisioningTrackerRow[]> {
  if (!expectedRole || !PLATFORM_ROLES.includes(expectedRole)) {
    throw new Error("PROVISIONING_TRACKER_PLATFORM_ROLE_REQUIRED");
  }
  const result = (await source()).map(mapTrackerRow);
  if (result.some((row) => !Number.isInteger(row.attempts) || row.attempts < 0)) {
    throw new Error("PROVISIONING_TRACKER_ROW_INVALID");
  }
  return result;
}

function stale(error: { message: string } | null) {
  return Boolean(error?.message.includes("PROVISIONING_ATTEMPT_STALE"));
}

function commitResult(error: { message: string } | null, code: string): ProvisioningCommitResult {
  if (stale(error)) return "stale";
  if (error) throw new Error(`${code}:${error.message}`);
  return "committed";
}

function mapClaim(value: unknown): ClaimedProvisioningStep | null {
  const row = rows(value, "PROVISIONING_CLAIM_RESPONSE_INVALID")[0];
  if (!row) return null;
  return {
    tenantId: requiredText(row.tenant_id, "PROVISIONING_CLAIM_RESPONSE_INVALID"),
    stepKey: member(row.step_key, PROVISIONING_STEPS, "PROVISIONING_CLAIM_RESPONSE_INVALID"),
    attemptId: requiredText(row.attempt_id, "PROVISIONING_CLAIM_RESPONSE_INVALID"),
    idempotencyKey: requiredText(row.idempotency_key, "PROVISIONING_CLAIM_RESPONSE_INVALID"),
    attempts: Number(row.attempts),
    leaseExpiresAt: requiredText(row.lease_expires_at, "PROVISIONING_CLAIM_RESPONSE_INVALID"),
  };
}

/** Production adapter over the exact Plan 05-01 claim/transition RPC signatures. */
export function createOnboardingStepRepository(): OnboardingStepRepository {
  const client = createSupabaseServiceClient();
  return {
    listStepSnapshots: async (tenantId) => {
      const { data, error } = await client
        .from("provisioning_steps")
        .select(`
          tenant_id, step_key, state, attempts, next_attempt_at, lease_expires_at, idempotency_key
        `)
        .eq("tenant_id", tenantId);
      if (error) throw new Error(`PROVISIONING_STEPS_READ_FAILED:${error.message}`);
      return rows(data ?? [], "PROVISIONING_STEP_ROW_INVALID").map((row) => ({
        tenantId: requiredText(row.tenant_id, "PROVISIONING_STEP_ROW_INVALID"),
        stepKey: member(row.step_key, PROVISIONING_STEPS, "PROVISIONING_STEP_ROW_INVALID"),
        state: member(row.state, PROVISIONING_STATES, "PROVISIONING_STEP_ROW_INVALID"),
        attempts: Number(row.attempts),
        nextAttemptAt: requiredText(row.next_attempt_at, "PROVISIONING_STEP_ROW_INVALID"),
        leaseExpiresAt: nullableText(row.lease_expires_at, "PROVISIONING_STEP_ROW_INVALID"),
        idempotencyKey: requiredText(row.idempotency_key, "PROVISIONING_STEP_ROW_INVALID"),
      }));
    },
    claimStep: async (input) => {
      const { data, error } = await client.rpc("claim_provisioning_step", {
        p_expected_tenant: input.tenantId,
        p_step_key: input.stepKey,
        p_attempt_id: input.attemptId,
        p_lease_seconds: input.leaseSeconds,
      });
      if (error?.message.includes("PROVISIONING_STEP_NOT_CLAIMABLE")) return null;
      if (error) throw new Error(`PROVISIONING_STEP_CLAIM_FAILED:${error.message}`);
      return mapClaim(data);
    },
    completeStep: async (input) => {
      const { error } = await client.rpc("complete_provisioning_step", {
        p_expected_tenant: input.tenantId,
        p_step_key: input.stepKey,
        p_attempt_id: input.attemptId,
        p_external_ref: input.externalRef ?? null,
      });
      return commitResult(error, "PROVISIONING_STEP_COMPLETE_FAILED");
    },
    transitionStep: async (input) => {
      const { error } = await client.rpc("transition_provisioning_step", {
        p_expected_tenant: input.tenantId,
        p_step_key: input.stepKey,
        p_attempt_id: input.attemptId,
        p_target_state: input.targetState,
        p_awaiting_party: input.awaitingParty ?? null,
        p_error_code: input.errorCode ?? null,
        p_error_message: input.errorMessage ?? null,
        p_external_ref: input.externalRef ?? null,
        p_blocked_reason: input.blockedReason ?? null,
        p_next_attempt_at: input.nextAttemptAt ?? null,
      });
      return commitResult(error, "PROVISIONING_STEP_TRANSITION_FAILED");
    },
    failStep: async (input) => {
      if (input.externalRef) {
        const { error } = await client.rpc("transition_provisioning_step", {
          p_expected_tenant: input.tenantId,
          p_step_key: input.stepKey,
          p_attempt_id: input.attemptId,
          p_target_state: "failed",
          p_awaiting_party: null,
          p_error_code: input.errorCode,
          p_error_message: input.errorMessage,
          p_external_ref: input.externalRef,
          p_blocked_reason: null,
          p_next_attempt_at: input.nextAttemptAt,
        });
        return commitResult(error, "PROVISIONING_STEP_FAIL_FAILED");
      }
      const { error } = await client.rpc("fail_provisioning_step", {
        p_expected_tenant: input.tenantId,
        p_step_key: input.stepKey,
        p_attempt_id: input.attemptId,
        p_error_code: input.errorCode,
        p_error_message: input.errorMessage,
        p_next_attempt_at: input.nextAttemptAt,
      });
      return commitResult(error, "PROVISIONING_STEP_FAIL_FAILED");
    },
  };
}
