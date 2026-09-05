"use client";

import type { ColumnDef, OnChangeFn, SortingState } from "@tanstack/react-table";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  MonoMeta,
  Monogram,
  Overline,
  Prose,
  STATE_TONE_TO_TONE,
  Segmented,
  Status,
  Surface,
  type Tone,
} from "@/components/kit/atomics";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { CellTwoLine } from "@/components/kit/cell-two-line";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { DataTableFacetedFilter } from "@/components/kit/data-table-faceted-filter";
import { DataTableToolbarShell } from "@/components/kit/data-table-toolbar";
import { ExportMenu } from "@/components/kit/export-menu";
import {
  ChevronLeft,
  ChevronRight,
  ListFilter,
  Search,
  SlidersHorizontal,
} from "@/components/kit/icons";
import { RecordSheet, type RecordSheetSection } from "@/components/kit/record-sheet";
import { StatStrip, type StatStripItem } from "@/components/kit/stat-strip";
import { TableFooterNote } from "@/components/kit/table-footer-note";
import { StateBadge, type StateTone } from "@/components/kit/state-badge";
import { ListPage } from "@/components/kit/templates/list-page";
import { type TechnicalDetailItem } from "@/components/kit/technical-detail";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/kit/tooltip";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  type AuditActionKey,
} from "@/lib/audit/actions";
import {
  AUDIT_VIEWS,
  auditCategoryOf,
  type AuditViewKey,
  type EventCategoryKey,
} from "@/lib/audit/views";
import { auditActionLabel } from "@/lib/copy/audit-labels";
import {
  WORKSPACE_DISPLAY_TIMEZONE,
  workspaceCountFormat,
  workspaceDateFormat,
  workspaceTimestampFormat,
} from "@/lib/format/datetime";
import { cn } from "@/lib/utils";

export type AdminAuditRow = {
  id: string;
  action: string;
  actor: string;
  /** Display name for the actor when the loader can resolve one; the id stays in `actor`. */
  actorName?: string | null;
  target: string;
  reason: string | null;
  at: string;
  testData: boolean | null;
  source: string | null;
  actorIp: string | null;
  /** Null for a platform-wide event: the change landed on every workspace, not on one of them. */
  tenantId?: string | null;
  /** The workspace's display name when the loader could resolve one. Never a fabricated label. */
  tenantName?: string | null;
};

export type AuditPagination = {
  totalRows: number;
  pageSize: number;
  pageIndex: number;
  hasPreviousPage: boolean;
  hasNextPage: boolean;
};

type AdminAuditLogProps = {
  enabled: boolean;
  rows: readonly AdminAuditRow[];
  pagination: AuditPagination;
  unavailableReason?: string | null;
  /**
   * How many workspaces are live *now*, for the blast-radius panel on a platform-wide event.
   * `null` means the count could not be read, and the panel says so in words rather than printing
   * a zero. It is deliberately never presented as the reach the event had when it happened: the
   * log does not record that, and a number labelled "now" is the only honest one available.
   */
  liveWorkspaceCount?: number | null;
  /**
   * How many events each saved view holds in the window the reader chose, counted by the loader.
   *
   * Not derived from `rows`. A count taken from the loaded page answers "how many pauses landed on
   * page one", which is a different question from the one a reader asks a segment labelled Pauses,
   * and it changed under them as they paged. `null` means the counts could not be read, and the
   * segments then carry no number rather than a wrong one.
   */
  viewCounts?: Record<AuditViewKey, number> | null;
  /**
   * The oldest instant this page's query would return, or null when the range is "All".
   *
   * Sent down rather than recomputed here so the sentence beside the range control names the
   * cutoff the SERVER actually used. A browser subtracting seven days from its own clock would
   * print a boundary the query did not use, which on a log whose entire value is "what happened
   * and when" is a small lie in the one place a reader would trust it.
   */
  rangeStart?: string | null;
  /**
   * The server's clock, so the day dividers can say "Today" and "Yesterday".
   *
   * Read on the server and passed down rather than taken from `new Date()` in the component: this
   * is a client component that Next renders on the server first, and a divider computed twice
   * against two clocks is a hydration mismatch on the one page whose whole job is being
   * trustworthy about when things happened. Omitting it drops the relative words and leaves the
   * absolute date, which is correct but harder to scan -- never a wrong day.
   */
  nowIso?: string | null;
};

export const AUDIT_ACTION_FILTER_OPTIONS = AUDIT_ACTION_KEYS.map((key) => ({
  label: auditActionLabel(key),
  value: key,
}));

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
  year: "numeric",
});

/**
 * One human predicate per registry key: the verb the actor performed and the object it landed on.
 * Typed against the closed key set, so a new audit action fails the build until it gets a sentence.
 */
type EventPhrase = { verb: string; object: string };

