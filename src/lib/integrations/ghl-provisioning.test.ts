import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { environmentValue, realArmSkipReason } from "@/lib/env-contract";

import {
  GhlProvisioningError,
  createMockGhlProvisioningDriver,
  createRealGhlProvisioningDriver,
  normalizeGhlLocationResponse,
  normalizeGhlPurchasedNumberResponse,
  normalizeGhlSnapshotResponse,
  normalizeGhlSnapshotStatusResponse,
} from "./ghl";
import {
  GHL_PROVISIONING_CONFIGURATION_NAMES,
  selectGhlProvisioningDriver,
} from "./selector";

const context = {
  tenantId: "tenant-synthetic",
  stepKey: "ghl_location" as const,
  attemptId: "attempt-synthetic",
  idempotencyKey: "tenant-synthetic:ghl_location",
};

const locationRequest = {
  companyId: "company-synthetic",
  name: "Synthetic Business",
  timezone: "America/New_York",
  country: "US",
  address: {
    line1: "100 Example Avenue",
    city: "Example City",
    region: "NY",
    postalCode: "10001",
  },
  snapshotId: "snapshot-synthetic",
};

describe("GHL provisioning selector", () => {
  it("uses mock only when explicitly selected", () => {
    const mock = createMockGhlProvisioningDriver();
    expect(selectGhlProvisioningDriver({
      environment: { SETTERFI_GHL_PROVISIONING_DRIVER: "mock" },
      factories: { mock: () => mock, real: () => createMockGhlProvisioningDriver() },
    })).toBe(mock);
  });

  it("fails explicit real mode with every missing variable name before factory construction", () => {
    const real = vi.fn(() => createMockGhlProvisioningDriver());
    expect(() => selectGhlProvisioningDriver({
      environment: { SETTERFI_GHL_PROVISIONING_DRIVER: "real" },
      factories: { mock: createMockGhlProvisioningDriver, real },
    })).toThrow(GHL_PROVISIONING_CONFIGURATION_NAMES.join(", "));
    expect(real).not.toHaveBeenCalled();
  });
});

describe("GHL provisioning mock", () => {
  it("replays location and number references from the durable idempotency key", async () => {
    const driver = createMockGhlProvisioningDriver();
    expect(await driver.createOrFindLocation(context, locationRequest))
      .toEqual(await driver.createOrFindLocation(context, locationRequest));
    const numberContext = { ...context, stepKey: "phone_number" as const };
    const numberRequest = { locationId: "location-synthetic", poolId: "pool-synthetic" };
    expect(await driver.purchaseOrFindNumber(numberContext, numberRequest))
      .toEqual(await driver.purchaseOrFindNumber(numberContext, numberRequest));
  });

  it("classifies retryable and terminal outcomes without leaking provider payloads", async () => {
    const retryable = createMockGhlProvisioningDriver({
      outcomeByOperation: { location: "retryable_failure" },
    });
    await expect(retryable.createOrFindLocation(context, locationRequest)).rejects.toMatchObject({
      classification: "retryable",
    });
    const terminal = createMockGhlProvisioningDriver({
      outcomeByOperation: { campaign: "terminal_refusal" },
    });
    await expect(terminal.submitCampaign(context, {
      artifactId: "artifact-synthetic",
      contentScreenId: "screen-synthetic",
      campaignDescriptionHash: "hash-synthetic",
      sampleMessagesHash: "samples-synthetic",
    })).rejects.toMatchObject({ classification: "terminal" });
  });
});

