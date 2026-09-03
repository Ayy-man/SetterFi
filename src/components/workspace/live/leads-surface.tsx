"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";

import {
  Figure,
  kitButtonClass,
  MonoMeta,
  Prose,
  QueueItem,
  StatusAbsent,
  Surface,
} from "@/components/kit/atomics";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { ExportMenu } from "@/components/kit/export-menu";
import { Columns, Menu, Phone } from "@/components/kit/icons";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { FilterBar, type FacetGroup, type ViewDef } from "@/components/kit/filter-bar";
import { CoachContacts } from "@/components/workspace/live/coach-contacts";
import {
  allowedMoves,
  CoachPipeline,
  type AppointmentEvidenceByContact,
} from "@/components/workspace/live/coach-pipeline";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_READING_CLASS,
  COACH_ROW_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import { leakExplanation } from "@/components/workspace/live/lead-leak";
import {
  filterLeads,
  LEAD_SEARCH_PLACEHOLDER,
  leadSearchScope,
  OUTCOME_LABELS,
  STAGE_LABELS,
} from "@/components/workspace/live/lead-search";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { useQueryState } from "@/lib/query-state";
import type { ContactRead } from "@/lib/repositories/contacts";

export type { AppointmentEvidenceByContact } from "@/components/workspace/live/coach-pipeline";

type LeadsView = "table" | "board" | "callback";

/**
 * The setter's next automated touch per contact, as an ISO instant.
 *
 * `null` means the read failed or came back truncated, which is not the same claim as "no touch
 * is scheduled": the callback rows say nothing at all in that case rather than reporting an
 * absence they did not establish. `{}` means the read succeeded and found none.
 */
export type NextSetterTouchByContact = Readonly<Record<string, string>>;

export type LeadsSurfaceProps = {
  // null means the evidence read itself failed; {} means it succeeded and found nothing.
  appointmentEvidence: AppointmentEvidenceByContact | null;
  nextSetterTouch?: NextSetterTouchByContact | null;
  /**
   * The page's own clock, as an ISO instant. Required rather than defaulted: a default would have
   * to call `Date.now()` somewhere, which is the impurity this prop exists to remove, and every
   * other surface in this product already threads its instant down from the server for the same
   * reason.
   */
  nowIso: string;
  defaultView: LeadsView;
  initialContacts: ContactRead[];
  impersonation?: { sessionId: string; tenantId: string } | null;
  writeEnabled: boolean;
};

function channelLabel(channel: ContactRead["channels"][number]["channel"] | undefined) {
  if (!channel) return "No channel";
  if (channel === "sms") return "Text messages (SMS)";
  if (channel === "messenger") return "Facebook Messenger";
  if (channel === "webchat") return "Web chat";
  return channel.charAt(0).toLocaleUpperCase() + channel.slice(1);
}

function isLeadsView(value: string | null): value is LeadsView {
  return value === "table" || value === "board" || value === "callback";
}

/*
 * The search itself lives in `lead-search.ts` beside the list of fields it reads and the
 * sentence that names them, so the scope a coach is shown cannot drift from the scope the
 * filter applies. Re-exported here because this module is the surface every leads test and
 * page already imports from.
 */
export { filterLeads, leadSearchScope };

export function leadExportRows(contacts: readonly ContactRead[]): Record<string, unknown>[] {
  return contacts.map((contact) => ({
    contactId: contact.id,
    name: contact.name,
    channels: contact.channels.map((channel) => ({
      address: channel.address,
      channel: channel.channel,
    })),
    creditRange: contact.credit,
    fundingGoal: contact.goal,
    timeline: contact.timeline,
    decision: contact.outcome,
    pipelineStage: contact.pipelineStage,
    optedOut: contact.optedOut ?? false,
    timezone: contact.timezone ?? null,
    lastActivity: contact.lastActivityAt,
    demoData: contact.isDemo,
    testData: contact.isTest,
  }));
}

/**
 * The four steps a lead can be counted at, in the only order the stored data supports.
 *
 * Nothing records the stages a lead passed through, so a stage-by-stage funnel over the seven
 * pipeline stages would be a funnel over where leads are sitting right now, which is a different
 * claim. These four are read off fields every row carries: the lead exists, a decision was
 * recorded against it, the decision was to book, and the booking happened.
 */
const FUNNEL_STEPS = [
  {
    key: "all",
    label: "Leads",
    of: () => true,
  },
  {
    key: "decided",
    label: "Decision recorded",
    of: (contact: ContactRead) => contact.outcome !== null,
  },
  {
    key: "ready",
    label: "Ready to book",
    of: (contact: ContactRead) => contact.outcome === "BOOK",
  },
  {
    key: "booked",
    label: "Booked",
    of: (contact: ContactRead) => contact.pipelineStage === "booked",
  },
] as const;

export type FunnelDrop =
  /** The step before it had rows and this step is a subset of them, so the share divides. */
  | { kind: "drop"; percent: number }
  /** It does not divide, and the reason is a sentence rather than a silent 0%. */
  | { kind: "absent"; reason: string };

export type FunnelStepView = {
  key: string;
  label: string;
  count: number;
  /** The label of the step this one is measured against; null on the first step. */
  from: string | null;
  /** null on the first step: nothing precedes it, so nothing leaked into it. */
  drop: FunnelDrop | null;
};

/**
 * Where the leads in view leak, computed from the rows themselves.
 *
 * A step with no denominator, or one holding more rows than the step before it, reports the
 * reason in words. Printing 0% for either would claim a total loss where the truth is that the
 * question cannot be answered from these rows.
 */
export function leadFunnel(contacts: readonly ContactRead[]): FunnelStepView[] {
  let previous: { count: number; label: string } | null = null;
  return FUNNEL_STEPS.map((step) => {
    const count = contacts.filter(step.of).length;
    let drop: FunnelDrop | null = null;
    if (previous !== null) {
      if (previous.count === 0) {
        drop = {
          kind: "absent",
          reason: `No lead reached ${previous.label}, so there is nothing for ${step.label} to be a share of.`,
        };
      } else if (count > previous.count) {
        drop = {
          kind: "absent",
          reason: `More leads are counted at ${step.label} than at ${previous.label}, so the two do not divide into a conversion.`,
        };
      } else {
        drop = {
          kind: "drop",
          percent: Math.round(((previous.count - count) / previous.count) * 100),
        };
      }
    }
    const view: FunnelStepView = {
      count,
      drop,
      from: previous?.label ?? null,
      key: step.key,
      label: step.label,
    };
    previous = { count, label: step.label };
    return view;
  });
}