const EVENT_PHRASES: Record<AuditActionKey, EventPhrase> = {
  "affiliate.payout.approved": { verb: "approved", object: "an affiliate payout" },
  "affiliate.payout.sent": { verb: "sent", object: "an affiliate payout" },
  "appointment.attendance_set": { verb: "recorded", object: "attendance for a booked call" },
  "appointment.attendance_set.system": { verb: "recorded", object: "attendance from the calendar provider" },
  "appointment.canceled": { verb: "canceled", object: "a booked call" },
  "appointment.created": { verb: "booked", object: "a call" },
  "appointment.rescheduled": { verb: "rescheduled", object: "a booked call" },
  "auth.signed_out": { verb: "signed out", object: "of their account" },
  "billing.checkout.created": { verb: "started", object: "a checkout" },
  "billing.correction.approved": { verb: "approved", object: "a billing correction" },
  "billing.correction.rejected": { verb: "rejected", object: "a billing correction" },
  "billing.correction.requested": { verb: "requested", object: "a billing correction" },
  "billing.tenant.suspended": { verb: "suspended", object: "a client's subscription" },
  "billing.tenant.unsuspended": { verb: "restored", object: "a client's subscription" },
  "billing.tenant_override.updated": { verb: "updated", object: "a client's call allowance override" },
  "billing.tier.updated": { verb: "changed", object: "a client's plan" },
  "brain.import.accepted": { verb: "accepted", object: "an import into the Brain" },
  "brain.published": { verb: "published", object: "a new version of the Brain" },
  "brain.rolled_back": { verb: "rolled back", object: "the Brain to an earlier version" },
  "calendar.connected": { verb: "connected", object: "a calendar" },
  "calendar.disconnected": { verb: "disconnected", object: "a calendar" },
  "capi.dataset.provisioned": { verb: "set up", object: "a conversion tracking dataset" },
  "channel.connect.completed": { verb: "completed", object: "a channel connection" },
  "channel.connect.started": { verb: "started", object: "a channel connection" },
  "channel.disconnected": { verb: "disconnected", object: "a channel" },
  "channel.provider.switched": { verb: "switched", object: "a channel to another provider" },
  "channel.went_live": { verb: "activated", object: "a channel" },
  "coach.question.enabled.changed": { verb: "changed", object: "whether a qualifying question is asked" },
  "coach.question_order.saved": { verb: "saved", object: "the order of the qualifying questions" },
  "compliance.control_reply.published": { verb: "published", object: "an approved STOP, HELP or START reply" },
  "consent.opt_in": { verb: "recorded", object: "a consent opt-in" },
  "consent.opt_out": { verb: "recorded", object: "an opt-out" },
  "consent.web_form_recorded": { verb: "recorded", object: "consent from a web form" },
  "contact.created.manual": { verb: "created", object: "a lead record by hand" },
  "contact.delete": { verb: "deleted", object: "a lead record" },
  "contact.delete.preview": { verb: "previewed", object: "a lead deletion" },
  "contact.imported": { verb: "imported", object: "a batch of lead records" },
  "contact.merged": { verb: "merged", object: "two lead records" },
  "contact.note.added": { verb: "added", object: "a note to a lead record" },
  "contact.tag.added": { verb: "tagged", object: "a lead record" },
  "contact.tag.removed": { verb: "removed", object: "a tag from a lead record" },
  "contact.pipeline_stage.set": { verb: "moved", object: "a lead to another stage" },
  "contact.unmerged": { verb: "undid", object: "a lead merge" },
  "conversation.channel_continued": { verb: "continued", object: "a conversation on another channel" },
  "conversation.closed": { verb: "closed", object: "a conversation" },
  "conversation.closed.stale": { verb: "closed", object: "a conversation that went quiet" },
  "conversation.escalated": { verb: "escalated", object: "a conversation" },
  "conversation.guardrail.cleared": { verb: "cleared", object: "a guardrail hold" },
  "conversation.internal_note.added": { verb: "added", object: "an internal note" },
  "conversation.message.sent.human": { verb: "sent", object: "a message by hand" },
  "conversation.rehearsal.played": { verb: "rehearsed", object: "a lead's message on a test thread" },
  "conversation.scope_blocked": { verb: "blocked", object: "a reply outside the agent's scope" },
  "conversation.takeover.claimed": { verb: "took over", object: "a conversation" },
  "conversation.takeover.released": { verb: "handed back", object: "a conversation" },
  "conversation.tripwire.refused": { verb: "refused", object: "a message that hit a tripwire" },
  "eval.case.promoted": { verb: "promoted", object: "an eval case" },
  "eval.model_config.created": { verb: "created", object: "a model configuration" },
  "export.finished": { verb: "finished", object: "an export" },
  "export.started": { verb: "started", object: "an export" },
  "followup.canceled.inbound": { verb: "canceled", object: "a follow-up after the lead replied" },
  "followup.claimed": { verb: "claimed", object: "a follow-up" },
  "followup.completed": { verb: "completed", object: "a follow-up" },
  "followup.deferred.quiet_hours": { verb: "deferred", object: "a follow-up past quiet hours" },
  "followup.discarded.window_closed": { verb: "discarded", object: "a follow-up whose window closed" },
  "impersonation.ended": { verb: "ended", object: "a view-as session" },
  "impersonation.started": { verb: "started", object: "a view-as session" },
  "keyword_goal.deactivated": { verb: "deactivated", object: "a keyword goal" },
  "keyword_goal.saved": { verb: "saved", object: "a keyword goal" },
  "message_template.rejected": { verb: "recorded", object: "a rejected message template" },
  "message_template.submitted": { verb: "submitted", object: "a message template" },
  "notification.preference.changed": { verb: "changed", object: "where a notice reaches them" },
  "offer.draft.saved": { verb: "saved", object: "an offer draft" },
  "offer.published": { verb: "published", object: "an offer" },
  "onboarding.a2p_blocked_permanent": { verb: "recorded", object: "a permanent block on text message registration" },
  "onboarding.a2p_filing_confirmed": { verb: "confirmed", object: "the text message registration filing" },
  "onboarding.artifact_confirmed": { verb: "confirmed", object: "an onboarding artifact" },
  "onboarding.content_acknowledged": { verb: "acknowledged", object: "onboarding content" },
  "onboarding.content_admin_confirmed": { verb: "confirmed", object: "onboarding content" },
  "onboarding.signup_completed": { verb: "completed", object: "a signup" },
  "onboarding.step_failed": { verb: "recorded", object: "a failed provisioning step" },
  "onboarding.step_retried": { verb: "retried", object: "a provisioning step" },
  "onboarding.step_unblocked": { verb: "unblocked", object: "a provisioning step" },
  "platform_export.finished": { verb: "finished", object: "a platform export" },
  "platform_export.started": { verb: "started", object: "a platform export" },
  "provider.rotation.verified": { verb: "verified", object: "a provider key rotation" },
  "quiet_hours.window.change": { verb: "changed", object: "the quiet hours window" },
  "referral.code_rejected": { verb: "rejected", object: "a referral code" },
  "send.refused.no_consent": { verb: "refused", object: "a send without consent" },
  "send.refused.suppressed": { verb: "refused", object: "a send to a suppressed contact" },
  "send.refused.window_expired": { verb: "refused", object: "a send outside the messaging window" },
  "suppression.clear.provider": { verb: "cleared", object: "a suppression at the provider" },
  "suppression.correct": { verb: "corrected", object: "a suppression record" },
  "suppression.insert.keyword": { verb: "suppressed", object: "a contact after a stop keyword" },
  "suppression.insert.manual": { verb: "suppressed", object: "a contact by hand" },
  "suppression.provider.confirmed": { verb: "confirmed", object: "a suppression with the provider" },
  "suppression.provider.unconfirmed": { verb: "recorded", object: "a suppression the provider has not confirmed" },
  "suppression.push.failed": { verb: "recorded", object: "a failed suppression push" },
  "suppression.push.provider": { verb: "pushed", object: "a suppression to the provider" },
  "tenant.billing_contact_changed": { verb: "changed", object: "a client's billing contact" },
  "tenant.demo_flag.changed": { verb: "changed", object: "a client's test data flag" },
  "tenant.success_owner.reassigned": { verb: "reassigned", object: "a client's success owner" },
  "tenant.went_live": { verb: "activated", object: "a client workspace" },
  "test_recipient.registered": { verb: "registered", object: "a test recipient" },
};

const UNKNOWN_PHRASE: EventPhrase = { verb: "recorded", object: "an action" };

/**
 * The five kinds of thing an audit row can be, which is the vocabulary screen 1h puts on every
 * row as a pill and in the segmented control above them.
 *
 * The artifact draws six -- publish, override, takeover, pause, client edit, auto-fix -- and this
 * renders five: three of the artifact's are dropped and two buckets are ours ("automatic" and the
 * generic "change", which also absorbs "override"). "Client edit" is not derivable *honestly*:
 * `users.role` exists and this page already joins that table, but `audit_log` snapshots no role at
 * write time, so labelling by the current role would retroactively relabel history whenever
 * someone is promoted -- an audit row that changes meaning after the fact is worse than one that
 * says less. "Auto-fix" claims the system repaired something, which is true of a re-route and
 * false of a refused send; both are system-authored, so the derivable fact is "SetterFi did this
 * on its own" and the label says exactly that.
 *
 * Tones follow the artifact's own hues: teal for a publish, amber for a person stepping into a
 * live thread, clay for something that stopped, periwinkle for machine activity.
 */
const EVENT_CATEGORIES = {
  publish: { label: "publish", tone: "accent" },
  takeover: { label: "takeover", tone: "warning" },
  pause: { label: "pause", tone: "failure" },
  automatic: { label: "automatic", tone: "waiting" },
  change: { label: "change", tone: "neutral" },
  // Keyed by the shared union, so a category added to the rule cannot reach a row without a chip.
} as const satisfies Record<EventCategoryKey, { label: string; tone: Tone }>;

/*
 * The categories, the four saved views and the rule that maps an action key onto one of them all
 * live in `@/lib/audit/views`, because the loader applies the same rule in the query. This screen
 * no longer decides which rows are in the view: it is handed the view's rows and the view's count.
 */


/**
 * The 180px column in 1h: which workspaces the change landed on. The registry's own `scope` field
 * is the authority -- a platform-scoped key reaches everyone by construction -- and a tenant-scoped
 * row names its workspace when the loader resolved one. Nothing here counts agents: the artifact's
 * "all 14 agents" is a number the log does not record and this page will not invent.
 */
function scopeOf(row: AdminAuditRow): { label: string; platformWide: boolean } {
  const key = knownActionKey(row.action);
  const platformWide = key ? AUDIT_ACTIONS[key].scope === "platform" : row.tenantId == null;
  if (platformWide) return { label: "Every workspace", platformWide: true };
  const name = row.tenantName?.trim();
  return { label: name || "One workspace", platformWide: false };
}

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time unavailable" : workspaceTimestampFormat.format(date);
}

/**
 * The day divider, in the words screen 1h uses: `TODAY · AUG 31`, not `August 31, 2026`.
 *
 * The relative token is the half that makes a long log scannable -- a reader scrolling for what
 * just happened is looking for a word, not doing date arithmetic -- and the absolute date stays
 * beside it so nothing depends on the reader knowing what today is. Both are formatted in the
 * workspace timezone, which is why the comparison is on the formatted string rather than on the
 * two `Date` objects: comparing timestamps would call an event "today" or not according to the
 * viewer's own timezone, which is exactly the drift this page cannot afford.
 *
 * With no server clock the label is the absolute date alone. Less scannable, never wrong.
 */
