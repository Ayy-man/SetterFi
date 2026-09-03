"use client";

/*
 * The affiliate portal, drawn from `Affiliate.body.html`.
 *
 * Data is the live page's, unchanged: the same `GET /api/affiliate/referrals` read and the same
 * exported parsers from `workspace/live/affiliate-money.tsx`. Nothing here queries anything the
 * old page did not, and nothing here computes a figure from a field the projection does not carry.
 *
 * Where the artboard asks for a fact the record does not hold, this says less rather than more:
 *
 *   - "September so far" over the commission figure. The projection carries one number per
 *     referral, `commissionEarnedCents`, with no accrual date on it, so there is no month to
 *     bound. The panel reads "All time", which is what that number is.
 *   - "Last six months" under the chart. Same reason: commission has no period axis at all, so
 *     the chart draws the single bar it can read and the panel says which period that is. Five
 *     invented months beside it would each be a figure this page cannot get.
 *   - The 1M/6M/1Y/All window. Nothing on this screen is windowed -- referrals and commission
 *     carry no dates, and the route takes no range -- so a control that changed nothing would be
 *     a control that lies about what it does. It is omitted rather than drawn inert.
 *
 * Two things the artboard does not draw are kept, because dropping them would take function off
 * the page rather than prose: the referral link and code, which is the one thing an affiliate
 * opens this portal to hand somebody, and the payout history table, which is the only place the
 * references behind the "Paid out" figure exist now that there is no Payouts route to move it to.
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { KitButton, Prose, Status, Surface } from "@/components/kit/atomics";
import { BarChart } from "@/components/kit/bar-chart";
import { DataState } from "@/components/kit/data-state";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ExportMenu } from "@/components/kit/export-menu";
import { Copy } from "@/components/kit/icons";
import { CoachScale } from "@/components/coach-scale";
import {
  affiliatePayoutLabel,
  parseAffiliatePayouts,
  parseAffiliateReferralCode,
  parseAffiliateReferralLink,
  parseAffiliateReferrals,
  type AffiliatePayoutView,
  type AffiliateReferralView,
} from "@/components/workspace/live/affiliate-money";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { Figure, StatusDot, type StatusTone } from "@/components/workspace/rehaul/_primitives";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";
import type { AffiliateAccountState } from "@/lib/billing/contracts";
import { humanError } from "@/lib/copy/errors";
import { money } from "@/lib/format/metric";

/* The sentences this screen used to print as help text, handed to the eye instead. */
export const AFFILIATE_EYE_COPY =
  "Coaches who signed up through your code, what they have earned you, and where every payout "
  + "stands. You see a coach's name, whether they are paying, and what you earned; their leads, "
  + "conversations and revenue are theirs alone and never appear here. Coaches who sign up "
  + "through your link are yours, and the code works too if you are reading it out on a call. A "
  + "payout only reads sent once a bank reference is recorded against it, so match that reference "
  + "to your statement: SetterFi records the payment, your bank makes it. Commission is held as "
  + "one running total per referral rather than by month, so this page states it all time.";

const H1_CLASS =
  "m-0 text-[46px] leading-[1.05] font-semibold tracking-[-0.025em] text-[color:var(--ink)]";
const TABULAR_CLASS = "[font-variant-numeric:tabular-nums_lining-nums]";
const STATUS_LINE_CLASS = "flex items-center gap-[8px] text-[16px] text-[color:var(--body)]";
const MONO_META_CLASS =
  "font-[family-name:var(--font-mono)] text-[14px] leading-[1.4] text-[color:var(--muted)] "
  + TABULAR_CLASS;
const PANEL_CLASS =
  "flex min-w-0 flex-col overflow-hidden rounded-[24px_24px_17px_17px] border "
  + "border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] "
  + "shadow-[0_1px_0_rgba(255,255,255,0.6)_inset,0_1px_2px_rgba(28,42,82,0.04),"
  + "0_8px_20px_-14px_rgba(28,42,82,0.16)]";
const BAND_CLASS =
  "flex min-h-[78px] flex-wrap items-center gap-[12px] border-b border-[var(--line)] "
  + "px-[20px] py-[19px]";
const EYEBROW_CLASS = "m-0 text-[14px] leading-[1.4] text-[color:var(--body)]";
const PANEL_NAME_CLASS =
  "m-0 text-[17px] leading-[1.3] font-semibold tracking-[-0.01em] text-[color:var(--ink)]";
