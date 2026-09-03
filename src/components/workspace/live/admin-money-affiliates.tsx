"use client";

import type { ColumnDef } from "@tanstack/react-table";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type FormEvent,
  type SetStateAction,
} from "react";

import { Send } from "@/components/kit/icons";

import { ActionMenu } from "@/components/kit/action-menu";
import { absentValue } from "@/components/kit/columns";
import {
  Figure,
  KitButton,
  MonoMeta,
  Overline,
  Prose,
  Surface,
} from "@/components/kit/atomics";
import { Callout } from "@/components/kit/callout";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import {
  seededRowLabel,
  seededRowWords,
  wholePageProvenanceKind,
} from "@/components/kit/provenance-chip";
import { DateField, workspaceDateKey } from "@/components/kit/date-field";
import type { ExportMenuProps } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { KeyValue } from "@/components/kit/key-value";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { StateTone } from "@/components/kit/state-badge";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { type StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { MoneySurfaceGuard, moneyPageHeader } from "@/components/workspace/live/admin-money-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import {
  workspaceCountFormat,
  workspaceDateFormat,
} from "@/lib/format/datetime";
import { money } from "@/lib/format/metric";
import type { MoneyRefusalRecord } from "@/lib/repositories/money-page-audit";

/**
 * `tenants.is_demo` reaches a row as `dataLabel`, and the two words it can carry are separate
 * claims: a seeded workspace, and a tenant marked as test data. Collapsing them into one is what
 * let these pages state a whole-page provenance their rows did not support.
 */
const seedingOf = (row: { dataLabel: string | null }) =>
  row.dataLabel === null ? null : row.dataLabel === "Test" ? ("test" as const) : ("demo" as const);


type PlatformRole = "owner" | "admin" | "success";
type PayoutState = "pending_approval" | "approved_for_payout" | "sent";
type EntryKind = "accrual" | "offset" | "recovery";

export type AdminMoneyAffiliatesProps = {
  surface: "affiliates";
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
  affiliatesEnabled?: boolean;
};

type AffiliateLedgerRow = {
  ledgerId: string;
  affiliateId: string;
  affiliateName: string;
  businessName: string;
  commissionCents: number;
  entryKind: EntryKind;
  reversesLedgerId: string | null;
  payoutId: string | null;
  payoutTotalCents: number | null;
  payoutState: PayoutState;
  approvedEventId: string | null;
  approvedAt: string | null;
  /**
   * `users.full_name`, which is nullable, so an approver can genuinely have no display name. The
   * time cannot be missing: `created_at`, `actor_id` and `audit_id` are all not-null on
   * `commission_payout_events`, so an approved payout always has both a moment and a person.
   */
  approvedBy: string | null;
  approvedAuditId: number | null;
  sentEventId: string | null;
  sentAuditId: number | null;
  reference: string | null;
  paidOn: string | null;
  createdAt: string;
  dataLabel: string | null;
};

type PayoutSelection = {
  payoutId: string;
  affiliateName: string;
  totalCents: number;
  /**
   * How many commission entries this ledger view holds for the payout. A total with no count
   * behind it is untraceable: "$50.00" could be one entry or twenty, and the person typing a bank
   * reference against it has no way to tell which.
   */
  entryCount: number;
  /**
   * The referred coaches those entries came from, deduplicated and in ledger order. 5f names them
   * in the dialog, and they are the only thing that makes the total recognisable to whoever is
   * looking at a bank screen beside it.
   */
  entryBusinesses: readonly string[];
  /**
   * Who signed the total off and when. The operator about to type a bank reference against it is
   * usually not the person who approved it, and "approved by someone, on a date" is what makes a
   * figure safe to act on rather than merely present.
   */
  approvedAt: string | null;
  approvedBy: string | null;
};

/** "3 entries" / "1 entry", from the list rather than from a literal. */
function entryCountLabel(count: number) {
  return `${workspaceCountFormat.format(count)} ${count === 1 ? "entry" : "entries"}`;
}

type SentDraft = {
  reference: string;
  paidOn: Date | null;
};

const EXPORT_REASON = "admin-affiliate-payouts-read";
const EXPORT_COLUMNS = [
  "ledgerId",
  "affiliateId",
  "affiliateName",
  "businessName",
  "commissionCents",
  "entryKind",
  "reversesLedgerId",
  "payoutId",
  "payoutTotalCents",
  "payoutState",
  "approvedEventId",
  "approvedAt",
  "approvedBy",
  "approvedAuditId",
  "sentEventId",
  "sentAuditId",
  "reference",
  "paidOn",
  "createdAt",
  "dataLabel",
] as const;

const ENTRY_LABELS: Record<EntryKind, string> = {
  accrual: "Commission earned",
  offset: "Commission offset",
  recovery: "Commission recovered",
};

const PAYOUT_STATE: Record<
  PayoutState,
  { label: string; tone: StateTone }
> = {
  pending_approval: { label: "Pending approval", tone: "warning" },
  // Approved-and-waiting is a holding state: the money is decided and the clock belongs to whoever
  // moves it, which is exactly the `waiting` role. It took the neutral wash before, because the
  // only in-progress tone then available was the pre-redesign cyan `--info`, which sits close
  // enough to `--accent` that a column of it reads as selected rows. `StateBadge` now paints
  // `info` in periwinkle `--waiting-*` rather than that cyan, so the reason for the substitution
  // is gone and the state can say in colour what it is: not yet done, and not on us.
  approved_for_payout: { label: "Approved for payout", tone: "info" },
  sent: { label: "Recorded sent", tone: "good" },
};

/** Band order: what is waiting on me, then on a bank, then what is already done. */
const PAYOUT_GROUPS = [
  { id: PAYOUT_STATE.pending_approval.label, label: "Pending approval" },
  { id: PAYOUT_STATE.approved_for_payout.label, label: "Approved, not sent" },
  { id: PAYOUT_STATE.sent.label, label: "Recorded sent" },
] as const;

/**
 * A clawback is the row that needs a decision, and at the same ink and weight as a payment it
 * reads as one. Negatives take the clay text colour and the accounting parenthesis, so a
 * reversal is legible as a reversal before the figure is read.
 */
