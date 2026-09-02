"use client";

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CollapsedSettingCard,
  Figure,
  Prose,
  SettingGroup,
  SettingRow,
  StatusDot,
  Surface,
  type Tone,
} from "@/components/kit/atomics";
import { Callout } from "@/components/kit/callout";
import { ChatIcon, FacebookLogo, InstagramLogo, Phone } from "@/components/kit/icons";
import type { KanbanCardFlag } from "@/components/kit/kanban-card";
import {
  KanbanBoard,
  type KanbanCardData,
  type KanbanColumn,
  type Result,
} from "@/components/kit/kanban-board";
import { StateBadge } from "@/components/kit/state-badge";
import {
  COACH_EYEBROW_CLASS,
  COACH_READING_CLASS,
} from "@/components/workspace/live/coach-type";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";
import {
  evaluateStageChange,
  PIPELINE_STAGES,
  type PipelineStage,
} from "@/lib/pipeline/transitions";
import type { ContactRead } from "@/lib/repositories/contacts";
import { STAGE_LABELS } from "@/components/workspace/live/lead-search";

export type PipelineAppointmentEvidence = {
  appointmentId: string;
  startAt: string;
  status: string;
};

export type AppointmentEvidenceByContact = Record<
  string,
  PipelineAppointmentEvidence | undefined
>;

/*
 * The stage words are `lead-search.ts`'s, imported rather than re-declared here -- see the note
 * beside the map for why the artboard's plainer names were taken for two stages and refused for
 * the collapse from seven to five. This module keeps the tones, which are its own concern.
 */

const STAGE_TONES: Record<PipelineStage, KanbanColumn["tone"]> = {
  // Artifact colour budget: only won and lost stages carry a coloured dot; the rest stay neutral.
  new_lead: "neutral",
  qualifying: "neutral",
  booked: "good",
  qualified_no_buy: "critical",
  long_term_followup: "neutral",
  no_show: "neutral",
  disqualified: "critical",
};

/**
 * Where the board spends and withholds colour, which `LeadsBoard.dc.html` does not do by tone.
 *
 * Call booked takes the accent -- the dot, the column's border and tint, and its count pill -- and
 * it is the only column on the board that does, because it is the outcome the whole surface is
 * for. Both lost stages drop to `--faint` with their names in `--muted` rather than to the
 * critical red they carried: a disqualified lead is finished, not broken, and two red columns on a
 * seven-column board read as an alarm about the coach's own pipeline. Everything else stays
 * neutral, which is the colour budget the deck is built on.
 */
const STAGE_EMPHASIS: Partial<Record<PipelineStage, KanbanColumn["emphasis"]>> = {
  booked: "accent",
  qualified_no_buy: "quiet",
  disqualified: "quiet",
};

/**
 * What actually moves a lead into each stage.
 *
 * Every sentence here is the rule `src/lib/pipeline/transitions.ts` enforces, or the plain
 * description of a stage the agent sets itself. Nothing on this list is a control, because there
 * is no per-tenant stage storage behind one: the stages and their rules are SetterFi's, and a
 * settled decision reads as decided when it is a sentence rather than a disabled input.
 */
const STAGE_RULES: Record<PipelineStage, string> = {
  new_lead: "Where every lead starts. The agent sets this itself when a conversation opens.",
  qualifying: "The agent is working through the qualifying questions with the lead.",
  booked: "Accepted only when an appointment receipt exists for the lead in Calendar.",
  qualified_no_buy: "A lost outcome: the lead qualified and did not book.",
  long_term_followup: "Parked for later. The conversation stays open, and the agent keeps it warm.",
  no_show: "Accepted only when the lead's latest appointment is recorded as a no show.",
  disqualified: "A lost outcome: the lead does not meet the current qualification rules.",
};

/**
 * The colour budget on this surface, unchanged: a bare dot beside the stage's full name, and the
 * dot is coloured only on the won stage and the two lost ones. The name carries the meaning.
 */
const STAGE_DOT_TONES: Record<PipelineStage, Tone> = {
  new_lead: "neutral",
  qualifying: "neutral",
  booked: "good",
  qualified_no_buy: "failure",
  long_term_followup: "neutral",
  no_show: "neutral",
  disqualified: "failure",
};

