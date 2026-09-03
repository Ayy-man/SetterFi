"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import { ExternalLink } from "@/components/kit/icons";

import { Callout } from "@/components/kit/callout";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { CurrencyInput } from "@/components/kit/currency-input";
import { DataState } from "@/components/kit/data-state";
import { DataTable, everyRowIsTest } from "@/components/kit/data-table";
import { RecordSheet } from "@/components/kit/record-sheet";
import { DateField } from "@/components/kit/date-field";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { KeyValue } from "@/components/kit/key-value";
import { KitButton, Status, StatusAbsent } from "@/components/kit/atomics";
import type { StateTone } from "@/components/kit/state-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ConsoleDeck } from "@/components/kit/console-deck";
import { DeckPanel } from "@/components/kit/deck-panel";
import { ListPage } from "@/components/kit/templates/list-page";
import { TierCommercialTerms } from "@/components/workspace/live/tier-commercial-terms";
import { MoneySurfaceGuard, moneyPageHeader } from "@/components/workspace/live/admin-money-shell";
import type { PricingHistoryEntry } from "@/components/workspace/live/admin-money-pricing-history";
import { moneyPageAccessStatus } from "@/components/workspace/live/view-models";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import { workspaceCountFormat, workspaceDateFormat } from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

type PlatformRole = "owner" | "admin" | "success";

export type StripeReadinessReceipt = {
  connectionStatus: "connected" | "incomplete";
  capabilityStatus: "available" | "missing";
  checkedAt: string;
  receiptStatus: "received";
};

export type TierImpactById = Readonly<
  Record<
    string,
    {
      effectiveAt: string;
      affectedWorkspaceCount: number;
    }
  >
>;

/**
 * What each client is actually charged: the plan their live subscription price maps to, and the
 * negotiated price standing over it, if any. Read on the server by `render-tiers-page.tsx`, which
 * is also where the join is explained. `null` means the read failed -- the surface then says the
 * plan is unknown rather than printing the standard price and being wrong about it.
 */
export type ClientPricingByTenantId = Readonly<
  Record<
    string,
    {
      tierId: string | null;
      tierName: string | null;
      tierPriceCents: number | null;
      override: {
        priceCents: number;
        effectiveAt: string;
        endsAt: string | null;
        reason: string;
      } | null;
    }
  >
>;

export type AdminMoneyTiersProps = {
  surface: "tiers";
  actorRole: PlatformRole;
  chrome?: "page" | "embedded";
  enabled: boolean;
  authorized: boolean;
  /**
   * The audit-write outcome for a role-boundary refusal, handed straight to `MoneySurfaceGuard`.
   * Absent on every arm that is not a refusal; the guard treats absence as "not recorded", which
   * is the safe direction for a page that cannot see its own audit result.
   */
  refusalRecord?: MoneyRefusalRecord;
  stripeReadinessReceipt: StripeReadinessReceipt | null;
  stripeActionHref: string;
  tierImpactById: TierImpactById | null;
  clientPricingByTenantId: ClientPricingByTenantId | null;
  /**
   * Null when the history could not be read, which is different from an empty array: no plan has
   * ever been repriced. The panel says which one it is rather than drawing an empty table for both.
   */
  pricingHistory?: readonly PricingHistoryEntry[] | null;
};

export type { PricingHistoryEntry };

/**
 * One surface, not two views of one: the plans are the subject and the client book is where those
 * prices get bent for a single account, so they read down the page rather than behind a tab strip
 * that made the reader choose between the price and who is not paying it. `/admin/tiers/overrides`
 * still resolves: it redirects to the `#client-overrides` band below, so a saved link lands on the
 * rows it was saved for instead of on a second copy of this page under a second name.
 */

type TierRow = {
  id: string;
  name: string;
  priceCents: number;
  callAllowance: number;
  fairUseCap: number | null;
  fairUseNote: string | null;
  active: boolean;
  updatedAt: string | null;
  dataLabel: string | null;
};

type ClientRow = {
  tenantId: string;
  businessName: string;
  accountStatus: string | null;
  subscriptionStatus: string | null;
  providerUpdatedAt: string | null;
  currentPeriodEnd: string | null;
  pendingTierId: string | null;
  pendingEffectiveAt: string | null;
  dataLabel: string | null;
};

type TierDraft = {
  priceCents: number | null;
  callAllowance: number | null;
  fairUseCap: number | null;
  fairUseNote: string;
};

type OverrideDraft = {
  priceCents: number | null;
  effectiveAt: Date | null;
  endsAt: Date | null;
};

type BlockingBannerProps = {
  stripeReadinessReceipt: StripeReadinessReceipt | null;
  stripeActionHref: string;
  tierImpactAvailable: boolean;
};

type BannerCopy = {
  title: string;
  body: string;
  actionLabel?: string;
  actionHref?: string;
};

const EXPORT_REASON = "admin-money-surface-read";
const EMPTY_TIER_DRAFT: TierDraft = {
  priceCents: null,
  callAllowance: null,
  fairUseCap: null,
  fairUseNote: "",
};
const EMPTY_OVERRIDE_DRAFT: OverrideDraft = {
  priceCents: null,
  effectiveAt: null,
  endsAt: null,
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Money data did not include the expected record identity.");
  }
  return value;
}

function optionalText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function requiredInteger(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error("Money data included an invalid amount or allowance.");
  }
  return value;
}

function parseTierRows(value: unknown): TierRow[] {
  if (!Array.isArray(value)) throw new Error("Plan data was not returned as a list.");
  return value.map((item) => {
    if (!record(item)) throw new Error("Plan data included an invalid row.");
    const fairUseCap = item.fairUseCap;
    return {
      id: requiredText(item, "id"),
      name: requiredText(item, "name"),
      priceCents: requiredInteger(item, "priceCents"),
      callAllowance: requiredInteger(item, "callAllowance"),
      fairUseCap:
        fairUseCap === null
          ? null
          : typeof fairUseCap === "number" && Number.isSafeInteger(fairUseCap)
            ? fairUseCap
            : null,
      fairUseNote: optionalText(item, "fairUseNote"),
      active: item.active === true,
      updatedAt: optionalText(item, "updatedAt"),
      dataLabel: optionalText(item, "dataLabel"),
    };
  });
}

function parseClientRows(value: unknown): ClientRow[] {
  if (!Array.isArray(value)) throw new Error("Client billing data was not returned as a list.");
  return value.map((item) => {
    if (!record(item)) throw new Error("Client billing data included an invalid row.");
    return {
      tenantId: requiredText(item, "tenantId"),
      businessName: requiredText(item, "businessName"),
      accountStatus: optionalText(item, "accountStatus"),
      subscriptionStatus: optionalText(item, "subscriptionStatus"),
      providerUpdatedAt: optionalText(item, "providerUpdatedAt"),
      currentPeriodEnd: optionalText(item, "currentPeriodEnd"),
      pendingTierId: optionalText(item, "pendingTierId"),
      pendingEffectiveAt: optionalText(item, "pendingEffectiveAt"),
      dataLabel: optionalText(item, "dataLabel"),
    };
  });
}

