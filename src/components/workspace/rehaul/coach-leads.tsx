"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";

import { ExportMenu } from "@/components/kit/export-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { CoachScale } from "@/components/coach-scale";
import {
  COACH_EYEBROW_CLASS,
  COACH_ROW_NAME_CLASS,
  COACH_SURFACE_TITLE_CLASS,
} from "@/components/workspace/live/coach-type";
import { filterLeads, LEAD_SEARCH_PLACEHOLDER } from "@/components/workspace/live/lead-search";
import { ContextEye } from "@/components/workspace/rehaul/context-eye";
import {
  channelLabel,
  coachLeadsView,
  lastActivityLabel,
  leadBoard,
  leadExportRows,
  leadSentence,
  leadsProvenance,
  moveTargets,
  outcomeLabel,
  stageDot,
  stageLabel,
  type AppointmentEvidenceByContact,
  type CoachLeadsView,
} from "@/components/workspace/rehaul/coach-leads-model";
import { displayName } from "@/lib/format/display-name";
import { useQueryState } from "@/lib/query-state";
import type { ContactRead } from "@/lib/repositories/contacts";

/* The sentences this screen no longer prints under its heading, handed to the eye instead. */
const LEADS_EYE_COPY =
  "Everyone who has messaged you, and where each one got to. The list is ordered by newest "
  + "activity. The board reads each lead's stage today, not the path it took, and moving a card "
  + "is recorded against your name. Report a duplicate and Request deletion both open a message "
  + "to support; neither one changes the lead.";

const REQUEST_NOTE =
  "Both requests open a message to support.";

export type CoachLeadsRequestKind = "duplicate" | "deletion";

export type CoachLeadsProps = {
  /** null means the appointment read itself failed; {} means it succeeded and found nothing. */
  appointmentEvidence: AppointmentEvidenceByContact | null;
  /** The page's own clock, threaded from the server so relative ages do not move on hydration. */
  nowIso: string;
  /** The view the route opens on: the list on `/coach/contacts`, the board on `/coach/pipelines`. */
  defaultView: CoachLeadsView;
  initialContacts: ContactRead[];
  impersonation?: { sessionId: string; tenantId: string } | null;
  /** `SETTERFI_PIPELINE_WRITE_LIVE`. Off means the board says so once and moves nothing. */
  writeEnabled?: boolean;
};

const PAGE_SIZE = 25;

/**
 * The stage filter's "no filter" value.
 *
 * An empty string reads as "no selection" to the select primitive, which then renders a blank
 * trigger rather than the words "All stages": the absence of a filter is a state with a name, and
 * a control that shows nothing is a control a coach cannot tell from a broken one.
 */
const ALL_STAGES = "all";

const CONTROL_CLASS =
  "inline-flex h-[48px] shrink-0 items-center justify-center gap-[10px] rounded-[9px] border "
  + "border-[var(--line)] bg-[var(--control-fill)] px-[22px] text-[16px] font-medium "
  + "text-[color:var(--body)] whitespace-nowrap hover:border-[var(--accent-edge)] "
  + "disabled:opacity-60";

const MENU_CONTENT_CLASS =
  "w-[268px] rounded-[12px] border border-[var(--line)] bg-[var(--raised)] p-[6px] "
  + "shadow-[var(--shadow-raised)]";

const MENU_ITEM_CLASS =
  "flex min-h-[48px] items-center rounded-[8px] px-[14px] text-[16px] leading-[1.4] "
  + "text-[color:var(--ink)] focus:bg-[var(--row-hover)] data-disabled:opacity-60";

const CELL_CLASS = "px-[26px] text-[16px] leading-[1.4]";

