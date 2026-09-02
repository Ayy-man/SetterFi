import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, createClient } = vi.hoisted(() => {
  const rpcMock = vi.fn();
  return {
    rpc: rpcMock,
    createClient: vi.fn(() => ({ rpc: rpcMock })),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: createClient,
}));

import { logMoneyPageRefusal } from "./money-page-audit";

const ACTOR = "72000000-0000-4000-8000-000000000009";

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: 1, error: null });
  createClient.mockClear();
  createClient.mockImplementation(() => ({ rpc }));
});

/**
 * The receipt behind the refused Money panel.
 *
 * `admin-money-shell.tsx` now prints "Logged -- this attempt is on the audit trail", so this
 * module is the thing that has to be true for that sentence to be honest. Two properties keep the
 * audit trail readable rather than merely populated, and neither is enforced by a type:
 *
 *   1. **Only a role boundary produces a row.** The guard refuses for two reasons and they are
 *      not the same event. `!enabled` is the billing feature flag being off for everybody, the
 *      owner included -- nobody was refused anything, so a row would be noise in a log whose
 *      whole value is that a `money.page.refused` entry means somebody hit a real boundary. That
 *      rule lives in the call sites, not here, so it is checked there.
 *   2. **A broken audit path may not become a 500.** A refusal that crashes instead of refusing
 *      turns an audit outage into an availability outage on a permission surface, and it would do
 *      it to the one reader who was already being told no.
 *   3. **A failed write is never silent.** This function used to return `void` and swallow every
 *      failure into a bare `catch {}`, and the panel asserted "Logged" on the strength of a call
 *      whose result it never looked at. Migration `20261004000001` had never been applied to the
 *      hosted project, so `record_money_page_refusal` did not exist there, every call failed, and
 *      the live deployment told refused operators their attempt was recorded when no row was
 *      written. The outcome now reaches the caller and the failure reaches the server log. Both
 *      halves are pinned below: return a wrong outcome, or drop the log line, and this file reds.
 */
