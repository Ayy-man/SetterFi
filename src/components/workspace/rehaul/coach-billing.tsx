"use client";

/*
 * Coach Billing, drawn from `design/coach/Billing.dc.html`.
 *
 * The artboard is four things and nothing else: one plan card carrying the price, the period and
 * the allowance as a figure with a phrase; one "This count looks wrong" button that opens a text
 * box; one list of appointments with two large buttons per row; and one line inside the plan card
 * when something about the billing record needs saying. Everything the previous pass carried on
 * top of that is gone -- the five eyebrow overlines it spelled as categories nobody scans, the
 * correction form's picker and its draft machinery, the single-bar chart drawn from one reading,
 * the progress meter under the allowance, and the "Activate your plan" panel that reported the
 * checkout state machine three times over an active subscription.
 *
 * Data and mutations are unchanged: the same `/api/billing/corrections` read, the same
 * `record_attendance` and `request_correction` posts, the same `/api/billing/checkout` state, the
 * same parsers. Nothing here queries anything the old page did not.
 *
 * Where the artboard asks for a fact the record does not carry, the card says less rather than
 * inventing it, and the gap is written down in `docs/plans/2026-09-04-coach-rehaul-notes.md`:
 *   - "Over the allowance, $18 a call". The projection carries no overage rate, so that stat
 *     prints its absence in words rather than a number nobody can check.
 *   - "The card ending 4429 expires next month". There is no saved-card record and no coach
 *     reachable route to one, so the notice line carries only the notices the record does hold.
 *   - "Calls from the last two weeks". No window is stated by the read, so the footer says what
 *     the list is for instead of asserting a range.
 *
 * The answered rows ("Grant Okafor, Showed") were a gap here until 2026-09-04 and are not one any
 * more: `coach_billing_projection` returns `settledAttendance` as of migration `20261012000010`,
 * so the card lists what the coach already answered under the queue, read only.
 *
 * The anatomy is spelled with `coach.css`'s own `.coach-panel*` classes rather than through
 * `DeckPanel`, because the artboard puts a real button in two of the three header bands and
 * `DeckPanel`'s band takes a 44px square link by contract. The card face, the band, the eyebrow
 * and the name are the same rules either way; no stylesheet was edited to get them.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Status } from "@/components/kit/atomics";
import type { BillingCheckoutBrowserState } from "@/app/api/billing/checkout/handler";
import { DataState } from "@/components/kit/data-state";
import { LoggedButton } from "@/components/kit/logged-button";
import { Skeleton } from "@/components/kit/skeleton";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  parseBillingCheckoutState,
  parseCoachBillingSnapshot,
  resolveOutcomePrompt,
  noticeDeliveryLabel,
  type CoachBillingSnapshot,
} from "@/components/workspace/live/coach-billing";
import { COACH_LEAD_CLASS } from "@/components/workspace/live/coach-type";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { FAILURE_BODY } from "@/lib/copy/failure";
import {
  WORKSPACE_DISPLAY_TIMEZONE,
  workspaceCountFormat,
  workspaceDateFormat,
} from "@/lib/format/datetime";
import { displayName } from "@/lib/format/display-name";
import { money } from "@/lib/format/metric";

/*
 * The sentences this screen used to print as help text, handed to the eye.
 *
 * The page's own lead line is not repeated here: the artboard prints "What you pay, what you have
 * used, and how the calls went" under the title, and a fact said on the page does not also belong
 * in the eye.
 */
export const COACH_BILLING_EYE_COPY =
  "A correction request is read by a person against the conversations, and the saved "
  + "count does not move until it is decided. Plan changes are arranged with SetterFi and always "
  + "take effect at the start of a billing period. Coming back from Stripe does not prove a "
  + "payment: the plan stays unconfirmed here until Stripe confirms the charge to us.";

/* The shell's own coach title: 46px/600, and the 30px step-down under 640px comes with it. */
const H1_CLASS = "coach-page-title m-0";

/*
 * The three control recipes the artboard draws, at the one height it draws them all at.
 *
 * 48px everywhere, which clears the 44px floor with room. The good pair is the attendance answer
 * (`Billing.dc.html:160`), heavier and wider than the page's other actions because it is the one
 * thing on its row asking for a reply.
 */
