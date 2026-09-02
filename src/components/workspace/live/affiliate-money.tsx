"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { humanError } from "@/lib/copy/errors";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  absentValue,
  identityColumn,
  moneyColumn,
  stateColumn,
} from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ExportMenu } from "@/components/kit/export-menu";
import { Copy, ShieldCheck } from "@/components/kit/icons";
import { carriesReferralAttribution } from "@/lib/affiliates/referral-attribution";
import { KitButton, Prose, Status, Surface, SurfaceHeader } from "@/components/kit/atomics";
import { CoachScale } from "@/components/coach-scale";
import { CoachDeck, type CoachDeckItem } from "@/components/workspace/live/coach-deck";
import {
  COACH_EYEBROW_CLASS,
  COACH_FOOTNOTE_CLASS,
  COACH_LEAD_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { formatMetric } from "@/lib/format/metric";
import { StateBadge } from "@/components/kit/state-badge";
import {
  AFFILIATE_ACCOUNT_STATES,
  type AffiliateAccountState,
} from "@/lib/billing/contracts";
import { useWorkspaceEnv } from "@/components/workspace/workspace-env";

export type AffiliateReferralView = {
  businessName: string;
  accountStatus: AffiliateAccountState;
  commissionEarnedCents: number;
};

export type AffiliatePayoutView = {
  amountCents: number;
  state: "approved_for_payout" | "sent";
  reference: string | null;
  recordedOn: string | null;
};

type ReferralTableRow = AffiliateReferralView & {
  rowId: string;
  kind: "referral" | "total";
  referralCount: number;
};

type PayoutTableRow = AffiliatePayoutView & {
  rowId: string;
};

export function parseAffiliateReferrals(value: unknown): AffiliateReferralView[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AFFILIATE_PROJECTION_INVALID");
  }
  const referrals = (value as Record<string, unknown>).referrals;
  if (!Array.isArray(referrals)) throw new Error("AFFILIATE_PROJECTION_INVALID");
  return referrals.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("AFFILIATE_PROJECTION_INVALID");
    }
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "accountStatus,businessName,commissionEarnedCents"
      || typeof row.businessName !== "string"
      || !(AFFILIATE_ACCOUNT_STATES as readonly string[]).includes(String(row.accountStatus))
      || typeof row.commissionEarnedCents !== "number"
      || !Number.isSafeInteger(row.commissionEarnedCents)
    ) throw new Error("AFFILIATE_PROJECTION_INVALID");
    return row as AffiliateReferralView;
  });
}

/**
 * The affiliate's own signup link, and `null` when it would not attribute anything.
 *
 * The route builds this from the origin that served the request, so it is the only source for it.
 * It is checked against `carriesReferralAttribution` before the portal will show it: a link whose
 * `ref` has gone missing looks exactly like one that works, and the person it fails is the
 * affiliate, who finds out by never being paid. Showing the code alone is the honest fallback.
 */
export function parseAffiliateReferralLink(value: unknown, code: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const referral = (value as Record<string, unknown>).referral;
  if (!referral || typeof referral !== "object" || Array.isArray(referral)) return null;
  const link = (referral as Record<string, unknown>).link;
  if (typeof link !== "string" || !carriesReferralAttribution(link, code)) return null;
  return link;
}

/**
 * The affiliate's own referral code. The route has returned `referral: { code, link }` since it
 * was written and this component read neither, so the person whose income depends on attribution
 * could not see the identity that earns it.
 */
export function parseAffiliateReferralCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AFFILIATE_REFERRAL_CODE_INVALID");
  }
  const referral = (value as Record<string, unknown>).referral;
  if (!referral || typeof referral !== "object" || Array.isArray(referral)) {
    throw new Error("AFFILIATE_REFERRAL_CODE_INVALID");
  }
  const code = (referral as Record<string, unknown>).code;
  if (typeof code !== "string" || !code.trim()) {
    throw new Error("AFFILIATE_REFERRAL_CODE_INVALID");
  }
  return code;
}

export function affiliatePayoutLabel(payout: AffiliatePayoutView) {
  if (payout.state === "sent") {
    return payout.reference && payout.recordedOn
      ? "Recorded sent"
      : "Payout record unavailable";
  }
  return "Approved for payout";
}

