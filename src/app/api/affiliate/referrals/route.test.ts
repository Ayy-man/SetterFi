import { describe, expect, it, vi } from "vitest";

import type { AffiliateProjectionRow } from "@/lib/billing/contracts";
import { AffiliateRepositoryError } from "@/lib/repositories/affiliates";

import { createAffiliateReferralsHandler } from "./handler";

type SessionActor = {
  userId: string;
  role: "affiliate" | "coach" | "owner";
  tenantId: string | null;
  impersonatingTenant: null;
  impersonationSessionId: null;
  affiliateAccess: boolean;
};

function actor(overrides: Partial<SessionActor> = {}): SessionActor {
  return {
    userId: "affiliate-user",
    role: "affiliate",
    tenantId: null,
    impersonatingTenant: null,
    impersonationSessionId: null,
    affiliateAccess: true,
    ...overrides,
  };
}

const affiliate = actor();
/**
 * T15-13: a coach who also refers coaches carries one login, one `users.role`, and an `affiliates`
 * row — which reaches the route as `affiliate_access`. This is the user the route used to admit at
 * the page and refuse at the API.
 */
const dualRoleCoach = actor({
  userId: "coach-user",
  role: "coach",
  tenantId: "tenant-1",
});
const plainCoach = actor({
  userId: "plain-coach-user",
  role: "coach",
  tenantId: "tenant-1",
  affiliateAccess: false,
});
const request = (query = "") => new Request(
  `https://setterfi.test/api/affiliate/referrals${query}`,
);
const rows: AffiliateProjectionRow[] = [{
  business_name: "Northstar Funding",
  account_status: "paying",
  commission_earned_cents: 1_250,
}];
const payouts = [{
  amount_cents: 2_500,
  state: "sent" as const,
  reference: "synthetic-reference",
  recorded_on: "2026-08-17",
}];
const identity = { referralCode: "SF-AFFILIATE" };

function expectNoStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("no-store");
}

