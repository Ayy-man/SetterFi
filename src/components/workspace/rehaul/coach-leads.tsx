"use client";

import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import { useMemo, useState } from "react";

import { Figure, MonoMeta, Surface } from "@/components/kit/atomics";
import { ExportMenu } from "@/components/kit/export-menu";
import { Columns, Menu } from "@/components/kit/icons";
import { SegmentedControl } from "@/components/kit/segmented-control";
import { CoachContacts } from "@/components/workspace/live/coach-contacts";
import type { AppointmentEvidenceByContact } from "@/components/workspace/live/coach-pipeline";
import {
  COACH_EYEBROW_CLASS,
  COACH_ROW_NAME_CLASS,
} from "@/components/workspace/live/coach-type";
import {
  CALLBACK_STAGES,
  leadExportRows,
  silentDays,
  type NextSetterTouchByContact,
} from "@/components/workspace/live/leads-surface";
import { workspaceDateFormat } from "@/lib/format/datetime";
import { useQueryState } from "@/lib/query-state";
import type { ContactRead } from "@/lib/repositories/contacts";

export type CoachLeadsView = "table" | "board";

export type CoachLeadsProps = {
  /** null means the appointment read itself failed; {} means it succeeded and found nothing. */
  appointmentEvidence: AppointmentEvidenceByContact | null;
  /** null means the follow-up read failed or came back truncated. */
  nextSetterTouch?: NextSetterTouchByContact | null;
  /** The page's own clock, threaded from the server so silence figures do not move on hydration. */
  nowIso: string;
  defaultView: CoachLeadsView;
  initialContacts: ContactRead[];
  impersonation?: { sessionId: string; tenantId: string } | null;
};

/**
 * The board's columns, one per stage this build actually stores.
 *
 * The artboard heads the board with AppointWise's seven names -- New lead, Qualification active,
 * Qualified, Call booked, Unqualified, Rescheduled, Cancelled -- and this build stores seven
 * stages of its own, in `COACH_PIPELINE_STAGES`. The two sevens are not the same seven, so four
 * of the artboard's names sit over the stage that means what they say, and three do not appear at
 * all:
 *
 * - **Qualified** is not a stage here. What the build records once a lead is ready to book is a
 *   decision on the lead (`outcome === "BOOK"`), which the funnel already counts as "Ready to
 *   book". A column with that heading would be one no lead could ever be moved into.
 * - **Rescheduled** and **Cancelled** have no stored state behind them either. The nearest things
 *   this build holds are "Long-term follow-up" and "No show", and those are the words the rest of
 *   the product uses for them -- the dashboard's call-back tile counts exactly those two stages --
 *   so renaming them on this one screen would make two screens disagree about the same leads.
 *
 * Every column is therefore backed by a real stage key, and the mapping is one to one: no stage is
 * merged into another and none is invented.
 */
export const LEAD_BOARD_COLUMNS = [
  { dot: "var(--accent)", key: "new_lead", label: "New lead" },
  { dot: "var(--warning)", key: "qualifying", label: "Qualification active" },
  { dot: "var(--waiting)", key: "booked", label: "Call booked" },
  { dot: "var(--waiting)", key: "long_term_followup", label: "Long-term follow-up" },
  { dot: "var(--warning)", key: "no_show", label: "No show" },
  { dot: "var(--muted)", key: "qualified_no_buy", label: "Qualified, no buy" },
  { dot: "var(--muted)", key: "disqualified", label: "Unqualified" },
] as const;

export type LeadBoardColumn = {
  key: string;
  label: string;
  dot: string;
  /** Terminal stages read at a lower weight, as the artboard draws them. */
  spent: boolean;
  contacts: readonly ContactRead[];
};

export type LeadBoard = {
  columns: readonly LeadBoardColumn[];
  /**
   * Leads whose stored stage has no column, keyed by the raw value. Never empty and silent: a lead
   * this board cannot place is named rather than dropped out of the count.
   */
  unplaced: readonly { stage: string; count: number }[];
};