async function readJson(response: Response, message: string) {
  if (!response.ok) throw new Error(message);
  return response.json() as Promise<unknown>;
}

async function fetchMoneyRows(signal?: AbortSignal) {
  const query = `format=json&reason=${encodeURIComponent(EXPORT_REASON)}`;
  const [tierResponse, clientResponse] = await Promise.all([
    fetch(`/api/exports/billing-tiers?${query}`, { cache: "no-store", signal }),
    fetch(`/api/exports/platform-billing?${query}`, { cache: "no-store", signal }),
  ]);
  const [tierPayload, clientPayload] = await Promise.all([
    readJson(tierResponse, "Plan data could not be loaded."),
    readJson(clientResponse, "Client billing data could not be loaded."),
  ]);
  return {
    tiers: parseTierRows(tierPayload),
    clients: parseClientRows(clientPayload),
  };
}

/**
 * Seeded copy carries a trailing "(demo)" so a row can never be mistaken for a real one, which
 * reads as a typo once it lands inside a sentence. The page-level provenance line says the same
 * thing once, in the right place, so the marker comes out of the prose.
 */
function withoutDemoMarker(value: string) {
  return value.replace(/\s*\(demo\)\s*$/i, "").trim();
}

function fairUseSentence(tier: TierRow) {
  if (tier.fairUseNote) return withoutDemoMarker(tier.fairUseNote) || tier.fairUseNote;
  if (tier.fairUseCap === null) return "No fair-use limit recorded.";
  return `Soft cap at ${workspaceCountFormat.format(tier.fairUseCap)} booked calls.`;
}

function customerCountLabel(count: number | undefined) {
  if (count === undefined) return "Customer count unavailable";
  return `${workspaceCountFormat.format(count)} ${count === 1 ? "customer" : "customers"}`;
}

/**
 * A plan reads as a card, not a table row: name, price, what is included, and
 * the fair-use sentence in the coach's words. Absent fields say so.
 */
function PlanCard({
  tier,
  customerCount,
  mostClients,
  actionsDisabled,
  onEdit,
}: {
  tier: TierRow;
  customerCount: number | undefined;
  /** True only for the single plan with the most customers, and only when the counts are real. */
  mostClients: boolean;
  actionsDisabled: boolean;
  onEdit: () => void;
}) {
  return (
    <DeckPanel
      /* The count leads as the eyebrow because it is the fact that ranks the three plans against
         each other, and it frees the name to be the plain word a reader is looking for. */
      eyebrow={customerCountLabel(customerCount)}
      figure={(
        <>
          {money(tier.priceCents, "USD")}
          {/* The cadence rides beside the figure rather than under it, because "$299.00" on its
              own is a price with no period attached and this page sells subscriptions. Small and
              muted so it reads as the figure's unit rather than as a second number. */}
          <span className="ml-[6px] align-baseline font-sans text-[12.5px] font-normal tracking-normal text-[color:var(--muted)]">
            a month
          </span>
        </>
      )}
      footer={(
        <div className="flex flex-col gap-[var(--s-3)]">
          <span className="flex min-w-0 flex-wrap items-center gap-[var(--s-2)]">
            {/* A measured fact about the book, not a marketing badge: it names the plan that
                currently has the most customers, and it disappears when a count is unavailable or
                two plans tie. */}
            {mostClients ? <Status label="Most clients" tone="neutral" treatment="bare" /> : null}
            {tier.active ? null : <Status label="Inactive" tone="neutral" treatment="bare" />}
            <span className="text-[11.5px] text-[color:var(--faint)]">
              Updated {displayDate(tier.updatedAt)}
            </span>
          </span>
          {/*
            A button, not a menu. `AdminPlans.dc.html:249,263,277` draws a full-width 34px control
            reading "Edit this plan" on every card, and this was a one-item `ActionMenu` -- a
            trigger that opened to reveal a single option, so reaching the only thing behind it
            cost a click and a decision, and the disclosure implied choices that were never there.
            Editing is also the only mutation this page has: there is no create-tier action on
            `src/app/api/platform/billing/handler.ts` for a second menu item to ever arrive as.

            `size="lg"` is the kit's 34px, which is the height the artboard draws, and `secondary`
            is its `--line` hairline over `--control-fill` in `--body`, which is the recipe the
            drawn control spells out inline. The accessible name carries the plan after the visible
            words rather than replacing them, because three cards otherwise offer three buttons
            named identically, and a name that dropped "Edit this plan" would no longer contain the
            label a speech user reads off the screen.
          */}
          <KitButton
            aria-label={`Edit this plan: ${tier.name}`}
            className="w-full"
            disabled={actionsDisabled}
            onClick={onEdit}
            size="lg"
            variant="secondary"
          >
            Edit this plan
          </KitButton>
        </div>
      )}
      /* The screen's one fill, and it is spent on a measurement rather than on a favourite: the
         plan that currently carries the most clients. It disappears the moment the counts cannot
         be read or two plans tie, which is also when the "Most clients" status disappears -- the
         fill and the label are the same claim, so they may never disagree. */
      drench={mostClients ? "info" : undefined}
      headingId={`plan-${tier.id}-title`}
      name={tier.name}
      sentence={`${workspaceCountFormat.format(tier.callAllowance)} booked calls per month`}
    >
      {/* The fair-use line is the second sentence a deck panel is not allowed to have in its
          `sentence` slot, so it sits in the body under the first one -- it is a different claim
          (what happens past the allowance) rather than a continuation of the same one. */}
      <p className="mt-[8px] mb-0 max-w-[var(--measure-deck)] text-[11.5px] leading-[1.45] text-[color:var(--faint)]">
        {fairUseSentence(tier)}
      </p>
    </DeckPanel>
  );
}

function displayDate(value: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Not recorded"
    : workspaceDateFormat.format(parsed);
}

function displayDraftDate(value: Date | null) {
  return value ? workspaceDateFormat.format(value) : "Not recorded";
}

