import { describe, expect, it, vi } from "vitest";

import type { CommissionPayoutResult } from "@/lib/billing/contracts";
import type { UserRole } from "@/lib/auth/claims";

import { createAffiliatePayoutHandler } from "./handler";

const owner = { userId: "owner-user", role: "owner" as const };
const approved: CommissionPayoutResult = {
  state: "approved_for_payout",
  payoutId: "payout-1",
  eventId: "event-approved",
  auditId: 41,
};
const sent: CommissionPayoutResult = {
  state: "sent",
  payoutId: "payout-1",
  eventId: "event-sent",
  reference: "bank-reference-7",
  paidOn: "2026-08-17",
  auditId: 42,
};

function post(body: unknown, query = "") {
  return new Request(`https://setterfi.test/api/platform/affiliate-payouts${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: {
  enabled?: () => boolean;
  session?: () => Promise<{ userId: string; role: UserRole } | null>;
  approve?: (input: {
    affiliateId: string;
    ledgerIds: readonly string[];
    reason: string;
  }) => Promise<CommissionPayoutResult>;
  recordSent?: (input: {
    payoutId: string;
    reference: string;
    paidOn: string;
  }) => Promise<CommissionPayoutResult>;
} = {}) {
  return {
    enabled: overrides.enabled ?? (() => true),
    session: overrides.session ?? (async () => owner),
    approve: overrides.approve ?? (async () => approved),
    recordSent: overrides.recordSent ?? (async () => sent),
  };
}

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("POST /api/platform/affiliate-payouts", () => {
  it("404s before auth or payout work while the affiliate flag is off", async () => {
    const session = vi.fn(async () => owner);
    const approve = vi.fn(async () => approved);
    const response = await createAffiliatePayoutHandler(dependencies({
      enabled: () => false,
      session,
      approve,
    }))(post({
      action: "approve",
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly review",
    }));

    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(session).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
  });

  it.each(["success", "build", "coach", "coach_member", "affiliate"] as const)(
    "refuses the %s role before parsing or querying payout state",
    async (role) => {
      const approve = vi.fn(async () => approved);
      const recordSent = vi.fn(async () => sent);
      const response = await createAffiliatePayoutHandler(dependencies({
        session: async () => ({ userId: `${role}-user`, role }),
        approve,
        recordSent,
      }))(new Request("https://setterfi.test/api/platform/affiliate-payouts", {
        method: "POST",
        body: "{malformed",
      }));

      expect(response.status).toBe(403);
      expectNoStore(response);
      expect(approve).not.toHaveBeenCalled();
      expect(recordSent).not.toHaveBeenCalled();
    },
  );

  it("requires authentication before payout work", async () => {
    const approve = vi.fn(async () => approved);
    const response = await createAffiliatePayoutHandler(dependencies({
      session: async () => null,
      approve,
    }))(post({ action: "approve" }));

    expect(response.status).toBe(401);
    expectNoStore(response);
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves only an exact ledger selection with a nonblank reason", async () => {
    const approve = vi.fn(async () => approved);
    const handler = createAffiliatePayoutHandler(dependencies({ approve }));
    const response = await handler(post({
      action: "approve",
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1", "ledger-2"],
      reason: "Monthly review",
    }));
    const extra = await handler(post({
      action: "approve",
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly review",
      transferNow: true,
    }));

    expect(response.status).toBe(200);
    expectNoStore(response);
    await expect(response.json()).resolves.toEqual({ payout: approved });
    expect(approve).toHaveBeenCalledWith({
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1", "ledger-2"],
      reason: "Monthly review",
    });
    expect(extra.status).toBe(409);
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it.each([
    { action: "record_sent", payoutId: "payout-1", reference: "", paidOn: "2026-08-17" },
    { action: "record_sent", payoutId: "payout-1", reference: "bank-7", paidOn: "2026-02-30" },
    { action: "record_sent", payoutId: "payout-1", reference: "bank-7" },
  ])("refuses an unreceipted sent claim %#", async (body) => {
    const recordSent = vi.fn(async () => sent);
    const response = await createAffiliatePayoutHandler(dependencies({ recordSent }))(post(body));

    expect(response.status).toBe(409);
    expectNoStore(response);
    expect(recordSent).not.toHaveBeenCalled();
  });

  it("records sent as an honest external receipt and replays the persisted event", async () => {
    const recordSent = vi.fn(async () => sent);
    const handler = createAffiliatePayoutHandler(dependencies({
      session: async () => ({ userId: "admin-user", role: "admin" }),
      recordSent,
    }));
    const body = {
      action: "record_sent",
      payoutId: "payout-1",
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
    };
    const first = await handler(post(body));
    const replay = await handler(post(body));

    expect([first.status, replay.status]).toEqual([200, 200]);
    expectNoStore(first);
    expectNoStore(replay);
    await expect(first.json()).resolves.toEqual({ payout: sent });
    await expect(replay.json()).resolves.toEqual({ payout: sent });
    expect(recordSent).toHaveBeenCalledTimes(2);
    expect(recordSent).toHaveBeenNthCalledWith(1, {
      payoutId: "payout-1",
      reference: "bank-reference-7",
      paidOn: "2026-08-17",
    });
  });

  it("rejects query selectors before payout repository work", async () => {
    const approve = vi.fn(async () => approved);
    const response = await createAffiliatePayoutHandler(dependencies({ approve }))(post({
      action: "approve",
      affiliateId: "affiliate-1",
      ledgerIds: ["ledger-1"],
      reason: "Monthly review",
    }, "?tenantId=tenant-2"));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(approve).not.toHaveBeenCalled();
  });
});