const CONTROL_BASE =
  "inline-flex h-[48px] items-center justify-center gap-[10px] rounded-[9px] "
  + "text-[16px] leading-none whitespace-nowrap no-underline";
const PRIMARY_CLASS =
  `${CONTROL_BASE} border border-[var(--accent-line)] [background:var(--accent-fill)] px-[24px] `
  + "font-semibold text-[color:var(--on-accent)]";
const SECONDARY_CLASS =
  `${CONTROL_BASE} border border-[var(--line)] bg-[var(--control-fill)] px-[22px] font-medium `
  + "text-[color:var(--body)] hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";
const GOOD_CLASS =
  `${CONTROL_BASE} border border-[var(--good-line)] bg-[var(--good-wash)] px-[26px] font-semibold `
  + "text-[color:var(--good-text)]";

const STAT_LABEL_CLASS = "coach-panel__stat-label";
const ROW_NAME_CLASS = "m-0 text-[18px] leading-[1.35] font-medium text-[color:var(--ink)]";
const ROW_META_CLASS = "m-0 text-[16px] leading-[1.45] text-[color:var(--muted)]";
const FOOTNOTE_CLASS = "m-0 text-[15px] leading-[1.5] text-[color:var(--muted)]";
const FIELD_LABEL_CLASS = "text-[16px] leading-[1.5] text-[color:var(--muted)]";
/* The queue's own cleared line: body size, not the footnote's 15px, and written once rather
   than appended over FOOTNOTE_CLASS, which would spell font-size twice in one class list. */
const CLEARED_CLASS = "m-0 text-[16px] leading-[1.5] text-[color:var(--muted)]";
const TEXTAREA_CLASS =
  "min-h-[120px] w-full resize-y rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] "
  + "px-[16px] py-[12px] text-[16px] leading-[1.5] text-[color:var(--ink)] "
  + "placeholder:text-[color:var(--muted)]";

/** "Tuesday, Sep 2 at 2:00 PM", which is how the artboard reads an appointment back. */
const APPOINTMENT_FORMAT = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** The month the allowance resets in, for the phrase under the figure. */
const RESET_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

const DAY_MS = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : workspaceDateFormat.format(parsed);
}

function formatAppointment(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Time not recorded" : APPOINTMENT_FORMAT.format(parsed);
}

function formatReset(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : RESET_FORMAT.format(parsed);
}

/**
 * What to call the price's cadence, measured rather than assumed.
 *
 * The projection carries a price and a pair of period boundaries, and no interval field. Printing
 * "a month" over a record that happens to hold an annual period would be a claim about the
 * contract this page cannot read, so the two dates decide, and anything that is not one of the
 * three ordinary cadences gets named as the period it actually is.
 */
function cadenceLabel(periodStart: string, periodEnd: string) {
  const start = Date.parse(periodStart);
  const end = Date.parse(periodEnd);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return "each period";
  const days = Math.round((end - start) / DAY_MS);
  if (days >= 26 && days <= 32) return "a month";
  if (days >= 6 && days <= 8) return "a week";
  if (days >= 360 && days <= 372) return "a year";
  return "each period";
}

/** The one line the plan card carries when something about the billing record needs saying. */
type PlanNotice = {
  tone: "warning" | "failure" | "waiting";
  text: string;
  action?: ReactNode;
  marker?: ReactNode;
};

function InfoGlyph() {
  return (
    <svg
      aria-hidden="true"
      className="mt-[2px] size-[20px] flex-none"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </svg>
  );
}

/**
 * The notice, chosen rather than stacked.
 *
 * The card carries one line, so the states are ordered by what a coach has to do something about
 * first: an account the platform has stopped, an account with a clock running on it, a payment
 * this browser can still complete, a plan already moving, and last the delivery of the allowance
 * notice itself. Everything quieter than that gets no line at all, which is the point of a single
 * slot: a line that is always there is a line nobody reads.
 */
