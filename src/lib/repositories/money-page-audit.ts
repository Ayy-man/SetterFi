/**
 * The audit receipt for a real role-boundary refusal on an admin Money page.
 *
 * `MoneySurfaceGuard` draws two different refusals and only one of them is a security-relevant
 * event: `!enabled` means the billing feature flag is off for everybody, including the owner --
 * nobody was refused anything. `!authorized` means a signed-in role hit
 * `moneyPageAccessStatus`'s real boundary, which is exactly the signal worth keeping if that
 * boundary is being probed. Callers must call `logMoneyPageRefusal` only for the second case; the
 * first has nothing to log, and that is the entire mechanism that keeps the two refusals
 * distinguishable in the audit trail -- one of them can produce a `money.page.refused` row, the
 * other structurally cannot.
 *
 * The RPC re-verifies the role boundary itself against `public.users` rather than trusting this
 * call's premise, so a caller cannot forge a refusal receipt for an actor who was actually
 * authorized. See `20261004000001_money_page_refusal_audit.sql`.
 *
 * ## Why this function returns instead of returning nothing
 *
 * It used to swallow every failure into a bare `catch {}` and return `void`, and the panel said
 * "Logged: this attempt is on the audit trail" unconditionally on the strength of that. On
 * 2026-09-01 a `supabase migration list --linked` run by hand showed `20261004000001` had never
 * been applied to the hosted project: `record_money_page_refusal` did not exist there, every call
 * failed, the `catch` ate it, and the live deployment told refused operators their attempt was
 * recorded when no row was ever written. It had been doing that since the copy landed.
 *
 * The missing function is the occasion; the swallow is the defect. A security surface that cannot
 * see whether its own audit write succeeded can never tell the truth about itself -- after the
 * migration lands it would fail the same silent way on a permissions error, a statement timeout or
 * a rename, with the same confident sentence on screen. So the outcome now reaches the caller and
 * the panel states what actually happened.
 *
 * The two properties that made the old swallow right are both kept: this still never throws, so a
 * broken audit path cannot turn a permission refusal into a server error, and the refusal panel
 * still renders either way. What changes is that the panel stops claiming a receipt it does not
 * have, and the failure is no longer invisible on the server.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

import type { AdminMoneySurface } from "@/components/workspace/live/view-models";

/**
 * Whether the `money.page.refused` row was actually written.
 *
 * Two states rather than three: the panel's reader does not care why the write failed, only
 * whether their attempt is on the trail. The why goes to the server log, where an operator can
 * act on it.
 */
export type MoneyRefusalRecord = "recorded" | "not-recorded";

/**
 * Writes the `money.page.refused` audit row and says whether it landed. Never throws.
 */
export async function logMoneyPageRefusal(
  actorId: string,
  surface: AdminMoneySurface,
): Promise<MoneyRefusalRecord> {
  try {
    const client = createSupabaseServiceClient();
    const { error } = await client.rpc("record_money_page_refusal", {
      p_actor_id: actorId,
      p_surface: surface,
    });
    if (error) {
      reportRefusalWriteFailure(surface, error);
      return "not-recorded";
    }
    return "recorded";
  } catch (cause) {
    reportRefusalWriteFailure(surface, cause);
    return "not-recorded";
  }
}

/**
 * The failure has to be loud somewhere.
 *
 * A swallowed exception on an audit path is how a missing migration went unnoticed for as long as
 * it did -- nothing on the screen, nothing in the logs, and it took someone running a migration
 * list by hand to find it. The panel telling its reader the attempt was not recorded is the honest
 * half; this is the half that reaches whoever can fix it.
 */
function reportRefusalWriteFailure(surface: AdminMoneySurface, cause: unknown) {
  const detail = cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String((cause as { message: unknown }).message)
      : String(cause);
  console.error(
    `[audit] money.page.refused was not written for surface "${surface}": ${detail}`,
  );
}
