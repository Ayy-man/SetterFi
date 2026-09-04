/**
 * The coach's own account profile fields with nowhere else to be read from.
 *
 * Round 3 backend gap: the Settings page states "Sent to the address on your account" but no
 * coach-reachable read returned that address -- `AppClaims` carries no email, and
 * `users_self_read` (20260813000001_init.sql:871) exists for the user-context RLS client, not the
 * service-role reads every route handler in this repository set uses. This module reads through
 * the service client the same way `coach-notification-preference.ts` does, re-imposing both the
 * actor id and the tenant id as explicit predicates rather than relying on RLS, per the
 * engineering brief's "service_role bypasses RLS" rule.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type CoachOwnProfileSource = (input: {
  userId: string;
  tenantId: string;
}) => Promise<{ email: unknown } | null>;

async function liveCoachOwnProfile(
  input: { userId: string; tenantId: string },
): Promise<{ email: unknown } | null> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client
    .from("users")
    .select("email")
    .eq("id", input.userId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (error) throw new Error(`COACH_OWN_PROFILE_READ_FAILED:${error.message}`);
  return data;
}

/**
 * Null on a missing or cross-tenant actor (never an error at this boundary -- the route decides
 * what that means), so a caller cannot receive an email for a user it did not ask about.
 */
export async function readCoachOwnEmail(
  actor: { userId: string; tenantId: string },
  source: CoachOwnProfileSource = liveCoachOwnProfile,
): Promise<string | null> {
  const userId = actor.userId?.trim();
  const tenantId = actor.tenantId?.trim();
  if (!userId) throw new Error("COACH_PROFILE_ACTOR_REQUIRED");
  if (!tenantId) throw new Error("EXPECTED_TENANT_REQUIRED");
  const row = await source({ userId, tenantId });
  if (!row) return null;
  if (typeof row.email !== "string" || !row.email.trim()) {
    throw new Error("COACH_OWN_PROFILE_INVALID");
  }
  return row.email;
}
