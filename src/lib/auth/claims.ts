/**
 * JWT claim parsing and workspace routing rules — the app-side half of the auth
 * model. The database half (RLS policies, the access-token hook that stamps
 * these claims) lives in supabase/migrations; this module is the single place
 * the app interprets what a token is allowed to see. Pure functions, no I/O,
 * so the whole access matrix is unit-testable.
 */

import type { WorkspaceRole } from "@/lib/workspace-navigation";

/** Mirrors the `user_role` enum in the schema. */
export const USER_ROLES = [
  "owner",
  "admin",
  "success",
  "build",
  "coach",
  "coach_member",
  "affiliate",
] as const;

export type UserRole = (typeof USER_ROLES)[number];

/**
 * The roles that may *read* platform-wide provisioning state. Distinct from the mutating set the
 * provisioning route keeps, which excludes `build`: a build user can look at the tracker and cannot
 * retry a step on it. Declared here, and only here, because the route, the tracker repository, and
 * the attempts view model all gate the same surface and cannot be allowed to disagree about it.
 */
export const PLATFORM_ROLES: readonly UserRole[] = ["owner", "admin", "success", "build"];

export type AppClaims = {
  userId: string | null;
  role: UserRole | null;
  tenantId: string | null;
  impersonatingTenant: string | null;
  impersonationSessionId: string | null;
  affiliateAccess?: boolean;
};

export type ImpersonationMarker = {
  impersonatingTenant?: string | null;
  impersonationSessionId?: string | null;
};

/** A partially refreshed token is read-only when either hook-stamped marker remains. */
export function hasImpersonationMarker(claims: ImpersonationMarker): boolean {
  return Boolean(claims.impersonatingTenant || claims.impersonationSessionId);
}

export const NO_CLAIMS: AppClaims = {
  userId: null,
  role: null,
  tenantId: null,
  impersonatingTenant: null,
  impersonationSessionId: null,
  affiliateAccess: false,
};

/**
 * Reads the hook-stamped `app_metadata` out of a decoded JWT claims object.
 * Unknown or missing values collapse to null — the same deny-by-default
 * direction the RLS helpers take (`app.current_tenant_id()` resolves NULL).
 */
export function parseAppClaims(claims: unknown): AppClaims {
  if (typeof claims !== "object" || claims === null) return NO_CLAIMS;
  const raw = claims as { sub?: unknown; app_metadata?: unknown };
  const meta = raw.app_metadata;
  if (typeof meta !== "object" || meta === null) return NO_CLAIMS;

  const {
    role, tenant_id, impersonating_tenant, impersonation_session_id, affiliate_access,
  } = meta as Record<string, unknown>;
  return {
    userId: typeof raw.sub === "string" && raw.sub ? raw.sub : null,
    role: USER_ROLES.includes(role as UserRole) ? (role as UserRole) : null,
    tenantId: typeof tenant_id === "string" && tenant_id ? tenant_id : null,
    impersonatingTenant:
      typeof impersonating_tenant === "string" && impersonating_tenant
        ? impersonating_tenant
        : null,
    impersonationSessionId:
      typeof impersonation_session_id === "string" && impersonation_session_id
        ? impersonation_session_id
        : null,
    affiliateAccess: affiliate_access === true,
  };
}

/**
 * Which workspace a role lands in. Platform staff share the admin console
 * (their differences are enforced inside it and by RLS, not by URL); coaches
 * and their members share the coach portal; affiliates get theirs.
 */
export function workspaceForRole(role: UserRole | null): WorkspaceRole | null {
  switch (role) {
    case "owner":
    case "admin":
    case "success":
    case "build":
      return "admin";
    case "coach":
    case "coach_member":
      return "coach";
    case "affiliate":
      return "affiliate";
    default:
      return null;
  }
}

export function canAccessWorkspace(
  role: UserRole | null,
  workspace: WorkspaceRole,
  capabilities: { affiliateAccess?: boolean } = {},
): boolean {
  // Platform staff may open the coach portal (support walks a coach's screens),
  // but nobody crosses INTO admin or affiliate from outside their own role set.
  const home = workspaceForRole(role);
  if (home === workspace) return true;
  if (workspace === "affiliate" && capabilities.affiliateAccess === true) return true;
  return home === "admin" && workspace === "coach";
}

/**
 * Paths that stay reachable without a session under Supabase auth mode:
 * the lead-facing consumer chat, public opt-in and signup surfaces, their APIs,
 * and the login/auth pair. Tenant onboarding itself requires a live session.
 */
const PUBLIC_PREFIXES = [
  // The static marketing site that `/` rewrites to when the public landing is live.
  "/site",
  "/consumer",
  "/api/consumer-agent",
  "/api/webhooks",
  "/api/jobs",
  "/login",
  "/auth",
  // Phase 5
  "/signup",
  "/opt-in",
  "/api/onboarding/signup",
  "/api/opt-in",
  // Phase 9. The provider redirects a browser here after approval, and that browser is not
  // guaranteed to carry our session: an install link opened from a mail client, a different
  // profile, or a session that lapsed during approval all arrive signed out. Gating them here
  // answered 401 before the route ran, so the single-use state was never consumed and the install
  // ended with no completion, failure, or decline recorded anywhere. Neither route reads a session
  // at all — the state is the whole of their authentication — so the gate bought nothing.
  // Listed as exact paths, not the `/api/channels/messaging` prefix, so a route added under that
  // segment later does not become public by inheritance.
  "/api/channels/messaging/callback",
  "/api/channels/messaging/agency-callback",
];

// Vercel cron sends the CRON_SECRET bearer directly to this exact route. Its route-local handler
// fails closed before any provisioning query when that bearer is absent or invalid, so this grants
// only proxy ingress, never permission to advance provisioning.
const HEALTH_CHECK_PATHS = [
  "/api/health/live",
  "/api/health/ready",
] as const;

const PUBLIC_EXACT_PATHS = [
  "/api/onboarding/run",
  ...HEALTH_CHECK_PATHS,
];

export function isHealthCheckPath(pathname: string) {
  return (HEALTH_CHECK_PATHS as readonly string[]).includes(pathname);
}

function isPublicPath(pathname: string) {
  return PUBLIC_EXACT_PATHS.includes(pathname)
    || PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export function isPublicIngressPath(pathname: string) {
  return isPublicPath(pathname);
}

export type RouteDecision =
  | { kind: "allow" }
  | { kind: "login"; next: string }
  | { kind: "forbidden"; home: WorkspaceRole | null };

/**
 * The proxy-level decision for a request under Supabase auth mode.
 * `claims` is null when there is no (valid) session.
 */
export function decideRoute(pathname: string, claims: AppClaims | null): RouteDecision {
  if (isPublicPath(pathname)) {
    return { kind: "allow" };
  }

  if (!claims || !claims.role) {
    return { kind: "login", next: pathname };
  }

  const workspaceMatch = pathname.match(/^\/(admin|coach|affiliate)(\/|$)/);
  if (workspaceMatch) {
    const workspace = workspaceMatch[1] as WorkspaceRole;
    if (!canAccessWorkspace(claims.role, workspace, {
      affiliateAccess: claims.affiliateAccess,
    })) {
      return { kind: "forbidden", home: workspaceForRole(claims.role) };
    }
  }

  return { kind: "allow" };
}