export function parseAffiliatePayouts(value: unknown): AffiliatePayoutView[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AFFILIATE_PAYOUT_PROJECTION_INVALID");
  }
  const payouts = (value as Record<string, unknown>).payouts;
  if (!Array.isArray(payouts)) throw new Error("AFFILIATE_PAYOUT_PROJECTION_INVALID");
  return payouts.map((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error("AFFILIATE_PAYOUT_PROJECTION_INVALID");
    }
    const row = candidate as Record<string, unknown>;
    if (
      Object.keys(row).sort().join(",") !== "amountCents,recordedOn,reference,state"
      || typeof row.amountCents !== "number" || !Number.isSafeInteger(row.amountCents)
      || (row.state !== "approved_for_payout" && row.state !== "sent")
      || (row.reference !== null && typeof row.reference !== "string")
      || (row.recordedOn !== null && typeof row.recordedOn !== "string")
      || (row.state === "approved_for_payout"
        && (row.reference !== null || row.recordedOn !== null))
      || (row.state === "sent"
        && (typeof row.reference !== "string" || !row.reference.trim()
          || typeof row.recordedOn !== "string" || !row.recordedOn.trim()))
    ) throw new Error("AFFILIATE_PAYOUT_PROJECTION_INVALID");
    return row as AffiliatePayoutView;
  });
}

/*
 * The four states, and the tones are the argument.
 *
 * "Active" and "Inactive" merged a coach who had not finished setting up with one who had
 * cancelled, and -- worse -- counted a coach whose payments had stalled as active, telling the
 * affiliate money was still coming from an account that had stopped paying for it. The projection
 * now returns four states and this maps each to what the affiliate can actually do about it.
 *
 * Amber on `payment_problem` is the only warning tone on the table and it is earned: it is the one
 * row where something has gone wrong that is still recoverable, and the affiliate's own commission
 * is what is at stake. `setting_up` is deliberately not amber -- a coach mid-setup is the normal
 * course of a referral working, not a problem, and SMS registration alone genuinely takes two to
 * three weeks. `cancelled` is neutral rather than critical: it is finished, not failing.
 *
 * The detail line never speculates. It says what is true of the commission in that state and
 * nothing about the coach: why a payment stalled is the coach's business, not their referrer's.
 */
const REFERRAL_STATES: Record<
  AffiliateAccountState,
  { label: string; tone: "neutral" | "good" | "warning"; detail?: string }
> = {
  setting_up: {
    detail: "commission starts when their first invoice clears",
    label: "Still setting up",
    tone: "neutral",
  },
  paying: { label: "Paying", tone: "good" },
  payment_problem: {
    detail: "no new commission accrues while this is unresolved",
    label: "Payment problem",
    tone: "warning",
  },
  cancelled: {
    detail: "earned commission remains payable",
    label: "Cancelled",
    tone: "neutral",
  },
};

function referralStatus(row: ReferralTableRow) {
  if (row.kind === "total") {
    return {
      kind: "lifecycle" as const,
      label: `${row.referralCount} ${row.referralCount === 1 ? "referral" : "referrals"}`,
      tone: "neutral" as const,
    };
  }
  const state = REFERRAL_STATES[row.accountStatus];
  return { kind: "lifecycle" as const, label: state.label, tone: state.tone, ...(state.detail ? { detail: state.detail } : {}) };
}

/*
 * A `YYYY-MM-DD` read back as the day it names, in UTC.
 *
 * A payout's recorded day is a date rather than an instant, and `new Date("2026-03-04")` parses as
 * UTC midnight, which formats as the third of March for any reader west of Greenwich. Splitting the
 * parts and rebuilding through `Date.UTC` with a UTC formatter is what keeps the day the affiliate
 * reads the day the database recorded.
 */
