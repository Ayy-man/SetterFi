"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { Sparkline, SPARKLINE_MIN_POINTS } from "@/components/kit/sparkline";
import { ConfirmFlow, type Result } from "@/components/kit/confirm-flow";
import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import { ExportMenu } from "@/components/kit/export-menu";
import { KitButton } from "@/components/kit/atomics";
import { Select } from "@/components/ui/select";
import {
  assigneeOptionsFor,
  type AssigneeOption,
} from "@/components/workspace/live/success-client-book";
import { ownerBooks } from "@/components/workspace/live/admin-support-team";
import {
  reassignmentReceiptView,
  successOwnerDisplayLabel,
} from "@/components/workspace/live/operations-view-models";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  CARD_TABLE,
  CardTable,
  Figure,
  Pill,
  RehaulTabs,
  Seg,
  StatusDot,
  type StatusTone,
} from "@/components/workspace/rehaul/_primitives";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";
import type { UserRole } from "@/lib/auth/claims";
import { WORKSPACE_DISPLAY_TIMEZONE, workspaceTimestampFormat } from "@/lib/format/datetime";
import { PROVISIONING_STEPS, type ProvisioningTrackerRow } from "@/lib/onboarding/contracts";
import type { AgentRoster, AgentRosterEntry } from "@/lib/operations/agent-roster";
import type { PlatformMeasurement } from "@/lib/repositories/platform-analytics";
import type { SuccessClientBookRead, SupportBook } from "@/lib/repositories/support";

/* --------------------------------------------------------------------------------------------
 * Contract
 * ------------------------------------------------------------------------------------------ */

export const OWNER_CLIENT_TABS = ["status", "agent", "performance", "health", "team", "setup"] as const;
export type OwnerClientsTab = (typeof OWNER_CLIENT_TABS)[number];

/**
 * A folded tab either has its read or says why it does not.
 *
 * The five surfaces this page folds do not share one gate: measurement carries its own flag and
 * its own actor, and the provisioning tracker answers 403 to readers the client book admits. A
 * fold that flattened those into an empty table would tell an owner their platform has no agents
 * on it, which is a different and much worse claim than "this tab could not be read".
 */
export type OwnerClientsFold<T> = { kind: "ready"; value: T } | { kind: "refused"; reason: string };

export type OwnerClientsPerformance = {
  origin?: PlatformMeasurement["origin"];
  role: Extract<UserRole, "owner" | "admin" | "success">;
  tenantPerformance: readonly { tenantId: string; bookedAppointments: number; grossMrrCents?: number | null }[];
  history: PlatformMeasurement["history"];
};

export type OwnerClientsHealth = {
  rows: readonly ProvisioningTrackerRow[];
  a2pSubmittedAtByTenant: Readonly<Record<string, string | null>>;
};

export type OwnerClientsProps = {
  actorId?: string;
  actorRole: Extract<UserRole, "owner" | "admin" | "success">;
  enabled: boolean;
  book: SupportBook;
  tab: OwnerClientsTab;
  selectedClientId: string | null;
  selectedOwnerId: string | null;
  rows: readonly SuccessClientBookRead[];
  rowsError: string | null;
  agents: OwnerClientsFold<AgentRoster>;
  performance: OwnerClientsFold<OwnerClientsPerformance>;
  health: OwnerClientsFold<OwnerClientsHealth>;
  /**
   * The marketplace install surface, rendered on the server and handed down as a node.
   *
   * It is the install panel, the attempts table and the agency grant cards -- the arm
   * `/admin/provisioning` used to own -- and it stays a server render because every read behind it
   * runs with the service role. Absent when the tab is not the one being drawn, so its four reads
   * never run for a reader who opened Status.
   */
  setup?: ReactNode;
  nowIso: string;
};

const REASSIGN_MICROCOPY = AUDIT_ACTIONS["tenant.success_owner.reassigned"].microcopy;

/**
 * The eye carries every sentence this page used to print under its heading: what the book is
 * ordered by, what the health dots mean, and which figures are measured rather than guessed.
 */
const EYE_COPY = "The client book is every coach on the platform, ordered so that whatever is "
  + "waiting on a person sits above whatever is not. The tabs change the columns, never the rows. "
  + "Health dots are the provisioning stages a client has cleared, and texting registration is "
  + "counted in days with the carrier because nobody can predict the date it clears. Booked calls "
  + "come from the measurement snapshot; leads, conversion and time to book are not measured per "
  + "client yet, so they are absent rather than estimated. Setup is the marketplace install: the "
  + "agency grant this workspace holds, the attempts behind it, and the provisioning queue those "
  + "installs feed.";

/* --------------------------------------------------------------------------------------------
 * Reading the rows
 * ------------------------------------------------------------------------------------------ */

function isOpenRequest(row: SuccessClientBookRead) {
  return row.supportStatus === "open" || row.supportStatus === "waiting_on_coach";
}