describe("GET /api/affiliate/referrals", () => {
  it("404s before session or projection work while the affiliate flag is off", async () => {
    const session = vi.fn(async () => affiliate);
    const list = vi.fn(async () => rows);
    const response = await createAffiliateReferralsHandler({
      enabled: () => false,
      session,
      list,
      listPayouts: vi.fn(async () => payouts),
      identity: async () => identity,
    })(request());

    expect(response.status).toBe(404);
    expectNoStore(response);
    expect(session).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses an absent session and every caller with no affiliates row behind it", async () => {
    const list = vi.fn(async () => rows);
    const refuse = (session: () => Promise<SessionActor | null>) =>
      createAffiliateReferralsHandler({
        enabled: () => true,
        session,
        list,
        listPayouts: vi.fn(async () => payouts),
        identity: async () => identity,
      })(request());
    const missing = await refuse(async () => null);
    const coach = await refuse(async () => plainCoach);
    const owner = await refuse(async () => actor({
      userId: "owner-user",
      role: "owner",
      affiliateAccess: false,
    }));

    expect([missing.status, coach.status, owner.status]).toEqual([401, 403, 403]);
    expectNoStore(missing);
    expectNoStore(coach);
    expectNoStore(owner);
    expect(list).not.toHaveBeenCalled();
  });

  /**
   * The dual-role pair, and the reason this route stopped reading `actor.role`.
   *
   * The `affiliates` row is the affiliate capability, not `role = 'affiliate'`, so the coach below
   * — one login, `role = 'coach'`, an `affiliates` row stamped as `affiliate_access` — is the user
   * that rule exists for. Before this, `/affiliate` admitted them and this route answered 403
   * to the only fetch that page makes, so they got a permanently erroring portal. The plain coach
   * is the control: same role, no row, still refused, so widening the gate did not widen the data.
   */
  it("admits a dual-role coach carrying the affiliates row and still refuses one without it", async () => {
    const admitted = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => dualRoleCoach,
      list: async () => rows,
      listPayouts: async () => payouts,
      identity: async () => identity,
    })(request());
    const refused = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => plainCoach,
      list: async () => rows,
      listPayouts: async () => payouts,
      identity: async () => identity,
    })(request());

    expect(admitted.status).toBe(200);
    expect(refused.status).toBe(403);
    expectNoStore(admitted);
    await expect(admitted.json()).resolves.toMatchObject({
      referrals: [{ businessName: "Northstar Funding" }],
    });
  });

  /**
   * The identifiers the route holds for a dual-role caller are the tenant they coach for, and the
   * projection must never key on them: `listOwnReferrals` and `listOwnPayouts` take no arguments
   * because the affiliate is selected inside PostgreSQL from the session user id.
   */
  it("passes no caller identifier into either projection", async () => {
    const list = vi.fn(async () => rows);
    const listPayouts = vi.fn(async () => payouts);
    await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => dualRoleCoach,
      list,
      listPayouts,
      identity: async () => identity,
    })(request());

    expect(list).toHaveBeenCalledWith();
    expect(listPayouts).toHaveBeenCalledWith();
  });

  it.each([
    "?tenantId=tenant-2",
    "?referralId=referral-2",
    "?affiliateId=affiliate-2",
    "?status=active",
  ])("rejects caller-selected scope %s before projection work", async (query) => {
    const list = vi.fn(async () => rows);
    const response = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => affiliate,
      list,
      listPayouts: vi.fn(async () => payouts),
      identity: async () => identity,
    })(request(query));

    expect(response.status).toBe(400);
    expectNoStore(response);
    expect(list).not.toHaveBeenCalled();
  });

  /**
   * Three fields, and the count is `CLAUDE.md`'s access model rather than a tidy response shape:
   * an affiliate "sees only referred-coach name, status, and commission earned". The canvas's
   * Joined column was built and removed before it shipped; this is one of the three allowlists
   * that refused it, and it stays this strict. Only the status vocabulary changed.
   */
  it("returns exactly the three camel-case business fields and strips repository extras", async () => {
    const widened = [{
      ...rows[0],
      tenant_id: "tenant-must-not-escape",
      referral_id: "referral-must-not-escape",
      revenue_cents: 99_999,
      lead_count: 88,
      message_cost_cents: 77,
    }] as unknown as AffiliateProjectionRow[];
    const response = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => affiliate,
      list: async () => widened,
      listPayouts: async () => payouts,
      identity: async () => identity,
    })(request());

    expect(response.status).toBe(200);
    expectNoStore(response);
    const payload = await response.json() as {
      referral: Record<string, unknown>;
      referrals: Array<Record<string, unknown>>;
      payouts: Array<Record<string, unknown>>;
    };
    expect(payload).toEqual({
      referral: { code: "SF-AFFILIATE", link: "https://setterfi.test/signup?ref=SF-AFFILIATE" },
      referrals: [{
        businessName: "Northstar Funding",
        accountStatus: "paying",
        commissionEarnedCents: 1_250,
      }],
      payouts: [{
        amountCents: 2_500,
        state: "sent",
        reference: "synthetic-reference",
        recordedOn: "2026-08-17",
      }],
    });
    expect(Object.keys(payload.referrals[0]).sort()).toEqual([
      "accountStatus",
      "businessName",
      "commissionEarnedCents",
    ]);
    expect(Object.keys(payload.referral).sort()).toEqual(["code", "link"]);
  });

  it("keeps repository failure distinct from an empty owned projection", async () => {
    const empty = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => affiliate,
      list: async () => [],
      listPayouts: async () => [],
      identity: async () => identity,
    })(request());
    const unavailable = await createAffiliateReferralsHandler({
      enabled: () => true,
      session: async () => affiliate,
      list: async () => { throw new Error("AFFILIATE_PROJECTION_FAILED"); },
      listPayouts: async () => payouts,
      identity: async () => identity,
    })(request());

    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({
      referral: { code: "SF-AFFILIATE", link: "https://setterfi.test/signup?ref=SF-AFFILIATE" },
      referrals: [],
      payouts: [],
    });
    expect(unavailable.status).toBe(503);
    expectNoStore(unavailable);
  });

  /**
   * The body of that 503 is generic on purpose and stays byte-for-byte what it was: an affiliate
   * must not learn from the answer which of the three reads broke, and none of them may hint at
   * another tenant's data. The cause going nowhere at all is the separate defect -- a real
   * production 503 on this route on 2026-09-01 left the runtime log able to say only that the
   * route had 503'd -- so the reason now reaches `console.error` and nothing else. Asserting the
   * body alongside the log is what stops the diagnosis being paid for with a leak.
   */
  it("names the failing read in the server log while the 503 body stays generic", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createAffiliateReferralsHandler({
        enabled: () => true,
        session: async () => affiliate,
        list: async () => { throw new Error("AFFILIATE_PROJECTION_FAILED"); },
        listPayouts: async () => payouts,
        identity: async () => identity,
      })(request());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Affiliate referrals are temporarily unavailable.",
      });
      expect(logged).toHaveBeenCalledWith(
        "/api/affiliate/referrals failed.",
        "AFFILIATE_PROJECTION_FAILED",
      );
    } finally {
      logged.mockRestore();
    }
  });

  /**
   * Which read broke, and what the database said about it, in one line.
   *
   * The repository constant alone names the read and stops there, so a 503 could still not be told
   * apart from any other 503 of the same read: a missing function, a revoked grant and a signature
   * that no longer matches all logged identically. PostgREST's `code` separates them and is a
   * fixed enumeration with no row content in it, which is why it may cross into the log while the
   * body an affiliate receives does not move a byte.
   */
  it("carries the database failure kind into the log without widening the body", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await createAffiliateReferralsHandler({
        enabled: () => true,
        session: async () => affiliate,
        list: async () => rows,
        listPayouts: async () => {
          throw new AffiliateRepositoryError("AFFILIATE_PAYOUT_PROJECTION_FAILED", "42883");
        },
        identity: async () => identity,
      })(request());

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: "Affiliate referrals are temporarily unavailable.",
      });
      expect(logged).toHaveBeenCalledWith(
        "/api/affiliate/referrals failed.",
        "AFFILIATE_PAYOUT_PROJECTION_FAILED (42883)",
      );
    } finally {
      logged.mockRestore();
    }
  });
});
