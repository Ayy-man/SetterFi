/**
 * Everything the Leads screen decides that is not a rendering decision.
 *
 * This module carries no directive on purpose. Both coach routes are server components and both
 * hand the screen a `defaultView`, so the two sides share the view vocabulary; a value imported
 * out of a `"use client"` module reaches a server page as a client reference and throws there,
 * which is the trap `src/app/server-client-boundary.test.ts` exists for and which has now shipped
 * four times in this repo. The rest of the file lives here for a duller reason: a pure function
 * over `ContactRead` is testable without a DOM, and the screen is easier to read when the only
 * thing left in it is markup.
 */

import { OUTCOME_LABELS, STAGE_LABELS } from "@/components/workspace/live/lead-search";
import type { ContactRead } from "@/lib/repositories/contacts";

/**
 * The two views, as the search parameter spells them.
 *
 * `/coach/contacts` opens the list and `/coach/pipelines` opens the board, and after that the
 * switch writes `?view=` on whichever route the coach happens to be standing on. Both routes
 * render this one screen, so the parameter is the only thing that decides which half is drawn.
 */
export const COACH_LEADS_VIEWS = ["list", "board"] as const;

export type CoachLeadsView = (typeof COACH_LEADS_VIEWS)[number];

/** The view a `?view=` value names, or the one the route opened on. */
export function coachLeadsView(
  value: string | null | undefined,
  fallback: CoachLeadsView,
): CoachLeadsView {
  return COACH_LEADS_VIEWS.includes(value as CoachLeadsView) ? (value as CoachLeadsView) : fallback;
}

export type LeadAppointmentEvidence = {
  appointmentId: string;
  startAt: string;
  status: string;
};

/**
 * The latest appointment per lead. `null` in the props means the read itself failed, which is a
 * different claim from `{}`, where the read ran and found nothing.
 */
export type AppointmentEvidenceByContact = Record<string, LeadAppointmentEvidence | undefined>;

/** The setter's next scheduled touch per lead, as an ISO instant. `null` means the read failed. */
export type NextSetterTouchByContact = Readonly<Record<string, string>>;

/**
 * The board's columns, one per stage this build actually stores.
 *
 * `LeadsBoard.dc.html` draws five columns and this build stores seven, and the collapse is the one
 * thing the artboard asks for that is refused here. `lead-search.ts` records the reasoning beside
 * the stage words themselves: "No show" and "Disqualified" would both land under the artboard's
 * "Not a fit", and a coach who cannot tell the lead who never turned up from the lead who was
 * turned away has lost the distinction they would act on. Every column is therefore backed by a
 * real stage key, one to one, and the board scrolls sideways rather than dropping two of them.
 *
 * **The dots.** Amber is spent only where the lead is the coach's to act on, which is a stage the
 * setter has stopped working. "Call booked" is green because a booking is something the server
 * recorded rather than something anyone is still waiting for. Everything else that is merely
 * pending reads `--muted`: a second persistent colour standing beside amber means neither of them
 * says anything.
 */
export const LEAD_BOARD_COLUMNS = [
  { dot: "var(--accent)", key: "new_lead" },
  { dot: "var(--warning)", key: "qualifying" },
  { dot: "var(--good)", key: "booked" },
  { dot: "var(--muted)", key: "long_term_followup" },
  { dot: "var(--warning)", key: "no_show" },
  { dot: "var(--muted)", key: "qualified_no_buy" },
  { dot: "var(--muted)", key: "disqualified" },
] as const;

/** The stage words are `lead-search.ts`'s, so this screen and the Inbox cannot drift apart. */
export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

/** The dot beside a stage word, `--faint` for a stage this build has no column for. */
export function stageDot(stage: string): string {
  return LEAD_BOARD_COLUMNS.find((column) => column.key === stage)?.dot ?? "var(--faint)";
}

/**
 * What the agent decided about a lead, in words, with the absence stated rather than blanked.
 *
 * `outcome` is null for every lead the agent is still working, which is most of them on a live
 * tenant. An empty cell there reads as a failed render; "No decision yet" reads as the fact it is.
 */
export function outcomeLabel(outcome: string | null): string {
  if (outcome === null) return "No decision yet";
  return OUTCOME_LABELS[outcome] ?? outcome;
}

export type LeadBoardColumn = {
  key: string;
  label: string;
  dot: string;
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
      label: stageLabel(column.key),
    })),
    unplaced: Array.from(unplaced.entries())
      .map(([stage, count]) => ({ count, stage }))
      .sort((left, right) => left.stage.localeCompare(right.stage)),
  };
}

const CHANNEL_LABELS: Record<string, string> = {
  instagram: "Instagram",
  messenger: "Messenger",
  sms: "Text message",
  webchat: "Web chat",
  whatsapp: "WhatsApp",
};

/** The channel a lead arrived on, or the stated absence of one. */
export function channelLabel(contact: ContactRead): string {
  const first = contact.channels[0]?.channel;
  if (!first) return "No channel recorded";
  return CHANNEL_LABELS[first] ?? first;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * How long ago something happened, in the words the artboard uses.
 *
 * Null when either instant fails to parse or the activity is in the future, because "in 3 hours"
 * on a last-activity column is a clock disagreement rather than a fact about the lead, and the
 * caller says so in its own words instead.
 */
export function relativeAge(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then) || !Number.isFinite(nowMs) || then > nowMs) return null;
  const elapsed = nowMs - then;
  if (elapsed < MINUTE) return "Just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  }
  const days = Math.floor(elapsed / DAY);
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

