"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ShieldAlert, ShieldCheck } from "@/components/kit/icons";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

export type MoneyTabId = "billing" | "tiers" | "corrections" | "affiliates";

export type MoneyActorRole = "owner" | "admin" | "success";

const SURFACE_GUARD_COPY: Record<MoneyTabId, {
  disabledTitle: string;
  disabledBody: string;
  /** The eyebrow on the refused panel: the rail group, then the destination, as the rail reads it. */
  trail: string;
  /**
   * Why this page in particular is closed, in the terms of what it carries rather than in the
   * terms of a permission table. "Limited to owner and admin roles" tells a reader the rule and
   * not the reason, and the reason here is a real one worth stating: these pages print cost
   * against revenue, which is the one thing CLAUDE.md keeps off every surface but this group.
   */
  restrictedBody: string;
}> = {
  billing: {
    disabledTitle: "Billing is not enabled",
    disabledBody: "This route is waiting for the billing feature gate.",
    trail: "Money · Revenue and subscriptions",
    restrictedBody:
      "Revenue, subscription movements and payout economics are open to the platform owner and admins only, because they carry cost-against-revenue figures that support does not work from.",
  },
  tiers: {
    disabledTitle: "Plans are not enabled",
    disabledBody: "This route is waiting for the billing feature gate.",
    trail: "Money · Plans and pricing",
    restrictedBody:
      "Plan prices and client overrides are open to the platform owner and admins only. Changing one moves what every client on that plan is billed, so the page is closed rather than read-only.",
  },
  corrections: {
    disabledTitle: "Billing corrections are not enabled",
    disabledBody: "The correction queue will appear when billing is enabled.",
    trail: "Money · Corrections",
    restrictedBody:
      "The correction queue is open to the platform owner, admins and success reviewers.",
  },
  affiliates: {
    disabledTitle: "Affiliates are not enabled",
    disabledBody: "This route is waiting for the affiliate feature gate.",
    trail: "Money · Affiliates and payouts",
    restrictedBody:
      "Commission ledgers and payout records are open to the platform owner and admins only, because approving a payout is a decision about money leaving the business.",
  },
};

/**
 * The one Money page a success reviewer does carry, named on every refusal they can hit.
 *
 * A refusal that only says no leaves the reader guessing whether they took a wrong turn or
 * whether the console has nothing for them here. `moneyPageAccessStatus` in `view-models.ts` is
 * the authority -- owner and admin get all four, success gets corrections and nothing else -- so
 * this is that rule stated forwards instead of as a denial.
 */
const SUCCESS_HOME = {
  href: "/admin/corrections",
  label: "Go to Corrections",
} as const;

/**
 * The page header on a Money surface its reader may not be allowed to see.
 *
 * `MoneySurfaceGuard` wraps the page body, so on four of the five Money routes the header sat
 * outside it and survived the refusal: `/admin/billing` told a refused success reviewer "What the
 * platform bills, and which subscriptions are in trouble" over a panel saying the page was not
 * theirs, and offered a "Cost evidence" link to `/admin/billing/costs`, which
 * `moneyPageAccessStatus` refuses them too. Cost evidence returns the favour with a back-link to
 * `/admin/billing`. Two descriptions of content nobody was shown, and two links from one refusal
 * into another.
 *
 * Corrections is the one route that already had this right -- its guard wraps the `ListPage`
 * rather than its children (`AdminMoneyCorrections` below) -- so this is the other four brought to
 * the shape the fifth already had. It is a helper rather than a moved `<MoneySurfaceGuard>`
 * because `AdminMoneyRefused.dc.html:230-231` keeps the `<h1>` on a refusal and swaps only the
 * sentence under it: wrapping the header would have dropped the page's only level-one heading and
 * left a screen reader's outline starting midway down.
 *
 * **Two arms, not one, and that is the whole point.** The same split `MoneySurfaceGuard` makes at
 * `:133-136` is made here: a route behind a dark feature gate is not a page anyone was refused, so
 * telling that reader their role does not carry it is a false statement about them -- on a route
 * that is off for the owner too. Collapsing these two into one sentence is the exact defect the
 * guard's own two-answer branch exists to prevent, and a header that disagreed with the body
 * directly beneath it would be worse than either.
 *
 * `actions` drops on both arms. A control over content that was not rendered is dead whichever
 * reason it was not rendered for.
 */
