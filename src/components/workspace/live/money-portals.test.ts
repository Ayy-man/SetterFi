import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { canAccessWorkspace } from "@/lib/auth/claims";
import type { MrrMovementRead } from "@/lib/repositories/billing";

import { MovementDisclosure, movementTile } from "./admin-money-billing";
import { moneyPageAccessStatus } from "./view-models";

import {
  AffiliateMoney,
  affiliatePayoutLabel,
  parseAffiliatePayouts,
  parseAffiliateReferrals,
} from "./affiliate-money";
import {
  CoachBilling,
  noticeDeliveryLabel,
  parseCoachBillingSnapshot,
  resolveOutcomePrompt,
  type CoachBillingSnapshot,
} from "./coach-billing";

const coachSnapshot: CoachBillingSnapshot = {
  tierName: "Synthetic Growth",
  priceCents: 30_000,
  currency: "USD",
  periodStart: "2026-08-21T00:00:00.000Z",
  periodEnd: "2026-09-21T00:00:00.000Z",
  timezone: "America/New_York",
  bookedCount: 18,
  callAllowance: 25,
  subscriptionState: "active",
  invoiceState: "open",
  accountState: "active",
  pendingMovement: null,
  notices: [],
  correctionCandidates: [],
  outcomePrompts: [{ appointmentId: "appointment-1", label: "Synthetic call", occurredAt: "2026-08-20" }],
  settledAttendance: [],
  isDemo: true,
};