function dayLabel(recordedOn: string) {
  const [year, month, day] = recordedOn.split("-").map(Number);
  if (!year || !month || !day) return "Recorded date unavailable";
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

const referralColumns = [
  identityColumn<ReferralTableRow>({
    accessor: (row) => row.businessName,
    header: "Referred coach",
    id: "businessName",
  }),
  stateColumn<ReferralTableRow>({
    accessor: referralStatus,
    header: "Status",
    id: "status",
    StateBadge,
  }),
  moneyColumn<ReferralTableRow>({
    accessor: (row) => row.commissionEarnedCents,
    header: "Commission earned",
    id: "commissionEarned",
  }),
] as ColumnDef<ReferralTableRow>[];

const payoutColumns = [
  stateColumn<PayoutTableRow>({
    accessor: (row) => ({
      kind: "lifecycle",
      label: affiliatePayoutLabel(row),
      // Periwinkle, which is what 5g draws it in, and what the tone contract means by `waiting`:
      // an approved payout is not waiting on the affiliate and there is nothing for them to do
      // about it. Amber would put a clock on them for someone else's bank run.
      tone: row.state === "sent" ? "good" : "info",
    }),
    header: "Status",
    id: "status",
    StateBadge,
  }),
  moneyColumn<PayoutTableRow>({
    accessor: (row) => row.amountCents,
    header: "Amount",
    id: "amount",
  }),
  {
    /*
     * The reference and its date are one fact, not two columns. A payout is only ever `sent`
     * *because* a bank reference was recorded against it, so the two are written together and
     * never exist apart. Split across two columns they rendered "Not recorded yet" twice on every
     * approved row, which reads as two things missing rather than one thing that has not happened;
     * together they say what the affiliate came here to check, in the mono the reference is
     * matched against a bank statement in.
     */
    accessorFn: (row: PayoutTableRow) => (
      row.reference && row.recordedOn
        ? `${row.reference} · ${dayLabel(row.recordedOn) ?? "recorded date unavailable"}`
        : "not sent yet"
    ),
    cell: ({ row }) => {
      const { recordedOn, reference } = row.original;
      if (!reference || !recordedOn) {
        return absentValue("not sent yet, so no reference exists");
      }
      return (
        <span className="font-mono text-[length:var(--t-mono-meta)] leading-[var(--t-mono-meta-lh)] tabular-nums text-[var(--muted)]">
          {reference} · <time dateTime={recordedOn}>{dayLabel(recordedOn) ?? "recorded date unavailable"}</time>
        </span>
      );
    },
    header: "Bank reference",
    id: "evidence",
    meta: { cellKind: "secondary", label: "Bank reference", minWidth: 240 },
  },
] as ColumnDef<PayoutTableRow>[];

/**
 * One copyable value: the label above it, the value in a mono well, the copy control beside it.
 *
 * The copy control is forced up to the coach-side target here rather than left to `coach.css`'s
 * floor rule, because `CopyValue` sets `!size-[var(--s-6)]` with `!important` -- 24px in both
 * directions -- and no zero-specificity `:where()` rule can outrank that. A control that is 44px
 * tall and 24px wide is not a 44px target, so the override has to be as loud as the value it is
 * overriding, and it belongs here where the reason is visible.
 */
function ReferralSlot({
  copyLabel,
  label,
  value,
}: { copyLabel: string; label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
      <span className={COACH_EYEBROW_CLASS}>{label}</span>
      <div className="flex min-w-0 flex-col gap-[var(--s-3)] @min-[440px]/referral:flex-row @min-[440px]/referral:items-center">
        <span className="flex min-w-0 flex-1 items-center overflow-hidden rounded-[12px] border border-[var(--line)] bg-[var(--well)] px-[18px] py-[var(--s-2)] font-mono text-[18px] leading-[1.3] tracking-[-0.01em] break-all text-[color:var(--ink)] min-h-[var(--coach-target-primary)]">
          {value}
        </span>
        <CopyReferralButton label={copyLabel} value={value} />
      </div>
    </div>
  );
}

/**
 * A copy control that says what it copies, at the coach side's target size.
 *
 * `SIMPLIFICATION-SPEC.md` §2.11 asks for the copy-link button to be enlarged and labelled by
 * name, and the canvas draws a "Copy link" button beside the well rather than a glyph inside it.
 * The reason is the reader: this surface is built for people over 55 who found the console
 * confusing, and the clipboard glyph is a convention rather than a picture of anything -- an
 * affiliate who does not recognise it has no way to find the one control the whole page exists to
 * hand them.
 *
 * Written here rather than by widening `kit/copy-value.tsx`, which is a 24px icon-only button
 * belonging to the console density and to another surface's lane. A labelled 44px control is a
 * different object, not a prop on that one, and forking a shared kit component to serve one page
 * would put the console's copy buttons one careless edit away from growing a label.
 *
 * The failure path matters as much as the success one. When the clipboard is unavailable -- an
 * insecure origin, a browser that refuses the permission -- the button says so instead of
 * reporting a copy that did not happen, because an affiliate who pastes nothing into a message to
 * a coach loses the commission and never learns why.
 */
function CopyReferralButton({ label, value }: { label: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`Copied your ${label}`);
    } catch {
      toast.error(`Your ${label} could not be copied. Select it and copy it by hand.`);
    }
  }

  return (
    <KitButton
      className="h-[var(--coach-target)] shrink-0 px-[20px] text-[16px]"
      leading={<Copy aria-hidden className="!size-[var(--s-4)]" />}
      onClick={() => void copy()}
      variant="secondary"
    >
      Copy {label}
    </KitButton>
  );
}

