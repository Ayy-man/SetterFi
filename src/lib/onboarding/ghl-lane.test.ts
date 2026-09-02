import { describe, expect, it, vi } from "vitest";

import { createMockGhlProvisioningDriver, createRealGhlProvisioningDriver } from "@/lib/integrations/ghl";

import type { StepAttempt } from "./contracts";
import { createGhlLaneExecutors, type GhlLaneDependencies } from "./ghl-lane";

const attempt = (stepKey: StepAttempt["stepKey"], isDemo = true): StepAttempt => ({
  tenantId: "tenant-synthetic",
  stepKey,
  attemptId: `attempt-${stepKey}`,
  idempotencyKey: `tenant-synthetic:${stepKey}`,
  isDemo,
});

function dependencies(
  overrides: Partial<GhlLaneDependencies> = {},
  externalReference: Record<string, unknown> | null = null,
): GhlLaneDependencies {
  return {
    driverForAttempt: () => createMockGhlProvisioningDriver({
      now: () => Date.parse("2026-08-17T12:00:00.000Z"),
    }),
    evidence: {
      loadExternalReference: async () => externalReference,
      loadLocationRequest: async () => ({
        companyId: "company-synthetic",
        name: "Synthetic Business",
        timezone: "America/Chicago",
        country: "US",
        address: {
          line1: "100 Example Avenue",
          city: "Example City",
          region: "TX",
          postalCode: "78701",
        },
        snapshotId: "snapshot-synthetic",
      }),
      loadSnapshotRequest: async () => ({
        locationId: "location-synthetic",
        snapshotId: "snapshot-synthetic",
        companyId: "company-synthetic",
      }),
      loadNumberRequest: async () => ({
        locationId: "location-synthetic",
        poolId: "pool-synthetic",
      }),
      loadApprovedBrandInput: async () => ({
        artifactId: "artifact-synthetic",
        businessProfileId: "profile-synthetic",
        artifactHash: "a".repeat(64),
      }),
      loadApprovedCampaignInput: async () => ({
        artifactId: "artifact-synthetic",
        contentScreenId: "screen-synthetic",
        campaignDescriptionHash: "b".repeat(64),
        sampleMessagesHash: "c".repeat(64),
      }),
    },
    ...overrides,
  };
}