/** Unowned, waiting on us, or in a paying state that has gone wrong. Nothing here is a forecast. */
function needsAttention(row: SuccessClientBookRead) {
  if (!row.successOwner) return true;
  if (isOpenRequest(row)) return true;
  return ["overdue", "suspended"].includes(row.status.toLocaleLowerCase());
}

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

function humanize(value: string) {
  const words = value.replaceAll("_", " ").trim().toLocaleLowerCase();
  return words ? `${words[0].toLocaleUpperCase()}${words.slice(1)}` : "Not recorded";
}

function stateTone(value: string): StatusTone {
  const normalized = value.toLocaleLowerCase();
  if (normalized === "active") return "good";
  if (["overdue", "suspended", "churned"].includes(normalized)) return "bad";
  if (["onboarding", "paused"].includes(normalized)) return "amber";
  return "grey";
}

function planLabel(row: SuccessClientBookRead) {
  return row.planLabel?.trim() || "No plan";
}

function timestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Time not recorded" : workspaceTimestampFormat.format(date);
}

const SINCE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

function sinceLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "not recorded" : SINCE_FORMAT.format(date);
}

const SUPPORT_LABEL = {
  open: "Open request",
  waiting_on_coach: "Waiting on coach",
  resolved: "Resolved",
} as const;

const SUPPORT_TONE = {
  open: "amber",
  waiting_on_coach: "wait",
  resolved: "good",
} as const satisfies Record<string, StatusTone>;

/* --------------------------------------------------------------------------------------------
 * The six stages
 * ------------------------------------------------------------------------------------------ */

/**
 * The stepper the artboard draws, mapped onto the provisioning steps that actually exist.
 *
 * `a2p_campaign` is the texting filing and is the only stage with a day count on it: it is the one
 * wait that belongs to a carrier rather than to us or to the coach, so it reads as elapsed days and
 * never as a percentage or a predicted date.
 */
const STAGES = [
  { step: "ghl_location", label: "Sub-account" },
  { step: "phone_number", label: "Phone number" },
  { step: "a2p_campaign", label: "Texting registration" },
  { step: "meta_connect", label: "Instagram and Messenger" },
  { step: "calendar_connect", label: "Calendar" },
  { step: "go_live", label: "Live" },
] as const;

type StageRead = { label: string; tone: StatusTone; detail: string };

function stageTone(row: ProvisioningTrackerRow | null, step: string): { tone: StatusTone; detail: string } {
  if (!row) return { tone: "grey", detail: "not tracked" };
  const target = PROVISIONING_STEPS.indexOf(step as (typeof PROVISIONING_STEPS)[number]);
  const current = row.currentStep
    ? PROVISIONING_STEPS.indexOf(row.currentStep)
    : -1;
  if (current < 0) return { tone: "grey", detail: "not started" };
  if (target < current) return { tone: "good", detail: "cleared" };
  if (target > current) return { tone: "grey", detail: "not reached" };
  if (row.state === "done") return { tone: "good", detail: "cleared" };
  if (row.state === "failed" || row.state === "blocked") return { tone: "bad", detail: humanize(row.state).toLocaleLowerCase() };
  if (row.state === "awaiting_provider") {
    return { tone: "amber", detail: row.blockingProvider === "carrier" ? "with carrier" : "with the provider" };
  }
  if (row.state === "awaiting_coach") return { tone: "amber", detail: "waiting on coach" };
  if (row.state === "awaiting_platform") return { tone: "amber", detail: "waiting on the team" };
  return { tone: "wait", detail: humanize(row.state).toLocaleLowerCase() };
}

function stageReads(row: ProvisioningTrackerRow | null): StageRead[] {
  return STAGES.map((stage) => ({ label: stage.label, ...stageTone(row, stage.step) }));
}

/* --------------------------------------------------------------------------------------------
 * The page
 * ------------------------------------------------------------------------------------------ */

function href(input: {
  tab: OwnerClientsTab;
  book: SupportBook;
  client?: string | null;
  owner?: string | null;
}) {
  const params = new URLSearchParams();
  params.set("tab", input.tab);
  if (input.book === "mine") params.set("book", "mine");
  if (input.client) params.set("client", input.client);
  if (input.owner) params.set("owner", input.owner);
  return `/admin/platform-clients?${params.toString()}`;
}

function Refusal({ reason, title }: { reason: string; title: string }) {
  return (
    <div
      className="rounded-[14px] border border-[var(--warning-line)] bg-[var(--warning-wash)] p-5"
      data-slot="owner-clients-refusal"
      role="status"
    >
      <div className="flex items-center gap-2 text-[13.5px] font-semibold text-[var(--ink)]">
        <StatusDot tone="amber" />
        {title}
      </div>
      <p className="m-0 mt-1.5 text-[12.5px] leading-[1.5] text-[var(--warning-body)]">{reason}</p>
    </div>
  );
}

function Quiet({ children }: { children: ReactNode }) {
  return <span className="text-[12.5px] text-[var(--faint)]">{children}</span>;
}

