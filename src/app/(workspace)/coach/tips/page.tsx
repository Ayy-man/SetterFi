import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { CoachTips } from "@/components/workspace/live/coach-tips";
import { loadRouteActor } from "@/lib/auth/actors";

export const metadata: Metadata = { title: "Tips and trainings" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Tips and trainings" }] as const;

/**
 * The trainings route, shipped ahead of its content on purpose.
 *
 * `CoachTips` takes no data here because there is nothing to hand it: there is no trainings
 * repository, no API route that serves a catalogue, and no source in the client's intake that
 * says where the videos will live. Rather than invent one, the page renders the real head and the
 * kit's empty state, and the day the catalogue exists this becomes a `loadTrainings()` call and a
 * `trainings=` prop -- no layout work, because the card shape is already behind that prop.
 *
 * The gate mirrors `/coach/billing` rather than `/coach/help`: there is no env flag to consult,
 * so the only question is whether a coach is signed in. A signed-out visitor is redirected to the
 * login screen with this route as the return, which is why an unauthenticated request to
 * `/coach/tips` answers 307 and not 500.
 */
export default async function CoachTipsPage() {
  const actor = await loadRouteActor();
  if (!actor) redirect("/login?next=%2Fcoach%2Ftips");
  if (actor.role !== "coach" && actor.role !== "coach_member") forbidden();
  return (
    <AppShell activePath="/coach/tips" crumbs={CRUMBS} role="coach">
      <CoachTips />
    </AppShell>
  );
}
