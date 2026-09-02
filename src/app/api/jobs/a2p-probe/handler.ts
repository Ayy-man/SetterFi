import { createHash, randomUUID } from "node:crypto";

import { accessToken, safeEqual } from "@/lib/access";
import { driverSelection, phase5Live, requireEnvironment } from "@/lib/env-contract";
import { createMockGhlProvisioningDriver, createRealGhlProvisioningDriver } from "@/lib/integrations/ghl";
import { selectGhlProvisioningDriver } from "@/lib/integrations/selector";
import { runJobWithReceipt, type JobReceiptExecution } from "@/lib/jobs/job-receipts";
import {
  executeA2pProbe,
  externalStallEvidence,
  probeKey,
  selectDueA2pProbes,
  type A2pProbeCandidate,
  type OnboardingAlertKey,
} from "@/lib/onboarding/a2p-probe";
import type { StepOutcome } from "@/lib/onboarding/contracts";
import { createOnboardingEvidenceRepository } from "@/lib/repositories/onboarding-evidence";
import { createOnboardingStepRepository } from "@/lib/repositories/onboarding-steps";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const BATCH_LIMIT = 25;
const PROBE_ROTATION_MS = 24 * 60 * 60 * 1_000;
const DEMO_TARGET_HASH = createHash("sha256").update("setterfi-synthetic-owned-probe-target").digest("hex");

export type ProbeWorkItem = A2pProbeCandidate & {
  idempotencyKey: string;
  isDemo: boolean;
  alreadyStalled: boolean;
  externalRef: Record<string, unknown>;
};

type PersistedProbeReceipt = {
  receiptId: string;
  result: "inconclusive" | "retryable_failure" | "delivered" | "terminal_rejection";
  providerCode: string | null;
};

export type A2pProbeSummary = {
  selected: number;
  attempted: number;
  delivered: number;
  registering: number;
  blocked: number;
  failed: number;
  stallsFlagged: number;
  replayed: number;
};

type ProbeJobDependencies = {
  enabled(): boolean;
  secret: string | null;
  execute?: JobReceiptExecution;
  now(): Date;
  list(limit: number): Promise<readonly ProbeWorkItem[]>;
  loadReceipt(candidate: ProbeWorkItem, key: string): Promise<PersistedProbeReceipt | null>;
  probe(candidate: ProbeWorkItem, key: string): Promise<StepOutcome>;
  apply(candidate: ProbeWorkItem, outcome: StepOutcome): Promise<void>;
  markStall(candidate: ProbeWorkItem, keys: readonly OnboardingAlertKey[]): Promise<boolean>;
  rotate(candidate: ProbeWorkItem, nextProbeAt: string): Promise<void>;
};

async function authorized(request: Request, secret: string | null) {
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
  const [candidateHash, secretHash] = await Promise.all([accessToken(candidate), accessToken(secret)]);
  return safeEqual(candidateHash, secretHash);
}

function replayOutcome(receipt: PersistedProbeReceipt): StepOutcome | null {
  if (receipt.result === "delivered") {
    return { kind: "done", externalRef: { receiptId: receipt.receiptId, result: receipt.result } };
  }
  if (receipt.result === "terminal_rejection") {
    return {
      kind: "blocked",
      code: receipt.providerCode ?? "CARRIER_TERMINAL_REJECTION",
      safeMessage: "Carrier registration was permanently refused.",
    };
  }
  return null;
}

function count(summary: A2pProbeSummary, outcome: StepOutcome) {
  if (outcome.kind === "done") summary.delivered += 1;
  else if (outcome.kind === "blocked") summary.blocked += 1;
  else if (outcome.kind === "awaiting_provider") summary.registering += 1;
  else summary.failed += 1;
}

