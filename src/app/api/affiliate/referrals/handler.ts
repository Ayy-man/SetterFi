/**
 * Authenticated affiliate projection boundary.
 *
 * The session selects the affiliate inside PostgreSQL. Query selectors and identifier-bearing
 * repository fields are rejected or projected away before the response leaves this route.
 */

import { createAffiliateService } from "@/lib/affiliates/service";
import {
  createAffiliateReferralIdentity,
  type AffiliateReferralIdentity,
} from "@/lib/affiliates/referral-link";
import { REFERRAL_QUERY_PARAM } from "@/lib/affiliates/referral-attribution";
import type { AffiliateProjectionRow } from "@/lib/billing/contracts";
import { phase6AffiliatesLive } from "@/lib/env-contract";
import { createAffiliateRepository } from "@/lib/repositories/affiliates";
import type { AffiliatePayoutProjectionRow } from "@/lib/repositories/affiliates";
import {
  loadCapabilityActor,
  type CapabilityActor,
} from "@/lib/auth/actors";
import { canAccessWorkspace } from "@/lib/auth/claims";

const noStoreHeaders = { "Cache-Control": "no-store" };

type AffiliateReferralDependencies = {
  enabled(): boolean;
  session(): Promise<CapabilityActor | null>;
  list(): Promise<readonly AffiliateProjectionRow[]>;
  listPayouts(): Promise<readonly AffiliatePayoutProjectionRow[]>;
  identity(): Promise<AffiliateReferralIdentity>;
};

export function createAffiliateReferralsHandler(
  dependencies: AffiliateReferralDependencies,
) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    /*
     * T15-13 (`docs/DECISIONS.md:277`, restated at `docs/ARCHITECTURE.md:366`): the `affiliates`
     * row is the capability, so portal access is gated on that row existing and never on
     * `role = 'affiliate'`. `users.role` is single-valued and `users.email` unique, so gating on
     * the role forces a coach who refers other coaches into a second account under a second email.
     * The row reaches this route as the hook-stamped `affiliate_access` claim
     * (`20260904000001_impersonation_claim_contract.sql:23-25`), and it is read from
     * `public.affiliates` at token-mint time rather than supplied by the caller.
     *
     * This calls the same predicate `/affiliate` calls, deliberately: the page and the route
     * refusing different people is the defect this closes — a dual-role coach used to pass the
     * page gate and get a permanent 403 from the only fetch the page makes.
     */
    if (!canAccessWorkspace(actor.role, "affiliate", { affiliateAccess: actor.affiliateAccess })) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    if ([...new URL(request.url).searchParams.keys()].length > 0) {
      return Response.json(
        { error: "Affiliate referral selectors are not accepted." },
        { status: 400, headers: noStoreHeaders },
      );
    }
    try {
      const [rows, payouts, identity] = await Promise.all([
        dependencies.list(),
        dependencies.listPayouts(),
        dependencies.identity(),
      ]);
      const referralUrl = new URL("/signup", request.url);
      referralUrl.searchParams.set(REFERRAL_QUERY_PARAM, identity.referralCode);
      return Response.json({
        referral: { code: identity.referralCode, link: referralUrl.toString() },
        referrals: rows.map((row) => ({
          businessName: row.business_name,
          accountStatus: row.account_status,
          commissionEarnedCents: row.commission_earned_cents,
        })),
        payouts: payouts.map((row) => ({
          amountCents: row.amount_cents,
          state: row.state,
          reference: row.reference,
          recordedOn: row.recorded_on,
        })),
      }, { headers: noStoreHeaders });
    } catch (cause) {
      /*
       * The body stays generic and stays byte-for-byte what it was -- an affiliate must not be
       * able to read from a 503 whether the projection, the payout read, or the referral-code
       * lookup is the thing that broke, and none of those failures may hint at another tenant's
       * data -- but the cause is logged, the way the pipeline-stage and contact-identity routes
       * log theirs. Without this line every distinct failure inside the try reached the runtime
       * log as an identical bare 503: a real production 503 on this route this morning could be
       * narrowed no further than "the route 503'd". A 503 carrying no code in the log now means
       * something specific -- the failure happened outside this try.
       */
      console.error(
        "/api/affiliate/referrals failed.",
        cause instanceof Error ? cause.message : "AFFILIATE_REFERRALS_UNAVAILABLE",
      );
      return Response.json(
        { error: "Affiliate referrals are temporarily unavailable." },
        { status: 503, headers: noStoreHeaders },
      );
    }
  };
}

const repository = createAffiliateRepository();
const service = createAffiliateService(repository);
const identity = createAffiliateReferralIdentity();

export const GET = createAffiliateReferralsHandler({
  enabled: phase6AffiliatesLive,
  session: loadCapabilityActor,
  list: () => service.listOwnReferrals(),
  listPayouts: () => repository.listOwnPayouts(),
  identity: () => identity.readOwn(),
});