export function moneyPageHeader<Actions>({
  actions,
  authorized,
  description,
  enabled,
}: {
  /** The page's own actions, returned untouched when nothing is refused. */
  actions?: Actions;
  authorized: boolean;
  /** What the page says about itself when the reader can actually see it. */
  description: string;
  enabled: boolean;
}): { actions: Actions | undefined; description: string } {
  if (!enabled) {
    return {
      actions: undefined,
      description: "This route is waiting for a feature gate, so nothing on it is available yet.",
    };
  }

  if (!authorized) {
    // The artboard's own words for this arm (`AdminMoneyRefused.dc.html:231`), minus the clause
    // in front of them that restates what the page would have carried -- which is the half that
    // describes withheld content, and so the half this exists to remove.
    return { actions: undefined, description: "Your role does not carry this page." };
  }

  return { actions, description };
}

/**
 * Feature gate and role gate for a money surface. Renders nothing else, so callers keep their own
 * layout.
 *
 * The four money routes are their own sidebar group, so the surfaces carry no in-page tab bar;
 * the sidebar is the only place they are listed. A reader who is refused therefore has no visible
 * route onwards unless this component draws one, which is why the refusal names Corrections
 * rather than stopping at the word "restricted".
 *
 * **The refusal is a page, not a crash.** It is reached by a real person with a real job -- a
 * success reviewer following a link from a client thread -- and the tone is set accordingly:
 * nothing has gone wrong, the console simply does not carry this page for them, and the audit
 * line at the bottom says the attempt was recorded the same way every privileged action is rather
 * than implying they tripped something.
 */
