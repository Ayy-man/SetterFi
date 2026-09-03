import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/coach/contacts",
  replace: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.searchParams,
}));

import {
  CoachLeads,
  leadBoard,
  LEAD_BOARD_COLUMNS,
  leadCardMeta,
  leadsMonthStatus,
  needsCoach,
} from "@/components/workspace/rehaul/coach-leads";
import { COACH_PIPELINE_STAGES } from "@/components/workspace/live/measurement-view-models";
import type { ContactRead } from "@/lib/repositories/contacts";

const NOW_ISO = "2026-08-24T09:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function lead(overrides: Partial<ContactRead> & Pick<ContactRead, "id" | "name">): ContactRead {
  return {
    channels: [{ address: "+15555550100", channel: "sms" }],
    credit: "680 to 719",
    goal: "$40,000",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-22T09:00:00.000Z",
    outcome: null,
    pipelineStage: "new_lead",
    timeline: "This month",
    ...overrides,
  };
}

const contacts: ContactRead[] = [
  lead({ id: "lead-1", name: "Nadia Farouk" }),
  lead({ id: "lead-2", name: "Omar Haddad", outcome: "BOOK", pipelineStage: "booked" }),
  lead({ id: "lead-3", name: "Leah Kim", pipelineStage: "qualifying" }),
  lead({
    id: "lead-4",
    name: "Devon Price",
    lastActivityAt: "2026-08-02T09:00:00.000Z",
    pipelineStage: "no_show",
  }),
  lead({ id: "lead-5", name: "Sam Ortiz", outcome: "HARD_DQ", pipelineStage: "disqualified" }),
];

describe("leadBoard", () => {
  it("has one column per stage this build stores, and no invented stage", () => {
    const stored = COACH_PIPELINE_STAGES.map((stage) => stage.key).sort();
    const columns = LEAD_BOARD_COLUMNS.map((column) => column.key).sort();
    expect(columns).toEqual(stored);
  });

  it("places every lead in the column for its stored stage", () => {
    const board = leadBoard(contacts);
    const byKey = Object.fromEntries(
      board.columns.map((column) => [column.key, column.contacts.map((contact) => contact.id)]),
    );
    expect(byKey.new_lead).toEqual(["lead-1"]);
    expect(byKey.qualifying).toEqual(["lead-3"]);
    expect(byKey.booked).toEqual(["lead-2"]);
    expect(byKey.no_show).toEqual(["lead-4"]);
    expect(byKey.disqualified).toEqual(["lead-5"]);
    expect(byKey.long_term_followup).toEqual([]);
    expect(byKey.qualified_no_buy).toEqual([]);
    expect(board.unplaced).toEqual([]);
  });

  it("spends amber only on the stages that are the coach's to act on", () => {
    const byKey = Object.fromEntries(
      LEAD_BOARD_COLUMNS.map((column) => [column.key, column.dot]),
    );
    // Amber is the one persistent pending colour, so nothing else may carry a second one.
    expect(Object.entries(byKey).filter(([, dot]) => dot === "var(--warning)").map(([key]) => key))
      .toEqual(["qualifying", "no_show"]);
    expect(Object.values(byKey)).not.toContain("var(--waiting)");
    // Green only where the server recorded the thing: a booking exists or it does not.
    expect(byKey.booked).toBe("var(--good)");
  });

  it("names a stage it has no column for rather than dropping the lead", () => {
    const board = leadBoard([...contacts, lead({ id: "lead-6", name: "Ray Dunn", pipelineStage: "archived" })]);
    expect(board.unplaced).toEqual([{ count: 1, stage: "archived" }]);
  });
});

describe("needsCoach and leadCardMeta", () => {
  const callback = lead({ id: "lead-4", name: "Devon Price", pipelineStage: "no_show" });

  it("marks a call-back lead with no automated touch left", () => {
    expect(needsCoach(callback, {})).toBe(true);
    expect(leadCardMeta(callback, { evidence: {}, nextSetterTouch: {}, nowMs: NOW_MS })).toEqual({
      text: "Needs you · no automated touch scheduled",
      tone: "warning",
    });
  });

  it("claims nothing when the follow-up read failed", () => {
    expect(needsCoach(callback, null)).toBe(false);
  });

  it("shows the appointment date on a booked lead", () => {
    const booked = lead({ id: "lead-2", name: "Omar Haddad", pipelineStage: "booked" });
    const meta = leadCardMeta(booked, {
      evidence: {
        "lead-2": { appointmentId: "appt-1", startAt: "2026-09-04T14:30:00.000Z", status: "booked" },
      },
      nextSetterTouch: {},
      nowMs: NOW_MS,
    });
    expect(meta.tone).toBe("neutral");
    expect(meta.text).toContain("2026");
  });

  it("falls back to a captured answer and a quiet-days count", () => {
    const meta = leadCardMeta(contacts[0], { evidence: {}, nextSetterTouch: {}, nowMs: NOW_MS });
    expect(meta).toEqual({ text: "$40,000 · 2d quiet", tone: "neutral" });
  });
});

describe("leadsMonthStatus", () => {
  it("counts leads active in the clock's own month", () => {
    expect(leadsMonthStatus(contacts, NOW_ISO)).toEqual({
      active: 5,
      booked: 1,
      label: "5 active this month · 1 booked",
    });
  });

  it("excludes activity from another month", () => {
    const older = lead({ id: "lead-7", name: "Bea Nwosu", lastActivityAt: "2026-07-30T09:00:00.000Z" });
    expect(leadsMonthStatus([...contacts, older], NOW_ISO).active).toBe(5);
  });
});

describe("CoachLeads", () => {
  it("renders the board with its stage counts and no explainer prose", () => {
    navigation.searchParams = new URLSearchParams("view=board");
    render(
      <CoachLeads
        appointmentEvidence={{}}
        defaultView="table"
        initialContacts={contacts}
        nextSetterTouch={{}}
        nowIso={NOW_ISO}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Leads" })).toBeInTheDocument();
    expect(screen.getByText("5 active this month · 1 booked")).toBeInTheDocument();

    const column = screen.getByRole("region", { name: "New lead" });
    expect(within(column).getByText("Nadia Farouk")).toBeInTheDocument();
    expect(within(column).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Call booked" })).toBeInTheDocument();
    expect(screen.getByText("Needs you · no automated touch scheduled")).toBeInTheDocument();

    // The old surface's help text is gone from the page body.
    expect(
      screen.queryByText("Everyone who has messaged you, and where each one got to."),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Drag a card to move someone along/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Ordered by how long each lead has been silent/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Where leads leak/u)).not.toBeInTheDocument();
  });

  it("renders the stat strip above the list in list view", () => {
    navigation.searchParams = new URLSearchParams();
    render(
      <CoachLeads
        appointmentEvidence={{}}
        defaultView="table"
        initialContacts={contacts}
        nextSetterTouch={{}}
        nowIso={NOW_ISO}
      />,
    );

    expect(screen.getByText("Awaiting a decision")).toBeInTheDocument();
    expect(screen.getByText("Booked")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "New lead" })).not.toBeInTheDocument();
  });
});
