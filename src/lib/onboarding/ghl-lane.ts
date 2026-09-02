/**
 * GHL and A2P lane executors translate normalized provider evidence into runner outcomes.
 *
 * Step persistence remains with the Phase 5 runner. These executors reconcile its durable
 * external reference before any provider call so a timeout replay cannot buy a second resource.
 */

import type { StepAttempt, StepExecutor, StepOutcome } from "./contracts";
import type {
  ApprovedA2pInput,
  ApprovedCampaignInput,
  GhlLocationRequest,
  GhlNumberRequest,
  GhlProvisioningDriver,
  GhlSnapshotRequest,
  ProvisioningContext,
} from "./provider-contracts";
import { GhlProvisioningError } from "@/lib/integrations/ghl";

type ExternalReference = Readonly<Record<string, unknown>>;

export type GhlLaneEvidencePort = {
  loadExternalReference(attempt: StepAttempt): Promise<ExternalReference | null>;
  loadLocationRequest(attempt: StepAttempt): Promise<GhlLocationRequest>;
  loadSnapshotRequest(attempt: StepAttempt): Promise<GhlSnapshotRequest>;
  loadNumberRequest(attempt: StepAttempt): Promise<GhlNumberRequest>;
  loadApprovedBrandInput(attempt: StepAttempt): Promise<ApprovedA2pInput | null>;
  loadApprovedCampaignInput(attempt: StepAttempt): Promise<ApprovedCampaignInput | null>;
};

export type GhlLaneDependencies = {
  driverForAttempt(attempt: StepAttempt): GhlProvisioningDriver;
  evidence: GhlLaneEvidencePort;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  snapshotPollIntervalMs?: number;
  snapshotTimeoutMs?: number;
};

export type GhlLaneExecutors = {
  executeGhlLocation: StepExecutor;
  executeGhlSnapshot: StepExecutor;
  executePhoneNumber: StepExecutor;
  executeA2pBrand: StepExecutor;
  executeA2pCampaign: StepExecutor;
};

function context(attempt: StepAttempt): ProvisioningContext {
  return {
    tenantId: attempt.tenantId,
    stepKey: attempt.stepKey,
    idempotencyKey: attempt.idempotencyKey,
  };
}