export function MoneySurfaceGuard({
  surface,
  enabled,
  authorized,
  actorRole,
  refusalRecord,
  children,
}: {
  surface: MoneyTabId;
  enabled: boolean;
  authorized: boolean;
  /**
   * The signed-in role, where the caller has it. Only used to decide whether to offer Corrections
   * as the way onwards: an owner or admin seeing this panel is looking at a bug rather than at a
   * permission boundary, and sending them to a page they were never refused would be noise.
   */
  actorRole?: MoneyActorRole;
  /**
   * Whether the `money.page.refused` row was actually written for this refusal.
   *
   * Required in practice on the role-boundary arm, and typed optional only because the flag-off
   * arm returns before reaching the sentence and the corrections surface renders the guard with
   * `authorized` hard-coded true. When it is absent on a refusal the panel says the attempt was
   * not recorded, which is the safe direction: a page that cannot see its own audit result has no
   * grounds to claim one.
   */
  refusalRecord?: MoneyRefusalRecord;
  children: ReactNode;
}) {
  const copy = SURFACE_GUARD_COPY[surface];

  /*
   * One gate, two answers.
   *
   * The condition is deliberately still `!enabled || !authorized` in a single branch:
   * `view-models.test.ts` reads this file's source for that exact expression, inside the block
   * that also pins `if (!phase6Live())` landing before `loadPlatformActor()` on every Money page.
   * That block is guarding a refuse-before-you-read ordering, which is a tenant-isolation
   * property rather than a style preference, so the shape of the gate is not mine to restructure
   * on the way past.
   *
   * What did need to change is what the gate SAYS. Both conditions used to produce the same
   * "access is restricted" copy, which meant a surface waiting on the billing feature flag told
   * the reader their role did not carry it -- a false statement about the person reading it, on a
   * route that is off for everybody including the owner. So the branch is one and the answer is
   * two: the flag case first, because a page nobody can open yet is not a page anyone was refused.
   */
  if (!enabled || !authorized) {
    if (!enabled) {
      return <DataState body={copy.disabledBody} kind="empty" title={copy.disabledTitle} />;
    }

    return (
      <DeckPanel
        className="max-w-[var(--measure-prose)]"
        eyebrow={copy.trail}
        headingId="money-refused-title"
        name="This one is not yours to open"
      >
        <p className="m-0 max-w-[var(--measure-tight)] text-[length:var(--t-body)] leading-[1.55] text-[color:var(--muted)]">
          {copy.restrictedBody}
          {actorRole === "success" && surface !== "corrections"
            ? " Corrections is the one Money page your role does carry, and it holds everything you need to fix a client's billing."
            : ""}
        </p>

        {actorRole === "success" && surface !== "corrections" ? (
          <p className="mt-[var(--s-4)] mb-0">
            <Link
              className="inline-flex h-[var(--console-target,32px)] items-center rounded-[var(--r-control)] bg-[var(--accent-fill)] px-[14px] text-[length:var(--t-body)] font-medium text-[color:var(--on-accent)] no-underline hover:no-underline"
              href={SUCCESS_HOME.href}
            >
              {SUCCESS_HOME.label}
            </Link>
          </p>
        ) : null}

        {/*
          * The sentence answers the write, which is the only version of it that can stay true.
          *
          * It has now been wrong in both directions. It was first written as "nothing was recorded
          * against you", pinned as absent, because the canvas drew an audit claim that nothing
          * backed. `20261004000001_money_page_refusal_audit.sql:26-31` then added the
          * `money.page.refused` action and all five Money routes started calling
          * `logMoneyPageRefusal` on this exact branch, so that copy became the false one and the
          * pin was reversed to assert the claim instead.
          *
          * It was still wrong, and for a reason neither version could see. `logMoneyPageRefusal`
          * swallowed every failure into a bare `catch {}` and returned nothing, so the panel
          * asserted a receipt on the strength of a call whose result it never looked at. That
          * migration had never been applied to the hosted project -- `record_money_page_refusal`
          * did not exist there, every write failed, and the live deployment told refused operators
          * their attempt was on the trail while no row was ever written.
          *
          * Neither sentence is the fix, because the defect was asserting anything unconditionally.
          * The write's outcome reaches this component now and the panel states what happened, so
          * the copy is true before the migration lands and stays true after it -- and it stays true
          * through the next permissions error, timeout or rename, which is the failure mode the old
          * swallow would have hidden just as completely.
          *
          * The flag-off refusal above returns before reaching here and must stay that way: it
          * writes nothing, so it may not say either of these things.
          */}
        {refusalRecord === "recorded" ? (
          <p
            className="mt-[var(--s-4)] mb-0 flex items-start gap-[var(--s-2)] text-[11.5px] leading-[1.45] text-[color:var(--faint)]"
            data-slot="money-refusal-audit"
            data-refusal-record="recorded"
          >
            <ShieldCheck aria-hidden className="mt-[1px] size-[var(--s-4)] shrink-0" />
            <span>
              Logged: this attempt is on the audit trail with your name, the page and the time.
              Nothing is wrong; it is recorded the same way every privileged action is, and the
              platform owner can open the page for you.
            </span>
          </p>
        ) : (
          <p
            className="mt-[var(--s-4)] mb-0 flex items-start gap-[var(--s-2)] text-[11.5px] leading-[1.45] text-[color:var(--faint)]"
            data-slot="money-refusal-audit"
            data-refusal-record="not-recorded"
          >
            <ShieldAlert aria-hidden className="mt-[1px] size-[var(--s-4)] shrink-0" />
            <span>
              We could not record this attempt on the audit trail. You were still refused the page
              and nothing is wrong on your side; the failure is on our audit path and it has been
              reported. The platform owner can open the page for you.
            </span>
          </p>
        )}

      </DeckPanel>
    );
  }

  return <>{children}</>;
}