/**
 * The rail's monogram, at the size the artboard draws it.
 *
 * Two letters at most, taken from the name the projection actually returned. An owner the store
 * never named comes through as "Owner not named" from `ownerBooks`, so the monogram reads "ON"
 * rather than inventing a person's initials.
 */
function Monogram({ name }: { name: string }) {
  const initials = name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toLocaleUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[rgba(60,90,150,0.1)] font-mono text-[11px] font-medium text-[var(--body)]"
    >
      {initials}
    </span>
  );
}

/** A counted tile: the figure, then what it counts. Amber only where the count is work waiting. */
function Tile({ amber, label, value }: { amber?: boolean; label: string; value: number }) {
  return (
    <div
      className={`flex items-baseline gap-3 rounded-[14px] border px-[18px] py-3.5 ${
        amber
          ? "border-[var(--warning-line)] bg-[var(--warning-wash)]"
          : "border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))]"
      }`}
    >
      <Figure className={amber ? "text-[var(--warning-text)]" : undefined} size="md">{value}</Figure>
      <div className="text-[12.5px] font-medium text-[var(--faint)]">{label}</div>
    </div>
  );
}

export function OwnerClients({
  actorId = "",
  actorRole,
  agents,
  book,
  enabled,
  health,
  nowIso,
  performance,
  rows,
  rowsError,
  selectedClientId,
  selectedOwnerId,
  setup = null,
  tab,
}: OwnerClientsProps) {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [assigneeChoice, setAssigneeChoice] = useState<string | null>(null);
  const [assignmentNote, setAssignmentNote] = useState<string | null>(null);

  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const ordered = useMemo(() => [...rows].sort(bookOrder), [rows]);
  const attention = useMemo(() => rows.filter(needsAttention).length, [rows]);
  const books = useMemo(() => ownerBooks(rows), [rows]);
  const unassigned = useMemo(() => rows.filter((row) => !row.successOwner), [rows]);
  const largest = books[0]?.clients ?? 0;

  const agentByTenant = useMemo(() => new Map<string, AgentRosterEntry>(
    agents.kind === "ready" ? agents.value.entries.map((entry) => [entry.tenantId, entry]) : [],
  ), [agents]);
  const performanceByTenant = useMemo(() => new Map(
    performance.kind === "ready"
      ? performance.value.tenantPerformance.map((entry) => [entry.tenantId, entry])
      : [],
  ), [performance]);
  const trackerByTenant = useMemo(() => new Map(
    health.kind === "ready"
      ? health.value.rows.flatMap((row) => (row.tenantId ? [[row.tenantId, row] as const] : []))
      : [],
  ), [health]);

  const open = ordered.find((row) => row.client.id === selectedClientId) ?? null;
  const openBook = books.find((entry) => entry.id === selectedOwnerId) ?? null;

  const candidates: AssigneeOption[] = useMemo(
    () => assigneeOptionsFor({ rows, actorId, actorRole }),
    [actorId, actorRole, rows],
  );
  const assigneeId = assigneeChoice
    ?? (actorRole === "success" ? actorId : open?.successOwner?.id ?? "");

  async function confirmAssignment(input: { reason?: string }): Promise<Result> {
    if (!open || !assigneeId || !input.reason) {
      return { ok: false, message: "Choose a named owner and add a reason." };
    }
    try {
      const response = await fetch(`/api/platform/clients/${open.client.id}/success-owner`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId, reason: input.reason }),
      });
      const value = (await response.json()) as Parameters<typeof reassignmentReceiptView>[0]["receipt"];
      const confirmed = reassignmentReceiptView({
        expectedTenant: open.client.id,
        expectedAssignee: assigneeId,
        receipt: value,
      });
      if (!response.ok || confirmed.kind !== "reassigned") {
        return { ok: false, message: "The owner change was not confirmed by the client and audit read-back." };
      }
      setAssignmentNote(`Owner changed. ${REASSIGN_MICROCOPY}.`);
      router.refresh();
      return {
        ok: true,
        receipt: { auditId: confirmed.auditId, actionKey: "tenant.success_owner.reassigned" },
      };
    } catch {
      return { ok: false, message: "The owner change could not be confirmed." };
    }
  }

  /* ------------------------------------------------------------------------------------------
   * The table, one head and one row shape per tab
   * ---------------------------------------------------------------------------------------- */

  const HEADS: Record<Exclude<OwnerClientsTab, "team" | "setup">, readonly { label: string; num?: boolean }[]> = {
    agent: [
      { label: "Client" }, { label: "Agent" }, { label: "Live version", num: true },
      { label: "Unpublished edits", num: true }, { label: "From the brain" }, { label: "Open threads", num: true },
    ],
    health: [
      { label: "Client" }, { label: "Stages" }, { label: "Blocked on" }, { label: "Texting registration" },
    ],
    performance: [
      { label: "Client" }, { label: "Booked calls", num: true }, { label: "Gross MRR", num: true },
      { label: "Leads" }, { label: "Conversion" }, { label: "Time to book" },
    ],
    status: [
      { label: "Client" }, { label: "Plan" }, { label: "State" }, { label: "Success owner" },
      { label: "Since", num: true }, { label: "Support" },
    ],
  };

  function clientCell(row: SuccessClientBookRead) {
    return (
      <td className={CARD_TABLE.td}>
        <Link
          className="font-medium text-[var(--ink)] no-underline hover:underline"
          href={href({ tab, book, client: row.client.id })}
        >
          {row.client.name}
        </Link>
        {row.client.isDemo ? <span className="ml-2 text-[11.5px] text-[var(--faint)]">Demo</span> : null}
      </td>
    );
  }

  function statusRow(row: SuccessClientBookRead) {
    const support = row.supportStatus;
    return (
      <>
        <td className={CARD_TABLE.td}>{planLabel(row)}</td>
        <td className={CARD_TABLE.td}>
          <span className="inline-flex items-center gap-2">
            <StatusDot tone={stateTone(row.status)} />
            {humanize(row.status)}
          </span>
        </td>
        <td className={CARD_TABLE.td}>
          {row.successOwner
            ? successOwnerDisplayLabel(row.successOwner)
            : <Quiet>Nobody owns this</Quiet>}
        </td>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>{sinceLabel(row.updatedAt)}</td>
        <td className={CARD_TABLE.td}>
          {support
            ? (
              <span className="inline-flex items-center gap-2">
                <StatusDot tone={SUPPORT_TONE[support]} />
                {SUPPORT_LABEL[support]}
              </span>
            )
            : <Quiet>No request</Quiet>}
        </td>
      </>
    );
  }

  function agentRow(row: SuccessClientBookRead) {
    const entry = agentByTenant.get(row.client.id);
    const settingCount = agents.kind === "ready" ? agents.value.settingCount : 0;
    if (!entry) {
      return (
        <td className={CARD_TABLE.td} colSpan={5}><Quiet>No agent row for this client</Quiet></td>
      );
    }
    const tone: StatusTone = entry.state === "live" ? "good" : entry.state === "draft" ? "amber" : "grey";
    const label = entry.state === "live" ? "Live"
      : entry.state === "draft" ? "Draft above the published version" : "Never published";
    return (
      <>
        <td className={CARD_TABLE.td}>
          <span className="inline-flex items-center gap-2"><StatusDot tone={tone} />{label}</span>
        </td>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>
          {entry.liveVersion === null ? <Quiet>none</Quiet> : `v${entry.liveVersion}`}
        </td>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>{entry.unpublishedEdits}</td>
        <td className={CARD_TABLE.td}>
          {settingCount - entry.overrides} of {settingCount}
        </td>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>
          {entry.openThreads === null ? <Quiet>not read</Quiet> : entry.openThreads}
        </td>
      </>
    );
  }

  function performanceRow(row: SuccessClientBookRead) {
    const entry = performanceByTenant.get(row.client.id);
    const mrr = entry && "grossMrrCents" in entry ? entry.grossMrrCents ?? null : null;
    return (
      <>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>
          {entry ? entry.bookedAppointments : <Quiet>not measured</Quiet>}
        </td>
        <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>
          {mrr === null ? <Quiet>not shown</Quiet> : `$${Math.round(mrr / 100).toLocaleString("en-US")}`}
        </td>
        <td className={CARD_TABLE.td}><Quiet>not measured</Quiet></td>
        <td className={CARD_TABLE.td}><Quiet>not measured</Quiet></td>
        <td className={CARD_TABLE.td}><Quiet>not measured</Quiet></td>
      </>
    );
  }

  function healthRow(row: SuccessClientBookRead) {
    const tracker = trackerByTenant.get(row.client.id) ?? null;
    const stages = stageReads(tracker);
    const submittedAt = health.kind === "ready"
      ? health.value.a2pSubmittedAtByTenant[row.client.id] ?? null
      : null;
    const days = submittedAt ? elapsedWorkspaceDays(submittedAt, now) : null;
    return (
      <>
        <td className={CARD_TABLE.td}>
          <span className="inline-flex items-center gap-1.5" title={stages.map((stage) => `${stage.label}: ${stage.detail}`).join(" · ")}>
            {stages.map((stage) => <StatusDot key={stage.label} tone={stage.tone} />)}
          </span>
        </td>
        <td className={CARD_TABLE.td}>
          {tracker
            ? (tracker.blockingProvider
              ? `Waiting on ${tracker.blockingProvider === "carrier" ? "the carrier" : tracker.blockingProvider}`
              : humanize(tracker.blockingParty))
            : <Quiet>not tracked</Quiet>}
        </td>
        <td className={CARD_TABLE.td}>
          {days === null
            ? <Quiet>{submittedAt ? "start time not readable" : "no filing receipt"}</Quiet>
            : <span className="font-mono font-medium tracking-[-0.05em] text-[var(--warning-text)]">day {days}</span>}
        </td>
      </>
    );
  }

  const tabular = tab !== "team" && tab !== "setup";
  const heads = tabular ? HEADS[tab] : [];
  const tableRows = !tabular ? [] : ordered.map((row) => (
      <tr key={row.client.id} className={row.client.id === selectedClientId ? "bg-[var(--accent-wash)]" : undefined}>
        {clientCell(row)}
        {tab === "status" ? statusRow(row) : null}
        {tab === "agent" ? agentRow(row) : null}
        {tab === "performance" ? performanceRow(row) : null}
        {tab === "health" ? healthRow(row) : null}
      </tr>
  ));

  const foldRefusal = tab === "agent" && agents.kind === "refused" ? agents
    : tab === "performance" && performance.kind === "refused" ? performance
      : tab === "health" && health.kind === "refused" ? health
        : null;

  const historyPoints = performance.kind === "ready"
    ? performance.value.history.filter((point) => point.state === "available").map((point) => point.value)
    : [];


  /* ------------------------------------------------------------------------------------------
   * The Team tab
   *
   * A roster of people, drawn as cards rather than as a sixth column set: the question this tab
   * answers is who is carrying what, and a card holds the whole book beside the counts. The four
   * tiles above it are the same rows counted a different way, so nothing here is a second read.
   * ---------------------------------------------------------------------------------------- */

  function teamBoard() {
    const assigned = rows.filter((row) => row.successOwner).length;
    const openRequests = rows.filter(isOpenRequest).length;
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" data-slot="owner-clients-team-tiles">
          <Tile label={books.length === 1 ? "person with a book" : "people with a book"} value={books.length} />
          <Tile label="clients assigned" value={assigned} />
          <Tile amber={openRequests > 0} label="open requests" value={openRequests} />
          <Tile amber={unassigned.length > 0} label="unassigned" value={unassigned.length} />
        </div>

        {books.length === 0 ? (
          <div className={`${CARD_TABLE.card} px-4 py-3 text-[12.5px] text-[var(--faint)]`}>
            No success owner holds a client in this book.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2" data-slot="owner-clients-team-cards">
            {books.map((entry) => {
              const held = rows.filter((row) => row.successOwner?.id === entry.id);
              const selected = entry.id === selectedOwnerId;
              return (
                <Link
                  aria-current={selected ? "true" : undefined}
                  className={`${CARD_TABLE.card} flex flex-col gap-2.5 p-[16px_18px] no-underline ${
                    selected ? "border-[var(--accent-line)] bg-[var(--accent-wash)]" : ""
                  }`}
                  href={href({ tab: "team", book, owner: entry.id })}
                  key={entry.id}
                >
                  <div className="flex items-start gap-2.5">
                    <Monogram name={entry.name} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-semibold text-[var(--ink)]">{entry.name}</div>
                      <div className="text-[12.5px] text-[var(--faint)]">
                        {entry.id === actorId ? "Your book" : "Success owner"}
                      </div>
                    </div>
                    <Figure size="md">{entry.clients}</Figure>
                  </div>

                  {/* Share of the heaviest book, which is the only comparison the counts support. */}
                  <span aria-hidden className="block h-1 w-full rounded-sm bg-[rgba(60,90,150,0.12)]">
                    <span
                      className={`block h-1 rounded-sm ${entry.openRequests > 0 ? "bg-[var(--warning)]" : "bg-[var(--accent)]"}`}
                      style={{ width: `${largest > 0 ? Math.round((entry.clients / largest) * 100) : 0}%` }}
                    />
                  </span>

                  <div className="font-mono text-[11.5px] text-[var(--meta)]">
                    {entry.live} live · {entry.onboarding} onboarding · {entry.openRequests} open
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {held.map((row) => <Pill key={row.client.id}>{row.client.name}</Pill>)}
                  </div>

                  {/*
                    * The artboard puts a median reply time here. Nothing on the client book or the
                    * support projection records a reply clock per owner, so the row states the
                    * absence rather than standing a number in for it.
                    */}
                  <div className="mt-auto flex items-center gap-2 border-t border-[var(--line-soft)] pt-1.5">
                    <span className="text-[12.5px] text-[var(--faint)]">Median reply</span>
                    <span className="ml-auto font-mono text-[12px] text-[var(--overline)]">not measured</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </>
    );
  }

  /* ------------------------------------------------------------------------------------------
   * The drawer
   * ---------------------------------------------------------------------------------------- */

  function clientDrawer(row: SuccessClientBookRead) {
    const entry = agentByTenant.get(row.client.id);
    const measured = performanceByTenant.get(row.client.id);
    const tracker = trackerByTenant.get(row.client.id) ?? null;
    const submittedAt = health.kind === "ready"
      ? health.value.a2pSubmittedAtByTenant[row.client.id] ?? null
      : null;
    const stages = stageReads(tracker);
    return (
      <div className={`${CARD_TABLE.card} flex flex-col gap-3.5 p-[18px_20px]`} data-slot="owner-clients-drawer">
        <div>
          <div className="text-[12.5px] font-medium text-[var(--faint)]">Client</div>
          <div className="mt-0.5 text-[17px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{row.client.name}</div>
          <div className="text-[12.5px] text-[var(--faint)]">
            {planLabel(row)} · {successOwnerDisplayLabel(row.successOwner)} · since {sinceLabel(row.updatedAt)}
          </div>
        </div>

        <Seg
          items={OWNER_CLIENT_TABS.filter((key) => key !== "team" && key !== "setup").map((key) => ({
            active: key === tab,
            href: href({ tab: key, book, client: row.client.id }),
            label: key === "status" ? "Status" : key === "agent" ? "Agent"
              : key === "performance" ? "Performance" : "Health",
          }))}
          label="Client sections"
        />

        {tab === "health" ? (
          <div className="flex flex-col" data-slot="owner-clients-stepper">
            {stages.map((stage, index) => (
              <div
                className={`flex h-10 items-center gap-2.5 text-[13px] ${index === stages.length - 1 ? "" : "border-b border-[var(--line-soft)]"}`}
                key={stage.label}
              >
                <StatusDot tone={stage.tone} />
                <span className="flex-1 text-[var(--body)]">{stage.label}</span>
                <span className="font-mono text-[12px] text-[var(--muted)]">{stage.detail}</span>
              </div>
            ))}
            <div className="mt-3">
              {submittedAt
                ? <DayCounter now={now} since={submittedAt} typicalDays={[5, 21]} />
                : <Quiet>Texting registration has no filing receipt on this client yet.</Quiet>}
            </div>
          </div>
        ) : null}

        {tab === "agent" ? (
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-[12.5px]">
            <dt className="text-[var(--faint)]">Agent</dt>
            <dd className="m-0 text-[var(--body)]">
              {entry ? (entry.state === "live" ? "Live" : entry.state === "draft" ? "Draft" : "Never published") : "No agent row"}
            </dd>
            <dt className="text-[var(--faint)]">Live version</dt>
            <dd className="m-0 font-mono text-[var(--body)]">{entry?.liveVersion === null || !entry ? "none" : `v${entry.liveVersion}`}</dd>
            <dt className="text-[var(--faint)]">From the brain</dt>
            <dd className="m-0 text-[var(--body)]">
              {agents.kind === "ready" && entry
                ? `${agents.value.settingCount - entry.overrides} of ${agents.value.settingCount}`
                : "not read"}
            </dd>
            <dt className="text-[var(--faint)]">Brain version</dt>
            <dd className="m-0 font-mono text-[var(--body)]">
              {agents.kind === "ready" && agents.value.brainVersion !== null ? `v${agents.value.brainVersion}` : "none published"}
            </dd>
          </dl>
        ) : null}

        {tab === "performance" ? (
          <div className="flex flex-col gap-2 text-[12.5px]">
            <div className="flex items-baseline gap-3">
              <Figure size="md">{measured ? measured.bookedAppointments : "—"}</Figure>
              <span className="text-[var(--faint)]">booked calls in the measured window</span>
            </div>
          </div>
        ) : null}

        {tab === "status" ? (
          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 text-[12.5px]">
            <dt className="text-[var(--faint)]">Plan</dt>
            <dd className="m-0 text-[var(--body)]">{planLabel(row)}</dd>
            <dt className="text-[var(--faint)]">State</dt>
            <dd className="m-0 text-[var(--body)]">{humanize(row.status)}</dd>
            <dt className="text-[var(--faint)]">Support</dt>
            <dd className="m-0 text-[var(--body)]">
              {row.supportStatus ? SUPPORT_LABEL[row.supportStatus] : "No request"}
            </dd>
            <dt className="text-[var(--faint)]">Updated</dt>
            <dd className="m-0 font-mono text-[var(--body)]">{timestamp(row.updatedAt)}</dd>
          </dl>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2">
          <KitButton
            disabled={!assigneeId}
            onClick={() => setConfirmOpen(true)}
            size="sm"
            variant="primary"
          >
            {actorRole === "success" ? "Take ownership" : "Reassign"}
          </KitButton>
          {candidates.length > 0 && actorRole !== "success" ? (
            <Select
              className="min-w-[180px]"
              label="Assignee"
              onValueChange={(value) => setAssigneeChoice(value)}
              options={candidates}
              placeholder="Choose an owner"
              srOnly
              value={assigneeId || null}
            />
          ) : null}
          <Link className="text-[12.5px] text-[var(--accent-text)]" href="/admin/support">Open in Support</Link>
        </div>
        {assignmentNote ? (
          <p className="m-0 text-[12.5px] text-[var(--good-text)]" role="status">{assignmentNote}</p>
        ) : null}
        <div className="font-mono text-[11px] text-[var(--overline)]">Logged</div>
      </div>
    );
  }

  function ownerDrawer(entry: (typeof books)[number]) {
    const held = rows.filter((row) => row.successOwner?.id === entry.id);
    const openRequests = held.filter(isOpenRequest);
    return (
      <div className={`${CARD_TABLE.card} flex flex-col gap-3.5 p-[18px_20px]`} data-slot="owner-clients-drawer">
        <div className="flex items-start gap-2.5">
          <Monogram name={entry.name} />
          <div>
            <div className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--ink)]">{entry.name}</div>
            <div className="text-[12.5px] text-[var(--faint)]">
              Success owner · {entry.clients} {entry.clients === 1 ? "client" : "clients"}
            </div>
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[12.5px] font-medium text-[var(--faint)]">Book</div>
          <div className="flex flex-col">
            {held.map((row, index) => (
              <div
                className={`flex h-9 items-center gap-2.5 text-[13px] ${index === held.length - 1 ? "" : "border-b border-[var(--line-soft)]"}`}
                key={row.client.id}
              >
                <StatusDot tone={isOpenRequest(row) ? "amber" : stateTone(row.status)} />
                <span className="flex-1 truncate text-[var(--body)]">{row.client.name}</span>
                <span className="text-[11.5px] text-[var(--faint)]">{planLabel(row)}</span>
              </div>
            ))}
          </div>
        </div>

        {openRequests.length > 0 ? (
          <div>
            <div className="mb-1.5 text-[12.5px] font-medium text-[var(--faint)]">Open requests</div>
            <div className="flex flex-col gap-2">
              {openRequests.map((row) => (
                <Link
                  className={`flex items-center gap-2.5 rounded-[10px] px-3 py-2.5 no-underline ${
                    row.supportStatus === "open" ? "bg-[var(--warning-wash)]" : "bg-[var(--well)]"
                  }`}
                  href={href({ tab: "status", book, client: row.client.id })}
                  key={row.client.id}
                >
                  <StatusDot tone={SUPPORT_TONE[row.supportStatus as keyof typeof SUPPORT_TONE]} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-[var(--ink)]">
                      {SUPPORT_LABEL[row.supportStatus as keyof typeof SUPPORT_LABEL]}
                    </span>
                    <span className="block truncate text-[12.5px] text-[var(--faint)]">{row.client.name}</span>
                  </span>
                  {/*
                    * The client book records when the row last moved and nothing else about the
                    * request, so this is a last-change date and never a wait: a wait would claim a
                    * clock nobody started.
                    */}
                  <span
                    className={`shrink-0 font-mono text-[11.5px] ${
                      row.supportStatus === "open" ? "text-[var(--warning-text)]" : "text-[var(--meta)]"
                    }`}
                  >
                    {sinceLabel(row.updatedAt)}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-auto flex flex-wrap items-center gap-2">
          <KitButton
            onClick={() => router.push(href({ tab: "status", book }))}
            size="sm"
            variant="primary"
          >
            Reassign a client
          </KitButton>
          <Link className="text-[12.5px] text-[var(--accent-text)]" href="/admin/support">Open in Support</Link>
        </div>
        <div className="font-mono text-[11px] text-[var(--overline)]">Logged</div>
      </div>
    );
  }

  const drawer = tab === "setup"
    ? null
    : tab === "team"
      ? (openBook ? ownerDrawer(openBook) : null)
      : (open ? clientDrawer(open) : null);

  /* ------------------------------------------------------------------------------------------
   * Render
   * ---------------------------------------------------------------------------------------- */

  return (
    <AppShell
      activePath="/admin/platform-clients"
      crumbs={[{ label: "Run" }, { label: "Clients" }]}
      navCounts={{ "/admin/platform-clients": attention }}
      platformRole={actorRole}
      role="admin"
    >
      <div className="flex min-h-0 flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="m-0 text-[30px] font-semibold tracking-tight text-[var(--ink)]">Clients</h1>
            <p className="m-0 mt-1 text-[13px] text-[var(--faint)]">
              <span className="font-mono">{rows.length}</span>
              {rows.length === 1 ? " client" : " clients"}
              {" · "}
              <span className="font-mono">{attention}</span> need a hand
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Seg
              items={[
                { active: book === "mine", href: href({ tab, book: "mine" }), label: "My clients" },
                { active: book === "all", href: href({ tab, book: "all" }), label: "All" },
              ]}
              label="Client book"
            />
            <ExportMenu
              filename="setterfi-success-client-book"
              mode="server"
              query={{ book, reason: "" }}
              resource="success-client-book"
            />
          </div>
        </div>

        <RehaulTabs
          items={OWNER_CLIENT_TABS.map((key) => ({
            active: key === tab,
            href: href({ tab: key, book }),
            label: key === "status" ? "Status" : key === "agent" ? "Agent"
              : key === "performance" ? "Performance" : key === "health" ? "Health"
                : key === "team" ? "Team" : "Setup",
          }))}
          label="Client sections"
        />

        {!enabled ? (
          <Refusal
            reason="Client-book reads are not enabled in this environment."
            title="Client book is not enabled"
          />
        ) : rowsError ? (
          <Refusal reason={rowsError} title="Client book unavailable" />
        ) : (
          <div className={`grid min-h-0 gap-4 ${drawer ? "lg:grid-cols-[minmax(0,1fr)_400px]" : ""}`}>
            <div className="flex min-w-0 flex-col gap-4">
              {foldRefusal ? <Refusal reason={foldRefusal.reason} title="This tab could not be read" /> : null}

              {tab === "performance" && historyPoints.length >= SPARKLINE_MIN_POINTS ? (
                <div className={`${CARD_TABLE.card} flex items-center gap-4 px-4 py-3`}>
                  <span className="text-[12.5px] text-[var(--faint)]">Booked calls across the platform</span>
                  <Sparkline label="Booked calls across the platform, by period" points={historyPoints} />
                </div>
              ) : null}

              {tab === "setup" ? setup : tab === "team" ? teamBoard() : (
              <CardTable>
                <table className={CARD_TABLE.table}>
                  <thead>
                    <tr>
                      {heads.map((column) => (
                        <th className={`${CARD_TABLE.th} ${column.num ? "text-right" : ""}`} key={column.label} scope="col">
                          {column.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tableRows.length === 0 ? (
                      <tr>
                        <td className={`${CARD_TABLE.td} text-[var(--faint)]`} colSpan={heads.length}>
                          No clients in this book.
                        </td>
                      </tr>
                    ) : tableRows}
                  </tbody>
                </table>
                {tab === "health" ? (
                  <div className="flex gap-4 px-3 py-2.5 text-[11.5px] text-[var(--meta)]">
                    <span>Stages: {STAGES.map((stage) => stage.label).join(" · ")}</span>
                  </div>
                ) : null}
              </CardTable>
              )}

              {tab === "team" && unassigned.length > 0 ? (
                <CardTable className="border-[var(--warning-line)]">
                  <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-3.5 py-2.5">
                    <StatusDot tone="amber" />
                    <span className="text-[13px] font-semibold text-[var(--ink)]">Waiting for an owner</span>
                    <span className="font-mono text-[11.5px] text-[var(--warning-text)]">{unassigned.length}</span>
                    <span className="ml-auto">
                      <ExportMenu
                        filename="setterfi-clients-waiting-for-an-owner"
                        mode="local"
                        rows={unassigned.map((row) => ({
                          client: row.client.name,
                          lifecycle: humanize(row.status),
                          plan: planLabel(row),
                          request: row.supportStatus ? SUPPORT_LABEL[row.supportStatus] : "No request",
                          last_change: row.updatedAt,
                        }))}
                      />
                    </span>
                  </div>
                  <table className={CARD_TABLE.table}>
                    <thead>
                      <tr>
                        <th className={CARD_TABLE.th} scope="col">Client</th>
                        <th className={CARD_TABLE.th} scope="col">Lifecycle</th>
                        <th className={CARD_TABLE.th} scope="col">Request</th>
                        <th className={`${CARD_TABLE.th} text-right`} scope="col">Last change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unassigned.map((row) => (
                        <tr key={row.client.id}>
                          <td className={CARD_TABLE.td}>
                            <Link
                              className="font-medium text-[var(--ink)] no-underline hover:underline"
                              href={href({ tab: "status", book, client: row.client.id })}
                            >
                              {row.client.name}
                            </Link>
                            <span className="ml-2 text-[11.5px] text-[var(--faint)]">{planLabel(row)}</span>
                          </td>
                          <td className={CARD_TABLE.td}>
                            <Pill><StatusDot tone={stateTone(row.status)} />{humanize(row.status)}</Pill>
                          </td>
                          <td className={CARD_TABLE.td}>
                            {row.supportStatus
                              ? <Pill tone="amber"><StatusDot tone={SUPPORT_TONE[row.supportStatus]} />{SUPPORT_LABEL[row.supportStatus]}</Pill>
                              : <Quiet>No request</Quiet>}
                          </td>
                          <td className={`${CARD_TABLE.td} ${CARD_TABLE.num}`}>{timestamp(row.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </CardTable>
              ) : null}
            </div>
            {drawer}
          </div>
        )}

        <ContextEye copy={EYE_COPY} position="fixed" screen="owner-clients" />
      </div>

      <ConfirmFlow
        action="tenant.success_owner.reassigned"
        confirmLabel={actorRole === "success" ? "Take ownership" : "Change owner"}
        impact={open ? [
          { label: "Client", value: open.client.name },
          { label: "Current owner", value: successOwnerDisplayLabel(open.successOwner) },
          {
            label: "New owner",
            value: candidates.find((candidate) => candidate.value === assigneeId)?.label
              ?? "No named owner selected",
          },
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
    </AppShell>
  );
}