/** The step that loses the most, or null when no step in the funnel divides. */
export function biggestLeak(steps: readonly FunnelStepView[]): FunnelStepView | null {
  return steps.reduce<FunnelStepView | null>((worst, step) => {
    if (step.drop?.kind !== "drop") return worst;
    if (worst?.drop?.kind !== "drop") return step;
    return step.drop.percent > worst.drop.percent ? step : worst;
  }, null);
}

/** One sentence naming the leak, or naming why there is not one to name. */
export function funnelLeak(steps: readonly FunnelStepView[]): string {
  const total = steps[0]?.count ?? 0;
  if (total === 0) return "No leads match these filters, so there is nothing to measure.";
  const worst = biggestLeak(steps);
  if (!worst || worst.drop?.kind !== "drop") {
    return "No two steps here divide into a conversion yet, so no drop is measured.";
  }
  const booked = steps.find((step) => step.key === "booked")?.count ?? 0;
  return `${Math.round((booked / total) * 100)}% of the leads in view are booked. The biggest drop is between ${worst.from} and ${worst.label}.`;
}

function facetCounts<T extends string>(values: readonly T[]) {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function makeIdempotencyKey(contactId: string, stage: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return `pipeline:${contactId}:${stage}:${random}`;
}

/**
 * The panel face on the coach side, which is the deck panel and nothing else.
 *
 * `.coach-panel` is declared in `src/app/(workspace)/coach/coach.css` and carries the canvas's own
 * geometry: the asymmetric `24px 24px 17px 17px` radius, the `--card-top` to `--card` gradient,
 * the hairline and the card shadow. Reaching for it here rather than for `.surface-card` is what
 * keeps the leads screens the same object as coach Home's deck instead of a second card shape
 * invented for this page. It is unstyled outside the coach shell, which is correct: these
 * components render inside `AppShell role="coach"` in the app and inside no shell at all in the
 * tests, and neither case wants the console's face.
 *
 * Nothing on this screen is drenched. The two drenches are for a figure worth spending the accent
 * on, and a list of leads has none -- the rows are the content, and a saturated ground under them
 * would be the accent shouting about a table.
 */
const LEADS_PANEL_CLASS = "coach-panel @container/card min-w-0 p-[var(--s-5)]";

/**
 * A page-level notice reads as a dot plus a word, never as coloured text alone, so the state
 * survives a reader who cannot separate the amber from the body ramp.
 */
function Notice({
  children,
  role,
  tone,
}: {
  children: ReactNode;
  role: "alert" | "status";
  tone: "neutral" | "warning";
}) {
  return (
    <p
      className={`mt-[var(--s-3)] flex items-baseline gap-[var(--s-2)] ${COACH_READING_CLASS} ${
        tone === "warning" ? "text-[var(--warning-body)]" : "text-[var(--body)]"
      }`}
      role={role}
    >
      <span
        aria-hidden="true"
        className={`mt-[0.45em] size-[var(--distance-small)] shrink-0 self-start rounded-[var(--r-full)] ${
          tone === "warning" ? "bg-[var(--warning)]" : "bg-[var(--muted)]"
        }`}
      />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function Key({ children }: { children: string }) {
  return (
    // 14px, where the console draws this at the 11px label token. A keycap a coach has to lean in
    // to read is worse than useless on a help block whose whole job is to be scanned once.
    <kbd className="mx-[2px] rounded-[4px] border border-b-2 border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-1)] py-[1px] font-mono text-[14px] leading-[1.4] text-[color:var(--muted)]">
      {children}
    </kbd>
  );
}

/**
 * Documents only the keys the board actually handles. Opening the conversation or the contact
 * from a card has no keyboard path yet, so nothing here promises one.
 */
function BoardKeyboardHelp({
  canMove,
  writeEnabled,
}: {
  canMove: boolean;
  writeEnabled: boolean;
}) {
  return (
    <section
      aria-labelledby="board-keyboard-help"
      className="mt-[var(--s-6)] max-w-[var(--measure-tight)]"
      data-board-keyboard-help="true"
    >
      {/*
        Closed by default, and this is the block the round-1 note was most about.

        A full keycap reference rendered open is the longest thing on the page and the least
        likely to be read twice: a coach who wants it goes looking for it once, and a coach who
        does not should never have to scroll past it to reach their own leads. Nothing is cut --
        every key the board handles is still documented, including the read-only sentence -- it
        just costs a click now instead of a screen.

        A native disclosure rather than the console's `CollapsedSettingCard`: that atomic is a
        button that swaps its own body out of the tree, and this content is a heading with a
        labelled region hanging off it. `details` keeps the region and its name intact whether it
        is open or shut, which is what the keyboard path this block documents actually needs.
      */}
      <details data-slot="board-keyboard-disclosure">
        <summary className="w-fit cursor-pointer">
          <h2
            className="inline text-[20px] leading-[1.25] font-[500] tracking-[-0.015em] text-[color:var(--ink)]"
            id="board-keyboard-help"
          >
            Moving a lead without the mouse
          </h2>
        </summary>
        <div className={`mt-[var(--s-3)] flex flex-col gap-[var(--s-2)] ${COACH_READING_CLASS} text-[color:var(--body)]`}>
          <p className="m-0">
            Select a card with <Key>Tab</Key>, then move between cards with{" "}
            <Key>↑</Key> <Key>↓</Key> <Key>←</Key> <Key>→</Key>. <Key>Enter</Key> opens the lead.
          </p>
          {canMove ? (
            <>
              <p className="m-0">
                <Key>M</Key> opens the Move to menu, <Key>↑</Key> <Key>↓</Key> pick a stage, and{" "}
                <Key>Enter</Key> opens the review step. The move is saved only when you confirm it.
              </p>
              <p className="m-0">
                <Key>Space</Key> lifts the card, <Key>←</Key> <Key>→</Key> carry it across stages,{" "}
                <Key>Space</Key> drops it, and <Key>Esc</Key> puts it back.
              </p>
              <p className="m-0 text-[color:var(--muted)]">
                A card reads Saving until the server answers. If the change is refused, the card
                returns to its stage and the notice above says why.
              </p>
            </>
          ) : (
            <p className="m-0 text-[color:var(--muted)]">
              {writeEnabled
                ? "This impersonated view is read only, so the move keys do nothing here. Nothing has changed stage, and no lead was messaged."
                : "Stage changes are not switched on in this environment, so the move keys do nothing here. Nothing has changed stage, and no lead was messaged."}
            </p>
          )}
        </div>
      </details>
    </section>
  );
}

/**
 * The funnel, as wells in the leads card rather than as a second card: a card contains wells.
 *
 * The step a lead loses the most at is the one thing a coach opens this page for, so it is the
 * only figure on the row that carries a tone, and the sentence under the row names that step in
 * words so the tone is never the only thing saying it.
 */
function LeadFunnel({
  contacts,
  steps,
}: {
  contacts: readonly ContactRead[];
  steps: readonly FunnelStepView[];
}) {
  const worst = biggestLeak(steps);
  const unmeasured = steps.filter((step) => step.drop?.kind === "absent");
  const explanation = worst ? leakExplanation(contacts, worst) : null;

  return (
    <section aria-labelledby="leads-funnel-title" className="mt-[var(--s-4)] min-w-0">
      {/* The heading was an `Overline`: 9.5px mono, uppercase, wide-tracked. That role does not
          exist on the coach side at all, so it is a sentence-case 12px eyebrow instead. The words
          are unchanged, because `aria-labelledby` points at them and the region is looked up by
          this exact name -- the type changed, the label did not. */}
      <h2 className={`m-0 block ${COACH_EYEBROW_CLASS}`} id="leads-funnel-title">
        Where leads leak
      </h2>
      <ul className="mt-[var(--s-3)] m-0 flex min-w-0 list-none flex-wrap gap-[var(--s-2)] p-0">
        {steps.map((step) => (
          <li
            className="flex min-w-[8.5rem] flex-1 flex-col"
            data-funnel-step={step.key}
            key={step.key}
          >
            <Surface className="min-w-0 flex-1" variant="well">
              {/* The step's own name at 15px and its count at the deck's `lg` figure: this is the
                  one place on the page where a number is the thing being read, and the console's
                  12px label over a 15px figure is the pairing the coach feedback was about.

                  The name wraps rather than truncating, and the rule it broke is worth naming: it
                  carried `truncate`, which is correct in the layout it was written for -- four
                  wells across one row at desktop, where every name fits -- and wrong the moment
                  the row wraps three-then-one at 500px and "Decision recorded" renders as
                  "Decision reco...". A stage figure whose name cannot say which stage it is
                  defeats the panel, and the ellipsis only ever appears at the width where a coach
                  can least afford to guess. The rule was narrower than its subject: it was written
                  about one row rather than about the name.

                  The `li` is a column and this surface takes the remaining height so a name that
                  wraps to two lines does not leave its neighbours in the same row shorter than it.
                  Wrapping is safe without a break rule because these four labels are constants in
                  `FUNNEL_STEPS` above -- none is a single unbreakable word, and none is data. */}
              <div
                className="text-[15px] leading-[1.35] font-[500] text-[color:var(--ink)]"
                data-funnel-step-name={step.key}
              >
                {step.label}
              </div>
              <Figure className="mt-[var(--s-1)] block" size="lg">
                {step.count}
              </Figure>
            </Surface>
            {/* The gap between two steps is where the leak is, so it sits under the step it
                arrives at, and an unmeasurable gap renders the absence mark rather than a 0%. */}
            <div className="mt-[6px] text-center" data-funnel-drop={step.key}>
              {step.drop === null ? null : step.drop.kind === "drop" ? (
                <MonoMeta
                  className="text-[13px]"
                  tone={worst?.key === step.key ? "warning" : "neutral"}
                >
                  {`−${step.drop.percent}%`}
                  <span className="sr-only">{` of ${step.from} do not reach ${step.label}`}</span>
                </MonoMeta>
              ) : (
                <StatusAbsent label={step.drop.reason} />
              )}
            </div>
          </li>
        ))}
      </ul>
      <Prose className={`mt-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--body)]`}>
        {funnelLeak(steps)}
      </Prose>
      {/*
        Everything that qualifies the figures, one disclosure below them.

        Three paragraphs of method sat open under this row and pushed the board -- the thing the
        page is for -- below the fold. None of it is cut, because each one stops a specific
        misreading: who the leads that stopped actually are, why a step could not be divided at
        all, and the fact that nothing records the path a lead took.

        The summary line is not a label for the disclosure, it is the caveat itself. Hiding
        "these read today's stage, not the history" behind a closed row would let a coach read
        -44% as a journey, which is precisely the misreading the paragraph inside exists to
        prevent -- so the short form of it stays on screen and opening gets the long form. The
        absence marks on the steps themselves are untouched for the same reason: a step that could
        not be measured still says so in the row, and only its explanation is inside.
      */}
      <details className="mt-[var(--s-3)] min-w-0" data-slot="funnel-method">
        <summary
          className={`w-fit cursor-pointer ${COACH_FOOTNOTE_CLASS} hover:text-[color:var(--ink)]`}
        >
          How these are counted: each lead&rsquo;s stage today, not the path it took
        </summary>
        <div className="mt-[var(--s-2)] flex min-w-0 flex-col gap-[var(--s-2)]">
          {/* The leak named, then the leak explained. Round 3 asks this card to say why leads stop,
              and the honest half of that is who the leads that stopped actually are: every one of
              these counts is a stored decision or a stored stage, read off the same rows the funnel
              counted. The half nobody can supply is the reason each lead gave, which lives in
              message text this page never loads, so the sentence stops at what is recorded. */}
          {explanation ? (
            <Prose
              className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}
              data-funnel-explanation="true"
            >
              {explanation}
            </Prose>
          ) : null}
          {/* Every step that could not be divided says why, in the same words its absence mark
              carries for a screen reader. Silence here would read as a healthy funnel. */}
          {unmeasured.length ? (
            <ul className="m-0 flex list-none flex-col gap-[var(--s-1)] p-0">
              {unmeasured.map((step) => (
                <li key={step.key}>
                  <Prose className={COACH_FOOTNOTE_CLASS}>
                    {step.drop?.kind === "absent" ? step.drop.reason : null}
                  </Prose>
                </li>
              ))}
            </ul>
          ) : null}
          <Prose className={`m-0 ${COACH_FOOTNOTE_CLASS}`}>
            Counted from the leads these filters match. The stages a lead passed through are not
            recorded, so this reads the decision on each lead, not its history.
          </Prose>
        </div>
      </details>
    </section>
  );
}

/**
 * The two stages a lead ends up in when the setter has stopped moving it and a person has to.
 *
 * They are the same two the coach Dashboard's "Leads to call back" tile counts, named here so the
 * tile and this list cannot come to mean different things.
 */
export const CALLBACK_STAGES = ["no_show", "long_term_followup"] as const;

export function callbackLeads(contacts: readonly ContactRead[]): ContactRead[] {
  return contacts
    .filter((contact) => (CALLBACK_STAGES as readonly string[]).includes(contact.pipelineStage))
    /*
     * Longest silent first, and the ordering is a deliberate refusal of the artifact's.
     *
     * A due date does exist: `followups.scheduled_at`, indexed by `followups_due_idx` for exactly
     * this question. But it is the setter's next automated touch on the conversation, not an
     * obligation on the coach, so sorting the coach's own worklist by it would order their day
     * around somebody else's cron. The artifact's "due today" inverts the owner of that date. What
     * the coach owns is the silence, so that is what the list is ordered by.
     */
    .sort((left, right) => Date.parse(left.lastActivityAt) - Date.parse(right.lastActivityAt));
}

export function silentDays(lastActivityAt: string, nowMs: number): number | null {
  const at = Date.parse(lastActivityAt);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 86_400_000));
}