const SPENT_STAGES: readonly string[] = ["qualified_no_buy", "disqualified"];

/** The seven columns with their leads, plus anything the seven could not place. */
export function leadBoard(contacts: readonly ContactRead[]): LeadBoard {
  const known = new Set<string>(LEAD_BOARD_COLUMNS.map((column) => column.key));
  const unplaced = new Map<string, number>();
  for (const contact of contacts) {
    if (known.has(contact.pipelineStage)) continue;
    unplaced.set(contact.pipelineStage, (unplaced.get(contact.pipelineStage) ?? 0) + 1);
  }
  return {
    columns: LEAD_BOARD_COLUMNS.map((column) => ({
      contacts: contacts.filter((contact) => contact.pipelineStage === column.key),
      dot: column.dot,
      key: column.key,
      label: column.label,
      spent: SPENT_STAGES.includes(column.key),
    })),
    unplaced: Array.from(unplaced.entries())
      .map(([stage, count]) => ({ count, stage }))
      .sort((left, right) => left.stage.localeCompare(right.stage)),
  };
}

/**
 * Whether a lead is waiting on the coach rather than on the setter.
 *
 * The one thing the loaded data establishes: the lead is sitting in a stage the setter has stopped
 * working -- a no show or a long-term follow-up -- and no automated touch is scheduled for it. If
 * the follow-up read failed or came back truncated (`null`), no card claims it, because an absence
 * that was never established is not evidence of one.
 */
export function needsCoach(
  contact: ContactRead,
  nextSetterTouch: NextSetterTouchByContact | null,
): boolean {
  if (nextSetterTouch === null) return false;
  if (!(CALLBACK_STAGES as readonly string[]).includes(contact.pipelineStage)) return false;
  return !nextSetterTouch[contact.id];
}

function formatDate(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : workspaceDateFormat.format(at);
}

export type LeadCardMeta = { text: string; tone: "neutral" | "warning" };

/**
 * The second line on a card: the next thing that happens to this lead, or how long it has been
 * quiet. Every branch reads a field the page already loaded.
 */
export function leadCardMeta(
  contact: ContactRead,
  input: {
    evidence: AppointmentEvidenceByContact;
    nextSetterTouch: NextSetterTouchByContact | null;
    nowMs: number;
  },
): LeadCardMeta {
  if (needsCoach(contact, input.nextSetterTouch)) {
    return { text: "Needs you · no automated touch scheduled", tone: "warning" };
  }
  const appointment = input.evidence[contact.id];
  if (contact.pipelineStage === "booked" && appointment) {
    const date = formatDate(appointment.startAt);
    if (date) return { text: date, tone: "neutral" };
  }
  const touch = input.nextSetterTouch?.[contact.id];
  if (touch) {
    const date = formatDate(touch);
    if (date) return { text: `Next touch ${date}`, tone: "neutral" };
  }
  const captured = contact.goal ?? contact.credit ?? contact.timeline;
  const days = silentDays(contact.lastActivityAt, input.nowMs);
  const silence = days === null ? "no activity recorded" : days === 0 ? "today" : `${days}d quiet`;
  return { text: captured ? `${captured} · ${silence}` : silence, tone: "neutral" };
}

/**
 * The line under the title: how many leads this month, and how many of them are booked.
 *
 * "This month" is the calendar month of the page's own clock, measured on `lastActivityAt`, which
 * is the only date every lead carries. It is therefore leads active this month rather than leads
 * created this month, and the words say so.
 */
