import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PIPELINE_STAGES } from "@/lib/pipeline/transitions";
import { describe, expect, it, vi } from "vitest";

import {
  allowedMoves,
  CoachPipeline,
  type PipelineAppointmentEvidence,
} from "@/components/workspace/live/coach-pipeline";
import type { ContactRead } from "@/lib/repositories/contacts";

const evidence: PipelineAppointmentEvidence = {
  appointmentId: "appointment-1",
  startAt: "2026-08-28T14:00:00.000Z",
  status: "scheduled",
};

const contact: ContactRead = {
  channels: [{ address: "lead-1", channel: "instagram" }],
  credit: "680 to 719",
  goal: "$50,000",
  id: "lead-1",
  isDemo: false,
  isTest: false,
  lastActivityAt: "2026-08-24T09:00:00.000Z",
  name: "Avery Stone",
  outcome: null,
  pipelineStage: "new_lead",
  timeline: "This month",
};

const labels = {
  booked: "Call booked",
  disqualified: "Disqualified or bad fit (lost)",
  long_term_followup: "Long-term follow-up",
  no_show: "No show",
  qualified_no_buy: "Qualified, no buy (lost)",
  qualifying: "Still talking",
} as const;

describe("CoachPipeline", () => {
  it("lists exactly the transition targets allowed for the card stage", async () => {
    render(
      <CoachPipeline
        appointmentEvidence={{ [contact.id]: evidence }}
        canMove
        contacts={[contact]}
        onMove={vi.fn(async () => ({
          ok: true as const,
          receipt: { actionKey: "contact.pipeline_stage.set" as const, auditId: 42 },
        }))}
        onOpen={vi.fn()}
        pendingIds={new Set()}
      />,
    );

    const card = screen.getByRole("group", { name: `Open ${contact.name}` });
    card.focus();
    fireEvent.keyDown(card, { key: "m" });

    const expected = allowedMoves(contact.pipelineStage).map((stage) => labels[stage as keyof typeof labels]);
    // The menu element arrives before its items do -- Base UI mounts the popup, then fills it on
    // the next commit -- so reading the items the instant the menu resolves can catch a partial
    // list and report it as the wrong set of transitions.
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(expected),
    );
  });

  it("flags only the cards that need the coach, and never by colour alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00.000Z"));
    const quiet = { ...contact, id: "lead-quiet", name: "Avery Stone" };
    const waiting: ContactRead = {
      ...contact,
      id: "lead-waiting",
      name: "Priya Raghunathan",
      outcome: "BOOK",
      pipelineStage: "qualifying",
    };
    const stalled: ContactRead = {
      ...contact,
      id: "lead-stalled",
      lastActivityAt: "2026-08-17T12:00:00.000Z",
      name: "Chris Dunmore",
    };

    try {
      const { container } = render(
        <CoachPipeline
          appointmentEvidence={{}}
          canMove={false}
          contacts={[quiet, waiting, stalled]}
          onMove={vi.fn()}
          onOpen={vi.fn()}
          pendingIds={new Set()}
        />,
      );

      const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-kanban-card]"));
      expect(cards).toHaveLength(3);

      // Cards render column by column, so look each one up by the name it shows.
      const flagFor = (name: string) => cards
        .find((card) => card.getAttribute("aria-label") === `Open ${name}`)
        ?.querySelector<HTMLElement>("[data-card-flag]") ?? null;

      expect(flagFor("Avery Stone")).toBeNull();
      expect(flagFor("Priya Raghunathan")).toHaveTextContent("Needs you");
      expect(flagFor("Chris Dunmore")).toHaveTextContent("Stalled 7d");

      const flags = cards.map((card) => card.querySelector<HTMLElement>("[data-card-flag]"));

      // Every flag reads without colour: a word carries the meaning, the dot only repeats it.
      for (const flag of flags.filter((entry): entry is HTMLElement => entry !== null)) {
        expect(flag.textContent?.trim()).toBeTruthy();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every card the reason it sits in its stage", () => {
    const disqualified: ContactRead = {
      ...contact,
      credit: null,
      goal: null,
      id: "lead-dq",
      name: "Derek Shaw",
      outcome: "HARD_DQ",
      pipelineStage: "disqualified",
      timeline: null,
    };

    const { container } = render(
      <CoachPipeline
        appointmentEvidence={{}}
        canMove={false}
        contacts={[contact, disqualified]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        pendingIds={new Set()}
      />,
    );

    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-kanban-card]"));
    expect(cards[0]).toHaveTextContent("$50,000 goal · 680 to 719 credit · This month");
    expect(cards[1]).toHaveTextContent("The lead did not meet the current qualification rules.");
  });

  it("closes each stage with the count of the cards it holds", () => {
    const { container } = render(
      <CoachPipeline
        appointmentEvidence={{}}
        canMove={false}
        contacts={[contact, { ...contact, id: "lead-2", name: "Omar Haddad" }]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        pendingIds={new Set()}
      />,
    );

    expect(
      container.querySelector('[data-kanban-column-total="new_lead"]'),
    ).toHaveTextContent("2 leads");
  });
});

/*
 * A disabled Move to with nothing beside it reads as broken. The board says which off-state it is
 * in, in words, and says what did not happen. Both sentences are pinned here because the flags are
 * on in production and these states only ever show in a preview or a rollback.
 */