/** The last-activity cell, with a failed or future reading named rather than drawn as a date. */
export function lastActivityLabel(contact: ContactRead, nowMs: number): string {
  return relativeAge(contact.lastActivityAt, nowMs) ?? "No activity recorded";
}

/** One format for every date this screen prints, so two cards cannot spell a day two ways. */
export const boardDateFormat = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: "UTC",
});

/**
 * The one sentence on a board card, composed only from fields the page already loaded.
 *
 * The artboard writes prose here ("Wants $40,000 to expand a trucking route"), and nothing in this
 * build stores why a lead wants the money. What it stores is the funding goal, the credit range
 * and the appointment, so the sentence is built from those and stops. Where the agent captured
 * nothing yet, the sentence says that, because a blank line under a name reads as a broken card.
 */
export function leadSentence(
  contact: ContactRead,
  evidence: AppointmentEvidenceByContact,
): string {
  const appointment = evidence[contact.id];
  if (contact.pipelineStage === "booked" && appointment) {
    const when = new Date(appointment.startAt);
    if (!Number.isNaN(when.getTime())) {
      return `On your calendar for ${boardDateFormat.format(when)}.`;
    }
  }
  const parts: string[] = [];
  if (contact.goal) parts.push(`Wants ${contact.goal}`);
  if (contact.credit) parts.push(`credit ${contact.credit}`);
  if (!parts.length && contact.timeline) parts.push(`Timeline ${contact.timeline}`);
  if (!parts.length) return "Your agent has not captured anything yet.";
  return `${parts.join(", ")}.`;
}

/**
 * The stages a lead can be moved into from where it is, with the refusals kept rather than hidden.
 *
 * `src/lib/pipeline/transitions.ts` refuses a move to "Call booked" without an appointment on file
 * and a move to "No show" unless the latest appointment is recorded as one. A menu that silently
 * dropped those two would leave a coach unable to tell a stage that does not apply from a stage
 * the screen forgot, so both are listed and both carry the reason they cannot be picked.
 */
export type MoveTarget = {
  key: string;
  label: string;
  disabled: boolean;
  /** Present only when `disabled`, and it is the whole explanation. */
  reason?: string;
};

export function moveTargets(
  contact: ContactRead,
  input: { evidence: AppointmentEvidenceByContact; evidenceChecked: boolean },
): MoveTarget[] {
  const appointment = input.evidence[contact.id] ?? null;
  return LEAD_BOARD_COLUMNS.filter((column) => column.key !== contact.pipelineStage).map(
    (column) => {
      const label = stageLabel(column.key);
      if (!input.evidenceChecked && (column.key === "booked" || column.key === "no_show")) {
        return {
          disabled: true,
          key: column.key,
          label,
          reason: "the appointment read failed, so reload before moving anyone here",
        };
      }
      if (column.key === "booked" && !appointment) {
        return {
          disabled: true,
          key: column.key,
          label,
          reason: "there is no booking on the calendar for this lead",
        };
      }
      if (column.key === "no_show" && appointment?.status !== "no_show") {
        return {
          disabled: true,
          key: column.key,
          label,
          reason: "the latest appointment is not recorded as a no show",
        };
      }
      return { disabled: false, key: column.key, label };
    },
  );
}

/**
 * The rows both exports carry. The keys are machine-readable and deliberately do not follow the
 * words on screen: an export is read by a spreadsheet and by someone chasing a specific record,
 * and renaming a column because a heading changed breaks every saved formula pointed at it.
 */
export function leadExportRows(contacts: readonly ContactRead[]): Record<string, unknown>[] {
  return contacts.map((contact) => ({
    contactId: contact.id,
    name: contact.name,
    channels: contact.channels.map((channel) => ({
      address: channel.address,
      channel: channel.channel,
    })),
    creditRange: contact.credit,
    fundingGoal: contact.goal,
    timeline: contact.timeline,
    decision: contact.outcome,
    pipelineStage: contact.pipelineStage,
    optedOut: contact.optedOut ?? false,
    timezone: contact.timezone ?? null,
    lastActivity: contact.lastActivityAt,
    demoData: contact.isDemo,
    testData: contact.isTest,
  }));
}

/**
 * The provenance sentence for the whole screen, or null when the rows do not agree on one.
 *
 * Stated once, in words, rather than as a marker repeated down a column. The seeders staple
 * `(demo)` onto every name they write and `displayName` strips it where a human reads a name, so
 * something has to carry the fact and this is it. Mixed rows get no sentence: "demo" and "test"
 * are not synonyms and picking either word would state something false about half the leads.
 */
export function leadsProvenance(contacts: readonly ContactRead[]): string | null {
  if (!contacts.length) return null;
  if (contacts.every((contact) => contact.isDemo)) {
    return "Demo leads, excluded from your analytics.";
  }
  if (contacts.every((contact) => contact.isTest)) {
    return "Test leads, excluded from your analytics.";
  }
  return null;
}
