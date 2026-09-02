import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceClientFactory = vi.fn();
const serverClientFactory = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: (...args: unknown[]) => serverClientFactory(...args),
  createSupabaseServiceClient: (...args: unknown[]) => serviceClientFactory(...args),
}));

import { createAffiliateRepository } from "./affiliates";

function userClient(rpcResult: { data: unknown; error: unknown }) {
  return { rpc: vi.fn(async () => rpcResult) };
}

/**
 * What an affiliate reading their own money is allowed to depend on.
 *
 * `/affiliate` makes exactly one fetch, and both reads behind it go through RLS as the signed-in
 * affiliate: `affiliate_referral_projection` and `affiliate_payout_history_projection`. Neither
 * needs the service role, which exists to bypass RLS for the commission and payout writes on the
 * other side of this file.
 *
 * They used to pay for it anyway. The live dependency set built both clients before either read
 * ran, and `createSupabaseServiceClient` throws outright when `SUPABASE_SERVICE_ROLE_KEY` is
 * missing or names a different Supabase project than the configured URL. That throw happens inside
 * the route's `try`, so it becomes a 503 with a generic body, on the first load and identically on
 * every Retry, over a read the database was willing to answer. This is the assertion that keeps
 * the two apart, and it is about authority rather than about a connection count: an unprivileged
 * read must not be reachable only by holding a privileged credential.
 */
describe("affiliate portal reads and the service role", () => {
  beforeEach(() => {
    serviceClientFactory.mockReset();
    serverClientFactory.mockReset();
    serviceClientFactory.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
    });
  });

  it("reads own referrals without constructing a service-role client", async () => {
    serverClientFactory.mockResolvedValue(userClient({
      data: [{
        business_name: "Northstar Funding",
        account_status: "paying",
        commission_earned_cents: 1_250,
      }],
      error: null,
    }));

    await expect(createAffiliateRepository().listOwnReferrals()).resolves.toEqual([{
      business_name: "Northstar Funding",
      account_status: "paying",
      commission_earned_cents: 1_250,
    }]);
    expect(serviceClientFactory).not.toHaveBeenCalled();
  });

  it("reads own payouts without constructing a service-role client", async () => {
    serverClientFactory.mockResolvedValue(userClient({
      data: [{
        amount_cents: 2_500,
        state: "sent",
        reference: "synthetic-reference",
        recorded_on: "2026-08-17",
      }],
      error: null,
    }));

    await expect(createAffiliateRepository().listOwnPayouts()).resolves.toEqual([{
      amount_cents: 2_500,
      state: "sent",
      reference: "synthetic-reference",
      recorded_on: "2026-08-17",
    }]);
    expect(serviceClientFactory).not.toHaveBeenCalled();
  });

  /**
   * The privileged half still is privileged. Deferring construction is not a downgrade of what
   * the payout operations need, so an unconfigured service role still stops them where it always
   * did rather than letting a payout proceed under the affiliate's own RLS.
   */
  it("still refuses a payout approval when the service role is unconfigured", async () => {
    serverClientFactory.mockResolvedValue(userClient({ data: [], error: null }));

    await expect(createAffiliateRepository().approvePayout({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "synthetic",
    })).rejects.toThrow("SUPABASE_SERVICE_ROLE_KEY is not configured");
    expect(serviceClientFactory).toHaveBeenCalled();
  });

  /**
   * PostgREST's code is what turns "the projection call failed" into a named failure kind in the
   * runtime log. `42883` is the deployment not having the function at all, which is the shape a
   * migration that never reached this project takes at this seam.
   */
  it("carries the database code into the error the route logs", async () => {
    serverClientFactory.mockResolvedValue(userClient({
      data: null,
      error: { code: "42883", message: "function does not exist", details: null, hint: null },
    }));

    await expect(createAffiliateRepository().listOwnPayouts())
      .rejects.toThrow("AFFILIATE_PAYOUT_PROJECTION_FAILED (42883)");
    expect(serviceClientFactory).not.toHaveBeenCalled();
  });
});
