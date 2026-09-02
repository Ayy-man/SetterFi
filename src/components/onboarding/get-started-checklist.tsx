"use client";

import { ArrowLeft, ChevronDown, QuestionMark, ShieldCheck } from "@/components/kit/icons";

import { useCallback, useEffect, useId, useReducer, useState, type ReactNode } from "react";

import type { ArtifactView } from "@/app/api/onboarding/artifacts/handler";
import {
  Figure,
  MonoMeta,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
  StatusDot,
  Surface,
} from "@/components/kit/atomics";
import { CoachPageHead, PROVENANCE_COPY, type CoachProvenance } from "@/components/workspace/live/coach-page-head";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_LEAD_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import { DataState } from "@/components/kit/data-state";
import { elapsedWorkspaceDays } from "@/components/kit/day-counter";
import type { StateTone } from "@/components/kit/state-badge";
import { StepJourney, type JourneyStep } from "@/components/kit/step-journey";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { workspaceDateFormat, workspaceTimestampFormat } from "@/lib/format/datetime";
import {
  a2pProjectionDescriptor,
  artifactDescriptor,
  contentScreenDescriptor,
  templateVersionLabel,
} from "@/components/onboarding/view-models";
import { fetchWithTimeout } from "@/lib/fetch-with-timeout";
import type { ContentScreenResult, ReadinessResult } from "@/lib/onboarding/contracts";
import type { CoachA2pRegistrationProjection } from "@/lib/repositories/onboarding-evidence";

type ArtifactPayload = { artifact: ArtifactView | null };
type ScreenPayload = { screen: ContentScreenResult | null };
type ReadinessPayload = { readiness: ReadinessResult };
type RegistrationPayload = { registration: CoachA2pRegistrationProjection | null };

type ResourceKey = "artifacts" | "contentScreen" | "readiness" | "a2p";
type ResourceData = ArtifactPayload | ScreenPayload | ReadinessPayload | RegistrationPayload;
type ResourceState = {
  status: "loading" | "ok" | "failed";
  data?: ResourceData;
  loadError?: string;
  actionError?: string;
};
type ChecklistState = Record<ResourceKey, ResourceState>;

type ChecklistAction =
  | { type: "loadStarted"; keys: readonly ResourceKey[] }
  | { type: "loadSucceeded"; key: ResourceKey; data: ResourceData }
  | { type: "loadFailed"; key: ResourceKey; code: string }
  | { type: "actionRefused"; key: "artifacts" | "contentScreen"; code: string }
  | { type: "actionSucceeded"; key: "artifacts" | "contentScreen" };

const RESOURCE_KEYS = ["artifacts", "contentScreen", "readiness", "a2p"] as const;
const STEP_RESOURCE_KEYS = ["readiness", "artifacts", "contentScreen", "a2p"] as const;

const RESOURCE_ENDPOINTS: Record<ResourceKey, string> = {
  artifacts: "/api/onboarding/artifacts",
  contentScreen: "/api/onboarding/content-screen",
  readiness: "/api/onboarding/readiness",
  a2p: "/api/onboarding/a2p-registration",
};

const RESOURCE_FAILURES: Record<ResourceKey, { title: string; body: string }> = {
  artifacts: {
    title: "Your consent page could not be checked",
    body: "The other setup steps are still available while we retry this saved page.",
  },
  contentScreen: {
    title: "Your welcome message could not be checked",
    body: "The other setup steps are still available while we retry this review.",
  },
  readiness: {
    title: "Your business details could not be checked",
    body: "The other setup steps are still available while we retry the readiness check.",
  },
  a2p: {
    title: "Carrier review could not be checked",
    body: "The other setup steps are still available while we retry the carrier status.",
  },
};

/*
 * Every face, overline, figure and mono readout on this page now comes from `kit/atomics`. It used
 * to carry its own copies of all four -- a 9.5px overline string, an 11.5px mono meta string, a
 * 22px figure string and two surface strings -- which is exactly the drift the craft audit found
 * across the rebuilt coach surfaces: seven lanes retyping the same nine class strings, and a coach
 * able to see where they retyped them differently. What is left here is layout and the two type
 * roles the atomics have no opinion about.
 */
/*
 * Coach sizes, not the console's. This page renders inside the coach shell, so `coach.css` has
 * already raised the root to 16px -- but a class whose size is an absolute px value does not move
 * with a root font-size, so the page went on rendering at the console's density however loud the
 * shell said the surface was. That is the exact trap `coach-type.ts` was written for, which is
 * where the card title that used to sit here now lives: it was `--coach-panel-name`'s recipe
 * retyped, in this file and in `coach-integrations.tsx`, spelled the same byte for byte.
 */
const CARD_SUB_CLASS = `mt-[var(--s-2)] ${COACH_FOOTNOTE_CLASS}`;

const OWNER_TEXT: Record<JourneyStep["owner"], string> = {
  carrier: "the carrier",
  meta: "Meta",
  setterfi: "SetterFi",
  you: "you",
};

/*
 * The journey, rendered at the coach's density rather than the console's.
 *
 * `StepJourney` is a kit component and its type comes off the `--t-*` scale, which is fixed at the
 * owner console's sizes: `--t-row` is 14px and `--t-body` 13px. That is the right scale for the
 * client's own team, and it is precisely the size the round-1 coaches said they could not read. The
 * shell around this page is already at 16px because `coach.css` raised the root, but an absolute px
 * class does not move with a root font-size, so the journey went on rendering small inside a large
 * page -- the same trap `coach-type.ts` was written for, one component further down.
 *
 * The fix is a scale applied from outside rather than a fork of the component: `StepJourney` is
 * shared with the console and with the admin provisioning view, so changing its own classes would
 * move two other readers' screens to fix this one. These arbitrary variants reach the parts it
 * already names in its markup -- `.step__title`, `.step__text`, `.step__owner`, `.step__receipt`,
 * the sequencing note and the badge label -- and lift each to the coach sizes the canvas draws:
 * 20px step names, 16px body, 15px metadata. The escaped underscores are Tailwind's own syntax for
 * a literal `_` inside an arbitrary selector, where a bare `_` would be read as a space.
 *
 * Nothing here truncates. That matters because the step title is a flex line carrying both the name
 * and its state badge, which is the exact shape that shredded the inbox's lead names into "Jo…" --
 * a shrink-0 metadata chip sharing a line with a longer name. `StepJourney` wraps that line rather
 * than clipping it, so at 20px the badge drops to its own row instead of eating the title.
 */
