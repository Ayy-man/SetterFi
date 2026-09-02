import type { Metadata } from "next";
import Link from "next/link";

import { AuthStage } from "@/components/auth/auth-shell";
import { Overline, Prose, Surface } from "@/components/kit/atomics";
import { LandingPage, type LandingPlan } from "@/components/marketing/landing-page";
import { tierChoicePrice } from "@/components/onboarding/view-models";
import {
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import { authMode } from "@/lib/auth/mode";
import { publicLandingLive } from "@/lib/env-contract";
import { listSignupTierCatalog } from "@/lib/repositories/onboarding-signup";
import { workspaceRoleMeta } from "@/lib/workspace-navigation";

/**
 * Metadata follows the same fork the page body does. Static metadata kept the picker's
 * "Choose a view" title on the public marketing page the day the landing flag went live
 * (2026-09-02, seen in production) — a browser tab and a search snippet both read the title, so
 * the marketing page has to carry its own words, not the gated console's.
 */
export async function generateMetadata(): Promise<Metadata> {
  if (publicLandingLive()) {
    return {
      title: "SetterFi — your funding DMs answered, qualified and booked",
      description:
        "SetterFi answers a credit or business-funding coach's Instagram and Facebook DMs, qualifies every lead, and books the ones who fit straight into the calendar.",
    };
  }
  return {
    title: "Choose a view",
    description: "Open the SetterFi admin console, coach workspace, partner portal, or lead experience.",
  };
}

// The access note reads the live gate, so it must not be baked at build time.
export const dynamic = "force-dynamic";

const DESTINATIONS = [
  {
    href: workspaceRoleMeta.admin.home,
    name: workspaceRoleMeta.admin.workspace,
    title: "Admin console",
    detail: "The Brain and its testing tools, client operations, tiers, and platform health. Operator scope only.",
  },
  {
    href: workspaceRoleMeta.coach.home,
    name: workspaceRoleMeta.coach.workspace,
    title: "Coach workspace",
    detail: "A coach’s own agent: inbox, contacts, pipeline, analytics, and offer settings.",
  },
  {
    href: workspaceRoleMeta.affiliate.home,
    name: workspaceRoleMeta.affiliate.workspace,
    title: "Partner portal",
    detail: "Referral link, attributed coaches, commission earned, and payout history.",
  },
] as const;

const SECONDARY = [
  { href: "/consumer", label: "Consumer preview: what a lead actually sees" },
  { href: "/onboarding", label: "Setup companion: how a coach goes live" },
] as const;

/**
 * What the visitor is actually about to walk into. The old note promised "every
 * view is open here and production permissions aren't simulated", which stopped
 * being true the day real Supabase sessions and role isolation went on: pick a
 * workspace your role cannot open now and the proxy turns you away. The note
 * follows the gate rather than asserting one, so it stays true in every
 * environment this build serves.
 */
function accessNote() {
  if (authMode() === "supabase") {
    return "Sign-in is real: each view opens only for the role that owns it, and role isolation is enforced, not simulated. Seeded demo records are labeled on screen and kept out of analytics.";
  }
  return "Demo build. Every view is open here and permissions aren’t enforced, so nothing on these screens reaches a real lead.";
}

/**
 * What `/` serves, which is one of two different pages for two different readers.
 *
 * Off -- the default -- it is the role picker below, unchanged, and everything
 * `src/app/entry-surfaces.test.ts` pins about this file still holds: it stands on the shared
 * `AuthStage`, names no colour of its own, and spends no accent fill. On, it is the public
 * marketing page, which lives in its own module precisely so that none of those assertions has to
 * be relaxed to accommodate it -- a sales page's whole argument is one repeated fill, and the
 * picker's correct resting state is zero, so the two genuinely cannot be the same markup.
 *
 * The flag is off by default because turning it on changes who can reach `/` without a session,
 * and this project has one environment that deploys straight to the client's Vercel project. See
 * `publicLandingLive` in `src/lib/env-contract.ts`, and the matching allowance in `src/proxy.ts` --
 * both halves have to be on for the page to be reachable, which is deliberate: a public page that
 * the gate still turns away is a worse failure than no page.
 */
/**
 * The plans the marketing page quotes, read here rather than typed there.
 *
 * This is the same `list_signup_tier_catalog` read `/signup` runs, resolved on the server during
 * the request for `/`. Nothing public widens to make it work: `/` is already the one exact path
 * `src/proxy.ts` lets a signed-out request through to, the RPC is granted to `anon`, and this file
 * is `force-dynamic`, so there is no new route and no new endpoint. Before this, the page carried
 * three prices and three allowances as string literals -- figures a stranger reads with no read
 * behind them, drifting silently the first time an operator edits a tier.
 *
 * Ordered by what the plans actually differ on. `list_signup_tier_catalog` orders by lowered name,
 * which would put Growth ahead of Starter; `call_allowance` is a real column on every row and
 * sorting by it puts the cards in the order the reader is choosing along.
 *
 * A failed read is an empty list, never a remembered price: the page has an honest state for
 * having no plans to show, and quoting the last figures anybody typed is the defect this replaced.
 */
async function landingPlans(): Promise<LandingPlan[]> {
  try {
    const choices = await listSignupTierCatalog();
    return [...choices]
      .sort((left, right) =>
        left.callAllowance - right.callAllowance || left.label.localeCompare(right.label))
      .map((choice) => ({
        id: choice.id,
        name: choice.label,
        callAllowance: choice.callAllowance,
        price: tierChoicePrice(choice),
      }));
  } catch {
    return [];
  }
}

export default async function Home() {
  if (publicLandingLive()) return <LandingPage plans={await landingPlans()} />;
  return <RolePicker />;
}

/**
 * The role picker, and the first thing anyone sees.
 *
 * It spends **zero** accent fills, which is the One Fill Rule's correct resting state rather than
 * an unfinished one: three destinations are three equal choices, and filling one of them would be
 * the page claiming a preference it does not have. The accent appears twice and only twice -- in
 * the wordmark and on a card's border while the pointer is over it.
 */
function RolePicker() {
  return (
    <AuthStage lockup={false} width="wide">
      <header className="flex flex-col items-start gap-[var(--s-2)]">
        <h1 className="m-0 text-[length:var(--t-title)] leading-[var(--t-title-lh)] font-[var(--t-title-w)] tracking-[var(--t-title-tr)] text-[color:var(--ink)]">
          Setter<span className="text-[color:var(--accent-text)]">Fi</span>
        </h1>
        <p className="m-0 text-[length:var(--t-read)] leading-[var(--t-read-lh)] font-[600] text-[color:var(--ink)]">
          Every lead answered. Every call booked.
        </p>
        <Prose className={COACH_FOOTNOTE_CLASS}>
          An AI appointment setter that answers a coach’s inbound messages, qualifies the lead
          against shared industry logic, and books the call. Pick the view you want to walk.
        </Prose>
      </header>

      <nav
        aria-label="Workspace views"
        className="grid gap-[var(--s-3)] @min-[560px]:grid-cols-3"
      >
        {DESTINATIONS.map((destination) => (
          <Link
            className="group rounded-[var(--r-card)] no-underline"
            href={destination.href}
            key={destination.href}
          >
            {/*
              Each card is the console's own row shape -- overline, name, one line saying what is
              behind the door -- rather than three tiles distinguished only by two initials. The
              hover is the secondary button's hover, an --accent-edge border, which is the same
              signal every other ownable surface in the product gives.
            */}
            <Surface className="h-full transition-[border-color,transform] duration-[var(--duration-quick)] ease-[var(--ease-out)] group-hover:-translate-y-[2px] group-hover:border-[var(--accent-edge)] group-focus-visible:border-[var(--accent-edge)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0">
              <Overline as="p">{destination.name}</Overline>
              <p className={`m-0 mt-[var(--s-2)] ${COACH_ROW_NAME_CLASS}`}>
                {destination.title}
              </p>
              <p className={`m-0 mt-[var(--s-1)] ${COACH_FOOTNOTE_CLASS}`}>
                {destination.detail}
              </p>
            </Surface>
          </Link>
        ))}
      </nav>

      <div className="flex flex-wrap gap-x-[var(--s-5)] gap-y-[var(--s-2)]">
        {SECONDARY.map((link) => (
          <Link className={`link-inline ${COACH_READING_CLASS}`} href={link.href} key={link.href}>
            {link.label}
          </Link>
        ))}
      </div>

      {/*
        The managed-strip idiom, doing exactly the job it was written for: it states what this
        deployment already decided about access, and there is nothing on it to act on.
      */}
      <Surface variant="strip">
        <Overline as="p">Access</Overline>
        <Prose className={`mt-[var(--s-2)] ${COACH_READING_CLASS} text-[color:var(--faint)]`}>
          {accessNote()}
        </Prose>
      </Surface>
    </AuthStage>
  );
}