function dayLabel(value: string, nowIso: string | null) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  const absolute = dayFormat.format(date);
  const now = nowIso === null ? null : new Date(nowIso);
  if (!now || Number.isNaN(now.getTime())) return absolute;
  if (dayFormat.format(now) === absolute) return `Today \u00b7 ${absolute}`;
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (dayFormat.format(yesterday) === absolute) return `Yesterday \u00b7 ${absolute}`;
  return absolute;
}

function knownActionKey(value: string): AuditActionKey | null {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, value)
    ? value as AuditActionKey
    : null;
}

function eventPhrase(action: string): EventPhrase {
  const key = knownActionKey(action);
  return key ? EVENT_PHRASES[key] : UNKNOWN_PHRASE;
}

function eventLabel(value: string) {
  const phrase = eventPhrase(value);
  return `${phrase.verb.charAt(0).toLocaleUpperCase()}${phrase.verb.slice(1)} ${phrase.object}`;
}

/** The registry's "… logged" line for an event, or the neutral fallback for an unknown key. */
function auditMicrocopy(action: string) {
  const key = knownActionKey(action);
  return key ? AUDIT_ACTIONS[key].microcopy : "Logged";
}

function isSystemAction(action: string) {
  const key = knownActionKey(action);
  return key ? AUDIT_ACTIONS[key].actorKind === "system" : false;
}

/**
 * The outcome column reads the event itself, never a separate field the log does not carry. A
 * refusal, a block, or a failure is a different thing to review than a completion, and everything
 * else is simply a recorded change.
 */