function isPipelineStage(value: string): value is PipelineStage {
  return PIPELINE_STAGES.some((stage) => stage === value);
}

export function allowedMoves(
  stage: string,
): readonly PipelineStage[] {
  if (!isPipelineStage(stage)) return [];

  return PIPELINE_STAGES.filter((target) => {
    const relevantEvidence = target === "booked"
      ? { appointmentId: "required", startAt: "required", status: "scheduled" }
      : target === "no_show"
        ? { appointmentId: "required", startAt: "required", status: "no_show" }
        : null;
    return evaluateStageChange({
      appointmentEvidence: relevantEvidence,
      currentSetBy: "user",
      from: stage,
      setBy: "user",
      to: target,
    }).allowed;
  });
}

function channelLabel(channel: ContactRead["channels"][number]["channel"] | undefined) {
  if (!channel) return "No channel";
  if (channel === "sms") return "Text messages (SMS)";
  if (channel === "messenger") return "Facebook Messenger";
  if (channel === "webchat") return "Web chat";
  return channel.charAt(0).toLocaleUpperCase() + channel.slice(1);
}

/**
 * The glyph the board's meta line opens with, for the channel the lead arrived on.
 *
 * Decorative, and the card's own markup hides it: the channel's name is printed beside it, so the
 * icon adds recognition at a glance rather than information. A channel with no glyph of its own,
 * and a lead with no saved channel, get the neutral chat mark rather than nothing, so the meta
 * line keeps one shape down the column.
 */
function channelIcon(channel: ContactRead["channels"][number]["channel"] | undefined) {
  const className = "size-[15px] shrink-0";
  if (channel === "instagram") return <InstagramLogo className={className} />;
  if (channel === "messenger") return <FacebookLogo className={className} />;
  if (channel === "sms") return <Phone className={className} />;
  return <ChatIcon className={className} />;
}

function displayDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Activity time not recorded" : workspaceDateTimeFormat.format(date);
}

const OPEN_STAGES: readonly PipelineStage[] = [
  "new_lead",
  "qualifying",
  "long_term_followup",
  "no_show",
];

/** A lead with no activity for this long in an open stage is stalled, not simply new. */
const STALLED_AFTER_DAYS = 5;

const DAY_MS = 86_400_000;

function daysSince(value: string) {
  const moment = new Date(value).getTime();
  if (Number.isNaN(moment)) return null;
  return Math.floor((Date.now() - moment) / DAY_MS);
}

/**
 * Every card says why it sits in its stage. The sentence is read off the row, never invented: an
 * appointment receipt, a recorded decision, or the qualification answers the lead actually gave.
 */
function cardReason(
  contact: ContactRead,
  appointmentEvidence: AppointmentEvidenceByContact,
) {
  const appointment = appointmentEvidence[contact.id];
  if (appointment && (contact.pipelineStage === "booked" || contact.pipelineStage === "no_show")) {
    return `${displayDate(appointment.startAt)} appointment`;
  }
  if (contact.outcome === "HARD_DQ") return "The lead did not meet the current qualification rules.";
  if (contact.outcome === "SOFT_DQ") return "The lead may be a better fit later.";
  if (contact.pipelineStage === "qualified_no_buy") return "Qualified, but did not book.";

  const answers = [
    contact.goal ? `${contact.goal} goal` : null,
    contact.credit ? `${contact.credit} credit` : null,
    contact.timeline,
  ].filter((entry): entry is string => Boolean(entry));
  if (answers.length) return answers.join(" · ");

  if (contact.outcome === "BOOK") return "The agent qualified this lead to book.";
  return undefined;
}

/**
 * Quiet by default: only a card that wants the coach carries a flag, so the flags that do appear
 * are worth scanning for.
 */
