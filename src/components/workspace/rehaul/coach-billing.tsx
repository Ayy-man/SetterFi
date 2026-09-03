"use client";

/*
 * Coach Billing, drawn from `CoachBilling.body.html`.
 *
 * Data, loaders and mutations are the live page's unchanged: the same `/api/billing/corrections`
 * read, the same `record_attendance` / `skip_attendance` / `request_correction` posts, the same
 * `/api/billing/checkout` state machine, the same parsers and receipts. Nothing here queries
 * anything the old page did not.
 *
 * Where the artboard asks for a fact the record does not carry, the panel says less rather than
 * inventing it:
 *   - "card ending 4242" and an Invoices button. The billing snapshot carries no saved-card and
 *     no invoice document, and there is no coach-reachable route for either, so both header
 *     buttons are omitted. The one real action on this screen -- asking us to move the plan --
 *     takes their place.
 *   - "Last six months". The projection carries one period: `bookedCount` against
 *     `callAllowance` for the period bounded by `periodStart`/`periodEnd`. The chart therefore
 *     draws the one bar it has, labelled with that period's month, rather than five invented ones.
 */

import { useEffect, useState, type FormEvent } from "react";

import {
  STATE_TONE_TO_TONE,
  Status,
  StatusDot,
  Surface,
  TONE_TEXT,
} from "@/components/kit/atomics";
import type { BillingCheckoutBrowserState } from "@/app/api/billing/checkout/handler";
import { BarChart } from "@/components/kit/bar-chart";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { LoggedButton } from "@/components/kit/logged-button";
import { Meter } from "@/components/kit/meter";
import { Skeleton } from "@/components/kit/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Figure } from "@/components/workspace/rehaul/_primitives";
import {
  parseBillingCheckoutState,
  parseCoachBillingSnapshot,
  resolveOutcomePrompt,
  type CoachBillingSnapshot,
} from "@/components/workspace/live/coach-billing";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { FAILURE_BODY } from "@/lib/copy/failure";
import {
  BILLING_INVOICE_STATE_COPY,
  BILLING_SUBSCRIPTION_STATE_COPY,
  type StateCopy,
} from "@/lib/copy/states";
import { workspaceCountFormat, workspaceDateFormat } from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";

/* The sentences this screen used to print as help text, handed to the eye instead. */
export const COACH_BILLING_EYE_COPY =
  "What you pay, what you have used, and how the calls went. Answering the attendance question "
  + "feeds your own analytics; it does not change what you are billed. A correction request is "
  + "read by a person against the conversations, and the saved count does not move until it is "
  + "decided. Plan changes are arranged with SetterFi and always take effect at the start of a "
  + "billing period. Coming back from Stripe does not prove a payment: the plan stays unconfirmed "
  + "here until Stripe confirms the charge to us.";

/* The shell's own coach title: 46px/600, and the 30px step-down under 640px comes with it. */
const H1_CLASS = "coach-page-title m-0";
const TABULAR_CLASS = "[font-variant-numeric:tabular-nums_lining-nums]";
const MONO_META_CLASS =
  "font-[family-name:var(--font-mono)] text-[14px] leading-[1.4] text-[color:var(--muted)] "
  + "[font-variant-numeric:tabular-nums_lining-nums]";
const SENT_CLASS =
  "m-0 mt-[10px] max-w-[34ch] text-[16px] leading-[1.5] text-[color:var(--muted)]";
const ROW_NAME_CLASS = "m-0 text-[18px] leading-[1.35] font-medium text-[color:var(--ink)]";
const ACTION_CLASS =
  "inline-flex h-[46px] items-center gap-[8px] rounded-[12px] border border-[var(--line-input)] "
  + "bg-[var(--card)] px-[20px] text-[16px] leading-[1.4] font-medium text-[color:var(--body)] "
  + "no-underline hover:border-[var(--accent-edge)] hover:text-[color:var(--ink)]";
const FIELD_CLASS =
  "h-[48px] w-full rounded-[10px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] "
  + "text-[16px] leading-[1.4] text-[color:var(--ink)] placeholder:text-[color:var(--muted)]";

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short" });

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stateCopy(value: string, copy: Readonly<Record<string, StateCopy>>): StateCopy {
  return copy[value] ?? { label: "State recorded", tone: "neutral" };
}

function formatDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Date not recorded" : workspaceDateFormat.format(parsed);
}

function monthLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "Period" : MONTH_FORMAT.format(parsed);
}

function BillingLoading() {
  return (
    <div aria-busy="true" className="grid gap-[20px] md:grid-cols-2" role="status">
      <span className="sr-only">Billing details are loading.</span>
      {["charge", "allowance"].map((slot) => (
        <DeckPanel key={slot} name="Loading">
          <Skeleton aria-hidden className="h-[62px] w-3/5" />
          <Skeleton aria-hidden className="mt-[14px] h-[12px] w-4/5" />
        </DeckPanel>
      ))}
    </div>
  );
}

/**
 * The checkout states, folded into one panel. The live page spreads the same state machine over a
 * banner, a well and three paragraphs; this keeps every state and every control and drops the
 * prose that explained what Stripe is.
 */
function CheckoutPanel({
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
  const label = checking ? "Checking checkout availability"
    : checkout?.state === "confirming" ? "Payment confirmed; activating"
      : returned ? "Waiting for Stripe confirmation"
        : canceled ? "Checkout canceled in this browser"
          : checkout?.state === "pending" ? "Checkout started; payment not confirmed"
            : checkout?.state === "expired" ? "Checkout expired"
              : checkout?.state === "offered" ? "Ready for secure checkout"
                : "Checkout unavailable";
  const tone = checkout?.state === "confirming" || returned || checking ? "waiting"
    : canceled || checkout?.state === "expired" ? "warning" : "neutral";

  return (
    <DeckPanel
      className="col-span-full"
      eyebrow="Subscription"
      meta={<Status label={label} tone={tone} />}
      name="Activate your plan"
    >
      {offer ? (
        <div className="flex flex-wrap items-end justify-between gap-[20px]">
          <div className="min-w-0">
            <p className={`m-0 ${ROW_NAME_CLASS}`}>{offer.label}</p>
            <Figure className={`mt-[8px] ${TABULAR_CLASS}`} size="md">
              {money(offer.amountCents, offer.currency)} / {interval}
            </Figure>
          </div>
          <div className="flex flex-wrap items-center gap-[12px]">
            {checkout?.state === "offered" || checkout?.state === "expired" ? (
              <LoggedButton
                actionKey="billing.checkout.created"
                disabled={checkoutPending}
                onClick={() => onCheckout(false)}
                scale="coach"
                variant="primary"
              >
                {checkoutPending ? "Opening secure checkout"
                  : checkout.state === "expired" ? "Start new checkout" : "Continue to checkout"}
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
            {returned || checkout?.state === "confirming" ? (
              <button
                className={`${ACTION_CLASS} cursor-pointer`}
                disabled={checkoutPending}
                onClick={onRefresh}
                type="button"
              >
                Refresh status
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {checkoutError ? (
        <p
          className="m-0 mt-[12px] text-[16px] leading-[1.5]"
          role="alert"
          style={{ color: TONE_TEXT.failure }}
        >
          {checkoutError}
        </p>
      ) : null}
      {/* Status, not an explainer: why a return is not a payment is in the eye. */}
      {returned ? (
        <p className={SENT_CLASS} role="status">
          Payment not confirmed.
        </p>
      ) : null}
    </DeckPanel>
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
  const [correctionEventId, setCorrectionEventId] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionPending, setCorrectionPending] = useState(false);
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
      const hostedUrl = isRecord(payload) && typeof payload.url === "string" ? payload.url : null;
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
      if (appointment?.id !== appointmentId || appointment.attendanceState !== "skipped") {
        throw new Error("ATTENDANCE_SKIP_RECEIPT_INVALID");
      }
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
  const waiting = snapshot?.outcomePrompts.length ?? 0;

  return (
    <div className="relative min-w-0">
      <div className="flex flex-wrap items-end gap-[24px]">
        <div className="min-w-0">
          <h1 className={H1_CLASS}>Billing</h1>
          {snapshot && subscription ? (
            <div className="mt-[10px] flex flex-wrap items-center gap-[20px] text-[16px] text-[color:var(--body)]">
              <span className="flex items-center gap-[8px]">
                <StatusDot size={6} tone={STATE_TONE_TO_TONE[subscription.tone]} />
                {snapshot.tierName}
                <span aria-hidden className="text-[color:var(--faint)]">·</span>
                {/* The plan's own state in words. The period end is a labelled sentence on the
                    charge panel now, so it is not repeated here as a bare date. */}
                {subscription.label}
              </span>
              {invoice ? (
                <Status
                  label={`Invoice: ${invoice.label}`}
                  tone={STATE_TONE_TO_TONE[invoice.tone]}
                  treatment="bare"
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {/*
          The artboard's Invoices and Update card sit here. Neither has a record or a route behind
          it, so the header carries the one action this screen really has.
        */}
        <div className="ml-auto flex flex-wrap gap-[10px]">
          <a className={ACTION_CLASS} href="/coach/help">Ask us to change your plan</a>
        </div>
      </div>

      <div className="mt-[32px] grid min-w-0 items-start gap-[32px] lg:grid-cols-[minmax(0,1fr)_420px]">
        <div className="flex min-w-0 flex-col gap-[20px]">
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

          {checkout?.state === "active" ? null : (
            <CheckoutPanel
              checkout={checkout}
              checkoutError={checkoutError}
              checkoutPending={checkoutPending}
              checkoutReturn={checkoutReturn}
              onCheckout={startCheckout}
              onRefresh={refreshCheckout}
            />
          )}

          {snapshot ? (
            <>
              <div className="grid min-w-0 gap-[20px] md:grid-cols-2">
                <DeckPanel
                  drench="live"
                  eyebrow="Charged each month"
                  name={`${snapshot.tierName} plan`}
                >
                  <Figure className={TABULAR_CLASS} size="hero">
                    <span data-slot="billing-charge">
                      {money(snapshot.priceCents, snapshot.currency)}
                    </span>
                  </Figure>
                  {/* The artboard's "card ending 4242" is not in the snapshot and has no route
                      behind it, so the sentence carries only the date the record does hold. */}
                  <p className={SENT_CLASS}>Next charge {formatDate(snapshot.periodEnd)}.</p>
                </DeckPanel>

                <DeckPanel eyebrow="Booked calls this period" name="Allowance">
                  <Figure className={TABULAR_CLASS} size="hero">
                    <span data-slot="billing-allowance">
                      {workspaceCountFormat.format(snapshot.bookedCount)}
                      <span className="text-[28px] text-[color:var(--muted)]">
                        /{workspaceCountFormat.format(snapshot.callAllowance)}
                      </span>
                    </span>
                  </Figure>
                  {snapshot.callAllowance > 0 ? (
                    <Meter
                      className="mt-[16px]"
                      value={snapshot.bookedCount / snapshot.callAllowance}
                    />
                  ) : null}
                  <p className={SENT_CLASS}>Resets {formatDate(snapshot.periodEnd)}.</p>
                </DeckPanel>
              </div>

              <DeckPanel
                eyebrow="Two taps each"
                meta={
                  <span className={MONO_META_CLASS}>
                    {workspaceCountFormat.format(waiting)} waiting
                  </span>
                }
                name="Did they show up?"
              >
                {pendingAppointmentId ? (
                  <Status className="mb-[12px]" label="Saving attendance choice" tone="waiting" />
                ) : actionReceipt === AUDIT_ACTIONS["appointment.attendance_set"].microcopy ? (
                  <Status className="mb-[12px]" label={actionReceipt} tone="good" />
                ) : null}
                {waiting ? (
                  <ul className="m-[-20px] list-none p-0">
                    {snapshot.outcomePrompts.map((prompt) => (
                      <li
                        className="flex flex-wrap items-center gap-[16px] border-b border-[var(--line-soft)] px-[20px] py-[16px] last:border-b-0"
                        key={prompt.appointmentId}
                      >
                        <div className="min-w-0 flex-1 basis-[min(100%,18ch)]">
                          <p className={ROW_NAME_CLASS}>{prompt.label}</p>
                          <span className={MONO_META_CLASS}>{formatDate(prompt.occurredAt)}</span>
                        </div>
                        <div className="flex flex-wrap items-center gap-[12px]">
                          <LoggedButton
                            actionKey="appointment.attendance_set"
                            disabled={pendingAppointmentId !== null}
                            onClick={() => void recordOutcome(prompt.appointmentId, "completed")}
                            scale="coach-verb"
                            type="button"
                          >
                            Showed
                          </LoggedButton>
                          <LoggedButton
                            actionKey="appointment.attendance_set"
                            disabled={pendingAppointmentId !== null}
                            onClick={() => void recordOutcome(prompt.appointmentId, "no_show")}
                            scale="coach-verb"
                            type="button"
                          >
                            No show
                          </LoggedButton>
                          <LoggedButton
                            actionKey="appointment.attendance_set"
                            disabled={pendingAppointmentId !== null}
                            onClick={() => void skipOutcome(prompt.appointmentId)}
                            scale="coach-verb"
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
                  <p className={`${SENT_CLASS} mt-0`}>Nothing is waiting for an outcome.</p>
                )}
              </DeckPanel>
            </>
          ) : null}
        </div>

        {snapshot ? (
          <div className="flex min-w-0 flex-col gap-[20px]">
            {/*
              One bar, because one period is what the projection carries. The artboard's five
              earlier months would each be a number this page cannot read.
            */}
            <DeckPanel eyebrow="This billing period" name="Booked calls">
              <BarChart
                height={140}
                label="Booked calls by billing period"
                labels={[monthLabel(snapshot.periodStart)]}
                values={[snapshot.bookedCount]}
                width={360}
              />
            </DeckPanel>

            <DeckPanel eyebrow="If a call is counted wrong" name="This looks wrong">
              <form className="flex flex-col gap-[12px]" onSubmit={requestCorrection}>
                <Select
                  disabled={!snapshot.correctionCandidates.length}
                  onValueChange={(value) => setCorrectionEventId(value ?? "")}
                  value={correctionEventId || null}
                >
                  <SelectTrigger
                    aria-label="Pick the call"
                    className="h-[48px] w-full"
                    id="billing-correction-event"
                  >
                    <SelectValue placeholder="Pick the call" />
                  </SelectTrigger>
                  <SelectContent align="start" alignItemWithTrigger={false}>
                    {snapshot.correctionCandidates.map((candidate) => (
                      <SelectItem key={candidate.eventId} value={candidate.eventId}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  The reason stays, against the artboard, because `/api/billing/corrections`
                  refuses a `request_correction` with an empty `reason`. A picker and a button
                  alone would post a request the route rejects, or make this page invent the
                  sentence a person is going to read.
                */}
                <input
                  aria-label="What looks wrong"
                  className={FIELD_CLASS}
                  onChange={(event) => setCorrectionReason(event.target.value)}
                  placeholder="What looks wrong"
                  required
                  value={correctionReason}
                />
                <LoggedButton
                  actionKey="billing.correction.requested"
                  className="w-full justify-center"
                  disabled={correctionPending || !correctionEventId || !correctionReason.trim()}
                  scale="coach"
                  type="submit"
                  variant="primary"
                >
                  {correctionPending ? "Asking" : "Ask for a review"}
                </LoggedButton>
                {correctionPending ? (
                  <Status label="Request in flight" tone="waiting" />
                ) : actionReceipt === AUDIT_ACTIONS["billing.correction.requested"].microcopy ? (
                  <Status label={actionReceipt} tone="good" />
                ) : (
                  <span className={`${MONO_META_CLASS} text-[14px] text-[color:var(--faint)]`}>
                    Logged
                  </span>
                )}
              </form>
            </DeckPanel>
          </div>
        ) : null}

        {actionError ? (
          <Surface
            as="p"
            className="col-span-full m-0 text-[16px] leading-[1.5]"
            role="alert"
            style={{ color: TONE_TEXT.failure }}
            tone="failure"
          >
            {actionError}
          </Surface>
        ) : null}
      </div>

      <ContextEye copy={COACH_BILLING_EYE_COPY} screen="coach-billing" />
    </div>
  );
}