function commissionDisplay(cents: number) {
  return cents < 0 ? `(${money(Math.abs(cents), "USD")})` : money(cents, "USD");
}

const EMPTY_SENT_DRAFT: SentDraft = { reference: "", paidOn: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(row: Record<string, unknown>, key: string) {
  const value = row[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Affiliate payout data did not include the expected record identity.");
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
    throw new Error("Affiliate payout data included an invalid amount.");
  }
  return value;
}

function optionalInteger(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return value === null
    ? null
    : typeof value === "number" && Number.isSafeInteger(value)
      ? value
      : null;
}

function parseLedgerRows(value: unknown): AffiliateLedgerRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Affiliate payout data was not returned as a list.");
  }

  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Affiliate payout data included an invalid row.");
    }

    const entryKind = candidate.entryKind;
    const payoutState = candidate.payoutState;
    if (entryKind !== "accrual" && entryKind !== "offset" && entryKind !== "recovery") {
      throw new Error("Affiliate payout data included an unknown commission entry.");
    }
    if (
      payoutState !== "pending_approval"
      && payoutState !== "approved_for_payout"
      && payoutState !== "sent"
    ) {
      throw new Error("Affiliate payout data included an unknown payout state.");
    }

    const payoutId = optionalText(candidate, "payoutId");
    if (payoutState !== "pending_approval" && !payoutId) {
      throw new Error("Affiliate payout data did not include the expected payout record.");
    }

    return {
      ledgerId: requiredText(candidate, "ledgerId"),
      affiliateId: requiredText(candidate, "affiliateId"),
      affiliateName: requiredText(candidate, "affiliateName"),
      businessName: requiredText(candidate, "businessName"),
      commissionCents: requiredInteger(candidate, "commissionCents"),
      entryKind,
      reversesLedgerId: optionalText(candidate, "reversesLedgerId"),
      payoutId,
      payoutTotalCents: optionalInteger(candidate, "payoutTotalCents"),
      payoutState,
      approvedEventId: optionalText(candidate, "approvedEventId"),
      approvedAt: optionalText(candidate, "approvedAt"),
      approvedBy: optionalText(candidate, "approvedBy"),
      approvedAuditId: optionalInteger(candidate, "approvedAuditId"),
      sentEventId: optionalText(candidate, "sentEventId"),
      sentAuditId: optionalInteger(candidate, "sentAuditId"),
      reference: optionalText(candidate, "reference"),
      paidOn: optionalText(candidate, "paidOn"),
      createdAt: requiredText(candidate, "createdAt"),
      dataLabel: optionalText(candidate, "dataLabel"),
    };
  });
}

function displayDate(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? "Date not recorded"
    : workspaceDateFormat.format(parsed);
}

function displayCalendarDate(value: string | null) {
  if (!value) return "Date not recorded";
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(parsed.valueOf())
    ? "Date not recorded"
    : workspaceDateFormat.format(parsed);
}

async function responsePayload(response: Response) {
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = isRecord(payload) && typeof payload.error === "string"
      ? payload.error
      : "The payout record could not be updated.";
    throw new Error(message);
  }
  if (!isRecord(payload)) throw new Error("The payout receipt was invalid.");
  return payload;
}

function PayoutNotice({
  affiliatesEnabled,
}: {
  affiliatesEnabled: boolean;
}) {
  /*
   * What is blocked on a page the reader can read, which is a different thing from a refusal.
   *
   * The billing flag and the role boundary used to answer here too, so Affiliates met a refused
   * success reviewer with a warning callout while Revenue met the same person with
   * `MoneySurfaceGuard`'s panel and Plans with a third banner -- one drawn screen, four
   * behaviours. Both refusals moved to the guard that now wraps this, and what is left is the one
   * case that is genuinely not a refusal: the ledger reads, only the payout actions are off.
   */
  const copy = affiliatesEnabled
    ? null
    : {
        title: "Payout actions are not enabled",
        body: "Commission records remain visible, but approvals and sent records stay blocked until affiliate payouts are enabled.",
      };

  if (!copy) return null;

  // The kit callout carries this: one hairline border, one tone dot, no edge stripe and no
  // decorative glyph box competing with the sentence that actually says what is blocked.
  return <Callout body={copy.body} className="mb-[var(--s-6)]" title={copy.title} tone="warning" />;
}

