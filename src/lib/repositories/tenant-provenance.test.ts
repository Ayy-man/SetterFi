import { beforeEach, describe, expect, it, vi } from "vitest";

const { maybeSingle, createClient } = vi.hoisted(() => {
  const maybeSingleMock = vi.fn();
  return {
    maybeSingle: maybeSingleMock,
    createClient: vi.fn(async () => ({
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }),
      }),
    })),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: createClient,
}));

import { loadTenantProvenance } from "./tenant-provenance";

const TENANT = "72000000-0000-4000-8000-000000000004";

beforeEach(() => {
  maybeSingle.mockReset();
  createClient.mockClear();
});

/**
 * The label that says whether a coach is looking at their own business's records.
 *
 * Coach setup is the surface this exists for: it has no figures to hang a provenance off, so
 * unlike every other coach page it cannot derive the answer from a read that has already thrown by
 * the time the head renders. That makes "the read did not answer" a state that reaches the screen,
 * and the whole point of this module is that the state stays distinguishable from "real".
 */
describe("loadTenantProvenance", () => {
  it("reports a seeded workspace as demo and a live one as real", async () => {
    maybeSingle.mockResolvedValueOnce({ data: { is_demo: true }, error: null });
    await expect(loadTenantProvenance(TENANT)).resolves.toBe("demo");

    maybeSingle.mockResolvedValueOnce({ data: { is_demo: false }, error: null });
    await expect(loadTenantProvenance(TENANT)).resolves.toBe("real");
  });

  /*
   * The one that matters, and the one a `catch`-shaped fix gets wrong.
   *
   * PostgREST resolves a denied or broken select with `{ error }` rather than throwing, so a
   * guard written only as a `try/catch` never sees this at all -- it takes the `{ data: null }`
   * and, if the mapping is `data?.is_demo === true ? "demo" : "real"`, prints "Real data" over a
   * read that failed. That is an invented affirmative on the product's most safety-relevant
   * label, so it is asserted as its own case rather than folded into the throw.
   */
  it("returns null for a failed read rather than claiming the workspace is real", async () => {
    maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: "permission denied for table tenants" },
    });
    await expect(loadTenantProvenance(TENANT)).resolves.toBeNull();

    // No row at all resolves the same way, and for the same reason.
    maybeSingle.mockResolvedValueOnce({ data: null, error: null });
    await expect(loadTenantProvenance(TENANT)).resolves.toBeNull();
  });

  it("returns null when the transport throws, without the throw escaping", async () => {
    maybeSingle.mockRejectedValueOnce(new Error("socket hang up"));
    await expect(loadTenantProvenance(TENANT)).resolves.toBeNull();
  });

  /*
   * A missing tenant id never reaches the database. Asserting the client was not constructed is
   * the substantive half: a version of this that queried `.eq("id", "")` would also return null,
   * and would look identical from the return value alone.
   */
  it("asks nothing of the database without a tenant id", async () => {
    await expect(loadTenantProvenance("   ")).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });
});