const COACH_JOURNEY_SCALE = [
  /*
   * `String.raw` rather than a plain string literal, and this is load-bearing rather than
   * stylistic. Tailwind finds a class by scanning the source text, so the candidate it compiles is
   * whatever the file says here; React then sets `className` to whatever the string *evaluates* to.
   * In a normal literal `"\_"` is an unrecognised escape that collapses to a bare `_`, and `"\\_"`
   * evaluates to `\_` while the scanner reads the two backslashes it can see -- either way the
   * compiled rule and the rendered class name are different strings and the styling silently does
   * nothing. A raw string makes the two identical, which is the only form of this that works.
   */
  /*
   * 21px/600, which `CoachSetup.dc.html:119` draws. The size was 20px and the weight was left to
   * `StepJourney`, which takes it from the console's `--t-section-w` -- so the step name rendered
   * a pixel short at the console's weight on the one screen a coach reads while they are still
   * deciding whether this product works. The weight is overridden here alongside the size because
   * the two are one decision about one heading, and lifting only the size is what left it looking
   * like body copy at a larger size rather than like a name.
   */
  String.raw`[&_.step\_\_title]:text-[21px] [&_.step\_\_title]:leading-[1.3] [&_.step\_\_title]:font-[600]`,
  String.raw`[&_.step\_\_text]:text-[16px] [&_.step\_\_text]:leading-[1.55]`,
  String.raw`[&_.step\_\_owner]:text-[15px] [&_.step\_\_owner]:leading-[1.5]`,
  String.raw`[&_.step\_\_receipt]:text-[15px] [&_.step\_\_receipt]:leading-[1.5]`,
  String.raw`[&_.step\_\_next-note]:text-[15px]`,
  /*
   * The badge's root as well as its label, and the root is the one that was missed. `StateBadge`
   * sets `text-body` on the pill and `state-badge__label` only on the words inside it, so lifting
   * the label alone left the pill itself at the console's 13px -- which is the size anything the
   * badge renders outside that span takes, and the line-height the whole pill is laid out on.
   * Found by the sweep in `get-started-checklist.test.tsx`, on six steps at once, four audits
   * after the label was fixed.
   */
  String.raw`[&_.state-badge]:text-[15px]`,
  String.raw`[&_.state-badge\_\_label]:text-[15px]`,
  /*
   * The one line in the journey the scale could not previously reach.
   *
   * `step-journey.tsx` printed "Nothing for you to do" with a bare `text-body` and no class name,
   * so there was nothing for an arbitrary variant to select and the sentence stayed at the
   * console's `--t-body`, 13px, on a page whose floor is 14px and whose body is 16px. It now
   * carries `step__nothing`, for the same reason every other line in that row carries a name.
   * Neither guard could see it: `coach-type-floor.test.ts` matches `text-[Npx]` literals in
   * coach-only modules and this one is a token utility in a module admin also reaches.
   *
   * It is also the line the carrier step ends on, so it is the last thing a coach reads about the
   * clock nobody controls -- which is why 16px rather than the 15px the metadata rows above take.
   *
   * **No `.daycount` entry, and the absence is the finding.** A round-4 report has this page
   * rendering `DayCounter` at 13px and calls it the page's honest-state line. It does not:
   * `get-started-checklist.tsx` sets no `wait` on any step, so `StepJourney`'s `DayCounter` branch
   * never runs here, and the A2P clock on this page is `CarrierWait` below -- its own readout, a
   * 38px mono figure with the submission date and the typical range beside it. Adding a rule for
   * an element this page does not render would have looked like a fix and guarded nothing.
   * `DayCounter` does render small on two other coach surfaces (`coach-channel-status.tsx` on
   * Home and `coach-integrations.tsx`); that is a real breach and it is not this file's.
   */
  String.raw`[&_.step\_\_nothing]:text-[16px]`,
].join(" ");

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six"] as const;

function countWord(value: number) {
  return COUNT_WORDS[value] ?? String(value);
}

