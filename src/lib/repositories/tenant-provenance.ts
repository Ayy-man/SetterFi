import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * What a workspace's rows are: a real business's, or a seeded demo's.
 *
 * The hard rule is that demo and test data are labelled where a coach can see them, and every
 * coach surface that shows figures already satisfies it by carrying the provenance its own read
 * returns -- `coach-measurement.tsx:1277` reads it off the measurement, `coach-contacts.tsx` off
 * the contact page's `tenants!inner(is_demo)` join. Setup was the exception, and not because
 * nobody thought about labelling: it labels a *different* fact. Its head prints "Sample setup
 * records" when the hosted consent artifact is a placeholder, which answers "is this filing real",
 * while nothing on the page answered "is this workspace real". A seeded tenant whose artifact
 * happens to be genuine got no label at all, on the one screen whose entire subject is whether the
 * account is live yet.
 *
 * So this is its own read rather than another join: setup has no figures to hang a provenance off,
 * because its content is provisioning state rather than analytics.
 *
 * ## The null arm is the point, not a fallback
 *
 * A failed read returns `null` and the caller says so in words. It deliberately does not return
 * `"real"`, which is the shape a `catch` naturally wants: "we could not read this" and "this is a
 * real business's data" are different claims, and collapsing them would print the reassuring one
 * on no evidence -- an invented affirmative, which is exactly what the grounding rule forbids
 * everywhere else in this product. Note the failure is silent from PostgREST's side: a denied or
 * broken select resolves with `{ error }` rather than throwing, so the `error` branch does the
 * work here and the `catch` only covers the transport.
 *
 * The read is `tenants.select("is_demo")` on the signed-in tenant through the *user* client, so
 * RLS applies and a coach can only ever resolve their own workspace. The same row is already
 * readable to them through the contacts and conversations joins, so nothing new is exposed.
 */
export type TenantProvenance = "demo" | "real";

export async function loadTenantProvenance(
  tenantId: string,
): Promise<TenantProvenance | null> {
  if (!tenantId.trim()) return null;
  try {
    const client = await createSupabaseServerClient();
    const { data, error } = await client
      .from("tenants")
      .select("is_demo")
      .eq("id", tenantId)
      .maybeSingle();
    if (error || !data) return null;
    /*
     * Only a literal `true` counts as demo, and only a literal `false` counts as real. Anything
     * else is not evidence that the workspace is real -- it is evidence that the column did not
     * answer -- so it goes to the unknown arm rather than being read as `false`.
     *
     * That third branch is defensive rather than reachable today: `tenants.is_demo` is
     * `boolean not null default false` (`20260817000001_phase1_demo_path.sql:784`), so every row
     * carries a real boolean from the moment it is inserted. Which is also why a brand-new
     * workspace with nothing provisioned resolves cleanly to "real" rather than to unknown -- the
     * flag is set at tenant creation and does not wait on any step of the setup journey.
     */
    if (data.is_demo === true) return "demo";
    if (data.is_demo === false) return "real";
    return null;
  } catch {
    return null;
  }
}
