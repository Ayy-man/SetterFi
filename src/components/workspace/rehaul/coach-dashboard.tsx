"use client";

import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import Link from "next/link";

import { useSyncExternalStore } from "react";

import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { CoachHomeBubbles } from "@/components/workspace/rehaul/coach-home-figures";
import { CoachHomeKeywords } from "@/components/workspace/rehaul/coach-home-keywords";
import { CoachHomeMonths } from "@/components/workspace/rehaul/coach-home-months";
import { CoachHomeRange } from "@/components/workspace/rehaul/coach-home-range";
import { DeckPanel } from "@/components/kit/deck-panel";
import {
  clearDemoSetupOverride,
  readDemoSetupOverride,
  startDemoSetupOverride,
} from "@/lib/demo-setup-override";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import { CARRIER_TYPICAL_DAYS, type ProvisioningStep } from "@/lib/onboarding/contracts";
import {
  CoachSetupRows,
  coachSetupRows,
  coachSetupSentence,
  type CoachSetupRead,
} from "@/components/workspace/rehaul/coach-setup";
import type {
  CoachLeadComposition,
  CoachMeasurement,
  CoachMeasurementWindow,
} from "@/lib/repositories/analytics";
import type { CoachChannelStatus } from "@/components/workspace/live/coach-channel-status";
import { PROVENANCE_COPY } from "@/components/workspace/live/coach-page-head";
import type { MessagingChannel } from "@/lib/integrations/types";

/**
 * Every explainer sentence the live coach dashboard printed under a heading, moved off the page.
 *
 * These are `coach-measurement.tsx`'s own `DECK_COPY` sentences and the carrier reassurance from
 * `CoachCarrierNotice`, copied verbatim rather than imported because neither is exported and that
 * file is not ours to edit. If a sentence there changes, it changes here.
 */
const EYE_COPY = [
  "Leads: everyone your agent reached in the window you picked.",
  "Booked: leads who took a slot on your calendar.",
  "Time to book: the average from a lead's first message to a call on the calendar.",
  "The keyword table counts opt-ins per conversation and qualified and booked per contact, so a lead who returns through a second keyword is counted on both rows.",
  "Percent view uses each keyword's share of all keyword opt-ins; qualified and booked use that keyword's opt-ins.",
  "Carriers take about three weeks to approve a new business for texting. Nothing is broken and there is nothing for you to do.",
].join(" ");

const COACH_CHANNEL_NAMES: Readonly<Record<MessagingChannel, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text messaging",
  webchat: "Web chat",
  whatsapp: "WhatsApp",
};

export type CoachDashboardProps = {
  attention: {
    threadsNeedingHuman: number;
    leadsToCallBack: number;
    blockedSetupSteps: number;
    /*
     * The oldest blocked step's own key, so the rail's blocked rung can name the step instead of
     * counting the blocked ones a second time under a header that already counted them. The page
     * has read it beside the count since this surface shipped; only the type was missing.
     */
    blockedStepKey?: ProvisioningStep | null;
    openConversations?: number;
  };
  billingPeriod?: { periodStart: string; periodEnd: string } | null | "unavailable";
  channelStatus?: CoachChannelStatus | null;
  /**
   * Setup's own read, made only when the connection read found nothing live. The first-run
   * composition draws it through Setup's own component; the live composition never reads it.
   */
  setup?: CoachSetupRead | null;
  composition: CoachLeadComposition;
  customFrom?: string | null;
  customTo?: string | null;
  greeting?: string | null;
  measurement: CoachMeasurement;
  window: CoachMeasurementWindow;
  /** Injected by tests so the day counter and the elapsed reading cannot disagree. */
  now?: Date;
};