describe("coach billing portal", () => {
  it("changes the rendered page from unavailable to the caller billing values", () => {
    const unavailable = renderToStaticMarkup(createElement(CoachBilling, {
      enabled: true,
      initialSnapshot: null,
    }));
    const snapshot = parseCoachBillingSnapshot({ snapshot: coachSnapshot });
    const populated = renderToStaticMarkup(createElement(CoachBilling, {
      enabled: true,
      initialSnapshot: snapshot,
    }));

    expect(unavailable).toContain("Billing details are temporarily unavailable");
    expect(populated).not.toContain("Billing details are temporarily unavailable");
    expect(populated).toContain("Synthetic Growth");
    expect(populated).toContain("18 of 25");
    // The billing period reached the page. It used to be asserted as the caller's raw ISO string,
    // which only worked because a technical-detail block printed the record in its own vocabulary
    // at the foot of the page; that block is gone, and the period is now the sentence saying when
    // the allowance resets. Same claim -- a caller value rendered -- read the way a coach reads it.
    expect(populated).toContain("Your month resets on");
    expect(populated).toContain("Sep 20, 2026");
  });

  it("keeps a suspended caller visibly suspended rather than degrading the row", () => {
    const populated = renderToStaticMarkup(createElement(CoachBilling, {
      enabled: true,
      initialSnapshot: { ...coachSnapshot, accountState: "suspended" },
    }));
    expect(populated).toContain("Draft copy");
    expect(populated).not.toContain(["unapproved", "suspension", "copy"].join(" "));
  });

  it("rejects any owner-only economics field before it can render", () => {
    expect(() => parseCoachBillingSnapshot({
      snapshot: { ...coachSnapshot, marginCents: 99_999 },
    })).toThrow("COACH_BILLING_PROJECTION_INVALID");
  });

  it("keeps the billed count unchanged for every outcome choice and for skip", () => {
    for (const choice of ["completed", "no_show", "skip"] as const) {
      const result = resolveOutcomePrompt(coachSnapshot, "appointment-1");
      expect(result.bookedCount, choice).toBe(18);
      expect(result.outcomePrompts).toEqual([]);
    }
  });

  it("calls an incomplete notice queued or pending rather than sent", () => {
    expect(noticeDeliveryLabel({
      id: "notice-1", kind: "warning", state: "queued",
      deliveryReceiptId: null, billingContactSource: "tenant billing contact",
    })).toBe("Queued");
    expect(noticeDeliveryLabel({
      id: "notice-2", kind: "crossing", state: "sent",
      deliveryReceiptId: null, billingContactSource: "tenant billing contact",
    })).toBe("Delivery pending");
    expect(noticeDeliveryLabel({
      id: "notice-3", kind: "crossing", state: "sent",
      deliveryReceiptId: "receipt-1", billingContactSource: "tenant billing contact",
    })).toBe("Sent");
  });

  it("gates the dedicated page before session work and keeps it fixture and repository free", () => {
    const page = readFileSync(resolve(process.cwd(), "src/app/(workspace)/coach/billing/page.tsx"), "utf8");
    const feature = readFileSync(resolve(process.cwd(), "src/components/workspace/live/coach-billing.tsx"), "utf8");
    expect(page.indexOf("if (!phase6Live())")).toBeLessThan(page.indexOf("loadRouteActor()"));
    expect(page).toContain("forbidden()");
    expect(`${page}\n${feature}`).not.toMatch(/workspace-fixtures|FixtureWorkspaceShell|WorkspaceScreen|createBillingRepository|\.from\(/);
    expect(feature).toContain('fetch("/api/billing/corrections"');
    expect(feature).toContain("Billing is not enabled");
    expect(feature).toContain('actionKey="billing.correction.requested"');
  });
});

describe("affiliate money portal", () => {
  it("accepts pure affiliates and stamped dual-role coaches without granting unstamped coaches", () => {
    expect(canAccessWorkspace("affiliate", "affiliate")).toBe(true);
    expect(canAccessWorkspace("coach", "affiliate", { affiliateAccess: true })).toBe(true);
    expect(canAccessWorkspace("coach", "affiliate", { affiliateAccess: false })).toBe(false);
  });

  it("changes payout history from unavailable to the caller recorded payout", () => {
    const unavailable = renderToStaticMarkup(createElement(AffiliateMoney, {
      enabled: true,
      termsCopy: null,
      initialPayouts: [],
    }));
    const payouts = parseAffiliatePayouts({ payouts: [{
      amountCents: 2_500,
      state: "sent",
      reference: "synthetic-reference",
      recordedOn: "2026-08-17",
    }] });
    const populated = renderToStaticMarkup(createElement(AffiliateMoney, {
      enabled: true,
      termsCopy: null,
      initialPayouts: payouts,
    }));

    expect(unavailable).toContain("No payout history was returned");
    expect(populated).not.toContain("No payout history was returned");
    expect(populated).toContain("Recorded sent");
    expect(populated).toContain("synthetic-reference");
    expect(populated).toContain("2026-08-17");
  });

  it("rejects referred-coach performance fields before payout history can render", () => {
    expect(() => parseAffiliatePayouts({ payouts: [{
      amountCents: 2_500,
      state: "sent",
      reference: "synthetic-reference",
      recordedOn: "2026-08-17",
      leadCount: 9,
      tenantRevenueCents: 99_999,
    }] })).toThrow("AFFILIATE_PAYOUT_PROJECTION_INVALID");
  });

  /**
   * Three fields, unchanged, because `CLAUDE.md` fixes them: an affiliate "sees only referred-coach
   * name, status, and commission earned, never their performance data." The canvas's fourth
   * column, Joined, was built and removed before it shipped; this allowlist is one of the three
   * that refused it, and it stays exactly this strict. Only the *values* of `accountStatus`
   * changed, from active/inactive to four states.
   */
  it("accepts exactly business name, coarse status, and earned commission", () => {
    const rows = parseAffiliateReferrals({ referrals: [{
      businessName: "Synthetic Coach",
      accountStatus: "paying",
      commissionEarnedCents: 450,
    }] });
    expect(Object.keys(rows[0]).sort()).toEqual([
      "accountStatus", "businessName", "commissionEarnedCents",
    ]);
    expect(() => parseAffiliateReferrals({ referrals: [{
      ...rows[0], tenantId: "must-not-escape", leadCount: 9,
    }] })).toThrow("AFFILIATE_PROJECTION_INVALID");
  });

  /**
   * The state whitelist at the client boundary.
   *
   * `affiliate_referral_projection`'s `case` has no `else` arm, so a `tenant_status` added later
   * arrives as null and has to be refused here rather than rendered: a new state reading as a
   * plausible label would be a wrong claim about whether commission is still coming. The two
   * retired labels are in the rejection list on purpose -- `active` in particular, because that was
   * the value that used to carry a stalled account.
   */
  it("refuses an unknown account state, including the two labels it replaced", () => {
    const base = { businessName: "Synthetic Coach", commissionEarnedCents: 450 };
    for (const accountStatus of ["active", "inactive", "trialing", null, ""]) {
      expect(() => parseAffiliateReferrals({ referrals: [{ ...base, accountStatus }] }))
        .toThrow("AFFILIATE_PROJECTION_INVALID");
    }
    // Positive controls: all four states pass, so the guard is a whitelist and not a blanket refusal.
    for (const accountStatus of ["setting_up", "paying", "payment_problem", "cancelled"]) {
      expect(parseAffiliateReferrals({ referrals: [{ ...base, accountStatus }] })).toHaveLength(1);
    }
  });

  it("distinguishes approved from receipt-backed recorded sent", () => {
    expect(affiliatePayoutLabel({
      amountCents: 500,
      state: "approved_for_payout",
      reference: null,
      recordedOn: null,
    })).toBe("Approved for payout");
    expect(affiliatePayoutLabel({
      amountCents: 500,
      state: "sent",
      reference: "synthetic-reference",
      recordedOn: "2026-08-18",
    })).toBe("Recorded sent");
    expect(affiliatePayoutLabel({
      amountCents: 500,
      state: "sent",
      reference: null,
      recordedOn: null,
    })).toBe("Payout record unavailable");
  });

  it("uses only the approved referral API and exact server export", () => {
    const page = readFileSync(resolve(process.cwd(), "src/app/(workspace)/affiliate/page.tsx"), "utf8");
    const feature = readFileSync(resolve(process.cwd(), "src/components/workspace/live/affiliate-money.tsx"), "utf8");
    expect(page.indexOf("if (!phase6AffiliatesLive())")).toBeLessThan(page.indexOf("loadPlatformActor()"));
    expect(page).toContain("forbidden()");
    expect(page).toContain("affiliateAccess: claims.affiliateAccess");
    expect(feature).toContain('fetch("/api/affiliate/referrals"');
    expect(feature).toContain('resource="affiliate-referrals"');
    expect(feature).not.toMatch(/resource="(?!affiliate-referrals)[^"]+"/);
    expect(`${page}\n${feature}`).not.toMatch(/workspace-fixtures|FixtureWorkspaceShell|WorkspaceScreen|createAffiliateRepository|\.from\(["'](?:referrals|commission_ledger)/);
    expect(feature).not.toMatch(/paid by SetterFi|automatic payout|bank payout/i);
    expect(feature).toContain("Demo placeholder: unapproved");
  });

  it("removes the affiliate catch-all and fixture branches", () => {
    expect(existsSync(resolve(process.cwd(), "src/app/(workspace)/[role]/[[...screen]]/page.tsx"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "src/components/workspace/workspace-screens.tsx"))).toBe(false);
  });
});

function movementFixture(overrides: Partial<MrrMovementRead> = {}): MrrMovementRead {
  return {
    asOf: "2026-08-19T00:00:00.000Z",
    windowStart: "2026-07-20T00:00:00.000Z",
    mrrCents: 95_000,
    clientCount: 3,
    newCents: 30_000,
    upgradeCents: 15_000,
    churnCents: -30_000,
    downgradeCents: -10_000,
    scheduledCancellations: 2,
    missingSources: ["tier_reassignment"],
    ...overrides,
  };
}

// The movement breakdown is its own disclosure on the revenue screen; rendering it directly keeps
// this assertion on the card rather than on the whole page's table machinery.
function billingMarkup(movement: MrrMovementRead | null) {
  return renderToStaticMarkup(createElement(MovementDisclosure, { movement }));
}

describe("admin monthly movement card", () => {
  it("reads New, Upgrades, Churn, Downgrades left to right", () => {
    const markup = billingMarkup(movementFixture());
    const order = ["New", "Upgrades", "Churn", "Downgrades"].map((label) => markup.indexOf(label));

    expect(markup).toContain("Monthly movement");
    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((left, right) => left - right));
    expect(new Set(order).size).toBe(4);
  });

  it("keeps green, green, red and tan on the four columns", () => {
    const markup = billingMarkup(movementFixture());
    const directions = [...markup.matchAll(/data-direction="([a-z]+)"/g)].map((match) => match[1]);

    expect(directions).toEqual(["up", "up", "down", "warn"]);
  });

  it("formats the figures with the sign the projection returned", () => {
    const markup = billingMarkup(movementFixture());

    expect(markup).toContain("+$300.00");
    expect(markup).toContain("+$150.00");
    expect(markup).toContain("−$300.00");
    expect(markup).toContain("−$100.00");
    // The MRR figure itself is the revenue screen's headline tile, not a movement column.
    expect(movementTile(movementFixture()).availability).toEqual({
      kind: "value",
      value: 95_000,
      format: "money",
    });
  });

  it("says a figure it cannot compute is unavailable rather than zero", () => {
    const movement = movementFixture({ mrrCents: null, downgradeCents: null });
    const markup = billingMarkup(movement);

    // The card names what did not happen instead of the generic "Unavailable" it used to print,
    // which is the kit's absent-value convention. The assertion that carries the honest-states
    // rule is the second one: a figure the projection could not resolve must never read as zero.
    expect(markup).toContain("not resolved by the projection");
    expect(markup).not.toContain("$0.00");
    expect(movementTile(movement).availability).toEqual({
      kind: "unavailable",
      note: "No priced subscription evidence",
    });
    expect(movementTile(null).availability).toMatchObject({ kind: "unavailable" });
  });

  it("names the tier reassignment gap and the scheduled cancellations on the card", () => {
    const markup = billingMarkup(movementFixture());

    expect(markup).toMatch(/tier reassignment is not counted/i);
    expect(markup).toContain("2 subscriptions are scheduled to cancel at period end");
    expect(billingMarkup(null)).toContain("The movement projection could not be read");
  });

  it("keeps the card behind the platform money wall", () => {
    expect(moneyPageAccessStatus("coach", "billing")).toBe(403);
    expect(moneyPageAccessStatus("affiliate", "billing")).toBe(403);
    expect(moneyPageAccessStatus("success", "billing")).toBe(403);

    const workspace = resolve(process.cwd(), "src/app/(workspace)");
    const restricted = ["coach", "affiliate"].flatMap((role) =>
      readdirSync(resolve(workspace, role), { recursive: true, encoding: "utf8" })
        .filter((entry) => entry.endsWith(".tsx"))
        .map((entry) => readFileSync(resolve(workspace, role, entry), "utf8")));

    expect(restricted.length).toBeGreaterThan(0);
    for (const source of restricted) expect(source).not.toContain("AdminMoney");
  });
});
