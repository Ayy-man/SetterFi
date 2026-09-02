// @vitest-environment node

/**
 * The password route's operations, driven directly.
 *
 * `routes.test.ts` covers this route's orchestration -- the call order, that the revoke happens
 * before the update, what each failure maps to on the wire -- and it does that by passing its own
 * `context` into `createAccountSecurityPasswordHandler`. That is the right way to test orchestration
 * and it is why these rules had no coverage at all: the operations lived as closures inside the
 * `context()` that only `POST` ever builds, so the suite that looks like it covers this route never
 * ran a line of them. The sharpest version of the problem is the revoke failure, where the test
 * stubs a function that throws `ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED` and then asserts the
 * handler's reaction to it: the stub and the assertion agree perfectly, and the code that decides
 * when to raise it is not involved.
 *
 * Two of the four carry rules worth holding on their own.
 *
 * The identity check in `verifyCurrentPassword` is what makes it a check on *this* account rather
 * than a check that some account somewhere accepts the password. GoTrue answering "yes, that is a
 * valid password" for a different user must not pass.
 *
 * The shape check in `endOtherSessions` exists because a failed PostgREST call resolves with
 * `{ error }` rather than throwing. A guard that only caught exceptions would read a failed revoke
 * as a successful one, and this route revokes *before* it changes the password precisely so that a
 * failed revoke stops everything -- so if that check is wrong, the audit row's unconditional
 * `'other_sessions': 'ended'` starts asserting something untrue.
 */

import { describe, expect, it, vi } from "vitest";

import { accountSecurityPasswordOperations } from "./handler";

const ACTOR = { userId: "user-1", tenantId: "tenant-1", email: "coach@example.com" };

/** A context whose `rpc` answers with whatever the test hands it. */
function contextWith(rpc: (name: string, args: Record<string, unknown>) => unknown, updateError: unknown = null) {
  const client = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => rpc(name, args)),
    auth: { updateUser: vi.fn(async () => ({ error: updateError })) },
  };
  return { context: { actor: ACTOR, client } as never, client };
}

function verifierReturning(user: { id: string } | null, error: unknown = null) {
  const signOut = vi.fn(async () => ({ error: null }));
  return {
    signOut,
    verifier: () => ({
      auth: {
        signInWithPassword: vi.fn(async () => ({ data: { user }, error })),
        signOut,
      },
    }),
  };
}

