type RpcResult = { data: unknown; error: unknown };

export type FairScanClient = {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<RpcResult>;
};

function boundedLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error("JOB_SCAN_LIMIT_INVALID");
  }
  return limit;
}

function ids(data: unknown, field: "tenant_id" | "conversation_id" | "receipt_id", limit: number) {
  if (!Array.isArray(data)) throw new Error("JOB_SCAN_RECEIPT_INVALID");
  const values = data.map((row) => {
    if (!row || typeof row !== "object") throw new Error("JOB_SCAN_RECEIPT_INVALID");
    const value = (row as Record<string, unknown>)[field];
    if (typeof value !== "string" || !value.trim()) throw new Error("JOB_SCAN_RECEIPT_INVALID");
    return value;
  });
  if (values.length > limit || new Set(values).size !== values.length) {
    throw new Error("JOB_SCAN_RECEIPT_INVALID");
  }
  return values;
}

export async function claimFairTenantIds(
  client: FairScanClient,
  jobKey: "followups" | "compliance_lifecycle",
  limit: number,
) {
  const expected = boundedLimit(limit);
  const { data, error } = await client.rpc("claim_fair_tenant_batch", {
    p_job_key: jobKey,
    p_limit: expected,
  });
  if (error) throw new Error("JOB_TENANT_SCAN_FAILED");
  return ids(data, "tenant_id", expected);
}

export async function claimFairBillingTenantIds(
  client: FairScanClient,
  jobKey: "billing_allowances" | "billing_cost_rollup",
  limit: number,
  statuses: readonly string[] | null,
) {
  const expected = boundedLimit(limit);
  const { data, error } = await client.rpc("claim_fair_billing_subscription_batch", {
    p_job_key: jobKey,
    p_limit: expected,
    p_statuses: statuses,
  });
  if (error) throw new Error("JOB_BILLING_SCAN_FAILED");
  return ids(data, "tenant_id", expected);
}

export async function claimFairNeedsHumanIds(client: FairScanClient, limit: number) {
  const expected = boundedLimit(limit);
  const { data, error } = await client.rpc("claim_fair_needs_human_batch", {
    p_limit: expected,
  });
  if (error) throw new Error("JOB_NEEDS_HUMAN_SCAN_FAILED");
  return ids(data, "conversation_id", expected);
}

export async function claimFairStripeReceiptIds(client: FairScanClient, limit: number) {
  const expected = boundedLimit(limit);
  const { data, error } = await client.rpc("claim_fair_stripe_receipt_batch", {
    p_limit: expected,
  });
  if (error) throw new Error("JOB_STRIPE_RECEIPT_SCAN_FAILED");
  return ids(data, "receipt_id", expected);
}

export async function claimFairGhlLifecycleReceiptIds(client: FairScanClient, limit: number) {
  const expected = boundedLimit(limit);
  const { data, error } = await client.rpc("claim_fair_ghl_lifecycle_receipt_batch", {
    p_limit: expected,
  });
  if (error) throw new Error("JOB_GHL_LIFECYCLE_SCAN_FAILED");
  return ids(data, "receipt_id", expected);
}
