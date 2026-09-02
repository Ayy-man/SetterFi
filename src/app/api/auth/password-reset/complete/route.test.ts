import { describe, expect, it, vi } from "vitest";

import {
  createCompletePasswordResetHandler,
  passwordUpdateOutcome,
  recoveryActor,
  revokedOtherSessions,
} from "./handler";

function request(password: string, next = "/coach/home") {
  const form = new URLSearchParams({ password });
  return new Request(`https://setterfi.test/api/auth/password-reset/complete?next=${encodeURIComponent(next)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://setterfi.test" },
    body: form,
  });
}

function dependencies() {
  // The absent session is a case under test, so the mock has to admit null rather than being
  // inferred from its happy-path return alone.
  const session = vi.fn(
    async (): Promise<{ userId: string; tenantId: string } | null> => ({ userId: "user-1", tenantId: "tenant-1" }),
  );
  const updatePassword = vi.fn(async (): Promise<"ok" | "rejected" | "failed"> => "ok");
  const endOtherSessions = vi.fn(async () => true);
  const signOut = vi.fn(async () => true);
  const audit = vi.fn(async () => undefined);
  return {
    session, updatePassword, endOtherSessions, signOut, audit,
    values: { session, updatePassword, endOtherSessions, signOut, audit },
  };
}

function jsonRequest(password: string) {
  return new Request("https://setterfi.test/api/auth/password-reset/complete?next=%2Fcoach%2Fhome", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://setterfi.test" },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/password-reset/complete", () => {
  it("updates the recovery-session password, ends that session, and audits the outcome", async () => {
    const deps = dependencies();
    const response = await createCompletePasswordResetHandler(deps.values)(
      request("correct horse battery staple"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://setterfi.test/auth/reset-password?next=%2Fcoach%2Fhome&success=1",
    );
    expect(deps.updatePassword).toHaveBeenCalledWith("correct horse battery staple");
    expect(deps.signOut).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(expect.any(Request), {
      userId: "user-1", tenantId: "tenant-1",
    });
  });

  it("refuses an expired or invalid recovery session without updating a password", async () => {
    const deps = dependencies();
    deps.session.mockResolvedValue(null);
    const response = await createCompletePasswordResetHandler(deps.values)(
      request("correct horse battery staple"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("error=invalid-link");
    expect(deps.updatePassword).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });
  /**
   * One `reset-failed` string used to cover three outcomes, two of which happen after the new
   * password is already live. Each of these asserts the code *and* whether the receipt cookie went
   * with it, because the page will not say a password changed without one.
   */
  describe("the sentence set is as wide as the failure set", () => {
    it("names a rejected password as its own outcome and leaves the link alone", async () => {
      const deps = dependencies();
      const response = await createCompletePasswordResetHandler(deps.values)(request("too short"));

      expect(response.headers.get("location")).toContain("error=password-rejected");
      // The recovery session is untouched, so the reader retypes rather than spending one of three
      // throttled emails on a link that was never the problem.
      expect(deps.session).not.toHaveBeenCalled();
      expect(deps.updatePassword).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    /**
     * The last road into the misattributed string, found by enumerating what can *cause* each code
     * rather than what each code says. `updateUser` refuses a password that is too weak, already in
     * use, or fails validation -- none of which a new link fixes, and all of which were reported as
     * "request a new link" because the dependency was a boolean.
     */
    it("blames the password when the provider is the one refusing it", async () => {
      const deps = dependencies();
      deps.updatePassword.mockResolvedValue("rejected");
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      expect(response.headers.get("location")).toContain("error=password-rejected");
      // Nothing changed, so no receipt: the page must not report on a change that did not happen.
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(deps.endOtherSessions).not.toHaveBeenCalled();
    });

    it("still sends the reader for a new link when the update failed for its own reasons", async () => {
      const deps = dependencies();
      deps.updatePassword.mockResolvedValue("failed");
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      expect(response.headers.get("location")).toContain("error=reset-failed");
    });

    it("says the sessions may be live rather than that the reset failed", async () => {
      const deps = dependencies();
      deps.endOtherSessions.mockResolvedValue(false);
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      expect(response.headers.get("location")).toContain("error=sessions-live");
      expect(deps.updatePassword).toHaveBeenCalledOnce();
      // The password did change, so the page is allowed to say so even though this outcome is bad
      // news: the receipt goes with every state that reports on a completed change.
      expect(response.headers.get("set-cookie")).toContain("sf_password_reset_done=1");
    });

    it("keeps the audit refusal, under a code that does not deny the change", async () => {
      const deps = dependencies();
      deps.audit.mockRejectedValue(new Error("AUDIT_DOWN"));
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      expect(response.headers.get("location")).toContain("error=not-recorded");
      expect(response.headers.get("set-cookie")).toContain("sf_password_reset_done=1");
    });

    it("ranks a live session above an unwritten audit row", async () => {
      const deps = dependencies();
      deps.endOtherSessions.mockResolvedValue(false);
      deps.audit.mockRejectedValue(new Error("AUDIT_DOWN"));
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      // One is a way in for whoever prompted the reset; the other is bookkeeping.
      expect(response.headers.get("location")).toContain("error=sessions-live");
    });

    /**
     * The JSON arm is narrower than it looks and this pins how narrow. `acceptsHtml` matches the
     * two content types `Request.formData()` can parse, so a caller who is not sending a form fails
     * at the parse and never reaches the outcomes below it -- every post-parse refusal is a
     * redirect. Written down because the handler reads as though it serves two kinds of client.
     */
    it("refuses a non-form body at the parse, before touching the session", async () => {
      const deps = dependencies();
      const response = await createCompletePasswordResetHandler(deps.values)(
        jsonRequest("correct horse battery staple"),
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "reset-failed", passwordChanged: false });
      expect(deps.session).not.toHaveBeenCalled();
      expect(deps.updatePassword).not.toHaveBeenCalled();
    });
  });

  /**
   * The claim the whole flow is built on. Nothing asserted this before, and the code it describes
   * used `signOut({ scope: "local" })`, which the Supabase reference defines as the current session
   * only -- so all three pages said other sessions were ended while nothing ended them.
   */
  it("ends the user's other sessions before closing the recovery one", async () => {
    const deps = dependencies();
    const order: string[] = [];
    deps.updatePassword.mockImplementation(async () => { order.push("update"); return "ok"; });
    deps.endOtherSessions.mockImplementation(async () => { order.push("others"); return true; });
    deps.signOut.mockImplementation(async () => { order.push("local"); return true; });

    await createCompletePasswordResetHandler(deps.values)(request("correct horse battery staple"));

    // Order is load-bearing: the revoke runs under the recovery JWT and keeps the session that JWT
    // names, so closing the recovery session first would leave it with nothing to keep.
    expect(order).toEqual(["update", "others", "local"]);
    expect(deps.endOtherSessions).toHaveBeenCalledWith({ userId: "user-1", tenantId: "tenant-1" });
  });

  it("sets the receipt the success page requires", async () => {
    const deps = dependencies();
    const response = await createCompletePasswordResetHandler(deps.values)(
      request("correct horse battery staple"),
    );

    // Without this, /auth/reset-password?success=1 is a sentence anyone can make the product say.
    expect(response.headers.get("set-cookie")).toContain("sf_password_reset_done=1");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Path=/auth/reset-password");
  });
  /**
   * The endpoint sets a password, so a foreign form must not reach it. Both arrivals are pinned,
   * because a refusal that also turns away the legitimate one is worse than the hole: the only
   * thing that legitimately posts here is the `method="post"` form on `/auth/reset-password`, on
   * our own origin, and its reader arrived from an email with no other way in.
   *
   * A same-origin form submission does send `Origin` -- user agents add it to same-origin requests
   * other than GET and HEAD (developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Origin,
   * read 2026-09-01) -- so this costs nothing to the scripting-unavailable path.
   */
  describe("origin", () => {
    it("accepts the form on our own origin, scripting or not", async () => {
      const deps = dependencies();
      const response = await createCompletePasswordResetHandler(deps.values)(
        request("correct horse battery staple"),
      );

      expect(response.status).toBe(303);
      expect(deps.updatePassword).toHaveBeenCalledOnce();
    });

    it("refuses a form posted from another site before touching the password", async () => {
      const deps = dependencies();
      const foreign = new Request(
        "https://setterfi.test/api/auth/password-reset/complete?next=%2Fcoach%2Fhome",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.test" },
          body: new URLSearchParams({ password: "attacker chosen password" }),
        },
      );
      const response = await createCompletePasswordResetHandler(deps.values)(foreign);

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "Request origin was refused." });
      // The reader holds a live recovery session; nothing about it may be spent by a foreign page.
      expect(deps.session).not.toHaveBeenCalled();
      expect(deps.updatePassword).not.toHaveBeenCalled();
      expect(deps.endOtherSessions).not.toHaveBeenCalled();
    });

    it("refuses a request that sends no Origin at all", async () => {
      const deps = dependencies();
      const headless = new Request(
        "https://setterfi.test/api/auth/password-reset/complete?next=%2Fcoach%2Fhome",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password: "attacker chosen password" }),
        },
      );
      const response = await createCompletePasswordResetHandler(deps.values)(headless);

      expect(response.status).toBe(403);
      expect(deps.updatePassword).not.toHaveBeenCalled();
    });
  });
  /**
   * The mapping itself, which the tests above cannot reach because they stub `updatePassword`.
   * Mutating it to "always rejected" left the whole suite green, which is the signature of a rule
   * living where nothing exercises it.
   */
  describe("what a GoTrue error means", () => {
    it("reads the three refusals as the reader's to fix", () => {
      expect(passwordUpdateOutcome({ code: "weak_password" })).toBe("rejected");
      expect(passwordUpdateOutcome({ code: "same_password" })).toBe("rejected");
      expect(passwordUpdateOutcome({ code: "validation_failed" })).toBe("rejected");
    });

    it("reads everything else as a failure the reader cannot fix by retyping", () => {
      expect(passwordUpdateOutcome({ code: "unexpected_failure" })).toBe("failed");
      expect(passwordUpdateOutcome({ code: "session_expired" })).toBe("failed");
      // An error with no code at all is a failure, not a refusal: silence is not permission to
      // blame the reader's password.
      expect(passwordUpdateOutcome({})).toBe("failed");
    });

    it("reads no error as success", () => {
      expect(passwordUpdateOutcome(null)).toBe("ok");
    });
  });
});

/**
 * The two rules that used to live inside the dependency closure, where nothing reached them.
 *
 * `route.test.ts` passes its own `endOtherSessions` and `session`, so the real implementations ran
 * in no test at all -- and the revoke guard is what decides whether a stolen session survives a
 * password reset. `passwordUpdateOutcome` was pulled out for exactly this reason and I stopped at
 * one of the three operations; these are the other two.
 *
 * Each case rules the other arms out rather than merely reaching the answer. A four-arm `||` is
 * green whichever arm fired, so a test that pairs an error with an absent payload proves nothing
 * about the error arm -- the absent-payload arm would have answered identically. So every case
 * below holds the other three arms in their *passing* state and moves one.
 */
describe("rules the handler's own dependencies apply", () => {
  describe("revokedOtherSessions", () => {
    const ROW = { revoked_count: 2 };

    it("accepts a well-shaped row and counts zero revocations as a real answer", () => {
      expect(revokedOtherSessions({ data: [ROW], error: null })).toBe(true);
      expect(revokedOtherSessions({ data: ROW, error: null })).toBe(true);
      // Zero is a result, not a failure: nothing else was signed in.
      expect(revokedOtherSessions({ data: [{ revoked_count: 0 }], error: null })).toBe(true);
    });

    it("refuses on the error arm alone, with the payload otherwise perfect", () => {
      // The row is well-shaped, so only the error arm can produce false here. Pairing an error
      // with null data -- the obvious way to write this -- would pass on the shape arm instead and
      // never touch the branch it claims to test. A failed PostgREST call resolves to `{ error }`
      // rather than throwing, so this is the arm that carries the whole PostgREST premise.
      expect(revokedOtherSessions({ data: [ROW], error: { message: "permission denied" } })).toBe(false);
    });

    it("refuses an empty set, which is what a call that matched nothing returns", () => {
      // No error, so only the shape arm can answer. This is the case the boolean was wrong about
      // before the shape check existed: the RPC returns a set, and a successful call that matched
      // no rows is not a revoke that ran.
      expect(revokedOtherSessions({ data: [], error: null })).toBe(false);
      expect(revokedOtherSessions({ data: null, error: null })).toBe(false);
    });

    it("refuses a row whose count is not a whole number, with no error present", () => {
      // Again no error, and the row is a real object, so only the `isSafeInteger` arm is left.
      for (const revoked_count of [undefined, null, "2", 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
        expect(revokedOtherSessions({ data: [{ revoked_count }], error: null })).toBe(false);
      }
    });
  });

  describe("recoveryActor", () => {
    const USER = { data: { user: { id: "user-1" } }, error: null };
    const CLAIMS = { data: { claims: { app_metadata: { tenant_id: "tenant-1" } } }, error: null };

    it("names the actor when both calls settle", () => {
      expect(recoveryActor(USER, CLAIMS)).toEqual({ userId: "user-1", tenantId: "tenant-1" });
    });

    it("refuses an absent claims payload that reported no error", () => {
      // The arm most easily lost, and the reason it is written separately: `getClaims` resolves to
      // a null payload *without* setting an error, so this cannot be inferred from `claims.error`.
      // Everything else here is valid, so only the `!claims.data` arm can answer.
      expect(recoveryActor(USER, { data: null, error: null })).toBeNull();
    });

    it("refuses on each error arm alone, with both payloads well-formed", () => {
      expect(recoveryActor({ ...USER, error: { message: "no session" } }, CLAIMS)).toBeNull();
      expect(recoveryActor(USER, { ...CLAIMS, error: { message: "no claims" } })).toBeNull();
    });

    it("refuses a missing user id while the claims payload is perfectly good", () => {
      expect(recoveryActor({ data: { user: null }, error: null }, CLAIMS)).toBeNull();
      expect(recoveryActor({ data: { user: { id: "" } }, error: null }, CLAIMS)).toBeNull();
    });

    it("carries a null tenant through rather than refusing, since the claim may be absent", () => {
      // A session with no tenant claim is still a session that may reset its own password; the
      // audit row records the null. Refusing here would lock out anyone mid-provisioning.
      expect(recoveryActor(USER, { data: { claims: {} }, error: null }))
        .toEqual({ userId: "user-1", tenantId: null });
    });
  });
});
