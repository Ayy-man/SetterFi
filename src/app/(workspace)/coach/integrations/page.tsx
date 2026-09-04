import type { Metadata } from "next";

import { AppShell } from "@/components/kit/app-shell";
import { CoachSetup } from "@/components/workspace/rehaul/coach-setup";
import { coachSetupContext, loadCoachSetup } from "@/components/workspace/rehaul/coach-setup-read";

export const metadata: Metadata = { title: "Your setup" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Your setup" }] as const;

/**
 * The old Connections page, which is now Setup.
 *
 * `docs/SIMPLIFICATION-SPEC.md` 2.6 killed this as a destination: the reply windows, connection
 * history, last error, "what to try" prose and message templates all went to admin, and what a
 * coach needs from it is four rows saying where their leads can reach them. Those four rows live
 * on Setup, so this route renders Setup rather than a second account of the same connections.
 *
 * The route itself stays, and that is deliberate rather than leftover. `META_CONNECT_RETURN_PATH`
 * sends every Meta sign-in back here, Home's attention row links here while a channel is blocked,
 * and `workspace-navigation.test.ts` pins the reachability of both demoted coach destinations.
 * Deleting the route would break a live OAuth round trip.
 */
export default async function CoachIntegrationsPage() {
  const context = await coachSetupContext("/coach/integrations");
  const read = await loadCoachSetup(context.tenantId, { impersonating: context.impersonating });

  return (
    <AppShell
      activePath="/coach/home"
      crumbs={CRUMBS}
      role="coach"
    >
      <CoachSetup read={read} />
    </AppShell>
  );
}