describe("GHL onboarding lane", () => {
  it("reconciles durable location and number references before any paid provider call", async () => {
    const create = vi.fn();
    const purchase = vi.fn();
    const driver = {
      ...createMockGhlProvisioningDriver(),
      createOrFindLocation: create,
      purchaseOrFindNumber: purchase,
    };
    const location = createGhlLaneExecutors(dependencies({ driverForAttempt: () => driver }, {
      locationId: "location-existing",
      companyId: "company-synthetic",
    }));
    await expect(location.executeGhlLocation(attempt("ghl_location"))).resolves.toMatchObject({
      kind: "done",
      externalRef: { locationId: "location-existing" },
    });
    expect(create).not.toHaveBeenCalled();

    const number = createGhlLaneExecutors(dependencies({ driverForAttempt: () => driver }, {
      numberRef: "number-existing",
      locationId: "location-synthetic",
    }));
    await expect(number.executePhoneNumber(attempt("phone_number"))).resolves.toMatchObject({
      kind: "done",
      externalRef: { numberRef: "number-existing" },
    });
    expect(purchase).not.toHaveBeenCalled();
  });

  it("blocks conflicting reconciliation evidence instead of creating a second resource", async () => {
    const lane = createGhlLaneExecutors(dependencies({}, {
      numberRef: "number-existing",
      locationId: "different-location",
    }));
    await expect(lane.executePhoneNumber(attempt("phone_number"))).resolves.toEqual({
      kind: "blocked",
      code: "GHL_NUMBER_REFERENCE_CONFLICT",
      safeMessage: "Existing provider evidence conflicts with this onboarding attempt.",
    });
  });

  it("polls documented snapshot fields until pending is empty", async () => {
    let polls = 0;
    const driver = {
      ...createMockGhlProvisioningDriver(),
      getSnapshotStatus: vi.fn(async () => {
        polls += 1;
        return polls === 1
          ? { pending: ["workflows"], completed: [], providerStatus: "processing" }
          : { pending: [], completed: ["workflows"], providerStatus: "settled" };
      }),
    };
    let now = 0;
    const lane = createGhlLaneExecutors(dependencies({
      driverForAttempt: () => driver,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      snapshotPollIntervalMs: 5,
      snapshotTimeoutMs: 10,
    }));
    await expect(lane.executeGhlSnapshot(attempt("ghl_snapshot"))).resolves.toMatchObject({
      kind: "done",
      externalRef: { complete: true, pending: [] },
    });
    expect(driver.getSnapshotStatus).toHaveBeenCalledTimes(2);
  });

  it("times out unknown snapshot processing as retryable instead of inventing a terminal enum", async () => {
    let now = 0;
    const lane = createGhlLaneExecutors(dependencies({
      driverForAttempt: () => ({
        ...createMockGhlProvisioningDriver(),
        getSnapshotStatus: async () => ({
          pending: ["workflows"],
          completed: [],
          providerStatus: "processing",
        }),
      }),
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
      snapshotPollIntervalMs: 5,
      snapshotTimeoutMs: 10,
    }));
    await expect(lane.executeGhlSnapshot(attempt("ghl_snapshot"))).resolves.toEqual({
      kind: "retryable_failure",
      code: "GHL_SNAPSHOT_TIMEOUT",
      safeMessage: "Provider setup is still processing and will be checked again.",
    });
  });

  it("requires approved artifact and screen evidence before any filing call", async () => {
    const submitBrand = vi.fn();
    const submitCampaign = vi.fn();
    const lane = createGhlLaneExecutors(dependencies({
      driverForAttempt: () => ({
        ...createMockGhlProvisioningDriver(),
        submitBrand,
        submitCampaign,
      }),
      evidence: {
        ...dependencies().evidence,
        loadApprovedBrandInput: async () => null,
        loadApprovedCampaignInput: async () => null,
      },
    }));
    await expect(lane.executeA2pBrand(attempt("a2p_brand"))).resolves.toEqual({
      kind: "awaiting_coach",
      code: "A2P_EVIDENCE_REQUIRED",
    });
    await expect(lane.executeA2pCampaign(attempt("a2p_campaign"))).resolves.toEqual({
      kind: "awaiting_coach",
      code: "A2P_EVIDENCE_REQUIRED",
    });
    expect(submitBrand).not.toHaveBeenCalled();
    expect(submitCampaign).not.toHaveBeenCalled();
  });

  it("preserves unverified real A2P filing as a fail-closed runner outcome", async () => {
    const driver = createRealGhlProvisioningDriver({
      agencyAccessToken: "configured",
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    });
    const lane = createGhlLaneExecutors(dependencies({ driverForAttempt: () => driver }));
    await expect(lane.executeA2pCampaign(attempt("a2p_campaign", false))).resolves.toEqual({
      kind: "blocked",
      code: "GHL_A2P_SUBMISSION_API_UNVERIFIED",
      safeMessage: "Provider automation is unavailable until its contract is verified.",
    });
  });

  it("classifies mock retryable and terminal failures without exposing provider payloads", async () => {
    const retryable = createGhlLaneExecutors(dependencies({
      driverForAttempt: () => createMockGhlProvisioningDriver({
        outcomeByOperation: { number: "retryable_failure" },
      }),
    }));
    await expect(retryable.executePhoneNumber(attempt("phone_number"))).resolves.toEqual({
      kind: "retryable_failure",
      code: "GHL_NUMBER_RETRYABLE",
      safeMessage: "Provider work can be retried.",
    });
    const terminal = createGhlLaneExecutors(dependencies({
      driverForAttempt: () => createMockGhlProvisioningDriver({
        outcomeByOperation: { location: "terminal_refusal" },
      }),
    }));
    await expect(terminal.executeGhlLocation(attempt("ghl_location"))).resolves.toMatchObject({
      kind: "blocked",
      code: "GHL_LOCATION_TERMINAL",
    });
  });
});
