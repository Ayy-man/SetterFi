import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Who the shell thinks it is greeting, for a reader with no tenant.
 *
 * The account chip in the topbar derives initials from `account.fullName` and falls back to the
 * role's own letters -- "AD", "CO", "AF" -- only when there is no name. Every owner and admin got
 * the fallback, and it looked like an unset `users.full_name` until you followed the read: this
 * layout resolved the actor with `loadRouteActor`, which returns null unless the session carries a
 * `tenantId`, and the platform console is not a tenant. So the name was never looked up for the
 * exact people whose chip was wrong, and no seed data could have fixed it.
 *
 * Both halves are asserted, because either alone would have passed while the bug shipped: the
 * tenant-less owner gets their name, and the coach still gets their business alongside it.
 */

const loadCapabilityActor = vi.fn();
const maybeSingle = vi.fn();
const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }));

vi.mock("@/lib/auth/actors", () => ({
  loadCapabilityActor,
  loadPlatformActor: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/mode", () => ({ authMode: () => "supabase" }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: () => ({ from }) }));
vi.mock("@/lib/impersonation-session", () => ({
  loadImpersonationSessionBanner: vi.fn(async () => null),
}));
vi.mock("@/components/kit/impersonation-frame", () => ({
  ImpersonationFrame: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("@/components/workspace/workspace-env", () => ({
  WorkspaceEnvProvider: (
    { account }: { account?: { fullName: string | null; business: string | null; isDemo?: boolean } },
  ) => (
    <p data-testid="account">
      {`${account?.fullName ?? "none"} / ${account?.business ?? "none"} / ${account?.isDemo === true ? "demo" : "real"}`}
    </p>
  ),
}));

const { default: WorkspaceLayout } = await import("./layout");

/** `users` answers first, `tenants` second — the order the layout's `Promise.all` reads them in. */
function answers(user: unknown, tenant: unknown) {
  maybeSingle.mockReset();
  maybeSingle.mockResolvedValueOnce({ data: user }).mockResolvedValueOnce({ data: tenant });
}

beforeEach(() => {
  from.mockClear();
  loadCapabilityActor.mockReset();
});
afterEach(cleanup);

describe("the workspace shell's account read", () => {
  it("names an owner who has no tenant", async () => {
    loadCapabilityActor.mockResolvedValue({ userId: "user-1", role: "owner", tenantId: null });
    answers({ full_name: "Alec Delpuech" }, null);

    render(await WorkspaceLayout({ children: null }));

    expect(screen.getByTestId("account")).toHaveTextContent("Alec Delpuech / none");
    // The tenant table is not queried on a null tenant: an `.eq("id", null)` is a read that can
    // only ever answer nothing, and it was the whole cost of the gate this replaced.
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("users");
  });

  it("still names a coach's business alongside their name", async () => {
    loadCapabilityActor.mockResolvedValue({ userId: "user-2", role: "coach", tenantId: "tenant-1" });
    answers({ full_name: "Marcus Reid" }, { name: "Reid Funding Group" });

    render(await WorkspaceLayout({ children: null }));

    expect(screen.getByTestId("account")).toHaveTextContent("Marcus Reid / Reid Funding Group");
    expect(from).toHaveBeenCalledTimes(2);
  });

  /*
   * The tenant's own `is_demo`, carried down so the account sheet can strip the seeders' "(demo)"
   * marker out of the name it prints and still say that the account is seeded. Stripping the marker
   * without the flag would hide test data on a live screen, which is a hard rule.
   */
  it("carries the tenant's demo flag, and reports a real account as real", async () => {
    loadCapabilityActor.mockResolvedValue({ userId: "user-4", role: "coach", tenantId: "tenant-2" });
    answers({ full_name: "Theo Brightwell (demo)" }, { name: "Brightwell Capital (demo)", is_demo: true });

    render(await WorkspaceLayout({ children: null }));

    // The marker stays in the string the layout hands down: stripping it is the reading surface's
    // job, and an export or a log search still has to match the stored value.
    expect(screen.getByTestId("account"))
      .toHaveTextContent("Theo Brightwell (demo) / Brightwell Capital (demo) / demo");
  });

  it("reports a tenant that is not seeded as real", async () => {
    loadCapabilityActor.mockResolvedValue({ userId: "user-5", role: "coach", tenantId: "tenant-3" });
    answers({ full_name: "Marcus Reid" }, { name: "Reid Funding Group", is_demo: false });

    render(await WorkspaceLayout({ children: null }));

    expect(screen.getByTestId("account")).toHaveTextContent("Marcus Reid / Reid Funding Group / real");
  });

  it("resolves no account at all when the row carries no name and no business", async () => {
    loadCapabilityActor.mockResolvedValue({ userId: "user-3", role: "owner", tenantId: null });
    answers({ full_name: "   " }, null);

    render(await WorkspaceLayout({ children: null }));

    expect(screen.getByTestId("account")).toHaveTextContent("none / none");
  });
});