describe("verifyCurrentPassword", () => {
  it("accepts a password that belongs to this actor, and does not leave the proof session open", async () => {
    const { context } = contextWith(() => ({ data: null, error: null }));
    const { verifier, signOut } = verifierReturning({ id: ACTOR.userId });
    const operations = accountSecurityPasswordOperations(context, verifier);

    await expect(operations.verifyCurrentPassword("correct")).resolves.toBe(true);
    // The proof session is a real session. Left open, it would be one of the sessions the revoke
    // below counts, and the number the route reports back would be wrong by one.
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("refuses a valid password that belongs to somebody else", async () => {
    const { context } = contextWith(() => ({ data: null, error: null }));
    const { verifier, signOut } = verifierReturning({ id: "a-different-user" });
    const operations = accountSecurityPasswordOperations(context, verifier);

    // GoTrue said the credentials were good. They were good for the wrong account, which is the
    // whole reason this route checks the id rather than trusting the absence of an error.
    await expect(operations.verifyCurrentPassword("valid, wrong account")).resolves.toBe(false);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("refuses when the provider returns an error", async () => {
    const { context } = contextWith(() => ({ data: null, error: null }));
    const { verifier } = verifierReturning(null, { message: "Invalid login credentials" });
    const operations = accountSecurityPasswordOperations(context, verifier);

    await expect(operations.verifyCurrentPassword("wrong")).resolves.toBe(false);
  });
});

describe("endOtherSessions", () => {
  const call = (rpcResult: unknown) => {
    const { context, client } = contextWith(() => rpcResult);
    return { operations: accountSecurityPasswordOperations(context, verifierReturning(null).verifier), client };
  };

  it("returns the count the database actually removed", async () => {
    const { operations, client } = call({ data: [{ revoked_count: 3 }], error: null });

    await expect(operations.endOtherSessions()).resolves.toBe(3);
    expect(client.rpc).toHaveBeenCalledWith("revoke_other_account_security_sessions", {
      p_expected_user: ACTOR.userId,
      p_expected_tenant: ACTOR.tenantId,
      p_reason: "Password changed",
    });
  });

  it("reads a bare row as well as a single-element array", async () => {
    const { operations } = call({ data: { revoked_count: 0 }, error: null });
    // Zero is a real answer -- an account with no other sessions -- and must not be confused with
    // a failure, which is why the guard tests the shape rather than the truthiness of the count.
    await expect(operations.endOtherSessions()).resolves.toBe(0);
  });

  it("refuses a PostgREST failure, which resolves rather than throws", async () => {
    // The row here is perfectly well shaped, so the shape arm of the guard cannot catch this and
    // the `error` arm is the only thing standing between a failed revoke and a reported success.
    // Pairing the error with `data: null` -- which is what I wrote first -- passes this test with
    // the error check deleted, because `!row` catches it instead.
    const { operations } = call({ data: [{ revoked_count: 4 }], error: { message: "permission denied" } });
    await expect(operations.endOtherSessions()).rejects.toThrow("ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED");
  });

  it("refuses a response that carries no row", async () => {
    const { operations } = call({ data: [], error: null });
    await expect(operations.endOtherSessions()).rejects.toThrow("ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED");
  });

  it("refuses a row whose count is not a whole number", async () => {
    // The count decides the sentence the user is shown. A string or a float here means the
    // function did not return what its contract says, and guessing is how "0 other sessions"
    // becomes a claim nobody checked.
    for (const revoked_count of ["2", 2.5, null, undefined, Number.NaN]) {
      const { operations } = call({ data: [{ revoked_count }], error: null });
      await expect(operations.endOtherSessions()).rejects.toThrow("ACCOUNT_SECURITY_PASSWORD_OTHERS_REVOKE_FAILED");
    }
  });
});

describe("audit", () => {
  const call = (rpcResult: unknown) => {
    const { context } = contextWith(() => rpcResult);
    return accountSecurityPasswordOperations(context, verifierReturning(null).verifier);
  };

  it("returns the audit id the row carries", async () => {
    await expect(call({ data: [{ audit_id: 42 }], error: null }).audit()).resolves.toEqual({ auditId: 42 });
  });

  it("refuses a failure or a row it cannot read", async () => {
    // The audit row is the record that a privileged action happened. A route that returned a
    // success without one would be reporting an action nothing logged. Well-shaped row beside the
    // error for the same reason as the revoke case above: otherwise the shape arm answers and the
    // error arm is never the thing under test.
    await expect(call({ data: [{ audit_id: 7 }], error: { message: "denied" } }).audit()).rejects.toThrow("ACCOUNT_SECURITY_PASSWORD_AUDIT_FAILED");
    await expect(call({ data: [{ audit_id: "42" }], error: null }).audit()).rejects.toThrow("ACCOUNT_SECURITY_PASSWORD_AUDIT_FAILED");
  });
});

describe("update", () => {
  it("passes the current password through, and reports a provider refusal as failure", async () => {
    const { context, client } = contextWith(() => ({ data: null, error: null }));
    const good = accountSecurityPasswordOperations(context, verifierReturning(null).verifier);
    await expect(good.update({ currentPassword: "old", password: "new" })).resolves.toBe(true);
    // `current_password` is what lets GoTrue's own re-authentication check run when the project
    // has it switched on; dropping it would silently downgrade to a session-only change.
    expect(client.auth.updateUser).toHaveBeenCalledWith({ password: "new", current_password: "old" });

    const refused = contextWith(() => ({ data: null, error: null }), { message: "weak_password" });
    const operations = accountSecurityPasswordOperations(refused.context, verifierReturning(null).verifier);
    await expect(operations.update({ currentPassword: "old", password: "weak" })).resolves.toBe(false);
  });
});