function sentenceCase(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/**
 * The lead sentence under "Your setup", counted from the steps rather than written as a string.
 *
 * The canvas words it "Two are finished, one is with the phone carriers, and two are waiting on
 * you", and a sentence of that shape is the single most perishable thing on the page: every clause
 * in it is a claim about state that changes the moment a receipt lands, and a hard-coded copy of it
 * would be wrong within a day of the first coach reading it while still reading as authored copy
 * rather than as a bug. So it is derived from the same `steps` array the journey below renders,
 * and the two can never disagree.
 *
 * Three buckets, in the order a reader wants them: what is finished, what an outside party is
 * holding, and what is waiting on the coach. A bucket with nothing in it contributes no clause
 * rather than "zero are finished", and the external clause names the actual owners the steps carry
 * so it can say "the carrier" without the page having assumed which clock is running.
 */
export function journeySummary(steps: readonly JourneyStep[]): string {
  const done = steps.filter((step) => step.state === "done");
  const external = steps.filter((step) => step.state !== "done" && step.owner !== "you");
  const yours = steps.filter((step) => step.state !== "done" && step.owner === "you");

  const clauses: string[] = [];
  const verb = (count: number) => (count === 1 ? "is" : "are");
  if (done.length > 0) {
    clauses.push(`${countWord(done.length)} ${verb(done.length)} finished`);
  }
  if (external.length > 0) {
    const owners = [...new Set(external.map((step) => OWNER_TEXT[step.owner]))];
    const named = owners.length > 1
      ? `${owners.slice(0, -1).join(", ")} and ${owners[owners.length - 1]}`
      : owners[0];
    clauses.push(`${countWord(external.length)} ${verb(external.length)} with ${named}`);
  }
  if (yours.length > 0) {
    clauses.push(`${countWord(yours.length)} ${verb(yours.length)} waiting on you`);
  }

  const opening = `${sentenceCase(countWord(steps.length))} steps, in order.`;
  if (clauses.length === 0) return opening;
  const tail = clauses.length === 1
    ? clauses[0]
    : `${clauses.slice(0, -1).join(", ")}, and ${clauses[clauses.length - 1]}`;
  return `${opening} ${sentenceCase(tail)}.`;
}

const initialState: ChecklistState = {
  artifacts: { status: "loading" },
  contentScreen: { status: "loading" },
  readiness: { status: "loading" },
  a2p: { status: "loading" },
};

function checklistReducer(state: ChecklistState, action: ChecklistAction): ChecklistState {
  if (action.type === "loadStarted") {
    const next = { ...state };
    for (const key of action.keys) {
      const previous = state[key];
      next[key] = {
        ...previous,
        status: "loading",
        loadError: undefined,
      };
    }
    return next;
  }

  if (action.type === "loadSucceeded") {
    const previous = state[action.key];
    return {
      ...state,
      [action.key]: {
        ...previous,
        status: "ok",
        data: action.data,
        loadError: undefined,
      },
    };
  }

  if (action.type === "loadFailed") {
    return {
      ...state,
      [action.key]: {
        ...state[action.key],
        status: "failed",
        loadError: action.code,
      },
    };
  }

  if (action.type === "actionSucceeded") {
    const previous = state[action.key];
    return {
      ...state,
      [action.key]: {
        ...previous,
        actionError: undefined,
      },
    };
  }

  return {
    ...state,
    [action.key]: {
      ...state[action.key],
      actionError: action.code,
    },
  };
}

function hasKey<K extends string>(value: unknown, key: K): value is Record<K, unknown> {
  return value !== null && typeof value === "object" && key in value;
}

function payloadFor(key: ResourceKey, value: unknown): ResourceData {
  if (key === "artifacts" && hasKey(value, "artifact")) return value as ArtifactPayload;
  if (key === "contentScreen" && hasKey(value, "screen")) return value as ScreenPayload;
  if (key === "readiness" && hasKey(value, "readiness")) return value as ReadinessPayload;
  if (key === "a2p" && hasKey(value, "registration")) return value as RegistrationPayload;
  throw new Error("The response did not match the saved setup contract.");
}

async function readResource(key: ResourceKey): Promise<ResourceData> {
  const response = await fetchWithTimeout(RESOURCE_ENDPOINTS[key], { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(RESOURCE_FAILURES[key].title);
  return payloadFor(key, body);
}

function dataFrom<T extends ResourceData>(state: ResourceState): T | null {
  return state.data ? state.data as T : null;
}

function receiptTime(value: string | null | undefined) {
  if (!value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/**
 * The A2P wait, stated as a figure the coach can check against a calendar. A day count and the
 * submission date are facts; a percentage or a predicted finish date would be an invention, and
 * carrier vetting is exactly the clock nobody here controls. Mono in a well, because it is a
 * readout rather than a sentence.
 */
function CarrierWait({ nowIso, since }: { nowIso: string; since: string }) {
  const day = elapsedWorkspaceDays(since, new Date(nowIso));
  const submitted = Number.isNaN(Date.parse(since))
    ? null
    : workspaceDateFormat.format(new Date(since));

  return (
    <Surface
      as="span"
      className="mt-[var(--s-3)] flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-1)]"
      variant="well"
    >
      <span className="flex basis-full items-center gap-[var(--s-2)]">
        {/* Amber, not periwinkle. `docs/DESIGN.md` assigns provisioning day counters to
            `--warning` by name and spells the treatment out: "a real day counter in mono with a
            --warning dot". The periwinkle waiting family is for a state pill, not for this. */}
        <StatusDot size={6} tone="warning" />
        <span className={COACH_EYEBROW_CLASS}>Waiting on the carrier</span>
      </span>
      {day === null ? (
        <span className={COACH_ROW_NAME_CLASS}>Still waiting</span>
      ) : (
        /* The day counter at the deck's own figure size. It is the number the coach opened this
           row for, and it is the honest answer to "how long": whole elapsed days, the typical
           range beside it, and no percentage or predicted date anywhere near it. */
        <Figure className="text-[38px] leading-[0.95] tracking-[-0.06em]" size="lg">Day {day}</Figure>
      )}
      <MonoMeta className="text-[14px]">
        {day === null || !submitted
          ? "the submission date was not recorded, so no day count is shown"
          : `submitted ${submitted}`}
        {" · typical 14 to 21 days · no action needed from you"}
      </MonoMeta>
    </Surface>
  );
}

function CarrierStepBody({ body, nowIso, since }: { body: string; nowIso: string; since: string | null }) {
  const checks = [
    "Your registered business matches public records.",
    "Your consent page explains how leads agree to texts and how they stop them.",
    "Your sample messages match what your agent sends.",
    "Your requested sending volume fits your business.",
  ] as const;
  const [open, setOpen] = useState(true);
  const panelId = useId();

  return (
    <>
      <span className="block">{body}</span>
      {since ? <CarrierWait nowIso={nowIso} since={since} /> : null}
      {/* A quiet disclosure, not a second heading: the carrier's checklist is reference detail
          under the step, so its head stays 13/500 muted and never competes with the step title. */}
      {/*
        Six class names came off this element and every one of them styled nothing, and then
        `surface-well` came off too because it was styling the wrong thing.

        The dead six: `px-0 py-0` lost to `.surface-well`, which declares `padding: 12px 13px` in
        `globals.css` -- an unlayered sheet, so it beats any Tailwind utility whatever the
        specificity, because v4 emits utilities into `@layer utilities`. And `acc`, `acc--quiet`,
        `acc__head` and `acc__chev` are defined nowhere in `src/`: they belong to the round-3
        rebuild's stylesheets, which were deleted rather than superseded.
        The chevron still turns because its rotation is an inline `style`.

        The recipe went with them, and the ruling is that this is a call site wearing the wrong
        recipe rather than a recipe that is wrong. 34 of the 35 `.surface-well` uses hold text
        directly and want its padding; this one wraps two children that each carry their own
        `--s-3`, so it was insetting its content twice and its trigger's rounded hover surface
        could not reach the well's edge. The old sheet's `.setup .acc--quiet { border: 0 }` says
        this was authored as a borderless quiet ground, so the border it has been wearing was
        never designed for it either. No variant was added for one caller -- that is how a design
        system accumulates a face per call site; the children own their spacing, which they were
        already doing.

        What is genuinely unresolved is whether the artboard draws a quiet borderless ground here
        at all. It is logged rather than invented.
      */}
      <span className="mt-[var(--s-3)] block" data-open={open ? "true" : "false"}>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          className={`flex w-full items-center gap-[var(--s-2)] rounded-[var(--r-well)] px-[var(--s-3)] py-[var(--s-3)] text-left ${COACH_READING_CLASS} font-medium text-[var(--muted)] hover:text-[var(--ink)]`}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          What the carrier is checking
          <ChevronDown
            aria-hidden="true"
            className="ml-auto size-[var(--s-4)] shrink-0 text-[var(--faint)] transition-transform duration-[var(--duration-quick)] ease-[var(--ease-out)]"
            style={{ transform: open ? "scaleY(-1)" : undefined }}
          />
        </button>
        {open ? (
          <span
            className="block px-[var(--s-3)] pb-[var(--s-3)]"
            data-state="pending"
            data-step-panel="carrier-review"
            id={panelId}
          >
            <span className={`block ${COACH_READING_CLASS} text-[var(--muted)]`}>
              We do not get told which of these has passed.
            </span>
            <span
              className={`mt-[var(--s-3)] flex flex-col gap-[var(--s-3)] ${COACH_READING_CLASS} text-[var(--body)]`}
              role="list"
            >
              {checks.map((check) => (
                <span className="flex items-start gap-[var(--s-2)]" key={check} role="listitem">
                  {/* Neutral by contract: we are not told which of these passed, so the mark may
                      never take a verdict tone. The sentence above says so in words too. */}
                  <span className="mt-[7px]"><StatusDot size={5} tone="neutral" /></span>
                  <Prose as="span" className="block">{check}</Prose>
                </span>
              ))}
            </span>
          </span>
        ) : null}
      </span>
    </>
  );
}

export type ChannelStripEntry = {
  key: string;
  name: string;
  stateLabel: string;
  tone: StateTone;
  action: { label: string; href: string } | null;
};

function ChannelStrip({ channels }: { channels: readonly ChannelStripEntry[] }) {
  /*
   * The quietest member of the page: it states channel facts SetterFi already knows and is never
   * the thing the coach came here to do, so it gets a wash rather than a card face and its verbs
   * are accent text, never the page's one fill.
   *
   * **The trailing link is the only unconditional route to `/coach/integrations` in the product,
   * and that is deliberate.** Every other way in fires on a problem -- Home's attention queue
   * gives a blocked channel the page's fill, and the per-channel action above appears only while
   * that channel is not live -- so a coach whose channels are all healthy had a live page with no
   * door. A route that exists as a side effect of a filter is the same defect that put two rows
   * back on the rail once already. So this link renders whatever the channels say, including when
   * the connections read failed and there are no rows to show at all: the facts are absent then,
   * but the way to the page that owns them is not a fact and does not go missing with them. Setup
   * itself is unconditionally reachable (the mounted support bubble), so this makes Connections
   * unconditionally reachable too. Pinned in `workspace-navigation.test.ts`.
   */
  return (
    <section
      aria-label="Channel status"
      className="surface-strip @container/strip mb-[var(--s-6)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-3)]">
        <p className={COACH_EYEBROW_CLASS}>Channels</p>
        <a
          className="link-inline shrink-0 text-[16px] font-medium"
          data-slot="channel-strip-connections"
          href="/coach/integrations"
        >
          Manage your connections
        </a>
      </div>
      {channels.length === 0 ? null : (
      <ul className="mt-[var(--s-3)] grid gap-[var(--s-2)] @2xl/strip:grid-cols-3 @2xl/strip:gap-[var(--s-4)]">
        {channels.map((channel) => (
          <li
            aria-current={channel.key === "sms" ? "true" : undefined}
            className="flex min-w-0 items-center gap-[var(--s-3)]"
            key={channel.key}
          >
            <span className={`min-w-0 flex-1 truncate ${COACH_ROW_NAME_CLASS}`}>
              {channel.name}
            </span>
            {/* One treatment for the whole list: bare dot plus its own words, which is what a
                three-across strip of facts wants -- a column of lozenges here would out-weigh the
                channel names they belong to. */}
            <Status
              label={channel.stateLabel}
              tone={STATE_TONE_TO_TONE[channel.tone]}
              treatment="bare"
            />
            {channel.action ? (
              <a
                className="link-inline inline-flex shrink-0 items-center whitespace-nowrap text-[16px] font-medium"
                href={channel.action.href}
              >
                {channel.action.label}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
      )}
    </section>
  );
}

type EvidenceRow = { label: string; at: string; tone: "good" | "warning" };

function evidenceTime(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Time could not be read"
    : workspaceTimestampFormat.format(parsed);
}

function FilingEvidence({
  filing,
  history,
  technical,
}: {
  filing: readonly { label: string; value: string }[];
  history: readonly EvidenceRow[];
  technical: readonly { label: string; value: string }[];
}) {
  const empty = filing.length === 0 && history.length === 0 && technical.length === 0;

  return (
    <Surface
      aria-label="Filing evidence"
      as="section"
      className="@container/card flex min-w-0 flex-col p-[var(--s-4)]"
      /* `well` rather than `strip`, on role rather than on availability. `.surface-strip` was
         dark-only when this was written and is fixed as of 764db65, so both variants render; a
         strip is the page-wide quiet band the "Right now" line above uses, and this is a recessed
         drawer holding references -- which is what a well is. No face gradient, no shadow either
         way, so the two look close; the difference is what the next reader infers about the role. */
      variant="well"
    >
      {/*
        The closing panel, and deliberately the quietest thing on the page.

        The canvas puts it at the foot as one low-contrast strip whose entire body is folded away
        behind a single button: a coach reads it once, if ever, and only to prove that something
        happened on a date, so Filing and History rendering open made the page end on a wall of
        references nobody asked for. Only the claim and the button show now.

        The one deviation from the artboard's geometry: the button sits under the sentence rather
        than to its right, because what it opens is a full-width table of labels and values and a
        disclosure that expands into a `flex-none` right-hand column would open its contents into
        the narrowest part of the row. Closed -- which is how the artboard draws it and how a coach
        will nearly always see it -- the strip is still the compact quiet row it is meant to be.
      */}
      <div className="flex min-w-0 items-start gap-[var(--s-4)]">
        <ShieldCheck aria-hidden className="mt-[3px] size-[var(--s-5)] shrink-0 text-[color:var(--faint)]" />
        <div className="min-w-0">
          {/*
            18px/500 in `--body`, per `CoachSetup.dc.html:182`, and deliberately not
            `COACH_PANEL_NAME_CLASS`. That constant is the banded panel name -- 20px/500 in
            `--ink`, the heading that opens a card inside a hairline band. This strip is not that
            shape: it is a quiet full-width row with an icon, sitting under the steps rather than
            heading a panel, and the artboard draws it a step smaller in the body colour precisely
            so it reads as a footnote to the journey instead of as a sixth step. Borrowing the
            panel-name role gave it a card's authority on a row that is not a card.
          */}
          <h2 className="m-0 text-[18px] leading-[1.35] font-[500] text-[color:var(--body)]">
            Every step above has a receipt
          </h2>
          <Prose className={CARD_SUB_CLASS} measure="prose">
            Meta&rsquo;s approval reference, the carrier campaign code and the checksum of what we
            filed, with the date and time of each. Open it if you ever need to prove when something
            happened.
          </Prose>
        </div>
      </div>

      {empty ? (
        <Prose className={`mt-[var(--s-4)] ${COACH_READING_CLASS} text-[color:var(--muted)]`} measure="caption">
          No filing evidence has been recorded yet.
        </Prose>
      ) : (
        // One fold, not three. The kit disclosure takes the strip's own words as its label and
        // carries Filing and History as children, so there is a single button rather than a
        // "Technical detail" drawer sitting beside two open tables.
        <TechnicalDetail
          className="mt-[var(--s-4)] rounded-[var(--r-well)] border-[var(--line)] bg-[var(--well)]"
          items={technical}
          label="Show the technical record"
        >
          {filing.length > 0 ? (
            <div>
              <h3 className={`m-0 ${COACH_EYEBROW_CLASS}`}>Filing</h3>
              <dl className={`mt-[var(--s-3)] grid gap-x-[var(--s-4)] gap-y-[var(--s-2)] ${COACH_READING_CLASS} @xs/card:grid-cols-[minmax(0,auto)_minmax(0,1fr)]`}>
                {filing.map((item) => (
                  <div className="contents" key={item.label}>
                    <dt className="text-[color:var(--muted)]">{item.label}</dt>
                    <dd className="min-w-0 break-words text-[color:var(--ink)]">{item.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {history.length > 0 ? (
            <div className="mt-[var(--s-4)]">
              <h3 className={`m-0 ${COACH_EYEBROW_CLASS}`}>History</h3>
              <ol className="mt-[var(--s-3)] flex flex-col">
                {history.map((item) => (
                  <li
                    className={`grid items-start gap-x-[var(--s-3)] gap-y-[var(--s-1)] border-b border-[var(--line-soft)] py-[var(--s-3)] ${COACH_READING_CLASS} last:border-b-0 @xs/card:grid-cols-[minmax(0,1fr)_auto]`}
                    key={`${item.label}:${item.at}`}
                  >
                    <span className="flex items-start gap-[var(--s-2)] text-[color:var(--body)]">
                      <span className="mt-[6px]"><StatusDot size={5} tone={item.tone} /></span>
                      <span className="min-w-0">{item.label}</span>
                    </span>
                    <MonoMeta className="whitespace-nowrap @xs/card:text-right">
                      {evidenceTime(item.at)}
                    </MonoMeta>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </TechnicalDetail>
      )}

      <p className={`mt-[var(--s-4)] flex items-center gap-[var(--s-2)] border-t border-[var(--line-soft)] pt-[var(--s-3)] ${COACH_FOOTNOTE_CLASS}`}>
        <ShieldCheck aria-hidden className="size-[var(--s-3)]" />
        Read-only. Logged.
      </p>
    </Surface>
  );
}


type ChecklistJourneyStep = Omit<JourneyStep, "body"> & { body: ReactNode };

export function GetStartedChecklist({
  enabled,
  nowIso,
  // The coach client has no route that lists channel connections, so the strip renders only
  // what a caller supplies. Absent data renders no strip rather than an invented channel state.
  channels = [],
  /*
   * What this workspace's records are, read on the server and passed down.
   *
   * A prop rather than a fetch because it is a fact about the account rather than a resource this
   * component polls, and because the page already holds the tenant id. `"unknown"` when the read
   * did not answer -- see `loadTenantProvenance`, which refuses to report a failed read as "real".
   */
  provenance,
}: {
  enabled: boolean;
  nowIso: string;
  channels?: readonly ChannelStripEntry[];
  provenance?: CoachProvenance;
}) {
  const [resources, dispatch] = useReducer(checklistReducer, initialState);

  const load = useCallback(async (keys: readonly ResourceKey[] = RESOURCE_KEYS) => {
    if (!enabled) return;
    dispatch({ type: "loadStarted", keys });
    const settled = await Promise.allSettled(keys.map((key) => readResource(key)));
    settled.forEach((result, index) => {
      const key = keys[index];
      if (result.status === "fulfilled") {
        dispatch({ type: "loadSucceeded", key, data: result.value });
      } else {
        dispatch({ type: "loadFailed", key, code: RESOURCE_FAILURES[key].title });
      }
    });
  }, [enabled]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const artifactPayload = dataFrom<ArtifactPayload>(resources.artifacts);
  const screenPayload = dataFrom<ScreenPayload>(resources.contentScreen);
  const readinessPayload = dataFrom<ReadinessPayload>(resources.readiness);
  const registrationPayload = dataFrom<RegistrationPayload>(resources.a2p);
  const artifact = artifactPayload?.artifact ?? null;
  const screen = screenPayload?.screen ?? null;
  const readiness = readinessPayload?.readiness ?? null;
  const registrationEvidence = registrationPayload?.registration ?? null;
  const artifactView = artifact ? artifactDescriptor(artifact) : null;
  const contentView = contentScreenDescriptor(screen, screen?.inputHash ?? null);
  const registration = a2pProjectionDescriptor(registrationEvidence, Date.parse(nowIso));

  const tenantCheck = readiness?.checks.find((check) => check.key === "tenant_active") ?? null;
  const testCheck = readiness?.checks.find((check) => check.key === "test_passed") ?? null;
  const businessReadyAt = resources.readiness.status === "ok" && tenantCheck?.ready
    ? receiptTime(tenantCheck.evidenceAt)
    : null;
  const consentReadyAt = resources.artifacts.status === "ok" && artifact && !artifact.placeholder
    ? receiptTime(artifact.confirmedAt)
    : null;
  const welcomeReadyAt = resources.contentScreen.status === "ok" && contentView.filingAvailable
    ? receiptTime(screen?.adminConfirmedAt) ?? receiptTime(registrationEvidence?.submittedAt)
    : null;
  // read_coach_a2p_registration derives registrationState from the SMS provisioning steps, so
  // "done" is itself the carrier's approval. messaging_channel_live is satisfied by any live
  // channel (Instagram counts), so neither its readiness nor its timestamp can stand in for
  // SMS evidence; without the approval the step stays pending.
  const providerReceiptAt = resources.a2p.status === "ok"
    && registrationEvidence?.registrationState === "done"
    ? receiptTime(registrationEvidence.submittedAt)
    : null;
  /*
   * The safe test's own receipt, which is `provisioning_steps.test_pass.completed_at` reaching
   * this page through the readiness check rather than through a second fetch. It ticks the step
   * and nothing else does: `ready` without an `evidenceAt` is a claim with no timestamp behind it,
   * and `StepJourney` refuses a done step that carries no receipt anyway.
   */
  const testReadyAt = resources.readiness.status === "ok" && testCheck?.ready
    ? receiptTime(testCheck.evidenceAt)
    : null;
  const localMilestones = [
    Boolean(businessReadyAt),
    Boolean(consentReadyAt),
    Boolean(welcomeReadyAt),
  ] as const;
  const failedStepIndex = STEP_RESOURCE_KEYS
    .findIndex((key) => resources[key].status === "failed");
  const firstLocalIncomplete = localMilestones.findIndex((complete) => !complete);
  /*
   * Six steps now: the safe test sits between carrier review and go-live, which is the order the
   * runner already enforces -- `test_pass` depends on the calendar and the offer, and `go_live`
   * depends on `test_pass`, so a journey that jumped from the carrier straight to go-live was
   * hiding a gate the coach still had to clear.
   */
  const currentIndex = failedStepIndex >= 0
    ? failedStepIndex
    : providerReceiptAt
    ? testReadyAt ? 5 : 4
    : registration.kind === "registering" || registration.kind === "blocked"
      ? 3
      : firstLocalIncomplete < 0
        ? 3
        : firstLocalIncomplete;

  // Every evidence line below is a field the loaded payloads actually carry. A field that is
  // absent contributes no row, so the drawer never fills a gap with a plausible value.
  const filingEvidence = [
    ...(registrationEvidence?.submittedAt
      ? [{ label: "Submitted", value: evidenceTime(registrationEvidence.submittedAt) }]
      : []),
    ...(registrationEvidence
      ? [
          { label: "Filed by", value: "SetterFi, on your behalf" },
          { label: "Registration state", value: registration.label },
        ]
      : []),
    ...(registrationEvidence?.terminalCode
      ? [{ label: "Carrier decision code", value: registrationEvidence.terminalCode }]
      : []),
    ...(artifactView && artifact?.templateVersion
      ? [{ label: "Consent page version", value: templateVersionLabel(artifact.templateVersion) }]
      : []),
  ];
  const historyEvidence: EvidenceRow[] = [
    ...(providerReceiptAt
      ? [{ label: "Carrier registration approved", at: providerReceiptAt, tone: "good" as const }]
      : []),
    ...(registrationEvidence?.submittedAt && !providerReceiptAt
      ? [{ label: "Filing submitted, no carrier verdict yet", at: registrationEvidence.submittedAt, tone: "warning" as const }]
      : []),
    ...(registrationEvidence?.submittedAt && providerReceiptAt
      ? [{ label: "Filing submitted", at: registrationEvidence.submittedAt, tone: "good" as const }]
      : []),
    ...(screen?.adminConfirmedAt
      ? [{ label: "Welcome message confirmed by SetterFi", at: screen.adminConfirmedAt, tone: "good" as const }]
      : []),
    ...(screen?.coachAcknowledgedAt
      ? [{ label: "Welcome message acknowledged by you", at: screen.coachAcknowledgedAt, tone: "good" as const }]
      : []),
    ...(consentReadyAt
      ? [{ label: "Consent page confirmed", at: consentReadyAt, tone: "good" as const }]
      : []),
    ...(businessReadyAt
      ? [{ label: "Business details receipt stored", at: businessReadyAt, tone: "good" as const }]
      : []),
  ];
  const historyEvidenceNewestFirst = [...historyEvidence]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
  const technicalEvidence = [
    ...(artifactView ? [{ label: "Campaign hash", value: artifactView.campaignDescriptionHash }] : []),
    ...(artifact ? [{ label: "Consent artifact", value: artifact.artifactId }] : []),
    ...(screen ? [{ label: "Welcome screen", value: screen.screenId }] : []),
    ...(screen?.inputHash ? [{ label: "Welcome input hash", value: screen.inputHash }] : []),
    ...(registrationEvidence?.submittedAt
      ? [{ label: "Filed at", value: registrationEvidence.submittedAt }]
      : []),
  ];
  async function confirmConsentPage() {
    if (!artifact) return;
    try {
      const response = await fetchWithTimeout(RESOURCE_ENDPOINTS.artifacts, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: artifact.artifactId }),
      });
      if (!response.ok) {
        dispatch({
          type: "actionRefused",
          key: "artifacts",
          code: "Consent page confirmation was refused. Its saved state has not changed.",
        });
      } else {
        dispatch({ type: "actionSucceeded", key: "artifacts" });
      }
    } catch {
      dispatch({
        type: "actionRefused",
        key: "artifacts",
        code: "Consent page confirmation could not be sent. Its saved state has not changed.",
      });
    }
    await load(["artifacts"]);
  }

  async function acknowledgeWelcomeMessage() {
    if (!screen) return;
    try {
      const response = await fetchWithTimeout(RESOURCE_ENDPOINTS.contentScreen, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ screenId: screen.screenId }),
      });
      if (!response.ok) {
        dispatch({
          type: "actionRefused",
          key: "contentScreen",
          code: "Welcome message acknowledgement was refused. Its saved state has not changed.",
        });
      } else {
        dispatch({ type: "actionSucceeded", key: "contentScreen" });
      }
    } catch {
      dispatch({
        type: "actionRefused",
        key: "contentScreen",
        code: "Welcome message acknowledgement could not be sent. Its saved state has not changed.",
      });
    }
    await load(["contentScreen"]);
  }

  const steps: readonly JourneyStep[] = (() => {
    const scopedBody = (key: ResourceKey, body: ReactNode): ReactNode => {
      const resource = resources[key];
      return (
        <>
          {resource.actionError ? (
            <span
              className={`mb-[var(--s-3)] block rounded-[var(--r-well)] border border-[var(--failure-line)] bg-[var(--failure-wash)] px-[var(--s-3)] py-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--failure-body)]`}
              role="alert"
            >
              {resource.actionError}
            </span>
          ) : null}
          {resource.status === "failed" ? (
            <span className="block">
              {resource.loadError ?? RESOURCE_FAILURES[key].title} Use its Retry above the steps.
            </span>
          ) : resource.status === "loading" && !resource.data ? (
            <span className="block">Checking the saved state.</span>
          ) : body}
        </>
      );
    };

    const stateFor = (index: number): JourneyStep["state"] => {
      if (index === currentIndex) return "current";
      // Each step ticks on its own receipt and on nothing else. The first four are proved by the
      // approved carrier filing that carried them; the safe test is proved by its own completion
      // stamp. Go-live has no receipt on this page and so is never done here.
      if (index < 4 && providerReceiptAt) return "done";
      if (index === 4 && testReadyAt) return "done";
      return "waiting";
    };

    const businessStep: ChecklistJourneyStep = {
      key: "business-details",
      title: "Your business details",
      owner: "setterfi",
      state: stateFor(0),
      body: scopedBody(
        "readiness",
        businessReadyAt
          ? "Your active workspace receipt is available for the remaining setup checks."
          : "We verify the business name, registration and address used for text messaging.",
      ),
      ...(providerReceiptAt
        ? { receipt: { label: "Business details accepted in the approved carrier filing, submitted", at: providerReceiptAt } }
        : {}),
    };

    const consentStep: ChecklistJourneyStep = {
      key: "consent-page",
      title: "Your consent page",
      owner: "you",
      state: stateFor(1),
      body: scopedBody(
        "artifacts",
        artifactView?.demoOnly
          ? "Replace the sample page before filing."
          : artifactView
            ? "Review the page that explains how leads agree to texts and how they stop them."
            : "Create the page that explains how leads agree to texts and how they stop them.",
      ),
      ...(providerReceiptAt
        ? { receipt: { label: "Consent page accepted in the approved carrier filing, submitted", at: providerReceiptAt } }
        : {}),
      ...(resources.artifacts.status === "ok" && !consentReadyAt && artifactView && !artifactView.demoOnly
        ? { action: { label: "Confirm consent page", onClick: () => void confirmConsentPage() } }
        : {}),
    };

    const welcomeStep: ChecklistJourneyStep = {
      key: "welcome-message",
      title: "Your welcome message",
      owner: contentView.kind === "waiting_admin" ? "setterfi" : "you",
      state: stateFor(2),
      body: scopedBody(
        "contentScreen",
        contentView.kind === "missing"
          ? "Add the welcome message your agent will send to new text leads."
          : contentView.kind === "clean"
            ? "Your message has no filing conflicts. We will include it when the carrier filing starts."
            : contentView.kind === "waiting_admin"
              ? "Your acknowledgement is saved. Our team is checking the message before filing."
              : contentView.stale
                ? "Your offer changed, so review the message again before filing."
                : "Review the phrases that need your acknowledgement before filing.",
      ),
      ...(providerReceiptAt
        ? { receipt: { label: "Welcome message accepted in the approved carrier filing, submitted", at: providerReceiptAt } }
        : {}),
      ...(resources.contentScreen.status === "ok" && contentView.kind === "coach_action"
        ? {
            action: {
              label: "Acknowledge message",
              onClick: () => void acknowledgeWelcomeMessage(),
            },
          }
        : {}),
    };

    const carrierBody = registration.kind === "blocked"
      ? `${registration.label} Contact support to review what happened.`
      : providerReceiptAt
        ? "The provider receipt confirms that text messaging is ready."
        : registration.kind === "registering"
          ? `${registration.label}. ${registration.detail}${registration.extra ? ` ${registration.extra}` : ""}`
          : registration.detail;
    const carrierStep: ChecklistJourneyStep = {
      key: "carrier-review",
      title: "Carrier review",
      owner: "carrier",
      state: stateFor(3),
      body: scopedBody(
        "a2p",
        registration.kind === "registering"
          ? (
            <CarrierStepBody
              body={carrierBody}
              nowIso={nowIso}
              // The day counter moves inside the step body so it can sit in a well in mono beside
              // the carrier's own checklist. Same facts, same clock, one readout instead of two.
              since={
                resources.a2p.status === "ok" && registrationEvidence?.submittedAt
                  ? registrationEvidence.submittedAt
                  : null
              }
            />
          )
          : carrierBody,
      ),
      ...(providerReceiptAt
        ? { receipt: { label: "Carrier registration approved, filing submitted", at: providerReceiptAt } }
        : {}),
    };

    /*
     * The safe test, screen 2j's step 6, adapted to the step that actually exists.
     *
     * The artifact draws the coach DMing their own setter from a personal account while a
     * six-item checklist ticks itself: quoted the prices, refused a discount, offered real times.
     * None of those six is stored anywhere. What is stored is one step, `test_pass`, owned by the
     * runner rather than by the coach (`steps.ts:208` gives it `owner: "automatic"`), and what it
     * proves is narrower and more useful than a transcript: the setter answered from published
     * Brain evidence with citations, the reply passed the output checks, and a real calendar read
     * returned open times without writing an appointment anywhere.
     *
     * So the step ticks itself in the sense the artifact means -- the coach presses nothing and it
     * moves on its own -- but it says who is running it and what passed. It ticks on
     * `test_passed`'s receipt, never optimistically, which is also the only thing `StepJourney`
     * will accept for a done step.
     */
    const testStep: ChecklistJourneyStep = {
      key: "safe-test",
      title: "Safe test",
      owner: "setterfi",
      state: stateFor(4),
      body: scopedBody(
        "readiness",
        testReadyAt
          ? "Your setter answered from your published Brain and read real times off your calendar."
          : testCheck?.code === "test_readiness_unavailable"
            ? "The safe test result could not be read. The other steps are unaffected."
            : "We ask your setter a real question and check that it answers from your published"
              + " Brain, then read open times off your calendar. Nothing is booked and no lead is"
              + " messaged.",
      ),
      ...(testReadyAt
        ? { receipt: { label: "Safe test passed, recorded", at: testReadyAt } }
        : {}),
    };

    // Global readiness can be green while A2P is still awaiting_provider; go-live must also
    // hold the validated carrier receipt or it claims a receipt that does not exist.
    const goLiveReady = resources.readiness.status === "ok" && readiness?.ready
      && Boolean(providerReceiptAt);
    const goLiveStep: ChecklistJourneyStep = {
      key: "go-live",
      title: "Go live",
      owner: "you",
      state: stateFor(5),
      body: goLiveReady
        ? "Every required check has a receipt. Review the final go-live confirmation."
        : "This opens after the required setup checks have receipts.",
      // The action stays named while it is sequenced behind carrier review; StepJourney renders
      // it disabled with the step that unblocks it until this step is the current one.
      action: goLiveReady
        ? { label: "Review go-live", href: "/onboarding" }
        : { label: "Review go-live" },
    };

    return [
      businessStep,
      consentStep,
      welcomeStep,
      carrierStep,
      testStep,
      goLiveStep,
    ] as unknown as readonly JourneyStep[];
  })();

  if (!enabled) {
    return (
      <section>
        {/*
          The coach head here too. The live path below writes its own `<h1 className=
          "coach-page-title">` for the reason stated there -- `PageHeader`'s title is the console's
          20px and no prop moves it -- and this branch kept the console head, so turning the flag
          off shrank the title by 26px on the same page. `CoachPageHead` rather than a second
          hand-rolled header, since this branch has no back link to carry.
        */}
        <CoachPageHead
          sub="Text messaging setup is not enabled in this workspace."
          surface="coach-setup"
          title="Get started"
        />
        <DataState
          body="No provider or saved setup route was called."
          kind="empty"
          title="Setup is not enabled"
        />
      </section>
    );
  }

  const initialLoading = RESOURCE_KEYS.every((key) => resources[key].status === "loading")
    && RESOURCE_KEYS.every((key) => !resources[key].data);

  // What the coach can do right now, said in words. When the live step belongs to an external
  // clock there is nothing to press, and saying so is a better answer than an accent fill or a
  // greyed-out button pretending to be one.
  const anyFailed = RESOURCE_KEYS.some((key) => resources[key].status === "failed");
  const currentStep = steps[currentIndex] ?? null;
  // Any step the coach owns that has a live control counts, not only the current one: a step can
  // be actionable while the journey's live step sits behind the carrier's clock, and telling the
  // coach there is nothing to do while a button of theirs is on screen would be the same
  // overstatement in the other direction.
  const coachStep = steps.find(
    (step) => step.owner === "you" && (step.action?.onClick || step.action?.href),
  ) ?? null;
  const rightNow = anyFailed
    ? "Some saved setup state could not be checked. Retry it beside the steps."
    : coachStep
      ? `Waiting on you: ${coachStep.title.charAt(0).toLowerCase()}${coachStep.title.slice(1)}.`
      : currentStep
        // No em dash: `docs/DESIGN.md` bans them in UI copy outright, and two sentences say the
        // same thing without one.
        ? `Nothing needs you yet. This step is with ${OWNER_TEXT[currentStep.owner]}.`
        : "Nothing needs you yet.";

  return (
    <section className="@container/page">
      {/*
        The coach page head, written locally rather than taken from `PageHeader`.

        `PageHeader`'s title is the console's 20px and no prop moves it, so a coach page that used it
        opened at a quarter of the size the canvas draws. `LeadsHead` in `leads-surface.tsx`
        established the pattern this follows: a bare `<h1 className="coach-page-title">`, which picks
        up the 46px `--coach-page-title` from `coach.css`, and the lead sentence at 17px under it.
      */}
      <header
        className="mb-[var(--s-6)] flex flex-wrap items-end justify-between gap-[var(--s-5)]"
        data-page-head="coach-setup"
      >
        <div className="min-w-0">
          {/*
            The way back, which the artboard draws above the title on every coach page that is not
            Home. Setup left the pill bar in the nine-to-five cut, so a coach who arrives here from
            the Home setup card has the browser's back button and nothing on the page itself.

            It reads "Back to Home" rather than the artboard's "Back to overview" because the
            shipped nav calls that destination Home and a pinned test says so; a link should name
            its destination the way the destination names itself.
          */}
          <a
            className="mb-[var(--s-3)] inline-flex items-center gap-[var(--s-2)] text-[16px] leading-[1.4] font-medium text-[color:var(--muted)] no-underline hover:text-[color:var(--ink)]"
            data-slot="setup-back"
            href="/coach/home"
          >
            <ArrowLeft aria-hidden size={18} strokeWidth={1.75} />
            Back to Home
          </a>
          <h1 className="coach-page-title m-0">Your setup</h1>
          <Prose className={`m-0 mt-[var(--s-3)] ${COACH_LEAD_CLASS}`} data-slot="setup-summary">
            {journeySummary(steps)}
          </Prose>
          {/*
            What this workspace's records are, which is a different question from the one the line
            below answers and was the one nothing on this page asked.

            The placeholder line says the hosted consent artifact is a sample -- "is this filing
            real". This says "is this workspace real". They came apart in both directions: a seeded
            demo tenant whose artifact happened to be genuine carried no label at all, on the one
            coach screen whose entire subject is whether the account is live yet, and a real
            business with a sample artifact was labelled without its workspace being in question.
            Both lines render when both are true, because they are two facts and not two spellings
            of one.

            16px `--muted`, matching `coach-page-head.tsx`: this is the same sentence every other
            coach surface prints, and the argument for saying provenance in words rather than in a
            chip only holds while the words are legible.
          */}
          {provenance ? (
            <p
              className="m-0 mt-[var(--s-2)] text-[length:var(--coach-body)] leading-[1.45] text-[color:var(--muted)]"
              data-provenance={provenance}
              data-slot="setup-provenance"
            >
              {PROVENANCE_COPY[provenance]}
            </p>
          ) : null}
          {artifact?.placeholder ? (
            /* Segregated and said so: a sample consent artifact means these steps are not the
               coach's real filing, and the page has to label that where the claim is made rather
               than leave a demo record looking like a receipt. */
            <p
              className="m-0 mt-[var(--s-2)] text-[15px] leading-[1.45] text-[color:var(--faint)]"
              data-provenance="demo"
            >
              Sample setup records. These are not your real filing.
            </p>
          ) : null}
        </div>
        {/*
          The one thing at the top of the page a coach can press, and it is a question rather than
          an action on the journey: most of these steps are held by somebody else, so "ask us" is
          genuinely the only move available on four of the six. It stays outlined -- the page's fill
          belongs to whichever step the coach can actually advance, which `StepJourney` decides.
        */}
        <a
          className="inline-flex shrink-0 items-center gap-[var(--s-2)] rounded-[10px] border border-[var(--line)] bg-[var(--well)] px-[var(--s-4)] text-[16px] font-medium text-[color:var(--body)] hover:text-[color:var(--ink)]"
          href="/coach/help"
        >
          <QuestionMark aria-hidden size={20} strokeWidth={1.75} />
          Ask us about a step
        </a>
      </header>

      <ChannelStrip channels={channels} />

      {initialLoading ? <DataState kind="loading" rows={4} /> : (
        <>
          {/* The page's one attention-bearing line, and deliberately a strip rather than a card:
              it reports who is holding the journey, which is a fact SetterFi already knows, and it
              is never something to press. The dot is amber only while the coach is the one being
              waited on, so the colour and the sentence make the same claim. */}
          <Surface as="p" className="mb-[var(--s-6)] flex flex-wrap items-baseline gap-x-[var(--s-3)] gap-y-[var(--s-1)]" variant="strip">
            <span className="flex items-center gap-[var(--s-2)]">
              <StatusDot size={6} tone={anyFailed ? "failure" : coachStep ? "warning" : "neutral"} />
              <span className={COACH_EYEBROW_CLASS}>Right now</span>
            </span>
            <Prose as="span" className={`block ${COACH_READING_CLASS} text-[color:var(--body)]`}>{rightNow}</Prose>
          </Surface>

          {/*
            One column, not the two-up the console laid this out in. The canvas stacks the steps and
            then closes with the receipts, and that order is the argument: the evidence panel answers
            a question a coach asks after reading the steps, so putting it in a sidebar beside them
            made it compete with the thing it is evidence for. Full width also gives each step title
            a whole line at 20px, which is what keeps the state badge off the end of the name.
          */}
          <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
            {RESOURCE_KEYS.filter((key) => resources[key].status === "failed").map((key) => (
              <DataState
                body={RESOURCE_FAILURES[key].body}
                key={key}
                kind="unavailable"
                retry={() => void load([key])}
                title={resources[key].loadError ?? RESOURCE_FAILURES[key].title}
              />
            ))}
            {/*
              The steps sit on the page ground, not inside a panel.

              The artboard draws them as full-width rows with nothing around them, and it is right:
              each step is already a card with its own border, tile, status lozenge and action, so a
              hero panel wrapped a stack of cards in a second card and put an eyebrow and the name
              "The steps" above a list that plainly is the steps. The count the eyebrow carried is
              not lost -- the page's own lead sentence above already states how many there are and
              where each one stands.
            */}
            <div className={COACH_JOURNEY_SCALE} data-slot="get-started-journey">
              <StepJourney steps={steps} />
            </div>

            <FilingEvidence
              filing={filingEvidence}
              history={historyEvidenceNewestFirst}
              technical={technicalEvidence}
            />
          </div>
        </>
      )}
    </section>
  );
}
