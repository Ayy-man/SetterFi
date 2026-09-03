/**
 * What the Compliance blocks table says about a row, and which rows a set of filters leaves.
 *
 * This is the whole of the screen's reading logic, kept out of the component so it can be
 * exercised without rendering: labels a reader sees, the confirmation state a row is in, the
 * counts the chips carry, and the predicate the table filters by. Nothing here reads a clock or
 * touches the DOM; the component hands in `now` so a test can name the day.
 */

import type { StateTone } from "@/components/kit/state-badge";
import type {
  ComplianceRecord,
  LiveSuppressionRow,
  SuppressionTombstoneRow,
} from "@/components/workspace/live/admin-compliance";
import { complianceAffirmativeLabel } from "@/components/workspace/live/view-models";
import { displayName } from "@/lib/format/display-name";

/**
 * Why a block exists, in the words the table has room for. The six keys are the whole of
 * `suppression_source_chk`; an unrecognised value falls back to the humanised enum.
 */
const BLOCK_REASON: Record<string, string> = {
  complaint: "A complaint was recorded",
  deletion: "Kept through a permanent deletion",
  import: "Imported from a do-not-contact list",
  manual: "Recorded by hand",
  stop_intent: "Asked to stop in their own words",
  stop_keyword: "Replied STOP",
};

/** The reason a deletion record carries, exported because the tombstone branch is built from it. */
export const DELETION_REASON = BLOCK_REASON.deletion;

/** What recorded the block, in plain words. The row stores an enum and nobody's name. */
const BLOCK_SOURCE: Record<string, string> = {
  complaint: "Complaint",
  deletion: "Deletion",
  import: "Imported list",
  manual: "By hand",
  stop_intent: "Intent match",
  stop_keyword: "Keyword match",
};

/**
 * A recorded reason the seeders wrote rather than a person did.
 *
 * `scripts/seed-phase1-demo.mjs` stores "Synthetic STOP state" on every seeded block, so the Why
 * column read "Replied STOP (Synthetic STOP state)": the parenthetical repeated the mapped reason
 * and then said "this row is seeded", which the demo pill beside the name already says. A reason
 * a human typed, like "Asked at a live event", still earns its parenthetical.
 */
const SEEDED_REASON = /^(synthetic|seeded?|demo|test)\b/iu;

function humanize(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

/**
 * The vendor guard, applied before any enum falls through to `humanize`.
 *
 * `humanize` swaps separators and capitalises, so an unmapped `ghl_*` value reaches a reader
 * verbatim. Every column that can print a raw enum runs this first, not only Source: the whole
 * point of the guard is that the enum is not trusted, and a value the Source column rewrites
 * should not appear untouched in Why or Channel beside it.
 */
function withoutVendor(value: string) {
  return /ghl|highlevel|leadconnector|twilio/iu.test(value) ? "SMS" : null;
}

export function channelLabel(channel: string) {
  if (channel.toLowerCase() === "sms") return "SMS";
  return withoutVendor(channel) ?? humanize(channel);
}

/** The source enum never carries a vendor, and the guard keeps one from reaching a reader if it ever does. */
export function sourceLabel(source: string) {
  return withoutVendor(source) ?? BLOCK_SOURCE[source] ?? humanize(source);
}

export function identifierLabel(value: string | null) {
  return value ? `•••• ${value}` : "No display suffix";
}

export function blockReason(row: { source: string; reason: string | null }) {
  const base = BLOCK_REASON[row.source]
    ?? (withoutVendor(row.source) ? "Recorded on the texting channel" : humanize(row.source));
  const recorded = row.reason?.trim();
  return recorded && !SEEDED_REASON.test(recorded) ? `${base} (${recorded})` : base;
}

/**
 * One list, two kinds. A tombstone is the same promise after the contact behind it was forgotten,
 * so it sits in this table under its own source rather than behind a tab nobody thinks to open.
 */
export function complianceRecords(
  suppressions: readonly LiveSuppressionRow[],
  tombstones: readonly SuppressionTombstoneRow[],
): ComplianceRecord[] {
  return [
    ...suppressions.map((row): ComplianceRecord => ({
      id: `block:${row.id}`,
      kind: "block",
      tenantName: row.tenantName,
      channel: row.channel,
      contactName: row.contactName,
      identifierLast4: row.identifierLast4,
      reason: blockReason(row),
      recordedAt: row.createdAt,
      isDemo: row.isDemo,
      isTest: row.isTest,
      source: row.source,
      providerSyncState: row.providerSyncState,
      providerSyncedAt: row.providerSyncedAt,
      deletionAuditId: null,
    })),
    ...tombstones.map((row): ComplianceRecord => ({
      id: `deleted:${row.id}`,
      kind: "deleted",
      tenantName: row.tenantName,
      channel: row.channel,
      contactName: null,
      identifierLast4: row.identifierLast4,
      reason: DELETION_REASON,
      recordedAt: row.createdAt,
      isDemo: row.isDemo,
      isTest: false,
      source: "deletion",
      providerSyncState: null,
      providerSyncedAt: null,
      deletionAuditId: row.deletionAuditId,
    })),
  ];
}

/** A block waiting longer than this for its carrier confirmation is drawn amber. */
export const AMBER_AFTER_DAYS = 7;

const DAY_MS = 86_400_000;

/** Whole days between the moment a block was recorded and now. Absent when the date will not parse. */
export function daysWaiting(recordedAt: string, now: number | null): number | null {
  if (now === null) return null;
  const recorded = new Date(recordedAt).getTime();
  if (Number.isNaN(recorded)) return null;
  return Math.max(0, Math.floor((now - recorded) / DAY_MS));
}

/**
 * The column is called Confirmation, so its values do not repeat the word. A block no provider has
 * to confirm is an absence rather than a state, and a tombstone is enforced here and never sent.
 *
 * A pending row carries how long it has waited and turns amber only past `AMBER_AFTER_DAYS`: a
 * confirmation that arrived an hour ago is not a problem, and painting every one of them amber
 * spent the loudest colour on the ordinary case. The clock is handed in, so a row rendered before
 * the browser has a clock is simply "Pending" rather than a guess.
 */
export function recordConfirmation(
  row: { providerSyncState: string | null; providerSyncedAt: string | null; recordedAt?: string },
  now: number | null = null,
): { label: string; tone: StateTone; kind: "lifecycle" | "none" } {
  if (row.providerSyncState === null) {
    return { label: "Not required", tone: "neutral", kind: "none" };
  }
  const confirmed = complianceAffirmativeLabel({
    kind: "provider_confirmation",
    providerSyncState: row.providerSyncState,
    providerSyncedAt: row.providerSyncedAt,
  });
  if (confirmed) return { label: "Confirmed", tone: "good", kind: "lifecycle" };
  if (row.providerSyncState === "failed") return { label: "Failed", tone: "critical", kind: "lifecycle" };
  if (row.providerSyncState === "not_applicable") {
    return { label: "Not required", tone: "neutral", kind: "none" };
  }
  const waited = row.recordedAt ? daysWaiting(row.recordedAt, now) : null;
  return {
    label: waited === null ? "Pending" : `Pending · ${waited}d`,
    tone: waited !== null && waited > AMBER_AFTER_DAYS ? "warning" : "neutral",
    kind: "lifecycle",
  };
}

/* --------------------------------------------------------------------------------------------
 * Filters
 * ------------------------------------------------------------------------------------------ */

/**
 * The five count chips over the table. They are a filter and a figure at once: the tiles that used
 * to carry these numbers said the same thing and then left the reader to find the rows themselves.
 */
export type CountFilter = "all" | "confirmed" | "awaiting" | "failed" | "kept";

export const COUNT_FILTERS: readonly { id: CountFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "confirmed", label: "Confirmed" },
  { id: "awaiting", label: "Awaiting confirmation" },
  { id: "failed", label: "Failed" },
  { id: "kept", label: "Kept after deletion" },
];