function SentRecordEditor({
  draft,
  onDraftChange,
  onOpenChange,
  onReview,
  open,
  payout,
}: {
  draft: SentDraft;
  onDraftChange: (draft: SentDraft) => void;
  onOpenChange: (open: boolean) => void;
  onReview: () => void;
  open: boolean;
  payout: PayoutSelection | null;
}) {
  const [error, setError] = useState<string | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.reference.trim()) {
      setError("Enter the reference from the external payout provider.");
      return;
    }
    if (!draft.paidOn) {
      setError("Choose the date the external payout was sent.");
      return;
    }
    setError(null);
    onReview();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        className="w-full max-w-[var(--drawer-w)] gap-0 border-[var(--line)] bg-[var(--raised)] p-0 shadow-[var(--shadow-drawer)] transition-[transform,opacity] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none sm:max-w-[var(--drawer-w)]"
      >
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
          <SheetHeader className="border-b border-[var(--line)] p-[var(--s-5)] pr-[var(--s-10)]">
            <SheetTitle className="text-section text-[color:var(--ink)]">
              {payout ? `Record payout as sent for ${payout.affiliateName}` : "Record payout as sent"}
            </SheetTitle>
            {/*
              * "Their portal shows this the moment you record it" is a verified claim, not a
              * flourish: the affiliate's payout projection derives `sent` from the presence of the
              * `sent` event row, so the state flips for them in the same transaction that writes
              * it here. Worth saying, because it tells the operator that a typo is visible to
              * somebody else immediately.
              */}
            <SheetDescription className="text-body text-[color:var(--muted)]">
              {payout
                ? `${money(payout.totalCents, "USD")} across ${entryCountLabel(payout.entryCount)}. ${payout.affiliateName.split(" ")[0] ?? "The affiliate"}'s portal shows this the moment you record it.`
                : "This records an external payout; no transfer was made by SetterFi."}
            </SheetDescription>
          </SheetHeader>

          <div className="relative flex flex-1 flex-col gap-[var(--s-5)] overflow-y-auto p-[var(--s-5)]">
            {/*
              * A well, not a second card inside the drawer: this states what SetterFi already
              * knows about the payout being recorded, and the two things the person needs in
              * front of them while they copy a reference off a bank receipt. When there is no
              * payout the well is absent rather than present-and-empty: a labelled field is a
              * claim that the label has a value, so an unrecorded total says nothing here and is
              * stated in words where the total would otherwise be read.
              */}
            {payout ? (
              <Surface as="dl" className="grid gap-[var(--s-3)] @min-[300px]:grid-cols-2" variant="well">
                <div className="min-w-0">
                  <Overline as="dt" className="block">Affiliate</Overline>
                  <dd className="mt-[var(--s-1)] truncate text-[13px] leading-[1.35] font-medium text-[color:var(--ink)]">
                    {payout.affiliateName}
                  </dd>
                </div>
                <div className="min-w-0">
                  <Overline as="dt" className="block">Approved total</Overline>
                  <dd className="mt-[var(--s-1)]">
                    <Figure className="block" size="md">{money(payout.totalCents, "USD")}</Figure>
                    <MonoMeta className="mt-[2px] block">
                      {entryCountLabel(payout.entryCount)}
                      {payout.entryBusinesses.length > 0
                        ? ` · ${payout.entryBusinesses.join(", ")}`
                        : ""}
                    </MonoMeta>
                  </dd>
                </div>
                {/*
                  * Only where an approval exists. Every payout reaching this drawer is approved,
                  * so in practice it always does, and the guard is here because a labelled field
                  * is a claim that the label has a value. The approver's name comes from
                  * `users.full_name`, which is nullable, so a missing one is stated as missing
                  * rather than filled in with an id nobody could ask.
                  */}
                {payout.approvedAt ? (
                  <div className="min-w-0">
                    <Overline as="dt" className="block">Approved</Overline>
                    <dd className="mt-[var(--s-1)]">
                      <MonoMeta className="block">{displayDate(payout.approvedAt)}</MonoMeta>
                      <span className="mt-[2px] block truncate text-[12px] leading-[1.35] text-[color:var(--muted)]">
                        {payout.approvedBy ? `by ${payout.approvedBy}` : "approver has no name on their account"}
                      </span>
                    </dd>
                  </div>
                ) : null}
              </Surface>
            ) : null}

            {/*
              * "Required" here is not a form convention, it is the database. A `sent` event whose
              * reference trims to empty is refused by `commission_payout_events_shape_chk`, so
              * there is no path that records the state without the evidence, and the label may say
              * so plainly rather than hedging.
              */}
            <Field
              error={error && !draft.reference.trim() ? error : undefined}
              hint={payout
                ? `Exactly as it appears on your bank statement. ${payout.affiliateName} matches against it in their portal.`
                : "Exactly as it appears on your bank statement."}
              label="Bank reference"
              required
            >
              <Input
                className="h-[var(--row-h-dense)] rounded-[var(--r-input)] border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-3)] text-[length:var(--t-body)] text-[color:var(--ink)] focus-visible:border-[var(--accent)] focus-visible:ring-[var(--focus-ring)]"
                onChange={(event) => onDraftChange({
                  ...draft,
                  reference: event.currentTarget.value,
                })}
                value={draft.reference}
              />
            </Field>
            <DateField
              error={error && !draft.paidOn ? error : undefined}
              hint="Use the date shown on the external payout receipt."
              label="Paid on"
              onChange={(paidOn) => onDraftChange({ ...draft, paidOn })}
              value={draft.paidOn}
            />

            <Callout
              body="This records a payment your bank already made. It cannot be undone or corrected, only offset by a recovery entry on the ledger."
              title="SetterFi does not move money"
              tone="warning"
            />

            {/*
              * Every clause of this is enforced rather than promised, which is why it can be
              * stated this flatly. SetterFi has no payment-provider port at all. The payout tables
              * are append-only by trigger and a second `sent` event is blocked by a partial unique
              * index, so a recorded reference genuinely cannot be edited or withdrawn: the only
              * remaining move is a recovery entry on the ledger. Someone about to type a reference
              * should know that before they type it, not after.
              */}

          </div>

          <SheetFooter className="flex-row justify-end border-t border-[var(--line)] p-[var(--s-4)]">
            <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={!payout} type="submit">
              Review sent record
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

const LEDGER_EXPORT = {
  filename: "setterfi-affiliate-payouts",
  mode: "server",
  query: {
    reason: EXPORT_REASON,
    order: "created_desc",
    columns: [...EXPORT_COLUMNS],
  },
  resource: "affiliate-payouts",
} as const satisfies ExportMenuProps;

/**
 * Selection stays owned by the surface rather than the kit table: a commission row is only
 * eligible while it is pending approval and belongs to the affiliate already selected, and the
 * confirmation flow reads the same set to list one line per row. The kit DataTable supplies the
 * sticky unfilled header, the shared cell contract, density, column visibility, and the export.
 */
