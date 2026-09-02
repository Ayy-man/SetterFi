"use client";

import { Info, ShieldCheck } from "@/components/kit/icons";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import {
  KitButton,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
  StatusDot,
  Surface,
  TONE_TEXT,
} from "@/components/kit/atomics";
import type { BillingCheckoutBrowserState } from "@/app/api/billing/checkout/handler";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel, TITLE_PANEL_TITLE_CLASS, TitlePanel } from "@/components/kit/deck-panel";
import { Field } from "@/components/kit/field";
import { LoggedButton } from "@/components/kit/logged-button";
import { Meter } from "@/components/kit/meter";
import { Skeleton } from "@/components/kit/skeleton";
import { CoachPageHead } from "@/components/workspace/live/coach-page-head";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { FAILURE_BODY } from "@/lib/copy/failure";
import {
  BILLING_INVOICE_STATE_COPY,
  BILLING_SUBSCRIPTION_STATE_COPY,
  type StateCopy,
} from "@/lib/copy/states";
import {
  timezoneDisplayLabel,
  workspaceCountFormat,
  workspaceDateFormat,
} from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";
import { cn } from "@/lib/utils";

export type CoachBillingNotice = {
  id: string;
  kind: "warning" | "crossing";
  state: "queued" | "pending" | "sent";
  deliveryReceiptId: string | null;
  billingContactSource: string;
};

export type CoachOutcomePrompt = {
  appointmentId: string;
  label: string;
  occurredAt: string;
};

export type CoachCorrectionCandidate = {
  eventId: string;
  label: string;
};

export type CoachBillingSnapshot = {
  tierName: string;
  priceCents: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  timezone: string;
  bookedCount: number;
  callAllowance: number;
  subscriptionState: string;
  invoiceState: string;
  accountState: "onboarding" | "active" | "paused" | "overdue" | "suspended" | "churned";
  pendingMovement: {
    tierName: string;
    priceCents: number;
    effectiveAt: string;
  } | null;
  notices: readonly CoachBillingNotice[];
  correctionCandidates: readonly CoachCorrectionCandidate[];
  outcomePrompts: readonly CoachOutcomePrompt[];
  isDemo: boolean;
};

const SNAPSHOT_KEYS = [
  "accountState", "bookedCount", "callAllowance", "correctionCandidates", "currency",
  "invoiceState", "isDemo", "notices", "outcomePrompts", "pendingMovement", "periodEnd",
  "periodStart", "priceCents", "subscriptionState", "tierName", "timezone",
] as const;

/*
 * The page is drawn out of `kit/atomics` rather than out of class strings retyped here.
 *
 * The earlier pass hand-rolled nine of them -- the card face, the well, the overline, the card
 * title, the mono meta line -- each a second definition of something the kit already owns, and
 * a second definition is a thing that drifts. `Surface` carries the face and the well,
 * `Overline`, `Figure`, `MonoMeta` and `Prose` carry the type, and `Status` carries every state.
 * What is left below is layout the kit has no opinion about.
 *
 * On a billing page the Mono Licence Rule is doing most of the work: money, counts, period
 * boundaries and dates are all figures and all set in mono with tabular numerals, while every
 * sentence around them stays Archivo. That contrast is what makes a charge read as an instrument
 * readout rather than as a paragraph with a number in it.
 */
const CARD_CLASS = "flex min-w-0 flex-col";
// The section-title role, taken from the token rather than restated as a pixel value, so a card
// heading here is the same size as a panel heading anywhere else in the product. It survives the
// coach port because the two account-state frames below are `Surface tone=` cards rather than
// deck panels: the tone frame is the kit's, and its heading has to match the kit's scale.
const CARD_TITLE_CLASS =
  "m-0 text-[length:var(--t-section-title)] leading-[var(--t-section-title-lh)] font-[600] tracking-[var(--t-section-title-tr)] text-[color:var(--ink)]";
const HAIRLINE_TOP_CLASS = "mt-[var(--s-4)] border-t border-[var(--line-soft)] pt-[var(--s-4)]";

/*
 * The coach scale, written here rather than taken from `kit/atomics`.
 *
 * The kit's type roles are the owner console's: `Overline` is 9.5px uppercase mono, `Figure` tops
 * out around 22px, `Prose` and `MonoMeta` sit at 12-12.5px. That scale is correct for a person
 * who is in the console all day with a mouse, and it is the exact thing the round-1 coaches said
 * they could not read. `coach.css` sets the body to 16px and the pressable floor to 44px for this
 * shell; these five recipes carry the same decision into the parts of a billing panel the CSS
 * file has no selector for. They are deliberately NOT a second definition of the kit's roles --
 * they are the same roles at the other density, which is why every one of them is a token
 * reference rather than a re-picked colour.
 *
 * The eyebrow is the load-bearing one. Every `Overline` on this page became one of these:
 * `--coach-eyebrow`, which is 14px, sentence case, `--muted`. 9.5px uppercase mono is the worst
 * legibility case in the product and a billing page is where a worried reader is scanning hardest
 * for the number.
 *
 * This said "12px" for a whole redesign pass, against a class that reads the token and a token that
 * has been 14px since it was declared. The size is named by reference rather than restated here for
 * exactly that reason: a number in a comment cannot be checked by anything, so it goes stale
 * silently and then gets believed by the next person sizing something to match.
 */
const EYEBROW_CLASS =
  "block text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";
const PANEL_SUB_CLASS =
  "m-0 max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]";
const ROW_TITLE_CLASS = "text-[18px] leading-[1.35] font-medium text-[color:var(--ink)]";
const ROW_META_CLASS =
  "mt-[3px] block text-[length:var(--coach-body)] leading-[1.45] text-[color:var(--muted)]";
/*
 * The figure inside a well. Mono with tabular numerals and negative tracking, at 30px rather than
 * the deck's 40-62px: a deck panel gives its figure the whole card, and a billing well has a
 * label above it and a note below it in the same box.
 */
const WELL_FIGURE_CLASS =
  "block truncate font-[family-name:var(--font-mono)] text-[30px] leading-[1.1] font-medium tracking-[-0.03em] text-[color:var(--ink)] [font-variant-numeric:tabular-nums_lining-nums]";
const COACH_WELL_CLASS =
  "min-w-0 rounded-[11px] border border-[var(--line)] bg-[var(--well)] px-[18px] py-[16px]";