export type BlockFilters = {
  count: CountFilter;
  /** A reason label as the Why column prints it, or `null` for every reason. */
  reason: string | null;
  /** A client name as the Client column prints it, or `null` for every client. */
  client: string | null;
  /** True narrows to blocks recorded in the last 30 days. */
  recent: boolean;
  search: string;
};

export const INITIAL_BLOCK_FILTERS: BlockFilters = {
  count: "all",
  reason: null,
  client: null,
  recent: false,
  search: "",
};

/** Which chip a row is counted under. A row nobody has to confirm belongs to All and nothing else. */
export function countBucket(row: ComplianceRecord): CountFilter | null {
  if (row.kind === "deleted") return "kept";
  const state = recordConfirmation(row);
  if (state.kind === "none") return null;
  if (state.label === "Confirmed") return "confirmed";
  if (state.label === "Failed") return "failed";
  return "awaiting";
}

export function blockCounts(records: readonly ComplianceRecord[]): Record<CountFilter, number> {
  const counts: Record<CountFilter, number> = {
    all: records.length,
    confirmed: 0,
    awaiting: 0,
    failed: 0,
    kept: 0,
  };
  for (const row of records) {
    const bucket = countBucket(row);
    if (bucket) counts[bucket] += 1;
  }
  return counts;
}

/** The client name as the table prints it: the seeded `(demo)` marker belongs to the pill, not the text. */
export function clientLabel(row: ComplianceRecord) {
  return displayName(row.tenantName);
}

export function reasonOptions(records: readonly ComplianceRecord[]): string[] {
  return [...new Set(records.map((row) => row.reason))].sort((a, b) => a.localeCompare(b));
}

export function clientOptions(records: readonly ComplianceRecord[]): string[] {
  return [...new Set(records.map(clientLabel))].sort((a, b) => a.localeCompare(b));
}

const RECENT_DAYS = 30;

export function matchesSearch(row: ComplianceRecord, query: string) {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return true;
  return [
    row.contactName ?? "",
    row.identifierLast4 ?? "",
    identifierLabel(row.identifierLast4),
    clientLabel(row),
    row.reason,
    channelLabel(row.channel),
    sourceLabel(row.source),
  ].some((value) => value.toLocaleLowerCase().includes(term));
}

/**
 * Every filter at once, so the chips, the dropdowns and the search box cannot disagree about what
 * the table shows. `now` only matters to the last-30-days chip; a null clock leaves it inert
 * rather than guessing a window.
 */
export function matchesBlockFilters(
  row: ComplianceRecord,
  filters: BlockFilters,
  now: number | null = null,
) {
  if (filters.count !== "all" && countBucket(row) !== filters.count) return false;
  if (filters.reason !== null && row.reason !== filters.reason) return false;
  if (filters.client !== null && clientLabel(row) !== filters.client) return false;
  if (filters.recent) {
    const waited = daysWaiting(row.recordedAt, now);
    if (waited === null || waited > RECENT_DAYS) return false;
  }
  return matchesSearch(row, filters.search);
}

/** True when anything other than the search box is narrowing the table. */
export function hasNarrowingFilter(filters: BlockFilters) {
  return filters.count !== "all"
    || filters.reason !== null
    || filters.client !== null
    || filters.recent
    || filters.search.trim().length > 0;
}