export function createA2pProbeHandler(dependencies: ProbeJobDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    if (!(await authorized(request, dependencies.secret))) {
      return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
    }
    const summary: A2pProbeSummary = {
      selected: 0,
      attempted: 0,
      delivered: 0,
      registering: 0,
      blocked: 0,
      failed: 0,
      stallsFlagged: 0,
      replayed: 0,
    };
    const work = async () => {
      const now = dependencies.now();
      const due = selectDueA2pProbes(await dependencies.list(BATCH_LIMIT), now.getTime())
        .slice(0, BATCH_LIMIT) as ProbeWorkItem[];
      summary.selected = due.length;
      for (const candidate of due) {
        try {
          const stall = externalStallEvidence({
            submittedAt: candidate.submittedAt,
            now: now.getTime(),
            alreadyFlagged: candidate.alreadyStalled,
          });
          if (stall.emit && await dependencies.markStall(candidate, stall.keys)) {
            summary.stallsFlagged += 1;
          }
          const key = probeKey(candidate.tenantId, now.getTime());
          const receipt = await dependencies.loadReceipt(candidate, key);
          if (receipt) {
            summary.replayed += 1;
            const outcome = replayOutcome(receipt);
            if (outcome) {
              await dependencies.apply(candidate, outcome);
              count(summary, outcome);
            } else {
              summary.registering += 1;
            }
            continue;
          }
          summary.attempted += 1;
          const outcome = await dependencies.probe(candidate, key);
          await dependencies.apply(candidate, outcome);
          count(summary, outcome);
        } catch (error) {
          if (error instanceof Error && /^PHASE4_[A-Z0-9_]+_MISSING$/.test(error.message)) {
            throw error;
          }
          summary.failed += 1;
        } finally {
          await dependencies.rotate(
            candidate,
            new Date(now.getTime() + PROBE_ROTATION_MS).toISOString(),
          );
        }
      }
      return summary;
    };
    try {
      const result = await (dependencies.execute
        ? dependencies.execute("a2p-probe", work)
        : work());
      return Response.json(result, { headers: NO_STORE });
    } catch (error) {
      const code = error instanceof Error && /^PHASE4_[A-Z0-9_]+_MISSING$/.test(error.message)
        ? error.message
        : null;
      return Response.json(
        code
          ? { error: "SMS connection state ownership is unavailable.", code }
          : { error: "A2P probe job is unavailable." },
        { status: 503, headers: NO_STORE },
      );
    }
  };
}

async function loadProbeCandidates(limit: number): Promise<readonly ProbeWorkItem[]> {
  const explicitReal = driverSelection(
    "ghl_provisioning",
    "SETTERFI_GHL_PROVISIONING_DRIVER",
  ) === "real";
  const realTarget = explicitReal
    ? requireEnvironment("ghl_provisioning", [
        "SETTERFI_A2P_PROBE_TARGET",
        "SETTERFI_A2P_PROBE_TARGET_HASH",
      ])
    : null;
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("provisioning_steps")
    .select("tenant_id, state, next_attempt_at, idempotency_key, external_ref")
    .eq("step_key", "sms_live")
    .eq("state", "awaiting_provider")
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error("A2P_PROBE_CANDIDATE_READ_FAILED");
  return Promise.all((data ?? []).map(async (row) => {
    const [{ data: tenant, error: tenantError }, { data: run, error: runError }] = await Promise.all([
      client.from("tenants").select("is_demo").eq("id", row.tenant_id).maybeSingle(),
      client.from("onboarding_runs").select("stalled_flagged_at").eq("tenant_id", row.tenant_id).maybeSingle(),
    ]);
    if (tenantError || runError || !tenant || !run) throw new Error("A2P_PROBE_CANDIDATE_CONTEXT_INVALID");
    const externalRef = row.external_ref && typeof row.external_ref === "object"
      ? row.external_ref as Record<string, unknown>
      : {};
    const submittedAt = typeof externalRef.submittedAt === "string"
      ? externalRef.submittedAt
      : typeof externalRef.submitted_at === "string"
        ? externalRef.submitted_at
        : "invalid";
    return {
      tenantId: row.tenant_id,
      state: row.state as "awaiting_provider",
      submittedAt,
      targetHash: realTarget?.SETTERFI_A2P_PROBE_TARGET_HASH ?? DEMO_TARGET_HASH,
      nextProbeAt: row.next_attempt_at,
      terminalReceiptAt: null,
      idempotencyKey: row.idempotency_key,
      isDemo: tenant.is_demo,
      alreadyStalled: run.stalled_flagged_at !== null,
      externalRef,
    };
  }));
}

async function loadProbeReceipt(candidate: ProbeWorkItem, key: string): Promise<PersistedProbeReceipt | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("a2p_probe_receipts")
    .select("id, result, provider_code")
    .eq("tenant_id", candidate.tenantId)
    .eq("probe_key", key)
    .maybeSingle();
  if (error) throw new Error("A2P_PROBE_RECEIPT_READ_FAILED");
  if (!data) return null;
  return { receiptId: data.id, result: data.result, providerCode: data.provider_code } as PersistedProbeReceipt;
}

