import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { createProxy } from "./proxy";

function request(path: string) {
  return new NextRequest(`https://setterfi.test${path}`);
}

describe("Phase 5 proxy allowlist", () => {
  const publicPaths = [
    "/signup",
    "/opt-in/acme",
    "/api/onboarding/signup",
    "/api/opt-in/acme/consent",
  ];

  it.each(publicPaths)("allows %s through password mode", async (path) => {
    const passwordAuthorized = vi.fn().mockResolvedValue(false);
    const handler = createProxy({
      mode: () => "password",
      loadSession: vi.fn(),
      password: () => "configured",
      passwordAuthorized,
    });

    const response = await handler(request(path));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(passwordAuthorized).not.toHaveBeenCalled();
  });

  it("does not exempt tenant onboarding from password mode", async () => {
    const handler = createProxy({
      mode: () => "password",
      loadSession: vi.fn(),
      password: () => "configured",
      passwordAuthorized: vi.fn().mockResolvedValue(false),
    });

    const response = await handler(request("/onboarding"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://setterfi.test/access?next=%2Fonboarding");
  });

  it.each(publicPaths)("allows %s through Supabase mode without claims", async (path) => {
    const handler = createProxy({
      mode: () => "supabase",
      loadSession: vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null }),
      password: () => null,
      passwordAuthorized: vi.fn(),
    });

    const response = await handler(request(path));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("requires authentication for tenant onboarding in Supabase mode", async () => {
    const handler = createProxy({
      mode: () => "supabase",
      loadSession: vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null }),
      password: () => null,
      passwordAuthorized: vi.fn(),
    });

    const response = await handler(request("/onboarding"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://setterfi.test/login?next=%2Fonboarding");
  });

  it("wraps the Supabase login in the shared gate for an explicit production demo review", async () => {
    const loadSession = vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null });
    const unauthorized = createProxy({
      mode: () => "supabase",
      loadSession,
      password: () => "configured",
      passwordAuthorized: vi.fn().mockResolvedValue(false),
      productionDemoAccessEnabled: () => true,
    });

    const response = await unauthorized(request("/login"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://setterfi.test/access?next=%2Flogin");
    expect(loadSession).not.toHaveBeenCalled();

    const authorized = createProxy({
      mode: () => "supabase",
      loadSession,
      password: () => "configured",
      passwordAuthorized: vi.fn().mockResolvedValue(true),
      productionDemoAccessEnabled: () => true,
    });
    const allowed = await authorized(request("/login"));
    expect(allowed.headers.get("x-middleware-next")).toBe("1");
    expect(loadSession).toHaveBeenCalledOnce();
  });

  /**
   * The two marketplace install callbacks, exercised through the whole proxy rather than through
   * `decideRoute` alone (`src/lib/auth/claims.test.ts` already pins that layer).
   *
   * Until 2026-08-28 (`1bfbfe6`) neither path was in `PUBLIC_PREFIXES`, so the provider's redirect
   * — a browser with no setter-fi session — got a 401 from the proxy and the route never ran: 15 of
   * 17 install attempts died there with no completed, failed, or declined row. The unit guard on
   * `decideRoute` would have caught a regression in that function, but not in any of the three
   * other ways this handler can refuse before reaching it (health short-circuit, production demo
   * gate, password mode), so the assertion has to be made on `createProxy` itself, in both modes,
   * with the exact request shape the provider sends: a signed-out GET carrying `state` and `code`.
   *
   * Mutation this was proved against (2026-09-02): deleting one callback path from
   * `PUBLIC_PREFIXES` in `claims.ts` reds this test with `expected 401 to be 200`, in both modes.
   */
  it.each(["password", "supabase"] as const)(
    "lets the provider's signed-out install redirect reach both marketplace callbacks in %s mode",
    async (mode) => {
      const handler = createProxy({
        mode: () => mode,
        loadSession: vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null }),
        password: () => mode === "password" ? "configured" : null,
        passwordAuthorized: vi.fn().mockResolvedValue(false),
      });
      for (const path of [
        "/api/channels/messaging/callback",
        "/api/channels/messaging/agency-callback",
      ]) {
        const response = await handler(request(`${path}?state=issued-by-us&code=provider-code`));
        expect(response.status, path).toBe(200);
        expect(response.headers.get("x-middleware-next"), path).toBe("1");
      }
      // The unauthenticated *starter* stays gated: it issues the state, so it must know who asked.
      const starter = await handler(request("/api/channels/ghl/install-start"));
      expect(starter.status).toBe(401);
    },
  );

  it.each(["password", "supabase"] as const)("admits only exact health paths in %s mode", async (mode) => {
    const resolveMode = vi.fn(() => mode);
    const loadSession = vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null });
    const password = vi.fn(() => mode === "password" ? "configured" : null);
    const passwordAuthorized = vi.fn().mockResolvedValue(false);
    const handler = createProxy({
      mode: resolveMode,
      loadSession,
      password,
      passwordAuthorized,
    });

    for (const path of ["/api/health/live", "/api/health/ready"]) {
      const response = await handler(request(path));
      expect(response.headers.get("x-middleware-next"), path).toBe("1");
    }
    expect(resolveMode).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
    expect(password).not.toHaveBeenCalled();
    expect(passwordAuthorized).not.toHaveBeenCalled();
    for (const path of [
      "/api/health",
      "/api/health/live/extra",
      "/api/health/ready/extra",
      "/api/health/live-ish",
    ]) {
      const response = await handler(request(path));
      expect(response.status, path).toBe(401);
    }
  });
});