function cardFlag(contact: ContactRead, pending: boolean): KanbanCardFlag | undefined {
  if (pending) return { label: "Saving", tone: "warning" };
  if (contact.optedOut) return { label: "Opted out", tone: "critical" };
  if (contact.outcome === "BOOK" && contact.pipelineStage !== "booked") {
    return { label: "Needs you", tone: "critical" };
  }

  const stalledDays = OPEN_STAGES.some((stage) => stage === contact.pipelineStage)
    ? daysSince(contact.lastActivityAt)
    : null;
  if (stalledDays !== null && stalledDays >= STALLED_AFTER_DAYS) {
    return { label: `Stalled ${stalledDays}d`, tone: "warning" };
  }

  return undefined;
}

/**
 * The stage rules, collapsed.
 *
 * 1k draws this as a stage editor with a rule per row; there is no per-tenant stage storage
 * behind it, so what ships is the same list stating the rules rather than offering to change
 * them. It opens on a deliberate act, which keeps the board -- the thing the coach came for --
 * the loudest thing on the page.
 */
function StageRules() {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-[var(--s-4)] min-w-0">
      <CollapsedSettingCard
        description="Every stage and the rule that moves a lead into it. The agent moves leads by rule. Move one by hand and the agent leaves it where you put it, except into Booked once a receipt arrives."
        expanded={expanded}
        onToggle={() => setExpanded((open) => !open)}
        summary={`${PIPELINE_STAGES.length} stages`}
        title="How a lead changes stage"
      />
      {expanded ? (
        <SettingGroup className="mt-[var(--s-2)]">
          {PIPELINE_STAGES.map((stage) => (
            <SettingRow
              description={STAGE_RULES[stage]}
              key={stage}
              title={(
                <span className="inline-flex items-center gap-[7px]">
                  <StatusDot size={6} tone={STAGE_DOT_TONES[stage]} />
                  {STAGE_LABELS[stage]}
                </span>
              )}
            />
          ))}
        </SettingGroup>
      ) : null}
    </div>
  );
}

/**
 * Why Move to is off, said on the board rather than left to a disabled button.
 *
 * A control that is grey and silent reads as broken. Both sentences name the state and then say
 * what did not happen, because the coach's next question after "why can I not move this" is
 * "did something happen anyway".
 */
const MOVES_OFF_COPY = {
  impersonated: {
    body: "This impersonated view is read only, so Move to is off on every card. Nothing has changed stage, and no lead was messaged.",
    title: "Stage changes off in this view",
  },
  released: {
    body: "Stage changes are not switched on in this environment, so Move to is off on every card. Nothing has changed stage, and no lead was messaged.",
    title: "Stage changes not switched on",
  },
} as const;