/** "A", "A and B", "A, B and C". */
function nameList(names: readonly string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The one status sentence under the greeting.
 *
 * On a first run it is Setup's own sentence, off the same rows the list below draws, so the
 * header cannot count something the list does not show. It used to count blocked provisioning
 * rows as "waiting on you"; those are SetterFi's, and the list now says so. On the live
 * composition it says which channels answer and where the carriers are.
 */
function StatusLine({
  now,
  setup,
  status,
}: {
  now?: Date;
  setup: CoachSetupRead | null;
  status: CoachChannelStatus | null | undefined;
}) {
  if (!status) return null;
  if (setup) {
    return (
      <p
        className="m-0 mt-3 max-w-[var(--measure-wide)] text-[17px] leading-[1.5] text-[color:var(--body)]"
        data-slot="home-status"
      >
        {coachSetupSentence(coachSetupRows(setup, now), setup, now)}
      </p>
    );
  }
  const liveNames = status.liveChannels.map((channel) => COACH_CHANNEL_NAMES[channel]);
  const carrier = status.carrier;
  const carrierDay = carrier.kind === "in-review" && carrier.submittedAt
    ? elapsedWorkspaceDays(carrier.submittedAt, now)
    : null;

  const clauses: string[] = [];
  if (liveNames.length > 0) clauses.push(`Your agent is live on ${nameList(liveNames)}.`);
  if (carrier.kind === "in-review") {
    clauses.push(
      carrierDay === null
        ? "Text messages are still with the carrier."
        // The typical range is a pair, `[14, 21]`, and the artboard prints its upper bound: the
        // carriers publish no schedule, so the sentence gives the outer edge of what we have seen
        // rather than a midpoint that would read as a prediction.
        : `Text messages are on day ${carrierDay} of about ${
          CARRIER_TYPICAL_DAYS[CARRIER_TYPICAL_DAYS.length - 1]
        }.`,
    );
  }
  if (clauses.length === 0) return null;

  return (
    <p
      className="m-0 mt-3 max-w-[var(--measure-wide)] text-[17px] leading-[1.5] text-[color:var(--body)]"
      data-slot="home-status"
    >
      {clauses.join(" ")}
    </p>
  );
}

/* --------------------------------------------------------------------------------------------
 * First run
 * ------------------------------------------------------------------------------------------ */

/**
 * Setup is unfinished when the connection read succeeded and found nothing live.
 *
 * `channelsChecked` is the load-bearing half. A failed connection read is not the same claim as
 * "no channel is live", and greeting a working coach with a setup checklist because a query timed
 * out is exactly the fake state this surface is not allowed to invent. A missing status is
 * likewise not evidence of anything, so it renders the figures.
 */
function setupIncomplete(status: CoachChannelStatus | null | undefined) {
  return Boolean(status && status.channelsChecked && status.liveChannels.length === 0);
}

const SETUP_LINK_CLASS = [
  "inline-flex min-h-12 items-center justify-center rounded-xl border border-[var(--line-input)]",
  "bg-[var(--card)] px-5 text-[16px] font-medium text-[var(--ink)] no-underline hover:no-underline",
  "w-full sm:min-h-0 sm:h-11 sm:w-auto",
].join(" ");

/**
 * The first-run setup, which is Setup's own list drawn compact.
 *
 * Until 2026-09-04 this was a three-row rail built from the two reads Home happened to make, and
 * it disagreed with Setup about the same coach on the same afternoon: it said a step was blocked
 * and offered to fix it while Setup said nothing was waiting. There is one derivation now,
 * `coachSetupRows`, and Home draws it through the same component Setup does, so the two surfaces
 * cannot disagree about a fact they both state. The link under the list is the only thing Home
 * adds: the page that draws the same rows in full, with the technical record beside them.
 */
function FirstRun({ now, setup }: { now?: Date; setup: CoachSetupRead }) {
  const rows = coachSetupRows(setup, now);
  return (
    <>
      <h2 className="sr-only" id="rehaul-setup-heading">Your setup</h2>
      <CoachSetupRows compact headingId="home-setup" rows={rows} />
      <div className="flex flex-wrap items-center gap-4 pl-[4px]">
        <p className="m-0 max-w-[var(--measure-deck)] text-[14px] text-[var(--muted)]">
          The same list, with the technical record beside it.
        </p>
        <Link className={SETUP_LINK_CLASS} href="/coach/get-started">
          See setup
        </Link>
      </div>
    </>
  );
}

/* --------------------------------------------------------------------------------------------
 * The demo setup override
 * ------------------------------------------------------------------------------------------ */

/**
 * A status that presents the setup as finished, built from nothing.
 *
 * This is the whole of what the override "knows". It reads no row and it is handed to the same
 * `FirstRun` and `StatusLine` a real status goes to, so the two compositions cannot drift: there is
 * one setup rail, and the override changes what it is given rather than how it draws.
 *
 * The channel pair is the pair the coach-facing copy already names as one step, "Instagram and
 * Messenger", so the status line reads the sentence a finished connection would actually produce.
 */
const DEMO_COMPLETE_STATUS: CoachChannelStatus = {
  carrier: { kind: "live" },
  channelsChecked: true,
  liveChannels: ["instagram", "messenger"],
};

/** The same finished state as Setup's read, so the override presents the list Setup would. */
const DEMO_COMPLETE_SETUP: CoachSetupRead = {
  blocked: { checked: true, steps: [] },
  business: { checked: true, completedAt: "2026-08-21T14:00:00.000Z" },
  calendar: { checked: true, connected: true, name: "Coaching calls", needsReconnect: false },
  carrier: { kind: "live" },
  goLive: { checked: true, completedAt: "2026-09-03T14:00:00.000Z" },
  instagram: { accountLabel: "Instagram", changedAt: null, checked: true, liveSince: "2026-08-29T14:00:00.000Z", state: "live" },
  messenger: { accountLabel: "Facebook page", changedAt: null, checked: true, liveSince: "2026-08-29T14:00:00.000Z", state: "live" },
  metaConnect: "ready",
  offer: { checked: true, published: true },
  record: { checked: false, rows: [] },
  sms: { accountLabel: null, changedAt: null, checked: true, liveSince: null, state: "live" },
  test: { checked: true, completedAt: "2026-09-02T14:00:00.000Z" },
};

/**
 * The provenance sentence while the override is on.
 *
 * The page already prints one line saying these rows are seeded, and the rule is that a fact is
 * said once, so this replaces that line rather than sitting under it. It has to carry two claims:
 * the rows are demo rows, as before, and the setup above is being shown complete by a switch rather
 * than by anything the platform read. "Clears itself" rather than a wall-clock time because the
 * expiry is a browser clock and the display formatters are pinned to one timezone, so a printed
 * time would be wrong for anybody demoing outside it.
 */
const DEMO_OVERRIDE_PROVENANCE =
  "Demo data, excluded from real analytics. Setup is shown complete for this demo, and it clears itself within ten minutes.";

/**
 * The override, as one piece of state, held in a module store rather than in component state.
 *
 * `ContextEye` reaches for the same shape a few files over and for the same two reasons. The first
 * is that the server has no storage, so state seeded from it would hydrate one tree over another;
 * `useSyncExternalStore` renders the server snapshot on both passes and swaps to the real one after
 * hydration, with no cascading render and no effect that writes state on mount. The second is that
 * this is genuinely one value per browser, not one per mounted component.
 *
 * The timer is what makes "self expiring" true on a page nobody reloads. Without it a dashboard
 * left open would keep drawing a complete setup after the stamp died, because nothing would ask the
 * storage again. It fires once, at the expiry, and drops the value for every subscriber.
 *
 * The store empties itself when its last subscriber leaves, so a remount re-reads the stamp the
 * same way a fresh page load does, and one test's override cannot leak into the next.
 */
let overrideExpiresAt: number | null = null;
let overrideHydrated = false;
let overrideTimer: ReturnType<typeof setTimeout> | null = null;
const overrideListeners = new Set<() => void>();

function armOverrideExpiry() {
  if (overrideTimer !== null) {
    clearTimeout(overrideTimer);
    overrideTimer = null;
  }
  if (overrideExpiresAt === null) return;
  const remaining = overrideExpiresAt - Date.now();
  if (remaining <= 0) {
    overrideExpiresAt = null;
    return;
  }
  overrideTimer = setTimeout(() => {
    overrideTimer = null;
    setOverride(null);
  }, remaining);
}

function setOverride(next: number | null) {
  if (overrideExpiresAt === next) return;
  overrideExpiresAt = next;
  armOverrideExpiry();
  for (const listener of overrideListeners) listener();
}

function subscribeOverride(listener: () => void) {
  overrideListeners.add(listener);
  if (!overrideHydrated) {
    overrideHydrated = true;
    // The one read of the viewer's storage. It answers null for a missing, expired, corrupt or
    // over-long stamp, and for a browser that refuses storage at all.
    overrideExpiresAt = readDemoSetupOverride(Date.now())?.expiresAt ?? null;
    armOverrideExpiry();
  }
  return () => {
    overrideListeners.delete(listener);
    if (overrideListeners.size > 0) return;
    overrideHydrated = false;
    overrideExpiresAt = null;
    if (overrideTimer !== null) {
      clearTimeout(overrideTimer);
      overrideTimer = null;
    }
  };
}

function overrideSnapshot() {
  return overrideExpiresAt;
}

/** The server has no storage and therefore no override, on every render. */
function overrideServerSnapshot(): number | null {
  return null;
}

function useDemoSetupOverride(available: boolean) {
  const expiresAt = useSyncExternalStore(
    subscribeOverride,
    overrideSnapshot,
    overrideServerSnapshot,
  );

  return {
    active: available && expiresAt !== null,
    turnOff() {
      clearDemoSetupOverride();
      setOverride(null);
    },
    turnOn() {
      setOverride(startDemoSetupOverride(Date.now()).expiresAt);
    },
  };
}

/**
 * The control itself, which lives inside the context eye and nowhere else.
 *
 * The eye is where this console already puts things a reviewer opens on purpose, it is already
 * labelled "review only" in its own corner, and it is the one place on a coach screen that is not
 * a coach's own control. A button in the page header or the account sheet would read as a product
 * feature, and this is not one: it draws a state that no receipt supports, for ten minutes, on a
 * seeded tenant.
 *
 * One button, one state, so switching it off is the same click in the same place as switching it
 * on.
 */
function DemoSetupControl({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle(): void;
}) {
  return (
    <div>
      <p className="m-0 text-[oklch(0.85_0.01_262)]">
        {active
          ? "The setup steps above are being shown complete for this demo. Nothing was saved, nobody else sees it, and it clears itself within ten minutes."
          : "Show the setup steps as complete for ten minutes. This only changes what this browser draws. It writes nothing, and no other viewer of this account is affected."}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          className="inline-flex min-h-8 items-center rounded-lg bg-white/12 px-3 py-1.5 text-[14px] font-medium text-[oklch(0.97_0.004_262)] transition-colors duration-150 hover:bg-white/20 motion-reduce:transition-none"
          data-slot="demo-setup-override-toggle"
          onClick={onToggle}
          type="button"
        >
          {active ? "Show the real setup" : "Show setup as complete"}
        </button>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The first run's right-hand column
 * ------------------------------------------------------------------------------------------ */

/**
 * What the first-run screen puts where the figures will be, per `HomeFirstRun.dc.html:...`.
 *
 * The previous build drew three figure cards here with a dash in each and a dashed rule under it,
 * which is the shape `docs/COACH-REDESIGN-PLAYBOOK.md` rule 1 exists to forbid: three empty charts
 * are a picture of nothing, drawn at the size of something. The artboard replaces all three with
 * one drenched panel that says what will appear and when, and one card offering the single thing a
 * coach with no leads can actually do.
 *
 * Neither panel reads a metric, deliberately. A first-run screen is the state where every figure
 * is absent by definition, so a figure here could only ever be a zero standing in for "not yet".
 *
 * The artboard's hero line reads "answers within a minute of a DM". That is a latency promise
 * nothing on this page has a receipt for, and `README.md`'s release boundary is explicit about
 * presenting a capability without one, so the sentence keeps the claim the setup rail above it
 * already makes from the connection rows and drops the number.
 */
function FirstRunHero() {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <DeckPanel
        dataSlot="home-first-run-hero"
        drench="live"
        eyebrow="Once you are live"
        headingId="home-first-run-hero-heading"
        hero
        name="Your leads"
      >
        <p className="max-w-[var(--measure-caption)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]">
          Your first leads will appear here.
        </p>
        <p className="coach-panel__sentence">
          Your agent answers a DM the moment it arrives, asks your qualifying questions and books
          the good ones onto your calendar.
        </p>
        <p className="coach-panel__stat-note">
          Your numbers will show here once leads start arriving.
        </p>
      </DeckPanel>

      <DeckPanel
        action={{ href: "/coach/agent", label: "Open your agent" }}
        dataSlot="home-first-run-try"
        eyebrow="Before a lead does"
        headingId="home-first-run-try-heading"
        name="Try a conversation"
      >
        <p className="coach-panel__sentence">
          Message your agent the way a lead would. Test conversations never count as leads.
        </p>
      </DeckPanel>
    </div>
  );
}

/* --------------------------------------------------------------------------------------------
 * The screen
 * ------------------------------------------------------------------------------------------ */

export function CoachDashboard({
  channelStatus,
  composition,
  customFrom,
  customTo,
  greeting,
  measurement,
  now,
  setup = null,
  window,
}: CoachDashboardProps) {
  const firstRun = setupIncomplete(channelStatus);
  /*
   * The demo setup override, gated twice and presented once.
   *
   * Both gates are hard. `demoAccountSwitching` is `SETTERFI_DEMO_LOGINS`, resolved on the server
   * layout, and `account.isDemo` is `tenants.is_demo` for the signed-in tenant, read by that same
   * layout. `measurement.isDemo` is the third: it is the flag the provenance line under the
   * greeting already prints, so the control cannot appear on a page that is not already telling the
   * room these rows are seeded. Any one of the three being false or unknown removes the control,
   * which is the direction an unknown has to fail in.
   *
   * It is offered only on the first-run composition, because that is the only composition with a
   * setup rail to override. Elsewhere it would be a switch with nothing behind it.
   */
  const workspace = useWorkspaceEnv();
  const overrideAvailable = firstRun
    && Boolean(channelStatus)
    && workspace.demoAccountSwitching === true
    && workspace.account?.isDemo === true
    && measurement.isDemo === true;
  const demoOverride = useDemoSetupOverride(overrideAvailable);
  /*
   * One substitution, at the top, feeding every consumer. The status line, the rungs and the
   * counter all read these two values, so they cannot disagree about whether the setup is done: it
   * is not possible to override the cards and leave the header saying a step is waiting, because
   * the header is reading the same object.
   */
  const displayStatus = demoOverride.active ? DEMO_COMPLETE_STATUS : channelStatus;
  const displaySetup = firstRun ? (demoOverride.active ? DEMO_COMPLETE_SETUP : setup) : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/*
        The head: the greeting, one status sentence, the provenance line, and the row of controls
        the artboard puts beside the title. It wraps on a narrow pane rather than squeezing,
        because the range control is six stops wide and a 46px title is not something to shrink.
      */}
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="coach-page-title m-0">
            {greeting
              ? `${firstRun ? "Welcome" : "Welcome back"}, ${greeting}`
              : "Dashboard"}
          </h1>
          <StatusLine now={now} setup={displaySetup} status={displayStatus} />
          {/*
            The provenance line, which is a hard rule rather than a decoration: demo and test rows
            are labelled on screen wherever they are shown. `measurement.isDemo` is the flag the
            repository already resolves, so nothing new is read to say it.
          */}
          <p
            className="m-0 mt-[10px] text-[14px] text-[var(--muted)]"
            data-provenance={
              demoOverride.active ? "demo-override" : measurement.isDemo ? "demo" : "real"
            }
          >
            {demoOverride.active
              ? DEMO_OVERRIDE_PROVENANCE
              : PROVENANCE_COPY[measurement.isDemo ? "demo" : "real"]}
          </p>
        </div>
        {/*
          The header's trailing control row. What sits in it changes with the run: a first-run
          screen has no window to pick, because it has no figures to pick one for.
        */}
        {/*
          On a phone the strip is the row: six word stops do not fit across 390, so the strip takes
          the full width and scrolls sideways inside it, which is what `HomeMobile.dc.html` draws.
          Sharing the line with the eye there clipped it mid-stop and made a scroller look like a
          truncation.
        */}
        <div className="flex w-full min-w-0 flex-wrap items-end gap-3 sm:w-auto sm:flex-nowrap">
          {firstRun ? null : (
            <CoachHomeRange customFrom={customFrom} customTo={customTo} window={window} />
          )}
          <ContextEye
            action={overrideAvailable
              ? (
                <DemoSetupControl
                  active={demoOverride.active}
                  onToggle={demoOverride.active ? demoOverride.turnOff : demoOverride.turnOn}
                />
              )
              : undefined}
            copy={EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-dashboard"
          />
        </div>
      </div>

      {firstRun && displayStatus ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start">
          <div className="flex min-w-0 flex-col gap-4">
            {displaySetup ? (
              <FirstRun now={now} setup={displaySetup} />
            ) : (
              <p className="m-0 text-[16px] text-[var(--muted)]" data-slot="home-setup-unread">
                We could not read your setup just now. Nothing has changed while we could not read
                it.
              </p>
            )}
          </div>
          <FirstRunHero />
        </div>
      ) : (
        <>
          <CoachHomeBubbles measurement={measurement} window={window} />
          <CoachHomeMonths composition={composition} />
          <CoachHomeKeywords
            customFrom={customFrom}
            customTo={customTo}
            keywords={measurement.keywords}
            window={window}
          />
        </>
      )}
    </div>
  );
}