function planNotice({
  checkout,
  checkoutPending,
  checkoutReturn,
  onCheckout,
  snapshot,
}: {
  checkout: BillingCheckoutBrowserState | null;
  checkoutPending: boolean;
  checkoutReturn: "returned" | "canceled" | null;
  onCheckout(retryAfterCancel: boolean): void;
  snapshot: CoachBillingSnapshot;
}): PlanNotice | null {
  if (snapshot.accountState === "suspended") {
    return {
      /*
       * Not approved copy, and the page says so rather than presenting draft wording as final.
       * `live/coach-billing.tsx` carries the same marker on the same sentence; the fix is the
       * owner approving the wording, not dropping the marker.
       */
      marker: <Status label="Draft copy" tone="draft" />,
      text: "This account is suspended. Contact support to review the billing record.",
      tone: "failure",
    };
  }
  if (snapshot.accountState === "overdue") {
    return {
      text: "Payment is overdue. Your agent stays available while the billing record is reviewed.",
      tone: "warning",
    };
  }

  /*
   * The checkout, folded into this one line. It is plumbing and stays invisible unless there is
   * something a coach can press: an offer that stands, or a return from Stripe still resolving.
   * `parseBillingCheckoutState` only allows a null offer on `unavailable`, so an offer is exactly
   * the test for "there is a checkout to act on".
   */
  const offer = checkout?.offer ?? null;
  const returned = checkoutReturn === "returned" && checkout?.state === "pending";
  const canceled = checkoutReturn === "canceled" && checkout?.state === "pending";
  if (returned || checkout?.state === "confirming") {
    return {
      text: "Stripe has not confirmed this payment yet. The plan activates when it does.",
      tone: "waiting",
    };
  }
  if (offer && (checkout?.state === "offered" || checkout?.state === "expired" || canceled)) {
    return {
      action: (
        <button
          className={SECONDARY_CLASS}
          disabled={checkoutPending}
          onClick={() => onCheckout(canceled)}
          type="button"
        >
          {checkoutPending ? "Opening secure checkout" : "Continue to checkout"}
        </button>
      ),
      text: canceled
        ? "Checkout was canceled in this browser. Nothing was charged."
        : "This plan is not paid for yet.",
      tone: "warning",
    };
  }

  const movement = snapshot.pendingMovement;
  if (movement) {
    const when = formatDate(movement.effectiveAt);
    return {
      text: when
        ? `Your plan moves to ${displayName(movement.tierName)} on ${when}.`
        : `Your plan moves to ${displayName(movement.tierName)} at the next period.`,
      tone: "waiting",
    };
  }

  const undelivered = snapshot.notices.filter(
    (notice) => noticeDeliveryLabel(notice) !== "Sent",
  ).length;
  if (undelivered > 0) {
    return {
      text: `${workspaceCountFormat.format(undelivered)} allowance `
        + `${undelivered === 1 ? "notice has" : "notices have"} not reached your billing contact `
        + "yet.",
      tone: "warning",
    };
  }
  return null;
}

const NOTICE_GROUND: Record<PlanNotice["tone"], string> = {
  failure: "border-[var(--failure-line)] bg-[var(--failure-wash)] text-[color:var(--failure-text)]",
  waiting: "border-[var(--waiting-line)] bg-[var(--waiting-wash)] text-[color:var(--waiting-text)]",
  warning: "border-[var(--warning-line)] bg-[var(--warning-wash)] text-[color:var(--warning-body)]",
};

function BillingLoading() {
  return (
    <div aria-busy="true" className="coach-panel" role="status">
      <span className="sr-only">Billing details are loading.</span>
      <div className="coach-panel__header flex-wrap">
        <div className="min-w-0">
          <p className="coach-panel__eyebrow">Your plan</p>
          <h2 className="coach-panel__name">Reading your billing record</h2>
        </div>
      </div>
      <div className="coach-panel__body">
        <Skeleton aria-hidden className="h-[62px] w-3/5" />
        <Skeleton aria-hidden className="mt-[16px] h-[14px] w-4/5" />
      </div>
    </div>
  );
}

/**
 * The plan card: everything a coach opened this page to read, in one card.
 *
 * The figure is the allowance rather than the price, which is the artboard's ruling and the right
 * one: the price is a number they agreed to once and the allowance is the number that moves. The
 * price sits in the footer stats beside the period, where a fact you check is easier to find than
 * a fact that shouts.
 */