export function CoachPipeline({
  appointmentEvidence,
  canMove,
  contacts,
  onMove,
  onOpen,
  pendingIds,
  writeEnabled = canMove,
}: {
  appointmentEvidence: AppointmentEvidenceByContact;
  canMove: boolean;
  contacts: readonly ContactRead[];
  onMove: (cardId: string, to: string) => Promise<Result>;
  onOpen: (cardId: string) => void;
  pendingIds: ReadonlySet<string>;
  /**
   * Whether the stage-move verb is released at all. `canMove` also goes false for an impersonated
   * view, and the two off-states get different sentences, so the board needs both facts.
   */
  writeEnabled?: boolean;
}) {
  const boardRootRef = useRef<HTMLDivElement>(null);
  const previousRectsRef = useRef(new Map<string, DOMRect>());
  const [lifted, setLifted] = useState<{ cardId: string; target: PipelineStage } | null>(null);
  const [dragAnnouncement, setDragAnnouncement] = useState("");
  const columns = useMemo<readonly KanbanColumn[]>(
    () => PIPELINE_STAGES.map((stage) => ({
      count: contacts.filter((contact) => contact.pipelineStage === stage).length,
      key: stage,
      emphasis: STAGE_EMPHASIS[stage],
      label: STAGE_LABELS[stage],
      tone: STAGE_TONES[stage],
    })),
    [contacts],
  );

  const cards = useMemo<readonly KanbanCardData[]>(
    () => contacts.flatMap((contact) => {
      if (!isPipelineStage(contact.pipelineStage)) return [];
      return [{
        flag: cardFlag(contact, pendingIds.has(contact.id)),
        id: contact.id,
        meta: [
          channelLabel(contact.channels.at(0)?.channel),
          displayDate(contact.lastActivityAt),
        ],
        metaIcon: channelIcon(contact.channels.at(0)?.channel),
        name: contact.name,
        reason: cardReason(contact, appointmentEvidence),
        stage: contact.pipelineStage,
      }];
    }),
    [appointmentEvidence, contacts, pendingIds],
  );

  const pendingCount = pendingIds.size;
  const appointmentReceiptCount = contacts.filter(
    (contact) => Boolean(appointmentEvidence[contact.id]),
  ).length;
  useLayoutEffect(() => {
    const root = boardRootRef.current;
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-kanban-card]"));
    const nextRects = new Map<string, DOMRect>();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    nodes.forEach((node) => {
      const cardId = node.dataset.cardId;
      if (!cardId) return;
      node.setAttribute("aria-grabbed", String(lifted?.cardId === cardId));
      const moveButton = node.querySelector<HTMLButtonElement>('button[aria-label^="Move "]');
      if (moveButton) moveButton.disabled = !canMove || pendingCount > 0;

      const nextRect = node.getBoundingClientRect();
      nextRects.set(cardId, nextRect);
      const previousRect = previousRectsRef.current.get(cardId);
      if (!previousRect || reduceMotion) return;
      const deltaX = previousRect.left - nextRect.left;
      const deltaY = previousRect.top - nextRect.top;
      if (deltaX === 0 && deltaY === 0) return;

      node.style.transition = "none";
      node.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      node.getBoundingClientRect();
      requestAnimationFrame(() => {
        node.style.transition = "transform var(--duration-fast) var(--ease-smooth-out)";
        node.style.transform = "translate(0, 0)";
      });
    });

    previousRectsRef.current = nextRects;
  }, [canMove, cards, lifted, pendingCount]);

  function canMoveCardTo(cardId: string, target: string) {
    const contact = contacts.find((candidate) => candidate.id === cardId);
    return Boolean(contact && !pendingIds.has(cardId) && allowedMoves(contact.pipelineStage).includes(
      target as PipelineStage,
    ));
  }

  async function moveWithFlip(cardId: string, target: string) {
    if (pendingCount > 0 || !canMoveCardTo(cardId, target)) {
      return { message: "Wait for the current stage change to finish.", ok: false } as const;
    }
    return onMove(cardId, target);
  }

  function openBookedFlow(event: ReactMouseEvent<HTMLDivElement>) {
    const menuItem = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[role="menuitem"]')
      : null;
    if (menuItem?.textContent?.trim() !== STAGE_LABELS.booked) return;
    const trigger = boardRootRef.current?.querySelector<HTMLButtonElement>(
      'button[aria-expanded="true"][aria-label^="Move "]',
    );
    const cardId = trigger?.closest<HTMLElement>("[data-kanban-card]")?.dataset.cardId;
    if (!trigger || !cardId || !canMoveCardTo(cardId, "booked")) return;

    event.preventDefault();
    event.stopPropagation();
    trigger.click();
    void moveWithFlip(cardId, "booked");
  }

  function handleKeyboardDrag(event: ReactKeyboardEvent<HTMLDivElement>) {
    const card = event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>("[data-kanban-card]")
      : null;
    if (!card || event.target !== card || !canMove) return;
    const cardId = card.dataset.cardId;
    const contact = contacts.find((candidate) => candidate.id === cardId);
    if (!cardId || !contact || !isPipelineStage(contact.pipelineStage)) return;

    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
      event.stopPropagation();
      if (!lifted || lifted.cardId !== cardId) {
        setLifted({ cardId, target: contact.pipelineStage });
        setDragAnnouncement(`${contact.name} lifted. Use left and right arrows to choose a stage.`);
      } else if (lifted.target === contact.pipelineStage) {
        setLifted(null);
        setDragAnnouncement(`${contact.name} returned to ${STAGE_LABELS[contact.pipelineStage]}.`);
      } else {
        const target = lifted.target;
        setLifted(null);
        setDragAnnouncement(`${contact.name} moving to ${STAGE_LABELS[target]}.`);
        void moveWithFlip(cardId, target);
      }
      return;
    }

    if (event.key === "Escape" && lifted?.cardId === cardId) {
      event.preventDefault();
      event.stopPropagation();
      setLifted(null);
      setDragAnnouncement(`${contact.name} returned to ${STAGE_LABELS[contact.pipelineStage]}.`);
      return;
    }

    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && lifted?.cardId === cardId) {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      let index = PIPELINE_STAGES.indexOf(lifted.target) + direction;
      const permitted = allowedMoves(contact.pipelineStage);
      while (index >= 0 && index < PIPELINE_STAGES.length) {
        const candidate = PIPELINE_STAGES[index];
        if (candidate === contact.pipelineStage || permitted.includes(candidate)) {
          setLifted({ cardId, target: candidate });
          setDragAnnouncement(`${contact.name}, target ${STAGE_LABELS[candidate]}.`);
          break;
        }
        index += direction;
      }
    }
  }

  return (
    <div
      aria-busy={pendingCount > 0}
      data-filtered-count={contacts.length}
      data-leads-view="board"
      onClickCapture={openBookedFlow}
      onKeyDownCapture={handleKeyboardDrag}
      ref={boardRootRef}
    >
      {canMove ? null : (
        <Callout
          body={MOVES_OFF_COPY[writeEnabled ? "impersonated" : "released"].body}
          className="mb-[var(--s-4)]"
          title={MOVES_OFF_COPY[writeEnabled ? "impersonated" : "released"].title}
          tone="warning"
        />
      )}
      <p aria-live="polite" className="sr-only">{dragAnnouncement}</p>
      <KanbanBoard
        allowedMoves={allowedMoves}
        cards={cards}
        columns={columns}
        onMove={canMove && pendingCount === 0 ? moveWithFlip : undefined}
        onOpen={onOpen}
      />
      {/*
        Everything from here down explains the board rather than being it.

        The stage rules and the managed-by-SetterFi strip used to sit above the board, which put
        two blocks of explanation between the page header and the thing a coach opened Leads to
        look at. Both are still here in full -- the rule per stage, what Won and Lost map to, and
        the receipt count -- they are just after the board now, where reference material belongs.
        The one thing that stays above it is the notice saying moves are off, because that one is
        about the board rather than about the pipeline, and a coach who cannot drag needs to know
        before they try rather than after they scroll.

        The per-card "Saving" flag is unaffected by the move: it is drawn on the card itself, so
        the feedback during a stage change is still where the coach is looking.
      */}
      <StageRules />
      {/* What SetterFi runs sits on the strip: the quietest surface in the system, flatter than a
          card and carrying no accent. The one figure on it is a count, so it is mono, and it is
          counted from the receipts this board actually holds. */}
      <Surface
        className="mt-[var(--s-4)] flex min-w-0 flex-wrap items-center justify-between gap-x-[var(--s-4)] gap-y-[var(--s-3)]"
        variant="strip"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
          {/* The eyebrow was an `Overline`: 9.5px mono uppercase on `--overline`. A coach reading
              this strip is being told which parts of the board are not theirs to change, which
              makes it the last label in the product that should be set in the smallest type the
              product has. Sentence case at 12px, the same treatment the deck panel's own eyebrow
              wears, so the two surfaces name a category the same way. */}
          <p className={`m-0 block ${COACH_EYEBROW_CLASS}`}>Managed by SetterFi</p>
          <Prose className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            Won is Booked. Lost is Qualified, no buy and Disqualified. A move into Booked is
            accepted only against an appointment receipt.
          </Prose>
          <Prose className={`m-0 ${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            <Figure size="md">{appointmentReceiptCount}</Figure>
            {appointmentReceiptCount === 1
              ? " lead on this board has an appointment receipt."
              : " leads on this board have appointment receipts."}
          </Prose>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-[var(--s-2)]">
          {pendingCount > 0 ? (
            <StateBadge
              detail={`${pendingCount}`}
              kind="tag"
              label="Saving"
              tone="warning"
            />
          ) : null}
        </div>
      </Surface>
    </div>
  );
}
