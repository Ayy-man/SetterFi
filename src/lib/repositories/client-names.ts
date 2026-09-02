import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Display names for a set of tenant ids, batched into one read.
 *
 * The platform measurement snapshot carries tenant ids and no names, so Agent performance and the
 * platform subscriptions table used to invent "Client 1 / 2 / 3" from the row index and ship
 * placeholder identity strings to a client demo. This is the same `tenants.select("id,name")` read
 * the channel-health page already does, so nothing new is exposed: it runs server-side, only the
 * resolved names cross into the client component, and a failed read returns an empty map rather
 * than a wrong name.
 *
 * The demo marker comes from the seeded name itself (`"… (demo)"`), never from `is_demo`, so the
 * label on screen is exactly the label stored.
 */
export async function loadClientNames(
  tenantIds: readonly string[],
): Promise<Readonly<Record<string, string>>> {
  const unique = [...new Set(tenantIds.filter((id) => id.trim().length > 0))];
  if (unique.length === 0) return {};
  try {
    const { data, error } = await createSupabaseServiceClient()
      .from("tenants")
      .select("id,name")
      .in("id", unique);
    if (error || !data) return {};
    return Object.fromEntries(
      data.flatMap((row) => {
        const id = typeof row.id === "string" ? row.id : String(row.id ?? "");
        const name = typeof row.name === "string" ? row.name.trim() : "";
        return id && name ? [[id, name] as const] : [];
      }),
    );
  } catch {
    return {};
  }
}