/**
 * The affiliate's referral identity: what they hand a coach so the signup is attributed to them.
 *
 * The link led for a while as a refusal rather than a control. It was generated by the route and
 * read by nothing, so copying it would have handed an affiliate a link that dropped their
 * commission in silence. `src/app/signup/page.tsx` now reads the parameter and prefills the field,
 * so the link works end to end and leads here.
 *
 * The code stays beside it, and not as a leftover: an affiliate on a call with a coach reads out a
 * code, they cannot read out a URL, and the signup field takes a typed code either way. Two
 * copyables, each for a different conversation.
 *
 * The link renders only when `parseAffiliateReferralLink` finds the attribution parameter still on
 * it, so the half-wired state that caused all this cannot come back silently: it degrades to the
 * code, which always works.
 *
 * Drawn as a deck panel rather than a strip because the canvas gives this the second panel on the
 * screen, beside the drenched commission figure -- it is the other thing an affiliate opens the
 * portal for. It is deliberately *not* drenched: the accent is legible as emphasis only while it
 * stays scarce, and the money is the emphasis.
 */
function ReferralIdentity({ code, link }: { code: string; link: string | null }) {
  return (
    <DeckPanel
      eyebrow="How coaches find you"
      headingId="referral-identity-heading"
      name={link ? "Your referral link" : "Your referral code"}
    >
      {/*
        `@container` here is what makes `ReferralSlot`'s `@min-[440px]:flex-row` mean anything. It
        had none: a container query resolves against the nearest ancestor that declares
        `container-type`, and nothing above the slot declared one -- `CoachScale` is bare,
        `DeckPanel` renders `coach-panel` with no container utility, `AppShell` has none, and no
        stylesheet in the tree sets the property. So both utilities on the slot were inert at every
        width and the link well stayed stacked above its Copy link button, where the canvas draws
        them side by side. That is the shape a dead container query takes: not an error, not a
        warning, just a rule the browser has nothing to evaluate against.

        This wrapper rather than the slot itself, because the width the query is asking about is
        the panel's content width, and an element cannot be its own query container -- declaring it
        on the slot would have it measure the box the rule is trying to reshape.

        Named rather than anonymous, which is the rule `container-queries.test.ts` states for new
        code and the reason is in this file's own ancestry: `Surface` is a bare `@container`, so an
        unnamed query binds to whichever anonymous container happens to be nearest and silently
        rebinds the day somebody wraps the panel in one. `/referral` says which box is meant.
      */}
      <div className="@container/referral flex min-w-0 flex-col gap-[var(--s-4)]">
        {link ? (
          <ReferralSlot copyLabel="referral link" label="Your link" value={link} />
        ) : null}
        <ReferralSlot copyLabel="referral code" label="Referral code" value={code} />
        <Prose className={`min-w-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`} measure="prose">
          {link
            ? "Coaches who sign up through this link are yours. The code works too, if you are reading it out."
            : "A coach enters this at signup and every commission they generate is yours."}
        </Prose>
      </div>
    </DeckPanel>
  );
}