function PlanCard({
  notice,
  snapshot,
}: {
  notice: PlanNotice | null;
  snapshot: CoachBillingSnapshot;
}) {
  const reset = formatReset(snapshot.periodEnd);
  const start = formatDate(snapshot.periodStart);
  const end = formatDate(snapshot.periodEnd);
  const cadence = cadenceLabel(snapshot.periodStart, snapshot.periodEnd);

  return (
    <section
      aria-labelledby="coach-billing-plan"
      className="coach-panel"
      data-hero="true"
      data-slot="billing-plan"
    >
      <div className="coach-panel__header flex-wrap">
        <div className="min-w-0">
          <p className="coach-panel__eyebrow">Your plan</p>
          <h2 className="coach-panel__name" id="coach-billing-plan">
            {displayName(snapshot.tierName)}
          </h2>
        </div>
        {/*
          The page's one filled button. There is no self-serve plan mover and there is not going
          to be one: a change is arranged with SetterFi and takes effect at a period boundary, so
          the control is a link to the place that conversation happens, drawn at the weight the
          artboard gives it.
        */}
        <a className={`${PRIMARY_CLASS} ml-auto flex-none`} href="/coach/help">
          Change plan
        </a>
      </div>

      <div className="coach-panel__body">
        <div className="flex flex-wrap items-baseline gap-[12px]">
          <span className="coach-panel__figure" data-slot="billing-allowance">
            {workspaceCountFormat.format(snapshot.bookedCount)}
          </span>
          <span className="text-[26px] leading-[1.2] font-medium text-[color:var(--muted)]">
            of {workspaceCountFormat.format(snapshot.callAllowance)}
          </span>
        </div>
        {/*
          The phrase, not a bar. A meter under this figure drew the same ratio a second time and
          the artboard draws no bar on this screen; the sentence is what a coach reads out loud.
        */}
        <p className="coach-panel__sentence" data-slot="billing-allowance-phrase">
          Booked calls this billing period.{reset ? ` Resets ${reset}.` : ""}
        </p>

        <div className="coach-panel__footer coach-panel__stats">
          <div className="coach-panel__stat">
            <span className={STAT_LABEL_CLASS}>Cost</span>
            <span className="coach-panel__stat-value">
              {money(snapshot.priceCents, snapshot.currency)}
              <span className="text-[length:var(--coach-eyebrow)] font-sans text-[color:var(--muted)]">
                {" "}
                {cadence}
              </span>
            </span>
          </div>
          <div className="coach-panel__stat">
            <span className={STAT_LABEL_CLASS}>Current period</span>
            {start && end ? (
              <span className="coach-panel__stat-value">{start} to {end}</span>
            ) : (
              <span className="coach-panel__stat-value" data-absent="true">
                Period dates not recorded
              </span>
            )}
          </div>
          {/*
            The artboard's third stat is an overage rate. Nothing in the projection carries one,
            so this states the absence where the figure would be rather than printing a rate the
            page cannot check. See the rehaul notes for the read Codex would have to add.
          */}
          <div className="coach-panel__stat">
            <span className={STAT_LABEL_CLASS}>Over the allowance</span>
            <span className="coach-panel__stat-value" data-absent="true">
              Not stated on your record
            </span>
          </div>
        </div>
      </div>

      {notice ? (
        <div
          className={`flex flex-wrap items-center gap-x-[12px] gap-y-[10px] border-t px-[20px] py-[16px] ${NOTICE_GROUND[notice.tone]}`}
          data-slot="billing-notice"
          role="status"
        >
          <InfoGlyph />
          {notice.marker}
          <span className="min-w-0 flex-1 text-[16px] leading-[1.5]">{notice.text}</span>
          {notice.action}
        </div>
      ) : null}
    </section>
  );
}

/**
 * "This count looks wrong": one button, one box, one send.
 *
 * The previous pass drew a picker of billable events, a reason field, an in-flight status and a
 * standing "Logged" caption, which is four controls for one sentence. `SIMPLIFICATION-SPEC` 2.8
 * calls that "right instinct, too much form" and the artboard answers with a button that opens a
 * box.
 *
 * The route still wants a `quantityDelta` and an `eventId`, so the request is anchored to the
 * most recent billable call in the period and the coach's words are the reason a person reads.
 * That anchoring is stated under the box rather than left implicit -- what is decided is the
 * count, and the anchor is which record the request hangs on.
 */