/** The scheduled instant as a date a coach can check against a calendar, or its raw absence. */
function touchLabel(scheduledAt: string) {
  const at = new Date(scheduledAt);
  return Number.isNaN(at.getTime()) ? "on a date we could not read" : workspaceDateFormat.format(at);
}

/** The number a coach can dial, or nothing. A DM handle is not a phone number. */
function callableNumber(contact: ContactRead): string | null {
  const sms = contact.channels.find((channel) => channel.channel === "sms");
  const digits = sms?.address.replace(/[^\d+]/gu, "") ?? "";
  return digits.length >= 7 ? digits : null;
}

/**
 * Screen 2e: the list behind the Dashboard's second queue tile.
 *
 * The artifact heads it "7 due today" and gives every row a due chip and two buttons, "Call now"
 * and "Let the setter retry". Three of those four cannot be built as drawn, each for its own
 * reason, and the reasons are different enough to be worth separating.
 *
 * **The due date exists, but it is not the coach's.** `followups.scheduled_at` is a real column
 * with a real partial index, and this list reads it. What it holds is when the setter will next
 * touch the conversation by itself, which is a fact about SetterFi's cadence rather than a
 * deadline anybody here has given the coach. "Due today" and "overdue" would hand the coach an
 * obligation that belongs to a cron job, so the row says whose date it is instead.
 *
 * **"Let the setter retry" has no way in.** Two paths write a followup, the cadence replace in
 * `repositories/followups.ts` and the quiet-hours deferral in `repositories/conversations.ts`, and
 * both run inside the send pipeline. Nothing coach-triggered exists, so a button here would be a
 * control for something with no storage behind it.
 *
 * **Calling works, because the number is already on file.** A row with no phone number gets no
 * button rather than a dead one.
 *
 * The absent case is common rather than exceptional: a lead reply, a takeover, an opt-out or a
 * hard disqualification all cancel the cadence, and callback stages are full of leads that have
 * done one of those. So "No automated touch scheduled" is a resting state and is written to read
 * as one, never as a failure.
 */