/**
 * A section name over a table, at the panel name's size.
 *
 * Written against `--coach-panel-name` rather than added to `coach-type.ts` because it is the same
 * role a deck panel's name plays -- `coach-offer.tsx` already draws its own heading from that
 * variable for the same reason -- and a fourth constant for a size that already has a name would be
 * the parallel constant the port brief rules out. `coach.css` declares the variable under
 * `[data-shell-role="coach"]`, which `CoachScale` stamps on this page's content and nowhere else.
 */
const SECTION_NAME_CLASS =
  "text-[length:var(--coach-panel-name)] leading-[1.25] font-[500] tracking-[-0.015em] text-[color:var(--ink)]";

/**
 * The page head, at the coach side's scale rather than the console's.
 *
 * A local head instead of `PageHeader` for the same reason `LeadsSurface` grew one: `PageHeader`
 * sets its title with `.t-page-title`, the console's 20px, and there is no prop that moves it. The
 * canvas draws the partner portal at `--coach-page-title` -- 46px, weight 500, tracking -0.026em --
 * and that size is the point of the port rather than decoration. `AppShell` already renders the
 * crumbs above this from its own `crumbs` prop, and this head takes no actions, so the two other
 * things `PageHeader` carried have nothing to do here.
 */
function AffiliateHead({ referralCount }: { referralCount: number | null }) {
  /*
   * The canvas opens this page "Welcome back, Dana", and until the workspace layout started
   * resolving a display name there was no source for one, so the head stated the count alone
   * rather than greeting nobody. The layout now reads `users.full_name` once per
   * request and hands the first token down through `WorkspaceEnvProvider`, so the greeting comes
   * from the signed-in row and from nothing else: outside `supabase` mode, on a blank column, or
   * on a failed read the name is undefined and the head falls straight back to the title it has
   * always carried. No placeholder person, ever.
   */
  const firstName = useWorkspaceEnv().account?.firstName ?? null;

  return (
    <header className="flex min-w-0 flex-col gap-[var(--s-2)]" data-page-head="affiliate">
      <h1 className="coach-page-title m-0">
        {firstName ? `Welcome back, ${firstName}` : "Your referrals"}
      </h1>
      <Prose className={`m-0 ${COACH_LEAD_CLASS}`}>
        {referralCount === null
          ? "Coaches who signed up through your code, what they have earned you, and where every payout stands."
          : referralCount === 0
            ? "Nobody has signed up through your link yet. Your link and code are below, and this page fills in the moment the first coach uses one."
            : `${referralCount} ${referralCount === 1 ? "coach has" : "coaches have"} signed up through your link. What they have earned you, and where every payout stands, is below.`}
      </Prose>
    </header>
  );
}

/**
 * The line that says what this page deliberately does not show.
 *
 * It is a product rule, not a nicety: an affiliate sees a referred coach's name, whether they are
 * paying, and what they earned, and never that coach's leads, conversations or revenue. It reads
 * under the referrals table rather than above it because that is the table it is a statement about,
 * and it carries the shield the rest of the product uses for a privacy or audit claim.
 */
function ReferralPrivacyNote() {
  return (
    <p
      className={`m-0 flex items-start gap-[var(--s-2)] ${COACH_FOOTNOTE_CLASS}`}
      data-slot="affiliate-privacy-note"
    >
      <ShieldCheck aria-hidden className="mt-[2px] !size-[var(--s-4)] flex-none" />
      <span>
        You see a coach’s name, whether they are paying, and what you earned. Their leads,
        conversations and revenue are theirs alone and never appear here.
      </span>
    </p>
  );
}

