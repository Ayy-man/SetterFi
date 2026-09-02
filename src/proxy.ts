import { NextResponse, type NextRequest } from "next/server";

import { ACCESS_COOKIE, accessPassword, isAuthorized } from "@/lib/access";
import { decideRoute, isHealthCheckPath, isPublicIngressPath, type AppClaims } from "@/lib/auth/claims";
import { authMode } from "@/lib/auth/mode";
import { productionDemoLoginsEnabled, publicLandingLive } from "@/lib/env-contract";
import { loadProxySession, redirectPreservingCookies } from "@/lib/supabase/proxy-session";

/**
 * Runs ahead of the cache on every matched request, including the prerendered
 * workspace screens. That ordering is the point: statically rendered admin pages
 * can serve from cache, so a gate that lived in the page component would be
 * bypassed by the very first cache hit. The proxy is the only layer that sees
 * every request for a static route. (Next 16 renamed this convention from
 * `middleware` to `proxy`; same execution position.)
 */
const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function withSecurityHeaders(response: NextResponse) {
  for (const [header, value] of Object.entries(securityHeaders)) {
    response.headers.set(header, value);
  }
  return response;
}

/**
 * Supabase auth mode (B3): real per-user sessions instead of the shared demo
 * password. Env-gated per deployment (see lib/auth/mode.ts), so enabling it on
 * staging cannot change production's behavior.
 */
type ProxyDependencies = {
  mode(): "open" | "password" | "supabase";
  loadSession(request: NextRequest): Promise<{ response: NextResponse; claims: AppClaims | null }>;
  password(): string | null;
  passwordAuthorized(request: NextRequest, password: string): Promise<boolean>;
  productionDemoAccessEnabled?(): boolean;
  /**
   * Whether `/` is the public marketing page rather than the gated role picker. Injected rather
   * than read from the environment here for the same reason every other gate in this object is:
   * a reachability rule that can only be exercised by mutating `process.env` is a rule nobody
   * writes a test for.
   */
  publicLanding?(): boolean;
};

async function supabaseGate(
  request: NextRequest,
  loadSession: ProxyDependencies["loadSession"],
  publicLanding = false,
) {
  const { response, claims } = await loadSession(request);
  const { pathname } = request.nextUrl;

  // The marketing page, when it is the thing `/` serves. It is one exact path rather than a
  // prefix in `PUBLIC_PREFIXES`, because `/` as a prefix would open the whole app: every route in
  // it starts with a slash. Keeping it here also keeps `isPublicPath` a pure function of the
  // path, which is what lets the rest of the public inventory stay a plain list.
  if (publicLanding && pathname === "/") return withSecurityHeaders(response);

  const decision = decideRoute(pathname, claims);

  if (decision.kind === "allow") return withSecurityHeaders(response);

  if (pathname.startsWith("/api/")) {
    return withSecurityHeaders(
      NextResponse.json({ error: "Authentication required." }, { status: 401 }),
    );
  }

  const target = request.nextUrl.clone();
  target.search = "";
  if (decision.kind === "login") {
    target.pathname = "/login";
    target.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  } else {
    // Signed in but wrong workspace: send them home rather than to a dead end.
    target.pathname = decision.home ? `/${decision.home}` : "/login";
  }
  return withSecurityHeaders(redirectPreservingCookies(response, target));
}

export function createProxy(dependencies: ProxyDependencies) {
  return async function proxyHandler(request: NextRequest) {
    // These exact deployment probes must survive broken auth configuration. In particular,
    // liveness cannot load a session or consult any environment-backed gate merely to say that the
    // process can answer HTTP; readiness performs its own bounded checks inside the route.
    if (isHealthCheckPath(request.nextUrl.pathname)) {
      return withSecurityHeaders(NextResponse.next());
    }

    const mode = dependencies.mode();
    const password = dependencies.password();

    const publicLanding = dependencies.publicLanding?.() ?? false;

    if (mode === "supabase" && !dependencies.productionDemoAccessEnabled?.()) {
      return supabaseGate(request, dependencies.loadSession, publicLanding);
    }

  // No password configured: the demo stays open exactly as it is today, and the
  // only change is that responses now carry security headers.
    if (!password) {
      return mode === "supabase"
        ? supabaseGate(request, dependencies.loadSession, publicLanding)
        : withSecurityHeaders(NextResponse.next());
    }

    const { pathname } = request.nextUrl;
    const productionDemoLogin = mode === "supabase"
      && dependencies.productionDemoAccessEnabled?.()
      && pathname === "/login";
    if (isPublicIngressPath(pathname) && !productionDemoLogin) {
      return withSecurityHeaders(NextResponse.next());
    }
    if (pathname === "/access" || pathname === "/api/access") {
      return withSecurityHeaders(NextResponse.next());
    }
    // The same allowance under the shared-password gate. A marketing page behind a password prompt
    // is the same non-door as one behind a login, and leaving it out here would mean the flag did
    // something different depending on which gate the deployment happens to run.
    if (publicLanding && pathname === "/") {
      return withSecurityHeaders(NextResponse.next());
    }

    if (await dependencies.passwordAuthorized(request, password)) {
      return mode === "supabase"
        ? supabaseGate(request, dependencies.loadSession, publicLanding)
        : withSecurityHeaders(NextResponse.next());
    }

  // API routes get a status, not a redirect — a fetch following a 307 to an HTML
  // login page produces a confusing parse error rather than a clear refusal.
    if (pathname.startsWith("/api/")) {
      return withSecurityHeaders(
        NextResponse.json({ error: "This deployment is password protected." }, { status: 401 }),
      );
    }

    const target = request.nextUrl.clone();
    target.pathname = "/access";
    target.search = "";
    // Carry the original path so a shared deep link survives the password prompt.
    target.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return withSecurityHeaders(NextResponse.redirect(target));
  };
}

export const proxy = createProxy({
  mode: authMode,
  loadSession: loadProxySession,
  password: accessPassword,
  passwordAuthorized: (request, password) =>
    isAuthorized(request.cookies.get(ACCESS_COOKIE)?.value, password),
  productionDemoAccessEnabled: productionDemoLoginsEnabled,
  publicLanding: publicLandingLive,
});

export const config = {
  matcher: [
    // Everything except Next's own build output, the favicon, and static files —
    // matching those would gate the CSS and JS the login page itself needs.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