const TH_CLASS =
  "border-b border-[var(--line)] px-[26px] py-[14px] text-left text-[14px] font-medium "
  + "text-[color:var(--muted)]";
const TD_CLASS = "border-b border-[var(--line-soft)] px-[26px] py-[19px] text-[16px]";
const NUM_CLASS = `text-right font-[family-name:var(--font-mono)] ${TABULAR_CLASS}`;
const WELL_CLASS =
  "flex min-h-[46px] min-w-0 flex-1 items-center overflow-hidden rounded-[12px] border "
  + "border-[var(--line)] bg-[var(--well)] px-[18px] py-[10px] font-[family-name:var(--font-mono)] "
  + "text-[16px] leading-[1.3] break-all text-[color:var(--ink)]";

/**
 * The four account states, reduced to the three things the affiliate is allowed to read: the word,
 * the dot tone, and nothing about the coach behind it.
 *
 * Amber on the two states that are still moving and still owe the affiliate something:
 * `payment_problem`, where commission has stopped accruing and the situation is recoverable, and
 * `setting_up`, where a referral has been made and no commission has started yet. Both are pending
 * and amber is the only colour a pending thing may wear. `cancelled` stays grey because it is
 * finished rather than waiting, and grey is the colour of a row with nothing left to happen.
 */
const REFERRAL_STATE: Record<AffiliateAccountState, { label: string; tone: StatusTone }> = {
  cancelled: { label: "Cancelled", tone: "grey" },
  paying: { label: "Paying", tone: "good" },
  payment_problem: { label: "Payment problem", tone: "amber" },
  setting_up: { label: "Still setting up", tone: "amber" },
};

/**
 * The three words `affiliatePayoutLabel` can return, and the only colour each is allowed.
 *
 * Green on the one state the ledger confirmed, amber on the approved-but-unsent row because that
 * is a pending payout and amber is the only colour a pending thing may wear, and grey on a payout
 * marked sent whose reference never arrived -- that is a missing record rather than a wait, and
 * painting it amber would put it in a queue nobody is working.
 */
const PAYOUT_TONE: Record<string, StatusTone> = {
  "Approved for payout": "amber",
  "Payout record unavailable": "grey",
  "Recorded sent": "good",
};

/**
 * A `YYYY-MM-DD` read back as the day it names, in UTC.
 *
 * `new Date("2026-03-04")` parses as UTC midnight, which formats as the third of March for any
 * reader west of Greenwich, so the parts are rebuilt through `Date.UTC` and read with a UTC
 * formatter. The day the affiliate matches against a bank statement stays the day the database
 * recorded.
 */
