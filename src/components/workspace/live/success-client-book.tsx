"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { DeckPanel } from "@/components/kit/deck-panel";
import { DataState } from "@/components/kit/data-state";
import type { StatStripItem } from "@/components/kit/stat-strip";
import { everyRowIsTest } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import {
  ChevronDown,
  Search,
  ShieldCheck,
} from "@/components/kit/icons";
import {
  RegisterPaletteClients,
  type PaletteClientEntry,
} from "@/components/kit/palette-clients";
import { TableFooterNote } from "@/components/kit/table-footer-note";
import { TableGroupHeader } from "@/components/kit/table-group-header";
import { ListPage } from "@/components/kit/templates/list-page";
import {
  GridTable,
  GridTableCell,
  GridTableHead,
  GridTableIdentity,
  GridTableRow,
  KeyValueList,
  KitButton,
  KitInput,
  kitButtonClass,
  MonoMeta,
  Overline,
  Segmented,
  Status,
  Surface,
  UnassignedMark,
  type KeyValueRow,
  type Tone,
} from "@/components/kit/atomics";
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
import type { UserRole } from "@/lib/auth/claims";
import { demoScreenDisclosure } from "@/lib/demo-disclosure";
import { workspaceTimestampFormat } from "@/lib/format/datetime";
import type {
  TenantHealthDetail,
  TenantHealthSignalDetail,
} from "@/lib/operations/tenant-health-detail";
import { useQueryState } from "@/lib/query-state";
import type { SuccessClientBookRead, SupportBook } from "@/lib/repositories/support";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";
import { reassignmentReceiptView } from "./operations-view-models";

type SuccessClientBookProps = {
  actorId: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
  enabled: boolean;
};

type Receipt = {
  state?: unknown;
  tenantId?: unknown;
  successOwner?: unknown;
  audit?: { id?: unknown; actionKey?: unknown } | null;
};

type ClientCommand = "pause" | "resume" | "resend_signup" | "nudge_onboarding" | "archive" | "note";
type OperatorAction = ClientCommand | "impersonate";

type CommandResult = {
  tone: "good" | "failure";
  message: string;
  auditId?: number;
  commandId?: string;
};

export type AssigneeOption = { value: string; label: string };

const CRUMBS = [
  { label: "Clients" },
  { label: "Client book" },
] as const;

const TITLE = "Client book";

/**
 * The purpose line, and the one place on this surface where the drawn copy is not the copy.
 *
 * `AdminClients.dc.html:231` draws "Every coach on the platform, who owns them, and whether their
 * agent is actually working." The third clause is the one that changes: this page's columns are
 * `Client | Success owner | Updated | Support`, and the read behind them carries no agent-health
 * reading at all -- no publish state, no delivery signal, no last-reply stamp. A purpose line
 * naming a thing the page cannot show sends a reader hunting for a column that is not there,
 * which is the same failure as a percentage on a provisioning row: the sentence is the promise,
 * and the promise has to be one the screen keeps. So the clause is replaced by the state column
 * that *is* drawn and *is* rendered, and the drawn wording comes back the day the read carries
 * agent health (`docs/GAPS.md`, client-book columns).
 *
 * It is a constant because both `ListPage` branches print it -- the disabled one and the enabled
 * one -- and two literals that must agree are two literals that will not. Every other divergence
 * from the artboard on this surface carries its reason in a comment beside it; this one did not,
 * which is the only thing that made it a defect rather than a decision.
 */
const PURPOSE = "Every coach on the platform, the state they are in, and who on the team owns them.";

/**
 * The three saved views. `book` is what the server is asked for; `attention` is a narrowing of
 * the whole book rather than a fourth server query, because "needs attention" is a property of a
 * row, not of a filter the projection knows how to run.
 */
const BOOK_VIEWS = [
  { key: "all", label: "All clients", book: "all" },
  { key: "mine", label: "My clients", book: "mine" },
  { key: "attention", label: "Needs attention", book: "all" },
] as const;

type BookView = (typeof BOOK_VIEWS)[number]["key"];

function isBookView(value: string | null): value is BookView {
  return BOOK_VIEWS.some((view) => view.key === value);
}

/**
 * 1a and 1c are the same screen at two densities, so this is one surface with a switch rather
 * than two components. Comfortable is the reading density -- a monogram, a plan subline, the
 * lifecycle in its own column. Dense is the triage density: the plan folds into the name and the
 * lifecycle column goes, because at that size the reason a row is on screen is its support state.
 */
const DENSITIES = [
  { key: "comfortable", label: "Comfortable" },
  { key: "dense", label: "Dense" },
] as const;

type Density = (typeof DENSITIES)[number]["key"];

function isDensity(value: string | null): value is Density {
  return DENSITIES.some((entry) => entry.key === value);
}

/**
 * The column template lives here rather than on the header and again on every row, which is the
 * whole reason `GridTable` carries it as a custom property. The narrow pair keeps the same column
 * count and simply squeezes: dropping a column in CSS would leave the header cells and the row
 * cells counting differently, and a header that has slipped one column to the left is the most
 * obvious way for a console to look broken.
 *
 * The quiet-lines order is identity, then the facts that qualify it, then the one answer the row
 * carries, then the chevron. Support is that answer here: a reader scanning this book is asking
 * which clients need them, and the lifecycle and the last touch are only the evidence.
 *
 * One answer, so one status: the comfortable rows used to print the billing lifecycle as a bare
 * status *and* the support state as a pill, side by side, and a row with two statuses has none --
 * the reader has to work out which one the row is about. The lifecycle moved into the drawer,
 * where it sits with the rest of the evidence a reader opens the row for.
 */
const COLUMNS = {
  comfortable: {
    wide: "1.7fr 1fr 118px .95fr 24px",
    narrow: "1.5fr .9fr 96px .9fr 20px",
  },
  dense: { wide: "1.6fr 1fr 100px .95fr 24px", narrow: "1.5fr .9fr 88px .9fr 20px" },
} as const satisfies Record<Density, { wide: string; narrow: string }>;