function selectProbeDriver() {
  return selectGhlProvisioningDriver({
    factories: { mock: createMockGhlProvisioningDriver, real: createRealGhlProvisioningDriver },
  });
}

async function executeProbe(candidate: ProbeWorkItem, key: string) {
  return executeA2pProbe({
    tenantId: candidate.tenantId,
    stepKey: "sms_live",
    attemptId: randomUUID(),
    idempotencyKey: candidate.idempotencyKey,
    isDemo: candidate.isDemo,
  }, { targetHash: candidate.targetHash, probeKey: key }, {
    driver: candidate.isDemo ? createMockGhlProvisioningDriver() : selectProbeDriver(),
    evidence: createOnboardingEvidenceRepository(),
  });
}

type SmsConnectionState = "live" | "blocked_permanent";
type SmsConnectionStateOwner = (tenantId: string, state: SmsConnectionState) => Promise<void>;
const phase4SmsConnectionStateOwner: SmsConnectionStateOwner | null = null;

async function applyProbeOutcome(candidate: ProbeWorkItem, outcome: StepOutcome) {
  if (outcome.kind !== "done" && outcome.kind !== "blocked") return;
  if (typeof phase4SmsConnectionStateOwner !== "function") {
    throw new Error("PHASE4_SMS_CONNECTION_STATE_SEAM_MISSING");
  }
  await phase4SmsConnectionStateOwner(
    candidate.tenantId,
    outcome.kind === "done" ? "live" : "blocked_permanent",
  );
  const repository = createOnboardingStepRepository();
  const attemptId = randomUUID();
  if (outcome.kind === "done") {
    await repository.completeStep({
      tenantId: candidate.tenantId,
      stepKey: "sms_live",
      attemptId,
      externalRef: outcome.externalRef,
    });
    return;
  }
  await repository.transitionStep({
    tenantId: candidate.tenantId,
    stepKey: "sms_live",
    attemptId,
    targetState: "blocked",
    errorCode: outcome.code,
    errorMessage: outcome.safeMessage,
    blockedReason: outcome.safeMessage,
  });
}

async function markExternalStall(candidate: ProbeWorkItem, keys: readonly OnboardingAlertKey[]) {
  const client = createSupabaseServiceClient();
  const alertEvidence = [...new Set([
    ...(Array.isArray(candidate.externalRef.alert_evidence)
      ? candidate.externalRef.alert_evidence.filter((value): value is string => typeof value === "string")
      : []),
    ...keys,
  ])];
  const { error: stepError } = await client
    .from("provisioning_steps")
    .update({ external_ref: { ...candidate.externalRef, alert_evidence: alertEvidence } })
    .eq("tenant_id", candidate.tenantId)
    .eq("step_key", "sms_live")
    .eq("state", "awaiting_provider");
  if (stepError) throw new Error("A2P_STALL_EVIDENCE_WRITE_FAILED");
  const { data, error } = await client
    .from("onboarding_runs")
    .update({ stalled_flagged_at: new Date().toISOString() })
    .eq("tenant_id", candidate.tenantId)
    .is("stalled_flagged_at", null)
    .select("tenant_id")
    .maybeSingle();
  if (error) throw new Error("A2P_STALL_FLAG_WRITE_FAILED");
  return Boolean(data);
}

async function rotateProbeCandidate(candidate: ProbeWorkItem, nextProbeAt: string) {
  const client = createSupabaseServiceClient();
  const { error } = await client.from("provisioning_steps").update({
    last_attempt_at: new Date().toISOString(),
    next_attempt_at: nextProbeAt,
  }).eq("tenant_id", candidate.tenantId)
    .eq("step_key", "sms_live")
    .eq("state", "awaiting_provider");
  if (error) throw new Error("A2P_PROBE_ROTATION_FAILED");
}

export const GET = createA2pProbeHandler({
  enabled: phase5Live,
  secret: process.env.CRON_SECRET?.trim() || null,
  execute: runJobWithReceipt,
  now: () => new Date(),
  list: loadProbeCandidates,
  loadReceipt: loadProbeReceipt,
  probe: executeProbe,
  apply: applyProbeOutcome,
  markStall: markExternalStall,
  rotate: rotateProbeCandidate,
});