function dayLabel(recordedOn: string) {
  const [year, month, day] = recordedOn.split("-").map(Number);
  if (!year || !month || !day) return "date not recorded";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/**
 * One copyable value at the coach side's target size, with the name of what it copies on the
 * button.
 *
 * Labelled rather than a clipboard glyph because this surface is read by people who found the
 * console confusing, and the glyph is a convention rather than a picture of anything. The failure
 * path says so out loud: a clipboard that refuses is reported, because an affiliate who pastes
 * nothing into a message to a coach loses the commission and never finds out why.
 */
function CopyRow({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied your ${label}`);
    } catch {
      toast.error(`Your ${label} could not be copied. Select it and copy it by hand.`);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-[10px] sm:flex-row sm:items-center">
      <span className={WELL_CLASS}>{value}</span>
      <KitButton
        className="h-[46px] shrink-0 px-[20px] text-[16px]"
        leading={<Copy aria-hidden className="!size-[var(--s-4)]" />}
        onClick={() => void copy()}
        variant="secondary"
      >
        Copy {label}
      </KitButton>
    </div>
  );
}

export function AffiliateHome({
  enabled,
  termsCopy,
  initialReferrals,
  initialPayouts,
  initialReferralCode,
  initialReferralLink,
}: {
  enabled: boolean;
  termsCopy: string | null;
  initialReferrals?: readonly AffiliateReferralView[];
  initialPayouts?: readonly AffiliatePayoutView[];
  initialReferralCode?: string;
  initialReferralLink?: string | null;
}) {
  const hasInitialData = initialReferrals !== undefined || initialPayouts !== undefined;
  const firstName = useWorkspaceEnv().account?.firstName ?? null;
  const [referrals, setReferrals] = useState<readonly AffiliateReferralView[]>(
    initialReferrals ?? [],
  );
  const [payouts, setPayouts] = useState<readonly AffiliatePayoutView[]>(initialPayouts ?? []);
  const [referralCode, setReferralCode] = useState<string | null>(initialReferralCode ?? null);
  const [referralLink, setReferralLink] = useState<string | null>(initialReferralLink ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    hasInitialData ? "success" : "loading",
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    setError(null);
    setLoadState("loading");
    try {
      const response = await fetch("/api/affiliate/referrals", { cache: "no-store", signal });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Partner earnings could not be loaded. Try again.");
      setReferrals(parseAffiliateReferrals(payload));
      setPayouts(parseAffiliatePayouts(payload));
      const code = parseAffiliateReferralCode(payload);
      setReferralCode(code);
      setReferralLink(parseAffiliateReferralLink(payload, code));
      setLoadState("success");
    } catch (cause) {
      if (!signal?.aborted) {
        // Parser and transport errors carry internal codes; the portal renders only stable
        // plain-language copy, never a raw exception.
        setError(humanError(
          cause instanceof Error ? cause.message : "AFFILIATE_PORTAL_LOAD_FAILED",
        ).body);
        setLoadState("error");
      }
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, load]);

  const earnedTotal = referrals.reduce((sum, row) => sum + row.commissionEarnedCents, 0);
  const paidOutTotal = payouts.reduce(
    (sum, payout) => (payout.state === "sent" ? sum + payout.amountCents : sum),
    0,
  );
  const payingCount = referrals.filter((row) => row.accountStatus === "paying").length;
  const problemCount = referrals.filter((row) => row.accountStatus === "payment_problem").length;
  /*
   * The most recent sent payout, by the day it was recorded. `sent` is the only state that carries
   * a reference and a date at all -- `commission_payout_events_shape_chk` refuses one without the
   * other -- so an approved row can never win this comparison by having a blank date.
   */
  const lastSent = payouts
    .filter((payout) => payout.state === "sent" && payout.reference && payout.recordedOn)
    .sort((a, b) => (a.recordedOn ?? "").localeCompare(b.recordedOn ?? ""))
    .at(-1) ?? null;
  // A brand new affiliate has nothing recorded anywhere, which is a different claim from a
  // measured zero. Once either list has a row every figure is a real reading, because a failed
  // read takes the whole surface to `DataState` and none of these panels render at all.
  const nothingRecorded = referrals.length === 0 && payouts.length === 0;

  const payoutRows = payouts.map((payout, index) => ({
    amount: payout.amountCents / 100,
    recordedOn: payout.recordedOn,
    reference: payout.reference,
    rowId: `payout-${index + 1}`,
    status: affiliatePayoutLabel(payout),
  }));

  return (
    /*
      `CoachScale` for the same reason the live portal reaches for it: `coach.css` is written under
      `[data-shell-role="coach"]`, and this page is mounted `role="affiliate"` on purpose so it
      keeps the rail rather than taking a coach's pill bar to routes an affiliate is forbidden
      from. Stamping the attribute on the page body puts the deck panels at the coach density that
      `docs/REDESIGN-CANVAS.md` puts this surface in, without a second copy of the stylesheet.

      `pb-[72px]` because this screen's header has no trailing control row, so the eye stays
      floating. The gutter is what keeps it off the last panel's own content.
    */
    <CoachScale className="relative flex min-w-0 flex-col gap-[20px] pb-[72px]">
      <div className="flex min-w-0 flex-wrap items-end gap-[24px]">
        <div className="min-w-0">
          <h1 className={H1_CLASS} data-slot="affiliate-title">
            {firstName ? `Welcome back, ${firstName}` : "Your referrals"}
          </h1>
          {enabled && loadState === "success" && !nothingRecorded ? (
            <div
              className="mt-[10px] flex flex-wrap items-center gap-[20px]"
              data-slot="affiliate-status"
            >
              <span className={STATUS_LINE_CLASS}>
                <StatusDot tone={payingCount > 0 ? "good" : "grey"} />
                {payingCount} of your {referrals.length}
                {referrals.length === 1 ? " coach is" : " coaches are"} paying
              </span>
              {problemCount > 0 ? (
                <span className={STATUS_LINE_CLASS}>
                  <StatusDot tone="amber" />
                  {problemCount === 1
                    ? "One payment problem, no commission accruing there"
                    : `${problemCount} payment problems, no commission accruing there`}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {!enabled ? (
        <DataState
          body="Partner earnings are currently off. No referral or payout data was requested."
          kind="unavailable"
          title="Partner earnings are not enabled"
        />
      ) : null}

      {enabled && loadState === "loading" ? <DataState kind="loading" rows={5} /> : null}

      {enabled && loadState === "error" && error ? (
        <DataState
          body={error}
          kind="error"
          retry={() => void load()}
          title="Partner earnings could not load"
        />
      ) : null}

      {enabled && loadState === "success" ? (
        <>
          <div className="grid min-w-0 gap-[20px] lg:grid-cols-3">
            <DeckPanel eyebrow="Joined on your link" name="Referred coaches">
              <Figure className={TABULAR_CLASS} size="hero">
                <span data-slot="affiliate-referral-count">{referrals.length}</span>
              </Figure>
            </DeckPanel>

            {/*
              The one drenched panel, on the figure the portal exists for. "All time" rather than
              the artboard's "September so far": `commissionEarnedCents` is a running total with no
              accrual date behind it, so there is no month to bound it to.
            */}
            <DeckPanel drench="live" eyebrow="All time" name="Commission earned">
              <Figure className={TABULAR_CLASS} size="hero">
                <span data-slot="affiliate-earned">
                  {nothingRecorded ? "Not yet" : money(earnedTotal, "USD")}
                </span>
              </Figure>
            </DeckPanel>

            <DeckPanel
              eyebrow="Sent to your bank"
              name="Paid out"
              sentence={lastSent && lastSent.reference && lastSent.recordedOn
                ? `Last reference ${lastSent.reference}, ${dayLabel(lastSent.recordedOn)}.`
                : "No payout has been recorded as sent yet."}
            >
              <Figure className={TABULAR_CLASS} size="hero">
                <span data-slot="affiliate-paid-out">
                  {nothingRecorded ? "Not yet" : money(paidOutTotal, "USD")}
                </span>
              </Figure>
            </DeckPanel>
          </div>

          <div className="grid min-w-0 items-start gap-[20px] lg:grid-cols-[minmax(0,1fr)_420px]">
            <section aria-labelledby="affiliate-referrals-heading" className={PANEL_CLASS}>
              <div className={BAND_CLASS}>
                <div className="min-w-0">
                  <p className={EYEBROW_CLASS}>Name, status and what you earned</p>
                  <h2 className={PANEL_NAME_CLASS} id="affiliate-referrals-heading">
                    Referred coaches
                  </h2>
                </div>
                <ExportMenu
                  className="ml-auto h-[46px] px-[20px] text-[16px]"
                  filename="setterfi-affiliate-referrals"
                  label="Export"
                  mode="server"
                  query={{
                    columns: ["businessName", "accountStatus", "commissionEarnedUsd"],
                    order: "created_desc",
                  }}
                  resource="affiliate-referrals"
                />
              </div>
              {referrals.length ? (
                <table className="w-full border-collapse" data-slot="affiliate-referral-table">
                  <thead>
                    <tr>
                      <th className={TH_CLASS} scope="col">Referred coach</th>
                      <th className={TH_CLASS} scope="col">Status</th>
                      <th className={`${TH_CLASS} text-right`} scope="col">Commission earned</th>
                    </tr>
                  </thead>
                  <tbody>
                    {referrals.map((row, index) => {
                      const state = REFERRAL_STATE[row.accountStatus];
                      return (
                        <tr key={`${row.businessName}-${index}`}>
                          <td className={`${TD_CLASS} font-medium text-[color:var(--ink)]`}>
                            {row.businessName}
                          </td>
                          <td className={`${TD_CLASS} text-[color:var(--body)]`}>
                            <span className="flex items-center gap-[9px]">
                              <StatusDot tone={state.tone} />
                              {state.label}
                            </span>
                          </td>
                          <td
                            className={`${TD_CLASS} ${NUM_CLASS} ${
                              row.commissionEarnedCents === 0
                                ? "text-[color:var(--muted)]"
                                : "text-[color:var(--ink)]"
                            }`}
                          >
                            {money(row.commissionEarnedCents, "USD")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <p className="m-0 px-[26px] py-[24px] text-[16px] text-[color:var(--muted)]">
                  No referred coaches are recorded.
                </p>
              )}
            </section>

            <div className="flex min-w-0 flex-col gap-[20px]">
              {/*
                One bar, because one period is what the projection carries. The artboard's five
                earlier months would each be a figure this page cannot read.
              */}
              <DeckPanel
                eyebrow="All time, the only period recorded"
                meta={(
                  <span className={MONO_META_CLASS}>
                    {nothingRecorded ? "nothing recorded" : `${money(earnedTotal, "USD")} earned`}
                  </span>
                )}
                name="Commission"
              >
                <BarChart
                  height={180}
                  label="Commission earned by recorded period"
                  labels={["All time"]}
                  values={[earnedTotal / 100]}
                  width={360}
                />
              </DeckPanel>

              {referralCode ? (
                <DeckPanel
                  eyebrow="How coaches find you"
                  name={referralLink ? "Your referral link" : "Your referral code"}
                >
                  <div className="flex min-w-0 flex-col gap-[14px]">
                    {referralLink ? (
                      <CopyRow label="referral link" value={referralLink} />
                    ) : null}
                    <CopyRow label="referral code" value={referralCode} />
                  </div>
                </DeckPanel>
              ) : null}
            </div>
          </div>

          {/*
            The payout table, kept because the shell gives an affiliate one route and there is
            nowhere else for the references behind the "Paid out" figure to live.
          */}
          <section aria-labelledby="affiliate-payouts-heading" className={PANEL_CLASS}>
            <div className={BAND_CLASS}>
              <div className="min-w-0">
                <p className={EYEBROW_CLASS}>What has reached your bank</p>
                <h2 className={PANEL_NAME_CLASS} id="affiliate-payouts-heading">Payouts</h2>
              </div>
              <ExportMenu
                className="ml-auto h-[46px] px-[20px] text-[16px]"
                filename="setterfi-affiliate-payout-history"
                label="Export"
                mode="local"
                rows={payoutRows.map((row) => ({
                  amount: row.amount,
                  recordedOn: row.recordedOn,
                  reference: row.reference,
                  status: row.status,
                }))}
              />
            </div>
            {payoutRows.length ? (
              <table className="w-full border-collapse" data-slot="affiliate-payout-table">
                <thead>
                  <tr>
                    <th className={TH_CLASS} scope="col">Status</th>
                    <th className={`${TH_CLASS} text-right`} scope="col">Amount</th>
                    <th className={TH_CLASS} scope="col">Bank reference</th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRows.map((row) => (
                    <tr key={row.rowId}>
                      <td className={`${TD_CLASS} text-[color:var(--body)]`}>
                        <span className="flex items-center gap-[9px]">
                          <StatusDot tone={PAYOUT_TONE[row.status] ?? "grey"} />
                          {row.status}
                        </span>
                      </td>
                      <td className={`${TD_CLASS} ${NUM_CLASS} text-[color:var(--ink)]`}>
                        {money(Math.round(row.amount * 100), "USD")}
                      </td>
                      <td
                        className={`${TD_CLASS} font-[family-name:var(--font-mono)] text-[14px] text-[color:var(--muted)]`}
                      >
                        {row.reference && row.recordedOn ? (
                          <>
                            {row.reference}
                            {" · "}
                            <time dateTime={row.recordedOn}>{dayLabel(row.recordedOn)}</time>
                          </>
                        ) : (
                          "not sent yet, so no reference exists"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="m-0 px-[26px] py-[24px] text-[16px] text-[color:var(--muted)]">
                No payout history was returned for your account.
              </p>
            )}
          </section>

          {/*
            Terms are set by SetterFi rather than edited here, so this states a value rather than
            offering a control. The marker describes the row beside it: configured terms are the
            configured text, and only an absent value is the placeholder. A badge that called real
            configured copy a demo placeholder was as wrong as one that called a placeholder real.
          */}
          <Surface className="max-w-[var(--measure-prose)] p-[var(--s-5)]" variant="well">
            <div className="flex flex-wrap items-center justify-between gap-[var(--s-2)]">
              <span className={EYEBROW_CLASS}>Partner terms</span>
              {termsCopy ? null : (
                <Status label="Not configured" tone="warning" treatment="bare" />
              )}
            </div>
            <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--body)]">
              {termsCopy ?? "Partner terms have not been approved or configured."}
            </Prose>
          </Surface>
        </>
      ) : null}

      <ContextEye copy={AFFILIATE_EYE_COPY} screen="affiliate" />
    </CoachScale>
  );
}
