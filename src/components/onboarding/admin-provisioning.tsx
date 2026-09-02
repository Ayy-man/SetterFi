"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState, type ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { Callout } from "@/components/kit/callout";
import { absentValue, identityColumn } from "@/components/kit/columns";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DataState } from "@/components/kit/data-state";
import { DataTable, type DataTableGroup, type RowAction } from "@/components/kit/data-table";
import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import { StateBadge, type StateTone } from "@/components/kit/state-badge";
import { Segmented } from "@/components/kit/atomics";
import { StatStrip, type StatStripItem } from "@/components/kit/stat-strip";
import { ListPage } from "@/components/kit/templates/list-page";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/kit/tooltip";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
/*
 * The carrier window comes from the contract, never from a local copy. Three surfaces render this
 * range and each one used to declare its own [14, 21]; a published provider window that four files
 * agree on by coincidence is a number that drifts the first time one of them is edited alone.
 */
import { CARRIER_TYPICAL_DAYS, type ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import { useQueryState } from "@/lib/query-state";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";
import {
  deriveAdminProvisioningView,
  loggedActionReceipt,
  type AdminProvisioningRow,
  type LoggedActionReceipt,
  type ProvisioningAdminAction,
  type ProvisioningPartyGroup,
} from "./admin-view-models";

const CRUMBS = [
  { label: "Run" },
  { label: "Provisioning" },
] as const;

const GROUP_LABELS: Record<ProvisioningPartyGroup, string> = {
  coach: "Coach-owned",
  platform: "Platform and system",
  provider: "Provider-owned",
};

/**
 * The band headers, phrased as the wait rather than as ownership.
 *
 * Screen 4a bands "by who has to move it", and the page's own description already says so. "Coach-
 * owned" names a category; "Waiting on the coach" names the fact a reader came here for, and it is
 * the same sentence the summary strip above the table uses, so the two stop being different
 * vocabularies for the same three parties. `GROUP_LABELS` stays for the Owner column, where the
 * noun is what belongs in a cell.
 */
const BAND_LABELS: Record<ProvisioningPartyGroup, string> = {
  coach: "Waiting on the coach",
  platform: "Waiting on the platform",
  provider: "Waiting on a provider",
};

const PROVIDER_LABELS: Record<string, string> = {
  carrier: "Mobile carrier",
  ghl: "Workspace provider",
  google: "Calendar provider",
  meta: "Meta",
  stripe: "Billing provider",
};

/**
 * Built from the labels the rows actually carry.
 *
 * The static list this replaced offered "Provider-owned", which no row could ever match: the Owner
 * column resolves a provider row to its provider ("Mobile carrier"), so the one facet option a
 * reader would reach for filtered the table to nothing, and the carriers themselves could not be
 * filtered to at all.
 */
function ownerFacetOptions(rows: readonly AdminProvisioningRow[]) {
  return [...new Set(rows.map(ownerLabel))]
    .sort((left, right) => left.localeCompare(right))
    .map((label) => ({ label, value: label }));
}

/**
 * The tracker bands by who has to move the row, because that is the only question this page is
 * asked: what is ours, what is the coach's, and what nobody here can hurry. Provider-owned work
 * sits last -- it is the band a reader can do nothing about.
 */
const PARTY_BANDS: readonly DataTableGroup<AdminProvisioningRow>[] = [
  { id: "platform", label: BAND_LABELS.platform },
  { id: "coach", label: BAND_LABELS.coach },
  { id: "provider", label: BAND_LABELS.provider },
];


const CARRIER_COPY =
  "Carrier review takes two to three weeks. Text messages switch on automatically after the carrier receipt is stored.";

function tone(value: "neutral" | "good" | "pending" | "bad"): StateTone {
  if (value === "pending") return "warning";
  if (value === "bad") return "critical";
  return value;
}

function displayCopy(value: string) {
  return value.replaceAll("—", ",");
}

function isCarrierRegistration(row: ProvisioningTrackerRow | undefined) {
  return Boolean(
    row
    && row.state === "awaiting_provider"
    && row.blockingProvider === "carrier"
    && ["a2p_brand", "a2p_campaign", "sms_live"].includes(row.currentStep ?? ""),
  );
}

function ownerLabel(row: AdminProvisioningRow) {
  if (row.providerLabel) return PROVIDER_LABELS[row.providerLabel] ?? "External provider";
  return GROUP_LABELS[row.group];
}

type ProvisioningWait =
  | { kind: "carrier"; days: number; since: string }
  | { kind: "carrier-unfiled"; days: number }
  | { kind: "step"; days: number; since: string };

/**
 * Days, never a percentage and never a predicted date. Past the published carrier window the
 * count turns amber, because that is the point at which a person has to chase it.
 */
/**
 * What `AdminProvisioning.dc.html` draws beside this table, and why it is not built.
 *
 * The canvas is two panels: a queue of who is waiting, and a per-client step timeline -- Business
 * details, Meta app review, Carrier A2P review, Safe test, Go live -- with an amber "past 21 days"
 * note and two buttons, "Chase the carrier" and "Show the technical record".
 *
 * **The timeline is the table.** Every row here already is one client on one step, with its own
 * state and its own real day count, banded by who has to move it. Drawing the same rows again for
 * a selected client would be a second presentation of one read, and the banding this page uses --
 * platform, coach, provider -- answers the question the canvas's In progress / Live / Stalled
 * switch was reaching for, from evidence rather than from a status word.
 *
 * **"Chase the carrier" has nothing behind it.** No route sends a carrier follow-up; A2P vetting
 * is the carrier's clock and we hold no channel to hurry it. A button that logged an intent and
 * changed nothing would be the most expensive kind of dishonest state on the one page whose
 * entire job is refusing to promise a date.
 *
 * **The 21-day note is a real threshold and it is already carried**, by `CARRIER_TYPICAL_DAYS`
 * in the cell below: a carrier row past the published window takes the warning colour and says
 * how long it has actually been. It is on the row rather than in a panel because the row is where
 * the reader is looking, and because it must never read as a commitment the carrier made.
 */
function WaitingCell({ row, wait }: { row: AdminProvisioningRow; wait: ProvisioningWait | null }) {
  if (wait === null) {
    return absentValue(row.terminal ? "not waiting" : "no wait recorded");
  }
  if (wait.kind === "carrier-unfiled") {
    return absentValue("awaiting submission receipt");
  }
  /*
   * "Past typical", never "overdue". Nothing was promised: `CARRIER_TYPICAL_DAYS` is a published
   * range the carrier observes on most filings, not a deadline it agreed to, so the variable and
   * the copy both name the window rather than a broken commitment.
   */
  const pastTypicalWindow = wait.kind === "carrier" && wait.days > CARRIER_TYPICAL_DAYS[1];
  /*
   * The qualifier is on the row, in the accessible output, and not only in `title`.
   *
   * The colour is an assertion -- amber on a bare "Day 27" reads as late -- and the sentence that
   * makes it honest, that this is past a typical window rather than past a promise, used to live
   * in a tooltip no touch or keyboard reader ever sees. A carrier row now carries its own window
   * beneath the count. It is per row rather than one line owned by the column, because the column
   * mixes carrier waits with plain step waits and no published window exists for a step: a
   * column-level note would be making a claim about rows it is not true of. The tooltip stays as
   * an addition, with the filing fact the cell has no room for.
   */
  const windowNote = wait.kind !== "carrier"
    ? null
    : `${pastTypicalWindow ? "past " : ""}typical ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days`;
  const count = (
    <span
      className={pastTypicalWindow ? "tabular-nums text-[var(--warning-text)]" : "tabular-nums text-[var(--body)]"}
      title={wait.kind === "carrier"
        ? `Filed with the carrier ${wait.days} days ago. Typical is ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days.`
        : `In this step for ${wait.days} days.`}
    >
      Day {wait.days}
    </span>
  );
  if (windowNote === null) return count;
  return (
    <span className="flex min-w-0 flex-col gap-[var(--s-1)]">
      {count}
      <span
        className="text-[length:var(--t-mono-meta)] leading-[var(--t-mono-meta-lh)] text-[var(--muted)]"
        data-slot="carrier-window-note"
      >
        {windowNote}
      </span>
    </span>
  );
}

/**
 * The canvas's view switch, with the one view that has nothing behind it left out.
 *
 * `AdminProvisioning.dc.html` draws `In progress / Live / Stalled`. Two of those are states a row
 * actually carries: `stalled` is set when a step passes its own threshold (three days on a
 * provider, twenty-one on a carrier, seventy-two hours on a coach), and everything else still
 * moving is in progress. **Live is not.** This page reads the provisioning tracker, and a client
 * that went live has left it -- there is no row here to filter for, so a `Live` segment would
 * always be empty and would read as "no clients are live" on a platform where plenty are. The
 * client book is where a live client is, and Live is a state it already shows.
 *
 * `Everything` replaces it rather than the switch shrinking to two, because a reader who filters
 * needs the way back, and the count on it is the honest total the two other segments split.
 */
const PROVISIONING_VIEWS = [
  { key: "progress", label: "In progress" },
  { key: "stalled", label: "Stalled" },
  { key: "all", label: "Everything" },
] as const;

type ProvisioningViewKey = (typeof PROVISIONING_VIEWS)[number]["key"];

export function provisioningViewRows(
  rows: readonly AdminProvisioningRow[],
  view: ProvisioningViewKey,
): readonly AdminProvisioningRow[] {
  if (view === "stalled") return rows.filter((row) => row.stalled || row.terminal);
  if (view === "progress") return rows.filter((row) => !row.stalled && !row.terminal);
  return rows;
}

export function AdminProvisioning({
  a2pSubmittedAtByTenant = {},
  children,
  enabled = true,
  authorized = true,
  hasDemoData = false,
  initialRows = [],
  initialError = null,
  installAttention = false,
  nowIso,
}: {
  a2pSubmittedAtByTenant?: Readonly<Record<string, string | null>>;
  children?: ReactNode;
  enabled?: boolean;
  authorized?: boolean;
  hasDemoData?: boolean;
  initialRows?: readonly ProvisioningTrackerRow[];
  initialError?: string | null;
  /** True right after a marketplace install callback, so its evidence opens without a hunt. */
  installAttention?: boolean;
  nowIso: string;
}) {
  const query = useQueryState();
  const setQueryValue = query.set;
  const requestedView = query.get("view");
  /*
   * `Everything` is the default, not `In progress`, and that is a departure from the artboard.
   * There the switch partitions a whole population three ways, so opening on the first segment
   * hides nothing a reader was not about to filter for anyway. Here `Live` does not exist, so
   * opening on `In progress` would open this page with every stalled row already hidden -- the
   * rows most likely to need somebody, on the page that exists to surface them. The switch adds a
   * way to narrow; it does not get to decide what a reader sees before they ask.
   */
  const rowView: ProvisioningViewKey = PROVISIONING_VIEWS
    .some((entry) => entry.key === requestedView)
    ? (requestedView as ProvisioningViewKey)
    : "all";
  const [rows, setRows] = useState<readonly ProvisioningTrackerRow[]>(initialRows);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<Record<string, LoggedActionReceipt>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(installAttention);
  /*
   * Screen 4b: the unblock is a dialog, not a `window.prompt`. The prompt it replaces could not
   * show the step, the state, who is blocking it or what the write does, and a browser prompt is
   * not a place to compose the sentence that becomes an audit receipt -- it has no hint, no
   * multiline field, and no way to show the receipt afterwards.
   */
  const [pendingUnblock, setPendingUnblock] = useState<
    { rowId: string; action: Extract<ProvisioningAdminAction, { kind: "unblock" }> } | null
  >(null);
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const view = useMemo(() => deriveAdminProvisioningView({
    enabled,
    authorized,
    rows,
    now,
  }), [authorized, enabled, now, rows]);

  const trackerById = useMemo(
    () => new Map(rows.map((row) => [row.signupIntentId, row])),
    [rows],
  );

  /**
   * How long this row has been waiting, in whole workspace days.
   *
   * Every non-terminal step has a `last_transition_at`, so every waiting row can carry a real day
   * count. The column used to read "Not waiting" on seven of seven rows because it only counted
   * carrier registrations, which left the one surface CLAUDE.md names for honest provisioning
   * states with no day counter on it at all. A carrier row still prefers its filed submission
   * receipt, because that is the date the coach is actually waiting from.
   */
  function waitingFor(row: AdminProvisioningRow): ProvisioningWait | null {
    if (row.terminal) return null;
    const facts = carrierFacts(row);
    if (facts.registering) {
      if (!facts.submittedAt) return { kind: "carrier-unfiled", days: 0 };
      const carrierDays = elapsedWorkspaceDays(facts.submittedAt, now);
      // An unreadable receipt date is the same fact as a missing one: there is no filing date to
      // count from, and the row says so rather than counting from today.
      if (carrierDays === null) return { kind: "carrier-unfiled", days: 0 };
      return { kind: "carrier", days: carrierDays, since: facts.submittedAt };
    }
    if (!row.waitingSince) return null;
    const days = elapsedWorkspaceDays(row.waitingSince, now);
    if (days === null) return null;
    return { kind: "step", days, since: row.waitingSince };
  }

  function carrierFacts(row: AdminProvisioningRow) {
    const trackerRow = trackerById.get(row.id);
    const registering = isCarrierRegistration(trackerRow);
    const submittedAt = registering && trackerRow?.tenantId
      ? a2pSubmittedAtByTenant[trackerRow.tenantId] ?? null
      : null;
    return { blocked: trackerRow?.state === "blocked", registering, submittedAt };
  }

  /**
   * Returns the outcome rather than only writing it to the page banner, because the unblock dialog
   * has to show its own failure beside the reason the operator just typed. The row-level callers
   * still get the banner; the dialog opts out of it, so a refusal is not narrated twice.
   */
  async function runAction(
    rowId: string,
    action: ProvisioningAdminAction,
    options: { reason?: string; reportOnPage?: boolean } = {},
  ): Promise<{ ok: true; receipt: LoggedActionReceipt } | { ok: false; message: string }> {
    const { reason, reportOnPage = true } = options;
    const trimmedReason = reason?.trim();
    if (action.kind === "unblock" && !trimmedReason) {
      return { ok: false, message: "Add a reason before unblocking this step." };
    }

    setBusy(rowId);
    setError(null);
    try {
      const response = await fetch("/api/admin/provisioning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action.kind === "retry"
          ? {
              action: "retry",
              tenantId: action.tenantId,
              step: action.step,
              expectedState: "failed",
            }
          : action.kind === "unblock"
            ? {
                action: "unblock",
                tenantId: action.tenantId,
                step: action.step,
                reason: trimmedReason,
              }
            : {
                action: "confirm_content",
                tenantId: action.tenantId,
                screenId: action.screenId,
              }),
      });
      const payload = await response.json() as { error?: unknown; receipt?: unknown };
      if (!response.ok) {
        const message = response.status === 409 && payload.error === "Blocked steps cannot be retried."
          ? payload.error
          : "The provisioning action could not be completed.";
        throw new Error(message);
      }
      const receipt = loggedActionReceipt(payload.receipt);
      if (!receipt) throw new Error("The audit receipt could not be verified.");
      setReceipts((current) => ({ ...current, [rowId]: receipt }));
      setRows((current) => current.map((row) => row.signupIntentId === rowId
        ? action.kind === "confirm_content"
          ? { ...row, contentScreenState: "confirmed" }
          : { ...row, state: "pending", errorCode: null, attempts: row.attempts + 1, stalledSince: null }
        : row));
      return { ok: true, receipt };
    } catch (actionError) {
      const message = actionError instanceof Error
        ? actionError.message
        : "The provisioning action could not be completed.";
      if (reportOnPage) setError(message);
      return { ok: false, message };
    } finally {
      setBusy(null);
    }
  }

  /** Every unblock goes through 4b's dialog; nothing else on the page asks for a reason. */
  function startAction(rowId: string, action: ProvisioningAdminAction) {
    if (action.kind === "unblock") {
      setPendingUnblock({ rowId, action });
      return;
    }
    void runAction(rowId, action);
  }

  async function confirmUnblock(input: { reason?: string }): Promise<Result> {
    if (!pendingUnblock) return { ok: false, message: "This step is no longer open for unblocking." };
    const outcome = await runAction(pendingUnblock.rowId, pendingUnblock.action, {
      reason: input.reason,
      reportOnPage: false,
    });
    if (!outcome.ok) return outcome;
    // `write_audit_row` returns a bigint, which crosses the wire as a numeric string. A receipt
    // whose id will not parse is not a receipt, and the dialog says so rather than showing "#NaN".
    const auditId = Number.parseInt(outcome.receipt.auditId, 10);
    if (!Number.isSafeInteger(auditId) || auditId <= 0) {
      return { ok: false, message: "The audit receipt could not be verified.", partial: true };
    }
    return { ok: true, receipt: { actionKey: outcome.receipt.actionKey, auditId } };
  }

  function rowActions(row: AdminProvisioningRow): RowAction[] {
    return row.actions.map((action) => ({
      id: action.kind,
      label: action.label,
      disabled: busy === row.id,
      logged: AUDIT_ACTIONS[action.actionKey].microcopy,
      onSelect: () => startAction(row.id, action),
      tone: action.kind === "unblock" ? ("critical" as const) : ("default" as const),
    }));
  }

  const columns = useMemo<ColumnDef<AdminProvisioningRow>[]>(() => [
    identityColumn<AdminProvisioningRow, string>({
      accessor: (row) => row.title,
      header: "Client",
      id: "work",
      secondary: (row) => row.stepLabel,
    }) as ColumnDef<AdminProvisioningRow>,
    {
      id: "step",
      accessorFn: (row) => row.stepLabel,
      header: "Step",
      meta: { cellKind: "secondary", label: "Step", minWidth: 180 },
    },
    {
      id: "state",
      accessorFn: (row) => carrierFacts(row).registering ? "Registering with carriers" : row.stateLabel,
      cell: ({ row }) => {
        const facts = carrierFacts(row.original);
        return (
          <StateBadge
            kind="lifecycle"
            label={facts.registering ? "Registering with carriers" : row.original.stateLabel}
            size="sm"
            tone={tone(row.original.tone)}
          />
        );
      },
      header: "State",
      meta: { cellKind: "state", label: "State" },
    },
    {
      id: "owner",
      accessorFn: (row) => ownerLabel(row),
      filterFn: "arrIncludesSome",
      header: "Owner",
      // Ships hidden while it reads "Platform and system" on nearly every row; a column with one
      // value spends a fifth of the table width to say nothing. It is still one press away.
      meta: { cellKind: "secondary", defaultHidden: true, label: "Owner" },
    },
    {
      id: "waiting",
      accessorFn: (row) => waitingFor(row)?.days ?? -1,
      cell: ({ row }) => <WaitingCell row={row.original} wait={waitingFor(row.original)} />,
      header: "Waiting",
      meta: { cellKind: "secondary", label: "Waiting", minWidth: 150 },
    },
    {
      id: "attempts",
      accessorFn: (row) => row.attemptsLabel,
      header: "Attempts",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Attempts" },
    },
    {
      id: "escalation",
      accessorFn: (row) => row.stalledLabel ?? "Not escalated",
      header: "Escalation",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Escalation" },
    },
    {
      id: "classification",
      accessorFn: (row) => row.dataClassification,
      header: "Data classification",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Data classification" },
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carrierFacts closes over the memoised tracker map and clock.
  ], [busy, now, trackerById, a2pSubmittedAtByTenant]);

  /**
   * The oldest carrier filing on the page, and how many are in flight behind it. One callout for
   * the whole wait rather than one per row: they all say the same thing and only the longest one
   * tells a reader whether it is time to chase.
   */
  const carrierWait = useMemo(() => {
    const days = view.rows.flatMap((row) => {
      const wait = waitingFor(row);
      return wait?.kind === "carrier" ? [wait.days] : [];
    });
    return days.length === 0 ? null : { count: days.length, days: Math.max(...days) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waitingFor closes over the memoised tracker map and clock.
  }, [view.rows, trackerById, now, a2pSubmittedAtByTenant]);

  /*
   * The filtered set the table renders. The stat strip, the carrier callout and the rail count all
   * stay on `view.rows` on purpose: they are facts about the platform, and a figure that moved
   * when a reader changed their view would be answering a question nobody asked.
   */
  const visibleRows = useMemo(
    () => provisioningViewRows(view.rows, rowView),
    [view.rows, rowView],
  );

  /*
   * `hasDemoData` is a page-level "there is some seeded data here" from the server, which is the
   * mixed-rows claim and stays a sentence. The chip is the stronger statement -- every client in
   * this view is a seeded one -- so it is computed from the rows on screen rather than from that
   * flag, and it is a demo workspace rather than a test tenant: `isDemo` is what the row carries
   * and what the row's own chip says.
   */
  const visibleProvenanceKind = wholePageProvenanceKind(
    visibleRows,
    (row) => (row.isDemo === true ? "demo" : null),
  );

  const selected = view.rows.find((row) => row.id === selectedId) ?? null;
  const selectedFacts = selected ? carrierFacts(selected) : null;

  const pendingRow = pendingUnblock
    ? view.rows.find((row) => row.id === pendingUnblock.rowId) ?? null
    : null;
  const pendingWait = pendingRow ? waitingFor(pendingRow) : null;

  /**
   * Screen 4a's four counts, and they are on `StatStrip` rather than the atomics' `FigureStrip`
   * for the reason `figure-strip.tsx` documents: a tracker that could not be read is not a tracker
   * with nothing in it. "Waiting on you: 0" is the best news this page can carry and has to print
   * as a measured zero, while a 503 from the tracker has to say it could not look -- and
   * `FigureStrip` collapses both into one absent string.
   *
   * The notes are facts about the same rows, never a forecast: how many clients the work spans,
   * how long the oldest coach-owned wait has run, and, for the provider band, that its clock
   * belongs to somebody else.
   */
  const tiles = useMemo<StatStripItem[]>(() => {
    const readable = view.enabled && view.authorized && initialError === null;
    const inFlight = view.rows.filter((row) => !row.terminal);
    const count = (label: string, of: readonly AdminProvisioningRow[], note?: string): StatStripItem => (
      readable
        ? {
          label,
          availability: { kind: "value", value: of.length, format: "count" },
          ...(note ? { note } : {}),
        }
        : { label, availability: { kind: "unavailable", note: "The tracker has not answered." } }
    );
    const byGroup = (group: ProvisioningPartyGroup) => inFlight.filter((row) => row.group === group);
    const coachRows = byGroup("coach");
    const oldestCoachWait = Math.max(
      0,
      ...coachRows.map((row) => waitingFor(row)?.days ?? 0),
    );
    return [
      count(
        "In flight",
        inFlight,
        `across ${new Set(inFlight.map((row) => row.tenantId ?? row.id)).size} clients`,
      ),
      count("Waiting on you", byGroup("platform"), "platform-owned"),
      count(
        "Waiting on coaches",
        coachRows,
        oldestCoachWait > 0 ? `oldest day ${oldestCoachWait}` : undefined,
      ),
      count("With providers", byGroup("provider"), "their clock, not yours"),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps -- waitingFor closes over the memoised tracker map and clock.
  }, [view.enabled, view.authorized, view.rows, initialError, trackerById, now, a2pSubmittedAtByTenant]);

  const body = !view.enabled ? (
    <DataState
      body="The tracker will appear when self-serve onboarding is enabled. Marketplace install evidence stays reachable from the header."
      kind="empty"
      title="Provisioning is not enabled"
    />
  ) : !view.authorized ? (
    <DataState
      body="This role cannot read provisioning records or perform provisioning actions."
      kind="empty"
      title="Provisioning access is restricted"
    />
  ) : (
    <div className="flex min-h-0 min-w-0 flex-col gap-[var(--s-3)]">
      {error ? (
        <div role="alert">
          <Callout body={error} title="Provisioning action could not be verified" tone="critical" />
        </div>
      ) : null}

      {carrierWait ? (
        /* The one state on this page nobody can hurry, said in days. No percentage, no predicted
           date, and no "all set" while a carrier still has the filing. */
        <div role="status">
          <Callout
            body={`${carrierWait.count === 1 ? "One coach is" : `${carrierWait.count} coaches are`} registering for text messaging. ${CARRIER_COPY}`}
            day={carrierWait.days}
            title="Text messaging is with the carrier"
            tone="warning"
          />
        </div>
      ) : null}

      {view.brainMissing ? (
        <div role="status">
          <Callout
            body="The Brain is not published. Go-live stays blocked until a published snapshot provides readiness evidence."
            title="Platform action required"
            tone="warning"
          />
        </div>
      ) : null}

      <DataTable
        ariaLabel="Provisioning tracker"
        columns={columns}
        data={visibleRows}
        emptyState={(
          <DataState
            body={rowView === "stalled"
              ? "Nothing has passed its own stall threshold. A row lands here after three days on a provider, twenty-one on a carrier, or seventy-two hours on a coach."
              : rowView === "progress"
                ? "No onboarding step is still moving. Anything that stopped is under Stalled."
                : "New onboarding work appears here when a signup reaches a platform, coach, or provider-owned step."}
            kind="empty"
            title={rowView === "all" ? "No provisioning work needs review" : "Nothing in this view"}
          />
        )}
        exportResource={{
          filename: "provisioning-steps",
          mode: "server",
          query: { order: "created_desc", reason: "" },
          resource: "provisioning-steps",
        }}
        facets={[{ columnId: "owner", options: ownerFacetOptions(visibleRows), title: "Owner" }]}
        /* 4a's footer line. It states the one rule a reader cannot infer from the rows: the
           refusal the API actually returns, and what unblocking past it costs. */
        footerNote="Blocked steps cannot be retried; unblocking records who and why"
        getRowId={(row) => row.id}
        groupBy={(row) => row.group}
        groups={PARTY_BANDS}
        onRowOpen={(row) => setSelectedId(row.id)}
        rowActions={rowActions}
        rowActionsLabel={(row) => `Actions for ${row.title}`}
        rowLabel={{ singular: "record", plural: "records" }}
        search={{ placeholder: "Search client or step" }}
        testRow={(row) => row.isDemo === true}
      />
    </div>
  );

  return (
    <AppShell
      activePath="/admin/provisioning"
      crumbs={CRUMBS}
      /*
       * Only the rows somebody here can move. Provider-owned work is a real wait but not a queue
       * depth: a carrier holding a filing for eleven days is not eleven days of unstarted work,
       * and putting it in the rail would ask the team to act on something it cannot touch.
       */
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/provisioning": view.rows.filter((row) => !row.terminal && row.group !== "provider").length,
      })}
      role="admin"
    >
      <ListPage
        /*
          The canvas's sentence, with its em dash spelled as a colon because `em-dash.test.ts`
          bans the character in UI copy. Its second clause is a promise rather than a description: day counters only, never a percentage and never a predicted date. It is
          worth saying on screen rather than only in `WaitingCell`, because it tells a reader that
          the absence of an ETA is the product working, not a column that failed to load.
          CLAUDE.md makes it a hard rule; this is where the reader is told about it.

          What the longer sentence this replaced also said -- that the queue is banded by who has
          to move a row -- is not lost, because the bands are on screen with their own headings
          and a description that narrates the layout is describing what the reader can already see.
        */
        description="Clients between signup and a live agent. Day counters only: nothing here shows a percentage or a predicted date."
        primaryAction={{ label: "Marketplace install", onClick: () => setInstallOpen(true) }}
        scope={view.enabled && view.authorized ? (
          /* Which rows the page is about, not how they are filtered, so it sits above the
             toolbar. The counts are the segments' own reason to exist: a reader picks Stalled
             because a number told them there was something in it. */
          <Segmented
            label="Provisioning view"
            onValueChange={(value) => setQueryValue("view", value)}
            options={PROVISIONING_VIEWS.map((entry) => {
              const count = provisioningViewRows(view.rows, entry.key).length;
              return {
                key: entry.key,
                label: entry.label,
                count,
                tone: entry.key === "stalled" && count > 0 ? ("warning" as const) : undefined,
              };
            })}
            value={rowView}
          />
        ) : undefined}
        stats={view.enabled && view.authorized ? (
          <StatStrip ariaLabel="Provisioning summary" items={tiles} />
        ) : undefined}
        provenance={hasDemoData && visibleProvenanceKind === null
          ? "Demo rows are labelled in the row and excluded from real analytics."
          : undefined}
        provenanceKind={visibleProvenanceKind ?? undefined}
        title="Provisioning"
      >
        {body}
      </ListPage>

      <RecordSheet
        onOpenChange={(open) => { if (!open) setSelectedId(null); }}
        open={selected !== null}
        sections={selected && selectedFacts ? [
          {
            title: "What is happening",
            body: (
              <div className="flex flex-col gap-[var(--s-2)]">
                <p className="t-muted m-0 max-w-[var(--measure-prose)]">
                  {selectedFacts.registering ? CARRIER_COPY : displayCopy(selected.detail)}
                </p>
                {selectedFacts.registering && selectedFacts.submittedAt ? (
                  <DayCounter
                    now={now}
                    since={selectedFacts.submittedAt}
                    typicalDays={CARRIER_TYPICAL_DAYS}
                  />
                ) : selectedFacts.registering ? (
                  <p className="t-muted m-0">
                    The day counter will appear when the submission receipt is available.
                  </p>
                ) : null}
              </div>
            ),
          },
          {
            title: "Evidence",
            fields: [
              { label: "Step", value: selected.stepLabel },
              { label: "Attempts", value: selected.attemptsLabel },
              { label: "Current owner", value: ownerLabel(selected) },
              {
                absence: "not escalated",
                label: "Escalation",
                value: selected.stalledLabel ?? undefined,
              },
            ],
          },
          {
            title: "Operator actions",
            body: (
              <div className="flex flex-wrap items-center gap-[var(--s-2)]">
                {selectedFacts.blocked ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" />}>
                      <LoggedButton actionKey="onboarding.step_retried" disabled type="button">
                        Retry
                      </LoggedButton>
                    </TooltipTrigger>
                    <TooltipContent>Blocked steps cannot be retried.</TooltipContent>
                  </Tooltip>
                ) : null}
                {selected.actions.map((action) => (
                  <LoggedButton
                    actionKey={action.actionKey}
                    disabled={busy === selected.id}
                    key={action.kind}
                    onClick={() => startAction(selected.id, action)}
                    type="button"
                    variant={action.kind === "unblock" ? "danger" : "secondary"}
                  >
                    {busy === selected.id ? "Recording..." : action.label}
                  </LoggedButton>
                ))}
                {receipts[selected.id] ? (
                  <StateBadge
                    kind="lifecycle"
                    label={receipts[selected.id].microcopy}
                    size="sm"
                    tone="good"
                  />
                ) : null}
                {selected.actions.length === 0 && !selectedFacts.blocked ? (
                  <p className="t-muted m-0">No operator action is available on this step.</p>
                ) : null}
              </div>
            ),
          },
        ] : []}
        state={selected && selectedFacts ? {
          kind: "lifecycle",
          label: selectedFacts.registering ? "Registering with carriers" : selected.stateLabel,
          tone: tone(selected.tone),
        } : undefined}
        states={selected ? [
          { kind: "tag", label: ownerLabel(selected), tone: "neutral" },
          ...(selected.isDemo === true
            ? [{ kind: "tag" as const, label: "Demo data", tone: "neutral" as const }]
            : []),
        ] : undefined}
        subtitle={selected
          ? `${selected.stepLabel}, waiting on ${ownerLabel(selected).toLocaleLowerCase()}`
          : ""}
        technical={selected ? [
          ...(selected.tenantId ? [{ label: "Tenant ID", value: selected.tenantId, mono: true }] : []),
          { label: "Data classification", value: selected.dataClassification, mono: false },
          ...(selected.safeError ? [{ label: "Error code", value: selected.safeError, mono: true }] : []),
        ] : undefined}
        title={selected?.title ?? ""}
      />

      {pendingUnblock && pendingRow ? (
        /*
         * 4b. Every claim in here is one the backend keeps: `unblock_provisioning_step` raises
         * `PROVISIONING_UNBLOCK_REASON_REQUIRED` on a blank reason, and writes an audit row
         * carrying the actor, the trimmed reason, the step key and the reason the step was blocked
         * under. The route refuses a receipt-less write. So the dialog may say "records who and
         * why" without qualification.
         *
         * What it does **not** say is the artifact's "the coach's Get started page moves to step 6
         * immediately". The function sets the step back to `pending` with `attempts = 0` and a
         * fresh `next_attempt_at` -- the step runs again, it does not complete -- so the
         * consequence line says that instead. A dialog that overstates an override is the exact
         * shape of the honest-states rule.
         */
        <ConfirmFlow
          action="onboarding.step_unblocked"
          confirmLabel="Unblock the step"
          consequence="This writes an audit receipt with your name, your reason and the step. The step returns to pending and runs again from the start; it is not marked complete."
          destructive
          impact={[
            { label: "Client", value: pendingRow.title },
            { label: "Step", value: pendingRow.stepLabel },
            { label: "State", value: pendingRow.stateLabel },
            { label: "Blocking party", value: ownerLabel(pendingRow) },
            {
              label: "Waiting",
              value: pendingWait && pendingWait.kind !== "carrier-unfiled"
                ? `day ${pendingWait.days}`
                : "no wait recorded",
            },
          ]}
          onConfirm={confirmUnblock}
          onOpenChange={(open) => { if (!open) setPendingUnblock(null); }}
          open
          reason={{
            required: true,
            label: "Why this is safe to override",
            hint: "The check being overridden is the one that blocked this step. Name the evidence that makes it safe: who confirmed it, and where that confirmation lives.",
          }}
          title={`Unblock ${pendingRow.stepLabel} for ${pendingRow.title}`}
        />
      ) : null}

      <RecordSheet
        onOpenChange={setInstallOpen}
        open={installOpen}
        sections={[{
          title: "Marketplace install",
          body: <div className="flex min-w-0 flex-col gap-[var(--s-6)]">{children}</div>,
        }]}
        subtitle="Agency install evidence and the approval attempts behind it. Stored history is not proof a connection still works."
        title="Marketplace install"
      />
    </AppShell>
  );
}
