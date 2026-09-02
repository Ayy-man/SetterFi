import { describe, expect, it } from "vitest";

import {
  canAccessWorkspace,
  decideRoute,
  hasImpersonationMarker,
  isPublicIngressPath,
  parseAppClaims,
  workspaceForRole,
  NO_CLAIMS,
  USER_ROLES,
  type AppClaims,
} from "./claims";

function claims(overrides: Partial<AppClaims>): AppClaims {
  return { ...NO_CLAIMS, ...overrides };
}

describe("parseAppClaims", () => {
  it("extracts role and tenant from app_metadata", () => {
    const parsed = parseAppClaims({
      sub: "user-1",
      app_metadata: { role: "coach", tenant_id: "tenant-1" },
    });
    expect(parsed).toEqual({
      userId: "user-1",
      role: "coach",
      tenantId: "tenant-1",
      impersonatingTenant: null,
      impersonationSessionId: null,
      affiliateAccess: false,
    });
  });

  it("extracts impersonating_tenant when present", () => {
    const parsed = parseAppClaims({
      app_metadata: { role: "success", impersonating_tenant: "tenant-9" },
    });
    expect(parsed.role).toBe("success");
    expect(parsed.impersonatingTenant).toBe("tenant-9");
  });

  it.each([null, undefined, 42, "string", [], {}])(
    "collapses %j to NO_CLAIMS",
    (input) => {
      expect(parseAppClaims(input)).toEqual(NO_CLAIMS);
    },
  );

  it("rejects roles outside the enum rather than trusting them", () => {
    const parsed = parseAppClaims({ app_metadata: { role: "superadmin", tenant_id: "t" } });
    expect(parsed.role).toBeNull();
  });

  it("treats empty-string tenant ids as absent", () => {
    const parsed = parseAppClaims({ app_metadata: { role: "coach", tenant_id: "" } });
    expect(parsed.tenantId).toBeNull();
  });

  it("accepts affiliate access only as a hook-stamped boolean", () => {
    expect(parseAppClaims({ app_metadata: { role: "coach", affiliate_access: true } })
      .affiliateAccess).toBe(true);
    for (const value of ["true", 1, {}, false, null]) {
      expect(parseAppClaims({ app_metadata: { role: "coach", affiliate_access: value } })
        .affiliateAccess).toBe(false);
    }
  });
});

describe("hasImpersonationMarker", () => {
  it("treats either claim as a read-only marker", () => {
    expect(hasImpersonationMarker({ impersonatingTenant: "tenant-1" })).toBe(true);
    expect(hasImpersonationMarker({ impersonationSessionId: "session-1" })).toBe(true);
    expect(hasImpersonationMarker({ impersonatingTenant: null, impersonationSessionId: null }))
      .toBe(false);
  });
});

describe("workspaceForRole", () => {
  it("routes every schema role to a workspace, and null to nowhere", () => {
    expect(workspaceForRole("owner")).toBe("admin");
    expect(workspaceForRole("admin")).toBe("admin");
    expect(workspaceForRole("success")).toBe("admin");
    expect(workspaceForRole("build")).toBe("admin");
    expect(workspaceForRole("coach")).toBe("coach");
    expect(workspaceForRole("coach_member")).toBe("coach");
    expect(workspaceForRole("affiliate")).toBe("affiliate");
    expect(workspaceForRole(null)).toBeNull();
  });

  it("covers the full USER_ROLES enum (guards against schema drift)", () => {
    for (const role of USER_ROLES) {
      expect(workspaceForRole(role)).not.toBeNull();
    }
  });
});

describe("canAccessWorkspace", () => {
  it("lets platform staff into the coach portal but not the reverse", () => {
    expect(canAccessWorkspace("admin", "coach")).toBe(true);
    expect(canAccessWorkspace("success", "coach")).toBe(true);
    expect(canAccessWorkspace("coach", "admin")).toBe(false);
  });

  it("keeps affiliates and coaches out of each other's workspaces", () => {
    expect(canAccessWorkspace("affiliate", "coach")).toBe(false);
    expect(canAccessWorkspace("coach", "affiliate")).toBe(false);
    expect(canAccessWorkspace("admin", "affiliate")).toBe(false);
  });

  it("lets a dual-role coach into affiliate without changing the primary workspace", () => {
    expect(canAccessWorkspace("coach", "affiliate", { affiliateAccess: true })).toBe(true);
    expect(workspaceForRole("coach")).toBe("coach");
    expect(canAccessWorkspace("coach", "admin", { affiliateAccess: true })).toBe(false);
  });

  it("denies everything for a null role", () => {
    expect(canAccessWorkspace(null, "admin")).toBe(false);
    expect(canAccessWorkspace(null, "coach")).toBe(false);
    expect(canAccessWorkspace(null, "affiliate")).toBe(false);
  });
});