export function leadsMonthStatus(
  contacts: readonly ContactRead[],
  nowIso: string,
): { active: number; booked: number; label: string } {
  const now = new Date(nowIso);
  const valid = !Number.isNaN(now.getTime());
  const inMonth = valid
    ? contacts.filter((contact) => {
        const at = new Date(contact.lastActivityAt);
        if (Number.isNaN(at.getTime())) return false;
        return (
          at.getUTCFullYear() === now.getUTCFullYear() && at.getUTCMonth() === now.getUTCMonth()
        );
      })
    : [];
  const booked = inMonth.filter((contact) => contact.pipelineStage === "booked").length;
  return {
    active: inMonth.length,
    booked,
    label: valid
      ? `${inMonth.length} active this month · ${booked} booked`
      : "Month figures unavailable",
  };
}

function isView(value: string | null): value is CoachLeadsView {
  return value === "table" || value === "board";
}

function LeadCard({
  contact,
  meta,
  spent,
}: {
  contact: ContactRead;
  meta: LeadCardMeta;
  spent: boolean;
}) {
  return (
    <div
      className="rounded-[12px] border bg-[var(--card)] px-[14px] py-[12px]"
      data-lead-card={contact.id}
      style={{
        borderColor: meta.tone === "warning" ? "var(--warning-line)" : "var(--line)",
        opacity: spent ? 0.75 : 1,
      }}
    >
      <div className={COACH_ROW_NAME_CLASS}>{contact.name}</div>
      <div
        className="mt-[2px] text-[14px] leading-[1.4]"
        data-lead-card-meta={contact.id}
        style={{ color: meta.tone === "warning" ? "var(--warning-text)" : "var(--faint)" }}
      >
        {meta.text}
      </div>
    </div>
  );
}

