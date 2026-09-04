import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ConnectStep } from "@/components/onboarding/connect-step";
import { connectCards } from "@/components/onboarding/connect-view-models";
import { OnboardingStepShell, STEP_PANEL_CLASS } from "@/components/onboarding/step-shell";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { phase5Live } from "@/lib/env-contract";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Where your leads reach you",
  description: "Connect the channels your SetterFi agent answers on.",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

const LEAD =
  "Connect the accounts your leads already message you on. The rest is running or with the carriers.";

/**
 * Step 2 of setup: where a coach's leads actually message them.
 *
 * It reads real connection rows and the real carrier registration rather than drawing identical
 * Connect buttons, because the state is the whole point of the screen. `connect-view-models.ts`
 * holds every one of those rules and is where they are tested; this file is the data load and
 * nothing else.
 *
 * The calendar row's state is the same `calendar_connections` read the calendar step and the setup
 * rail both make, so the row here, the rung there and that step cannot disagree about whether a
 * calendar is connected.
 */
async function coachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fonboarding%2Fconnect");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  if (!claims.tenantId) redirect("/login");
  return { tenantId: claims.tenantId };
}

/**
 * Whether the primary calendar connection is `ready`, which is the same read the calendar step
 * draws its own verified state from and the same one the setup rail's calendar rung uses. Three
 * surfaces, one row, so none of them can call a calendar connected while another calls it not.
 *
 * `null` when the read did not run, which the row states in words rather than drawing as absent.
 */
async function calendarConnected(tenantId: string): Promise<boolean | null> {
  try {
    const { data, error } = await createSupabaseServiceClient()
      .from("calendar_connections")
      .select("state")
      .eq("tenant_id", tenantId)
      .eq("is_primary", true)
      .limit(1);
    if (error || !Array.isArray(data)) return null;
    return data.length > 0 && (data[0] as { state?: unknown }).state === "ready";
  } catch {
    return null;
  }
}

/** The one shape this route draws when it cannot draw the rows: a sentence, in the rows' place. */
function ConnectAbsence({ body, title }: { body: string; title: string }) {
  return (
    <OnboardingStepShell
      eyeCopy="This step lists the places your agent reaches your leads: Instagram direct messages, Facebook page messages, text messages once the carriers finish, and the calendar it books into."
      eyeScreen="onboarding-connect"
      lead={LEAD}
      primary={null}
      stepKey="connect"
      width={860}
    >
      <section className={STEP_PANEL_CLASS}>
        <div className="px-[16px] py-[24px] sm:px-[20px]">
          <h2 className="m-0 text-[20px] leading-[1.2] font-[500] tracking-[-0.015em] text-[color:var(--ink)]">
            {title}
          </h2>
          <p className="m-0 mt-[10px] max-w-[var(--measure-sentence)] text-[16px] leading-[1.55] text-[color:var(--muted)]">
            {body}
          </p>
        </div>
      </section>
    </OnboardingStepShell>
  );
}

export default async function OnboardingConnectPage() {
  if (!phase5Live()) {
    return (
      <ConnectAbsence
        body="Setup is not enabled on this deployment, so no channel can be connected from here yet."
        title="Connecting channels is not enabled"
      />
    );
  }

  const { tenantId } = await coachContext();

  let connections: Awaited<ReturnType<typeof listChannelConnections>> = [];
  let registration = null;
  let failed = false;
  let calendarReady: boolean | null = null;
  try {
    [connections, registration, calendarReady] = await Promise.all([
      listChannelConnections(tenantId),
      loadCoachA2pRegistration(tenantId),
      calendarConnected(tenantId),
    ]);
  } catch {
    // An unreadable channel list is an absence, not a licence to draw every row as unconnected:
    // that would tell a coach with a live Instagram that they have none.
    failed = true;
  }

  if (failed) {
    return (
      <ConnectAbsence
        body="Your channel connections could not be read just now, so this page cannot say which of them are working. Nothing has changed. Reload the page, or open your setup screen to connect a channel."
        title="Channel status is unavailable"
      />
    );
  }

  return (
    <ConnectStep
      calendarReady={calendarReady}
      cards={connectCards({ connections, registration })}
    />
  );
}