describe("the off-state for Move to", () => {
  function board(overrides: { canMove: boolean; writeEnabled?: boolean }) {
    return render(
      <CoachPipeline
        appointmentEvidence={{}}
        canMove={overrides.canMove}
        contacts={[contact]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        pendingIds={new Set()}
        writeEnabled={overrides.writeEnabled ?? overrides.canMove}
      />,
    );
  }

  it("says the verb is not switched on, and what did not happen", () => {
    board({ canMove: false, writeEnabled: false });
    expect(screen.getByText(
      "Stage changes are not switched on in this environment, so Move to is off on every card. Nothing has changed stage, and no lead was messaged.",
    )).toBeVisible();
    expect(screen.getByText("Stage changes not switched on")).toBeVisible();
  });

  it("names the impersonated view instead when the verb itself is released", () => {
    board({ canMove: false, writeEnabled: true });
    expect(screen.getByText(
      "This impersonated view is read only, so Move to is off on every card. Nothing has changed stage, and no lead was messaged.",
    )).toBeVisible();
    expect(screen.queryByText(/not switched on/)).not.toBeInTheDocument();
  });

  it("says nothing at all when moves are on", () => {
    const { container } = board({ canMove: true });
    // The board has to be on screen for its silence to mean anything: `querySelector(...)` is null
    // both when the callout is correctly absent and when no board rendered at all. Stubbing
    // `CoachPipeline` to `return null` left this test green, which is what this line fixes.
    expect(screen.getByRole("group", { name: `Open ${contact.name}` })).toBeInTheDocument();
    expect(container.querySelector('[data-slot="callout"]')).toBeNull();
  });
});

/**
 * 1k draws a stage editor. There is no per-tenant stage storage behind one, so what ships states
 * the rules rather than offering to change them, and these two tests are what keep it that way.
 */
describe("the stage rules", () => {
  function openRules() {
    render(
      <CoachPipeline
        appointmentEvidence={{}}
        canMove={false}
        contacts={[contact]}
        onMove={vi.fn()}
        onOpen={vi.fn()}
        pendingIds={new Set()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /How a lead changes stage/u }));
    return Array.from(document.querySelectorAll<HTMLElement>('[data-slot="setting-row"]'));
  }

  it("gives every stage a rule, and spends colour only on the won and lost stages", () => {
    const rows = openRules();
    expect(rows).toHaveLength(PIPELINE_STAGES.length);

    for (const row of rows) {
      // The row kit puts the sentence in a <p>; a stage with a bare label is the failure this
      // panel exists to avoid.
      expect(row.querySelector("p")?.textContent?.trim()).toBeTruthy();
    }

    const toned = rows
      .map((row) => ({
        text: row.textContent ?? "",
        tone: row.querySelector<HTMLElement>('[data-slot="status-dot"]')?.dataset.tone,
      }))
      .filter((entry) => entry.tone !== "neutral");

    expect(toned.map((entry) => entry.tone)).toEqual(["good", "failure", "failure"]);
    // Never colour alone: every toned dot sits beside the stage's full name.
    expect(toned.map((entry) => entry.text.split(".")[0])).toEqual([
      "Call bookedAccepted only when an appointment receipt exists for the lead in Calendar",
      "Qualified, no buy (lost)A lost outcome: the lead qualified and did not book",
      "Disqualified or bad fit (lost)A lost outcome: the lead does not meet the current qualification rules",
    ]);
  });

  it("states the rules rather than offering controls for them", () => {
    openRules();
    const group = document.querySelector<HTMLElement>('[data-slot="setting-group"]');
    expect(group).not.toBeNull();
    expect(group!.querySelectorAll("input, select, textarea, button")).toHaveLength(0);
  });
});

describe("where the board spends colour", () => {
  function board() {
    render(
      <CoachPipeline
        appointmentEvidence={{}}
        canMove
        contacts={[
          { ...contact, id: "booked-1", pipelineStage: "booked" },
          { ...contact, id: "lost-1", pipelineStage: "disqualified" },
        ]}
        onMove={vi.fn(async () => ({ ok: true as const, receipt: { actionKey: "contact.pipeline_stage.set" as const, auditId: 1 } }))}
        onOpen={vi.fn()}
        pendingIds={new Set()}
      />,
    );
  }

  /*
   * `LeadsBoard.dc.html` gives Call booked the accent -- dot, border, tint and count pill -- and it
   * is the only column that gets any, because it is the outcome the board exists to produce. Both
   * lost columns drop below neutral rather than to the critical red they carried: a disqualified
   * lead is finished, not broken, and two red columns read as an alarm about the coach's pipeline.
   */
  it("gives the accent to Call booked and to nothing else", () => {
    board();
    const columns = Array.from(document.querySelectorAll<HTMLElement>("[data-kanban-column]"));
    const accented = columns.filter((column) => column.dataset.emphasis === "accent");
    expect(accented.map((column) => column.dataset.kanbanColumn)).toEqual(["booked"]);
    const quiet = columns.filter((column) => column.dataset.emphasis === "quiet");
    expect(quiet.map((column) => column.dataset.kanbanColumn)).toEqual([
      "qualified_no_buy",
      "disqualified",
    ]);
  });

  it("opens every card's meta line with its channel glyph", () => {
    board();
    const meta = document.querySelector<HTMLElement>('[data-slot="kanban-card-meta"]');
    expect(meta).not.toBeNull();
    expect(meta!.querySelector("svg")).not.toBeNull();
    // The glyph is decorative: the channel's own name is printed beside it.
    expect(meta).toHaveTextContent("Instagram");
  });
});
