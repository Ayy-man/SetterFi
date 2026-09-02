import { describe, expect, it, vi } from "vitest";

import { createMockSuppressionProviderPort, type SuppressionIdentity } from "./service";
import { reconcileProviderSuppressions, type PendingProviderSuppression } from "./reconcile";

const identity: SuppressionIdentity = {
  tenantId: "tenant-a",
  contactId: "contact-a",
  identityId: "identity-a",
  provider: "ghl",
  channel: "sms",
  recipientExternalId: "provider-contact-a",
  providerIdentityId: "provider-contact-a",
  normalizedIdentifier: "+15555550100",
  suppressionId: "suppression-a",
};
const pending: PendingProviderSuppression = {
  id: "suppression-a",
  tenantId: "tenant-a",
  contactId: "contact-a",
  channel: "sms",
  identifierHash: "hash-a",
  attempts: 2,
};

describe("provider suppression reconciliation", () => {
  it("retries a pending suppression and persists provider readback", async () => {
    const recordResult = vi.fn(async () => undefined);
    const result = await reconcileProviderSuppressions(100, "2026-08-27T00:00:00.000Z", {
      listPending: vi.fn(async () => [pending]),
      loadIdentities: vi.fn(async () => [identity]),
      recordResult,
      provider: createMockSuppressionProviderPort(() => "2026-08-27T00:00:00.000Z"),
      hashIdentifier: () => "hash-a",
    });

    expect(result).toEqual({ checked: 1, confirmed: 1, failed: 0 });
    expect(recordResult).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      suppressionId: "suppression-a",
      confirmed: true,
      error: null,
    });
  });

  it("records an exact failure when the durable entry no longer maps to an identity", async () => {
    const recordResult = vi.fn(async () => undefined);
    const result = await reconcileProviderSuppressions(100, "2026-08-27T00:00:00.000Z", {
      listPending: vi.fn(async () => [pending]),
      loadIdentities: vi.fn(async () => []),
      recordResult,
      provider: createMockSuppressionProviderPort(),
      hashIdentifier: () => "hash-a",
    });

    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 1 });
    expect(recordResult).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: false,
      error: "SUPPRESSION_IDENTITY_UNAVAILABLE",
    }));
  });

  it("does not mark a suppression confirmed when independent readback disagrees", async () => {
    const recordResult = vi.fn(async () => undefined);
    const base = createMockSuppressionProviderPort();
    const result = await reconcileProviderSuppressions(100, "2026-08-27T00:00:00.000Z", {
      listPending: vi.fn(async () => [pending]),
      loadIdentities: vi.fn(async () => [identity]),
      recordResult,
      provider: { ...base, readBack: async () => ({ providerOperationId: "other", suppressed: false, observedAt: "now" }) },
      hashIdentifier: () => "hash-a",
    });

    expect(result).toEqual({ checked: 1, confirmed: 0, failed: 1 });
    expect(recordResult).toHaveBeenCalledWith(expect.objectContaining({
      confirmed: false,
      error: "PROVIDER_SUPPRESSION_READBACK_MISMATCH",
    }));
  });
});