function CorrectionCard({
  onSubmit,
  pending,
  receipt,
  snapshot,
}: {
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  pending: boolean;
  receipt: boolean;
  snapshot: CoachBillingSnapshot;
}) {
  const [open, setOpen] = useState(false);
  const from = formatDate(snapshot.periodStart);
  const noticeCount = snapshot.notices.length;

  return (
    <section
      aria-labelledby="coach-billing-correction"
      className="coach-panel"
      data-slot="billing-correction"
    >
      <div className="coach-panel__header flex-wrap">
        <div className="min-w-0">
          <p className="coach-panel__eyebrow">Booked calls</p>
          <h2 className="coach-panel__name" id="coach-billing-correction">
            Does {workspaceCountFormat.format(snapshot.bookedCount)} look wrong?
          </h2>
        </div>
        <button
          aria-expanded={open}
          className={`${SECONDARY_CLASS} ml-auto flex-none`}
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          This count looks wrong
        </button>
      </div>

      <div className="coach-panel__body gap-[14px]">
        {/*
          What the card is about, said in sentences, because the record carries no second figure
          for this column and inventing one to fill the height is the defect the whole rebuild is
          against. Each of these is a fact the plan card does not already print: the plan card
          says what the count is and when it resets, and these say what goes into it, which window
          it covers, and what pressing the button does.
        */}
        <div className="flex flex-col gap-[10px]" data-slot="billing-correction-body">
          <p className={FIELD_LABEL_CLASS}>
            Every appointment your agent booked counts once, whether or not the lead turned up.
          </p>
          {from ? (
            <p className={FIELD_LABEL_CLASS}>
              Calls booked before {from} belong to an earlier period and are not in this count.
            </p>
          ) : null}
          {/*
            The period's notices, as the one sentence `SIMPLIFICATION-SPEC` 2.8 leaves room for
            rather than the list it kills. Whether one failed to arrive is the plan card's line;
            this is how many were sent at all, which is a different fact and belongs beside the
            count they were about.
          */}
          {noticeCount > 0 ? (
            <p className={FIELD_LABEL_CLASS} data-slot="billing-correction-notices">
              {workspaceCountFormat.format(noticeCount)} allowance{" "}
              {noticeCount === 1 ? "notice" : "notices"} went to your billing contact this period.
            </p>
          ) : null}
          <p className={FIELD_LABEL_CLASS}>
            If that does not match your calendar, use the button above. Tell us what you saw and a
            person checks it against your conversations.
          </p>
        </div>

        {open ? (
          <form className="mt-auto flex flex-col gap-[12px]" onSubmit={onSubmit}>
            <label className={FIELD_LABEL_CLASS} htmlFor="billing-correction-reason">
              What should the count be?
            </label>
            <textarea
              className={TEXTAREA_CLASS}
              id="billing-correction-reason"
              name="reason"
              placeholder="Tell us what looks wrong"
              required
            />
            <div className="flex justify-end">
              <LoggedButton
                actionKey="billing.correction.requested"
                disabled={pending}
                scale="coach"
                type="submit"
                wrapperClassName="items-end"
              >
                {pending ? "Sending" : "Send to support"}
              </LoggedButton>
            </div>
            {receipt ? (
              <Status
                label={AUDIT_ACTIONS["billing.correction.requested"].microcopy}
                tone="good"
              />
            ) : null}
          </form>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The one question only the coach can answer.
 *
 * Two buttons per row and nothing else: the artboard's third control, Skip, is gone, because a
 * row a coach does not want to answer is already answered by leaving it alone, and a third button
 * on a two-button question is the form asking about itself.
 *
 * The card is two lists in one: the unanswered queue, then what the coach already answered this
 * period, read only. They share a row shape and a run of hairlines because the artboard draws
 * them as one list, and because the second is the first a moment later.
 *
 * With neither, the absence is stated in words. On the demo workspace it is empty by design
 * rather than by accident -- every billable row on a demo tenant carries `is_test` and the
 * projections exclude it -- so the sentence names that reason instead of reading as a screen that
 * failed to load.
 */
function AttendanceCard({
  onRecord,
  pendingId,
  receipt,
  snapshot,
}: {
  onRecord(appointmentId: string, status: "completed" | "no_show"): void;
  pendingId: string | null;
  receipt: boolean;
  snapshot: CoachBillingSnapshot;
}) {
  const prompts = snapshot.outcomePrompts;
  const settled = snapshot.settledAttendance;

  return (
    <section
      aria-labelledby="coach-billing-attendance"
      className="coach-panel"
      data-slot="billing-attendance"
    >
      <div className="coach-panel__header flex-wrap">
        <div className="min-w-0">
          <p className="coach-panel__eyebrow">Only you can tell us</p>
          <h2 className="coach-panel__name" id="coach-billing-attendance">
            How did these appointments go?
          </h2>
        </div>
        {pendingId ? (
          <span className="ml-auto flex-none">
            <Status label="Saving your answer" tone="waiting" />
          </span>
        ) : receipt ? (
          <span className="ml-auto flex-none">
            <Status
              label={AUDIT_ACTIONS["appointment.attendance_set"].microcopy}
              tone="good"
            />
          </span>
        ) : null}
      </div>

      {/*
        Nothing to answer, but something to read. The queue being empty is not the same fact as
        the card being empty, so when the coach has already answered every call in the period the
        sentence says only that and the record stays on the page under it.

        The card's gutter is written out rather than `coach-panel__body` with `pb-0`, because the
        sheet declares padding on that class unlayered, so a utility in `@layer utilities` loses
        to it and the bottom padding would have stayed whatever the class list said.
      */}
      {prompts.length === 0 && settled.length > 0 ? (
        <div className="px-[20px] pt-[20px]">
          <p className={CLEARED_CLASS} data-slot="billing-attendance-cleared">
            Nothing is waiting for an answer.
          </p>
        </div>
      ) : null}

      {prompts.length > 0 || settled.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {prompts.map((prompt) => (
            <li
              className="flex flex-wrap items-center gap-x-[24px] gap-y-[12px] border-t border-[var(--line-soft)] px-[20px] py-[16px] first:border-t-0"
              key={prompt.appointmentId}
            >
              <div className="min-w-0 flex-1 basis-[min(100%,20ch)]">
                <p className={ROW_NAME_CLASS}>{displayName(prompt.label)}</p>
                <p className={ROW_META_CLASS}>{formatAppointment(prompt.occurredAt)}</p>
              </div>
              <div className="flex flex-wrap gap-[12px]">
                <button
                  className={GOOD_CLASS}
                  disabled={pendingId !== null}
                  onClick={() => onRecord(prompt.appointmentId, "completed")}
                  type="button"
                >
                  Showed
                </button>
                <button
                  className={SECONDARY_CLASS}
                  disabled={pendingId !== null}
                  onClick={() => onRecord(prompt.appointmentId, "no_show")}
                  type="button"
                >
                  No-show
                </button>
              </div>
            </li>
          ))}
          {/*
            What the coach already answered, so a press on Showed leaves a record instead of making
            the row vanish. Read only: changing an answer is a correction request, which is the
            card beside this one. The same row shape as the queue above it, with the answer in the
            slot the two buttons occupied, which is how the artboard draws Grant Okafor.
          */}
          {settled.map((row) => (
            <li
              className="flex flex-wrap items-center gap-x-[24px] gap-y-[12px] border-t border-[var(--line-soft)] px-[20px] py-[16px] first:border-t-0"
              data-slot="billing-attendance-settled"
              key={row.appointmentId}
            >
              <div className="min-w-0 flex-1 basis-[min(100%,20ch)]">
                <p className={ROW_NAME_CLASS}>{displayName(row.label)}</p>
                <p className={ROW_META_CLASS}>{formatAppointment(row.occurredAt)}</p>
              </div>
              {/*
                Neutral for a no-show, never warning. Amber is this product's one persistent status
                colour and it means somebody has to act; a call the coach has already told us about
                is settled, and colouring it amber would put a standing alarm on the record of an
                answer they gave.
              */}
              <Status
                label={row.outcome === "completed" ? "Showed" : "No-show"}
                tone={row.outcome === "completed" ? "good" : "neutral"}
              />
            </li>
          ))}
        </ul>
      ) : (
        <div className="coach-panel__body">
          <p
            className="m-0 max-w-[var(--measure-deck)] text-[20px] leading-[1.35] font-medium text-[color:var(--muted)]"
            data-slot="billing-attendance-absent"
          >
            {snapshot.isDemo
              ? "No calls are listed here. This is a demo workspace, so its bookings are marked as "
                + "test data and never billed."
              : "No appointments are waiting for an answer."}
          </p>
        </div>
      )}

      <div className="border-t border-[var(--line-soft)] px-[20px] py-[14px]">
        <p className={FOOTNOTE_CLASS}>
          Every answer is logged, and it feeds your own analytics.
        </p>
      </div>
    </section>
  );
}

export function CoachBillingRehaul({
  enabled,
  initialSnapshot = null,
  checkoutReturn = null,
}: {
  enabled: boolean;
  initialSnapshot?: CoachBillingSnapshot | null;
  checkoutReturn?: "returned" | "canceled" | null;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [loading, setLoading] = useState(enabled && initialSnapshot === null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionReceipt, setActionReceipt] = useState<string | null>(null);
  const [correctionPending, setCorrectionPending] = useState(false);
  const [pendingAppointmentId, setPendingAppointmentId] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<BillingCheckoutBrowserState | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/billing/corrections", {
          cache: "no-store",
          signal: controller.signal,
        });
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("BILLING_LOAD_REFUSED");
        setSnapshot(parseCoachBillingSnapshot(payload));
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [enabled, loadAttempt]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/billing/checkout", {
          cache: "no-store",
          signal: controller.signal,
        });
        /*
         * A 404 is the route saying hosted checkout is not configured in this deployment, which is
         * a reading rather than a failure: there is no offer, no attempt and nothing to verify.
         * A read that fails for any other reason is recorded the same way, because this screen has
         * one slot for a notice and a checkout the page cannot read is not the thing a coach with
         * an active subscription needs it for. The page never claims a payment either way.
         */
        if (!response.ok) {
          setCheckout({ state: "unavailable", offer: null, attempt: null });
          return;
        }
        setCheckout(parseBillingCheckoutState(await response.json()));
      } catch {
        if (!controller.signal.aborted) {
          setCheckout({ state: "unavailable", offer: null, attempt: null });
        }
      }
    })();
    return () => controller.abort();
  }, [enabled]);

  if (!enabled) {
    return (
      <div className="min-w-0">
        <h1 className={H1_CLASS}>Billing</h1>
        <div className="mt-[32px]">
          <DataState
            body="Turn on billing when this workspace is ready to use subscription records."
            kind="empty"
            title="Billing is not enabled"
          />
        </div>
      </div>
    );
  }

  function retryLoad() {
    setLoading(true);
    setLoadError(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function startCheckout(retryAfterCancel: boolean) {
    if (!checkout?.offer || checkoutPending) return;
    setCheckoutPending(true);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tierId: checkout.offer.tierId,
          ...(retryAfterCancel ? { retryAfterCancel: true } : {}),
        }),
      });
      const payload: unknown = await response.json();
      const hostedUrl = isRecord(payload) && typeof payload.url === "string" ? payload.url : null;
      if (!response.ok || !hostedUrl) throw new Error("BILLING_CHECKOUT_URL_REFUSED");
      window.location.assign(hostedUrl);
    } catch {
      setActionError("Secure checkout could not be opened. Nothing was charged; try again.");
      setCheckoutPending(false);
    }
  }

  async function post(body: Record<string, unknown>) {
    const response = await fetch("/api/billing/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload)) throw new Error("BILLING_ACTION_REFUSED");
    return payload;
  }

  /*
   * A period-level request: `request_period_correction` takes the coach's words and nothing else.
   *
   * This card used to anchor the request to the most recent billable call and say so under the
   * box, because `request_correction` demanded an `eventId` and a signed `quantityDelta` that a
   * coach describing a problem in words has no way to supply. That was reported as a gap and the
   * route now carries the shape the artboard always drew, so the anchoring sentence is gone with
   * the field that forced it -- and the card works on a workspace with no billable call in it,
   * which is where the workaround was at its worst.
   */
  async function requestCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    if (!reason) return;
    setCorrectionPending(true);
    setActionError(null);
    setActionReceipt(null);
    try {
      const payload = await post({ action: "request_period_correction", reason });
      const result = isRecord(payload.result) ? payload.result : null;
      if (
        typeof result?.requestId !== "string"
        || typeof result.auditId !== "number"
      ) throw new Error("BILLING_CORRECTION_RECEIPT_INVALID");
      form.reset();
      setActionReceipt(AUDIT_ACTIONS["billing.correction.requested"].microcopy);
    } catch {
      setActionError("The correction request was refused. Nothing changed.");
    } finally {
      setCorrectionPending(false);
    }
  }

  async function recordOutcome(appointmentId: string, status: "completed" | "no_show") {
    setPendingAppointmentId(appointmentId);
    setActionError(null);
    setActionReceipt(null);
    try {
      const payload = await post({ action: "record_attendance", appointmentId, status });
      const result = isRecord(payload.result) ? payload.result : null;
      if (typeof result?.auditId !== "number" || typeof result.billableQuantity !== "number") {
        throw new Error("ATTENDANCE_RECEIPT_INVALID");
      }
      /*
       * The answer moves from the queue into the settled list in the same step, so a coach who
       * pressed Showed sees their answer rather than a row that disappeared.
       * `resolveOutcomePrompt` drops the prompt and does not add the settled row, because it is
       * shared with the live surface, so the second half is done here against the row this
       * handler already holds. It is not a guess about the write: the receipt above is checked
       * first, and the next read replaces the whole snapshot with the projection's own copy.
       */
      setSnapshot((current) => {
        if (!current) return current;
        const answered = current.outcomePrompts.find(
          (prompt) => prompt.appointmentId === appointmentId,
        );
        const resolved = resolveOutcomePrompt(current, appointmentId);
        return answered
          ? {
            ...resolved,
            settledAttendance: [
              {
                appointmentId,
                label: answered.label,
                occurredAt: answered.occurredAt,
                outcome: status,
              },
              ...resolved.settledAttendance,
            ],
          }
          : resolved;
      });
      setActionReceipt(AUDIT_ACTIONS["appointment.attendance_set"].microcopy);
    } catch {
      setActionError("The attendance update was refused. Nothing changed.");
    } finally {
      setPendingAppointmentId(null);
    }
  }

  const notice = snapshot
    ? planNotice({
      checkout,
      checkoutPending,
      checkoutReturn,
      onCheckout: (retry) => void startCheckout(retry),
      snapshot,
    })
    : null;

  return (
    <div className="relative min-w-0">
      <div className="flex flex-wrap items-end gap-[24px]">
        <div className="min-w-0">
          <h1 className={H1_CLASS}>Billing</h1>
          <p className={`m-0 mt-[12px] max-w-[var(--measure-wide)] ${COACH_LEAD_CLASS}`}>
            What you pay, what you have used, and how the calls went.
          </p>
        </div>
        <div className="ml-auto flex flex-none items-center">
          <ContextEye
            copy={COACH_BILLING_EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-billing"
          />
        </div>
      </div>

      <div className="mt-[32px] flex min-w-0 flex-col gap-[24px]">
        {loading ? <BillingLoading /> : null}
        {!loading && loadError ? (
          <DataState
            body={`Billing records could not be read. ${FAILURE_BODY.billing}`}
            kind="error"
            retry={retryLoad}
            title="Billing details could not load"
          />
        ) : null}
        {!loading && !loadError && !snapshot ? (
          <DataState
            body={`${FAILURE_BODY.billingUnavailable} ${FAILURE_BODY.billing}`}
            kind="unavailable"
            retry={retryLoad}
            title="Billing details could not load"
          />
        ) : null}

        {snapshot ? (
          <>
            {/* Not `items-start`: the two cards in a row are the same height, so the column beside a
                tall plan card is a card rather than a stub over bare ground. */}
            <div className="grid min-w-0 items-stretch gap-[24px] lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
              <PlanCard notice={notice} snapshot={snapshot} />
              <CorrectionCard
                onSubmit={(event) => void requestCorrection(event)}
                pending={correctionPending}
                receipt={
                  actionReceipt === AUDIT_ACTIONS["billing.correction.requested"].microcopy
                }
                snapshot={snapshot}
              />
            </div>

            <AttendanceCard
              onRecord={(appointmentId, status) => void recordOutcome(appointmentId, status)}
              pendingId={pendingAppointmentId}
              receipt={actionReceipt === AUDIT_ACTIONS["appointment.attendance_set"].microcopy}
              snapshot={snapshot}
            />
          </>
        ) : null}

        {actionError ? (
          <p
            className="m-0 text-[16px] leading-[1.5] text-[color:var(--failure-text)]"
            role="alert"
          >
            {actionError}
          </p>
        ) : null}
      </div>
    </div>
  );
}