function requiredText(reference: ExternalReference, key: string) {
  const value = reference[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function conflict(code: string): StepOutcome {
  return {
    kind: "blocked",
    code,
    safeMessage: "Existing provider evidence conflicts with this onboarding attempt.",
  };
}

function providerFailure(error: unknown): StepOutcome {
  if (!(error instanceof GhlProvisioningError)) throw error;
  if (error.classification === "retryable") {
    return { kind: "retryable_failure", code: error.code, safeMessage: "Provider work can be retried." };
  }
  return {
    kind: "blocked",
    code: error.code,
    safeMessage: error.classification === "contract_unverified"
      ? "Provider automation is unavailable until its contract is verified."
      : "Provider work requires review before it can continue.",
  };
}

function filingEvidenceMissing(): StepOutcome {
  return { kind: "awaiting_coach", code: "A2P_EVIDENCE_REQUIRED" };
}

export function createGhlLaneExecutors(dependencies: GhlLaneDependencies): GhlLaneExecutors {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const snapshotPollIntervalMs = dependencies.snapshotPollIntervalMs ?? 5_000;
  const snapshotTimeoutMs = dependencies.snapshotTimeoutMs ?? 60_000;

  const executeGhlLocation: StepExecutor = async (attempt) => {
    const request = await dependencies.evidence.loadLocationRequest(attempt);
    const existing = await dependencies.evidence.loadExternalReference(attempt);
    if (existing) {
      const locationId = requiredText(existing, "locationId");
      if (!locationId || requiredText(existing, "companyId") !== request.companyId) {
        return conflict("GHL_LOCATION_REFERENCE_CONFLICT");
      }
      return { kind: "done", externalRef: { ...existing, locationId } };
    }
    try {
      const location = await dependencies.driverForAttempt(attempt)
        .createOrFindLocation(context(attempt), request);
      if (location.companyId !== request.companyId) {
        return conflict("GHL_LOCATION_COMPANY_CONFLICT");
      }
      return { kind: "done", externalRef: { ...location } };
    } catch (error) {
      return providerFailure(error);
    }
  };

  const executeGhlSnapshot: StepExecutor = async (attempt) => {
    const request = await dependencies.evidence.loadSnapshotRequest(attempt);
    const existing = await dependencies.evidence.loadExternalReference(attempt);
    if (existing && requiredText(existing, "locationId") !== request.locationId) {
      return conflict("GHL_SNAPSHOT_LOCATION_CONFLICT");
    }
    if (existing?.complete === true) return { kind: "done", externalRef: { ...existing } };

    const deadline = now() + snapshotTimeoutMs;
    try {
      while (true) {
        const status = await dependencies.driverForAttempt(attempt)
          .getSnapshotStatus(context(attempt), request);
        const externalRef = {
          locationId: request.locationId,
          snapshotId: request.snapshotId,
          providerStatus: status.providerStatus,
          pending: [...status.pending],
          completed: [...status.completed],
          complete: status.pending.length === 0,
        };
        if (status.pending.length === 0) return { kind: "done", externalRef };
        if (now() >= deadline) {
          return {
            kind: "retryable_failure",
            code: "GHL_SNAPSHOT_TIMEOUT",
            safeMessage: "Provider setup is still processing and will be checked again.",
          };
        }
        await sleep(Math.min(snapshotPollIntervalMs, Math.max(0, deadline - now())));
      }
    } catch (error) {
      return providerFailure(error);
    }
  };

  const executePhoneNumber: StepExecutor = async (attempt) => {
    const request = await dependencies.evidence.loadNumberRequest(attempt);
    const existing = await dependencies.evidence.loadExternalReference(attempt);
    if (existing) {
      const numberRef = requiredText(existing, "numberRef");
      if (!numberRef || requiredText(existing, "locationId") !== request.locationId) {
        return conflict("GHL_NUMBER_REFERENCE_CONFLICT");
      }
      return { kind: "done", externalRef: { ...existing, numberRef } };
    }
    try {
      const purchased = await dependencies.driverForAttempt(attempt)
        .purchaseOrFindNumber(context(attempt), request);
      if (purchased.locationId !== request.locationId) {
        return conflict("GHL_NUMBER_LOCATION_CONFLICT");
      }
      return { kind: "done", externalRef: { ...purchased } };
    } catch (error) {
      return providerFailure(error);
    }
  };

  const executeA2pBrand: StepExecutor = async (attempt) => {
    const approved = await dependencies.evidence.loadApprovedBrandInput(attempt);
    if (!approved) return filingEvidenceMissing();
    const existing = await dependencies.evidence.loadExternalReference(attempt);
    if (existing) {
      if (!requiredText(existing, "submissionRef")) return conflict("A2P_BRAND_REFERENCE_CONFLICT");
      return { kind: "awaiting_provider", party: "carrier", externalRef: { ...existing } };
    }
    try {
      const submission = await dependencies.driverForAttempt(attempt)
        .submitBrand(context(attempt), approved);
      return { kind: "awaiting_provider", party: "carrier", externalRef: { ...submission } };
    } catch (error) {
      return providerFailure(error);
    }
  };

  const executeA2pCampaign: StepExecutor = async (attempt) => {
    const approved = await dependencies.evidence.loadApprovedCampaignInput(attempt);
    if (!approved) return filingEvidenceMissing();
    const existing = await dependencies.evidence.loadExternalReference(attempt);
    if (existing) {
      if (!requiredText(existing, "submissionRef")) {
        return conflict("A2P_CAMPAIGN_REFERENCE_CONFLICT");
      }
      return { kind: "awaiting_provider", party: "carrier", externalRef: { ...existing } };
    }
    try {
      const submission = await dependencies.driverForAttempt(attempt)
        .submitCampaign(context(attempt), approved);
      return { kind: "awaiting_provider", party: "carrier", externalRef: { ...submission } };
    } catch (error) {
      return providerFailure(error);
    }
  };

  return {
    executeGhlLocation,
    executeGhlSnapshot,
    executePhoneNumber,
    executeA2pBrand,
    executeA2pCampaign,
  };
}