function LedgerTable({
  actionsAvailable,
  onOpenApproval,
  onOpenRow,
  onOpenSentEditor,
  rows,
  selectedIds,
  setSelectedIds,
}: {
  actionsAvailable: boolean;
  onOpenApproval: () => void;
  onOpenRow: (row: AffiliateLedgerRow) => void;
  onOpenSentEditor: (row: AffiliateLedgerRow) => void;
  rows: readonly AffiliateLedgerRow[];
  selectedIds: ReadonlySet<string>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  const selectedRows = rows.filter((row) => selectedIds.has(row.ledgerId));
  // The table's own rows, not the page's: this component is handed a filtered ledger, and a label
  // derived from rows it is not drawing would name seeding the reader cannot see.
  const labelledWords = seededRowWords(rows, seedingOf);

  // The ledger arrives in insert order, which put five sub-dollar rows for the same affiliate and
  // the same coach next to each other with nothing to tell them apart. Largest first gives the
  // table a shape before anyone touches a header, and the reader can still sort any other way.
  const orderedRows = useMemo(
    () => [...rows].sort((left, right) => right.commissionCents - left.commissionCents),
    [rows],
  );

  const selectedAffiliateId = useMemo(() => {
    for (const row of rows) {
      if (selectedIds.has(row.ledgerId)) return row.affiliateId;
    }
    return null;
  }, [rows, selectedIds]);

  const firstApprovedRowByPayout = useMemo(() => {
    const first = new Map<string, string>();
    for (const row of rows) {
      if (
        row.payoutState === "approved_for_payout"
        && row.payoutId
        && !first.has(row.payoutId)
      ) {
        first.set(row.payoutId, row.ledgerId);
      }
    }
    return first;
  }, [rows]);

  const toggleRow = useCallback((row: AffiliateLedgerRow, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(row.ledgerId);
      else next.delete(row.ledgerId);
      return next;
    });
  }, [setSelectedIds]);

  const columns = useMemo<ColumnDef<AffiliateLedgerRow>[]>(() => {
    const selection: ColumnDef<AffiliateLedgerRow>[] = actionsAvailable
      ? [{
          id: "select",
          enableHiding: false,
          enableSorting: false,
          // "selection" keeps the narrow column width and renders the control unwrapped.
          meta: { cellKind: "selection" },
          header: () => <span className="sr-only">Select commission rows</span>,
          cell: ({ row }) => {
            const entry = row.original;
            const canApprove = entry.payoutState === "pending_approval";
            const incompatibleAffiliate = Boolean(
              selectedAffiliateId && selectedAffiliateId !== entry.affiliateId,
            );
            return (
              // The row press opens the record sheet, so the selection control keeps its own press.
              <span onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  aria-label={`Select commission row for ${entry.businessName}, ${commissionDisplay(entry.commissionCents)}`}
                  checked={selectedIds.has(entry.ledgerId)}
                  disabled={!canApprove || incompatibleAffiliate}
                  onCheckedChange={(checked) => toggleRow(entry, Boolean(checked))}
                />
              </span>
            );
          },
        }]
      : [];

    const actions: ColumnDef<AffiliateLedgerRow>[] = actionsAvailable
      ? [{
          id: "actions",
          enableHiding: false,
          enableSorting: false,
          // "actions" gives the kebab its own width band; on "selection" it was squeezed into the
          // checkbox width and clipped at the right edge of the table at 1440.
          meta: { cellClassName: "text-right", cellKind: "actions" },
          header: () => <span className="sr-only">Payout actions</span>,
          cell: ({ row }) => {
            const entry = row.original;
            const showSentAction = entry.payoutState === "approved_for_payout"
              && entry.payoutId
              && firstApprovedRowByPayout.get(entry.payoutId) === entry.ledgerId;
            if (!showSentAction) return null;
            return (
              // The row opens the record sheet, so the kebab has to keep its press to itself.
              <span onClick={(event) => event.stopPropagation()}>
                <ActionMenu
                  items={[{
                    icon: <Send aria-hidden className="size-[var(--s-4)]" />,
                    label: "Record sent",
                    onSelect: () => onOpenSentEditor(entry),
                  }]}
                  label={`Payout actions for ${entry.affiliateName}`}
                />
              </span>
            );
          },
        }]
      : [];

    return [
      ...selection,
      {
        id: "affiliate",
        accessorFn: (row) => row.affiliateName,
        header: "Affiliate",
        meta: { cellKind: "identity", label: "Affiliate" },
        cell: ({ row }) => (
          <span className="text-[length:var(--t-row)] font-[var(--t-row-w)] text-[var(--ink)]">
            {row.original.affiliateName}
          </span>
        ),
      },
      {
        id: "referredCoach",
        accessorFn: (row) => row.businessName,
        header: "Referred coach",
        meta: { label: "Referred coach" },
      },
      {
        id: "entry",
        accessorFn: (row) => ENTRY_LABELS[row.entryKind],
        filterFn: "arrIncludesSome",
        header: "Entry",
        meta: { defaultHidden: true, label: "Entry" },
      },
      {
        id: "commission",
        accessorFn: (row) => row.commissionCents,
        header: "Commission",
        meta: {
          cellClassName: "text-right",
          cellKind: "money",
          headerClassName: "text-right",
          label: "Commission",
          // The money band alone is narrower than the word "Commission", which truncated the
          // header to "COMMISSI…" at 1440.
          minWidth: 140,
        },
        cell: ({ row }) => {
          const cents = row.original.commissionCents;
          return (
            // `Figure` is the mono tabular money treatment the whole redesign shares, so a clawback
            // and a payment line up digit for digit and the parenthesis around the reversal means
            // something. The clay tone is `Figure`'s documented claim that this is the number that
            // is the problem; the parenthesis is what carries it for a reader who cannot see hue,
            // so the colour is never the only thing saying the row is a reversal.
            <Figure
              data-negative={cents < 0 ? "true" : undefined}
              size="sm"
              tone={cents < 0 ? "failure" : "neutral"}
            >
              {commissionDisplay(cents)}
            </Figure>
          );
        },
      },
      {
        id: "recorded",
        accessorFn: (row) => row.createdAt,
        header: "Recorded",
        meta: {
          cellClassName: "tabular-nums text-[var(--muted)]",
          cellKind: "secondary",
          label: "Recorded",
        },
        cell: ({ row }) => displayDate(row.original.createdAt),
      },
      {
        // Payout state is the ledger's lifecycle, so it groups the rows into bands instead of
        // printing the same three pills down a column. It ships hidden but declared, so Display
        // can bring the raw value back for a reader who wants it in a sorted flat list.
        id: "payoutState",
        accessorFn: (row) => PAYOUT_STATE[row.payoutState].label,
        header: "Payout state",
        meta: { cellKind: "secondary", defaultHidden: true, label: "Payout state" },
      },
      {
        /*
         * The bank reference belongs on the row, not behind Display. It is the thing that makes a
         * "Recorded sent" row true rather than claimed, it is what the affiliate sees in their own
         * portal, and it is the column an operator reconciling a bank statement is here to read.
         * The two states before it get the word for what has not happened yet rather than a blank,
         * so a reader can tell "no reference exists" from "no reference was loaded".
         */
        id: "sentEvidence",
        accessorFn: (row) => (
          row.reference && row.paidOn
            ? `${row.reference}, ${displayCalendarDate(row.paidOn)}`
            : "No sent record"
        ),
        header: "Bank reference",
        meta: { cellKind: "secondary", label: "Bank reference", minWidth: 200 },
        cell: ({ row }) => {
          const entry = row.original;
          if (entry.reference && entry.paidOn) {
            return (
              <MonoMeta>
                {entry.reference} · {displayCalendarDate(entry.paidOn)}
              </MonoMeta>
            );
          }
          return absentValue(
            entry.payoutState === "approved_for_payout"
              ? "no reference yet"
              : "not approved yet",
          );
        },
      },
      ...actions,
    ];
  }, [
    actionsAvailable,
    firstApprovedRowByPayout,
    onOpenSentEditor,
    selectedAffiliateId,
    selectedIds,
    toggleRow,
  ]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DataTable
        ariaLabel="Affiliate commission ledger"
        columns={columns}
        data={orderedRows}
        emptyState={(
          <DataState
            body="Commission entries appear after a referred coach produces an eligible paid invoice."
            kind="empty"
            title="No commission entries"
          />
        )}
        exportResource={LEDGER_EXPORT}
        // Payout state is a band now, so the chip is spent on the question the bands cannot
        // answer: which of these rows is a clawback rather than a payment.
        facets={[{
          columnId: "entry",
          title: "Entry",
          options: Object.values(ENTRY_LABELS).map((label) => ({ label, value: label })),
        }]}
        getRowId={(row) => row.ledgerId}
        groupBy={(row) => PAYOUT_STATE[row.payoutState].label}
        groups={PAYOUT_GROUPS}
        onRowOpen={onOpenRow}
        rowLabel={{ plural: "entries", singular: "entry" }}
        search={{ columnId: "affiliate", placeholder: "Search affiliates" }}
        testRow={(row) => row.dataLabel !== null}
        testRowLabel={seededRowLabel(labelledWords)}
      />

      {selectedRows.length > 0 ? (
        // The artifact draws this exact object in 1c: a mono count, an accent-wash action, and a
        // quiet one beside it. It was an inverted slab in `--ink` under `--canvas` text, which is
        // the only place in the product where the page's ground and its ink swap over, and which
        // forced the approve button to override its own fill to stay legible on it. On a card face
        // the button keeps the kit's `soft` accent instead, so the page spends accent once and
        // spends no fill at all -- the resting state DESIGN.md calls correct rather than
        // unfinished. Raised rather than card-rung because it floats over the rows it acts on.
        <Surface
          aria-label="Selected payout actions"
          className="sticky bottom-[var(--s-4)] z-[var(--z-sticky)] mx-auto mt-[var(--s-3)] flex w-fit max-w-full flex-wrap items-center gap-[var(--s-3)] px-[var(--s-4)] py-[var(--s-2)] [box-shadow:var(--shadow-raised)]"
          role="toolbar"
        >
          <MonoMeta>
            {workspaceCountFormat.format(selectedRows.length)} commission {selectedRows.length === 1 ? "row" : "rows"}
          </MonoMeta>
          <KitButton onClick={onOpenApproval} size="sm" variant="soft">
            Approve {workspaceCountFormat.format(selectedRows.length)} selected
          </KitButton>
          <KitButton onClick={() => setSelectedIds(new Set())} size="sm" variant="ghost">
            Clear
          </KitButton>
        </Surface>
      ) : null}
    </div>
  );
}