export function CoachLeads({
  appointmentEvidence,
  defaultView,
  impersonation = null,
  initialContacts,
  nextSetterTouch = null,
  nowIso,
}: CoachLeadsProps) {
  const query = useQueryState();
  const [contacts, setContacts] = useState(initialContacts);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const requested = query.get("view");
  const activeView = isView(requested) ? requested : defaultView;
  const evidence = useMemo<AppointmentEvidenceByContact>(
    () => appointmentEvidence ?? {},
    [appointmentEvidence],
  );
  const nowMs = Date.parse(nowIso);
  const board = useMemo(() => leadBoard(contacts), [contacts]);
  const status = useMemo(() => leadsMonthStatus(contacts, nowIso), [contacts, nowIso]);
  const exportRows = useMemo(() => leadExportRows(contacts), [contacts]);

  const strip = useMemo(() => {
    const count = (of: (contact: ContactRead) => boolean) => contacts.filter(of).length;
    return [
      {
        key: "open",
        label: "Open",
        value: count((contact) =>
          ["new_lead", "qualifying", "long_term_followup", "no_show"].includes(
            contact.pipelineStage,
          ),
        ),
      },
      {
        key: "booked",
        label: "Booked",
        value: count((contact) => contact.pipelineStage === "booked"),
      },
      {
        key: "lost",
        label: "Lost outcomes",
        value: count((contact) => SPENT_STAGES.includes(contact.pipelineStage)),
      },
      {
        key: "undecided",
        label: "Awaiting a decision",
        value: count((contact) => contact.outcome === null),
      },
    ];
  }, [contacts]);

  function contactMerged(_winnerId: string, loserId: string) {
    setContacts((current) => current.filter((contact) => contact.id !== loserId));
  }

  function contactUnmerged(contactId: string) {
    const restored = initialContacts.find((contact) => contact.id === contactId);
    if (!restored) return;
    setContacts((current) =>
      current.some((contact) => contact.id === contactId) ? current : [restored, ...current],
    );
  }

  function contactDeleted(contactId: string) {
    setContacts((current) => current.filter((contact) => contact.id !== contactId));
  }

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-5)]">
      <div className="flex min-w-0 flex-wrap items-end gap-[var(--s-5)]">
        <div className="min-w-0">
          <h1 className="m-0 text-[length:var(--coach-page-title)] leading-[1.05] font-[500] tracking-[-0.026em] text-[color:var(--ink)]">
            Leads
          </h1>
          <p className={`m-0 mt-[var(--s-2)] ${COACH_EYEBROW_CLASS}`} data-slot="leads-month-status">
            {status.label}
          </p>
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-[var(--s-3)]">
          <SegmentedControl
            ariaLabel="Leads view"
            onValueChange={(next) => query.set("view", next === defaultView ? null : next)}
            scale="coach"
            segments={[
              {
                count: contacts.length,
                icon: <Menu aria-hidden className="size-[18px]" />,
                key: "table",
                label: "List",
              },
              {
                count: contacts.length,
                icon: <Columns aria-hidden className="size-[18px]" />,
                key: "board",
                label: "Board",
              },
            ]}
            value={activeView}
          />
          <ExportMenu
            className="h-[48px] px-[var(--s-4)] text-[16px]"
            filename="setterfi-coach-leads"
            label="Export"
            mode="local"
            rows={exportRows}
          />
        </div>
      </div>

      {activeView === "board" ? (
        <div className="min-w-0">
          <div
            className="grid min-w-0 gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]"
            data-slot="leads-board"
          >
            {board.columns.map((column) => (
              <section
                aria-label={column.label}
                className="flex min-w-0 flex-col gap-[10px] rounded-[16px] bg-[var(--well)] p-[14px]"
                data-board-column={column.key}
                key={column.key}
              >
                <div className="flex items-center gap-[8px] px-[4px]">
                  <span
                    aria-hidden
                    className="size-[8px] shrink-0 rounded-[var(--r-full)]"
                    style={{ background: column.dot }}
                  />
                  <h2 className="m-0 text-[15px] leading-[1.3] font-[600] text-[color:var(--ink)]">
                    {column.label}
                  </h2>
                  <Figure className="ml-auto text-[14px]" data-board-count={column.key} size="sm">
                    {column.contacts.length}
                  </Figure>
                </div>
                <div className="flex max-h-[560px] min-w-0 flex-col gap-[10px] overflow-y-auto">
                  {column.contacts.map((contact) => (
                    <LeadCard
                      contact={contact}
                      key={contact.id}
                      meta={leadCardMeta(contact, {
                        evidence,
                        nextSetterTouch,
                        nowMs,
                      })}
                      spent={column.spent}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {board.unplaced.length ? (
            <p className="mt-[var(--s-3)]" data-slot="leads-board-unplaced">
              {board.unplaced.map((entry) => (
                <MonoMeta className="mr-[var(--s-3)]" key={entry.stage}>
                  {`${entry.count} in ${entry.stage}, which has no column`}
                </MonoMeta>
              ))}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
          <ul
            className="m-0 grid min-w-0 list-none grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-[var(--s-3)] p-0"
            data-slot="leads-stat-strip"
          >
            {strip.map((entry) => (
              <li className="min-w-0" key={entry.key}>
                <Surface className="min-w-0" variant="well">
                  <div className="text-[15px] leading-[1.35] font-[500] text-[color:var(--ink)]">
                    {entry.label}
                  </div>
                  <Figure className="mt-[var(--s-1)] block" data-stat={entry.key} size="lg">
                    {entry.value}
                  </Figure>
                </Surface>
              </li>
            ))}
          </ul>
          <CoachContacts
            contacts={contacts}
            impersonation={impersonation}
            onContactDeleted={contactDeleted}
            onContactMerged={contactMerged}
            onContactUnmerged={contactUnmerged}
            onSelectedChange={setSelectedId}
            selectedId={selectedId}
          />
        </div>
      )}

      <ContextEye
            screen="coach-leads"
            copy="Everyone who has messaged you, and where each one got to. The board reads each lead's stage today, not the path it took. A card marked Needs you is sitting in a no show or a long-term follow-up with no automated touch left to run, so the next move is yours."
          />
    </div>
  );
}