/* A figure said inside a sentence rather than in a well of its own. Mono, at the sentence's size. */
/**
 * The coach-scale control: 48px tall, 16px label, the height every button on `Billing.dc.html`
 * takes. The kit's `buttonClass` tops out at 34px because it was drawn for the console's toolbars,
 * and a 34px control under a 46px page title is the console's proportion on a coach's page.
 */
const COACH_ACTION_CLASS =
  "inline-flex h-[48px] items-center gap-[10px] rounded-[9px] border border-[var(--line)] bg-[var(--control-fill)] px-[24px] text-[16px] leading-[1.4] font-medium text-[color:var(--body)] no-underline hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";

const INLINE_MONO_CLASS =
  "font-[family-name:var(--font-mono)] font-medium text-[color:var(--ink)] [font-variant-numeric:tabular-nums_lining-nums]";

const CHECKOUT_STATES = new Set([
  "unavailable", "offered", "pending", "expired", "confirming", "active",
]);
const CHECKOUT_INTERVALS = new Set(["day", "week", "month", "year"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseBillingCheckoutState(value: unknown): BillingCheckoutBrowserState {
  if (!isRecord(value) || !isRecord(value.checkout)) {
    throw new Error("BILLING_CHECKOUT_STATE_INVALID");
  }
  const checkout = value.checkout;
  if (!CHECKOUT_STATES.has(String(checkout.state))) {
    throw new Error("BILLING_CHECKOUT_STATE_INVALID");
  }
  if (checkout.offer === null) {
    if (checkout.state !== "unavailable" || checkout.attempt !== null) {
      throw new Error("BILLING_CHECKOUT_STATE_INVALID");
    }
    return checkout as BillingCheckoutBrowserState;
  }
  if (
    !isRecord(checkout.offer)
    || typeof checkout.offer.tierId !== "string" || !checkout.offer.tierId.trim()
    || typeof checkout.offer.label !== "string" || !checkout.offer.label.trim()
    || typeof checkout.offer.currency !== "string" || !/^[A-Z]{3}$/.test(checkout.offer.currency)
    || typeof checkout.offer.amountCents !== "number" || !Number.isSafeInteger(checkout.offer.amountCents)
    || checkout.offer.amountCents < 0
    || !CHECKOUT_INTERVALS.has(String(checkout.offer.interval))
    || (checkout.offer.effectiveTo !== null
      && (typeof checkout.offer.effectiveTo !== "string"
        || !Number.isFinite(Date.parse(checkout.offer.effectiveTo))))
  ) throw new Error("BILLING_CHECKOUT_STATE_INVALID");
  if (checkout.attempt !== null && (
    !isRecord(checkout.attempt)
    || !["pending", "succeeded", "expired"].includes(String(checkout.attempt.outcome))
    || (checkout.attempt.expiresAt !== null
      && (typeof checkout.attempt.expiresAt !== "string"
        || !Number.isFinite(Date.parse(checkout.attempt.expiresAt))))
  )) throw new Error("BILLING_CHECKOUT_STATE_INVALID");
  return checkout as BillingCheckoutBrowserState;
}

export function validatedStripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:"
      || url.hostname !== "checkout.stripe.com"
      || url.username || url.password || url.port
    ) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stateCopy(value: string, copy: Readonly<Record<string, StateCopy>>): StateCopy {
  return copy[value] ?? { label: "State recorded", tone: "neutral" };
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date not recorded" : workspaceDateFormat.format(parsed);
}

export function parseCoachBillingSnapshot(value: unknown): CoachBillingSnapshot | null {
  if (!isRecord(value)) throw new Error("COACH_BILLING_PROJECTION_INVALID");
  const snapshot = value.snapshot;
  if (snapshot === null) return null;
  if (!isRecord(snapshot)) throw new Error("COACH_BILLING_PROJECTION_INVALID");
  if (
    Object.keys(snapshot).sort().join(",") !== SNAPSHOT_KEYS.join(",")
    || typeof snapshot.tierName !== "string"
    || typeof snapshot.priceCents !== "number" || !Number.isSafeInteger(snapshot.priceCents)
    || typeof snapshot.currency !== "string"
    || typeof snapshot.periodStart !== "string" || typeof snapshot.periodEnd !== "string"
    || typeof snapshot.timezone !== "string"
    || typeof snapshot.bookedCount !== "number" || !Number.isSafeInteger(snapshot.bookedCount)
    || typeof snapshot.callAllowance !== "number" || !Number.isSafeInteger(snapshot.callAllowance)
    || typeof snapshot.subscriptionState !== "string" || typeof snapshot.invoiceState !== "string"
    || !["onboarding", "active", "paused", "overdue", "suspended", "churned"]
      .includes(String(snapshot.accountState))
    || (snapshot.pendingMovement !== null && !isRecord(snapshot.pendingMovement))
    || !Array.isArray(snapshot.notices) || !Array.isArray(snapshot.correctionCandidates)
    || !Array.isArray(snapshot.outcomePrompts) || typeof snapshot.isDemo !== "boolean"
  ) throw new Error("COACH_BILLING_PROJECTION_INVALID");
  return snapshot as CoachBillingSnapshot;
}

export function noticeDeliveryLabel(notice: CoachBillingNotice) {
  if (notice.state === "sent" && notice.deliveryReceiptId) return "Sent";
  return notice.state === "queued" ? "Queued" : "Delivery pending";
}

export function resolveOutcomePrompt(
  snapshot: CoachBillingSnapshot,
  appointmentId: string,
) {
  return {
    ...snapshot,
    outcomePrompts: snapshot.outcomePrompts.filter(
      (prompt) => prompt.appointmentId !== appointmentId,
    ),
    bookedCount: snapshot.bookedCount,
  };
}

/**
 * A mono overline over the figure a coach opened this page to read, sunk into a well.
 *
 * It stays bespoke rather than becoming `FigureStrip`, for two reasons the kit is explicit about.
 * The allowance is a ratio -- `money-portals.test.ts` pins it as "18 of 25" -- and `FigureStrip`
 * formats a single number, so the ratio would have to be split across two figures a reader then
 * recombines. And a coach who has booked nothing this period must read `0 of 25`, a measured
 * zero; `figure-strip.tsx` documents that its one absent case cannot tell that apart from a
 * figure it could not read, which on a bill is the difference between "you owe nothing yet" and
 * "we cannot tell you what you owe".
 */
function FigureWell({ figure, label, meter, note }: {
  figure: string;
  label: string;
  /**
   * A share of the allowance, 0 to 1, drawn as the canvas's bar under the figure. Optional and
   * `aria-hidden` on purpose: the bar restates the ratio the figure already prints in words, so a
   * reader who cannot see it has lost nothing, and a reader who can gets the one thing a ratio in
   * text is bad at -- how close to the edge this month is.
   */
  meter?: number;
  note?: ReactNode;
}) {
  return (
    <div className={`flex-1 basis-[min(100%,220px)] ${COACH_WELL_CLASS}`}>
      <span className={`${EYEBROW_CLASS} mb-[8px]`}>{label}</span>
      <span className={WELL_FIGURE_CLASS}>{figure}</span>
      {meter === undefined ? null : <Meter className="mt-[14px]" value={meter} />}
      {note ? (
        <span className={ROW_META_CLASS}>{note}</span>
      ) : null}
    </div>
  );
}

/*
 * `BillingCard` was here, and what removed it was the canvas rather than a tidy-up.
 *
 * It gave every card on this page an identical banded face -- an eyebrow over a 20px name over the
 * subtitle -- and its argument for the eyebrow was a real one: a reader who is worried about a
 * charge scans category words before prose, and CHARGE / PERIOD / OUTCOMES read faster than five
 * title sentences. But it only ever wrapped the two cards `Billing.dc.html` draws with no band at
 * all (`:98`, `:151`), and an eyebrow is a part of the header band rather than a part of the card:
 * there is nowhere for it to sit once the band goes. Both are `TitlePanel` now and the two
 * eyebrows are gone with them. The account-state frames are `Surface` and never took this shape,
 * so nothing else on the page changed.
 */

/**
 * Change your plan.
 *
 * This is the surface the `CoachPlanChange` artboard draws, and it is deliberately much smaller
 * than the artboard, because most of what the artboard promises has nothing behind it. The canvas
 * shows three tier cards with prices, allowances and per-extra-call rates, a "Move to Scale on 14
 * September" button, and a consequence panel that ends "You can move back to Growth any time before
 * 14 September". Working back from the billing code, only some of that is true:
 *
 *   - There is no coach-reachable tier catalogue. `/api/billing/checkout` resolves an offer for the
 *     tenant's own already-assigned `tenants.tier_id` and refuses any other `tierId`, so a coach's
 *     session can see exactly one tier: theirs. Three priced cards would be three inventions.
 *   - There is no per-extra-call price anywhere. `tiers`, `tier_price_versions` and
 *     `tier_offer_terms` carry `price_cents`, `call_allowance` and `fair_use_cap`; none of them
 *     carries an overage rate, and crossing the allowance schedules a tier move rather than billing
 *     a per-call charge. "Extra calls are $18 each" is not a number this product has.
 *   - There is no mutation a coach can call to change a plan. `/api/billing/corrections` accepts
 *     `request_correction`, `record_attendance` and `skip_attendance`, and nothing else; the admin
 *     platform route has no `set_tenant_tier` action either. A button that moved a plan would post
 *     to a route that does not exist.
 *   - A scheduled move is not reversible. `allowance_actions` is append-only behind
 *     `app.allowance_action_completion_guard()`, which permits only `scheduled -> completed` and
 *     `scheduled -> failed`; `cancelled` is not in the state check and no code calls Stripe to
 *     release a schedule. Promising a coach they can back out is the one sentence on this page that
 *     would be a straightforward lie.
 *
 * What IS true, and what this renders: a scheduled movement carries a tier name, a price and an
 * `effective_at`, which `allowances.ts` sets to the current period end and Stripe honours with a
 * two-phase schedule at `proration_behavior: "none"`. So the date, the new price, the fact that
 * nothing is charged today and the fact that this period's booked calls stay where they are can all
 * be stated as facts. The new allowance cannot -- the projection returns the pending tier's name and
 * price and not its `call_allowance` -- so the panel says so out loud rather than leaving a coach to
 * assume a number, which is the same rule the provisioning screens follow about the carrier clock.
 */
function PlanCard({
  invoice,
  snapshot,
  subscription,
  timezoneLabel,
}: {
  invoice: StateCopy;
  snapshot: CoachBillingSnapshot;
  subscription: StateCopy;
  timezoneLabel: string | null;
}) {
  const movement = snapshot.pendingMovement;
  /*
   * The date is only described as the period boundary when it actually is one. Every movement this
   * projection can return is a `crossing` action stamped with the period end, so the two agree
   * today -- but "the day your month resets" is a claim about the billing calendar, and it should
   * come from comparing the two timestamps rather than from a comment asserting they match.
   */
  const resetsThisPeriod = movement !== null
    && Date.parse(movement.effectiveAt) === Date.parse(snapshot.periodEnd);
  const noticeCount = snapshot.notices.length;
  const sentCount = snapshot.notices.filter(
    (notice) => noticeDeliveryLabel(notice) === "Sent"
  ).length;
  const noticesLine = noticeCount === 0
    ? "No allowance notices were sent to your billing contact this period."
    : sentCount === noticeCount
      ? `${workspaceCountFormat.format(noticeCount)} allowance ${noticeCount === 1 ? "notice" : "notices"} reached your billing contact this period.`
      : `${workspaceCountFormat.format(sentCount)} of ${workspaceCountFormat.format(noticeCount)} allowance notices reached your billing contact this period. The rest are still queued.`;

  return (
    /*
      Title-led, not banded, and the canvas is unambiguous about which: `Billing.dc.html:98` opens
      this card with a 22px/600 "Your plan" as its first line, at `padding: 28px 30px`, with no
      eyebrow and no band above it. The eyebrow leaves with the band -- it is a part of the band,
      not a part of the card -- which costs this page one of the two scan words the note where
      `BillingCard` used to stand argues for. That trade is the canvas's, and it is only taken on the two cards the canvas
      actually draws this way; the account-state card keeps its band and its overline.
    */
    <TitlePanel
      className="col-span-full"
      sentence={`${snapshot.tierName}, ${workspaceCountFormat.format(snapshot.callAllowance)} booked calls a month. Nothing else about your agent changes.`}
      title="Your plan"
    >
      <div className="flex flex-wrap gap-[12px]">
        <FigureWell
          figure={money(snapshot.priceCents, snapshot.currency)}
          label="Charged each month"
          note={`${snapshot.tierName} plan`}
        />
        {/*
          The meter is the canvas's one addition to this well, and it is only drawn where a real
          allowance exists to divide by: an allowance of zero would make the share undefined, and a
          full bar over "0 of 0" would claim the coach was at their limit. The words stay the
          reading; the bar is `aria-hidden` decoration over them.
        */}
        <FigureWell
          figure={`${workspaceCountFormat.format(snapshot.bookedCount)} of ${workspaceCountFormat.format(snapshot.callAllowance)}`}
          label="Booked-call allowance"
          meter={
            snapshot.callAllowance > 0
              ? snapshot.bookedCount / snapshot.callAllowance
              : undefined
          }
          note={
            <>
              Non-test booked calls this billing period. Your month resets on{" "}
              <span className={INLINE_MONO_CLASS}>{formatDate(snapshot.periodEnd)}</span>
              {timezoneLabel ? ` (${timezoneLabel})` : ""}.
            </>
          }
        />
      </div>

      {/*
        One treatment for the pair. Both are pills because this card has room for them and there
        are two, not a column; a table of these would take the bare dot instead. The canvas draws
        no rate for calls past the allowance, and none exists on the record -- `tiers` carries a
        price and an allowance and no overage rate -- so the reset sentence above ends where the
        facts do.
      */}
      <div className={`flex flex-wrap items-center gap-[var(--s-2)] ${HAIRLINE_TOP_CLASS}`}>
        <Status label={subscription.label} tone={STATE_TONE_TO_TONE[subscription.tone]} />
        <Status label={`Invoice: ${invoice.label}`} tone={STATE_TONE_TO_TONE[invoice.tone]} />
      </div>

      {movement ? (
        <div className={HAIRLINE_TOP_CLASS}>
          {/*
            The 22px/600 title-led role, not the banded name's 20px. This heading has never had a
            band over it, and `CoachPlanChange.dc.html:182` draws the same block -- the plain-words
            consequence list -- with a 22px/600 line at its head. The class comes from `deck-panel`
            so the size cannot drift away from the shape it belongs to.
          */}
          <h3 className={`${TITLE_PANEL_TITLE_CLASS} text-[color:var(--ink)]`}>
            What happens on {formatDate(movement.effectiveAt)}
          </h3>
          <Prose className={`${PANEL_SUB_CLASS} mt-[6px]`}>
            Read this before the date. Nothing on this page charges your card today.
          </Prose>
          {/*
            A numbered list because these are consequences in time order, not a set of features, and
            a coach who is about to be charged more reads them as a sequence: what changes, when, and
            what happens to what they have already used.
          */}
          <ol className="m-0 mt-[var(--s-4)] flex list-none flex-col gap-[var(--s-4)] p-0">
            <li className={`text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]`}>
              <span className="mr-[var(--s-2)] font-[family-name:var(--font-mono)] text-[color:var(--faint)]">1</span>
              Your plan becomes {movement.tierName} at{" "}
              <span className={INLINE_MONO_CLASS}>
                {money(movement.priceCents, snapshot.currency)}
              </span>{" "}
              a month, starting {formatDate(movement.effectiveAt)}
              {resetsThisPeriod ? ", the day this billing period ends" : ""}. Nothing is charged today.
            </li>
            <li className={`text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]`}>
              <span className="mr-[var(--s-2)] font-[family-name:var(--font-mono)] text-[color:var(--faint)]">2</span>
              The{" "}
              <span className={INLINE_MONO_CLASS}>
                {workspaceCountFormat.format(snapshot.bookedCount)}
              </span>{" "}
              calls already booked in this period stay on {snapshot.tierName} and stay counted. They
              do not carry over.
            </li>
            <li className={`text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]`}>
              <span className="mr-[var(--s-2)] font-[family-name:var(--font-mono)] text-[color:var(--faint)]">3</span>
              Your agent, your own prices and your calendar are untouched. Only the monthly charge
              and the booked-call allowance move.
            </li>
          </ol>
          {/*
            The gap, named. The projection carries the pending tier's name and price and not its
            allowance, so this page genuinely cannot say what the new number of booked calls will be
            -- and a plausible guess on a billing page is how a billing dispute starts. Saying which
            fact is missing, and who can answer it, is the honest form of the same sentence.
          */}
          <Prose className={`${PANEL_SUB_CLASS} mt-[var(--s-4)]`}>
            Your saved billing record does not carry the new plan&rsquo;s booked-call allowance, so
            this page does not state one. Ask us and we will confirm it in writing before the date.
          </Prose>
          <p className={`mt-[var(--s-4)] flex items-center gap-[var(--s-2)] border-t border-[var(--line-soft)] pt-[var(--s-3)] text-[15px] leading-[1.5] text-[color:var(--muted)]`}>
            <ShieldCheck aria-hidden className="size-[var(--s-3)]" />
            Scheduled by SetterFi, not from this page. Logged.
          </p>
        </div>
      ) : (
        <div className={HAIRLINE_TOP_CLASS}>
          <span className={`${EYEBROW_CLASS} mb-[8px]`}>Nothing scheduled</span>
          <Prose className={`${PANEL_SUB_CLASS} text-[color:var(--body)]`}>
            No plan change is scheduled. A plan change is arranged with SetterFi rather than started
            from this page, and it always takes effect at the start of a billing period, so nothing
            you do here can change what you are charged for the period you are in.
          </Prose>
        </div>
      )}

      {/*
        The notices card, folded to its one sentence. Four rows of "Allowance warning -- Sent" were
        a card's worth of chrome around a fact that is a count and a delivery state, and the count
        is what a coach reads: whether we told them before the allowance moved. The unsent half is
        named separately because "queued" is not "sent" and a single total would round it away.
      */}
      <p className={`${PANEL_SUB_CLASS} ${HAIRLINE_TOP_CLASS}`} data-slot="billing-notices-line">
        {noticesLine}
      </p>

      {/*
        One action, and it is a question rather than a mutation, because there is no coach-reachable
        route that moves a plan (see this component's note above). The canvas's second button,
        "Update your card", is not drawn: the billing snapshot carries no saved-card record at all,
        so a control promising to update one would open onto nothing. Logged in `docs/GAPS.md`.
      */}
      <div className={`flex flex-wrap items-center gap-[12px] ${HAIRLINE_TOP_CLASS}`}>
        <a className={COACH_ACTION_CLASS} href="/coach/help">
          Ask us to change your plan
        </a>
      </div>
    </TitlePanel>
  );
}

function DisabledBilling() {
  return (
    <div className="min-w-0">
      <CoachPageHead
        sub="What you pay, what you have used, and how the calls went."
        surface="billing"
        title="Billing"
      />
      <div className="mt-[var(--s-5)]" />
      <DataState
        body="Turn on billing when this workspace is ready to use subscription records."
        kind="empty"
        title="Billing is not enabled"
      />
    </div>
  );
}

/**
 * The skeleton draws the proportions the loaded page arrives in: two cards side by side, titles
 * already legible, only the figure wells and the rows pulsing. A generic pair of grey slabs
 * would move the page under the reader the moment the fetch lands.
 */
function BillingLoading() {
  return (
    <div
      aria-busy="true"
      className="grid min-w-0 grid-cols-1 items-start gap-[20px] md:grid-cols-2"
      role="status"
    >
      <span className="sr-only">
        Billing details are temporarily unavailable while saved records load.
      </span>
      {[
        { eyebrow: "Charge", title: "Your plan" },
        { eyebrow: "Period", title: "Billing period" },
      ].map((card) => (
        <DeckPanel className={CARD_CLASS} eyebrow={card.eyebrow} key={card.title} name={card.title}>
          {/* The wells pulse at the height the loaded figure arrives at, so the panel does not
              grow under the reader the moment the fetch lands. 30px figure, `--coach-eyebrow`
              label -- the third comment in this file to name that size, and the reason none of
              them spells it out any more is that two of the three had gone stale at 12px. */}
          <div aria-hidden className="flex flex-wrap gap-[10px]">
            {["left", "right"].map((side) => (
              <div className={`flex-1 basis-[min(100%,220px)] ${COACH_WELL_CLASS}`} key={side}>
                <Skeleton aria-hidden className="h-[12px] w-2/5" />
                <Skeleton aria-hidden className="mt-[12px] h-[33px] w-3/5" />
                <Skeleton aria-hidden className="mt-[12px] h-[12px] w-4/5" />
              </div>
            ))}
          </div>
        </DeckPanel>
      ))}
    </div>
  );
}

/**
 * The account-state frame: the answer to "is anything wrong right now", which is the first
 * question a coach brings to a billing page and so the first thing on it.
 *
 * Both arms are `Surface tone=`, which is the tone frame the kit already owns -- the tone's
 * hairline all the way round plus the corner wash -- rather than the radial and the border
 * re-rolled by hand here at slightly different stops from the eight other screens that frame a
 * card in a status colour. Overdue is amber because a clock is running on the coach; suspended is
 * `failure` rather than the pre-redesign `--critical` red, per the ruling in
 * `.planning/design/LEDGER.md` that splits `critical` three ways and sends a *state* to `failure`.
 *
 * They are mutually exclusive because `accountState` is a single value, so the page never stacks
 * two of them.
 */
function AccountStateCard({ accountState }: { accountState: CoachBillingSnapshot["accountState"] }) {
  if (accountState === "overdue") {
    return (
      <Surface aria-label="Account state" as="section" className="col-span-full" role="status" tone="warning">
        <div className="mb-[5px] flex flex-wrap items-center gap-[9px]">
          {/*
            The attention dot, and the one halo this page paints. `docs/DESIGN.md:377` reads "One
            glow on the page, and it belongs to the attention dot" -- per page, so an overdue
            account is entitled to its own. It asks the atomic for the halo rather than painting a
            box-shadow beside it, because a hand-rolled glow is invisible to the budget guard, and
            a rule only enforced against the callers who declare themselves is not enforced.
          */}
          <StatusDot glow tone="warning" />
          <h2 className={CARD_TITLE_CLASS}>Payment is overdue.</h2>
          <span className="shrink-0 rounded-[8px] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[10px] py-[4px] text-[length:var(--coach-eyebrow)] leading-[1.4] whitespace-nowrap text-[color:var(--warning-text)]">
            Under review
          </span>
        </div>
        <Prose className="text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--warning-body)]">
          Your agent remains available while the billing record is reviewed.
        </Prose>
      </Surface>
    );
  }

  if (accountState === "suspended") {
    return (
      <Surface aria-label="Account state" as="section" className="col-span-full" role="status" tone="failure">
        {/*
          Not approved copy yet, and the page says so rather than presenting draft wording as
          final. Recorded at `.planning/phases/11-ui-rebuild/PLAN.md:3939` and pinned by two
          guards; the fix is Alec approving the wording, not deleting the marker.
        */}
        <Status label="Draft copy" tone="draft" />
        <h2 className={cn(CARD_TITLE_CLASS, "mt-[9px]")} style={{ color: TONE_TEXT.failure }}>
          This account is suspended
        </h2>
        <Prose className="mt-[6px] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--body)]">
          Contact support to review the billing record and next steps.
        </Prose>
      </Surface>
    );
  }

  return null;
}

function CheckoutCard({
  checkout,
  checkoutError,
  checkoutPending,
  checkoutReturn,
  onCheckout,
  onRefresh,
}: {
  checkout: BillingCheckoutBrowserState | null;
  checkoutError: string | null;
  checkoutPending: boolean;
  checkoutReturn: "returned" | "canceled" | null;
  onCheckout(retryAfterCancel: boolean): Promise<void>;
  onRefresh(): void;
}) {
  const offer = checkout?.offer ?? null;
  const canceled = checkoutReturn === "canceled" && checkout?.state === "pending";
  const returned = checkoutReturn === "returned" && checkout?.state === "pending";
  const interval = offer?.interval === "day" ? "day"
    : offer?.interval === "week" ? "week"
      : offer?.interval === "year" ? "year" : "month";
  const checking = checkout === null && checkoutError === null;
  const stateLabel = checking
    ? "Checking checkout availability"
    : checkout?.state === "active"
    ? "Subscription active"
    : checkout?.state === "confirming"
      ? "Payment confirmed; activating"
      : returned
        ? "Waiting for Stripe confirmation"
        : canceled
          ? "Checkout canceled in this browser"
          : checkout?.state === "pending"
            ? "Checkout started; payment not confirmed"
            : checkout?.state === "expired"
              ? "Checkout expired"
              : checkout?.state === "offered"
                ? "Ready for secure checkout"
                : "Checkout unavailable";
  const tone = checkout?.state === "active" ? "good"
    : checkout?.state === "confirming" || returned ? "waiting"
      : canceled || checkout?.state === "expired" ? "warning"
        : checking ? "waiting" : "neutral";

  return (
    <Surface aria-labelledby="checkout-title" as="section" className="mb-[12px]">
      <div className="flex flex-wrap items-start justify-between gap-[var(--s-4)]">
        <div className="min-w-0 flex-1 basis-[min(100%,30rem)]">
          <span className={`${EYEBROW_CLASS} mb-[6px]`}>Subscription</span>
          <h2 className={CARD_TITLE_CLASS} id="checkout-title">Activate your plan</h2>
          <Prose className={`${PANEL_SUB_CLASS} mt-[6px]`}>
            Stripe collects payment on its secure checkout. SetterFi waits for Stripe and the saved subscription record before it marks this plan active.
          </Prose>
        </div>
        <Status label={stateLabel} tone={tone} />
      </div>

      {offer ? (
        <div className={`mt-[var(--s-4)] flex flex-wrap items-end justify-between gap-[var(--s-4)] ${COACH_WELL_CLASS}`}>
          <div>
            <span className={`${EYEBROW_CLASS} mb-[8px]`}>Selected at signup</span>
            <p className="m-0 text-[18px] leading-[1.35] font-medium text-[color:var(--ink)]">{offer.label}</p>
            <p className={`m-0 mt-[8px] ${WELL_FIGURE_CLASS}`}>
              {money(offer.amountCents, offer.currency)} / {interval}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-[var(--s-2)]">
            {checkout?.state === "offered" || checkout?.state === "expired" ? (
              <LoggedButton
                actionKey="billing.checkout.created"
                disabled={checkoutPending}
                onClick={() => onCheckout(false)}
                scale="coach"
                variant="primary"
              >
                {checkoutPending ? "Opening secure checkout" : checkout.state === "expired" ? "Start new checkout" : "Continue to checkout"}
              </LoggedButton>
            ) : null}
            {canceled ? (
              <LoggedButton
                actionKey="billing.checkout.created"
                disabled={checkoutPending}
                onClick={() => onCheckout(true)}
                scale="coach"
                variant="primary"
              >
                {checkoutPending ? "Opening secure checkout" : "Try checkout again"}
              </LoggedButton>
            ) : null}
            {checkout?.state === "pending" && !canceled && !returned ? (
              <LoggedButton
                actionKey="billing.checkout.created"
                disabled={checkoutPending}
                onClick={() => onCheckout(false)}
                scale="coach"
              >
                {checkoutPending ? "Opening secure checkout" : "Return to checkout"}
              </LoggedButton>
            ) : null}
            {returned || checkout?.state === "confirming" || checkout?.state === "active" ? (
              <KitButton disabled={checkoutPending} onClick={onRefresh}>
                Refresh status
              </KitButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {checkoutError ? (
        <p className={`m-0 mt-[var(--s-3)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--failure-text)]`} role="alert">
          {checkoutError}
        </p>
      ) : null}
      {checkout?.state === "unavailable" ? (
        <p className={`${PANEL_SUB_CLASS} mt-[var(--s-3)]`}>
          The current plan or commercial terms could not be verified, so no payment session was created.
        </p>
      ) : null}
      {returned ? (
        <p className={`${PANEL_SUB_CLASS} mt-[var(--s-3)] text-[color:var(--body)]`} role="status">
          Returning from Stripe does not prove payment. This page will show the plan as active only after the saved subscription read-back arrives.
        </p>
      ) : null}
    </Surface>
  );
}

export function CoachBilling({
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
  const [correctionEventId, setCorrectionEventId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionPending, setCorrectionPending] = useState(false);
  /*
   * The form is shut until a coach says a number looks wrong. `Billing.dc.html` draws this strip as
   * one sentence and one button, and that is the honest weight: a record picker and a reason box
   * standing open at the foot of every billing page invite a dispute nobody came to file.
   */
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [pendingAppointmentId, setPendingAppointmentId] = useState<string | null>(null);
  const [checkout, setCheckout] = useState<BillingCheckoutBrowserState | null>(null);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [checkoutLoadAttempt, setCheckoutLoadAttempt] = useState(0);

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
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("BILLING_CHECKOUT_STATE_REFUSED");
        setCheckout(parseBillingCheckoutState(payload));
        setCheckoutError(null);
      } catch {
        if (!controller.signal.aborted) {
          setCheckout(null);
          setCheckoutError("Checkout status could not be verified. No payment session was created.");
        }
      }
    })();
    return () => controller.abort();
  }, [enabled, checkoutLoadAttempt]);

  if (!enabled) return <DisabledBilling />;

  function retryLoad() {
    setLoading(true);
    setLoadError(false);
    setLoadAttempt((attempt) => attempt + 1);
  }

  function refreshCheckout() {
    setCheckoutPending(false);
    setCheckoutLoadAttempt((attempt) => attempt + 1);
    setLoadAttempt((attempt) => attempt + 1);
  }

  async function startCheckout(retryAfterCancel: boolean) {
    if (!checkout?.offer || checkoutPending) return;
    setCheckoutPending(true);
    setCheckoutError(null);
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
      const hostedUrl = isRecord(payload) ? validatedStripeCheckoutUrl(payload.url) : null;
      if (!response.ok || !hostedUrl) throw new Error("BILLING_CHECKOUT_URL_REFUSED");
      window.location.assign(hostedUrl);
    } catch {
      setCheckoutError("Secure checkout could not be opened. Nothing was charged; try again.");
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

  async function requestCorrection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!correctionEventId || !correctionReason.trim()) return;
    setCorrectionPending(true);
    setActionError(null);
    setActionReceipt(null);
    try {
      const payload = await post({
        action: "request_correction",
        eventId: correctionEventId,
        quantityDelta: -1,
        reason: correctionReason,
      });
      const result = isRecord(payload.result) ? payload.result : null;
      if (
        result?.state !== "requested"
        || typeof result.requestId !== "string"
        || typeof result.requestAuditId !== "number"
      ) throw new Error("BILLING_CORRECTION_RECEIPT_INVALID");
      setCorrectionEventId("");
      setCorrectionReason("");
      setActionReceipt(AUDIT_ACTIONS["billing.correction.requested"].microcopy);
    } catch {
      setActionError("The correction request was refused. Nothing changed.");
    } finally {
      setCorrectionPending(false);
    }
  }

  async function recordOutcome(
    appointmentId: string,
    status: "completed" | "no_show",
  ) {
    setPendingAppointmentId(appointmentId);
    setActionError(null);
    setActionReceipt(null);
    try {
      const payload = await post({ action: "record_attendance", appointmentId, status });
      const result = isRecord(payload.result) ? payload.result : null;
      if (typeof result?.auditId !== "number" || typeof result.billableQuantity !== "number") {
        throw new Error("ATTENDANCE_RECEIPT_INVALID");
      }
      setSnapshot((current) => current ? resolveOutcomePrompt(current, appointmentId) : current);
      setActionReceipt(AUDIT_ACTIONS["appointment.attendance_set"].microcopy);
    } catch {
      setActionError("The attendance update was refused. Nothing changed.");
    } finally {
      setPendingAppointmentId(null);
    }
  }

  async function skipOutcome(appointmentId: string) {
    if (!snapshot) return;
    const previous = snapshot;
    setPendingAppointmentId(appointmentId);
    setActionError(null);
    setActionReceipt(null);
    setSnapshot(resolveOutcomePrompt(snapshot, appointmentId));
    try {
      const payload = await post({
        action: "skip_attendance",
        appointmentId,
        idempotencyKey: `skip-attendance:${appointmentId}`,
      });
      const appointment = isRecord(payload.appointment) ? payload.appointment : null;
      if (
        appointment?.id !== appointmentId
        || appointment.attendanceState !== "skipped"
      ) throw new Error("ATTENDANCE_SKIP_RECEIPT_INVALID");
      setActionReceipt(AUDIT_ACTIONS["appointment.attendance_set"].microcopy);
    } catch {
      setSnapshot(previous);
      setActionError("The skip was refused. The appointment is still waiting for an outcome.");
    } finally {
      setPendingAppointmentId(null);
    }
  }

  const subscription = snapshot
    ? stateCopy(snapshot.subscriptionState, BILLING_SUBSCRIPTION_STATE_COPY)
    : null;
  const invoice = snapshot ? stateCopy(snapshot.invoiceState, BILLING_INVOICE_STATE_COPY) : null;
  const timezoneLabel = snapshot ? timezoneDisplayLabel(snapshot.timezone) : null;

  return (
    <div className="min-w-0">
      <CoachPageHead
        provenance={snapshot ? (snapshot.isDemo ? "demo" : "real") : undefined}
        sub="What you pay, what you have used, and how the calls went."
        surface="billing"
        title="Billing"
      />
      <div className="mt-[var(--s-6)]" />

      <CheckoutCard
        checkout={checkout}
        checkoutError={checkoutError}
        checkoutPending={checkoutPending}
        checkoutReturn={checkoutReturn}
        onCheckout={startCheckout}
        onRefresh={refreshCheckout}
      />

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

      {snapshot && subscription && invoice ? (
        <div className="grid min-w-0 grid-cols-1 items-start gap-[20px] md:grid-cols-2">
          <AccountStateCard accountState={snapshot.accountState} />

          <PlanCard
            invoice={invoice}
            snapshot={snapshot}
            subscription={subscription}
            timezoneLabel={timezoneLabel}
          />

          {/*
            The canvas titles this "Did they show up?" and calls it the only thing we cannot see
            from our side, which is exactly right and is the sentence that makes a coach answer it
            -- so it is now the sentence that ships (`Billing.dc.html:152`). This comment made that
            argument for three audit rounds while the card rendered "Self-reported outcomes help
            your analytics and do not change your billed count." Both sentences are true; only one
            of them gets a busy coach to tap. The old one described the data model to somebody who
            does not have one, and a card whose whole purpose is to collect the answer we cannot
            observe should say why only they can give it.

            What the old sentence did carry, and is not lost: it promised that answering changes
            nothing about the bill. That belongs with the thing it reassures about rather than in
            the card's one line, so it is stated at the outcome buttons' own receipt instead.

            The three verbs stay three: Skip is a real recorded outcome with its own audit receipt,
            and dropping it to match a two-button mockup would leave a coach with no way to clear a
            prompt they cannot answer.
          */}
          {/*
            Title-led with a rule under the head, which is what `Billing.dc.html:151` draws and is
            the same shape as "Your plan" rather than a third one. The anatomy above the hairline is
            title-led exactly -- no eyebrow, no 78px floor, a 22px/600 title with its sentence under
            it at `24px 30px`. The hairline is there because what follows is a list of rows that
            has to be separated from the head, which is the `divided` case; the rows then carry the
            card's horizontal padding themselves, at the artboard's `22px 30px`.
          */}
          <TitlePanel
            className="col-span-full"
            divided
            sentence="Two taps each. It is the only thing we cannot see from our side."
            title="Did they show up?"
          >
            {pendingAppointmentId ? (
              <div className="px-[30px] pt-[18px]">
                <Status label="Saving attendance choice" tone="waiting" />
              </div>
            ) : actionReceipt === AUDIT_ACTIONS["appointment.attendance_set"].microcopy ? (
              <div className="px-[30px] pt-[18px]">
                <Status label={actionReceipt} tone="good" />
              </div>
            ) : null}

            {snapshot.outcomePrompts.length ? (
              <ul className="m-0 list-none p-0">
                {snapshot.outcomePrompts.map((prompt) => (
                  <li
                    className="flex flex-wrap items-center justify-between gap-[16px] border-b border-[var(--line-soft)] px-[30px] py-[22px] last:border-b-0"
                    key={prompt.appointmentId}
                  >
                    <div className="min-w-0 flex-1 basis-[min(100%,20ch)]">
                      <p className={`m-0 ${ROW_TITLE_CLASS}`}>{prompt.label}</p>
                      <span className={`${ROW_META_CLASS} font-[family-name:var(--font-mono)]`}>
                        {formatDate(prompt.occurredAt)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-[12px]">
                      <LoggedButton
                        actionKey="appointment.attendance_set"
                        scale="coach-verb"
                        disabled={pendingAppointmentId !== null}
                        onClick={() => void recordOutcome(prompt.appointmentId, "completed")}
                        type="button"
                      >
                        Showed
                      </LoggedButton>
                      <LoggedButton
                        actionKey="appointment.attendance_set"
                        scale="coach-verb"
                        disabled={pendingAppointmentId !== null}
                        onClick={() => void recordOutcome(prompt.appointmentId, "no_show")}
                        type="button"
                      >
                        No show
                      </LoggedButton>
                      <LoggedButton
                        actionKey="appointment.attendance_set"
                        scale="coach-verb"
                        disabled={pendingAppointmentId !== null}
                        onClick={() => void skipOutcome(prompt.appointmentId)}
                        type="button"
                        variant="ghost"
                      >
                        Skip
                      </LoggedButton>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`${PANEL_SUB_CLASS} px-[30px] py-[22px]`}>
                No past appointments are waiting for an outcome.
              </p>
            )}
            {/*
              The half of the old sentence worth keeping, moved to where it answers something.
              "This does not change your bill" is a reassurance about pressing the buttons, so it
              belongs under them rather than in the card's one line, where it was spending the
              coach's attention on the data model instead of on the question. Only drawn when there
              is something to answer -- an empty card has nothing to reassure anybody about.
            */}
            {snapshot.outcomePrompts.length ? (
              <p className={`${PANEL_SUB_CLASS} px-[30px] pb-[22px] text-[15px]`}>
                Your answers feed your own analytics. They do not change what you are billed.
              </p>
            ) : null}
          </TitlePanel>

          {/*
            The page's single accent fill lives on this form's submit, because requesting a
            correction is the only thing a coach can actually change from this screen. Every other
            control here reports an outcome or reads a record, so they all stay secondary.
          */}
          {/*
            The quiet frame, not a deck panel, and the difference is the point.
            
            The canvas draws this as a low-contrast strip at the foot of the page rather than as a
            sixth card, because a correction request is the rare case: a coach reaches it only when
            a number above it already looks wrong, and giving it a full card face would make every
            reader weigh it against the records it is questioning. The heading names the count it
            is questioning, read from the same `bookedCount` the allowance well prints, so the two
            can never disagree about which number the coach is disputing.
          */}
          <section
            aria-labelledby="correction-title"
            /* `22px 28px`, which is `Billing.dc.html:176` exactly. The horizontal, the
               `22px 22px 17px 17px` radius, the 20px gap and the 24px glyph were all already the
               artboard's; the vertical was 24px, the one value in the strip that had drifted. */
            className="col-span-full min-w-0 rounded-[22px_22px_17px_17px] border border-[var(--line)] bg-[var(--well)] px-[28px] py-[22px]"
          >
            <div className="flex flex-wrap items-center gap-[20px]">
              <Info aria-hidden className="size-[24px] shrink-0 text-[color:var(--faint)]" />
              <div className="min-w-0 flex-1 basis-[min(100%,28ch)]">
                {/*
                  The row-name role at 18px/500, not a panel name at 20px. `Billing.dc.html:178`
                  draws this strip's heading at exactly the size of the two attendee names three
                  cards above it (`:156`, `:166`) -- which is the reading: the strip is a row, not a
                  sixth card, and it has never had a band or a card face to make it one.
                */}
                <h2 className={`m-0 ${ROW_TITLE_CLASS}`} id="correction-title">
                  Does the booked-call count of{" "}
                  <span className={INLINE_MONO_CLASS}>
                    {workspaceCountFormat.format(snapshot.bookedCount)}
                  </span>{" "}
                  look wrong?
                </h2>
                <Prose className={`${PANEL_SUB_CLASS} mt-[4px]`}>
                  Tell us what needs review and a person checks it against the conversations. The
                  saved count does not change until the request is decided.
                </Prose>
              </div>
              <button
                aria-expanded={correctionOpen}
                className={`${COACH_ACTION_CLASS} shrink-0 cursor-pointer`}
                data-slot="correction-open"
                onClick={() => setCorrectionOpen((open) => !open)}
                type="button"
              >
                {correctionOpen ? "Never mind" : "This looks wrong"}
              </button>
            </div>
            {correctionOpen ? (
            <form className="mt-[var(--s-5)] grid max-w-[var(--measure-prose)] gap-[var(--s-4)]" onSubmit={requestCorrection}>
              <div className="flex min-w-0 flex-col gap-[var(--distance-small)]">
                <Label
                  className="text-[length:var(--coach-body)] leading-[1.5] font-medium text-[var(--ink)]"
                  htmlFor="billing-correction-event"
                >
                  Booked-call record
                  <span aria-hidden style={{ color: TONE_TEXT.failure }}>*</span>
                </Label>
                <Select
                  disabled={!snapshot.correctionCandidates.length}
                  onValueChange={(value) => setCorrectionEventId(value ?? "")}
                  value={correctionEventId || null}
                >
                  <SelectTrigger className="w-full" id="billing-correction-event">
                    <SelectValue placeholder="Select a record" />
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    {snapshot.correctionCandidates.map((candidate) => (
                      <SelectItem key={candidate.eventId} value={candidate.eventId}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Field
                hint="Describe why this booked call should be reviewed."
                label="Reason"
                required
              >
                <Textarea
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  required
                  value={correctionReason}
                />
              </Field>
              <div className="flex flex-wrap items-center gap-[var(--s-3)]">
                <LoggedButton
                  actionKey="billing.correction.requested"
                  disabled={correctionPending || !correctionEventId || !correctionReason.trim()}
                  scale="coach"
                  type="submit"
                  variant="primary"
                >
                  {correctionPending ? "Requesting" : "Request correction"}
                </LoggedButton>
                {correctionPending ? (
                  <Status label="Request in flight" tone="waiting" />
                ) : actionReceipt === AUDIT_ACTIONS["billing.correction.requested"].microcopy ? (
                  <Status label={actionReceipt} tone="good" />
                ) : null}
              </div>
            </form>
            ) : null}
          </section>

          {/*
            Inline error text, which the LEDGER's three-way split of `critical` keeps off `Status`
            deliberately: an error is a thing that just happened to a request, not a state the
            account is in. It takes the failure text token on the failure-framed surface and says
            in words that nothing changed.
          */}
          {actionError ? (
            <Surface
              as="p"
              className="col-span-full m-0 text-[length:var(--coach-body)] leading-[1.5]"
              role="alert"
              style={{ color: TONE_TEXT.failure }}
              tone="failure"
            >
              {actionError}
            </Surface>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