/**
 * A row earns the attention view by being unowned, by having a live request on it, or by being in
 * a paying state that has gone wrong. Nothing here is a guess about the future -- each clause is a
 * value already in the projection.
 */
function needsAttention(row: SuccessClientBookRead) {
  if (!row.successOwner) return true;
  if (row.supportStatus === "open" || row.supportStatus === "waiting_on_coach") return true;
  return ["overdue", "suspended"].includes(row.status.toLocaleLowerCase());
}

const REASSIGN_MICROCOPY = AUDIT_ACTIONS["tenant.success_owner.reassigned"].microcopy;

/**
 * Support state reaches the screen as a sentence, never as the stored enum. Every value in
 * `SUPPORT_STATUSES` has a line here, and the tone is the tone contract's own claim about who the
 * clock belongs to: amber while it is ours, periwinkle while it is the coach's, sage once it is
 * nobody's.
 */
const SUPPORT_STATE = {
  open: { label: "Open request", tone: "warning" },
  waiting_on_coach: { label: "Waiting on coach", tone: "waiting" },
  resolved: { label: "Resolved", tone: "good" },
} as const satisfies Record<string, { label: string; tone: Tone }>;

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(date);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long ago the row last moved, read as elapsed time. The book cannot promise when a client
 * will be touched next, so the column says what has already happened and nothing about what is
 * due. The drawer still carries the exact stamp for anyone who needs it.
 */
