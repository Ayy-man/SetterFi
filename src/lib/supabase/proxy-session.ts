import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

import { parseAppClaims, type AppClaims } from "@/lib/auth/claims";

/**
 * Proxy-side session handling (the @supabase/ssr middleware pattern): binds a
 * client to the request/response cookie pair so expired sessions refresh on
 * any request, then validates the JWT and extracts the hook-stamped claims.
 *
 * Returns claims=null for anonymous or invalid sessions. The response object
 * must be the one ultimately returned (or its cookies copied onto a redirect)
 * or the refreshed tokens are lost and users get logged out at random.
 */
export async function loadProxySession(
  request: NextRequest,
): Promise<{ response: NextResponse; claims: AppClaims | null }> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // getClaims() validates the token (not just decodes it) and returns the
  // claims the access-token hook stamped — user.app_metadata from getUser()
  // would NOT include them, since the hook rewrites the JWT, not the user row.
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return { response, claims: null };

  return { response, claims: parseAppClaims(data.claims) };
}

/** Redirect that keeps the refreshed session cookies from `from`. */
export function redirectPreservingCookies(from: NextResponse, to: URL): NextResponse {
  const redirect = NextResponse.redirect(to);
  from.cookies.getAll().forEach((cookie) => redirect.cookies.set(cookie));
  return redirect;
}