/**
 * What a payout is actually made of.
 *
 * A payout total is a sum of commission entries, and until this existed the drawer showed only the
 * sum: an admin looking at "$50.00" beside "Payout total" could not see which referred coaches it
 * came from, whether a clawback was netted inside it, or how many entries were rolled up. On a
 * money ledger that is the whole job, so the total is now rendered from the entries under it
 * rather than announced on its own.
 *
 * The two numbers are kept apart on purpose. The subtotal is arithmetic over the rows this view
 * holds; the payout total is what `commission_payouts.total_cents` recorded when the approval was
 * written. They should agree, and when they do not, the honest reading is that this view is not
 * looking at every entry in the payout, not that either figure is wrong. So the sentence says
 * that, instead of the surface quietly printing the derived sum as though it were the total.
 */
function PayoutComposition({
  openedRow,
  rows,
}: {
  openedRow: AffiliateLedgerRow;
  rows: readonly AffiliateLedgerRow[];
}) {
  const entries = rows.filter((row) => row.payoutId === openedRow.payoutId);
  const subtotalCents = entries.reduce((total, row) => total + row.commissionCents, 0);
  const recordedCents = openedRow.payoutTotalCents;
  const reconciles = recordedCents === null || recordedCents === subtotalCents;

  return (
    <div className="grid gap-[var(--s-3)]">
      <Surface className="grid gap-[var(--s-3)]" variant="well">
        <ul aria-label="Commission entries in this payout" className="grid gap-[var(--s-3)]">
          {entries.map((entry) => (
            <li
              className="flex min-w-0 items-baseline justify-between gap-[var(--s-3)]"
              key={entry.ledgerId}
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] leading-[1.35] text-[color:var(--ink)]">
                  {entry.businessName}
                </span>
                <MonoMeta className="block">
                  {ENTRY_LABELS[entry.entryKind]} · {displayDate(entry.createdAt)}
                  {entry.ledgerId === openedRow.ledgerId ? " · the entry you opened" : ""}
                </MonoMeta>
              </span>
              <Figure size="sm" tone={entry.commissionCents < 0 ? "failure" : "neutral"}>
                {commissionDisplay(entry.commissionCents)}
              </Figure>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-3)] border-t border-[var(--line)] pt-[var(--s-3)]">
          <MonoMeta>{entryCountLabel(entries.length)} shown here</MonoMeta>
          <Figure size="sm">{commissionDisplay(subtotalCents)}</Figure>
        </div>
      </Surface>

      <div className="flex flex-wrap items-baseline justify-between gap-[var(--s-3)]">
        <Overline>Payout total recorded</Overline>
        {recordedCents === null ? (
          <MonoMeta>no payout total recorded</MonoMeta>
        ) : (
          <Figure size="md">{money(recordedCents, "USD")}</Figure>
        )}
      </div>

      {reconciles ? null : (
        <Prose
          className="text-[length:var(--t-body)] leading-[var(--t-body-lh)] text-[color:var(--warning-text)]"
          measure="prose"
        >
          These entries do not add up to the recorded payout total, so this view is not holding
          every entry in the payout. Open the payout record before you record it sent.
        </Prose>
      )}
    </div>
  );
}