describe("GHL provisioning response contracts", () => {
  it("narrows only pinned location, snapshot, and purchase fields", () => {
    expect(normalizeGhlLocationResponse({
      id: "location-synthetic",
      companyId: "company-synthetic",
      ignored: { provider: "payload" },
    })).toEqual({
      locationId: "location-synthetic",
      companyId: "company-synthetic",
      rawReference: "location-synthetic",
    });
    expect(normalizeGhlSnapshotResponse({
      processing: true,
      completed: ["funnels"],
      pending: ["workflows"],
    })).toEqual({
      completed: ["funnels"],
      pending: ["workflows"],
      providerStatus: "processing",
    });
    expect(normalizeGhlPurchasedNumberResponse({
      status: true,
      statusCode: 201,
      message: "created",
      data: {
        id: "number-synthetic",
        number: "+12125550100",
        locationId: "location-synthetic",
        underLcAccount: true,
      },
    })).toEqual({
      numberRef: "number-synthetic",
      maskedNumber: "********0100",
      locationId: "location-synthetic",
      underLcAccount: true,
    });
  });

  it("asks the path-shaped snapshot-status route and refuses an unverified body", async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [
      { processing: true, pending: ["workflows"], completed: ["funnels"] },
      { status: true, statusCode: 200, data: { snapshotId: "snapshot-synthetic" } },
    ];
    const driver = createRealGhlProvisioningDriver({
      agencyAccessToken: "configured",
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, {
      contractEvidence: { snapshot: true },
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(JSON.stringify(bodies.shift()), { status: 200 });
      },
    });
    const snapshotRequest = {
      companyId: "company-synthetic",
      locationId: "location-synthetic",
      snapshotId: "snapshot-synthetic",
    };
    await expect(driver.getSnapshotStatus(context, snapshotRequest)).resolves.toEqual({
      pending: ["workflows"],
      completed: ["funnels"],
      providerStatus: "processing",
    });
    expect(urls).toEqual([
      "https://services.leadconnectorhq.com/snapshots/snapshot-status/snapshot-synthetic"
      + "/location/location-synthetic?companyId=company-synthetic",
    ]);

    // The live body is unverified. A provider envelope we have not confirmed must stop the lane
    // by name rather than normalise into a "snapshot is ready" the coach would see as done.
    await expect(driver.getSnapshotStatus(context, snapshotRequest)).rejects.toMatchObject({
      code: "GHL_SNAPSHOT_STATUS_RESPONSE_UNVERIFIED",
      classification: "contract_unverified",
    });
    expect(() => normalizeGhlSnapshotStatusResponse({ completed: [], pending: [] }))
      .toThrow(/GHL_SNAPSHOT_STATUS_RESPONSE_UNVERIFIED/);
  });

  it("refuses every unverified real operation before a network call", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealGhlProvisioningDriver({
      agencyAccessToken: "configured",
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, { fetch: fetcher });
    await expect(driver.createOrFindLocation(context, locationRequest))
      .rejects.toThrow("GHL_LOCATION_CONTRACT_UNVERIFIED");
    await expect(driver.submitBrand(context, {
      artifactId: "artifact-synthetic",
      businessProfileId: "profile-synthetic",
      artifactHash: "hash-synthetic",
    })).rejects.toThrow("GHL_A2P_SUBMISSION_API_UNVERIFIED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("resolves the bearer per call, so a rotated grant reaches the provider on the next one", async () => {
    const authorizations: (string | undefined)[] = [];
    let issued = 0;
    const driver = createRealGhlProvisioningDriver({
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, {
      contractEvidence: { location: true },
      // The stored grant rotates under the row lease. A header built once at construction time
      // would pin the driver instance to whichever token was live when it was made.
      resolveAgencyAccessToken: async () => `rotated-${++issued}`,
      fetch: async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? undefined);
        return new Response(
          JSON.stringify({ id: "location-synthetic", companyId: "company-synthetic" }),
          { status: 200 },
        );
      },
    });
    await driver.createOrFindLocation(context, locationRequest);
    await driver.createOrFindLocation(context, locationRequest);
    expect(authorizations).toEqual(["Bearer rotated-1", "Bearer rotated-2"]);
  });

  it("refuses an unverified operation before it asks the store for a token at all", async () => {
    const resolveAgencyAccessToken = vi.fn(async () => "never-resolved");
    const fetcher = vi.fn<typeof fetch>();
    const driver = createRealGhlProvisioningDriver({
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, { fetch: fetcher, resolveAgencyAccessToken });
    await expect(driver.createOrFindLocation(context, locationRequest))
      .rejects.toThrow("GHL_LOCATION_CONTRACT_UNVERIFIED");
    await expect(driver.getSnapshotStatus(context, {
      companyId: "company-synthetic",
      locationId: "location-synthetic",
      snapshotId: "snapshot-synthetic",
    })).rejects.toThrow("GHL_SNAPSHOT_CONTRACT_UNVERIFIED");
    // The contract gate is the outermost refusal: an operation nobody has verified must not cost a
    // database read, a lease, or a refresh of a single-use rotating token.
    expect(resolveAgencyAccessToken).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects malformed success envelopes without repeating raw values", () => {
    try {
      normalizeGhlLocationResponse({ privateDetail: "must-not-repeat" });
    } catch (error) {
      expect(error).toBeInstanceOf(GhlProvisioningError);
      expect(String(error)).not.toContain("must-not-repeat");
    }
  });

  it("reads the owned probe target at call time and compares only hashes", async () => {
    const target = "owned-probe-target-synthetic";
    const targetHash = createHash("sha256").update(target).digest("hex");
    const driver = createRealGhlProvisioningDriver({
      agencyAccessToken: "configured",
      agencyCompanyId: "company-synthetic",
      snapshotId: "snapshot-synthetic",
      numberPoolId: "pool-synthetic",
    }, {
      environment: {
        SETTERFI_A2P_PROBE_TARGET: target,
        SETTERFI_A2P_PROBE_TARGET_HASH: targetHash,
      },
    });
    await expect(driver.probeOwnedTarget(context, {
      probeKey: "probe-synthetic",
      targetHash,
    })).rejects.toThrow("GHL_A2P_PROBE_CONTRACT_UNVERIFIED");
    await expect(driver.probeOwnedTarget(context, {
      probeKey: "probe-synthetic",
      targetHash: "0".repeat(64),
    })).rejects.toThrow("GHL_A2P_PROBE_TARGET_MISMATCH");
  });
});

const realSkipReason = realArmSkipReason(
  "ghl_provisioning",
  "SETTERFI_GHL_PROVISIONING_DRIVER",
  GHL_PROVISIONING_CONFIGURATION_NAMES,
);

describe.skipIf(Boolean(realSkipReason))(
  `GHL provisioning sandbox arm — SKIPPED: ${realSkipReason ?? "configured"}`,
  () => {
    it("loads names for a future sandbox contract probe without claiming provider success", () => {
      expect(GHL_PROVISIONING_CONFIGURATION_NAMES.every((name) => environmentValue(name))).toBe(true);
    });
  },
);