function ageLabel(value: string, now: number) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Time not recorded";
  const elapsed = Math.max(0, now - date.getTime());
  const days = Math.floor(elapsed / DAY_MS);
  if (days >= 1) return `${days}d ago`;
  const hours = Math.floor(elapsed / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h ago`;
  return `${Math.floor(elapsed / (60 * 1000))}m ago`;
}

function humanize(value: string) {
  const words = value.replaceAll("_", " ").trim().toLocaleLowerCase();
  return words ? `${words[0].toLocaleUpperCase()}${words.slice(1)}` : "Not recorded";
}

function clientStatus(value: string): { label: string; tone: Tone } {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "active") return { label: "Active", tone: "good" };
  if (["overdue", "suspended", "churned"].includes(normalized)) {
    return { label: humanize(value), tone: "failure" };
  }
  if (["onboarding", "paused"].includes(normalized)) {
    return { label: humanize(value), tone: "warning" };
  }
  return { label: humanize(value), tone: "neutral" };
}

/**
 * An absence is not a status, so a client with no thread gets no pill. `null` here is what tells
 * every caller to render a quiet cell instead, naming what did not happen in words: a washed pill
 * on every quiet client would give an absence the same weight as the three rows a success owner
 * actually has to act on.
 */
function supportState(row: SuccessClientBookRead): { label: string; tone: Tone } | null {
  return row.supportStatus ? SUPPORT_STATE[row.supportStatus] : null;
}

function successOwnerLabel(row: SuccessClientBookRead) {
  return row.successOwner?.name?.trim()
    || (row.successOwner ? "Assigned owner" : "Unassigned");
}

function planLabel(row: SuccessClientBookRead) {
  return row.planLabel?.trim() || "No plan";
}

/**
 * The order the book opens in, and it is the page's whole argument: whatever is waiting on a
 * person sits above whatever is not, and inside each group the most recently touched leads.
 * Sorting by recency alone would bury an unowned client under six healthy ones the moment
 * somebody replied to them.
 */
function bookRank(row: SuccessClientBookRead) {
  if (row.supportStatus === "open") return 0;
  if (!row.successOwner) return 1;
  if (row.supportStatus === "waiting_on_coach") return 2;
  return 3;
}

function bookOrder(left: SuccessClientBookRead, right: SuccessClientBookRead) {
  const gap = bookRank(left) - bookRank(right);
  return gap !== 0 ? gap : right.updatedAt.localeCompare(left.updatedAt);
}

/**
 * The bands are the ranking the order already runs, drawn. Every row under a band is there for the
 * same reason, so the band says the reason once instead of every row tinting itself amber and the
 * reader having to work out which of four different things the tint meant.
 */
const BANDS = [
  {
    label: "Waiting on the team",
    annotation: "a coach asked and nobody has answered yet",
    tone: "warning",
  },
  {
    label: "Nobody owns these",
    annotation: "assign a success owner before anything else moves",
    tone: "failure",
  },
  {
    label: "Parked on the coach",
    annotation: "the team replied, so the clock is the coach's",
    tone: "waiting",
  },
  {
    label: "Running quietly",
    annotation: "an owner on file and no open request",
    tone: "neutral",
  },
] as const satisfies readonly { label: string; annotation: string; tone: Tone }[];

async function payload(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_RESPONSE");
  return value as Record<string, unknown>;
}

export function assigneeOptionsFor(input: {
  rows: readonly SuccessClientBookRead[];
  actorId: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
}): AssigneeOption[] {
  if (input.actorRole === "success") return [{ value: input.actorId, label: "You" }];

  const named = new Map<string, string>();
  for (const row of input.rows) {
    if (row.successOwner?.name?.trim()) named.set(row.successOwner.id, row.successOwner.name.trim());
  }
  return [...named].map(([value, label]) => ({ value, label }));
}

const HEALTH_STATE = {
  healthy: { label: "Healthy", tone: "good" },
  unhealthy: { label: "Unhealthy", tone: "failure" },
  indeterminate: { label: "Not determined", tone: "waiting" },
} as const satisfies Record<string, { label: string; tone: Tone }>;

/**
 * One signal as a key-value line.
 *
 * Freshness is part of the value rather than a separate row, because "healthy" measured eleven
 * days ago and "healthy" measured this morning are different claims and only one of them is worth
 * acting on. A signal nobody has measured says so instead of borrowing the indeterminate word,
 * which would read as a finding.
 */
export function healthSignalRow(signal: TenantHealthSignalDetail): KeyValueRow {
  if (signal.freshness === "not-measured") {
    return { label: signal.label, value: "Not measured", tone: "neutral" };
  }
  const state = HEALTH_STATE[signal.state];
  return {
    label: signal.label,
    value: signal.freshness === "stale" ? `${state.label}, stale` : state.label,
    tone: signal.freshness === "stale" ? "waiting" : state.tone,
  };
}

type HealthRead =
  | { kind: "loading" }
  | { kind: "ready"; health: TenantHealthDetail }
  | { kind: "failed" };

const CLIENT_COMMANDS = {
  pause: {
    label: "Pause client",
    expectedAction: "client_pause",
    expectedState: "applied",
    expectedStatus: "paused",
    confirmation: "This changes the client lifecycle from active to paused after the command and audit read-backs agree.",
  },
  resume: {
    label: "Resume client",
    expectedAction: "client_resume",
    expectedState: "applied",
    expectedStatus: "active",
    confirmation: "This changes the client lifecycle from paused to active after the command and audit read-backs agree.",
  },
  resend_signup: {
    label: "Record signup resend",
    expectedAction: "client_resend_signup",
    expectedState: "intent_recorded",
    expectedStatus: null,
    confirmation: "This records a signup-resend intent and audit entry. It does not send a message because provider dispatch is not wired.",
  },
  nudge_onboarding: {
    label: "Record onboarding nudge",
    expectedAction: "client_nudge_onboarding",
    expectedState: "intent_recorded",
    expectedStatus: null,
    confirmation: "This records an onboarding-nudge intent and audit entry. It does not message the coach because provider dispatch is not wired.",
  },
  archive: {
    label: "Archive client",
    expectedAction: "client_archive",
    expectedState: "applied",
    expectedStatus: "churned",
    confirmation: "This changes the client lifecycle to churned after the command and audit read-backs agree. The command receipt remains available for an audited undo.",
  },
  note: {
    label: "Add internal note",
    expectedAction: "client_note",
    expectedState: "recorded",
    expectedStatus: null,
    confirmation: "This appends an internal platform note and records its audit receipt. The coach does not see this note.",
  },
} as const satisfies Record<ClientCommand, {
  label: string;
  expectedAction: string;
  expectedState: "applied" | "intent_recorded" | "recorded";
  expectedStatus: "active" | "paused" | "churned" | null;
  confirmation: string;
}>;

export function clientCommandsFor(row: SuccessClientBookRead): ClientCommand[] {
  const status = row.status.toLocaleLowerCase();
  const commands: ClientCommand[] = [];
  if (status === "active") commands.push("pause");
  if (status === "paused") commands.push("resume");
  if (status === "onboarding") commands.push("nudge_onboarding", "resend_signup");
  if (status !== "churned") commands.push("archive");
  commands.push("note");
  return commands;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function commandResult(
  value: Record<string, unknown>,
  action: ClientCommand,
): { auditId: number; commandId: string; expectedStatus: string | null; message: string } | null {
  const definition = CLIENT_COMMANDS[action];
  const command = record(value.command);
  const effect = record(value.effect);
  const audit = record(value.audit);
  const undo = record(value.undo);
  const auditId = audit?.id;
  if (
    !command || !effect || !audit || !undo || typeof command.id !== "string" || !command.id.trim()
    || command.action !== definition.expectedAction || command.state !== definition.expectedState
    || effect.status !== definition.expectedState
    || typeof auditId !== "number" || !Number.isSafeInteger(auditId) || auditId <= 0
  ) return null;

  if (definition.expectedState === "intent_recorded") {
    if (effect.providerDispatch !== "not_wired" || undo.available !== false || undo.commandId !== null) {
      return null;
    }
    const intent = action === "nudge_onboarding" ? "Onboarding nudge" : "Signup resend";
    return {
      auditId,
      commandId: command.id,
      expectedStatus: null,
      message: `${intent} intent recorded and logged. No message was sent; provider dispatch is not wired.`,
    };
  }
  if (definition.expectedState === "recorded") {
    if (undo.available !== false || undo.commandId !== null) return null;
    return {
      auditId,
      commandId: command.id,
      expectedStatus: null,
      message: "Internal note recorded and logged.",
    };
  }
  if (
    effect.tenantStatus !== definition.expectedStatus
    || undo.available !== true || undo.commandId !== command.id
  ) return null;
  return {
    auditId,
    commandId: command.id,
    expectedStatus: definition.expectedStatus,
    message: action === "pause" ? "Client paused and logged."
      : action === "resume" ? "Client resumed and logged."
        : "Client archived and logged.",
  };
}

function OperatorActions({
  actorId,
  row,
  reload,
}: {
  actorId: string;
  row: SuccessClientBookRead;
  reload: () => Promise<SuccessClientBookRead[] | null>;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<OperatorAction | null>(null);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<CommandResult | null>(null);
  const commands = clientCommandsFor(row);

  function choose(action: OperatorAction) {
    setPending(action);
    setReason("");
    setResult(null);
  }

  async function confirm() {
    const normalized = reason.trim();
    if (!pending || !normalized) return;
    setSending(true);
    setResult(null);
    try {
      if (pending === "impersonate") {
        const response = await fetch("/api/platform/impersonation/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenantId: row.client.id, reason: normalized }),
        });
        const value = await payload(response);
        const session = record(value.session);
        const started = Date.parse(String(session?.startedAt ?? ""));
        const expires = Date.parse(String(session?.expiresAt ?? ""));
        if (
          !response.ok || !session || typeof session.id !== "string" || !session.id.trim()
          || session.actorId !== actorId || session.tenantId !== row.client.id
          || session.reason !== normalized || session.endedAt !== null
          || !Number.isFinite(started) || expires - started !== 30 * 60_000
        ) throw new Error("IMPERSONATION_READBACK_INVALID");
        router.push("/coach/home");
        router.refresh();
        return;
      }

      const response = await fetch(`/api/platform/clients/${row.client.id}/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending === "note"
          ? { action: pending, note: normalized }
          : { action: pending, reason: normalized }),
      });
      const value = await payload(response);
      const confirmed = response.ok ? commandResult(value, pending) : null;
      if (!confirmed) throw new Error("CLIENT_COMMAND_READBACK_INVALID");
      if (confirmed.expectedStatus) {
        const refreshed = await reload();
        const readBack = refreshed?.find((candidate) => candidate.client.id === row.client.id);
        if (readBack?.status.toLocaleLowerCase() !== confirmed.expectedStatus) {
          setResult({
            tone: "failure",
            message: "The command returned a receipt, but the client book did not confirm the new lifecycle. Refresh before retrying.",
            auditId: confirmed.auditId,
            commandId: confirmed.commandId,
          });
          return;
        }
      }
      setPending(null);
      setReason("");
      setResult({ tone: "good", ...confirmed });
    } catch {
      setResult({
        tone: "failure",
        message: "The command could not be confirmed. Refresh before retrying.",
      });
    } finally {
      setSending(false);
    }
  }

  const pendingDefinition = pending && pending !== "impersonate" ? CLIENT_COMMANDS[pending] : null;
  const fieldId = `client-operator-${row.client.id}`;

  return (
    /*
      * No rule and no top padding of its own: this renders in the deck panel's `footer` slot,
      * which already sits on `margin-top: auto` under a hairline from `console.css`. Keeping the
      * old ones here drew the divider twice, 14px apart, which reads as an empty band.
      */
    <div>
      <Overline className="mb-[var(--s-2)] block">Operator actions</Overline>
      {pending ? (
        <Surface tone="warning" variant="well">
          <Overline className="mb-[var(--s-2)] block">
            Confirm · {pending === "impersonate" ? "View as coach" : pendingDefinition?.label}
          </Overline>
          <p className="m-0 text-[12px] leading-[1.5] text-[color:var(--body)]">
            {pending === "impersonate"
              ? `This starts a 30-minute read-only view-as session for this client. Tenant mutations stay blocked while the session is active. Reading ${row.client.name}'s workspace crosses a tenant boundary, so the entry names you, the client and the session, and ${row.client.name} can see the visit on their own audit trail.`
              : pendingDefinition?.confirmation}
          </p>
          {/*
            * The "Logged" line sits on the confirmation rather than only on the receipt, because
            * the point of stating it is that the operator reads it *before* deciding. A shield and
            * the word after the fact is a notification; here it is a disclosure.
            */}
          <p className="m-0 mt-[var(--s-2)] flex items-center gap-[7px] text-[11.5px] leading-[1.45] text-[color:var(--muted)]" data-slot="audit-microcopy">
            <ShieldCheck aria-hidden className="size-[13px] shrink-0 text-[color:var(--faint)]" />
            Logged. The visit is recorded against your name and is visible to the client.
          </p>
          <div className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]">
            <Label htmlFor={fieldId}>{pending === "note" ? "Internal note" : "Reason"}</Label>
            <Textarea
              id={fieldId}
              maxLength={pending === "note" ? 2_000 : 500}
              onChange={(event) => setReason(event.currentTarget.value)}
              placeholder={pending === "note"
                ? "Write the internal note that should be retained."
                : "Explain why this action is needed. This is retained with the record."}
              value={reason}
            />
          </div>
          <div className="mt-[var(--s-3)] flex flex-wrap items-center gap-[var(--s-2)]">
            <KitButton disabled={sending || !reason.trim()} onClick={() => void confirm()} size="sm" variant="primary">
              {sending ? "Confirming…" : pending === "impersonate" ? "Start read-only view" : pendingDefinition?.label}
            </KitButton>
            <KitButton disabled={sending} onClick={() => setPending(null)} size="sm" variant="ghost">
              Cancel
            </KitButton>
            <MonoMeta className="ml-auto">Audit receipt required</MonoMeta>
          </div>
        </Surface>
      ) : (
        <div className="flex flex-wrap gap-[var(--s-2)]">
          {commands.map((command) => (
            <KitButton
              key={command}
              onClick={() => choose(command)}
              size="sm"
              variant={command === "archive" ? "destructive" : "secondary"}
            >
              {CLIENT_COMMANDS[command].label}…
            </KitButton>
          ))}
          <KitButton onClick={() => choose("impersonate")} size="sm" variant="secondary">
            View as coach…
          </KitButton>
        </div>
      )}
      {result ? (
        <div className="mt-[var(--s-2)]" role={result.tone === "failure" ? "alert" : "status"}>
          <Status label={result.message} tone={result.tone} />
          {result.auditId && result.commandId ? (
            <MonoMeta className="mt-[var(--s-1)] block">
              Audit receipt #{result.auditId} · Command {result.commandId}
            </MonoMeta>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function SuccessClientBook({ actorId, actorRole, enabled }: SuccessClientBookProps) {
  const query = useQueryState();
  const requestedView = query.get("view");
  const view: BookView = isBookView(requestedView)
    ? requestedView
    : actorRole === "success" ? "mine" : "all";
  const requestedDensity = query.get("density");
  const density: Density = isDensity(requestedDensity) ? requestedDensity : "comfortable";
  const book: SupportBook = BOOK_VIEWS.find((entry) => entry.key === view)?.book ?? "all";
  const setQueryValue = query.set;
  const [rows, setRows] = useState<SuccessClientBookRead[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [assigneeChoice, setAssigneeChoice] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [supportFilter, setSupportFilter] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, HealthRead>>({});
  // Age is measured from the read that produced the rows, so a row never ages while nothing moves.
  const [now, setNow] = useState<number | null>(null);

  const loadRows = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setAssigneeChoice(null);
    try {
      const response = await fetch(`/api/platform/clients?book=${book}`, {
        cache: "no-store",
        signal,
      });
      const value = await payload(response);
      if (!response.ok || !Array.isArray(value.clients)) throw new Error("CLIENT_BOOK_READ_FAILED");
      if (signal?.aborted) return null;
      const next = value.clients as SuccessClientBookRead[];
      setRows(next);
      setNow(Date.now());
      setOpenId((current) => current && next.some((row) => row.client.id === current)
        ? current
        : null);
      return next;
    } catch {
      if (!signal?.aborted) setError("The client book could not be read.");
      return null;
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [book]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void Promise.resolve().then(() => loadRows(controller.signal));
    return () => controller.abort();
  }, [enabled, loadRows]);

  /**
   * Health is read per client, on open, from the route that already exists for exactly this
   * question. It is not folded into the book projection: four signals for every client on every
   * page load would be a read nobody asked for, and the drawer is the only place the answer is
   * looked at.
   */
  const loadHealth = useCallback(async (tenantId: string) => {
    setHealth((current) => ({ ...current, [tenantId]: { kind: "loading" } }));
    try {
      const response = await fetch(`/api/platform/clients/${tenantId}/health`, { cache: "no-store" });
      const value = await payload(response);
      const detail = value.health as TenantHealthDetail | undefined;
      if (!response.ok || !detail || detail.tenantId !== tenantId) throw new Error("HEALTH_READ_FAILED");
      setHealth((current) => ({ ...current, [tenantId]: { kind: "ready", health: detail } }));
    } catch {
      setHealth((current) => ({ ...current, [tenantId]: { kind: "failed" } }));
    }
  }, []);

  const open = rows.find((row) => row.client.id === openId) ?? null;

  /**
   * The rows this page already loaded, offered to the command palette.
   *
   * This is the only page in the console that holds a client list, so it is the only page that can
   * feed the palette's Clients group without a second read. Status and owner ride along as
   * keywords, so typing "onboarding" or a success owner's name finds the clients behind them.
   */
  const paletteClients = useMemo<PaletteClientEntry[]>(
    () => rows.map((row) => ({
      id: row.client.id,
      label: row.client.name,
      href: "/admin/platform-clients",
      kind: "Client",
      keywords: [row.status, row.planLabel ?? "", row.successOwner?.name ?? ""].filter(Boolean),
    })),
    [rows],
  );
  const candidates = useMemo(
    () => assigneeOptionsFor({ rows, actorId, actorRole }),
    [actorId, actorRole, rows],
  );
  const assigneeId = assigneeChoice
    ?? (actorRole === "success" ? actorId : open?.successOwner?.name ? open.successOwner.id : "");

  const attentionCount = useMemo(() => rows.filter(needsAttention).length, [rows]);

  // Every filter narrows whatever book the server returned; none of them is a fourth query.
  const visibleRows = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return rows
      .filter((row) => (view === "attention" ? needsAttention(row) : true))
      .filter((row) => (supportFilter
        ? (supportState(row)?.label ?? "No request") === supportFilter
        : true))
      .filter((row) => (needle
        ? [row.client.name, planLabel(row), successOwnerLabel(row)]
          .some((field) => field.toLocaleLowerCase().includes(needle))
        : true))
      .sort(bookOrder);
  }, [rows, search, supportFilter, view]);

  const supportFilters = useMemo(() => {
    const labels = new Set(rows.map((row) => supportState(row)?.label ?? "No request"));
    return [...labels].sort();
  }, [rows]);

  // Four figures, each one a reason to open a different row: who is still landing, how much of
  // the book is healthy, how much is waiting on a person, and how much nobody owns. The size of
  // the book is not one of them -- the table footer already counts the rows.
  const read = !loading || rows.length > 0;
  const count = (predicate: (row: SuccessClientBookRead) => boolean) => rows.filter(predicate).length;
  const onboarding = count((row) => row.status.toLocaleLowerCase() === "onboarding");
  const live = count((row) => row.status.toLocaleLowerCase() === "active");
  const openRequests = count(
    (row) => row.supportStatus === "open" || row.supportStatus === "waiting_on_coach",
  );
  const unassigned = count((row) => !row.successOwner);
  const bookSize = rows.length;

  /**
   * A count nobody has read yet is not zero, so an unread figure says it is unavailable and why
   * rather than showing four confident zeros over an empty table.
   *
   * That rule used to be spelled out here against `MetricCard`'s props. It is now spelled as a
   * `MetricAvailability`, which is the same rule expressed in the type the rest of the console
   * uses -- the union has an `unavailable` arm carrying its own note, so "the client book has not
   * answered yet" is a state the renderer knows about rather than an em-rule a caller remembered
   * to pass. The panels are `ConsoleStatDeck`, which is the canvas's card shape at console scale.
   *
   * The per-tile tone is gone with the tiles. The console spends one drenched panel per screen and
   * nothing else fills, so a strip that used to tint two figures amber and red now leads on one --
   * open requests, the figure this page exists to work down -- and the other three read as ink.
   * Four coloured figures rank nothing against each other.
   */
  const figure = (input: {
    label: string;
    value: number;
    note: string;
  }): StatStripItem => ({
    label: input.label,
    availability: read
      ? { kind: "value", value: input.value, format: "count" }
      : { kind: "unavailable", note: "The client book has not answered yet." },
    ...(read ? { note: input.note } : {}),
  });

  const bookFigures: StatStripItem[] = [
    figure({ label: "Onboarding", note: `Of ${bookSize} in the book, still landing.`, value: onboarding }),
    figure({ label: "Live", note: `Of ${bookSize} in the book, answering leads.`, value: live }),
    figure({ label: "Open requests", note: "Waiting on somebody on the team.", value: openRequests }),
    figure({ label: "Unassigned", note: "Nobody on the team owns these clients.", value: unassigned }),
  ];

  const truth = open ? reassignmentReceiptView({
    expectedTenant: open.client.id,
    expectedAssignee: assigneeId,
    receipt,
  }) : null;

  function toggleRow(id: string) {
    setAssigneeChoice(null);
    setReceipt(null);
    const closing = openId === id;
    setOpenId(closing ? null : id);
    // Read health on open, and only once per client per page life: the effect belongs beside the
    // click and not inside the state updater, which React is free to run twice.
    if (!closing && (!health[id] || health[id].kind === "failed")) void loadHealth(id);
  }

  async function confirmAssignment(input: { reason?: string }): Promise<Result> {
    if (!open || !assigneeId || !input.reason) {
      return { ok: false, message: "Choose a named owner and add a reason." };
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/platform/clients/${open.client.id}/success-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId, reason: input.reason }),
      });
      const value = await payload(response) as Receipt;
      const confirmed = reassignmentReceiptView({
        expectedTenant: open.client.id,
        expectedAssignee: assigneeId,
        receipt: value,
      });
      if (!response.ok || confirmed.kind !== "reassigned") {
        return { ok: false, message: "The owner change was not confirmed by the client and audit read-back." };
      }
      setReceipt(value);
      await loadRows();
      return {
        ok: true,
        receipt: { auditId: confirmed.auditId, actionKey: "tenant.success_owner.reassigned" },
      };
    } catch {
      return { ok: false, message: "The owner change could not be confirmed." };
    } finally {
      setBusy(false);
    }
  }

  // A success owner opens on their own book, so their own view leads the switch.
  const segments = (actorRole === "success"
    ? [BOOK_VIEWS[1], BOOK_VIEWS[0], BOOK_VIEWS[2]]
    : [...BOOK_VIEWS]
  ).map((entry) => (entry.key === "attention"
    ? {
      key: entry.key,
      label: entry.label,
      count: read ? attentionCount : undefined,
      tone: read && attentionCount > 0 ? ("warning" as Tone) : undefined,
    }
    : { key: entry.key, label: entry.label }));

  // Every row seeded means the table drops its per-row chip -- it would repeat on all eight lines
  // and say nothing about how they differ -- so the page has to carry the disclosure itself.
  const allRowsAreDemo = everyRowIsTest(visibleRows, (row) => row.client.isDemo);
  // Every row seeded is a claim about the page, so it goes in the chip over the title. A mixed
  // view is a claim about some rows, which the chip must not make, so that case keeps its sentence.
  const allDemo = visibleRows.length > 0 && allRowsAreDemo;
  const provenance = !allDemo && visibleRows.some((row) => row.client.isDemo)
    ? demoScreenDisclosure
    : undefined;

  // The trailing header names the chevron for a screen reader and shows nothing, because the
  // affordance is the whole row and a visible "Open" label would read as a sixth fact.
  const chevronColumn = { label: <span className="sr-only">Open</span> };
  const headerColumns = density === "dense"
    ? [
      { label: "Client" },
      { label: "Owner" },
      { label: "Updated" },
      { label: "Support" },
      chevronColumn,
    ]
    : [
      { label: "Client" },
      { label: "Success owner" },
      { label: "Updated" },
      { label: "Support" },
      chevronColumn,
    ];

  function healthRows(row: SuccessClientBookRead): KeyValueRow[] {
    const read = health[row.client.id];
    const book: KeyValueRow[] = [
      { label: "Plan", value: planLabel(row) },
      // The billing lifecycle used to be a second status on the row itself. It is evidence, not
      // the row's answer, so it reads here beside the rest of the evidence.
      { label: "Status", value: clientStatus(row.status).label },
      { label: "Data", value: row.client.isDemo ? "Demo" : "Real" },
      { label: "Updated", value: timestamp(row.updatedAt) },
    ];
    if (read?.kind !== "ready") return book;
    return [
      ...read.health.signals.map(healthSignalRow),
      ...(read.health.calculatedAt
        ? [{ label: "Measured", value: timestamp(read.health.calculatedAt) }]
        : []),
      ...book,
    ];
  }

  function drawer(row: SuccessClientBookRead) {
    const state = supportState(row);
    const detail = health[row.client.id];
    return (
      <div
        /* `@container/drawer`, which the grid inside queries by name. It was querying an unnamed
           container instead, and nothing in this drawer's ancestry declared one, so the two panels
           stayed stacked at every width. Named rather than bare so it keeps measuring the drawer
           after somebody drops a `Surface` between here and the pane. */
        className="@container/drawer border-b border-[var(--line-soft)] pt-[2px] pb-[15px]"
        data-slot="client-drawer"
        role="row"
        style={{ background: "linear-gradient(180deg, var(--accent-wash), transparent)" }}
      >
        {/*
          * The drill-down `AdminClientDetail.dc.html` draws as a page, drawn here as the expanding
          * row it actually is.
          *
          * The canvas puts a whole route behind this -- a drenched subscription hero, a channel
          * list, the agent's configuration as statements, a six-event activity timeline. Four of
          * those five panels are figures this surface does not have: there is no per-client MRR,
          * model spend or margin on the client-book read, no channel rollup, and no platform event
          * feed joined to a tenant. Drawing the drawing would have meant inventing four numbers on
          * the one screen in the product where cost and margin are allowed to be real, which is
          * the worst possible place to guess. So the drill-down keeps the canvas's *shape* -- deck
          * panels with a header band, an eyebrow over the name, a hairline, one sentence, and the
          * audit line pushed to the footer -- over the two panels the read genuinely fills.
          *
          * `min-w-0` on the grid children is load-bearing: a deck panel is a flex column, and a
          * flex child defaults to `min-width: auto`, so a long client name would push the drawer
          * wider than the row above it.
          */}
        <div
          className="grid gap-[14px] [&>*]:min-w-0 @min-[720px]/drawer:grid-cols-[1.15fr_1fr]"
          role="cell"
        >
          <DeckPanel
            dataSlot="client-drawer-request"
            eyebrow="What this client is waiting on"
            footer={<OperatorActions actorId={actorId} reload={() => loadRows()} row={row} />}
            name="Latest request"
          >
            {state
              ? <Status label={state.label} tone={state.tone} />
              : <CellQuiet>No open request</CellQuiet>}
            <p className="m-0 max-w-[var(--measure-prose)] text-[12.5px] leading-[1.55] text-[color:var(--body)]">
              {state
                ? "This book carries the state of the request, not the words in it. The thread itself is read in Support."
                : "Nothing is open for this client. A new request arrives in Support and shows here as soon as it does."}
            </p>
            {candidates.length > 0 ? (
              <div className="flex flex-col gap-[var(--s-1)]">
                <Overline as="label">Assignee</Overline>
                <Select
                  onValueChange={(value) => {
                    if (!value) return;
                    setAssigneeChoice(value);
                    setReceipt(null);
                  }}
                  value={assigneeId || null}
                >
                  <SelectTrigger aria-label="Assignee" className="w-full">
                    <SelectValue placeholder="Choose a named success owner" />
                  </SelectTrigger>
                  <SelectContent align="start">
                    {candidates.map((candidate) => (
                      <SelectItem key={candidate.value} value={candidate.value}>{candidate.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <p className="m-0 text-[12.5px] text-[color:var(--faint)]">
                The client book did not supply a named success owner, so there is nobody to assign to yet.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-[var(--s-2)]">
              <KitButton
                disabled={busy || !assigneeId}
                onClick={() => setConfirmOpen(true)}
                size="sm"
                variant="primary"
              >
                {actorRole === "success" ? "Take ownership" : "Reassign owner"}
              </KitButton>
              <Link
                className="link-inline text-[12.5px]"
                href="/admin/support"
              >
                Open in Support
              </Link>
              <MonoMeta className="text-[11px]">{REASSIGN_MICROCOPY}</MonoMeta>
            </div>
            {truth?.kind === "reassigned" ? (
              <p className="m-0 text-[12.5px] text-[color:var(--good-text)]" role="status">
                Owner changed. {REASSIGN_MICROCOPY}.
              </p>
            ) : null}
          </DeckPanel>

          <DeckPanel
            dataSlot="client-drawer-health"
            eyebrow="Measured signals, each with its own freshness"
            name="Health"
          >
            {detail?.kind === "loading" ? (
              <p className="m-0 text-[12px] text-[color:var(--muted)]">Reading the health signals.</p>
            ) : null}
            {detail?.kind === "failed" ? (
              <div className="flex flex-wrap items-center gap-[var(--s-2)]">
                <span className="text-[12px] text-[color:var(--failure-body)]">Couldn&apos;t load the health signals.</span>
                <KitButton onClick={() => void loadHealth(row.client.id)} size="sm">Retry</KitButton>
              </div>
            ) : null}
            <KeyValueList rows={healthRows(row)} />
          </DeckPanel>
        </div>
      </div>
    );
  }

  return (
    <AppShell
      activePath="/admin/platform-clients"
      crumbs={CRUMBS}
      /*
       * The rail carries the same set the Needs attention view opens on, so the number beside
       * Client book and the number on its own segment can never disagree. It is the whole book's
       * attention count, not the current view's -- a reader who has filtered down to their own
       * clients still needs to see that nine others are unowned.
       */
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/platform-clients": read ? attentionCount : 0,
      })}
      role="admin"
    >
      {!enabled ? (
        <ListPage
          description={PURPOSE}
          title={TITLE}
        >
          <DataState
            body="Client-book reads are not enabled in this environment."
            kind="unavailable"
            title="Client book is not enabled"
          />
        </ListPage>
      ) : (
        <ListPage
          actions={(
            <>
              {/*
                The only route to /admin/support-team. The rail's nineteen destinations are pinned
                by `workspace-navigation.test.ts`, and the page it leads to is a rollup of this
                one's own read -- who owns which of these clients -- so the book is where a reader
                already is when the question occurs to them.
              */}
              <Link className={kitButtonClass({ size: "sm", variant: "ghost" })} href="/admin/support-team">
                Success team
              </Link>
              <Segmented
                label="Row density"
                onValueChange={(value) => setQueryValue("density", value)}
                options={DENSITIES}
                value={density}
              />
              <ExportMenu
                filename="setterfi-success-client-book"
                mode="server"
                query={{ book, reason: "" }}
                resource="success-client-book"
              />
            </>
          )}
          description={PURPOSE}
          provenance={provenance}
          provenanceKind={allDemo ? "demo" : undefined}
          scope={(
            /* Which book you are reading is a different question from how you are filtering it,
               so the saved views sit above the toolbar rather than inside it. */
            <Segmented
              label="Client book"
              onValueChange={(value) => setQueryValue("view", value)}
              options={segments}
              value={view}
            />
          )}
          stats={(
            /* The wrapper exists only to carry the slot hook the figures test reads. The grid is
               `ConsoleDeck`'s own `<section>` inside it, so the wrapper adds no layout. */
            <div data-slot="client-book-figures">
              <ConsoleStatDeck
                ariaLabel="Client book figures"
                heroLabel="Open requests"
                items={bookFigures}
              />
            </div>
          )}
          title={TITLE}
        >
          {error && rows.length === 0 ? (
            <DataState
              body={error}
              kind="unavailable"
              retry={() => void loadRows()}
              title="Client book unavailable"
            />
          ) : (
            <>
              <RegisterPaletteClients clients={paletteClients} sourceKey="client-book" />
              <div className="flex min-h-0 flex-col" data-slot="client-book-lines">
                <div className="flex flex-wrap items-center gap-[var(--s-2)] border-b border-[var(--line)] pb-[var(--s-3)]">
                  <KitInput
                    aria-label="Search the client book"
                    leading={<Search className="size-[13px]" />}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search clients"
                    shellClassName="w-[260px] max-w-full"
                    value={search}
                  />
                  <div className="ml-auto flex flex-wrap items-center gap-[var(--s-2)]">
                    {supportFilters.map((label) => (
                      <KitButton
                        aria-pressed={supportFilter === label}
                        key={label}
                        onClick={() => setSupportFilter((current) => (current === label ? null : label))}
                        size="sm"
                        variant={supportFilter === label ? "soft" : "secondary"}
                      >
                        {label}
                      </KitButton>
                    ))}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  <GridTable
                    className="@max-[820px]/grid-table:[--grid-table-columns:var(--grid-table-columns-narrow)]"
                    columns={COLUMNS[density].wide}
                    columnsNarrow={COLUMNS[density].narrow}
                    label="Client book"
                  >
                    {/* No fill. The quiet treatment sits on the bare canvas rather than on a card
                        face, and the 2% wash that reads as a header strip inside a card reads as a
                        stripe painted across the page out here. */}
                    <GridTableHead className="bg-transparent px-0" columns={headerColumns} />
                    {visibleRows.length === 0 ? (
                      <div className="py-[var(--s-6)]">
                        <DataState
                          body={view === "attention"
                            ? "Every client in this book has an owner and no open request."
                            : "Change the view, the support filter, or the search to see another part of the book."}
                          kind="empty"
                          title={view === "attention" ? "Nothing is waiting on the team" : "No clients match this view"}
                        />
                      </div>
                    ) : null}
                    {visibleRows.map((row, index) => {
                      const state = supportState(row);
                      const expanded = openId === row.client.id;
                      const last = index === visibleRows.length - 1;
                      const rank = bookRank(row);
                      const band = index === 0 || bookRank(visibleRows[index - 1]) !== rank
                        ? BANDS[rank]
                        : null;
                      return (
                        <div key={row.client.id}>
                          {band ? (
                            <div className="pt-[var(--s-4)] pb-[var(--s-2)]" role="row">
                              <div role="cell">
                                <TableGroupHeader
                                  annotation={band.annotation}
                                  count={visibleRows.filter((entry) => bookRank(entry) === rank).length}
                                  label={band.label}
                                  tone={band.tone}
                                />
                              </div>
                            </div>
                          ) : null}
                          <GridTableRow
                            aria-expanded={expanded}
                            /* --line, not the atomic's --line-soft: --line-soft is for dividers
                               inside a card, and this list has no card. At 0.07 alpha on the bare
                               canvas the rules between rows were not there. The atomic keeps its
                               default because every other caller does sit on a card. */
                            className={`border-[var(--line)] ${density === "dense"
                              ? "cursor-pointer px-0 py-[8px]"
                              : "min-h-[var(--d-row-quiet)] cursor-pointer px-0"}`}
                            last={last && !expanded}
                            onClick={() => toggleRow(row.client.id)}
                            selected={expanded}
                          >
                            <GridTableCell>
                              <GridTableIdentity
                                name={(
                                  <span className="inline-flex min-w-0 items-center gap-[var(--s-2)]">
                                    <span className="truncate">{row.client.name}</span>
                                    {density === "dense" ? (
                                      <span className="shrink-0 font-[400] text-[color:var(--faint)]">
                                        · {planLabel(row)}
                                      </span>
                                    ) : null}
                                  </span>
                                )}
                                subline={density === "dense" ? undefined : (
                                  <>
                                    {planLabel(row)}
                                    {row.client.isDemo && !allRowsAreDemo ? " · Demo data" : ""}
                                  </>
                                )}
                              />
                            </GridTableCell>

                            {density === "dense" ? (
                              <GridTableCell className="text-[12.5px]">
                                {row.successOwner
                                  ? <span className="truncate">{successOwnerLabel(row)}</span>
                                  : <CellQuiet>{successOwnerLabel(row)}</CellQuiet>}
                              </GridTableCell>
                            ) : (
                              <GridTableCell className="text-[12.5px]">
                                {/* The owner's initials say nothing the owner's name beside them
                                    does not, and two monograms on one row is the budget 6b spends
                                    on the stacked evidence instead. The unassigned mark stays: it
                                    is the one case where there is no name to print. */}
                                <span className="flex min-w-0 items-center gap-[var(--s-2)]">
                                  {row.successOwner ? null : <UnassignedMark />}
                                  {row.successOwner
                                    ? <span className="truncate">{successOwnerLabel(row)}</span>
                                    : <CellQuiet>{successOwnerLabel(row)}</CellQuiet>}
                                </span>
                              </GridTableCell>
                            )}

                            <GridTableCell>
                              {now === null
                                ? <CellQuiet>not read yet</CellQuiet>
                                : <MonoMeta className="text-[11.5px]">{ageLabel(row.updatedAt, now)}</MonoMeta>}
                            </GridTableCell>

                            <GridTableCell>
                              {state
                                ? <Status label={state.label} tone={state.tone} />
                                : <CellQuiet>No request</CellQuiet>}
                            </GridTableCell>

                            <GridTableCell align="right">
                              <ChevronDown
                                aria-hidden="true"
                                className={`size-[var(--s-4)] shrink-0 text-[color:var(--faint)] transition-transform duration-[var(--duration-quick)] motion-reduce:transition-none ${expanded ? "" : "-rotate-90"}`}
                              />
                            </GridTableCell>
                          </GridTableRow>
                          {expanded ? drawer(row) : null}
                        </div>
                      );
                    })}
                    {/* Not GridTableFooter: its left slot is one truncating line, and the note
                        under a quiet table is two. No rule and no fill either -- 6a rules its
                        footer off because the table is a card and the rule is that card's last
                        edge, and 6b, which this is, draws neither.

                        The attention count rides the range rather than sitting beside the note.
                        `TableFooterNote` justifies range and note to its two ends, so a third
                        element after it landed on top of the note's right edge; the range is
                        already where a count of what is in view belongs, which is where
                        `DataTablePagination` puts its "N selected" for the same reason. */}
                    <div
                      className="flex items-start gap-[var(--s-3)] pt-[11px] text-[12px] text-[color:var(--faint)]"
                      data-slot="client-book-footer"
                    >
                      <TableFooterNote
                        note="Order is what each row is waiting on, then how recently it moved. It is not a ranking of which client matters most."
                        ordering="waiting on a person first"
                        range={`Showing ${visibleRows.length} of ${bookSize} ${bookSize === 1 ? "client" : "clients"}${
                          read ? `, ${attentionCount} need attention` : ""
                        }`}
                      />
                    </div>
                  </GridTable>
                </div>
              </div>
            </>
          )}

          {error && rows.length > 0 ? (
            <p className="mt-[var(--s-3)] text-[length:var(--t-body)] text-[color:var(--failure-text)]" role="alert">
              {error}
            </p>
          ) : null}

          <ConfirmFlow
            action="tenant.success_owner.reassigned"
            confirmLabel={actorRole === "success" ? "Take ownership" : "Change owner"}
            impact={open ? [
              { label: "Client", value: open.client.name },
              { label: "Current owner", value: successOwnerLabel(open) },
              { label: "New owner", value: candidates.find((candidate) => candidate.value === assigneeId)?.label ?? "No named owner selected" },
            ] : []}
            onConfirm={confirmAssignment}
            onOpenChange={setConfirmOpen}
            open={confirmOpen}
            reason={{
              required: true,
              label: "Reason",
              hint: "Explain why this client needs a different success owner.",
            }}
            title="Review success owner change"
          />
        </ListPage>
      )}
    </AppShell>
  );
}
