/**
 * The refusals all four Google calendar routes share, in one place so they cannot drift apart.
 *
 * The order matches `src/app/api/onboarding/calendar/handler.ts` exactly, and it is deliberate: an
 * impersonated admin sitting in a coach's account is refused as impersonation rather than as a role
 * problem, because that is the more serious of the two and the one an auditor needs named.
 */

import type { RouteActor } from "@/lib/auth/actors";
import { hasImpersonationMarker } from "@/lib/auth/claims";

export const NO_STORE = { "Cache-Control": "no-store" };

/** Flag off is a 404 and never a redirect: an unarmed route does not exist to the browser. */
export function notFound() {
  return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
}

export function refuseActor(actor: RouteActor | null) {
  if (!actor) {
    return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
  }
  if (hasImpersonationMarker(actor)) {
    return Response.json(
      { error: "Impersonated sessions are read-only." },
      { status: 403, headers: NO_STORE },
    );
  }
  if (actor.role !== "coach") {
    return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
  }
  return null;
}

/**
 * An allow-list on the keys, not just on the values. A body carrying an extra key is a caller that
 * believes it can set something this route does not offer, and answering 400 says so rather than
 * silently ignoring it.
 */
export function exactKeys(value: unknown, allowed: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !allowed.includes(key))) return null;
  return body;
}

export function trimmed(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
