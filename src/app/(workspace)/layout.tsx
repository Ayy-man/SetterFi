import type { ReactNode } from "react";

import { ImpersonationFrame } from "@/components/kit/impersonation-frame";
import { TOASTER_PRESET } from "@/components/kit/toast-preset";
import { Toaster } from "@/components/ui/sonner";
import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env";
import { loadCapabilityActor, loadPlatformActor } from "@/lib/auth/actors";
import { authMode } from "@/lib/auth/mode";
import { demoLoginsEnabled } from "@/lib/env-contract";
import { phaseProviderReadiness } from "@/lib/operations/phase-provider-readiness";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadImpersonationSessionBanner } from "@/lib/impersonation-session";
import { demoViewTargetsFor, navigationEnvironment } from "@/lib/workspace-navigation";

/**
 * The only server boundary above all 30 <WorkspaceShell> mounts, which all live under
 * this route group. It renders no markup; it exists so two server-only reads happen on
 * the server. WorkspaceShell is a client component, so process.env is empty there:
 * SETTERFI_AUTH_MODE was unreadable, and calling demoViewTargetsFor() client-side made
 * SETTERFI_PHASE5_LIVE always look false, which is why the Onboarding demo view kept
 * rendering after Phase 5 went live.
 *
 * The nav groups have the same problem from the other direction: the shell reads
 * process.env for its liveWhen flags, which is populated during SSR and empty after
 * hydration, so "Get started" appeared on a server-rendered coach page and vanished on
 * the next client navigation. navigationEnvironment() resolves those flags here, on the
 * server, and hands them down so both passes build the same nav.
 */
/**
 * The signed-in platform role, for the nav's role gate only.
 *
 * Read here and nowhere else in the shell: every page that cares already loads its own actor and
 * guards on it, and this must not become a second authority. It is read only under real auth --
 * the open and password fixtures have no claims to read, and asking would cost a round trip per
 * page for a null -- and a failed read is a null, which renders the full nav exactly as before.
 */
async function sessionPlatformRole() {
  if (authMode() !== "supabase") return undefined;
  try {
    return (await loadPlatformActor())?.role;
  } catch {
    return undefined;
  }
}

/**
 * Who the shell is greeting, and nothing else.
 *
 * The topbar's account chip and the coach support bubble both want a real name, and both are
 * client components mounted on thirty pages, so neither can read one. The name existed only as a
 * page-level read -- `loadCoachGreeting()` in `coach/home/page.tsx` -- which is why the chip
 * carried the literal initials "CO" for every coach and the bubble opened with "Need a hand?".
 * Reading it once here is one pair of queries per request reused by every workspace route, rather
 * than thirty page-level copies of the same read.
 *
 * **This is display, not authority.** It resolves no role, grants nothing and gates nothing -- the
 * note above `sessionPlatformRole` says this layout must not become a second place permissions are
 * decided, and a name that only ever reaches a heading does not make it one. Every failure mode is
 * a null: no session, an unreadable row, a blank column, a thrown query. Both surfaces that
 * consume it already render correctly with no name at all, which is what lets this read be allowed
 * to fail rather than being something a page waits on.
 *
 * The first whitespace token, for the reason `loadCoachGreeting` gives: "Welcome back, Marcus" is
 * a greeting and "Welcome back, Marcus Reed" is a database row wearing one.
 *
 * **The actor is read without requiring a tenant**, which is the whole of what was wrong here. It
 * used `loadRouteActor`, and that returns null for any session with no `tenantId` -- which is every
 * platform owner and admin, because the console is not a tenant. So the name read was skipped for
 * exactly those people and the topbar fell through to its role initials: every owner's chip read
 * "AD", and it read "AD" no matter what `users.full_name` said, so it looked like missing seed data
 * rather than a gate. The tenant lookup is now conditional on there being a tenant to look up,
 * instead of the name being conditional on the tenant.
 */
async function sessionAccount() {
  if (authMode() !== "supabase") return undefined;
  try {
    const actor = await loadCapabilityActor();
    if (!actor) return undefined;
    const service = createSupabaseServiceClient();
    const [user, tenant] = await Promise.all([
      service.from("users").select("full_name").eq("id", actor.userId).maybeSingle(),
      actor.tenantId
        ? service.from("tenants").select("name,is_demo").eq("id", actor.tenantId).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const fullName = typeof user.data?.full_name === "string" ? user.data.full_name.trim() : "";
    const business = typeof tenant.data?.name === "string" ? tenant.data.name.trim() : "";
    if (!fullName && !business) return undefined;
    return {
      fullName: fullName || null,
      firstName: fullName.split(/\s+/u)[0] || null,
      business: business || null,
      // The same read, one column wider. The account sheet strips the seeders' "(demo)" marker out
      // of the name it prints, and the hard rule on test data is that it stays labelled on screen,
      // so the sheet needs the column the marker stands for rather than the marker.
      isDemo: tenant.data?.is_demo === true,
    };
  } catch {
    return undefined;
  }
}

export default async function WorkspaceLayout({ children }: { children: ReactNode }) {
  const [platformRole, account] = await Promise.all([sessionPlatformRole(), sessionAccount()]);

  return (
    <WorkspaceEnvProvider
      account={account}
      demoViews={demoViewTargetsFor()}
      demoAccountSwitching={demoLoginsEnabled()}
      mode={authMode()}
      navEnvironment={navigationEnvironment()}
      platformRole={platformRole}
      providerReadiness={phaseProviderReadiness()}
    >
      {/*
        The impersonation band, resolved once here rather than per page.
        `ImpersonationBanner` shipped with zero call sites, so an owner inside a coach's workspace
        saw nothing naming the workspace, no elapsed clock, no audit line, and had no way out --
        `/api/platform/impersonation/end` had no caller anywhere in the app and a session could
        only be waited out. This is the only server boundary above all thirty shell mounts, so one
        read here is what puts the band on every page of the session.
      */}
      <ImpersonationFrame session={await loadImpersonationSessionBanner()}>
        {children}
      </ImpersonationFrame>
      <Toaster {...TOASTER_PRESET} />
    </WorkspaceEnvProvider>
  );
}
