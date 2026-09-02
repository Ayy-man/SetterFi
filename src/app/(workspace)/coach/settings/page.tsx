import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AlertSettings } from "@/components/workspace/live/alert-settings";
import { phase8AlertsLive } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Notification settings" };
export const dynamic = "force-dynamic";

export default async function CoachSettingsPage() {
  if (!phase8AlertsLive()) {
    return <AlertSettings enabled={false} surface="coach-settings" />;
  }

  const { loadAlertActor } = await import("@/lib/auth/actors");
  const actor = await loadAlertActor();
  if (!actor) redirect("/login?next=%2Fcoach%2Fsettings");
  if (actor.role !== "coach" && actor.role !== "coach_member") forbidden();

  return (
    <AlertSettings
      affiliateAccess={actor.affiliateAccess}
      enabled
      surface="coach-settings"
    />
  );
}