describe("logMoneyPageRefusal", () => {
  it("writes the refusal through the RPC that re-derives the role rule server-side", async () => {
    await logMoneyPageRefusal(ACTOR, "billing");

    // Not a table insert: `record_money_page_refusal` recomputes `moneyPageAccessStatus` against
    // `public.users` and raises for an authorized actor, so a forged refusal cannot be recorded.
    // Calling it by any other name, or writing `audit_log` directly, loses that check.
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("record_money_page_refusal", {
      p_actor_id: ACTOR,
      p_surface: "billing",
    });
  });

  it("passes each Money surface through unchanged, because the surface is the audit target", async () => {
    for (const surface of ["tiers", "billing", "corrections", "affiliates"] as const) {
      rpc.mockClear();
      await logMoneyPageRefusal(ACTOR, surface);
      expect(rpc).toHaveBeenCalledWith("record_money_page_refusal", {
        p_actor_id: ACTOR,
        p_surface: surface,
      });
    }
  });

  it("says the row was recorded when the RPC returns no error", async () => {
    await expect(logMoneyPageRefusal(ACTOR, "billing")).resolves.toBe("recorded");
  });

  /**
   * The exact failure that was live: the RPC does not exist, so PostgREST answers with an error
   * rather than throwing. A `catch`-only guard never sees this one at all, which is why it went
   * unnoticed -- the call resolved, the function returned, and the panel claimed a receipt.
   */
  it("says the row was not recorded when the RPC comes back with an error, not a throw", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'function public.record_money_page_refusal(...) does not exist' },
    });

    await expect(logMoneyPageRefusal(ACTOR, "billing")).resolves.toBe("not-recorded");
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("money.page.refused was not written");
    error.mockRestore();
  });

  it("refuses quietly when the audit write throws, rather than turning a 403 into a 500", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    rpc.mockRejectedValue(new Error("PGRST_CONNECTION_LOST"));

    await expect(logMoneyPageRefusal(ACTOR, "affiliates")).resolves.toBe("not-recorded");
    expect(String(error.mock.calls[0]?.[0])).toContain("PGRST_CONNECTION_LOST");
    error.mockRestore();
  });

  it("survives the service client itself being unavailable", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createClient.mockImplementation(() => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY_MISSING");
    });

    await expect(logMoneyPageRefusal(ACTOR, "corrections")).resolves.toBe("not-recorded");
    expect(rpc).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  /**
   * The outcome has to reach the panel or the sentence is asserting on nothing.
   *
   * This is the assertion that would have caught the original defect. Every route that logs must
   * bind the return value and hand it to the surface it renders; a route that calls the function
   * and discards the answer puts the panel back to claiming a receipt it cannot see. The one
   * exception is `corrections`, which calls `forbidden()` on its refusal branch and draws no panel
   * at all -- it is named here so that dropping it from the list is a deliberate act.
   */
  it("hands the outcome to the surface on every route that draws the refusal panel", () => {
    const panelRoutes = [
      "src/app/(workspace)/admin/tiers/render-tiers-page.tsx",
      "src/app/(workspace)/admin/billing/page.tsx",
      "src/app/(workspace)/admin/billing/costs/page.tsx",
      "src/app/(workspace)/admin/affiliates/page.tsx",
    ];

    for (const file of panelRoutes) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source).toMatch(/refusalRecord\s*=\s*await logMoneyPageRefusal\(/);
      expect(source).toContain("refusalRecord={refusalRecord}");
    }

    const corrections = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/admin/corrections/page.tsx"),
      "utf8",
    );
    expect(corrections).toContain("forbidden()");
    expect(corrections).not.toContain("refusalRecord={");
  });

  /**
   * The flag-off rule is a property of the call sites, so it is read there.
   *
   * Every Money route returns before `loadPlatformActor()` when `phase6Live()` is false, which is
   * already pinned by `view-models.test.ts` as a refuse-before-you-read ordering. What is pinned
   * here is the consequence for the audit trail: because the flag arm returns first and the log
   * call sits inside the authorization branch, a feature-flag refusal structurally cannot write a
   * `money.page.refused` row. Someone hoisting the log call to the top of a route to "catch every
   * refusal" would fill the log with entries for a page nobody was refused.
   */
  it("is only reachable from a route's role-boundary branch, never from its feature-flag arm", () => {
    const gateFiles = [
      "src/app/(workspace)/admin/tiers/render-tiers-page.tsx",
      "src/app/(workspace)/admin/billing/page.tsx",
      "src/app/(workspace)/admin/billing/costs/page.tsx",
      "src/app/(workspace)/admin/corrections/page.tsx",
      "src/app/(workspace)/admin/affiliates/page.tsx",
    ];

    for (const file of gateFiles) {
      const path = resolve(process.cwd(), file);
      expect(existsSync(path)).toBe(true);
      const source = readFileSync(path, "utf8");

      const flagArm = source.indexOf("if (!phase6Live())");
      expect(flagArm).toBeGreaterThan(-1);

      const calls = [...source.matchAll(/logMoneyPageRefusal\(/g)]
        .map((match) => match.index ?? -1)
        .filter((index) => !source.slice(0, index).trimEnd().endsWith("import {"));
      // Every Money route logs, or the panel's "Logged" sentence is false on that route.
      expect(calls.length).toBeGreaterThan(0);

      for (const index of calls) {
        expect(index).toBeGreaterThan(flagArm);
        // The nearest preceding condition has to be the authorization decision, not the flag.
        const preceding = source.slice(0, index);
        const authorization = Math.max(
          preceding.lastIndexOf("!authorized"),
          preceding.lastIndexOf("!== 200"),
        );
        expect(authorization).toBeGreaterThan(flagArm);
        expect(preceding.slice(authorization).includes("phase6Live")).toBe(false);
      }
    }
  });
});
