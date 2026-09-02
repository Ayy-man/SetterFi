import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { COACH_INBOX_HREF, type WorkspaceNavCounts } from "@/lib/workspace-navigation";

type CountResult = { count: number | null; error: unknown };

/** The narrow slice of the service client this read uses, so a test can hand one over. */
export type NeedsYouCountSource = {
  from: (table: string) => {
    select: (columns: string, options: { count: "exact"; head: true }) => {
      eq: (column: string, value: string) => {
        eq: (column: string, value: string) => PromiseLike<CountResult>;
      };
    };
  };
};

/**
 * The needs-you depth the coach pill bar carries, read once per request.
 *
 * `Main.dc.html`, `Inbox.dc.html` and `Agent.dc.html` all draw an amber count on the Inbox pill,
 * and it is the load-bearing half of the canvas's decision to take the amber attention card off
 * Home: with the card gone and no count in the shell, a coach has no needs-you signal anywhere in
 * the product. That only holds if the count is on every coach route, so every coach page reads it
 * from here instead of deriving one of its own.
 *
 * The predicate is deliberately the Inbox's own -- every conversation in the tenant whose status
 * is `needs_human`, test rows included, which is what `coach-conversations.tsx` counts off the
 * list it renders. `coach/agent/page.tsx`'s `loadCoachEscalations` excludes test rows, which is
 * right for the attention card (a seeded row must not inflate a real coach's queue) and wrong
 * here: on the seeded demo tenant every row is a test row, so a test-excluded pill would read
 * nothing while the Inbox lists threads under "Waiting on you".
 *
 * A failed read returns no count rather than a zero. Zero is the claim that nothing is waiting,
 * and a query that did not answer has not established it.
 */
export async function coachNavCounts(
  tenantId: string,
  client: NeedsYouCountSource = createSupabaseServiceClient() as unknown as NeedsYouCountSource,
): Promise<WorkspaceNavCounts> {
  const { count, error } = await client
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "needs_human");
  if (error || typeof count !== "number") return {};
  return { [COACH_INBOX_HREF]: count };
}