function sentenceCase(value: string | null) {
  if (!value) return "Not recorded";
  const normalized = value.replaceAll("_", " ").replaceAll("-", " ").trim();
  return normalized
    ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1).toLowerCase()}`
    : "Not recorded";
}

/**
 * `info` is reserved for a state that is genuinely in progress. It sits close enough to the accent
 * that a column of blue pills reads as a column of selected rows, so an unrecognised status is
 * neutral rather than informational, and a missing one is an absence (`kind="none"`), not a pill.
 */
function subscriptionTone(value: string): StateTone {
  if (value === "active") return "good";
  if (value === "past_due" || value === "unpaid") return "critical";
  if (value === "trialing" || value === "incomplete") return "warning";
  return "neutral";
}

/**
 * The band a client row sits in. An unrecorded subscription is its own band rather than being
 * dropped into the last one: a client the mirror has said nothing about is a different problem
 * from a client whose subscription is active.
 */
function subscriptionBand(row: ClientRow) {
  return row.subscriptionStatus
    ? sentenceCase(row.subscriptionStatus)
    : "No subscription recorded";
}

/**
 * A signed difference against the plan's own price, so an override reads as a decision rather
 * than as a second number to subtract in your head. It is omitted rather than guessed when the
 * plan price could not be read.
 */
function overrideDelta(overridePriceCents: number, tierPriceCents: number | null) {
  if (tierPriceCents === null || overridePriceCents === tierPriceCents) return null;
  const difference = overridePriceCents - tierPriceCents;
  return `${difference > 0 ? "+" : "\u2212"}${money(Math.abs(difference), "USD")}`;
}

const PRICING_GROUPS = [
  { id: "override", label: "Client overrides" },
  { id: "standard", label: "On standard pricing" },
] as const;

/** Worst first. Anything the mirror adds later is appended by the table under its own name. */
const CLIENT_GROUPS = [
  { id: "Past due", label: "Past due" },
  { id: "Unpaid", label: "Unpaid" },
  { id: "Incomplete", label: "Payment setup incomplete" },
  { id: "Trialing", label: "Trial" },
  { id: "Active", label: "Active" },
  { id: "No subscription recorded", label: "No subscription recorded" },
] as const;

function integerFromInput(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function tierDraftError(draft: TierDraft) {
  if (draft.priceCents === null || draft.priceCents < 0) {
    return "Enter a valid monthly price.";
  }
  if (draft.callAllowance === null || draft.callAllowance < 0) {
    return "Enter a valid included-call allowance.";
  }
  if (draft.fairUseCap !== null && draft.fairUseCap < draft.callAllowance) {
    return "The fair-use cap cannot be lower than the included-call allowance.";
  }
  return null;
}

function overrideDraftError(draft: OverrideDraft) {
  if (draft.priceCents === null || draft.priceCents < 0) {
    return "Enter a valid override price.";
  }
  if (!draft.effectiveAt) return "Choose when the override takes effect.";
  if (draft.endsAt && draft.endsAt <= draft.effectiveAt) {
    return "The end date must be after the effective date.";
  }
  return null;
}

/**
 * What is blocking a pricing CHANGE, on a page the reader can still read.
 *
 * Refusals used to live here too -- the billing flag being off, and the role boundary -- which
 * meant Plans answered a refused reader with a warning callout of its own while Revenue and Cost
 * evidence answered the same refusal with `MoneySurfaceGuard`'s panel and Affiliates with a third
 * thing. One drawn screen, four behaviours. Both refusals moved to the guard, so everything left
 * in here is the same shape: the values below are readable and only the change is refused.
 */
function blockingCopy({
  stripeReadinessReceipt,
  stripeActionHref,
  tierImpactAvailable,
}: BlockingBannerProps): BannerCopy | null {
  if (
    !stripeReadinessReceipt ||
    stripeReadinessReceipt.receiptStatus !== "received" ||
    !Number.isFinite(Date.parse(stripeReadinessReceipt.checkedAt))
  ) {
    return {
      title: "Pricing changes are blocked until Stripe is verified",
      body: "No current Stripe account readback was received. Existing plan and client values remain visible below, but no pricing change can be submitted.",
      actionLabel: "Review Stripe account",
      actionHref: stripeActionHref,
    };
  }
  if (stripeReadinessReceipt.connectionStatus !== "connected") {
    return {
      title: "Pricing changes are blocked until Stripe setup is complete",
      body: "Stripe confirmed the account, but its required business details are incomplete. Existing values remain visible below while pricing actions stay blocked.",
      actionLabel: "Complete Stripe setup",
      actionHref: stripeActionHref,
    };
  }
  if (stripeReadinessReceipt.capabilityStatus !== "available") {
    return {
      title: "Pricing changes are blocked until Stripe finishes its review",
      body: "Stripe reports that the payments capability is unavailable. Existing plan and client values remain visible below, but no pricing change can be submitted.",
      actionLabel: "Resolve Stripe requirements",
      actionHref: stripeActionHref,
    };
  }
  if (!tierImpactAvailable) {
    return {
      title: "Pricing changes are blocked until impact can be verified",
      body: "Current workspace assignments could not be read, so the confirmation cannot show who the plan change affects. Existing values remain visible below.",
      actionLabel: "Reload impact data",
      actionHref: "/admin/tiers",
    };
  }
  return null;
}

export function MoneyBlockingBanner(props: BlockingBannerProps) {
  const copy = blockingCopy(props);
  if (!copy) return null;

  return (
    // The kit callout, not a second bespoke banner: one hairline border on all four sides and a
    // single tone dot before the title. Nothing on this page grows a coloured edge.
    <Callout
      body={(
        <>
          {copy.body}
          {copy.actionHref && copy.actionLabel ? (
            <a
              className={`${buttonVariants({ size: "sm", variant: "outline" })} mt-[var(--s-3)] flex w-fit`}
              href={copy.actionHref}
              rel="noreferrer"
              target="_blank"
            >
              {copy.actionLabel}
              <ExternalLink aria-hidden />
            </a>
          ) : null}
        </>
      )}
      className="mb-[var(--s-5)]"
      title={copy.title}
      // Blocked is waiting, not broken: the values below still read, only the change is refused.
      tone="warning"
    />
  );
}

function TierEditor({
  draft,
  onDraftChange,
  onOpenChange,
  onReview,
  open,
  tier,
}: {
  draft: TierDraft;
  onDraftChange: (draft: TierDraft) => void;
  onOpenChange: (open: boolean) => void;
  onReview: () => void;
  open: boolean;
  tier: TierRow | null;
}) {
  const error = tierDraftError(draft);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!error) onReview();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full max-w-[var(--drawer-w)] gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-[var(--shadow-drawer)] transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none sm:max-w-[var(--drawer-w)]"
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <SheetHeader className="gap-[var(--s-1)] border-b border-[var(--line)] p-[var(--s-5)]">
            <SheetTitle className="text-section text-[color:var(--ink)]">
              Edit {tier?.name ?? "plan"}
            </SheetTitle>
            <SheetDescription className="text-body text-[color:var(--muted)]">
              Set the new terms, then review the impact and record a reason.
            </SheetDescription>
          </SheetHeader>
          <div className="relative flex min-h-0 flex-1 flex-col gap-[var(--s-4)] overflow-y-auto p-[var(--s-5)]">
            <CurrencyInput
              currency="USD"
              label="Monthly price"
              onChangeCents={(priceCents) => onDraftChange({ ...draft, priceCents })}
              valueCents={draft.priceCents}
            />
            <Field label="Included calls" required>
              <Input
                min="0"
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    callAllowance: integerFromInput(event.currentTarget.value),
                  })
                }
                step="1"
                type="number"
                value={draft.callAllowance ?? ""}
              />
            </Field>
            <Field
              hint="Leave blank when the plan has no recorded cap."
              label="Fair-use cap"
            >
              <Input
                min="0"
                onChange={(event) =>
                  onDraftChange({
                    ...draft,
                    fairUseCap: integerFromInput(event.currentTarget.value),
                  })
                }
                step="1"
                type="number"
                value={draft.fairUseCap ?? ""}
              />
            </Field>
            <Field label="Fair-use note">
              <Textarea
                onChange={(event) =>
                  onDraftChange({ ...draft, fairUseNote: event.currentTarget.value })
                }
                value={draft.fairUseNote}
              />
            </Field>
            {error ? (
              <p className="text-body text-[color:var(--critical)]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="flex-row justify-end gap-[var(--s-2)] border-t border-[var(--line)] p-[var(--s-4)]">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={Boolean(error)} type="submit">
              Review change
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function OverrideEditor({
  client,
  draft,
  onDraftChange,
  onOpenChange,
  onReview,
  open,
}: {
  client: ClientRow | null;
  draft: OverrideDraft;
  onDraftChange: (draft: OverrideDraft) => void;
  onOpenChange: (open: boolean) => void;
  onReview: () => void;
  open: boolean;
}) {
  const error = overrideDraftError(draft);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!error) onReview();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full max-w-[var(--drawer-w)] gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-[var(--shadow-drawer)] transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none sm:max-w-[var(--drawer-w)]"
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <SheetHeader className="gap-[var(--s-1)] border-b border-[var(--line)] p-[var(--s-5)]">
            <SheetTitle className="text-section text-[color:var(--ink)]">
              Set override for {client?.businessName ?? "client"}
            </SheetTitle>
            <SheetDescription className="text-body text-[color:var(--muted)]">
              Choose the price and date window, then review the impact and record a reason.
            </SheetDescription>
          </SheetHeader>
          <div className="relative flex min-h-0 flex-1 flex-col gap-[var(--s-4)] overflow-y-auto p-[var(--s-5)]">
            <CurrencyInput
              currency="USD"
              label="Override price"
              onChangeCents={(priceCents) => onDraftChange({ ...draft, priceCents })}
              valueCents={draft.priceCents}
            />
            <DateField
              label="Effective at"
              onChange={(effectiveAt) => onDraftChange({ ...draft, effectiveAt })}
              value={draft.effectiveAt}
            />
            <DateField
              error={
                draft.endsAt && draft.effectiveAt && draft.endsAt <= draft.effectiveAt
                  ? "Choose a date after the effective date."
                  : undefined
              }
              label="Ends at"
              min={draft.effectiveAt ?? undefined}
              onChange={(endsAt) => onDraftChange({ ...draft, endsAt })}
              value={draft.endsAt}
            />
            {error ? (
              <p className="text-body text-[color:var(--critical)]" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <SheetFooter className="flex-row justify-end gap-[var(--s-2)] border-t border-[var(--line)] p-[var(--s-4)]">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={Boolean(error)} type="submit">
              Review override
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Pricing history: every version of every plan's terms, newest first.
 *
 * `public.tier_price_versions` is append-only and every column the canvas asks for is NOT NULL on
 * it -- `effective_at` is When, the value columns are What changed, `actor_id` is Who, and
 * `audit_id` ties the row to the audit entry that authorised it. The only thing drawn on the
 * canvas that this table cannot answer is "Clients affected": no historical count is stored, so
 * the column says how many clients are on that plan NOW and its header says so. Printing a
 * historical-looking number derived from today's subscriptions would be a figure nobody measured.
 */
function PricingHistoryPanel({
  entries,
  tierImpactById,
}: {
  entries: readonly PricingHistoryEntry[] | null;
  tierImpactById: TierImpactById | null;
}) {
  const columns = useMemo<ColumnDef<PricingHistoryEntry>[]>(
    () => [
      {
        accessorKey: "effectiveAt",
        header: "When",
        meta: { label: "When", minWidth: 130 },
        cell: ({ row }) => (
          <span className="text-[color:var(--body)]">{displayDate(row.original.effectiveAt)}</span>
        ),
      },
      {
        accessorKey: "tierName",
        header: "Plan",
        meta: { cellKind: "identity", label: "Plan", minWidth: 160 },
        cell: ({ row }) => row.original.tierName
          ? (
            <span className="font-medium text-[color:var(--ink)]">{row.original.tierName}</span>
          )
          : <StatusAbsent label="Plan no longer listed" />,
      },
      {
        id: "changed",
        accessorFn: (row) => row.changed ? row.changed.join(", ") : "First recorded terms",
        header: "What changed",
        meta: { label: "What changed", minWidth: 260 },
        cell: ({ row }) => {
          const changed = row.original.changed;
          // The oldest version of a plan has nothing to be a change FROM, and calling it one
          // would invent a previous price that was never recorded.
          if (!changed) return <StatusAbsent label="First recorded terms" />;
          return (
            <span className="flex min-w-0 flex-col">
              {changed.map((line) => (
                <span className="text-[color:var(--body)]" key={line}>{line}</span>
              ))}
            </span>
          );
        },
      },
      {
        id: "actor",
        accessorFn: (row) => row.actorName ?? "",
        header: "Who",
        meta: { label: "Who", minWidth: 160 },
        cell: ({ row }) => row.original.actorName
          ? <span className="text-[color:var(--body)]">{row.original.actorName}</span>
          // `actor_id` is NOT NULL, so the actor exists; only the name lookup came back empty.
          : <StatusAbsent label="Name not on the account" />,
      },
      {
        id: "clientsNow",
        accessorFn: (row) => tierImpactById?.[row.tierId]?.affectedWorkspaceCount ?? -1,
        header: "Clients on this plan now",
        meta: { label: "Clients on this plan now", minWidth: 150 },
        cell: ({ row }) => {
          const count = tierImpactById?.[row.original.tierId]?.affectedWorkspaceCount;
          return typeof count === "number"
            ? <span className="text-[color:var(--body)]">{workspaceCountFormat.format(count)}</span>
            : <StatusAbsent label="Not counted" />;
        },
      },
      {
        accessorKey: "reason",
        header: "Reason",
        meta: { label: "Reason", minWidth: 240 },
        cell: ({ row }) => (
          <span className="text-[color:var(--muted)]">{row.original.reason}</span>
        ),
      },
    ],
    [tierImpactById],
  );

  return (
    <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
      <p className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-body)] text-[color:var(--muted)]">
        Every version of a plan&apos;s terms, newest first. Existing subscriptions keep the price
        they signed at until they change plan, and each row carries the audit entry that authorised
        it.
      </p>
      {entries === null ? (
        <DataState
          body="Plan pricing history could not be read. The plan cards above are unaffected."
          kind="unavailable"
          title="Pricing history is unavailable"
        />
      ) : (
        <DataTable
          ariaLabel="Pricing history"
          columns={columns}
          data={[...entries]}
          emptyState={(
            <DataState
              body="A row appears here the first time a plan's price, allowance or fair-use cap is changed."
              kind="empty"
              title="No plan has been repriced yet"
            />
          )}
          exportResource={{
            mode: "local",
            filename: "setterfi-pricing-history",
            rows: entries.map((entry) => ({
              effectiveAt: entry.effectiveAt,
              tierId: entry.tierId,
              tierName: entry.tierName,
              priceCents: entry.priceCents,
              callAllowance: entry.callAllowance,
              fairUseCap: entry.fairUseCap,
              changed: entry.changed ? entry.changed.join("; ") : null,
              actorName: entry.actorName,
              reason: entry.reason,
              auditId: entry.auditId,
              clientsOnThisPlanNow:
                tierImpactById?.[entry.tierId]?.affectedWorkspaceCount ?? null,
            })),
          }}
          getRowId={(row) => row.id}
          ordering="newest first"
          pagination={{ mode: "offset", pageSize: 25 }}
          rowLabel={{ singular: "price version", plural: "price versions" }}
        />
      )}
    </section>
  );
}

export function AdminMoneyTiers({
  actorRole,
  chrome = "page",
  authorized,
  refusalRecord,
  enabled,
  stripeReadinessReceipt,
  stripeActionHref,
  tierImpactById,
  clientPricingByTenantId,
  pricingHistory = null,
}: AdminMoneyTiersProps) {
  const accessStatus = moneyPageAccessStatus(actorRole, "tiers");
  const canRead = enabled && authorized && accessStatus === 200;
  const receiptCheckedAt = stripeReadinessReceipt
    ? Date.parse(stripeReadinessReceipt.checkedAt)
    : Number.NaN;
  const stripeReady = Boolean(
    stripeReadinessReceipt &&
      Number.isFinite(receiptCheckedAt) &&
      stripeReadinessReceipt.receiptStatus === "received" &&
      stripeReadinessReceipt.connectionStatus === "connected" &&
      stripeReadinessReceipt.capabilityStatus === "available",
  );
  const actionsBlocked = !canRead || !stripeReady || !tierImpactById;
  const [tiers, setTiers] = useState<TierRow[]>([]);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [loading, setLoading] = useState(canRead);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedTier, setSelectedTier] = useState<TierRow | null>(null);
  const [tierDraft, setTierDraft] = useState<TierDraft>(EMPTY_TIER_DRAFT);
  const [tierEditorOpen, setTierEditorOpen] = useState(false);
  const [tierConfirmOpen, setTierConfirmOpen] = useState(false);
  const [selectedClient, setSelectedClient] = useState<ClientRow | null>(null);
  const [sheetClient, setSheetClient] = useState<ClientRow | null>(null);
  const [overrideDraft, setOverrideDraft] =
    useState<OverrideDraft>(EMPTY_OVERRIDE_DRAFT);
  const [overrideEditorOpen, setOverrideEditorOpen] = useState(false);
  const [overrideConfirmOpen, setOverrideConfirmOpen] = useState(false);

  const loadData = useCallback(async () => {
    if (!canRead) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchMoneyRows();
      setTiers(result.tiers);
      setClients(result.clients);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "Money data could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await fetchMoneyRows(controller.signal);
        if (controller.signal.aborted) return;
        setTiers(result.tiers);
        setClients(result.clients);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setLoadError(
          cause instanceof Error ? cause.message : "Money data could not be loaded.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [canRead]);

  function openTierEditor(tier: TierRow) {
    setSelectedTier(tier);
    setTierDraft({
      priceCents: tier.priceCents,
      callAllowance: tier.callAllowance,
      fairUseCap: tier.fairUseCap,
      fairUseNote: tier.fairUseNote ?? "",
    });
    setTierEditorOpen(true);
  }

  function openOverrideEditor(client: ClientRow) {
    setSelectedClient(client);
    setOverrideDraft(EMPTY_OVERRIDE_DRAFT);
    setOverrideEditorOpen(true);
  }

  async function postAction(body: Record<string, unknown>) {
    return fetch("/api/platform/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function confirmTier(input: { reason?: string }): Promise<Result> {
    if (
      actionsBlocked ||
      !selectedTier ||
      !tierImpactById?.[selectedTier.id] ||
      tierDraftError(tierDraft) ||
      !input.reason
    ) {
      return { ok: false, message: "Review the plan terms and enter a reason." };
    }
    const response = await postAction({
      action: "update_tier",
      tierId: selectedTier.id,
      priceCents: tierDraft.priceCents,
      callAllowance: tierDraft.callAllowance,
      fairUseCap: tierDraft.fairUseCap,
      fairUseNote: tierDraft.fairUseNote.trim() || null,
      reason: input.reason,
    });
    if (!response.ok) {
      return { ok: false, message: "The plan update could not be recorded." };
    }
    const payload = (await response.json()) as unknown;
    const result = record(payload) && record(payload.result) ? payload.result : undefined;
    if (
      typeof result?.priceVersionId !== "string" ||
      typeof result?.auditId !== "number"
    ) {
      return { ok: false, message: "The plan update receipt could not be verified." };
    }
    await loadData();
    return {
      ok: true,
      receipt: { auditId: result.auditId, actionKey: "billing.tier.updated" },
    };
  }

  async function confirmOverride(input: { reason?: string }): Promise<Result> {
    if (
      actionsBlocked ||
      !selectedClient ||
      overrideDraftError(overrideDraft) ||
      !input.reason
    ) {
      return { ok: false, message: "Review the override terms and enter a reason." };
    }
    const response = await postAction({
      action: "set_tenant_override",
      tenantId: selectedClient.tenantId,
      priceCents: overrideDraft.priceCents,
      effectiveAt: overrideDraft.effectiveAt?.toISOString(),
      endsAt: overrideDraft.endsAt?.toISOString() ?? null,
      reason: input.reason,
    });
    if (!response.ok) {
      return { ok: false, message: "The price override could not be recorded." };
    }
    const payload = (await response.json()) as unknown;
    const result = record(payload) && record(payload.result) ? payload.result : undefined;
    if (
      typeof result?.overrideId !== "string" ||
      typeof result?.auditId !== "number"
    ) {
      return { ok: false, message: "The override receipt could not be verified." };
    }
    await loadData();
    return {
      ok: true,
      receipt: {
        auditId: result.auditId,
        actionKey: "billing.tenant_override.updated",
      },
    };
  }

  const pricingFor = useCallback(
    (tenantId: string) => clientPricingByTenantId?.[tenantId] ?? null,
    [clientPricingByTenantId],
  );
  const tierNameById = useMemo(
    () => new Map(tiers.map((tier) => [tier.id, withoutDemoMarker(tier.name) || tier.name])),
    [tiers],
  );
  /** Override or standard: the only two answers this page exists to give about a client. */
  const pricingBand = useCallback(
    (row: ClientRow) => (pricingFor(row.tenantId)?.override ? "override" : "standard"),
    [pricingFor],
  );

  const clientColumns = useMemo<ColumnDef<ClientRow>[]>(
    () => [
      {
        accessorKey: "businessName",
        header: "Client",
        meta: { cellKind: "identity", label: "Client", minWidth: 240 },
        cell: ({ row }) => <span className="font-medium text-[color:var(--ink)]">{row.original.businessName}</span>,
      },
      {
        // The plan a live subscription price actually maps to. When the mapping could not be read
        // the cell says so: printing the standard plan for a client we cannot place is how a
        // negotiated client silently gets invoiced at list price.
        id: "plan",
        accessorFn: (row) => pricingFor(row.tenantId)?.tierName ?? "Plan not recorded",
        filterFn: "arrIncludesSome",
        header: "Plan",
        meta: { label: "Plan", minWidth: 130 },
        cell: ({ row }) => {
          const name = pricingFor(row.original.tenantId)?.tierName;
          return name
            ? <span className="text-[color:var(--body)]">{withoutDemoMarker(name) || name}</span>
            : <StatusAbsent label="Plan not recorded" />;
        },
      },
      {
        id: "override",
        accessorFn: (row) => {
          const override = pricingFor(row.tenantId)?.override;
          return override ? money(override.priceCents, "USD") : "No override";
        },
        header: "Override",
        meta: { label: "Override", minWidth: 200 },
        cell: ({ row }) => {
          const pricing = pricingFor(row.original.tenantId);
          if (pricing?.override) {
            const delta = overrideDelta(pricing.override.priceCents, pricing.tierPriceCents);
            return (
              <span className="flex min-w-0 flex-col">
                <span className="text-[color:var(--ink)]">
                  {money(pricing.override.priceCents, "USD")} / month{delta ? ` (${delta})` : ""}
                </span>
                {pricing.override.endsAt ? (
                  <span className="text-[color:var(--faint)]">
                    ends {displayDate(pricing.override.endsAt)}
                  </span>
                ) : null}
              </span>
            );
          }
          // No override standing. A queued plan change is the only other thing that will move this
          // client's price, and it is a fact from the allowance action, not a prediction.
          if (row.original.pendingTierId) {
            const name = tierNameById.get(row.original.pendingTierId);
            return (
              <span className="text-[color:var(--body)]">
                {name ? `Moves to ${name}` : "Plan change queued"}
                {row.original.pendingEffectiveAt
                  ? ` on ${displayDate(row.original.pendingEffectiveAt)}`
                  : ""}
              </span>
            );
          }
          return <StatusAbsent label="No override" />;
        },
      },
      {
        // `tenant_price_overrides.reason` is required by the table's own check, so an override row
        // always has one. A standard row has nothing to explain and shows nothing.
        id: "overrideReason",
        accessorFn: (row) => pricingFor(row.tenantId)?.override?.reason ?? "",
        header: "Why",
        meta: { cellKind: "secondary", label: "Why", minWidth: 260 },
        cell: ({ row }) => {
          const reason = pricingFor(row.original.tenantId)?.override?.reason;
          return reason
            ? <span className="block whitespace-normal text-[color:var(--muted)]">{reason}</span>
            : null;
        },
      },
      {
        id: "overrideSince",
        accessorFn: (row) => pricingFor(row.tenantId)?.override?.effectiveAt ?? "",
        header: "Since",
        meta: { cellKind: "secondary", label: "Since", minWidth: 120 },
        cell: ({ row }) => {
          const override = pricingFor(row.original.tenantId)?.override;
          return override
            ? <span>{displayDate(override.effectiveAt)}</span>
            : <StatusAbsent label="Never overridden" />;
        },
      },
      {
        // Subscription is still the state an override decision turns on, and it stays declared so
        // the Filters chip and the Display menu can reach it. The bands now say override or
        // standard, which is what this page is for, so this ships hidden.
        id: "subscriptionBand",
        accessorFn: subscriptionBand,
        filterFn: "arrIncludesSome",
        header: "Subscription",
        meta: { cellKind: "secondary", defaultHidden: true, label: "Subscription" },
      },
      {
        accessorKey: "accountStatus",
        header: "Account",
        meta: { cellKind: "secondary", defaultHidden: true, label: "Account", minWidth: 130 },
        cell: ({ row }) =>
          row.original.accountStatus ? (
            <span className="text-[color:var(--body)]">
              {sentenceCase(row.original.accountStatus)}
            </span>
          ) : (
            <StatusAbsent label="No account state" />
          ),
      },
      {
        accessorKey: "currentPeriodEnd",
        header: "Renews",
        meta: { cellKind: "secondary", defaultHidden: true, label: "Renews" },
        cell: ({ row }) =>
          row.original.currentPeriodEnd ? (
            displayDate(row.original.currentPeriodEnd)
          ) : (
            <StatusAbsent label="No renewal date" />
          ),
      },
      {
        accessorKey: "providerUpdatedAt",
        header: "Provider checked",
        meta: { cellKind: "secondary", defaultHidden: true, label: "Provider checked" },
        cell: ({ row }) =>
          row.original.providerUpdatedAt ? (
            displayDate(row.original.providerUpdatedAt)
          ) : (
            <StatusAbsent label="Never checked" />
          ),
      },
    ],
    [pricingFor, tierNameById],
  );

  const isDemoClient = useCallback((row: ClientRow) => row.dataLabel !== null, []);
  // When every client row is seeded the table drops its per-row chip, so the page-level line is
  // the only thing left saying so -- ask the table's own rule rather than guessing.
  const hasDemoData =
    everyRowIsTest(clients, isDemoClient) ||
    [...tiers, ...clients].some((row) => row.dataLabel !== null);

  /*
   * This page reads two lists -- the plans and the clients on them -- and the chip is a claim
   * about both. All plans real and every client seeded is a mixed page, so it keeps the sentence;
   * the chip ships only when nothing on either list is production data. The word comes from the
   * rows rather than from the first labelled one this page happens to find, which on a page
   * carrying both a demo and a test row would have been whichever sorted first.
   */
  const pageProvenanceKind = wholePageProvenanceKind(
    [...tiers, ...clients],
    (row) => (row.dataLabel === null ? null : row.dataLabel === "Test" ? "test" : "demo"),
  );
  // No `!canRead` arm: `MoneySurfaceGuard` below is the refusal, and this branch used to draw a
  // second one underneath it. What is left is the page's own read outcome.
  const unavailable = loading ? (
    <DataState kind="loading" rows={6} />
  ) : loadError ? (
    <DataState
      body={`${loadError} No pricing action was completed.`}
      kind="unavailable"
      retry={() => void loadData()}
      title="Pricing data could not be loaded"
    />
  ) : null;

  // The measured leader, not a favourite: only when the counts are readable and one plan is
  // strictly ahead of every other.
  const mostClientsTierId = (() => {
    if (!tierImpactById) return null;
    const counted = tiers
      .map((tier) => ({ id: tier.id, count: tierImpactById[tier.id]?.affectedWorkspaceCount ?? 0 }))
      .filter((entry) => entry.count > 0)
      .sort((left, right) => right.count - left.count);
    if (counted.length === 0) return null;
    if (counted.length > 1 && counted[0].count === counted[1].count) return null;
    return counted[0].id;
  })();

  const body = (
    <>
      <MoneySurfaceGuard
        actorRole={actorRole}
        authorized={authorized && accessStatus === 200}
        enabled={enabled}
        refusalRecord={refusalRecord}
        surface="tiers"
      >
      <MoneyBlockingBanner
        stripeActionHref={stripeActionHref}
        stripeReadinessReceipt={stripeReadinessReceipt}
        tierImpactAvailable={tierImpactById !== null}
      />

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-5)] overflow-y-auto">
        {/* One refusal for the whole page, not one per section: a reader who cannot read the
            pricing cannot read either half of it, and saying so twice reads as two faults. */}
        {unavailable}
        {unavailable ? null : (<>
        {/* The plans are the page's subject, so they lead as cards; the client book underneath is
            where those prices are bent for one account. One surface, two bands, no tab strip. */}
        <section className="flex min-w-0 flex-col gap-[var(--s-3)]">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--s-3)]">
            <p className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-body)] text-[color:var(--muted)]">
              A plan change is queued for the next renewal, never applied to a period already
              running.
            </p>
            <ExportMenu
              filename="setterfi-billing-tiers"
              label="Export plans"
              mode="server"
              query={{
                reason: EXPORT_REASON,
                order: "created_desc",
                columns: [
                  "id",
                  "name",
                  "priceCents",
                  "callAllowance",
                  "fairUseCap",
                  "fairUseNote",
                  "active",
                  "updatedAt",
                ],
              }}
              resource="billing-tiers"
            />
          </div>
          {tiers.length === 0 ? (
            <DataState body="No plans have been recorded yet." kind="empty" title="No plans" />
          ) : (
            <ConsoleDeck ariaLabel="Plans">
              {tiers.map((tier) => (
                <PlanCard
                  actionsDisabled={actionsBlocked || !tierImpactById?.[tier.id]}
                  customerCount={tierImpactById?.[tier.id]?.affectedWorkspaceCount}
                  key={tier.id}
                  mostClients={tier.id === mostClientsTierId}
                  onEdit={() => openTierEditor(tier)}
                  tier={tier}
                />
              ))}
            </ConsoleDeck>
          )}
        </section>

        <PricingHistoryPanel entries={pricingHistory} tierImpactById={tierImpactById} />

        {/*
          The terms ledger is a record of what was sold, not a pricing control, so it is gated on
          reading the page rather than on `actionsBlocked`: a blocked Stripe readback stops a plan
          price changing, and it must not stop an operator writing down the price Stripe already
          has. Turning billing off still takes it away, because then the whole page is gone.
        */}
        <TierCommercialTerms
          canRead={canRead}
          tiers={tiers.map((tier) => ({ id: tier.id, name: tier.name }))}
        />

        {/*
          The band `/admin/tiers/overrides` resolves to. That route used to be a second page with
          its own document title, "Client overrides", over this page's "Plans and pricing" heading:
          one surface answering to two names, because the tab strip the title was written for was
          removed when the plans and the client book became one page. The route now redirects to
          this id, so the saved link lands on the rows it was saved for and there is one name for
          one screen. The anchor carries no styling; it is where the URL points.
        */}
        <section className="flex min-w-0 flex-col gap-[var(--s-3)]" id="client-overrides">
          {clientPricingByTenantId === null && canRead && !loading && !loadError ? (
            <Callout
              body="Plan assignments and standing overrides could not be read, so the rows below cannot say which plan a client is on. The plan cards above are unaffected."
              title="Client pricing is unavailable"
              tone="warning"
            />
          ) : null}
          <DataTable
              ariaLabel="Client plans and overrides"
              columns={clientColumns}
              data={clients}
              rowActions={(row) => [{
                id: "override",
                label: "Set price override",
                disabled: actionsBlocked,
                logged: AUDIT_ACTIONS["billing.tenant_override.updated"].microcopy,
                onSelect: () => openOverrideEditor(row),
              }]}
              rowActionsLabel={(row) => `Actions for ${row.businessName}`}
              onRowClick={setSheetClient}
              emptyState={<DataState body="No client billing records have been returned." kind="empty" title="No clients" />}
              exportResource={{
                mode: "local",
                filename: "setterfi-platform-billing",
                rows: clients.map((row) => {
                  const pricing = pricingFor(row.tenantId);
                  return {
                    ...row,
                    tierId: pricing?.tierId ?? null,
                    tierName: pricing?.tierName ?? null,
                    overridePriceCents: pricing?.override?.priceCents ?? null,
                    overrideEffectiveAt: pricing?.override?.effectiveAt ?? null,
                    overrideEndsAt: pricing?.override?.endsAt ?? null,
                    overrideReason: pricing?.override?.reason ?? null,
                  };
                }),
              }}
              facets={[{
                columnId: "subscriptionBand",
                title: "Subscription",
                options: CLIENT_GROUPS.map((group) => ({
                  label: group.label,
                  value: group.id,
                })),
              }]}
              getRowId={(row) => row.tenantId}
              groupBy={pricingBand}
              groups={PRICING_GROUPS}
              pagination={{ mode: "offset", pageSize: 25 }}
              rowLabel={{ singular: "client", plural: "clients" }}
              search={{ columnId: "businessName", placeholder: "Search clients" }}
              testRow={isDemoClient}
            />

          {/* The kebab already exposes the override action; the List template asks that a row
              press reach the same record, with the provider evidence the columns hide. */}
          <RecordSheet
            onOpenChange={(open) => { if (!open) setSheetClient(null); }}
            open={sheetClient !== null}
            primaryAction={sheetClient && !actionsBlocked ? {
              label: "Set price override",
              onClick: () => {
                const row = sheetClient;
                setSheetClient(null);
                openOverrideEditor(row);
              },
            } : undefined}
            logged={AUDIT_ACTIONS["billing.tenant_override.updated"].microcopy}
            sections={sheetClient ? [
              {
                title: "Pricing",
                body: (
                  <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                    <KeyValue
                      label="Plan"
                      layout="stacked"
                      value={pricingFor(sheetClient.tenantId)?.tierName ?? "Plan not recorded"}
                    />
                    <KeyValue
                      label="Override"
                      layout="stacked"
                      value={(() => {
                        const override = pricingFor(sheetClient.tenantId)?.override;
                        return override
                          ? `${money(override.priceCents, "USD")} / month since ${displayDate(override.effectiveAt)}`
                          : "No override";
                      })()}
                    />
                    {pricingFor(sheetClient.tenantId)?.override ? (
                      <KeyValue
                        label="Why"
                        layout="stacked"
                        value={pricingFor(sheetClient.tenantId)!.override!.reason}
                      />
                    ) : null}
                  </dl>
                ),
              },
              {
                title: "Billing state",
                body: (
                  <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                    <KeyValue
                      label="Subscription"
                      layout="stacked"
                      value={sheetClient.subscriptionStatus
                        ? sentenceCase(sheetClient.subscriptionStatus)
                        : "No subscription recorded"}
                    />
                    <KeyValue
                      label="Account"
                      layout="stacked"
                      value={sheetClient.accountStatus
                        ? sentenceCase(sheetClient.accountStatus)
                        : "No account state"}
                    />
                  </dl>
                ),
              },
              {
                title: "Provider evidence",
                body: (
                  <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
                    <KeyValue
                      label="Renews"
                      layout="stacked"
                      value={sheetClient.currentPeriodEnd
                        ? displayDate(sheetClient.currentPeriodEnd)
                        : "No renewal date"}
                    />
                    <KeyValue
                      label="Provider checked"
                      layout="stacked"
                      value={sheetClient.providerUpdatedAt
                        ? displayDate(sheetClient.providerUpdatedAt)
                        : "Never checked"}
                    />
                  </dl>
                ),
              },
            ] : []}
            state={sheetClient?.subscriptionStatus ? {
              kind: "lifecycle",
              label: sentenceCase(sheetClient.subscriptionStatus),
              tone: subscriptionTone(sheetClient.subscriptionStatus),
            } : undefined}
            technical={sheetClient ? [{ label: "Account ID", value: sheetClient.tenantId }] : undefined}
            title={sheetClient?.businessName ?? ""}
          />
        </section>
        </>)}
      </div>
      </MoneySurfaceGuard>

      <TierEditor
        draft={tierDraft}
        onDraftChange={setTierDraft}
        onOpenChange={setTierEditorOpen}
        onReview={() => {
          setTierEditorOpen(false);
          setTierConfirmOpen(true);
        }}
        open={tierEditorOpen}
        tier={selectedTier}
      />
      <ConfirmFlow
        action="billing.tier.updated"
        confirmLabel="Update plan"
        impact={
          selectedTier && tierImpactById?.[selectedTier.id]
            ? [
                { label: "Plan", value: selectedTier.name },
                {
                  label: "Monthly price",
                  value: `${money(selectedTier.priceCents, "USD")} becomes ${money(tierDraft.priceCents ?? 0, "USD")}`,
                },
                {
                  label: "Included calls",
                  value: `${workspaceCountFormat.format(selectedTier.callAllowance)} becomes ${workspaceCountFormat.format(tierDraft.callAllowance ?? 0)}`,
                },
                {
                  label: "Takes effect",
                  value: displayDate(tierImpactById[selectedTier.id].effectiveAt),
                },
                {
                  label: "Affected workspaces",
                  value: `${workspaceCountFormat.format(tierImpactById[selectedTier.id].affectedWorkspaceCount)} ${tierImpactById[selectedTier.id].affectedWorkspaceCount === 1 ? "workspace" : "workspaces"}`,
                },
              ]
            : []
        }
        onConfirm={confirmTier}
        onOpenChange={setTierConfirmOpen}
        open={tierConfirmOpen}
        reason={{
          required: true,
          label: "Reason",
          hint: "Explain why the plan terms are changing.",
        }}
        title={`Review ${selectedTier?.name ?? "plan"} change`}
      />

      <OverrideEditor
        client={selectedClient}
        draft={overrideDraft}
        onDraftChange={setOverrideDraft}
        onOpenChange={setOverrideEditorOpen}
        onReview={() => {
          setOverrideEditorOpen(false);
          setOverrideConfirmOpen(true);
        }}
        open={overrideEditorOpen}
      />
      <ConfirmFlow
        action="billing.tenant_override.updated"
        confirmLabel="Set price override"
        impact={
          selectedClient
            ? [
                { label: "Client", value: selectedClient.businessName },
                { label: "Override price", value: money(overrideDraft.priceCents ?? 0, "USD") },
                { label: "Effective at", value: displayDraftDate(overrideDraft.effectiveAt) },
                {
                  label: "Ends at",
                  value: overrideDraft.endsAt
                    ? displayDraftDate(overrideDraft.endsAt)
                    : "No end date recorded",
                },
              ]
            : []
        }
        onConfirm={confirmOverride}
        onOpenChange={setOverrideConfirmOpen}
        open={overrideConfirmOpen}
        reason={{
          required: true,
          label: "Reason",
          hint: "Explain why this client needs a different price.",
        }}
        title={`Review override for ${selectedClient?.businessName ?? "client"}`}
      />
    </>
  );

  return chrome === "embedded" ? body : (
    <ListPage
      {...moneyPageHeader({
        authorized: authorized && accessStatus === 200,
        description: "The plans a coach can buy, what each one includes, and the fair-use cap past that. Changing one is audit-logged.",
        enabled,
      })}
      provenance={
        hasDemoData && pageProvenanceKind === null
          ? "Demo rows are labelled and excluded from analytics."
          : undefined
      }
      provenanceKind={pageProvenanceKind ?? undefined}
      title="Plans and pricing"
    >
      {body}
    </ListPage>
  );
}