export function AffiliateMoney({
  enabled,
  termsCopy,
  initialReferrals,
  initialPayouts,
  initialReferralCode,
}: {
  enabled: boolean;
  termsCopy: string | null;
  initialReferrals?: readonly AffiliateReferralView[];
  initialPayouts?: readonly AffiliatePayoutView[];
  initialReferralCode?: string;
}) {
  const hasInitialData = initialReferrals !== undefined || initialPayouts !== undefined;
  const [referrals, setReferrals] = useState<readonly AffiliateReferralView[]>(initialReferrals ?? []);
  const [payouts, setPayouts] = useState<readonly AffiliatePayoutView[]>(initialPayouts ?? []);
  const [referralCode, setReferralCode] = useState<string | null>(initialReferralCode ?? null);
  const [referralLink, setReferralLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "success" | "error">(
    hasInitialData ? "success" : "loading",
  );

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!enabled) return;
    setError(null);
    setLoadState("loading");
    try {
      const response = await fetch("/api/affiliate/referrals", {
        cache: "no-store",
        signal,
      });
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
        // Parser and transport errors carry internal codes (AFFILIATE_PROJECTION_INVALID and
        // friends); the portal renders only stable plain-language copy, never a raw exception.
        setError(humanError(cause instanceof Error ? cause.message : "AFFILIATE_PORTAL_LOAD_FAILED").body);
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
    (sum, payout) => payout.state === "sent" ? sum + payout.amountCents : sum,
    0,
  );
  const approvedWaitingTotal = payouts.reduce(
    (sum, payout) => payout.state === "approved_for_payout" ? sum + payout.amountCents : sum,
    0,
  );
  // Everything earned that has not left SetterFi yet. Derived as a difference rather than summed
  // from the payout list on purpose: commission with no payout record at all has not been
  // approved, so it appears in neither payout state, and summing states would under-report the
  // affiliate's own money. Earned minus sent is the whole of what is still owed.
  const payableTotal = earnedTotal - paidOutTotal;
  // A brand new affiliate has nothing recorded anywhere, which is a different claim from a
  // measured zero and reads as words rather than $0.00. Once either list has a row, every figure
  // is a real reading and a zero among them is a fact worth printing.
  const nothingRecorded = referrals.length === 0 && payouts.length === 0;
  /**
   * `reverse_invoice_commission` can post an offset against an accrual that was already paid out,
   * and nothing nets it against a later payout automatically, so more can have been sent than is
   * currently earned. Rare, but it is the affiliate's own money and the figure must not read as an
   * ordinary balance.
   */
  const payableNote = payableTotal < 0
    ? "a reversal posted after your last payout, so this is being recovered"
    : approvedWaitingTotal > 0
      ? `${formatMetric(approvedWaitingTotal, "money")} approved, waiting on the bank`
      : "none approved for payout yet";
  const referralRows = useMemo<ReferralTableRow[]>(() => {
    const rows = referrals.map((row, index) => ({
      ...row,
      kind: "referral" as const,
      referralCount: 1,
      rowId: `referral-${index + 1}`,
    }));
    return rows.length
      ? [...rows, {
          // The footer is arithmetic, not a referral. `referralStatus` branches on `kind` before
          // it ever reads this, so it is filler that never reaches a reader.
          accountStatus: "paying" as const,
          businessName: "Total",
          commissionEarnedCents: earnedTotal,
          kind: "total" as const,
          referralCount: rows.length,
          rowId: "referral-total",
        }]
      : [];
  }, [earnedTotal, referrals]);
  const payoutRows = useMemo<PayoutTableRow[]>(
    () => payouts.map((payout, index) => ({ ...payout, rowId: `payout-${index + 1}` })),
    [payouts],
  );

  /*
   * The three figures, as the deck rather than as a managed strip.
   *
   * They are still one statement about one balance and they still read left to right as the
   * arithmetic they are -- earned, minus sent, leaves payable -- but at the coach side's scale,
   * which is the whole point of this surface's port: an affiliate opens this page to read one
   * number, and reading it should not require leaning in.
   *
   * `CoachDeck` rather than a hand-rolled grid because its absent arms are the honest-states rule
   * in code, and this page needs exactly one of them. A brand new affiliate has nothing recorded
   * anywhere, which is a different claim from a measured zero: `unavailable` prints "Not yet" over
   * the reason, while a real reading of zero prints `$0.00`. Once either list has a row every
   * figure has genuinely been measured, because a read failure takes the whole surface to a
   * `DataState` error and this deck never renders at all -- so a zero here is always a fact.
   *
   * One drench, on the earned figure, and nothing else fills. `--drench-info` is left unspent: the
   * cap is two and the second one would only dilute the first.
   */
  const deckItems: readonly CoachDeckItem[] = [
    {
      availability: nothingRecorded
        ? { kind: "unavailable", note: "No earned commission yet" }
        : { format: "money", kind: "value", value: earnedTotal },
      drench: "live",
      eyebrow: "Your earnings",
      footer: (
        // Written out rather than composed from COACH_FOOTNOTE_CLASS plus a colour: that constant
        // already carries `--muted`, and two arbitrary colour utilities in one class string are
        // resolved by the order Tailwind emits them, not the order they are written, so the
        // override is a coin flip. The size is the footnote's; only the colour differs, because
        // this footer sits on a drench.
        <p className="m-0 text-[15px] leading-[1.5] text-[color:var(--coach-on-drench-sub)]">
          {referrals.length === 1 ? "1 coach" : `${referrals.length} coaches`} signed up on your
          link.
        </p>
      ),
      hero: true,
      name: "Earned, all time",
      sentence: "Commission from every coach who joined on your link.",
    },
    {
      availability: nothingRecorded
        ? { kind: "unavailable", note: "No payout has been sent" }
        : { format: "money", kind: "value", value: paidOutTotal },
      eyebrow: "Already with you",
      name: "Paid out",
      sentence: "Payouts SetterFi has recorded as sent to your bank.",
    },
    {
      availability: nothingRecorded
        ? { kind: "unavailable", note: "Nothing is payable yet" }
        : { format: "money", kind: "value", value: payableTotal },
      eyebrow: "Still owed to you",
      name: "Payable",
      // The note is the sentence here: what the payable figure is made of is the only thing worth
      // saying under it, and it changes with the data in a way a fixed sentence could not.
      sentence: payableNote,
    },
  ];

  return (
    /*
      `CoachScale` rather than a stylesheet of this surface's own.

      `coach.css` is written entirely under `[data-shell-role="coach"]`, which `AppShell` stamps
      from its `role` prop -- and the portal is mounted as `role="affiliate"` on purpose, because
      the role also decides that it keeps the rail rather than taking a coach's pill bar to routes
      an affiliate is forbidden from. So the coach scope does not reach this page's content, and
      the obvious fix, a sibling stylesheet restating the same anatomy under the affiliate role,
      was written and then thrown away: it was 230 lines of duplicated deck panel that would drift
      from `coach.css` the first time the coach lane touched it, which is exactly the failure the
      2026-08-30 craft audit is a record of.

      What this does instead is stamp the attribute on the page's content, inside `<main>`, so the
      rail and topbar above it keep the console's density and everything below reads at the coach
      side's 16px with the 44px target floor. `docs/REDESIGN-CANVAS.md` is the authority for that
      being honest rather than a trick: its density table puts coach, affiliate, consumer and
      onboarding in one column and the owner console in the other, and this page is that column.
      The sign-in and onboarding surfaces reached the same conclusion independently, which is why
      the component already exists.
    */
    <CoachScale className="flex min-w-0 flex-col gap-[var(--s-8)]">
      {/* The count is the affiliate's own referral rows and nothing else: null while the read is
          in flight or has failed, so the head never states a number it does not have. */}
      <AffiliateHead
        referralCount={enabled && loadState === "success" ? referrals.length : null}
      />

      {!enabled ? (
        <DataState
          body="Partner earnings are currently off. No referral or payout data was requested."
          kind="unavailable"
          title="Partner earnings are not enabled"
        />
      ) : (
        <>
          {loadState === "loading" ? <DataState kind="loading" rows={5} /> : null}

          {loadState === "error" && error ? (
            <DataState body={error} kind="error" retry={() => void load()} title="Partner earnings could not load" />
          ) : null}

          {loadState === "success" ? (
            <>
              {/*
                The deck first, then the identity panel. The canvas puts the money and the link
                side by side as the two things an affiliate opens the portal for; the deck's own
                `auto-fit` grid already collapses to one column on a phone, so the two blocks stack
                rather than needing a breakpoint of their own.
              */}
              <section aria-label="Earnings summary" className="min-w-0">
                <CoachDeck items={deckItems} />
              </section>

              {referralCode ? <ReferralIdentity code={referralCode} link={referralLink} /> : null}

              {/*
                `Affiliate.dc.html:163-168` draws this as the wide data panel: one card, the head
                inside a band at `22px 26px`, the table running edge to edge under it. It shipped
                as a bare heading stack above an unwrapped `DataTable`, which is the same content
                with the card taken off -- so the eyebrow and the name floated on the page ground
                and the table's own toolbar band read as the panel's head. It is the third of the
                three drawings the shape was established from, and the only one outside the coach
                shell; `coach.css` reaches it because the `CoachScale` above stamps the role.
              */}
              <Surface
                aria-labelledby="referrals-heading"
                className="flex min-w-0 flex-col"
                variant="panel"
              >
                <SurfaceHeader
                  overline="Everyone who joined on your link"
                  scale="coach-data"
                  title="Referred coaches"
                  titleAs="h2"
                  titleId="referrals-heading"
                />
                <DataTable
                  ariaLabel="Referred coaches"
                  columns={referralColumns}
                  data={referralRows}
                  emptyState={<p className={`py-[var(--s-4)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>No referred coaches are recorded.</p>}
                  getRowId={(row) => row.rowId}
                  rowLabel={{ singular: "row", plural: "rows" }}
                  toolbar={(
                    <ExportMenu
                      filename="setterfi-affiliate-referrals"
                      mode="server"
                      query={{
                        columns: ["businessName", "accountStatus", "commissionEarnedUsd"],
                        order: "created_desc",
                      }}
                      resource="affiliate-referrals"
                    />
                  )}
                />
              </Surface>
              <ReferralPrivacyNote />

              <section
                aria-labelledby="payouts-heading"
                className="flex min-w-0 flex-col gap-[var(--s-3)]"
              >
                <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
                  <span className={COACH_EYEBROW_CLASS}>What has reached your bank</span>
                  <h2 className={`m-0 ${SECTION_NAME_CLASS}`} id="payouts-heading">Payouts</h2>
                </div>
                {/*
                  Both halves of this sentence are enforced, not promised. A payout row cannot read
                  sent without a reference: `commission_payout_events_shape_chk` requires a non
                  blank reference and a paid-on date for `kind = 'sent'`, and the tables are append
                  only, so there is no path that records the state without the evidence.
                */}
                <Prose className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
                  A payout only reads sent once a bank reference is recorded against it. Match that
                  reference to your statement. SetterFi records the payment, your bank makes it.
                </Prose>
                <DataTable
                  ariaLabel="Payout history"
                  columns={payoutColumns}
                  data={payoutRows}
                  emptyState={<p className={`py-[var(--s-4)] ${COACH_READING_CLASS} text-[color:var(--muted)]`}>No payout history was returned for your account.</p>}
                  getRowId={(row) => row.rowId}
                  rowLabel={{ singular: "payout", plural: "payouts" }}
                  toolbar={(
                    <ExportMenu
                      filename="setterfi-affiliate-payout-history"
                      mode="local"
                      rows={payoutRows.map((payout) => ({
                        amount: payout.amountCents / 100,
                        recordedOn: payout.recordedOn,
                        reference: payout.reference,
                        status: affiliatePayoutLabel(payout),
                      }))}
                    />
                  )}
                />
              </section>

              {/*
                Terms are something SetterFi sets, not something the affiliate edits, so this is a
                well rather than a card: it states a value rather than offering a control. The
                unapproved marker stays a real status beside the heading, because a placeholder
                that does not say it is a placeholder is the honest-states failure.
              */}
              <Surface className="max-w-[var(--measure-prose)] p-[var(--s-5)]" variant="well">
                <div className="flex flex-wrap items-center justify-between gap-[var(--s-2)]">
                  <span className={COACH_EYEBROW_CLASS}>Partner terms</span>
                  <Status label="Demo placeholder: unapproved" tone="warning" treatment="bare" />
                </div>
                {/*
                  15px, not the 12.5px this printed at before. Terms are the one block on the page
                  with legal consequence for the reader, and a footnote a partner cannot read is a
                  footnote that may as well say nothing -- which is the round-1 demo feedback this
                  whole port answers.
                */}
                <Prose className="mt-[var(--s-2)] text-[15px] leading-[1.5] text-[color:var(--body)]">
                  {termsCopy ?? "Partner terms have not been approved or configured."}
                </Prose>
              </Surface>
            </>
          ) : null}
        </>
      )}
    </CoachScale>
  );
}
