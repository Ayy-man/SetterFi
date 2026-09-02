import { describe, expect, it, vi } from "vitest";

import {
  runOutboundReconciliationBatch,
  type OutboundReconciliationClaim,
  type OutboundReconciliationDependencies,
} from "./reconciliation";

const accepted: OutboundReconciliationClaim = {
  attemptId: "attempt-accepted", tenantId: "tenant-1", conversationId: "conversation-1",
  idempotencyKey: "inbound:ghl:one", disposition: "accepted", claimToken: "token-1",
  providerMessageId: "provider-1", acceptedAt: "2026-08-27T12:00:00.000Z",
  errorCode: "PERSISTENCE_FAILED", isTest: false, reconciliationAttempt: 1,
};
const indeterminate: OutboundReconciliationClaim = {
  ...accepted, attemptId: "attempt-unknown", idempotencyKey: "inbound:ghl:two",
  disposition: "indeterminate", claimToken: "token-2", providerMessageId: null,
  acceptedAt: null, errorCode: "PROVIDER_SEND_UNKNOWN_ERROR", reconciliationAttempt: 2,
};

function dependencies(claims: readonly OutboundReconciliationClaim[]) {
  return {
    claim: vi.fn(async () => claims),
    persistAccepted: vi.fn(async () => undefined),
    alertIndeterminate: vi.fn(async () => undefined),
    finish: vi.fn(async () => undefined),
  } satisfies OutboundReconciliationDependencies;
}

describe("outbound reconciliation runtime", () => {
  it("persists accepted evidence without provider dispatch and alerts indeterminate custody", async () => {
    const deps = dependencies([accepted, indeterminate]);
    await expect(runOutboundReconciliationBatch(
      deps,
      new Date("2026-08-27T12:05:00.000Z"),
    )).resolves.toEqual({ claimed: 2, persisted: 1, alerted: 1, retryable: 0 });
    expect(deps.persistAccepted).toHaveBeenCalledWith(accepted);
    expect(deps.alertIndeterminate).toHaveBeenCalledWith(
      indeterminate,
      new Date("2026-08-27T12:05:00.000Z"),
    );
    expect(deps.finish).toHaveBeenCalledWith(expect.objectContaining({
      claim: indeterminate, outcome: "alerted",
    }));
  });

  it("backs off failed persistence or alert work without attempting a provider resend", async () => {
    const deps = dependencies([accepted, indeterminate]);
    deps.persistAccepted.mockRejectedValueOnce(new Error("database unavailable"));
    deps.alertIndeterminate.mockRejectedValueOnce(new Error("notification unavailable"));
    await expect(runOutboundReconciliationBatch(
      deps,
      new Date("2026-08-27T12:05:00.000Z"),
    )).resolves.toEqual({ claimed: 2, persisted: 0, alerted: 0, retryable: 2 });
    expect(deps.finish).toHaveBeenCalledTimes(2);
    expect(deps.finish).toHaveBeenNthCalledWith(1, expect.objectContaining({
      outcome: "retry", error: "database unavailable", retryAt: "2026-08-27T12:06:00.000Z",
    }));
    expect(deps.finish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      outcome: "retry", error: "notification unavailable", retryAt: "2026-08-27T12:07:00.000Z",
    }));
  });
});
