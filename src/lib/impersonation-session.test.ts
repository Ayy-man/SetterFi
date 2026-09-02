import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMode, resolveActiveImpersonationSession, serverClient, serviceClient, tables } =
  vi.hoisted(() => {
    const tables: Record<string, { data: unknown; error: unknown }> = {};
    const getClaims = vi.fn();
    return {
      authMode: vi.fn(),
      resolveActiveImpersonationSession: vi.fn(),
      tables,
      serverClient: { auth: { getClaims } },
      serviceClient: {
        from: (table: string) => ({
          select: () => ({
            eq: () => ({
              maybeSingle: async () =>
                tables[table] ?? { data: null, error: { message: "NO_FIXTURE" } },
            }),
          }),
        }),
      },
    };
  });

vi.mock("@/lib/auth/mode", () => ({ authMode }));
vi.mock("@/lib/auth/actors", () => ({ resolveActiveImpersonationSession }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => serverClient,
  createSupabaseServiceClient: () => serviceClient,
}));

import { loadImpersonationSessionBanner } from "./impersonation-session";

const ACTOR = "72000000-0000-4000-8000-000000000009";
const SESSION = "a1000000-0000-4000-8000-000000000001";
const TENANT = "b1000000-0000-4000-8000-000000000002";

function signedIn(role = "success") {
  serverClient.auth.getClaims.mockResolvedValue({
    data: { claims: { sub: ACTOR, app_metadata: { role, impersonating_tenant: TENANT } } },
    error: null,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authMode.mockReturnValue("supabase");
  resolveActiveImpersonationSession.mockResolvedValue({ id: SESSION, tenantId: TENANT });
  signedIn();
  tables.impersonation_sessions = {
    data: { started_at: "2026-09-01T10:00:00.000Z", expires_at: "2026-09-01T10:30:00.000Z" },
    error: null,
  };
  tables.tenants = { data: { name: "Reid Funding Group" }, error: null };
  tables.users = { data: { full_name: "Dana Whitlock", role: "success" }, error: null };
});

/**
 * The read behind the band that says whose workspace an operator is standing in.
 *
 * What is worth pinning here is not the happy path -- it is the three places where returning
 * *something* would be worse than returning nothing, because each one would put a control on
 * screen that cannot do what it claims.
 */
describe("loadImpersonationSessionBanner", () => {
  it("resolves the band from the live session row", async () => {
    expect(await loadImpersonationSessionBanner()).toEqual({
      expiresAt: "2026-09-01T10:30:00.000Z",
      operator: { name: "Dana Whitlock", role: "client success" },
      sessionId: SESSION,
      startedAt: "2026-09-01T10:00:00.000Z",
      tenantName: "Reid Funding Group",
    });
  });

  /**
   * The id the banner posts is the id the end route accepts, and nothing else.
   *
   * `createImpersonationEndHandler` refuses any `sessionId` that is not the actor's active session
   * as resolved from `impersonation_sessions`. Reading the id from the claims instead would be one
   * fewer query and would render a "Leave this workspace" button whose only possible outcome, on a
   * session already ended in another tab, is a 409. So the claim's own session id is deliberately
   * not the source: this asserts the banner carries the resolver's id even when they disagree.
   */
  it("takes the session id from the active-session resolver, not from the claims", async () => {
    serverClient.auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: ACTOR,
          app_metadata: {
            role: "success",
            impersonating_tenant: TENANT,
            impersonation_session_id: "a stale id from a session that already ended",
          },
        },
      },
      error: null,
    });

    expect((await loadImpersonationSessionBanner())?.sessionId).toBe(SESSION);
  });

  it("renders no band when no session is active", async () => {
    resolveActiveImpersonationSession.mockResolvedValue(null);
    expect(await loadImpersonationSessionBanner()).toBeNull();
  });

  /**
   * "You are viewing 8f3a-...'s workspace" names nobody, and the sentence is the whole point of
   * the band. The database refuses the writes either way, so the honest failure is no band.
   */
  it("refuses to announce a workspace it cannot name", async () => {
    tables.tenants = { data: { name: "   " }, error: null };
    expect(await loadImpersonationSessionBanner()).toBeNull();
  });

  /** A caller that cannot resolve a person prints nothing rather than a raw id or an enum value. */
  it("omits the operator line rather than printing an unnamed one", async () => {
    tables.users = { data: { full_name: null, role: "success" }, error: null };
    expect((await loadImpersonationSessionBanner())?.operator).toBeUndefined();
  });

  it("gives each impersonating role a capacity a coach would recognise", async () => {
    for (const [role, label] of [
      ["owner", "platform owner"],
      ["admin", "platform admin"],
      ["success", "client success"],
    ] as const) {
      tables.users = { data: { full_name: "Dana Whitlock", role }, error: null };
      expect((await loadImpersonationSessionBanner())?.operator?.role).toBe(label);
    }
  });

  it("skips the read entirely outside real auth", async () => {
    authMode.mockReturnValue("open");
    expect(await loadImpersonationSessionBanner()).toBeNull();
    expect(resolveActiveImpersonationSession).not.toHaveBeenCalled();
  });

  /**
   * A failed read must not take the workspace down with it. Every page under `(workspace)` renders
   * through this, so a throw here is a blank product, and it would be a blank product on the one
   * surface whose enforcement (Postgres refusing the write) is unaffected by the failure.
   */
  it("returns no band rather than throwing when the session read fails", async () => {
    resolveActiveImpersonationSession.mockRejectedValue(new Error("RESOLUTION_FAILED"));
    await expect(loadImpersonationSessionBanner()).resolves.toBeNull();
  });
});
