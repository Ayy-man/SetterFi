import { describe, expect, it, vi } from "vitest";

import {
  claimFairBillingTenantIds,
  claimFairGhlLifecycleReceiptIds,
  claimFairNeedsHumanIds,
  claimFairStripeReceiptIds,
  claimFairTenantIds,
  type FairScanClient,
} from "./fair-scan";

function client(data: unknown, error: unknown = null) {
  return { rpc: vi.fn(async () => ({ data, error })) } satisfies FairScanClient;
}

describe("durable fair scan client", () => {
  it("uses separate closed cursor keys for tenant jobs", async () => {
    const database = client([{ tenant_id: "tenant-b" }, { tenant_id: "tenant-c" }]);
    await expect(claimFairTenantIds(database, "followups", 2))
      .resolves.toEqual(["tenant-b", "tenant-c"]);
    expect(database.rpc).toHaveBeenCalledWith("claim_fair_tenant_batch", {
      p_job_key: "followups",
      p_limit: 2,
    });
  });

  it("passes the honest active subscription filter only for allowance evaluation", async () => {
    const database = client([{ tenant_id: "tenant-a" }]);
    await claimFairBillingTenantIds(
      database,
      "billing_allowances",
      25,
      ["active", "trialing", "past_due"],
    );
    expect(database.rpc).toHaveBeenCalledWith("claim_fair_billing_subscription_batch", {
      p_job_key: "billing_allowances",
      p_limit: 25,
      p_statuses: ["active", "trialing", "past_due"],
    });
  });

  it("rejects duplicate, oversized, malformed, and failed receipts", async () => {
    await expect(claimFairNeedsHumanIds(client([
      { conversation_id: "conversation-a" },
      { conversation_id: "conversation-a" },
    ]), 2)).rejects.toThrow("JOB_SCAN_RECEIPT_INVALID");
    await expect(claimFairTenantIds(client([{ tenant_id: "a" }, { tenant_id: "b" }]), "compliance_lifecycle", 1))
      .rejects.toThrow("JOB_SCAN_RECEIPT_INVALID");
    await expect(claimFairNeedsHumanIds(client(null), 10)).rejects.toThrow("JOB_SCAN_RECEIPT_INVALID");
    await expect(claimFairNeedsHumanIds(client([], { message: "database unavailable" }), 10))
      .rejects.toThrow("JOB_NEEDS_HUMAN_SCAN_FAILED");
  });

  it("claims Stripe retry receipts through a separate durable cursor", async () => {
    const database = client([{ receipt_id: "receipt-b" }, { receipt_id: "receipt-c" }]);
    await expect(claimFairStripeReceiptIds(database, 2))
      .resolves.toEqual(["receipt-b", "receipt-c"]);
    expect(database.rpc).toHaveBeenCalledWith("claim_fair_stripe_receipt_batch", {
      p_limit: 2,
    });
  });

  it("claims GHL lifecycle receipts through a separate durable cursor", async () => {
    const database = client([{ receipt_id: "receipt-d" }]);
    await expect(claimFairGhlLifecycleReceiptIds(database, 25))
      .resolves.toEqual(["receipt-d"]);
    expect(database.rpc).toHaveBeenCalledWith("claim_fair_ghl_lifecycle_receipt_batch", {
      p_limit: 25,
    });
  });
});
