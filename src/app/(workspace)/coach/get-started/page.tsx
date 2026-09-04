import type { Metadata } from "next";

import { AppShell } from "@/components/kit/app-shell";
import { CoachSetup } from "@/components/workspace/rehaul/coach-setup";
import { coachSetupContext, loadCoachSetup } from "@/components/workspace/rehaul/coach-setup-read";

export const metadata: Metadata = { title: "Your setup" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Your setup" }] as const;

/**
 * Setup, reached from the setup panel on Home.
 *
 * This route and `/coach/integrations` render the same surface, because the redesign folded
 * Connections into Setup and `src/lib/workspace-navigation.test.ts` pins that both demoted
 * destinations stay reachable. A route that stopped rendering would be a bookmark and a link on
 * Home landing on nothing, which is the exact failure that put Connections on the rail in the
 * first place.
 *
 * `activePath` is Home rather than this route, which is what `design/coach/Setup.dc.html` draws:
 * Setup is not one of the five rail destinations, and a pill group with nothing lit reads as a
 * navigation that has lost its place.
 */
export default async function CoachGetStartedPage() {
  const context = await coachSetupContext("/coach/get-started");
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