const OUTCOMES = {
  refused: { label: "Refused", tone: "critical" },
  failed: { label: "Failed", tone: "critical" },
  reversed: { label: "Reversed", tone: "warning" },
  completed: { label: "Completed", tone: "good" },
  recorded: { label: "Recorded", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: StateTone }>;

const OUTCOME_KEYS = ["refused", "failed", "reversed", "completed", "recorded"] as const;

type OutcomeKey = (typeof OUTCOME_KEYS)[number];

const OUTCOME_SUFFIXES: readonly (readonly [string, OutcomeKey])[] = [
  [".refused", "refused"],
  [".rejected", "refused"],
  ["_blocked", "refused"],
  [".scope_blocked", "refused"],
  [".a2p_blocked_permanent", "refused"],
  [".failed", "failed"],
  [".unconfirmed", "failed"],
  [".canceled", "reversed"],
  [".rolled_back", "reversed"],
  [".unmerged", "reversed"],
  [".disconnected", "reversed"],
  [".discarded.window_closed", "reversed"],
  [".suspended", "reversed"],
  [".approved", "completed"],
  [".completed", "completed"],
  [".confirmed", "completed"],
  [".verified", "completed"],
  [".finished", "completed"],
  [".published", "completed"],
  [".went_live", "completed"],
  [".accepted", "completed"],
  [".sent", "completed"],
];

function outcomeOf(action: string): { label: string; tone: StateTone } {
  for (const [suffix, key] of OUTCOME_SUFFIXES) {
    if (action.endsWith(suffix)) return OUTCOMES[key];
  }
  return OUTCOMES.recorded;
}

/** Two actor roles reach the screen, because the registry records exactly two actor kinds. */
const ACTOR_ROLES = [
  { key: "human", label: "Person" },
  { key: "system", label: "SetterFi system" },
] as const;

function actorRoleOf(row: AdminAuditRow) {
  return isSystemAction(row.action) ? ACTOR_ROLES[1] : ACTOR_ROLES[0];
}

type AuditActor = { name: string; kind: "person" | "system" | "unknown" };

/** A name when the row carries one, "Operator" for a bare user id, and the system otherwise. */
function actorFor(row: AdminAuditRow): AuditActor {
  const name = row.actorName?.trim();
  if (name) return { name, kind: "person" };
  if (row.actor === "Actor unavailable") {
    return isSystemAction(row.action)
      ? { name: "SetterFi", kind: "system" }
      : { name: "Actor unavailable", kind: "unknown" };
  }
  if (UUID_PATTERN.test(row.actor)) return { name: "Operator", kind: "person" };
  return { name: row.actor, kind: isSystemAction(row.action) ? "system" : "person" };
}

function actorLabel(row: AdminAuditRow) {
  return actorFor(row).name;
}

function targetParts(value: string) {
  if (value === "Target unavailable") {
    return { label: value, type: null, id: null };
  }
  const separator = value.indexOf(": ");
  if (separator === -1) return { label: "Affected record", type: null, id: value };
  const type = value.slice(0, separator);
  const id = value.slice(separator + 2);
  const label = type.startsWith("ghl_")
    ? "Text messages (SMS)"
    : type.startsWith("calendar_") || type === "appointment"
      ? "Calendar"
      : type.startsWith("brain_")
        ? "The Brain"
        : type
          .replaceAll(/[._-]+/g, " ")
          .replace(/^./, (character) => character.toLocaleUpperCase());
  return { label: label || "Affected record", type, id };
}

function sourceLabel(value: string) {
  return value
    .replaceAll(/[._-]+/g, " ")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

function auditExportSearch(search: string) {
  return search ? { search } : {};
}

function technicalItems(row: AdminAuditRow): TechnicalDetailItem[] {
  const target = targetParts(row.target);
  return [
    { label: "Event ID", value: row.id },
    ...(row.actor !== "Actor unavailable" ? [{ label: "Actor ID", value: row.actor }] : []),
    ...(target.type ? [{ label: "Target type", value: target.type }] : []),
    ...(target.id ? [{ label: "Target ID", value: target.id }] : []),
    { label: "Action key", value: row.action },
    { label: "Recorded", value: row.at },
  ];
}

function EventSentence({ row }: { row: AdminAuditRow }) {
  const phrase = eventPhrase(row.action);
  return (
    <>
      <strong className="font-medium text-[var(--ink)]">{actorLabel(row)}</strong>
      {` ${phrase.verb} `}
      <span className="font-medium text-[var(--ink)]" data-slot="feed-row-object">
        {phrase.object}
      </span>
    </>
  );
}

function AbsentSection({ body, title }: { body: string; title: string }) {
  return <DataState body={body} kind="empty" title={title} />;
}

function EventList({
  currentId,
  onSelect,
  rows,
}: {
  currentId: string;
  onSelect: (id: string) => void;
  rows: readonly AdminAuditRow[];
}) {
  return (
    <ol className="m-0 flex list-none flex-col gap-[var(--s-2)] p-0">
      {rows.map((row) => (
        <li className="flex min-w-0 items-baseline gap-[var(--s-2)]" key={row.id}>
          <span className="tabular shrink-0 text-[length:var(--t-badge)] text-[var(--faint)]">
            {timestamp(row.at)}
          </span>
          {row.id === currentId ? (
            <span className="min-w-0 text-[var(--ink)]">
              <EventSentence row={row} />
              <span className="t-overline ml-[var(--s-2)]">This event</span>
            </span>
          ) : (
            <button
              className="link-inline min-w-0 border-0 bg-transparent p-0 text-left text-[length:var(--t-body)]"
              onClick={() => onSelect(row.id)}
              type="button"
            >
              <EventSentence row={row} />
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * Screen 1i opens a publish onto its blast radius: who it took effect on, and what has happened
 * since. Two of those three facts are in the code and one is not, so this panel prints the two and
 * names the third rather than leaving a hole the reader fills in with an assumption.
 *
 * What is derivable: the registry's `scope`, which says by construction whether a key reaches every
 * workspace or one, and the workspace's own name on a tenant-scoped row. What is not: how many
 * workspaces were live at the moment of the publish, and how many conversations have run on the
 * new version since. The live count is therefore labelled "now" every time it appears, because a
 * bare number beside "took effect on" would read as the historical reach.
 */
function BlastRadius({
  liveWorkspaceCount,
  row,
}: {
  liveWorkspaceCount: number | null;
  row: AdminAuditRow;
}) {
  const scope = scopeOf(row);
  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-3)]">
      <Surface className="min-w-0" variant="well">
        <Overline className="block">Took effect on</Overline>
        <div className="mt-[var(--s-1)] text-[length:var(--t-row)] text-[color:var(--ink)]">
          {scope.label}
        </div>
        <MonoMeta className="mt-[2px] block">
          {scope.platformWide
            ? liveWorkspaceCount === null
              ? "how many are live is not readable right now"
              : `${workspaceCountFormat.format(liveWorkspaceCount)} live now`
            : "this workspace only"}
        </MonoMeta>
      </Surface>
      <Prose
        className="text-[12.5px] leading-[1.5] text-[color:var(--muted)]"
        data-slot="blast-radius-limit"
      >
        {scope.platformWide
          ? "The log records that this happened and why, not how many workspaces were live at the time or how many conversations have run since. Compare the versions in The Brain for the wording that changed."
          : "The log records that this happened and why, not the wording that changed. Open the workspace to see the settings as they stand now."}
      </Prose>
    </div>
  );
}

function eventSections({
  liveWorkspaceCount,
  onSelect,
  related,
  row,
  trail,
}: {
  liveWorkspaceCount: number | null;
  onSelect: (id: string) => void;
  related: readonly AdminAuditRow[];
  row: AdminAuditRow;
  trail: readonly AdminAuditRow[];
}): readonly RecordSheetSection[] {
  const target = targetParts(row.target);
  return [
    {
      /*
       * 1i's diff area, as much of it as exists. The reason the actor typed is the plain-language
       * account of the change; the per-block before/after the artifact draws is not stored
       * anywhere this page can read, so nothing here pretends to render one.
       */
      title: "Blast radius",
      body: <BlastRadius liveWorkspaceCount={liveWorkspaceCount} row={row} />,
    },
    {
      /*
       * The kit's field grid rather than a hand-built list: an absent origin or reason then reads
       * as italic faint words in the value column instead of a sentence dressed as data, and the
       * keys line up down the drawer. "Recorded" is not a field here -- the footer's audit line
       * already carries when this event happened and who caused it.
       */
      title: "What happened",
      fields: [
        { label: "Actor", value: actorLabel(row) },
        { label: "Event", value: eventLabel(row.action) },
        { label: "Target", value: target.label },
        {
          absence: "no origin recorded",
          label: "Source",
          value: row.source ? sourceLabel(row.source) : undefined,
        },
        {
          absence: "no address recorded",
          label: "IP address",
          mono: true,
          value: row.actorIp ?? undefined,
        },
        {
          absence: "no reason was given",
          label: "Reason",
          value: row.reason?.trim() || undefined,
        },
      ],
    },
    {
      title: "Lineage",
      body: trail.length > 1 ? (
        <EventList currentId={row.id} onSelect={onSelect} rows={trail} />
      ) : (
        <AbsentSection
          body="No other event on this page touched the same record, so there is no trail to show."
          title="No lineage on this page"
        />
      ),
    },
    {
      title: "Related",
      body: related.length > 0 ? (
        <EventList currentId={row.id} onSelect={onSelect} rows={related} />
      ) : (
        <AbsentSection
          body="This actor has no other event on this page."
          title="Nothing related on this page"
        />
      ),
    },
  ];
}


/**
 * One row of screen 1h: monogram, the sentence, where it landed, what kind of change it was, and
 * the time. Five columns, and each is a different question, which is why none of them repeats
 * another -- the category pill says what kind of event this is, the scope column says who felt it.
 *
 * The whole row is one button rather than a row with a button in it, because there is exactly one
 * thing to do with an audit event and it is to open it. Selection is a background tint and a
 * hairline, never an edge stripe.
 */
function AuditFeedRow({
  onSelect,
  row,
  selected,
  showActor,
}: {
  onSelect: () => void;
  row: AdminAuditRow;
  selected: boolean;
  showActor: boolean;
}) {
  const actor = actorFor(row);
  const phrase = eventPhrase(row.action);
  const scope = scopeOf(row);
  const category = EVENT_CATEGORIES[auditCategoryOf(row.action)];

  return (
    <button
      aria-label={`Open event detail: ${eventLabel(row.action)}`}
      aria-pressed={selected}
      className={cn(
        "flex w-full min-w-0 items-center gap-[13px] border-b border-[var(--line-soft)] px-[var(--s-4)] py-[11px] text-left last:border-b-0",
        "transition-colors duration-[var(--duration-quick)] motion-reduce:transition-none hover:bg-[var(--row-hover)]",
        selected && "bg-[var(--row-selected)]",
      )}
      data-selected={selected ? "true" : undefined}
      data-slot="audit-row"
      data-test-data={row.testData === true ? "true" : undefined}
      data-testid="audit-row"
      onClick={onSelect}
      type="button"
    >
      {/*
        A repeated monogram down a run of one actor's events is five copies of the same mark, so
        only the first of a run wears it. The sentence still names the actor on every row, so
        nothing is carried by the avatar alone.
      */}
      {showActor
        ? <Monogram className="shrink-0" kind="person" name={actor.name} size={26} />
        : <span aria-hidden className="size-[26px] shrink-0" />}

      <span
        className="min-w-0 flex-1 truncate text-[12.5px] leading-[1.4] text-[color:var(--body)]"
        data-slot="audit-row-sentence"
        data-testid="feed-row-sentence"
      >
        <strong className="font-[600] text-[color:var(--ink)]">{actor.name}</strong>
        {` ${phrase.verb} `}
        <span className="font-[600] text-[color:var(--ink)]" data-slot="feed-row-object">
          {phrase.object}
        </span>
        {/*
          Seeded rows sit in the same log as real ones, so a test row says so on the row itself
          and not only in the page's provenance line. It is words, never a tint.
        */}
        {row.testData === true ? (
          <MonoMeta className="ml-[var(--s-2)] text-[10.5px]" data-slot="audit-row-test">
            test data
          </MonoMeta>
        ) : null}
      </span>

      <MonoMeta
        className="hidden w-[180px] shrink-0 truncate text-[10.5px] @min-[860px]:block"
        data-slot="audit-row-scope"
      >
        {scope.label}
      </MonoMeta>

      <span className="hidden w-[120px] shrink-0 @min-[720px]:block">
        <Status label={category.label} tone={category.tone} />
      </span>

      {/* The clock is the one thing that differs between two otherwise identical renders. */}
      <MonoMeta
        className="w-[74px] shrink-0 text-right text-[10.5px]"
        data-volatile=""
      >
        {timestamp(row.at)}
      </MonoMeta>
    </button>
  );
}

function AuditFeed({
  nowIso,
  onSelect,
  rows,
  selectedId,
}: {
  nowIso: string | null;
  onSelect: (id: string) => void;
  rows: readonly AdminAuditRow[];
  selectedId: string | null;
}) {
  const grouped = useMemo(() => {
    const groups = new Map<string, AdminAuditRow[]>();
    for (const row of rows) {
      const label = dayLabel(row.at, nowIso);
      groups.set(label, [...(groups.get(label) ?? []), row]);
    }
    return [...groups.entries()];
  }, [nowIso, rows]);

  return (
    <div className="@container" data-testid="audit-feed">
      {grouped.map(([day, dayRows]) => (
        <section aria-labelledby={`audit-day-${dayRows[0]?.id}`} key={day}>
          {/*
            1h's mono day label, kept as a section heading rather than a filled band: a run of
            filled bands down a long log reads as five headers competing with the rows under them.
          */}
          <h2
            className="t-overline m-0 flex items-center justify-end border-b border-[var(--line-soft)] px-[var(--s-4)] py-[var(--s-2)]"
            id={`audit-day-${dayRows[0]?.id}`}
          >
            {day}
          </h2>
          {dayRows.map((row, index) => {
            // Every row in the audit log is, by definition, logged. Printing each event's
            // "\u2026 logged" microcopy as an uppercase overline put a machine-sounding token on
            // the right half of every row and said nothing the page had not already said. The
            // microcopy still appears once, on the record sheet for the event you opened.
            const previousActor = index === 0 ? null : actorFor(dayRows[index - 1]!).name;
            return (
              <AuditFeedRow
                key={row.id}
                onSelect={() => onSelect(row.id)}
                row={row}
                selected={row.id === selectedId}
                showActor={actorFor(row).name !== previousActor}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

/**
 * What the order does not mean, printed under every count on this page.
 *
 * A reader looking at a log sorted by time reads the top row as the most recent *change*. It is
 * the most recently *recorded* one, and the two come apart whenever a change is written by a
 * provider callback minutes after the thing it describes happened. The log stores one of those and
 * not the other, so the sentence says so rather than letting the sort imply otherwise.
 */
const FOOTER_NOTE =
  "Order is when each event was recorded. The log does not store when the change took effect.";

/** Every band here is a day, and every day boundary is drawn on the same clock. */
const GROUP_ANNOTATION = "day boundaries follow the workspace clock in New York";

function PaginationSummary({
  ordering,
  pagination,
  onNext,
  onPrevious,
  shownRows,
  viewNote,
}: {
  ordering: string;
  pagination: AuditPagination;
  onNext: () => void;
  onPrevious: () => void;
  shownRows: number;
  viewNote: string | null;
}) {
  const first = pagination.totalRows === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const last = pagination.totalRows === 0 ? 0 : Math.min(pagination.totalRows, first + shownRows - 1);
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-between gap-[var(--s-4)] py-[var(--s-2)] text-[length:var(--t-body)] text-[var(--muted)]"
      data-slot="audit-pagination"
    >
      {/* One count in one idiom: "202 events, showing 1 to 50" on the left and "Page 1 of 5" on
          the right were two spellings of the same fact, 1200px apart. */}
      <TableFooterNote
        note={FOOTER_NOTE}
        ordering={ordering}
        range={`${workspaceCountFormat.format(pagination.totalRows)} events, showing ${workspaceCountFormat.format(first)} to ${workspaceCountFormat.format(last)}${viewNote ? ` · ${viewNote}` : ""}`}
      />
      {pagination.totalRows > pagination.pageSize ? (
        <div className="flex items-center gap-[var(--s-1)]">
          <Button
            aria-label="Previous page"
            disabled={!pagination.hasPreviousPage}
            onClick={onPrevious}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronLeft aria-hidden />
          </Button>
          <Button
            aria-label="Next page"
            disabled={!pagination.hasNextPage}
            onClick={onNext}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const SEARCH_DEBOUNCE_MS = 250;

/**
 * The audit toolbar. Search and the action filter run against the whole log on the server, so they
 * write to the URL rather than into the table's own filter state; the saved views and the layout
 * choice are page state. The same row renders inside the table's toolbar and above the feed, so
 * the controls do not move when the layout does.
 */
/**
 * A single-choice facet chip, driven by the URL.
 *
 * Outcome and Actor role used to be table column filters, so switching from the table to the feed
 * silently dropped two of the three facets: the same page filtered differently depending on how it
 * was laid out. Holding them in the URL beside Action means one control set renders above both
 * layouts and survives the switch. The kit's chip is multi-select and each of these URL keys
 * holds one value, so the last value pressed is the one kept.
 */
function AuditFacet({
  active,
  onChange,
  options,
  title,
}: {
  active: string | null;
  onChange: (value: string | null) => void;
  options: readonly { label: string; value: string }[];
  title: string;
}) {
  return (
    <DataTableFacetedFilter
      onChange={(next) => onChange(next.at(-1) ?? null)}
      options={options}
      title={title}
      value={active === null ? [] : [active]}
    />
  );
}

/** The cutoff as a date, never as "7 days ago" -- a reader checking a window needs the boundary. */
function auditRangeStartLabel(value: string) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? "an unrecorded date" : workspaceDateFormat.format(parsed);
}

function AuditControls({
  activeAction,
  activeActorRole,
  activeClient,
  activeOutcome,
  activeRange,
  activeSearch,
  clientOptions,
  onActionChange,
  onActorRoleChange,
  onClientChange,
  onOutcomeChange,
  onRangeChange,
  onSearchChange,
  rangeStart,
}: {
  activeRange: "7d" | "30d" | "all";
  onRangeChange: (range: string) => void;
  /** The server's own cutoff for `activeRange`, or null on "All". */
  rangeStart: string | null;
  activeAction: string | null;
  activeActorRole: string | null;
  activeClient: string | null;
  activeOutcome: string | null;
  activeSearch: string;
  clientOptions: readonly { label: string; value: string }[];
  onActionChange: (action: string | null) => void;
  onActorRoleChange: (value: string | null) => void;
  onClientChange: (value: string | null) => void;
  onOutcomeChange: (value: string | null) => void;
  onSearchChange: (search: string) => void;
}) {
  const [draft, setDraft] = useState(() => ({ source: activeSearch, value: activeSearch }));
  const search = draft.source === activeSearch ? draft.value : activeSearch;
  const [actionOpen, setActionOpen] = useState(false);

  useEffect(() => {
    if (search === activeSearch) return;
    const timeout = window.setTimeout(() => onSearchChange(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [activeSearch, onSearchChange, search]);

  const actionLabel = activeAction ? auditActionLabel(activeAction as AuditActionKey) : null;

  return (
    <>
      {/*
        How far back the log is read, and it is a SERVER filter -- the outcome, actor-role and
        client facets beside it narrow the rows already loaded, which is right for a facet whose
        options come from those rows, and wrong for a window. "7 days" applied to one loaded page
        would show the last 50 events that happen to be recent, and the footer's total would answer
        a different question from the control above it.

        The mono face is the period-switch shape from the artifact rather than the sans view
        switch, because this changes the scope of the same list rather than which list it is.
      */}
      <Segmented
        face="mono"
        label="Time range"
        onValueChange={onRangeChange}
        options={[
          { key: "7d", label: "7 days" },
          { key: "30d", label: "30 days" },
          { key: "all", label: "All" },
        ]}
        value={activeRange}
      />
      {/*
        The explicit window the canvas draws, stated as the boundary the query actually used rather
        than as a range somebody picked. It comes from the server for the same reason the day
        dividers do: a browser computing "seven days ago" off its own clock would print a cutoff
        the query never applied.
      */}
      {rangeStart ? (
        <span className="text-[length:var(--t-body)] whitespace-nowrap text-[color:var(--muted)]">
          since {auditRangeStartLabel(rangeStart)}
        </span>
      ) : null}
      <div className="relative min-w-0 max-sm:w-full">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-[var(--s-2)] size-[var(--s-3)] -translate-y-1/2 text-[var(--muted)]"
        />
        <Input
          aria-label="Search events"
          className="w-full pl-[var(--s-6)] sm:w-[calc(var(--drawer-w)/2)]"
          onChange={(event) => setDraft({ source: activeSearch, value: event.target.value })}
          placeholder="Search events"
          type="search"
          value={search}
        />
      </div>
      <DropdownMenu
        onOpenChange={(nextOpen, details) => {
          if (details.reason !== "trigger-press") setActionOpen(nextOpen);
        }}
        open={actionOpen}
      >
        <DropdownMenuTrigger
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "border-dashed data-[popup-open]:bg-[var(--quiet)]",
          )}
          onClick={() => setActionOpen((current) => !current)}
        >
          <ListFilter aria-hidden className="size-[var(--s-3)]" />
          Action
          {actionLabel ? (
            <StateBadge dot={false} kind="tag" label={actionLabel} size="sm" tone="neutral" />
          ) : null}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          aria-label="Filter by action"
          className="relative max-h-[var(--drawer-w)] min-w-[calc(var(--drawer-w)/2)] overflow-y-auto"
        >
          <DropdownMenuRadioGroup
            onValueChange={(value) => onActionChange(value === "all" ? null : String(value))}
            value={activeAction ?? "all"}
          >
            <DropdownMenuLabel>Action</DropdownMenuLabel>
            <DropdownMenuRadioItem value="all">Every action</DropdownMenuRadioItem>
            {AUDIT_ACTION_FILTER_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <AuditFacet
        active={activeOutcome}
        onChange={onOutcomeChange}
        options={OUTCOME_KEYS.map((key) => ({ label: OUTCOMES[key].label, value: OUTCOMES[key].label }))}
        title="Outcome"
      />
      <AuditFacet
        active={activeActorRole}
        onChange={onActorRoleChange}
        options={ACTOR_ROLES.map((role) => ({ label: role.label, value: role.label }))}
        title="Actor role"
      />
      {/*
        1h's "Filter: all clients". The screen is named for this control -- "filterable to what did
        the client see change" -- so it sits with the other facets rather than behind Display. Its
        options are the workspaces that appear on the loaded page, never a roster the page has not
        read, and it is omitted entirely when every loaded row is platform-wide.
      */}
      {clientOptions.length > 0 ? (
        <AuditFacet
          active={activeClient}
          onChange={onClientChange}
          options={clientOptions}
          title="Client"
        />
      ) : null}
    </>
  );
}

/** The layout choice, written once and shown either inside Display or beside the feed. */
function LayoutChoice({
  display,
  onDisplayChange,
}: {
  display: "feed" | "table";
  onDisplayChange: (display: "feed" | "table") => void;
}) {
  return (
    <DropdownMenuRadioGroup
      onValueChange={(value) => onDisplayChange(value === "feed" ? "feed" : "table")}
      value={display}
    >
      <DropdownMenuLabel className="text-[length:var(--t-over)] font-[var(--t-over-w)] tracking-[var(--t-over-tr)] uppercase">
        Layout
      </DropdownMenuLabel>
      <DropdownMenuRadioItem value="table">Data table</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="feed">Event feed</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

/** In the feed layout there is no table, so the same choice needs its own trigger. */
function FeedLayoutMenu({
  display,
  onDisplayChange,
}: {
  display: "feed" | "table";
  onDisplayChange: (display: "feed" | "table") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu
      onOpenChange={(nextOpen, details) => {
        if (details.reason !== "trigger-press") setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        className={buttonVariants({ size: "sm", variant: "outline" })}
        onClick={() => setOpen((current) => !current)}
      >
        <SlidersHorizontal aria-hidden className="size-[var(--s-3)]" />
        Display
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Audit display options">
        <LayoutChoice display={display} onDisplayChange={onDisplayChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AdminAuditLog({
  enabled,
  liveWorkspaceCount = null,
  nowIso = null,
  rangeStart = null,
  rows,
  pagination,
  unavailableReason = null,
  viewCounts = null,
}: AdminAuditLogProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  /*
   * The feed is the screen now, and the table is the alternate. Screen 1h draws one panel of
   * sentences: a reader opens this page to find out who changed what, and a grid of nine columns
   * made them assemble that sentence themselves. The table stays behind Display, unchanged and
   * with its sorting, faceting, pagination and CSV/JSON export intact, because none of that has
   * anywhere else to live.
   */
  const display = searchParams.get("display") === "table" ? "table" : "feed";
  const ascending = searchParams.get("sort") === "oldest";
  // The range is a server-side filter like search and action, so it joins the signature that
  // resets paging. Leaving it out would keep a page-4 cursor pointing into a window that no longer
  // has four pages, and the reader would land on an empty page for a range that has events in it.
  // The view is a server-side filter now, so it joins the signature that resets paging: a page-4
  // cursor into Everything points nowhere in a Pauses window with one page in it.
  const filterSignature = `${searchParams.get("q") ?? ""}|${searchParams.get("action") ?? ""}|${searchParams.get("range") ?? ""}|${searchParams.get("view") ?? ""}`;
  const previousFilterSignature = useRef(filterSignature);
  const activeAction = searchParams.get("action");
  const activeSearch = (searchParams.get("q") ?? "").trim().slice(0, 120);
  const [exportReason, setExportReason] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const requestedView = searchParams.get("view");
  const activeView: AuditViewKey = AUDIT_VIEWS
    .find((view) => view.key === requestedView)?.key ?? "all";
  const activeViewDefinition = AUDIT_VIEWS.find((view) => view.key === activeView) ?? AUDIT_VIEWS[0];

  const requestedRange = searchParams.get("range");
  const activeRange = requestedRange === "7d" || requestedRange === "30d" ? requestedRange : "all";

  const activeOutcome = searchParams.get("outcome");
  const activeActorRole = searchParams.get("actorRole");
  const activeClient = searchParams.get("client");

  /*
   * Only the three facets are applied here. The view is not: the loader already ran it in the
   * query, so every row in hand belongs to the active view, and filtering again would mean the
   * page quietly showing nothing the moment the two spellings of the rule drifted apart.
   */
  const visibleRows = useMemo(
    () => rows.filter((row) => (!activeOutcome || outcomeOf(row.action).label === activeOutcome)
      && (!activeActorRole || actorRoleOf(row).label === activeActorRole)
      && (!activeClient || scopeOf(row).label === activeClient)),
    [activeActorRole, activeClient, activeOutcome, rows],
  );

  // The disclosure is about what is on screen, not about what was loaded: a reader filtered down
  // to eight seeded events is looking at a page of seeded events, whatever sits behind the filter.
  const allVisibleRowsAreTest = visibleRows.length > 0
    && visibleRows.every((row) => row.testData === true);

  const views = useMemo(
    () => AUDIT_VIEWS.map((view) => ({
      key: view.key,
      label: view.label,
      count: viewCounts ? viewCounts[view.key] : null,
    })),
    [viewCounts],
  );

  /*
   * The workspaces this page can honestly offer to filter by are the ones it has loaded. A roster
   * fetched from somewhere else would let a reader pick a client, see nothing, and conclude that
   * client changed nothing -- when the truth is that its events are on another page.
   */
  const clientOptions = useMemo(
    () => [...new Set(rows.filter((row) => !scopeOf(row).platformWide).map((row) => scopeOf(row).label))]
      .sort((first, second) => first.localeCompare(second))
      .map((label) => ({ label, value: label })),
    [rows],
  );

  /*
   * The strip states four facts the page already computes, and nothing it would have to guess at.
   * Three of the four are about *this page* rather than the log, because a cursor-paginated view
   * cannot count refusals across 212 events without asking the server for a number it does not
   * offer -- so the notes say "on this page" and the tiles never imply otherwise.
   *
   * Refusals and reversals carry the one tone on the screen. A zero there is a measured zero and
   * the good case, and `StatStrip` refuses to colour it, which is exactly right: an amber "0
   * refused" would report a healthy log as a problem.
   */
  const summaryTiles = useMemo<StatStripItem[]>(() => {
    const needsReading = visibleRows.filter((row) => {
      const tone = outcomeOf(row.action).tone;
      return tone === "critical" || tone === "warning";
    }).length;
    const people = new Set(
      visibleRows
        .filter((row) => actorFor(row).kind === "person")
        .map((row) => actorLabel(row)),
    );
    const systemActions = visibleRows.filter((row) => actorFor(row).kind !== "person").length;
    const workspaces = new Set(
      visibleRows.filter((row) => !scopeOf(row).platformWide).map((row) => scopeOf(row).label),
    );
    const platformWide = visibleRows.filter((row) => scopeOf(row).platformWide).length;
    const count = (value: number, singular: string, plural: string) =>
      `${workspaceCountFormat.format(value)} ${value === 1 ? singular : plural}`;

    return [
      {
        label: "Events recorded",
        availability: { kind: "value", value: pagination.totalRows, format: "count" },
        note: `${count(visibleRows.length, "event", "events")} on this page`,
      },
      {
        label: "Refused or reversed",
        availability: { kind: "value", value: needsReading, format: "count" },
        note: "on this page, the events that did not simply go through",
        tone: "warning",
      },
      {
        label: "People acting",
        availability: { kind: "value", value: people.size, format: "count" },
        note: `${count(systemActions, "event", "events")} the platform recorded itself`,
      },
      {
        label: "Workspaces touched",
        availability: { kind: "value", value: workspaces.size, format: "count" },
        note: `${count(platformWide, "event", "events")} landed on every workspace`,
      },
    ];
  }, [pagination.totalRows, visibleRows]);

  const replaceQuery = useCallback((updates: Record<string, string | null>, resetPaging = false) => {
    const params = new URLSearchParams(searchParams.toString());
    if (resetPaging) {
      params.delete("cursor");
      params.delete("direction");
      params.delete("page");
    }
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    if (previousFilterSignature.current === filterSignature) return;
    previousFilterSignature.current = filterSignature;
    if (searchParams.has("cursor") || searchParams.has("page")) {
      replaceQuery({}, true);
    }
  }, [filterSignature, replaceQuery, searchParams]);

  const sorting = useMemo<SortingState>(
    () => [{ id: "at", desc: !ascending }],
    [ascending],
  );
  const orderingLabel = ascending ? "oldest first" : "newest first";

  const changeSorting: OnChangeFn<SortingState> = useCallback((updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    const recorded = next.find((item) => item.id === "at");
    replaceQuery({ sort: recorded?.desc === false ? "oldest" : null }, true);
  }, [replaceQuery, sorting]);

  const navigate = useCallback((direction: "next" | "previous") => {
    const boundary = direction === "next" ? rows.at(-1) : rows.at(0);
    if (!boundary) return;
    const pageIndex = direction === "next"
      ? pagination.pageIndex + 1
      : Math.max(0, pagination.pageIndex - 1);
    replaceQuery({
      cursor: `${boundary.at}~${boundary.id}`,
      direction,
      page: String(pageIndex),
    });
  }, [pagination.pageIndex, replaceQuery, rows]);

  const columns = useMemo<ColumnDef<AdminAuditRow>[]>(() => [
    {
      accessorFn: (row) => timestamp(row.at),
      // The clock is the one thing on this page that differs between two otherwise identical
      // renders, so it carries the marker the visual suite masks on.
      cell: ({ getValue }) => (
        <span className="tabular-nums text-[var(--muted)]" data-volatile="">
          {String(getValue())}
        </span>
      ),
      enableSorting: true,
      header: "When",
      id: "at",
      meta: { cellKind: "secondary", label: "When", minWidth: 150 },
    },
    {
      accessorFn: (row) => actorLabel(row),
      /*
        The feed's identity mark and its role, in one cell. The role used to be a column of its own
        behind Display, which meant the table could not tell a person from the system without the
        reader going and turning a column on -- and it is the first thing anyone asks of an audit
        row.
      */
      cell: ({ row }) => (
        <CellTwoLine
          leading={
            <Monogram
              className="shrink-0"
              kind={actorFor(row.original).kind === "system" ? "account" : "person"}
              name={actorLabel(row.original)}
              size={22}
            />
          }
          primary={actorLabel(row.original)}
          subline={actorRoleOf(row.original).label}
        />
      ),
      enableSorting: false,
      header: "Actor",
      id: "actor",
      meta: { cellKind: "identity", label: "Actor", minWidth: 200, multiline: true },
    },
    {
      accessorFn: (row) => eventLabel(row.action),
      /*
        The event over the kind of change it was. The Kind column stays hidden and stays a column,
        because it is what the facet filters on; as a subline it costs no width and spares the row
        a second coloured pill beside Outcome.
      */
      cell: ({ row }) => (
        <CellTwoLine
          primary={eventLabel(row.original.action)}
          subline={EVENT_CATEGORIES[auditCategoryOf(row.original.action)].label.toLocaleLowerCase()}
        />
      ),
      enableSorting: false,
      header: "Action",
      id: "event",
      meta: { label: "Action", minWidth: 240, multiline: true },
    },
    {
      /*
        The feed's scope column, so the two layouts carry the same facts. Without it, switching to
        the table dropped the one thing screen 1h added: which workspaces felt the change.
      */
      accessorFn: (row) => scopeOf(row).label,
      enableSorting: false,
      header: "Where",
      id: "scope",
      meta: { cellKind: "secondary", label: "Where", minWidth: 150 },
    },
    {
      // The feed's category pill. Hidden by default because Outcome already occupies the table's
      // one state column, and two coloured pills per row is a row that reads as two states.
      accessorFn: (row) => EVENT_CATEGORIES[auditCategoryOf(row.action)].label,
      enableSorting: false,
      filterFn: "arrIncludesSome",
      header: "Kind",
      id: "category",
      meta: { defaultHidden: true, label: "Kind" },
    },
    {
      accessorFn: (row) => targetParts(row.target).label,
      enableSorting: false,
      header: "Target",
      id: "target",
      meta: { label: "Target" },
    },
    {
      accessorFn: (row) => outcomeOf(row.action).label,
      cell: ({ row }) => {
        const outcome = outcomeOf(row.original.action);
        /*
          The kit's status rather than the legacy badge, mapped through STATE_TONE_TO_TONE because
          the two vocabularies are not the same size. Bare, not a pill: a column of lozenges
          out-weighs the rows it sits beside, and the feed already spends the pill treatment on its
          category. The ordinary "Recorded" outcome drops the dot as well -- a mark beside every
          row on a page where most rows are unremarkable is a mark that says nothing.
        */
        return (
          <Status
            dot={outcome.label !== OUTCOMES.recorded.label}
            label={outcome.label}
            tone={STATE_TONE_TO_TONE[outcome.tone]}
            treatment="bare"
          />
        );
      },
      enableSorting: false,
      filterFn: "arrIncludesSome",
      header: "Outcome",
      id: "outcome",
      meta: { cellKind: "state", label: "Outcome" },
    },
    {
      accessorFn: (row) => actorRoleOf(row).label,
      enableSorting: false,
      filterFn: "arrIncludesSome",
      header: "Actor role",
      id: "actorRole",
      meta: { defaultHidden: true, label: "Actor role" },
    },
    {
      accessorFn: (row) => row.reason?.trim() || "No reason recorded",
      cell: ({ row }) => row.original.reason?.trim() || <CellQuiet>no reason was given</CellQuiet>,
      enableSorting: false,
      header: "Reason",
      id: "reason",
      meta: { defaultHidden: true, label: "Reason" },
    },
    {
      accessorFn: (row) => (row.source ? sourceLabel(row.source) : "Not recorded"),
      cell: ({ row }) => (row.original.source
        ? sourceLabel(row.original.source)
        : <CellQuiet>no origin recorded</CellQuiet>),
      enableSorting: false,
      header: "Source",
      id: "source",
      meta: { defaultHidden: true, label: "Source" },
    },
    {
      accessorFn: (row) => row.actorIp ?? "Not recorded",
      cell: ({ row }) => row.original.actorIp ?? <CellQuiet>no address recorded</CellQuiet>,
      enableSorting: false,
      header: "IP address",
      id: "actorIp",
      meta: { defaultHidden: true, label: "IP address" },
    },
  ], []);

  const selected = visibleRows.find((row) => row.id === selectedId) ?? null;

  const trail = useMemo(() => {
    if (!selected) return [];
    const targetId = targetParts(selected.target).id;
    if (!targetId) return [selected];
    return [...visibleRows]
      .filter((row) => targetParts(row.target).id === targetId)
      .sort((first, second) => first.at.localeCompare(second.at));
  }, [selected, visibleRows]);

  const related = useMemo(() => {
    if (!selected || selected.actor === "Actor unavailable") return [];
    return visibleRows.filter((row) => row.actor === selected.actor && row.id !== selected.id);
  }, [selected, visibleRows]);

  const exportControl = (
    <Tooltip>
      <TooltipTrigger
        render={(
          <span
            className="inline-flex"
            data-export-reason-required={!exportReason.trim() || undefined}
            onChangeCapture={(event) => {
              const target = event.target;
              if (target instanceof HTMLInputElement && target.id === "setterfi-audit-log-export-reason") {
                setExportReason(target.value);
              }
            }}
          />
        )}
      >
        <ExportMenu
          filename="setterfi-audit-log"
          mode="server"
          query={{
            action: activeAction ?? undefined,
            reason: exportReason,
            ...auditExportSearch(activeSearch),
          }}
          resource="audit-log"
        />
      </TooltipTrigger>
      <TooltipContent>
        {exportReason.trim()
          ? "CSV and JSON are enabled now that a reason is set."
          : "CSV and JSON are disabled until you add a reason in the export menu."}
      </TooltipContent>
    </Tooltip>
  );

  const changeDisplay = (next: "feed" | "table") =>
    replaceQuery({ display: next === "table" ? "table" : null });

  const controls = (
    <AuditControls
      activeRange={activeRange}
      onRangeChange={(range) => replaceQuery({ range: range === "all" ? null : range }, true)}
      rangeStart={rangeStart}
      activeAction={activeAction}
      activeActorRole={activeActorRole}
      activeClient={activeClient}
      activeOutcome={activeOutcome}
      activeSearch={activeSearch}
      clientOptions={clientOptions}
      onActionChange={(action) => replaceQuery({ action }, true)}
      onActorRoleChange={(actorRole) => replaceQuery({ actorRole })}
      onClientChange={(client) => replaceQuery({ client })}
      onOutcomeChange={(outcome) => replaceQuery({ outcome })}
      onSearchChange={(search) => replaceQuery({ q: search || null }, true)}
    />
  );

  /**
   * 1h's segmented control, transcribed: an outer well holding four pills, the active one a plain
   * white wash. It replaces the underlined tab pair this page used to wear, because the artifact
   * spends the tab shape on a record's sections and this shape on a list's scope, and a page that
   * uses the same object for both stops telling the reader which is which.
   *
   * Every count comes from the loader, over the whole window the range and the filters describe,
   * so a segment reads the same on page four as on page one. The segment stays visible at zero,
   * because "no pauses in this window" is a fact worth reading, and the body then says so in
   * words. A window whose counts could not be read shows the segments with no number on them.
   */
  const scopeSwitch = (
    <Segmented
      className="mb-[var(--s-3)]"
      label="Event kinds"
      onValueChange={(value) => replaceQuery({ view: value === "all" ? null : value })}
      options={views.map((view) => ({
        key: view.key,
        label: view.label,
        ...(view.count === null ? {} : { count: workspaceCountFormat.format(view.count) }),
      }))}
      value={activeView}
    />
  );

  /*
   * Two different emptinesses, and the view is now on the server side of the line between them.
   * An empty page in a saved view is the whole window's answer, so it no longer tells the reader
   * to page on in the hope of finding one -- there are none to find. Rows in hand and nothing
   * visible is the facets, which are the only filters still applied in the browser.
   */
  const noRows = rows.length === 0 ? (
    <DataState
      body={activeView === "all"
        ? "Change or clear the filters to see recorded activity."
        : `Nothing in this window is ${activeViewDefinition.label.toLocaleLowerCase()}. Widen the range, or pick Everything.`}
      kind="empty"
      title={activeView === "all"
        ? "No audit events match this view"
        : `No ${activeViewDefinition.label.toLocaleLowerCase()} in this window`}
    />
  ) : visibleRows.length === 0 ? (
    <DataState
      body="Later pages may still hold events these facets keep. Move through the pages, or clear them."
      kind="empty"
      title="No events on this page match the outcome, actor and client facets"
    />
  ) : null;

  return (
    <ListPage
      /*
       * 1h's own subline, with the em dash traded for a comma: "Don't write an em dash in UI copy"
       * is a named rule and the artifact is not authority on it.
       */
      description="Every publish, override, takeover, and pause, because “why did the agent say that” always has an answer. Nothing here can be edited or deleted."
      /*
       * Seeded events sit in the same log as real ones, so the page says so whenever any are on
       * screen. The table drops the per-row chip once every row is seeded, which is exactly when
       * this sentence is the only thing left carrying the disclosure.
       */
      /*
       * Every visible event seeded is a claim about the page, so it becomes the chip above the
       * title. A log with real events in it cannot say that -- the row keeps its own "test data"
       * mono tag and the sentence stays. The projection carries one boolean rather than a demo /
       * test distinction, and the row's own tag reads "test data", so the chip uses the same word.
       */
      provenance={allVisibleRowsAreTest || !visibleRows.some((row) => row.testData === true)
        ? undefined
        : "Demo and test events are labelled in the row and excluded from real analytics."}
      provenanceKind={allVisibleRowsAreTest ? "test" : undefined}
      /*
       * The kind switch changes what the rows are, not how they are filtered, so it takes the
       * template's own scope slot above the toolbar rather than sitting inside it.
       */
      scope={enabled && !unavailableReason ? scopeSwitch : undefined}
      title="Audit"
    >
      {enabled && !unavailableReason ? (
        <StatStrip
          ariaLabel="Audit summary"
          className="mb-[var(--d-stack-gap)]"
          items={summaryTiles}
        />
      ) : null}
      {!enabled ? (
        <DataState
          body="Audit events will appear here when operations logging is enabled."
          kind="empty"
          title="Audit is not enabled"
        />
      ) : unavailableReason ? (
        <DataState body={unavailableReason} kind="unavailable" title="Audit events could not be loaded" />
      ) : display === "feed" ? (
        /*
          1h's single panel: a card face carrying a toolbar, hairline-separated rows, and its own
          footer. `panel` gives up interior padding and clips, so the toolbar and the last row both
          meet the 14px corner rather than floating inside a box.
        */
        <Surface
          aria-label="Audit events"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          variant="panel"
        >
          <DataTableToolbarShell>
            {controls}
            {/* Display then Export, the order every other page uses. */}
            <div className="ml-auto flex items-center gap-[var(--s-2)]">
              <FeedLayoutMenu display={display} onDisplayChange={changeDisplay} />
              {exportControl}
            </div>
          </DataTableToolbarShell>
          <div className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
            {noRows ? <div className="px-[var(--cell-x)]">{noRows}</div> : (
              <AuditFeed
                nowIso={nowIso}
                onSelect={setSelectedId}
                rows={visibleRows}
                selectedId={selectedId}
              />
            )}
          </div>
          <div className="border-t border-[var(--line)] px-[var(--s-4)]">
            <PaginationSummary
              ordering={orderingLabel}
              onNext={() => navigate("next")}
              onPrevious={() => navigate("previous")}
              pagination={pagination}
              shownRows={rows.length}
              /*
               * The total beside this is the active view's own total now, so the note is only
               * about the three facets, which are the only narrowing the browser still does.
               */
              viewNote={visibleRows.length === rows.length
                ? null
                : `${workspaceCountFormat.format(visibleRows.length)} of them on this page`}
            />
          </div>
        </Surface>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <DataTable
          ariaLabel="Audit events"
          className="min-h-0 flex-1"
          columns={columns}
          data={visibleRows}
          emptyState={noRows ?? (
            <DataState
              body="Change or clear the filters to see recorded activity."
              kind="empty"
              title="No audit events match this view"
            />
          )}
          getRowId={(row) => row.id}
          /*
            The feed's day dividers, kept when the reader switches layouts: the two layouts carry
            the same facts, and a table that drops the boundary makes yesterday's events look like
            today's. The band is a partition rather than a claim, so it takes no dot -- but it does
            take an annotation, because the boundary is drawn on the workspace's clock and a reader
            in another timezone would otherwise assume it was drawn on theirs.
          */
          groupAnnotation={GROUP_ANNOTATION}
          groupBy={(row) => dayLabel(row.at, nowIso)}
          onRowOpen={(row) => setSelectedId(row.id)}
          pagination={{
            hasNextPage: pagination.hasNextPage,
            hasPreviousPage: pagination.hasPreviousPage,
            mode: "cursor",
            onNextPage: () => navigate("next"),
            onPreviousPage: () => navigate("previous"),
            onSortingChange: changeSorting,
            pageIndex: pagination.pageIndex,
            pageSize: pagination.pageSize,
            sorting,
            totalRows: pagination.totalRows,
          }}
          rowActions={(row) => [{
            id: "open",
            label: "Open event detail",
            onSelect: () => setSelectedId(row.id),
          }]}
          rowActionsLabel={(row) => `Actions for ${eventLabel(row.action)}`}
          displayOptions={<LayoutChoice display={display} onDisplayChange={changeDisplay} />}
          rowLabel={{ singular: "event", plural: "events" }}
          footerNote={FOOTER_NOTE}
          ordering={orderingLabel}
          testRow={(row) => row.testData === true}
          toolbar={controls}
          toolbarEnd={exportControl}
          variant="ledger"
        />
        </div>
      )}

      {selected ? (
        <RecordSheet
          onOpenChange={(open) => {
            if (!open) setSelectedId(null);
          }}
          open
          sections={eventSections({
            liveWorkspaceCount,
            onSelect: setSelectedId,
            related,
            row: selected,
            trail,
          })}
          /*
           * The event is the record, so its own timestamp and actor are the drawer's audit line
           * rather than three facts run together in the subtitle. The kit prints them in the
           * footer as "created <when> · <who>", which is what the reader came to establish.
           */
          created={{ when: timestamp(selected.at), who: actorLabel(selected) }}
          logged={auditMicrocopy(selected.action)}
          state={{
            kind: "verdict",
            label: outcomeOf(selected.action).label,
            tone: outcomeOf(selected.action).tone,
          }}
          subtitle={targetParts(selected.target).label}
          technical={technicalItems(selected)}
          title={eventLabel(selected.action)}
        />
      ) : null}
    </ListPage>
  );
}
