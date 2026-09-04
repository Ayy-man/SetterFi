import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { CoachSettingsNotifications } from "@/components/workspace/rehaul/coach-settings-notifications";
import { phase8AlertsLive } from "@/lib/env-contract";

/**
 * The coach's settings page.
 *
 * Titled "Settings" rather than "Notification settings" because the page now is the coach's
 * settings: `design/coach/Notifications.dc.html` heads it that way, and the account-menu row that
 * opens it says the same word. What is behind the title did not widen -- there is still exactly
 * one question on it -- but naming a page after the mechanism inside it is what produced the
 * 29-notice matrix this replaces, where the title named the machinery and the reader had to work
 * out what it was for.
 *
 * The flag check stays ahead of any dynamic actor work, and the surface renders either way: the
 * list of what SetterFi already sends is true whether or not this deployment can read a
 * preference, so only the question is withheld when the flag is off.
 */
export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function CoachSettingsPage() {
  if (!phase8AlertsLive()) {
    return <CoachSettingsNotifications enabled={false} />;
  }

  const { loadAlertActor } = await import("@/lib/auth/actors");
  const actor = await loadAlertActor();
  if (!actor) redirect("/login?next=%2Fcoach%2Fsettings");
  if (actor.role !== "coach" && actor.role !== "coach_member") forbidden();

  return (
    <CoachSettingsNotifications
      affiliateAccess={actor.affiliateAccess}
      enabled
    />
  );
}
