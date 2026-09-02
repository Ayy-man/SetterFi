// @vitest-environment node

/**
 * `loadAccountSecurityContext` decides who the actor is for every account-security mutation.
 *
 * Seven route handlers call it -- password, email, MFA enrol, MFA verify, session list, session
 * revoke, revoke-others -- and until this file, `grep -rln "security/shared"` across every test in
 * the repo returned nothing. Not weak coverage: none. It is the single point that answers "whose
 * account is this request allowed to change", and nothing had ever run a line of it.
 *
 * THE IMPERSONATION ARM IS THE ONE THAT MATTERS, AND THE OBVIOUS CHECK ON IT RETURNS THE WRONG
 * ANSWER. `hasImpersonationMarker` is well covered as a predicate in `claims.test.ts`, so grepping
 * its name gets a confident yes. What nothing asserted is that *this function still calls it*. A
 * predicate stays green forever after its caller quietly stops consulting it, and what breaks then
 * is an admin in a view-as session changing a coach's password, email or MFA. So the tests below
 * assert the rule's application at the point that enforces it -- claims carrying a marker must
 * yield no context -- rather than asserting the predicate again from a second angle.
 *
 * ONE CASE PER DISJUNCT. The guard is five arms wide:
 *
 *   if (userError || claimsError || !userData.user?.id || !userData.user.email || !claimsData?.claims)
 *
 * and every arm returns the same `null`, as do both checks on the line below it. So a failure tells
 * you nothing about which arm produced it, and two arms covered by one case leaves one of them
 * untested with no way to notice. Every test here holds the other four arms in their passing state
 * and moves exactly one, which is what makes the mutation counts readable: deleting any single arm
 * should take down exactly one test.
 *
 * The `!claimsData?.claims` arm exists because `getClaims` resolves a null payload WITHOUT setting
 * an error, so an absent payload cannot be inferred from `claimsError`. The obvious test -- a null
 * payload paired with an error -- would be answered by the `claimsError` arm and would never
 * exercise this one. It is given a case with no error set, for the same reason a PostgREST failure
 * needs a well-shaped row beside it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const getClaims = vi.fn();
const client = { auth: { getUser, getClaims } };

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => client,
  createSupabaseServiceClient: () => client,
}));

const { loadAccountSecurityContext } = await import("./shared");

const USER_ID = "8f1c0a92-0000-4000-8000-000000000001";

/** A session that passes every arm, so a test can spoil exactly one thing and know what it spoiled. */
function healthy() {
  getUser.mockResolvedValue({
    data: { user: { id: USER_ID, email: "coach@example.com" } },
    error: null,
  });
  getClaims.mockResolvedValue({
    data: { claims: { sub: USER_ID, app_metadata: { role: "coach", tenant_id: "tenant-1" } } },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  healthy();
});

describe("loadAccountSecurityContext", () => {
  it("returns the actor for an ordinary signed-in session", () => {
    // The control. Without it, every refusal below could be a function that refuses everything,
    // and a guard that never returns a context would pass all of them.
    return expect(loadAccountSecurityContext()).resolves.toMatchObject({
      actor: { userId: USER_ID, tenantId: "tenant-1", email: "coach@example.com" },
    });
  });

  it("refuses a view-as session, which is the rule seven handlers depend on", async () => {
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: USER_ID,
          app_metadata: { role: "admin", tenant_id: "tenant-1", impersonating_tenant: "tenant-2" },
        },
      },
      error: null,
    });

    // Everything else about this session is valid -- real user, matching sub, present email and
    // claims. The marker is the only thing wrong, so only the impersonation check can refuse it.
    // This is the assertion that the rule is APPLIED here; `claims.test.ts` already holds the
    // predicate, and a predicate is exactly what stays green when its caller stops calling it.
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses a view-as session marked only by a session id", async () => {
    // The marker is a disjunction of its own, and `impersonating_tenant` is the arm a test would
    // reach for first. An impersonation carrying only a session id must refuse too.
    getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: USER_ID,
          app_metadata: { role: "admin", tenant_id: "tenant-1", impersonation_session_id: "imp-1" },
        },
      },
      error: null,
    });

    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses when the claims name a different user than the session does", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: "a-different-user", app_metadata: { role: "coach", tenant_id: "tenant-1" } } },
      error: null,
    });

    // Both this and the impersonation check return the same null on the same line, so this case
    // carries no marker and that one carries a matching sub: each moves one thing.
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses when getUser reports an error", async () => {
    getUser.mockResolvedValue({
      data: { user: { id: USER_ID, email: "coach@example.com" } },
      error: { message: "session expired" },
    });

    // The user payload is intact, so only the `userError` arm can answer.
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses when getClaims reports an error", async () => {
    getClaims.mockResolvedValue({
      data: { claims: { sub: USER_ID, app_metadata: { role: "coach", tenant_id: "tenant-1" } } },
      error: { message: "claims unavailable" },
    });

    // Claims payload intact and valid, so `!claimsData?.claims` cannot be what refuses this.
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses a claims payload that is absent without an error", async () => {
    getClaims.mockResolvedValue({ data: null, error: null });

    // The arm that only exists because `getClaims` resolves a null payload without setting an
    // error. Pairing the null payload with an error -- the obvious way to write this -- would be
    // answered by the `claimsError` arm above and would leave this one unexercised.
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses when there is no user on the session at all", async () => {
    /*
     * `user: null` rather than a user with a blank id, and the difference is the whole point.
     *
     * My first version used `{ id: "", email: ... }`, and deleting the `!userData.user?.id` arm
     * took down zero tests: with a blank id the claims' `sub` no longer matches it, so
     * `claims.userId !== userData.user.id` refused instead and the case passed for a reason that
     * had nothing to do with the arm it was named after. A zero on that mutation is the signal --
     * a red proves a mutation landed, and only the count says where.
     *
     * With no user object, `userData.user?.id` is the only thing that can answer, and it is also
     * the shape Supabase actually returns for a request carrying no session.
     */
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });

  it("refuses a session with no email", async () => {
    // The email is not decoration: it is what `verifyCurrentPassword` signs in with to prove the
    // current password, so a context without one would reach that code as `undefined`.
    getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: null } }, error: null });
    await expect(loadAccountSecurityContext()).resolves.toBeNull();
  });
});