describe("decideRoute", () => {
  const coach = claims({ role: "coach", tenantId: "tenant-1" });

  it("allows public prefixes without a session", () => {
    for (const path of [
      "/consumer",
      "/consumer/chat",
      "/api/consumer-agent/stream",
      "/api/webhooks/ghl",
      "/api/jobs/appointment-reconcile",
      "/login",
      "/auth/signout",
      "/signup",
      "/signup/choose-plan",
      "/opt-in/acme",
      "/api/onboarding/signup",
      "/api/onboarding/run",
      "/api/opt-in/acme/consent",
      "/api/health/live",
      "/api/health/ready",
      "/api/channels/messaging/callback",
      "/api/channels/messaging/agency-callback",
    ]) {
      expect(decideRoute(path, null)).toEqual({ kind: "allow" });
    }
  });

  // The regression this pins: the provider redirects a browser to these two paths after an
  // install approval, and that browser may hold no session of ours. While they were gated the
  // proxy answered 401 before the route ran, the single-use state stayed unconsumed, and the
  // attempt ended with nothing recorded either way.
  it("lets a signed-out browser reach the marketplace install callbacks, and only those two", () => {
    expect(decideRoute("/api/channels/messaging/callback", null)).toEqual({ kind: "allow" });
    expect(decideRoute("/api/channels/messaging/agency-callback", null)).toEqual({ kind: "allow" });
    expect(isPublicIngressPath("/api/channels/messaging/callback")).toBe(true);
    expect(isPublicIngressPath("/api/channels/messaging/agency-callback")).toBe(true);

    // Everything else under the same segment stays gated: the install starter issues a credential
    // and must know who asked, the Meta callback deliberately requires an actor, and a route added
    // under `/api/channels/messaging/` later must not inherit public reach.
    expect(decideRoute("/api/channels/ghl/install-start", null).kind).toBe("login");
    expect(decideRoute("/api/channels/meta/callback", null).kind).toBe("login");
    expect(decideRoute("/api/channels/messaging", null).kind).toBe("login");
    expect(decideRoute("/api/channels/messaging/callbackx", null).kind).toBe("login");
    expect(decideRoute("/api/channels/messaging/callback/extra", null).kind).toBe("allow");
  });

  it("allows the exact cron ingress path but no onboarding siblings", () => {
    expect(isPublicIngressPath("/api/onboarding/run")).toBe(true);
    expect(decideRoute("/api/onboarding/run", null)).toEqual({ kind: "allow" });
    expect(isPublicIngressPath("/api/onboarding/run/extra")).toBe(false);
    expect(decideRoute("/api/onboarding/run/extra", null).kind).toBe("login");
    expect(isPublicIngressPath("/api/onboarding/repair")).toBe(false);
    expect(decideRoute("/api/onboarding/repair", null).kind).toBe("login");
  });

  it("allows only the exact health endpoints without a session", () => {
    for (const path of ["/api/health/live", "/api/health/ready"]) {
      expect(isPublicIngressPath(path)).toBe(true);
      expect(decideRoute(path, null)).toEqual({ kind: "allow" });
    }
    for (const path of ["/api/health", "/api/health/live/extra", "/api/health/ready/extra", "/api/health/live-ish"]) {
      expect(isPublicIngressPath(path)).toBe(false);
      expect(decideRoute(path, null).kind).toBe("login");
    }
  });

  it("does not allow prefix look-alikes (/loginx is not /login)", () => {
    expect(decideRoute("/loginx", null).kind).toBe("login");
    expect(decideRoute("/consumerish", null).kind).toBe("login");
    expect(decideRoute("/api/webhooksx/ghl", null).kind).toBe("login");
    expect(decideRoute("/api/jobsx/run", null).kind).toBe("login");
    expect(decideRoute("/signupx", null).kind).toBe("login");
    expect(decideRoute("/opt-inx/acme", null).kind).toBe("login");
    expect(decideRoute("/api/onboarding/signupx", null).kind).toBe("login");
    expect(decideRoute("/api/opt-inx/acme", null).kind).toBe("login");
    expect(decideRoute("/api/private", null).kind).toBe("login");
  });

  it("requires a session for tenant onboarding", () => {
    expect(decideRoute("/onboarding", null)).toEqual({ kind: "login", next: "/onboarding" });
    expect(decideRoute("/onboarding/step-2", null)).toEqual({
      kind: "login",
      next: "/onboarding/step-2",
    });
  });

  it("sends anonymous users to login with the original path as next", () => {
    expect(decideRoute("/admin/brain", null)).toEqual({ kind: "login", next: "/admin/brain" });
  });

  it("treats a session with no role claim as anonymous", () => {
    expect(decideRoute("/coach", claims({ tenantId: "tenant-1" })).kind).toBe("login");
  });

  it("allows a coach into the coach workspace and blocks admin/affiliate", () => {
    expect(decideRoute("/coach/contacts", coach)).toEqual({ kind: "allow" });
    expect(decideRoute("/admin", coach)).toEqual({ kind: "forbidden", home: "coach" });
    expect(decideRoute("/affiliate/earnings", coach)).toEqual({ kind: "forbidden", home: "coach" });
  });

  it("allows hook-stamped affiliate capability while preserving the coach home", () => {
    const dualRoleCoach = claims({
      role: "coach",
      tenantId: "tenant-1",
      affiliateAccess: true,
    });
    expect(decideRoute("/affiliate", dualRoleCoach)).toEqual({ kind: "allow" });
    expect(decideRoute("/admin", dualRoleCoach)).toEqual({ kind: "forbidden", home: "coach" });
  });

  it("lets platform staff open both admin and coach workspaces", () => {
    const success = claims({ role: "success" });
    expect(decideRoute("/admin/coaches", success)).toEqual({ kind: "allow" });
    expect(decideRoute("/coach/conversations", success)).toEqual({ kind: "allow" });
    expect(decideRoute("/affiliate", success)).toEqual({ kind: "forbidden", home: "admin" });
  });

  it("matches workspace segments exactly (/administrator is not /admin)", () => {
    expect(decideRoute("/administrator", coach)).toEqual({ kind: "allow" });
  });

  it("allows signed-in users onto non-workspace paths", () => {
    expect(decideRoute("/", coach)).toEqual({ kind: "allow" });
  });
});