function CallbackList({
  contacts,
  nextSetterTouch,
  nowMs,
}: {
  contacts: readonly ContactRead[];
  nextSetterTouch: NextSetterTouchByContact | null;
  nowMs: number;
}) {
  if (contacts.length === 0) {
    return (
      <Prose className={`mt-[var(--s-4)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
        No lead is sitting in a no show or a long-term follow-up right now.
      </Prose>
    );
  }

  return (
    <div className="mt-[var(--s-4)] min-w-0">
      <ul aria-label="Leads to call back" className="m-0 flex list-none flex-col p-0">
        {contacts.map((contact) => {
          const days = silentDays(contact.lastActivityAt, nowMs);
          const number = callableNumber(contact);
          return (
            <li key={contact.id}>
              <QueueItem
                actions={number ? (
                  /* An anchor wearing the kit's own button face, because `KitButton` is a
                     `<button>` and a phone number is a link. `kitButtonClass` exists for exactly
                     this so the face has one definition. Secondary, never the fill: a list of
                     twelve leads cannot spend twelve accents. */
                  <a
                    className={kitButtonClass({ size: "sm", variant: "secondary" })}
                    href={`tel:${number}`}
                  >
                    Call now
                  </a>
                ) : (
                  <MonoMeta>no phone number on file</MonoMeta>
                )}
                clock={days === null
                  ? "no activity recorded"
                  : days === 0 ? "today" : `${days}d silent`}
                context={(
                  <>
                    {STAGE_LABELS[contact.pipelineStage] ?? contact.pipelineStage}
                    {contact.optedOut ? " · opted out of texts" : ""}
                    {contact.isTest ? " · test data, excluded from real analytics" : ""}
                    {/* Whose date it is, said in the label. The coach reads this to decide
                        whether calling is worth it today, which is the honest use of somebody
                        else's schedule. A failed or truncated read renders nothing rather than
                        an absence it cannot stand behind. */}
                    {nextSetterTouch === null ? null : (
                      <span className="mt-[3px] block" data-slot="callback-next-touch">
                        {nextSetterTouch[contact.id]
                          ? `Setter's next touch ${touchLabel(nextSetterTouch[contact.id])}`
                          : "No automated touch scheduled"}
                      </span>
                    )}
                  </>
                )}
                title={contact.name}
                // Amber is for the leads nobody has touched in a fortnight, which is the only
                // thing on this list a colour can honestly say. Everything newer is neutral.
                tone={days !== null && days >= 14 ? "warning" : "neutral"}
              />
            </li>
          );
        })}
      </ul>
      <Prose className={`mt-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
        Ordered by how long each lead has been silent, which is the part you own. Any touch date
        shown is SetterFi&apos;s own cadence, not a deadline for you, and there is no control here that
        re-opens a thread on demand.
      </Prose>
    </div>
  );
}

/* The sentences this screen would otherwise print as help text, handed to the eye instead. */
const LEADS_SURFACE_EYE_COPY =
  "Everyone who has messaged you, and where each one got to. Every row reads the lead's stage "
  + "today rather than the path it took there. The line under the head says what the list is "
  + "currently scoped to, so read that before taking a short list for your whole pipeline.";

export function LeadsSurface({
  appointmentEvidence,
  defaultView,
  initialContacts,
  impersonation = null,
  nextSetterTouch = null,
  nowIso,
  writeEnabled,
}: LeadsSurfaceProps) {
  const query = useQueryState();
  const [contacts, setContacts] = useState(initialContacts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [bookedRequest, setBookedRequest] = useState<{ cardId: string; from: string } | null>(null);
  const [appointmentDate, setAppointmentDate] = useState<string | null>(null);
  const [moveNotice, setMoveNotice] = useState("");
  const evidenceChecked = appointmentEvidence !== null;
  const evidenceByContact = useMemo<AppointmentEvidenceByContact>(
    () => appointmentEvidence ?? {},
    [appointmentEvidence],
  );
  const removedContactsRef = useRef(new Map<string, ContactRead>());
  const initialContactsRef = useRef(new Map(initialContacts.map((contact) => [contact.id, contact])));
  const requestGenerationRef = useRef(new Map<string, symbol>());
  const requestedView = query.get("view");
  const activeView = isLeadsView(requestedView) ? requestedView : defaultView;

  const channelCounts = useMemo(
    () => facetCounts(contacts.flatMap((contact) => contact.channels.map((channel) => channel.channel))),
    [contacts],
  );
  const stageCounts = useMemo(
    () => facetCounts(contacts.map((contact) => contact.pipelineStage)),
    [contacts],
  );
  const outcomeCounts = useMemo(
    () => facetCounts(contacts.map((contact) => contact.outcome ?? "pending")),
    [contacts],
  );

  const facets = useMemo<readonly FacetGroup[]>(() => [
    {
      key: "channel",
      label: "Channel",
      multi: true,
      options: Array.from(channelCounts.entries()).map(([value, count]) => ({
        count,
        label: channelLabel(value),
        value,
      })),
    },
    {
      key: "stage",
      // "Stage" is what the artboard's control is called and what the column beside it is now
      // headed, so the facet and the column stop being two names for one value.
      label: "Stage",
      multi: true,
      options: Object.entries(STAGE_LABELS).map(([value, label]) => ({
        count: stageCounts.get(value) ?? 0,
        label,
        value,
      })),
    },
    {
      key: "outcome",
      label: "Decision",
      multi: true,
      options: [
        ...Object.entries(OUTCOME_LABELS).map(([value, label]) => ({
          count: outcomeCounts.get(value) ?? 0,
          label,
          value,
        })),
        { count: outcomeCounts.get("pending") ?? 0, label: "Decision pending", value: "pending" },
      ],
    },
  ], [channelCounts, outcomeCounts, stageCounts]);

  const filteredContacts = useMemo(() => filterLeads(contacts, {
    channels: query.getAll("channel"),
    outcomes: query.getAll("outcome"),
    query: query.get("q") ?? "",
    stages: query.getAll("stage"),
  }), [contacts, query]);
  const exportRows = useMemo(() => leadExportRows(filteredContacts), [filteredContacts]);
  const funnelSteps = useMemo(() => leadFunnel(filteredContacts), [filteredContacts]);

  // Threaded from the server, never sampled here. `Date.now()` during render is impure, and the
  // failure it causes is not theoretical on this list: the server and the hydrated client would
  // read the clock at different instants, so a lead could render "13d silent" and then flip to
  // "14d silent" with the amber tone the threshold gives it. One instant for the whole page.
  const nowMs = Date.parse(nowIso);
  const callbackContacts = useMemo(() => callbackLeads(filteredContacts), [filteredContacts]);
  const touchByContact = nextSetterTouch ?? null;

  const views = useMemo<readonly ViewDef[]>(() => {
    /*
     * "List", not "Table", which is the artboard's word and the better one for a reason beyond
     * conformance: the switch beside it says "Board", and Board/Table pairs a shape with a
     * shape while Board/List pairs two ways of reading the same leads. The key stays "table"
     * because it is the value in the URL and in `defaultView`, and renaming it would break the
     * routes that land on `/coach/contacts` and `/coach/pipelines`.
     */
    // The icons are the artboard's own: a three-rule list glyph and a three-column board glyph.
    // They are decorative -- `SegmentedControl` names each segment from its label -- and they earn
    // their place because the two words alone read as two nouns rather than as two drawings of
    // the same set.
    const icon = "size-[18px]";
    const table = {
      count: filteredContacts.length,
      icon: <Menu aria-hidden className={icon} />,
      key: "table",
      label: "List",
    } as const;
    const board = {
      count: filteredContacts.length,
      icon: <Columns aria-hidden className={icon} />,
      key: "board",
      label: "Board",
    } as const;
    // Its own count, not the filtered total: this view shows two stages out of seven, and a
    // switch labelled with the whole list would promise rows it does not render.
    //
    // `Leads.dc.html` draws two segments, not three. This one stays because coach Home's
    // attention queue links straight at `?view=callback`, so deleting the segment would leave a
    // route reachable with no way back to it and no way to tell you were in it. Re-homing that
    // link is the change that unblocks cutting it, and it belongs with Home rather than here.
    const callback = {
      count: callbackContacts.length,
      icon: <Phone aria-hidden className={icon} />,
      key: "callback",
      label: "Call back",
    } as const;
    return defaultView === "table" ? [table, board, callback] : [board, table, callback];
  }, [callbackContacts.length, defaultView, filteredContacts.length]);

  // Counted from the filtered rows, so the sentence, the funnel and the board below it are all
  // describing the same set of leads. A distribution over every lead beside a funnel over the
  // filtered ones read as one paragraph and disagreed with itself.
  const openCount = filteredContacts.filter((contact) => [
    "new_lead",
    "qualifying",
    "long_term_followup",
    "no_show",
  ].includes(contact.pipelineStage)).length;
  const bookedCount = filteredContacts.filter((contact) => contact.pipelineStage === "booked").length;
  const decisionCount = filteredContacts.filter((contact) => contact.outcome === null).length;
  const lostCount = filteredContacts.filter((contact) => [
    "qualified_no_buy",
    "disqualified",
  ].includes(contact.pipelineStage)).length;
  const provenance = contacts.some((contact) => contact.isDemo)
    ? "demo"
    : contacts.some((contact) => contact.isTest)
      ? "test"
      : "real";
  const canMove = writeEnabled && !impersonation;

  function contactMerged(_winnerId: string, loserId: string) {
    setContacts((current) => {
      const loser = current.find((contact) => contact.id === loserId);
      if (loser) removedContactsRef.current.set(loserId, loser);
      return current.filter((contact) => contact.id !== loserId);
    });
  }

  function contactUnmerged(contactId: string) {
    const restored = removedContactsRef.current.get(contactId) ?? initialContactsRef.current.get(contactId);
    if (!restored) {
      window.location.reload();
      return;
    }
    setContacts((current) => current.some((contact) => contact.id === contactId)
      ? current
      : [restored, ...current]);
    removedContactsRef.current.delete(contactId);
  }

  function contactDeleted(contactId: string) {
    setContacts((current) => current.filter((contact) => contact.id !== contactId));
  }

  async function persistMove(
    cardId: string,
    target: string,
    reason: string | null = null,
  ): Promise<Result> {
    const current = contacts.find((contact) => contact.id === cardId);
    if (!current || !allowedMoves(current.pipelineStage).some((stage) => stage === target)) {
      return { message: "That stage is not available for this lead.", ok: false } as const;
    }
    if (requestGenerationRef.current.has(cardId)) {
      return { message: "Wait for this lead's current stage change to finish.", ok: false } as const;
    }
    if (!evidenceChecked && (target === "booked" || target === "no_show")) {
      return {
        message: "Appointment evidence could not be loaded, so stage changes that need a receipt are paused. Reload to try again.",
        ok: false,
      } as const;
    }
    const evidence = evidenceByContact[cardId] ?? null;
    if (target === "no_show" && evidence?.status !== "no_show") {
      return { message: "No show requires the latest appointment to be recorded as a no show.", ok: false } as const;
    }

    const previousStage = current.pipelineStage;
    const generation = Symbol(cardId);
    requestGenerationRef.current.set(cardId, generation);
    setMoveNotice("");
    setPendingIds((pending) => new Set(pending).add(cardId));
    setContacts((rows) => rows.map((contact) => contact.id === cardId
      ? { ...contact, pipelineStage: target }
      : contact));

    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(cardId)}/pipeline-stage`,
        {
          body: JSON.stringify({
            appointmentId: target === "booked"
              ? evidenceByContact[cardId]?.appointmentId ?? null
              : null,
            expectedStage: previousStage,
            idempotencyKey: makeIdempotencyKey(cardId, target),
            reason,
            stage: target,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" ||
        !("audit" in payload) || !payload.audit || typeof payload.audit !== "object" ||
        !("id" in payload.audit) || !Number.isSafeInteger(payload.audit.id)) {
        throw new Error("The stage change was refused.");
      }
      setMoveNotice(`${current.name} moved to ${STAGE_LABELS[target]}.`);
      return {
        ok: true as const,
        receipt: {
          actionKey: "contact.pipeline_stage.set" as const,
          auditId: Number(payload.audit.id),
        },
      };
    } catch (error) {
      if (requestGenerationRef.current.get(cardId) === generation) {
        setContacts((rows) => rows.map((contact) => contact.id === cardId
          ? { ...contact, pipelineStage: previousStage }
          : contact));
      }
      const message = error instanceof Error ? error.message : "The stage change was refused.";
      setMoveNotice(`${current.name}: ${message}`);
      return {
        message,
        ok: false as const,
      };
    } finally {
      if (requestGenerationRef.current.get(cardId) === generation) {
        requestGenerationRef.current.delete(cardId);
        setPendingIds((pending) => {
          const next = new Set(pending);
          next.delete(cardId);
          return next;
        });
      }
    }
  }

  async function moveLead(cardId: string, target: string): Promise<Result> {
    const current = contacts.find((contact) => contact.id === cardId);
    if (target === "booked" && current) {
      setAppointmentDate(evidenceByContact[cardId]?.startAt.slice(0, 10) ?? null);
      setBookedRequest({ cardId, from: current.pipelineStage });
      return {
        message: "Confirm the appointment evidence in the booking flow.",
        ok: false,
      };
    }
    return persistMove(cardId, target);
  }

  async function confirmBookedMove(input: {
    reason?: string;
    expiry?: string | null;
  }): Promise<Result> {
    if (!bookedRequest) return { message: "Choose a lead before confirming.", ok: false };
    if (!evidenceChecked) {
      return {
        message: "Appointment evidence could not be loaded, so stage changes that need a receipt are paused. Reload to try again.",
        ok: false,
      };
    }
    const evidence = evidenceByContact[bookedRequest.cardId];
    if (!evidence) {
      if (!input.expiry) {
        return {
          message: "Add the appointment date before continuing.",
          ok: false,
        };
      }
      return {
        message: "Save this appointment in Calendar first, then reload so its receipt can be verified.",
        ok: false,
      };
    }
    return persistMove(bookedRequest.cardId, "booked", input.reason?.trim() || null);
  }

  /*
   * The stage filter said back to the reader. Unselected reads "All stages", which is the
   * artboard's own words for the unfiltered case; a selection lists the stages it kept, in the
   * order `STAGE_LABELS` declares them so the sentence does not reshuffle as facets are ticked.
   * A stage value the build has no label for is printed raw rather than dropped -- a filter the
   * readout silently omits is exactly the hidden narrowing this line exists to prevent.
   */
  const selectedStages = query.getAll("stage");
  const stageScope = selectedStages.length === 0
    ? "All stages"
    : `Stage: ${Object.keys(STAGE_LABELS)
        .filter((stage) => selectedStages.includes(stage))
        .map((stage) => STAGE_LABELS[stage] ?? stage)
        .concat(selectedStages.filter((stage) => !(stage in STAGE_LABELS)))
        .join(", ")}`;

  const summary: readonly { count: number; label: string }[] = [
    { count: openCount, label: "open" },
    { count: bookedCount, label: "booked" },
    { count: lostCount, label: "lost outcomes" },
    { count: decisionCount, label: "awaiting a decision" },
  ];

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-5)]">
      {/*
        The view switch sits at the top right of the head, which is where `Leads.dc.html` draws it.
        It was on the filter row beside the search and the facets, in among the controls that
        narrow the list; this one does not narrow anything, it chooses which of two drawings of the
        same set you are looking at, and it belongs with the title for the same reason a tab does.
      */}
      <CoachPageHead
        action={
          <div className="flex items-center gap-[var(--s-3)]">
            <SegmentedControl
              ariaLabel="Leads view"
              onValueChange={(next) => query.set("view", next === defaultView ? null : next)}
              scale="coach"
              segments={views}
              value={activeView}
            />
            <ContextEye
              copy={LEADS_SURFACE_EYE_COPY}
              placement="header"
              scale="coach"
              screen="coach-pipelines"
            />
          </div>
        }
        provenance={provenance}
        sub="Everyone who has messaged you, and where each one got to."
        surface="leads"
        title="Your leads"
      />

      {/* The filter row sits on the bare canvas, above the card, which is where the canvas draws
          it: search, the stage facet and the view switch are controls over the list rather than
          part of it, and folding them into the card's own header is what made the old screen read
          as one undifferentiated box with a table somewhere inside it. */}
      <FilterBar
        facets={facets}
        scale="coach"
        searchPlaceholder={LEAD_SEARCH_PLACEHOLDER}
        /*
          Download sits on the filter row, right-aligned, which is where both leads artboards draw
          it. It was inside the table's own toolbar band on the list and inside the board's stage
          strip on the board -- two positions for one action, both of them inside the thing being
          exported, and neither of them where a coach looks for it. One control here covers both
          views, and it exports the filtered rows either way because that is the set the row above
          it describes.

          The board's drag line keeps its place beside it, also as the artboard draws it, and stays
          gated on a move actually being possible.
        */
        trailing={
          <div className="flex min-w-0 items-center gap-[var(--s-3)]">
            {activeView === "board" && canMove ? (
              <p className={COACH_FOOTNOTE_CLASS} data-slot="board-drag-hint">
                Drag a card to move someone along.
              </p>
            ) : null}
            {activeView === "callback" ? null : (
              /*
                Not on the call-back view, which is the one view whose rows are not `exportRows`:
                it draws two stages out of seven while the export carries the whole filtered set,
                so a coach looking at four leads would be handed two hundred. That view has never
                had an export -- the control used to live inside the table and the board, so it
                simply was not there -- and the honest fix is to keep it that way rather than to
                bind a second rows expression the guard could not tell from a mistake.
              */
              <ExportMenu
                className="h-[48px] px-[var(--s-4)] text-[16px]"
                filename="setterfi-coach-leads"
                label="Download"
                mode="local"
                rows={exportRows}
              />
            )}
          </div>
        }
        views={[]}
      />

      {/*
        What the list below is scoped to, in words, sitting where `Leads.dc.html` draws a stage
        control reading "All stages".

        The artboard draws that as a select. This build's stage filter is multi-select and lives
        inside the Filters popover with the channel and decision facets, so a second visible stage
        control would be a duplicate that can disagree with the one in the popover. What was
        genuinely missing was not the control but the readout: with the popover shut there was
        nothing on screen saying whether a stage filter was on, so a coach could scroll a
        four-row list and read it as their whole pipeline. This says which it is, and it is the
        selected stages by name rather than a count, because "2 stages" leaves the reader to open
        the popover to find out which two.
      */}
      <p className={`${COACH_FOOTNOTE_CLASS} -mt-[var(--s-2)]`} data-slot="leads-stage-scope">
        {stageScope}
      </p>

      {/* One panel for what the filtered set adds up to: the distribution sentence, the funnel,
          and the notices that qualify both. The list itself carries its own panel below, so the
          page is two cards doing two jobs rather than one card holding everything. */}
      <section className={LEADS_PANEL_CLASS}>
        {/* The distribution is one sentence rather than a row of figure wells, because the funnel
            below already owns that interior and two rows of counts on one card would be the same
            card twice. Every numeral in it is counted from the loaded list. */}
        <Prose
          aria-label="Pipeline summary"
          className={`mt-[var(--s-3)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}
        >
          {summary.map((entry, index) => (
            <span key={entry.label}>
              {index === 0 ? "" : index === summary.length - 1 ? ", and " : ", "}
              <span className="font-mono tabular-nums text-[color:var(--body)]">{entry.count}</span>
              {` ${entry.label}`}
            </span>
          ))}
          .
        </Prose>

        <LeadFunnel contacts={filteredContacts} steps={funnelSteps} />

        <p className={`mt-[var(--s-3)] ${COACH_READING_CLASS} text-[var(--muted)]`}>
          Stage changes:{" "}
          <span className="font-mono tabular-nums text-[var(--body)]">
            {AUDIT_ACTIONS["contact.pipeline_stage.set"].microcopy}
          </span>
        </p>

        {impersonation ? (
          <Notice role="status" tone="warning">This impersonated view is read-only.</Notice>
        ) : null}

        {!evidenceChecked ? (
          <Notice role="status" tone="warning">
            Appointment evidence could not be loaded. Receipts are hidden and booked or no-show changes are paused until it loads.
          </Notice>
        ) : null}
        {moveNotice ? (
          <Notice role="status" tone="neutral">{moveNotice}</Notice>
        ) : null}
      </section>

      {activeView === "callback" ? (
        <section className={LEADS_PANEL_CLASS}>
          <CallbackList
            contacts={callbackContacts}
            nextSetterTouch={touchByContact}
            nowMs={nowMs}
          />
        </section>
      ) : null}

      {activeView === "table" ? (
        <div className="min-w-0">
          <CoachContacts
            contacts={filteredContacts}
            impersonation={impersonation}
            onContactDeleted={contactDeleted}
            onContactMerged={contactMerged}
            onContactUnmerged={contactUnmerged}
            onSelectedChange={setSelectedId}
            selectedId={selectedId}
          />
        </div>
      ) : null}

      {/*
        The board's one-line instruction, and it is gated rather than printed.

        `LeadsBoard.dc.html` heads the board with "Drag a card to move someone along.", which is
        an instruction that is only true while a move can actually be made. In this environment
        `writeEnabled` is off and the board already says so at length -- stage changes are not
        switched on, Move to is off on every card, nothing has changed stage and no lead was
        messaged. Printing an invitation to drag directly above that would be the honest-state
        rule broken in the smallest possible way: a coach follows the instruction, nothing
        happens, and now they do not know whether the feature is broken or their mouse is.

        So it renders on the same condition the move itself does, which means a read-only
        impersonated view does not get it either.
      */}
      {activeView === "board" ? (
        <div className="min-w-0">
          <CoachPipeline
            appointmentEvidence={evidenceByContact}
            canMove={canMove}
            contacts={filteredContacts}
            onMove={moveLead}
            onOpen={setSelectedId}
            pendingIds={pendingIds}
            writeEnabled={writeEnabled}
          />
        </div>
      ) : null}

      {activeView === "board"
        ? <BoardKeyboardHelp canMove={canMove} writeEnabled={writeEnabled} />
        : null}

      {activeView === "board" ? (
        <CoachContacts
          contacts={filteredContacts}
          impersonation={impersonation}
          onContactDeleted={contactDeleted}
          onContactMerged={contactMerged}
          onContactUnmerged={contactUnmerged}
          onSelectedChange={setSelectedId}
          selectedId={selectedId}
          tableVisible={false}
        />
      ) : null}

      {/*
        The artboard's closing line under the list, and it is here rather than in `CoachContacts`
        because both the list and the board render it -- a duplicate lead is a duplicate card as
        much as a duplicate row.

        It points at Help rather than at the merge tool one panel above, and that is deliberate.
        Merging is available on this page, but only where the build has already matched two
        records as candidates for each other; the case this sentence is about is the one where a
        coach can see two entries the matcher did not pair, or a row that should not exist at all,
        and there is no self-serve verb for either. "Tell us and we will sort it out" is therefore
        an accurate description of what happens next rather than a softer way of saying no.

        `prefetch={false}` for the same reason `coach-offer.tsx` gives on its own Help link: this
        renders on every load, and Next attaches an IntersectionObserver the moment it mounts.
      */}
      <section className={`${LEADS_PANEL_CLASS} flex min-w-0 flex-wrap items-center gap-[var(--s-3)]`}>
        <div className="min-w-0 flex-1">
          <p className={`m-0 ${COACH_ROW_NAME_CLASS}`}>
            Two entries for the same person, or one that should not be here?
          </p>
          <p className={`m-0 mt-[calc(var(--s-1)/2)] ${COACH_FOOTNOTE_CLASS}`}>
            Tell us and we will sort it out.
          </p>
        </div>
        {/* `secondary` is the kit's bordered low-emphasis face. "outline" is shadcn's name for the
            same idea and the kit has never had it, so this compiled to nothing typed and would have
            fallen through to the base class -- a borderless run of text where a button was drawn.
            Not `primary`: the page spends its one fill elsewhere and reporting a duplicate lead is
            not the thing a coach came to Leads to do. */}
        <Link className={kitButtonClass({ variant: "secondary" })} href="/coach/help" prefetch={false}>
          Tell us about a lead
        </Link>
      </section>

      {bookedRequest ? (
        <ConfirmFlow
          action="contact.pipeline_stage.set"
          confirmLabel={evidenceByContact[bookedRequest.cardId]
            ? "Move to Booked"
            : "Check appointment evidence"}
          expiry={{
            label: "Appointment date",
            onChange: setAppointmentDate,
            value: appointmentDate,
          }}
          impact={[
            {
              label: "Lead",
              value: contacts.find((contact) => contact.id === bookedRequest.cardId)?.name ?? "Selected lead",
            },
            { label: "From", value: STAGE_LABELS[bookedRequest.from] ?? "Current stage" },
            { label: "To", value: STAGE_LABELS.booked },
            {
              label: "Appointment receipt",
              value: evidenceByContact[bookedRequest.cardId]
                ? "Verified from Calendar"
                : "Required before the move can be saved",
            },
          ]}
          onConfirm={confirmBookedMove}
          onOpenChange={(open) => {
            if (!open) {
              setBookedRequest(null);
              setAppointmentDate(null);
            }
          }}
          open
          reason={{
            hint: "Record where the appointment was booked and any context for the activity log.",
            label: "Where it was booked",
            required: false,
          }}
          title={`Move to ${STAGE_LABELS.booked}`}
        />
      ) : null}
    </div>
  );
}
