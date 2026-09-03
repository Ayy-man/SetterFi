import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import {
  AccountSheetRoute,
  type AccountSheetTerms,
} from "@/components/workspace/rehaul/account-sheet";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { loadAccountTermsRegistry } from "@/lib/account/terms-publisher";
import { loadPlatformActor } from "@/lib/auth/actors";
import { workspaceForRole } from "@/lib/auth/claims";
import { accountTermsLive, uiRehaulLive } from "@/lib/env-contract";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Account" }] as const;

const EYE_COPY =
  "Everything about your own account lives in this panel: who you are signed in as, where each "
  + "notice reaches you, and the way out. The owner side also carries the account terms registry -- "
  + "the contract a coach accepts at signup, which SetterFi stores and hashes but never writes -- "
  + "and the operator runbooks. Deep links open a section directly: /account?section=terms and "
  + "/account?section=help both land on the panel already scrolled to that part.";

const HOME_HREF = {
  admin: "/admin/overview",
  affiliate: "/affiliate",
  coach: "/coach/home",
} as const;

/**
 * The account panel as a route, so it can be linked to.
 *
 * The four surfaces this replaces were pages, and pages get bookmarked, pasted into a support
 * thread and linked from a runbook. A sheet that only ever opened from a chip would have broken
 * every one of those links, so the sheet has a route of its own and `?section=` names the part.
 * The redirects from `/admin/account-terms` and `/admin/help` land here.
 *
 * With the rehaul off this route does not exist as anything new: it hands the reader to the
 * account page that was already there, rather than rendering a second, flagless copy of a panel
 * whose whole point is the rehaul.
 */
export default async function AccountPage() {
  if (!uiRehaulLive()) redirect("/account/security");

  const actor = await loadPlatformActor();
  if (!actor) redirect("/login?next=%2Faccount");
  const role = workspaceForRole(actor.role);
  if (!role) forbidden();

  const variant = role === "coach" ? "coach" : "owner";

  /*
   * The registry is read here or not at all. There is no GET on `/api/admin/account-terms`, so a
   * client-mounted panel cannot know what is published -- which is exactly why the sheet treats
   * `terms` as optional and says nothing about publication state without it, rather than
   * rendering an empty registry that reads as "nothing published".
   */
  let terms: AccountSheetTerms | undefined;
  if (variant === "owner" && (actor.role === "owner" || actor.role === "admin")) {
    try {
      const registry = await loadAccountTermsRegistry();
      terms = {
        acceptanceLive: accountTermsLive(),
        drafts: registry.drafts,
        published: registry.published,
        readError: null,
      };
    } catch {
      terms = {
        acceptanceLive: accountTermsLive(),
        drafts: [],
        published: null,
        readError: "The account terms registry could not be read.",
      };
    }
  }

  return (
    <AppShell activePath="/account" crumbs={CRUMBS} platformRole={actor.role} role={role}>
      <div className="relative min-h-[60vh]">
        <h1
          className={
            variant === "coach"
              ? "m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.025em] text-[var(--ink)]"
              : "m-0 text-[30px] leading-[1.1] font-semibold tracking-[-0.02em] text-[var(--ink)]"
          }
        >
          Account
        </h1>
        <AccountSheetRoute homeHref={HOME_HREF[role]} terms={terms} variant={variant} />
        <ContextEye copy={EYE_COPY} screen="account" />
      </div>
    </AppShell>
  );
}