function MoreIcon() {
  return (
    <svg aria-hidden className="size-[20px]" fill="none" stroke="currentColor" strokeWidth="1.75" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden className="size-[16px] text-[color:var(--faint)]" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" viewBox="0 0 24 24">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function conversationHref(contactId: string) {
  return `/coach/conversations?contact=${encodeURIComponent(contactId)}`;
}

/** A stage as a dot and a word. Never a pill: the row is already dense with boxes. */
function StageWord({ stage }: { stage: string }) {
  return (
    <span className="inline-flex items-center gap-[8px] whitespace-nowrap text-[16px] text-[color:var(--body)]">
      <span
        aria-hidden
        className="size-[8px] shrink-0 rounded-full"
        style={{ background: stageDot(stage) }}
      />
      {stageLabel(stage)}
    </span>
  );
}

/**
 * The three things a coach can do to one lead, behind one 44px trigger.
 *
 * Two of them file a request and neither performs it, which is the whole point of the demotion in
 * `SIMPLIFICATION-SPEC` 2.3: merge, unmerge and a type-to-confirm permanent delete were controls
 * asking a coach to reason about identity resolution and irreversible destruction. The sentence
 * under the items says what the two requests do, once, in the only place a coach meets them.
 */
function LeadMenu({
  contact,
  onRequest,
}: {
  contact: ContactRead;
  onRequest: (contact: ContactRead, kind: CoachLeadsRequestKind) => void;
}) {
  const name = displayName(contact.name);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={`More for ${name}`}
            className="grid size-[44px] shrink-0 place-items-center rounded-[10px] border border-[var(--line)] bg-[var(--control-fill)] text-[color:var(--body)]"
            type="button"
          />
        }
      >
        <MoreIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_CONTENT_CLASS}>
        <CoachScale>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            render={<Link href={conversationHref(contact.id)} />}
          >
            Open the conversation
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() => onRequest(contact, "duplicate")}
          >
            Report a duplicate
          </DropdownMenuItem>
          <DropdownMenuItem
            className={MENU_ITEM_CLASS}
            onClick={() => onRequest(contact, "deletion")}
          >
            Request deletion
          </DropdownMenuItem>
          <p className={`m-0 px-[14px] pt-[8px] pb-[10px] ${COACH_EYEBROW_CLASS}`}>{REQUEST_NOTE}</p>
        </CoachScale>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The non-drag equivalent of the board's drag gesture, as a full-width button on every card.
 *
 * Drag alone fails this audience and the accessibility floor both, so every move a pointer can
 * make by dragging is also one item in this menu. The stages a transition rule refuses are listed
 * and disabled with the reason attached, rather than dropped: a coach who cannot see "Call booked"
 * cannot tell a stage that does not apply from a stage the screen forgot.
 */
function MoveMenu({
  contact,
  evidence,
  evidenceChecked,
  onMove,
  pending,
}: {
  contact: ContactRead;
  evidence: AppointmentEvidenceByContact;
  evidenceChecked: boolean;
  onMove: (contact: ContactRead, stage: string) => void;
  pending: boolean;
}) {
  const targets = moveTargets(contact, { evidence, evidenceChecked });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            aria-label={`Move ${displayName(contact.name)} to another stage`}
            className="flex h-[44px] w-full items-center justify-center gap-[8px] rounded-[9px] border border-[var(--line)] bg-[var(--control-fill)] px-[14px] text-[15px] font-medium text-[color:var(--body)] disabled:opacity-60"
            disabled={pending}
            type="button"
          />
        }
      >
        {pending ? "Moving" : "Move to"}
        <ChevronIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className={MENU_CONTENT_CLASS}>
        <CoachScale>
          {targets.map((target) => (
            <DropdownMenuItem
              className={MENU_ITEM_CLASS}
              disabled={target.disabled}
              key={target.key}
              onClick={() => onMove(contact, target.key)}
            >
              {target.disabled ? `${target.label}, ${target.reason}` : target.label}
            </DropdownMenuItem>
          ))}
        </CoachScale>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function makeIdempotencyKey(contactId: string, stage: string) {
  const random = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  return `pipeline:${contactId}:${stage}:${random}`;
}

