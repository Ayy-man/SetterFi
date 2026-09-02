/**
 * The affiliate portal's only fetch, run against the hosted project as a real affiliate.
 *
 * **Why this exists.** `/affiliate` answered 503 in production on 2026-09-01 and no test saw it,
 * because every offline test builds the rows it then asserts against. The failure was a
 * disagreement between the deployed application and the deployed database: the allowlist in
 * `src/lib/billing/contracts.ts` had moved to four account states while the hosted
 * `affiliate_referral_projection` was still the two-state version, so `parseProjection` refused
 * the first row it was handed. A fixture cannot be in that state; only the hosted project can.
 *
 * **Why it is `.spec.ts`.** The default suite includes `src/**\/*.test.ts`, and this file talks to
 * the network and must fail loudly when its credentials are absent, so it cannot ride along in the
 * offline run. The suffix is what keeps it out, the same separation
 * `vitest.hosted.config.mts` makes for the measurement round-trip.
 *
 * **Why it drives the route handler rather than the RPC.** The RPC answering is not the claim: an
 * affiliate seeing their money is. Calling the handler runs the live repository, the live service,
 * the referral-identity read, the strict parsers and the capability gate, which is the whole path
 * that produced the 503. Signing in for a real user JWT rather than using the service role is part
 * of that: both projections select the affiliate from `app.current_user_id()` inside PostgreSQL,
 * so a service-role client reads nothing and would prove nothing.
 *
 * Run it with `npm run verify:affiliate-hosted`, which does the environment hygiene first.
 */
import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { AFFILIATE_ACCOUNT_STATES } from "@/lib/billing/contracts";

const AFFILIATE_EMAIL = "support+affiliate@livelegacystrong.com";

const cookieJar: { name: string; value: string }[] = [];

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => cookieJar,
    get: (name: string) => cookieJar.find((cookie) => cookie.name === name),
    set: () => {},
  }),
  headers: async () => new Headers(),
}));

/**
 * `@supabase/ssr` reads the session out of one cookie holding the base64 of the token set, so
 * signing in through the public client and encoding the result is what makes the server client
 * inside the handler believe it is serving a signed-in affiliate.
 */
function sessionCookie(projectRef: string, session: Record<string, unknown>) {
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString("base64")}`;
  return { name: `sb-${projectRef}-auth-token`, value: encoded };
}

describe("affiliate portal against the hosted project", () => {
  beforeAll(async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const password = process.env.SETTERFI_DEMO_LOGIN_PASSWORD;
    if (!url || !anonKey || !password) {
      throw new Error(
        "NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and"
        + " SETTERFI_DEMO_LOGIN_PASSWORD are all required. This harness has no offline mode.",
      );
    }
    const { data, error } = await createClient(url, anonKey).auth
      .signInWithPassword({ email: AFFILIATE_EMAIL, password });
    if (error || !data.session) {
      throw new Error(`Could not sign in as ${AFFILIATE_EMAIL}: ${error?.message ?? "no session"}`);
    }
    const session = data.session;
    cookieJar.push(sessionCookie(new URL(url).hostname.split(".")[0], {
      access_token: session.access_token,
      token_type: session.token_type,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      refresh_token: session.refresh_token,
      user: session.user,
    }));
  });

  it("answers 200 with the affiliate's own referrals, payouts and referral link", async () => {
    const { GET } = await import("@/app/api/affiliate/referrals/handler");
    const response = await GET(new Request("https://setterfi.test/api/affiliate/referrals"));
    const body = await response.json();

    // Printed rather than only asserted: this output is what a reviewer reads after a deploy, and
    // a green line saying nothing about what it saw is the kind of proof that let the 503 ship.
    // Printed as a shape, never as the rows: the body carries referred-business names, commission
    // amounts, payout references and the referral link, and a terminal or CI log is not a place
    // an affiliate's money data may land. Counts and state names are enough to read a 200 by.
    console.log(`status ${response.status}`);
    console.log(JSON.stringify({
      referralCodePresent: typeof body.referral?.code === "string" && body.referral.code.trim() !== "",
      referrals: Array.isArray(body.referrals) ? body.referrals.length : null,
      accountStates: Array.isArray(body.referrals)
        ? [...new Set(body.referrals.map((row: { accountStatus: string }) => row.accountStatus))].sort()
        : null,
      payouts: Array.isArray(body.payouts) ? body.payouts.length : null,
      payoutStates: Array.isArray(body.payouts)
        ? [...new Set(body.payouts.map((row: { state: string }) => row.state))].sort()
        : null,
    }));

    expect(response.status).toBe(200);
    expect(typeof body.referral?.code).toBe("string");
    expect(body.referral.code.trim()).not.toBe("");
    expect(body.referral.link).toContain(body.referral.code);
    expect(Array.isArray(body.referrals)).toBe(true);
    expect(Array.isArray(body.payouts)).toBe(true);
  }, 60_000);

  /**
   * The exact skew that caused the production 503. The hosted function returning a state the
   * deployed allowlist refuses is invisible to every offline test and fatal to the page, so it is
   * asserted against the shipped constant rather than against a list written here.
   */
  it("returns only account states the deployed application accepts", async () => {
    const { GET } = await import("@/app/api/affiliate/referrals/handler");
    const body = await (await GET(
      new Request("https://setterfi.test/api/affiliate/referrals"),
    )).json();

    expect(body.referrals.length).toBeGreaterThan(0);
    for (const row of body.referrals) {
      expect(AFFILIATE_ACCOUNT_STATES as readonly string[]).toContain(row.accountStatus);
      expect(typeof row.businessName).toBe("string");
      expect(Number.isSafeInteger(row.commissionEarnedCents)).toBe(true);
    }
  }, 60_000);

  /**
   * Both portal reads go through RLS as the affiliate, so neither may depend on the service role.
   * Clearing the key here is the assertion: before this was fixed, building the repository threw
   * `SUPABASE_SERVICE_ROLE_KEY is not configured` inside the route's `try` and the page 503'd on
   * every load and every Retry over a read the database was willing to answer.
   */
  it("reads both projections with no service-role key configured", async () => {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const { createAffiliateRepository } = await import("@/lib/repositories/affiliates");
      const repository = createAffiliateRepository();

      await expect(repository.listOwnReferrals()).resolves.toBeInstanceOf(Array);
      await expect(repository.listOwnPayouts()).resolves.toBeInstanceOf(Array);
    } finally {
      if (key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = key;
    }
  }, 60_000);
});