export function AdminMoneyAffiliates({
  actorRole,
  affiliatesEnabled = false,
  authorized,
  chrome = "page",
  refusalRecord,
  enabled,
}: AdminMoneyAffiliatesProps) {
  const canRead = enabled && authorized && actorRole !== "success";
  const actionsAvailable = canRead
    && affiliatesEnabled
    && (actorRole === "owner" || actorRole === "admin");
  const [rows, setRows] = useState<AffiliateLedgerRow[]>([]);
  const [loading, setLoading] = useState(canRead);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [selectedPayout, setSelectedPayout] = useState<PayoutSelection | null>(null);
  const [sentEditorOpen, setSentEditorOpen] = useState(false);
  const [sentConfirmOpen, setSentConfirmOpen] = useState(false);
  const [sentDraft, setSentDraft] = useState<SentDraft>(EMPTY_SENT_DRAFT);
  const [openedRow, setOpenedRow] = useState<AffiliateLedgerRow | null>(null);

  const loadRows = useCallback(async (signal?: AbortSignal) => {
    if (!canRead) return;
    setLoading(true);
    setLoadError(null);
    try {
      const query = `format=json&reason=${encodeURIComponent(EXPORT_REASON)}`;
      const response = await fetch(`/api/exports/affiliate-payouts?${query}`, {
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("Commission and payout records could not be loaded.");
      setRows(parseLedgerRows(await response.json()));
    } catch (cause) {
      if (signal?.aborted) return;
      setLoadError(
        cause instanceof Error
          ? cause.message
          : "Commission and payout records could not be loaded.",
      );
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [canRead]);

  useEffect(() => {
    if (!canRead) return;
    const controller = new AbortController();
    const frame = window.requestAnimationFrame(() => {
      void loadRows(controller.signal);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [canRead, loadRows]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.ledgerId)),
    [rows, selectedIds],
  );
  const selectedAffiliate = selectedRows[0] ?? null;
  const selectedTotal = selectedRows.reduce(
    (total, row) => total + row.commissionCents,
    0,
  );
  /*
   * The chip's word comes from every row or from none of them.
   *
   * This used to be "some row says Demo" AND "every row carries a label", which are two questions
   * that do not compose: a ledger of one demo affiliate and one test affiliate answers yes to both,
   * and the chip then asserted over the title that the whole commission ledger is demo while a test
   * tenant's rows sat in it. `wholePageProvenanceKind` returns `null` for a seeded-but-mixed set --
   * demo and test are separate claims -- and the sentence below names the words that are present.
   */
  const pageProvenanceKind = wholePageProvenanceKind(rows, seedingOf);
  const labelledWords = seededRowWords(rows, seedingOf);

  // Four figures, and each one is a decision: what is waiting on me, what is waiting on a bank
  // transfer, what has already left, and how many partners the ledger covers.
  // A sum with no count behind it says nothing about the work: "$0.50" could be one entry or
  // twenty, so each money tile carries how many entries it is a sum of.
  const entriesFor = (state: PayoutState) => rows.filter((row) => row.payoutState === state);
  /**
   * What each band's note adds beyond its own count, derived from that band's rows.
   *
   * 5e writes these as "oldest 12 days", "1 payout, waiting on your bank" and "every entry carries
   * a bank reference". Two of the three are rendered here from the rows; the age is rendered as
   * the oldest entry's own date instead of a day count, because a day count needs a clock this
   * surface is not handed and a figure that drifts against the row it describes is worse than the
   * date the row already carries. The reference claim is counted rather than asserted: the DB
   * check makes it true, but a note that says "every" without looking is a promise, not a reading.
   */
  const bandNote = (state: PayoutState, entries: readonly AffiliateLedgerRow[]) => {
    if (entries.length === 0) return null;
    if (state === "pending_approval") {
      const oldest = entries.reduce(
        (earliest, row) => (row.createdAt < earliest.createdAt ? row : earliest),
        entries[0]!,
      );
      return `oldest ${displayDate(oldest.createdAt)}`;
    }
    const payoutCount = new Set(entries.map((row) => row.payoutId)).size;
    const payouts = `${workspaceCountFormat.format(payoutCount)} ${payoutCount === 1 ? "payout" : "payouts"}`;
    if (state === "approved_for_payout") return `${payouts}, waiting on your bank`;
    const missing = entries.filter((row) => !row.reference).length;
    return missing === 0
      ? `${payouts}, each with a bank reference`
      : `${payouts}, ${workspaceCountFormat.format(missing)} with no reference recorded`;
  };
  const moneyTile = (label: string, state: PayoutState): StatStripItem => {
    const entries = entriesFor(state);
    const detail = bandNote(state, entries);
    const note = detail ? `${entryCountLabel(entries.length)} · ${detail}` : entryCountLabel(entries.length);
    return {
      // The count belongs on the note line, not inside the label: at four tiles across, a label
      // carrying its own sub-clause truncates and the reader loses the word that names the tile.
      label,
      note,
      availability: entries.length === 0
        // The ledger was read and this band came back empty, so zero is the true reading rather
        // than an absence -- which is exactly what `no-events` is for.
        ? { kind: "no-events", note }
        : {
            kind: "value",
            value: entries.reduce((total, row) => total + row.commissionCents, 0),
            format: "money",
          },
    };
  };
  const affiliateCount = new Set(rows.map((row) => row.affiliateId)).size;
  const tiles: StatStripItem[] = [
    moneyTile("Pending approval", "pending_approval"),
    moneyTile("Approved, not sent", "approved_for_payout"),
    moneyTile("Recorded sent", "sent"),
    {
      label: "Affiliates with entries",
      availability: affiliateCount === 0
        ? { kind: "no-events", note: "No commission entry has been recorded yet" }
        : { kind: "value", value: affiliateCount, format: "count" },
    },
  ];

  async function postPayout(body: Record<string, unknown>) {
    return responsePayload(await fetch("/api/platform/affiliate-payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  async function confirmApproval(input: { reason?: string }): Promise<Result> {
    if (!actionsAvailable || !selectedAffiliate || selectedRows.length === 0 || !input.reason) {
      return { ok: false, message: "Select at least one commission row and enter a reason." };
    }
    if (selectedRows.some((row) => row.affiliateId !== selectedAffiliate.affiliateId)) {
      return { ok: false, message: "Approve commission rows for one affiliate at a time." };
    }

    try {
      const payload = await postPayout({
        action: "approve",
        affiliateId: selectedAffiliate.affiliateId,
        ledgerIds: selectedRows.map((row) => row.ledgerId),
        reason: input.reason,
      });
      const payout = payload.payout;
      if (
        !isRecord(payout)
        || payout?.state !== "approved_for_payout"
        || typeof payout.payoutId !== "string"
        || typeof payout.eventId !== "string"
        || typeof payout.auditId !== "number"
        || !Number.isSafeInteger(payout.auditId)
      ) {
        throw new Error("The payout approval receipt was invalid.");
      }
      setSelectedIds(new Set());
      await loadRows();
      return {
        ok: true,
        receipt: {
          actionKey: "affiliate.payout.approved",
          auditId: payout.auditId,
        },
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error
          ? cause.message
          : "The payout approval could not be recorded.",
      };
    }
  }

  // Only one modal at a time: two open dialogs make each other inert.
  function openSentEditor(row: AffiliateLedgerRow) {
    if (!actionsAvailable || !row.payoutId) return;
    setOpenedRow(null);
    const payoutRows = rows.filter((candidate) => candidate.payoutId === row.payoutId);
    setSelectedPayout({
      payoutId: row.payoutId,
      affiliateName: row.affiliateName,
      totalCents: row.payoutTotalCents
        ?? payoutRows.reduce((total, candidate) => total + candidate.commissionCents, 0),
      entryCount: payoutRows.length,
      entryBusinesses: [...new Set(payoutRows.map((candidate) => candidate.businessName))],
      approvedAt: row.approvedAt,
      approvedBy: row.approvedBy,
    });
    setSentDraft(EMPTY_SENT_DRAFT);
    setSentEditorOpen(true);
  }

  async function confirmSent(): Promise<Result> {
    if (!actionsAvailable || !selectedPayout || !sentDraft.reference.trim() || !sentDraft.paidOn) {
      return { ok: false, message: "Enter the external reference and sent date." };
    }

    const paidOn = workspaceDateKey(sentDraft.paidOn);
    try {
      const payload = await postPayout({
        action: "record_sent",
        payoutId: selectedPayout.payoutId,
        reference: sentDraft.reference.trim(),
        paidOn,
      });
      const payout = payload.payout;
      if (
        !isRecord(payout)
        || payout?.state !== "sent"
        || payout.payoutId !== selectedPayout.payoutId
        || payout.reference !== sentDraft.reference.trim()
        || payout.paidOn !== paidOn
        || typeof payout.eventId !== "string"
        || typeof payout.auditId !== "number"
        || !Number.isSafeInteger(payout.auditId)
      ) {
        throw new Error("The sent-record receipt was invalid.");
      }
      await loadRows();
      return {
        ok: true,
        receipt: {
          actionKey: "affiliate.payout.sent",
          auditId: payout.auditId,
        },
      };
    } catch (cause) {
      return {
        ok: false,
        message: cause instanceof Error
          ? cause.message
          : "The sent record could not be recorded.",
      };
    }
  }

  const body = (
    <>
      {chrome === "embedded" && canRead && !loading && !loadError ? (
        <ConsoleStatDeck
          ariaLabel="Affiliate payout summary"
          heroLabel="Approved, not sent"
          items={tiles}
        />
      ) : null}
      <MoneySurfaceGuard
        actorRole={actorRole}
        authorized={canRead}
        enabled={enabled}
        refusalRecord={refusalRecord}
        surface="affiliates"
      >
      <PayoutNotice affiliatesEnabled={affiliatesEnabled} />

      {loading ? (
        <DataState kind="loading" rows={6} />
      ) : loadError ? (
        <DataState
          body={`${loadError} No payout action was completed.`}
          kind="unavailable"
          retry={() => void loadRows()}
          title="Affiliate payout data could not be loaded"
        />
      ) : (
        <LedgerTable
          actionsAvailable={actionsAvailable}
          onOpenApproval={() => setApprovalOpen(true)}
          onOpenRow={setOpenedRow}
          onOpenSentEditor={openSentEditor}
          rows={rows}
          selectedIds={selectedIds}
          setSelectedIds={setSelectedIds}
        />
      )}
      </MoneySurfaceGuard>

      <RecordSheet
        logged={AUDIT_ACTIONS["affiliate.payout.approved"].microcopy}
        onOpenChange={(open) => {
          if (!open) setOpenedRow(null);
        }}
        open={openedRow !== null && !sentEditorOpen && !sentConfirmOpen && !approvalOpen}
        primaryAction={
          openedRow
          && actionsAvailable
          && openedRow.payoutState === "approved_for_payout"
          && openedRow.payoutId
            ? {
                label: "Record sent",
                onClick: () => {
                  const row = openedRow;
                  setOpenedRow(null);
                  openSentEditor(row);
                },
              }
            : undefined
        }
        sections={openedRow ? [
          {
            title: "Commission entry",
            body: (
              <dl className="grid gap-[var(--s-2)]">
                <KeyValue label="Affiliate" layout="stacked" value={openedRow.affiliateName} />
                <KeyValue label="Referred coach" layout="stacked" value={openedRow.businessName} />
                <KeyValue label="Entry" layout="stacked" value={ENTRY_LABELS[openedRow.entryKind]} />
                <KeyValue
                  label="Commission"
                  layout="stacked"
                  value={commissionDisplay(openedRow.commissionCents)}
                />
                <KeyValue label="Recorded" layout="stacked" value={displayDate(openedRow.createdAt)} />
              </dl>
            ),
          },
          // Only where there is a payout to decompose. A row still pending approval belongs to no
          // payout yet, and an empty composition block would invite the reader to look for one.
          ...(openedRow.payoutId ? [{
            title: "What this payout is made of",
            body: <PayoutComposition openedRow={openedRow} rows={rows} />,
          }] : []),
          {
            title: "Payout evidence",
            body: (
              <dl className="grid gap-[var(--s-2)]">
                {/*
                  * Approval before sending, in the order the money moved. A payout still awaiting
                  * approval has no approval facts rather than blank ones, and an approver whose
                  * account carries no display name reads as a missing name: never their user id,
                  * which identifies nobody a person could ask, and never "you", which would be a
                  * guess about who is reading.
                  */}
                <KeyValue
                  label="Approved"
                  layout="stacked"
                  value={openedRow.approvedAt ? displayDate(openedRow.approvedAt) : "Not approved yet"}
                />
                {openedRow.approvedAt ? (
                  <KeyValue
                    label="Approved by"
                    layout="stacked"
                    value={openedRow.approvedBy ?? "Name not recorded on the account"}
                  />
                ) : null}
                <KeyValue
                  label="External reference"
                  layout="stacked"
                  value={openedRow.reference ?? "No sent record"}
                />
                <KeyValue
                  label="Sent on"
                  layout="stacked"
                  value={openedRow.paidOn ? displayCalendarDate(openedRow.paidOn) : "No sent record"}
                />
              </dl>
            ),
          },
        ] : []}
        state={openedRow ? {
          kind: "lifecycle",
          label: PAYOUT_STATE[openedRow.payoutState].label,
          tone: PAYOUT_STATE[openedRow.payoutState].tone,
        } : undefined}
        subtitle={openedRow ? ENTRY_LABELS[openedRow.entryKind] : undefined}
        technical={openedRow ? [
          { label: "Ledger ID", value: openedRow.ledgerId },
          { label: "Affiliate ID", value: openedRow.affiliateId },
          { label: "Payout ID", value: openedRow.payoutId ?? "Not recorded" },
          {
            label: "Approval audit receipt",
            value: openedRow.approvedAuditId === null ? "Not recorded" : String(openedRow.approvedAuditId),
          },
          {
            label: "Sent audit receipt",
            value: openedRow.sentAuditId === null ? "Not recorded" : String(openedRow.sentAuditId),
          },
        ] : undefined}
        title={openedRow?.affiliateName ?? "Commission entry"}
      />

      <ConfirmFlow
        action="affiliate.payout.approved"
        confirmLabel="Approve for payout"
        impact={selectedAffiliate
          ? [
              { label: "Affiliate", value: selectedAffiliate.affiliateName },
              ...selectedRows.map((row) => ({
                label: "Ledger row",
                value: `${row.businessName}, ${ENTRY_LABELS[row.entryKind]}, ${commissionDisplay(row.commissionCents)}, ${displayDate(row.createdAt)}`,
              })),
              { label: "Total", value: commissionDisplay(selectedTotal) },
            ]
          : []}
        onConfirm={confirmApproval}
        onOpenChange={setApprovalOpen}
        open={approvalOpen}
        reason={{
          required: true,
          label: "Approval reason",
          hint: "Explain why these commission rows are ready for payout.",
        }}
        title={`Approve ${workspaceCountFormat.format(selectedRows.length)} selected`}
      />

      <SentRecordEditor
        draft={sentDraft}
        onDraftChange={setSentDraft}
        onOpenChange={setSentEditorOpen}
        onReview={() => {
          setSentEditorOpen(false);
          setSentConfirmOpen(true);
        }}
        open={sentEditorOpen}
        payout={selectedPayout}
      />
      <ConfirmFlow
        action="affiliate.payout.sent"
        confirmLabel="Record sent"
        impact={selectedPayout && sentDraft.paidOn
          ? [
              { label: "Affiliate", value: selectedPayout.affiliateName },
              { label: "Approved total", value: money(selectedPayout.totalCents, "USD") },
              { label: "External reference", value: sentDraft.reference.trim() },
              { label: "Sent date", value: workspaceDateFormat.format(sentDraft.paidOn) },
              { label: "Result", value: "External payout evidence is recorded. SetterFi does not transfer funds." },
            ]
          : []}
        onConfirm={confirmSent}
        onOpenChange={setSentConfirmOpen}
        open={sentConfirmOpen}
        title={`Record sent for ${selectedPayout?.affiliateName ?? "affiliate"}`}
      />
    </>
  );

  return chrome === "embedded" ? body : (
    <ListPage
      {...moneyPageHeader({
        authorized: canRead,
        description: "Every commission entry, banded by what is waiting on whom. SetterFi never moves the money; this page records what your bank did.",
        enabled,
      })}
      note="An affiliate sees only the referred coach's name, their status, and their own commission. Never that coach's performance."
      provenance={pageProvenanceKind === null && labelledWords.length > 0
        ? `${labelledWords.join(" and ")} rows are labelled in the table and excluded from analytics.`
        : undefined}
      provenanceKind={pageProvenanceKind ?? undefined}
      stats={canRead && !loading && !loadError ? (
        <ConsoleStatDeck
          ariaLabel="Affiliate payout summary"
          heroLabel="Approved, not sent"
          items={tiles}
        />
      ) : undefined}
      title="Affiliates and payouts"
    >
      {body}
    </ListPage>
  );
}