export function CoachLeads({
  appointmentEvidence,
  defaultView,
  impersonation = null,
  initialContacts,
  nowIso,
  writeEnabled = false,
}: CoachLeadsProps) {
  const query = useQueryState();
  const [contacts, setContacts] = useState(initialContacts);
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [notice, setNotice] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [request, setRequest] = useState<{ contact: ContactRead; kind: CoachLeadsRequestKind } | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const moveGenerationRef = useRef(new Map<string, symbol>());

  const view = coachLeadsView(query.get("view"), defaultView);
  const nowMs = Date.parse(nowIso);
  const evidence = useMemo<AppointmentEvidenceByContact>(
    () => appointmentEvidence ?? {},
    [appointmentEvidence],
  );
  const evidenceChecked = appointmentEvidence !== null;
  const canMove = writeEnabled && !impersonation;

  const visible = useMemo(
    () => filterLeads(contacts, {
      channels: [],
      outcomes: [],
      query: search,
      stages: stage ? [stage] : [],
    }),
    [contacts, search, stage],
  );
  const board = useMemo(() => leadBoard(visible), [visible]);
  const exportRows = useMemo(() => leadExportRows(visible), [visible]);
  const provenance = useMemo(() => leadsProvenance(contacts), [contacts]);

  /**
   * The one sentence about why a card cannot be moved, said in one place.
   *
   * The board this replaces stated the same fact four times in 160 vertical pixels. It is a fact
   * about the whole board rather than about any one lead, so it lives above the columns and the
   * cards simply do not draw a control they cannot honour.
   */
  const moveBlocked = !writeEnabled
    ? "Stage changes are not switched on in this environment, so no lead can be moved yet."
    : impersonation
      ? "You are viewing this workspace as support, so no lead can be moved from here."
      : null;

  async function moveLead(contact: ContactRead, target: string) {
    if (!canMove || pendingId) return;
    const previousStage = contact.pipelineStage;
    if (previousStage === target) return;

    const generation = Symbol(contact.id);
    moveGenerationRef.current.set(contact.id, generation);
    setPendingId(contact.id);
    setNotice("");
    setContacts((rows) => rows.map((row) => (
      row.id === contact.id ? { ...row, pipelineStage: target } : row
    )));

    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(contact.id)}/pipeline-stage`,
        {
          body: JSON.stringify({
            appointmentId: target === "booked" ? evidence[contact.id]?.appointmentId ?? null : null,
            expectedStage: previousStage,
            idempotencyKey: makeIdempotencyKey(contact.id, target),
            reason: null,
            stage: target,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      const payload: unknown = await response.json();
      // A receipt or nothing: an HTTP 200 with no audit row is not a recorded stage change, and
      // the release boundary in README.md is explicit that a 200 alone proves nothing.
      const audit = payload && typeof payload === "object" && "audit" in payload
        ? (payload as { audit?: { id?: unknown } }).audit
        : null;
      if (!response.ok || !audit || !Number.isSafeInteger(audit.id)) {
        throw new Error("The stage change was refused.");
      }
      setNotice(`${displayName(contact.name)} moved to ${stageLabel(target)}. Logged.`);
    } catch (error) {
      if (moveGenerationRef.current.get(contact.id) === generation) {
        setContacts((rows) => rows.map((row) => (
          row.id === contact.id ? { ...row, pipelineStage: previousStage } : row
        )));
      }
      const message = error instanceof Error ? error.message : "The stage change was refused.";
      setNotice(`${displayName(contact.name)} stayed in ${stageLabel(previousStage)}. ${message}`);
    } finally {
      if (moveGenerationRef.current.get(contact.id) === generation) {
        moveGenerationRef.current.delete(contact.id);
        setPendingId(null);
      }
    }
  }

  async function sendRequest() {
    if (!request || sending) return;
    const trimmed = note.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const response = await fetch(
        `/api/contacts/${encodeURIComponent(request.contact.id)}/support-request`,
        {
          body: JSON.stringify({ note: trimmed, type: request.kind }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );
      if (!response.ok) throw new Error("That request did not reach support. Try again.");
      // The one thing that happened, said once. Nothing on the lead changed and the words do not
      // suggest otherwise.
      setNotice("Sent to support.");
      setRequest(null);
      setNote("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That request did not reach support.");
    } finally {
      setSending(false);
    }
  }

  const page = visible.slice(0, shown);

  return (
    <div className="flex min-w-0 flex-col gap-[20px]">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-[20px]">
        <div className="min-w-0">
          <h1 className="coach-page-title m-0">Your leads</h1>
          {provenance ? (
            <p className={`m-0 mt-[8px] ${COACH_EYEBROW_CLASS}`} data-slot="leads-provenance">
              {provenance}
            </p>
          ) : null}
        </div>
        {/* Below sm the three controls reflow rather than wrap where they happen to run out of
            room, which stranded the eye alone on a second line with a gap beside it. `order`
            puts the eye next to the switch and pushes Export to a line of its own, where its
            full width is a deliberate row rather than a leftover. Above sm the order and the
            width both drop away and the row reads switch, Export, eye as the artboard draws it. */}
        <div className="flex w-full min-w-0 flex-wrap items-center gap-[12px] max-sm:justify-between sm:w-auto">
          <div
            aria-label="Leads view"
            className="flex shrink-0 gap-[4px] rounded-[12px] border border-[var(--line)] bg-[var(--well)] p-[4px] max-sm:order-1"
            role="group"
          >
            {([
              { key: "list", label: "List" },
              { key: "board", label: "Board" },
            ] as const).map((option) => {
              const active = view === option.key;
              return (
                <button
                  aria-pressed={active}
                  className={`h-[48px] rounded-[9px] border px-[18px] text-[16px] whitespace-nowrap ${
                    active
                      ? "border-[var(--accent-edge)] bg-[var(--accent-wash-strong)] font-semibold text-[color:var(--ink)]"
                      : "border-transparent bg-transparent font-medium text-[color:var(--muted)]"
                  }`}
                  data-view={option.key}
                  key={option.key}
                  onClick={() => query.set("view", option.key === defaultView ? null : option.key)}
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <ExportMenu
            className={`${CONTROL_CLASS} max-sm:order-3 max-sm:w-full`}
            filename="setterfi-coach-leads"
            label="Export"
            mode="local"
            rows={exportRows}
          />
          <ContextEye
            className="max-sm:order-2"
            copy={LEADS_EYE_COPY}
            placement="header"
            scale="coach"
            screen="coach-leads"
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-[16px]">
        {/* `basis-full` rather than `w-full`: this is a flex item, so the basis decides the main
            axis and a width of 100% beside a 260px basis is simply ignored. */}
        <div className="flex h-[48px] min-w-0 flex-grow basis-full items-center gap-[10px] rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[16px] sm:basis-[260px] sm:max-w-[460px]">
          <svg aria-hidden className="size-[18px] shrink-0 text-[color:var(--faint)]" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.75" viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            aria-label="Search leads"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] text-[color:var(--ink)] outline-none placeholder:text-[color:var(--faint)]"
            onChange={(event) => {
              setSearch(event.target.value);
              setShown(PAGE_SIZE);
            }}
            placeholder={LEAD_SEARCH_PLACEHOLDER}
            type="search"
            value={search}
          />
        </div>
        <Select
          onValueChange={(next) => {
            setStage(next === ALL_STAGES ? "" : String(next));
            setShown(PAGE_SIZE);
          }}
          value={stage || ALL_STAGES}
        >
          <SelectTrigger
            aria-label="Stage"
            className="h-[48px] shrink-0 gap-[12px] rounded-[9px] border-[var(--line-input)] bg-[var(--well)] px-[16px] text-[16px] text-[color:var(--ink)] max-sm:min-w-0 max-sm:flex-1"
          >
            <span className="text-[color:var(--muted)]">Stage</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start" alignItemWithTrigger={false}>
            <CoachScale>
              <SelectItem className="min-h-[44px] text-[16px]" value={ALL_STAGES}>
                All stages
              </SelectItem>
              {board.columns.map((column) => (
                <SelectItem className="min-h-[44px] text-[16px]" key={column.key} value={column.key}>
                  {column.label}
                </SelectItem>
              ))}
            </CoachScale>
          </SelectContent>
        </Select>
        <span className="ml-auto text-[16px] text-[color:var(--muted)]" data-slot="leads-count">
          {visible.length === contacts.length
            ? `${contacts.length} leads`
            : `${visible.length} of ${contacts.length} leads`}
        </span>
      </div>

      <p
        aria-live="polite"
        className={`m-0 min-h-[22px] ${COACH_EYEBROW_CLASS}`}
        data-slot="leads-notice"
      >
        {notice}
      </p>

      {view === "board" ? (
        <div className="min-w-0">
          {moveBlocked ? (
            <p
              className={`m-0 mb-[12px] ${COACH_EYEBROW_CLASS}`}
              data-slot="leads-move-blocked"
            >
              {moveBlocked}
            </p>
          ) : null}
          <div
            className="flex min-w-0 items-start gap-[16px] overflow-x-auto pb-[8px]"
            data-slot="leads-board"
          >
            {board.columns.map((column) => (
              <section
                aria-label={column.label}
                className="flex w-[300px] max-w-[86vw] shrink-0 flex-col gap-[12px]"
                data-board-column={column.key}
                key={column.key}
                onDragOver={(event) => {
                  if (!canMove || !dragging) return;
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  if (!canMove || !dragging) return;
                  event.preventDefault();
                  const moved = contacts.find((row) => row.id === dragging);
                  setDragging(null);
                  if (moved) void moveLead(moved, column.key);
                }}
              >
                <div className="flex min-h-[44px] items-center gap-[10px] px-[6px]">
                  <span
                    aria-hidden
                    className="size-[10px] shrink-0 rounded-full"
                    style={{ background: column.dot }}
                  />
                  <h2 className="m-0 min-w-0 truncate text-[18px] leading-[1.3] font-semibold text-[color:var(--ink)]">
                    {column.label}
                  </h2>
                  <span
                    className="ml-auto font-mono text-[17px] text-[color:var(--muted)] tabular-nums"
                    data-board-count={column.key}
                  >
                    {column.contacts.length}
                  </span>
                </div>
                <div className="flex max-h-[calc(100vh-320px)] min-h-0 flex-col gap-[12px] overflow-y-auto pr-[2px]">
                {column.contacts.length ? (
                  column.contacts.map((contact) => (
                    <article
                      className="flex flex-col gap-[10px] rounded-[16px_16px_13px_13px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] px-[16px] pt-[16px] pb-[12px] shadow-[var(--shadow-card)]"
                      data-lead-card={contact.id}
                      draggable={canMove}
                      key={contact.id}
                      onDragEnd={() => setDragging(null)}
                      onDragStart={() => setDragging(contact.id)}
                      style={{ opacity: dragging === contact.id ? 0.6 : 1 }}
                    >
                      <Link
                        className={`inline-flex min-h-[44px] items-center ${COACH_ROW_NAME_CLASS}`}
                        href={conversationHref(contact.id)}
                      >
                        {displayName(contact.name)}
                      </Link>
                      <div className="text-[15px] text-[color:var(--muted)]">
                        {`${channelLabel(contact)}, ${lastActivityLabel(contact, nowMs).toLocaleLowerCase()}`}
                      </div>
                      <p className="m-0 text-[16px] leading-[1.45] text-[color:var(--body)]">
                        {leadSentence(contact, evidence)}
                      </p>
                      <div>
                        <span className="inline-flex h-[32px] items-center gap-[8px] rounded-full border border-[var(--line)] bg-[var(--control-fill)] px-[12px] text-[15px] font-medium whitespace-nowrap text-[color:var(--muted)]">
                          <span
                            aria-hidden
                            className="size-[8px] shrink-0 rounded-full"
                            style={{
                              background: contact.outcome === "BOOK" ? "var(--good)" : "var(--faint)",
                            }}
                          />
                          {outcomeLabel(contact.outcome)}
                        </span>
                      </div>
                      {canMove ? (
                        <MoveMenu
                          contact={contact}
                          evidence={evidence}
                          evidenceChecked={evidenceChecked}
                          onMove={moveLead}
                          pending={pendingId === contact.id}
                        />
                      ) : null}
                    </article>
                  ))
                ) : (
                  <p className={`m-0 px-[6px] ${COACH_EYEBROW_CLASS}`}>No leads in this stage.</p>
                )}
                </div>
              </section>
            ))}
          </div>
          {board.unplaced.length ? (
            <p className={`m-0 mt-[12px] ${COACH_EYEBROW_CLASS}`} data-slot="leads-board-unplaced">
              {board.unplaced
                .map((entry) => `${entry.count} in ${entry.stage}, which has no column`)
                .join(". ")}
              .
            </p>
          ) : null}
        </div>
      ) : (
        <div className="min-w-0 overflow-hidden rounded-[24px_24px_17px_17px] border border-[var(--line)] bg-[linear-gradient(180deg,var(--card-top),var(--card))] shadow-[var(--shadow-card)]">
          <div className="min-w-0 overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left">
              <thead>
                <tr className="bg-[var(--band)]">
                  {["Name", "Channel", "Stage", "Last activity", "Outcome"].map((heading) => (
                    <th
                      className="px-[26px] py-[14px] text-[15px] font-semibold whitespace-nowrap text-[color:var(--muted)]"
                      key={heading}
                      scope="col"
                    >
                      {heading}
                    </th>
                  ))}
                  {/* `relative` is load-bearing: `sr-only` positions absolutely, and with no
                      positioned ancestor its containing block is the page itself, which pushed
                      the document's scroll width to 846px at a 390px viewport. */}
                  <th className="relative w-[60px] px-[26px] py-[14px]" scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.map((contact) => (
                  <tr className="border-t border-[var(--line-soft)]" data-lead-row={contact.id} key={contact.id}>
                    <td className="h-[48px] px-[26px]">
                      <Link
                        className={`inline-flex min-h-[48px] items-center ${COACH_ROW_NAME_CLASS}`}
                        href={conversationHref(contact.id)}
                      >
                        {displayName(contact.name)}
                      </Link>
                    </td>
                    <td className={`${CELL_CLASS} whitespace-nowrap text-[color:var(--body)]`}>
                      {channelLabel(contact)}
                    </td>
                    <td className={`${CELL_CLASS} whitespace-nowrap`}>
                      <StageWord stage={contact.pipelineStage} />
                    </td>
                    <td className={`${CELL_CLASS} whitespace-nowrap text-[color:var(--muted)]`}>
                      {lastActivityLabel(contact, nowMs)}
                    </td>
                    <td className={`${CELL_CLASS} text-[color:var(--body)]`}>
                      {outcomeLabel(contact.outcome)}
                    </td>
                    <td className="py-[6px] pr-[16px] pl-0">
                      <div className="flex justify-end">
                        <LeadMenu contact={contact} onRequest={(row, kind) => {
                          setNote("");
                          setRequest({ contact: row, kind });
                        }} />
                      </div>
                    </td>
                  </tr>
                ))}
                {page.length === 0 ? (
                  <tr>
                    <td className="px-[26px] py-[24px] text-[16px] text-[color:var(--muted)]" colSpan={6}>
                      {contacts.length
                        ? "No lead matches that search."
                        : "Nobody has messaged you yet."}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {page.length ? (
            <div className="flex flex-wrap items-center justify-between gap-[12px] border-t border-[var(--line-soft)] px-[26px] py-[16px]">
              <span className={COACH_EYEBROW_CLASS} data-slot="leads-page-note">
                {`Showing ${page.length} of ${visible.length}, newest activity first.`}
              </span>
              {page.length < visible.length ? (
                <button
                  className={CONTROL_CLASS}
                  onClick={() => setShown((current) => current + PAGE_SIZE)}
                  type="button"
                >
                  More leads
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      <Dialog
        onOpenChange={(open) => {
          if (!open) setRequest(null);
        }}
        open={request !== null}
      >
        <DialogContent className="sm:max-w-[520px]" showCloseButton={false}>
          <CoachScale>
            {/* The request dialog is a bandless surface with no eyebrow over it, which is the role
                `COACH_SURFACE_TITLE_CLASS` names. Cited rather than respelled: the constant carries
                the `-0.015em` this heading had lost, and it is safe inside a portal because that
                one keeps its size as a literal instead of a `--coach-*` token. */}
            <DialogTitle className={COACH_SURFACE_TITLE_CLASS}>
              {request?.kind === "deletion" ? "Request deletion" : "Report a duplicate"}
            </DialogTitle>
            <DialogDescription className="mt-[8px] text-[16px] leading-[1.5] text-[color:var(--muted)]">
              {`This opens a message to support about ${displayName(request?.contact.name ?? "this lead")}. Nothing on the lead changes.`}
            </DialogDescription>
            <label className="mt-[20px] block text-[16px] text-[color:var(--muted)]" htmlFor="lead-request-note">
              What should support know?
            </label>
            <textarea
              className="mt-[8px] min-h-[112px] w-full rounded-[9px] border border-[var(--line-input)] bg-[var(--well)] px-[14px] py-[12px] text-[16px] leading-[1.5] text-[color:var(--ink)] outline-none"
              id="lead-request-note"
              onChange={(event) => setNote(event.target.value)}
              value={note}
            />
            <div className="mt-[20px] flex flex-wrap justify-end gap-[12px]">
              <DialogClose
                render={
                  <button className={CONTROL_CLASS} type="button">
                    Cancel
                  </button>
                }
              />
              <button
                className={CONTROL_CLASS}
                disabled={sending || !note.trim()}
                onClick={() => void sendRequest()}
                type="button"
              >
                {sending ? "Sending" : "Send to support"}
              </button>
            </div>
          </CoachScale>
        </DialogContent>
      </Dialog>
    </div>
  );
}
