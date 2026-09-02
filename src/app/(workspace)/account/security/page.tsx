import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { PageHeader } from "@/components/kit/page-header";
import { AccountSecuritySettings } from "@/components/workspace/live/account-security-settings";
import { loadPlatformActor } from "@/lib/auth/actors";
import { workspaceForRole } from "@/lib/auth/claims";
import { authMode } from "@/lib/auth/mode";
import { accountEmailChangeLive, accountMfaLive, accountSecurityLive } from "@/lib/env-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Account security" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Account" }, { label: "Security" }] as const;

const HEAD_SENTENCE =
  "Review signed-in devices, replace your password, and manage the extra checks supported for sensitive changes.";

/*
 * The page head is branched on the shell's role rather than written once, and the branch is the
 * honest answer rather than a shortcut.
 *
 * `PageHeader` draws its title through `.t-page-title`, which reads `--t-page-title`: 20px
 * globally and 30px under the owner console, with no prop that moves either. The coach side wants
 * 46px, and the class that carries it -- `.coach-page-title` -- is declared inside
 * `[data-shell-role="coach"]` in `coach.css`. Under the admin shell that selector does not match,
 * so an `<h1 className="coach-page-title">` there is an unstyled heading: the browser's default
 * 2em bold, no `--ink`, no tracking, no line-height, and visibly not the console's head. There is
 * no fallback trick available either, because a class is matched or it is not -- the
 * `var(--coach-*, console)` pattern the settings component leans on only works for a property.
 *
 * So the coach branch gets the deck's own head and the admin branch keeps the console's, which is
 * also what stops this route quietly shipping a 46px title into a language three other lanes own.
 * `PageHeader` asserts in development that exactly one of it renders inside a shell, and only one
 * of these two ever does.
 */
function CoachSecurityHead() {
  return (
    <header
      className="mb-[var(--s-5)] flex min-w-0 flex-col gap-[var(--s-2)]"
      data-page-head="account-security"
    >
      <h1 className="coach-page-title m-0">Account security</h1>
      <p className="m-0 max-w-[var(--measure-prose)] text-[17px] leading-[1.5] text-[color:var(--muted)]">
        {HEAD_SENTENCE}
      </p>
    </header>
  );
}

export default async function AccountSecurityPage() {
  if (authMode() !== "supabase") {
    redirect("/login?next=%2Faccount%2Fsecurity");
  }

  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getUser();
  const email = data.user?.email?.trim();
  if (error || !data.user?.id || !email) {
    redirect("/login?next=%2Faccount%2Fsecurity");
  }
  const actor = await loadPlatformActor();
  if (!actor || data.user.id !== actor.userId) forbidden();
  const role = workspaceForRole(actor.role);
  if (!role) forbidden();

  return (
    <AppShell
      activePath="/account/security"
      crumbs={CRUMBS}
      platformRole={actor.role}
      role={role}
    >
      {role === "coach" ? <CoachSecurityHead /> : (
        <PageHeader
          crumbs={CRUMBS}
          description={HEAD_SENTENCE}
          title="Account security"
        />
      )}
      <AccountSecuritySettings
        currentEmail={email}
        emailChangeEnabled={accountEmailChangeLive()}
        emailVerified={Boolean(data.user.email_confirmed_at)}
        mfaEnabled={accountMfaLive()}
        securityEnabled={accountSecurityLive()}
      />
    </AppShell>
  );
}
