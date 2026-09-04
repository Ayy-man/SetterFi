import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { CoachLeads } from "@/components/workspace/rehaul/coach-leads";
import {
  coachLeadsView,
  LEAD_BOARD_COLUMNS,
  channelLabel,
  lastActivityLabel,
  leadBoard,
  leadSentence,
  leadsProvenance,
  moveTargets,
  outcomeLabel,
  relativeAge,
  stageDot,
} from "@/components/workspace/rehaul/coach-leads-model";
import { COACH_PIPELINE_STAGES } from "@/components/workspace/live/measurement-view-models";
import type { ContactRead } from "@/lib/repositories/contacts";

const NOW_ISO = "2026-08-24T09:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);

function lead(overrides: Partial<ContactRead> & Pick<ContactRead, "id" | "name">): ContactRead {
  return {
    channels: [{ address: "+15555550100", channel: "instagram" }],
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
    lastActivityAt: "2026-08-02T09:00:00.000Z",
    name: "Devon Price",
    pipelineStage: "no_show",
  }),
  lead({ id: "lead-5", name: "Sam Ortiz", outcome: "HARD_DQ", pipelineStage: "disqualified" }),
];

function renderLeads(props: Partial<React.ComponentProps<typeof CoachLeads>> = {}) {
  return render(
    <CoachLeads
      appointmentEvidence={{}}
      defaultView="list"
      initialContacts={contacts}
      nowIso={NOW_ISO}
      {...props}
    />,
  );
}

beforeEach(() => {
  navigation.searchParams = new URLSearchParams();
  navigation.replace.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the view is a search parameter, so both routes render one screen", () => {
  it("opens on the view the route passed and falls back on an unknown value", () => {
    expect(coachLeadsView(null, "list")).toBe("list");
    expect(coachLeadsView(null, "board")).toBe("board");
    expect(coachLeadsView("board", "list")).toBe("board");
    expect(coachLeadsView("callback", "list")).toBe("list");
  });

  it("writes ?view= when the switch moves off the route's own view", () => {
    renderLeads();
    fireEvent.click(screen.getByRole("button", { name: "Board" }));
    expect(navigation.replace).toHaveBeenCalledWith("/coach/contacts?view=board", {
      scroll: false,
    });
  });
});

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
    expect(board.unplaced).toEqual([]);
  });

  it("spends amber only on the stages that are the coach's to act on", () => {
    const amber = LEAD_BOARD_COLUMNS.filter((column) => column.dot === "var(--warning)");
    expect(amber.map((column) => column.key)).toEqual(["qualifying", "no_show"]);
    expect(LEAD_BOARD_COLUMNS.map((column) => column.dot)).not.toContain("var(--waiting)");
    expect(stageDot("booked")).toBe("var(--good)");
    expect(stageDot("archived")).toBe("var(--faint)");
  });

  it("names a stage it has no column for rather than dropping the lead", () => {
    const board = leadBoard([...contacts, lead({ id: "lead-6", name: "Ray Dunn", pipelineStage: "archived" })]);
    expect(board.unplaced).toEqual([{ count: 1, stage: "archived" }]);
  });
});

describe("every cell states its absence rather than blanking", () => {
  it("names a lead with no decision, no channel and no captured answers", () => {
    const bare = lead({
      channels: [],
      credit: null,
      goal: null,
      id: "lead-bare",
      name: "Bea Nwosu",
      timeline: null,
    });
    expect(outcomeLabel(null)).toBe("No decision yet");
    expect(channelLabel(bare)).toBe("No channel recorded");
    expect(leadSentence(bare, {})).toBe("Your agent has not captured anything yet.");
  });

  it("refuses to print an age it cannot measure", () => {
    expect(relativeAge("not a date", NOW_MS)).toBeNull();
    expect(relativeAge("2026-08-25T09:00:00.000Z", NOW_MS)).toBeNull();
    expect(lastActivityLabel(lead({ id: "x", lastActivityAt: "nope", name: "X" }), NOW_MS))
      .toBe("No activity recorded");
    expect(relativeAge("2026-08-23T09:00:00.000Z", NOW_MS)).toBe("Yesterday");
    expect(relativeAge("2026-08-24T08:00:00.000Z", NOW_MS)).toBe("1 hour ago");
  });

  it("says nothing about provenance when the rows disagree about it", () => {
    expect(leadsProvenance(contacts)).toBeNull();
    expect(leadsProvenance(contacts.map((row) => ({ ...row, isDemo: true }))))
      .toBe("Demo leads, excluded from your analytics.");
  });
});

describe("moveTargets", () => {
  it("lists every other stage and never the one the lead is already in", () => {
    const targets = moveTargets(contacts[0], { evidence: {}, evidenceChecked: true });
    expect(targets.map((target) => target.key)).not.toContain("new_lead");
    expect(targets).toHaveLength(LEAD_BOARD_COLUMNS.length - 1);
  });

  it("keeps a refused stage in the menu with the reason attached", () => {
    const targets = moveTargets(contacts[0], { evidence: {}, evidenceChecked: true });
    const booked = targets.find((target) => target.key === "booked");
    expect(booked?.disabled).toBe(true);
    expect(booked?.reason).toBe("there is no booking on the calendar for this lead");

    const withBooking = moveTargets(contacts[0], {
      evidence: {
        "lead-1": { appointmentId: "appt-1", startAt: NOW_ISO, status: "scheduled" },
      },
      evidenceChecked: true,
    });
    expect(withBooking.find((target) => target.key === "booked")?.disabled).toBe(false);
  });

  it("pauses the receipt-backed stages when the appointment read itself failed", () => {
    const targets = moveTargets(contacts[0], { evidence: {}, evidenceChecked: false });
    for (const key of ["booked", "no_show"]) {
      expect(targets.find((target) => target.key === key)?.reason)
        .toBe("the appointment read failed, so reload before moving anyone here");
    }
  });
});

describe("the list", () => {
  it("draws the five artboard columns and nothing the spec killed", () => {
    renderLeads();

    expect(screen.getByRole("heading", { level: 1, name: "Your leads" })).toBeInTheDocument();
    for (const heading of ["Name", "Channel", "Stage", "Last activity", "Outcome"]) {
      expect(screen.getByRole("columnheader", { name: heading })).toBeInTheDocument();
    }

    // The five KPI cards, the eleven filters, merge, unmerge and the typed delete are all gone.
    expect(screen.queryByText("Awaiting a decision")).not.toBeInTheDocument();
    expect(screen.queryByText("Lost outcomes")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /merge/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete/iu })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /filters/iu })).not.toBeInTheDocument();
    // Playbook rule 5: the explanation is in the eye, not printed under the heading.
    expect(screen.queryByText(/Everyone who has messaged you/u)).not.toBeInTheDocument();
  });

  it("opens the conversation from the name and offers the two requests behind one menu", () => {
    renderLeads();

    expect(screen.getByRole("link", { name: "Nadia Farouk" })).toHaveAttribute(
      "href",
      "/coach/conversations?contact=lead-1",
    );

    fireEvent.click(screen.getByRole("button", { name: "More for Nadia Farouk" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Open the conversation" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Report a duplicate" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Request deletion" })).toBeInTheDocument();
    expect(within(menu).getByText("Both requests open a message to support.")).toBeInTheDocument();
  });

  it("narrows on the search box and says how many of the whole set are left", () => {
    renderLeads();
    expect(screen.getByText("5 leads")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search leads" }), {
      target: { value: "Nadia" },
    });
    expect(screen.getByText("1 of 5 leads")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Omar Haddad" })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search leads" }), {
      target: { value: "nobody at all" },
    });
    expect(screen.getByText("No lead matches that search.")).toBeInTheDocument();
  });
});

describe("the board", () => {
  beforeEach(() => {
    navigation.searchParams = new URLSearchParams("view=board");
  });

  it("draws one column per stored stage with its count, and names an empty one", () => {
    renderLeads();

    const column = screen.getByRole("region", { name: "New lead" });
    expect(within(column).getByRole("link", { name: "Nadia Farouk" })).toBeInTheDocument();
    expect(within(column).getByText("Wants $40,000, credit 680 to 719.")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Call booked" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Long-term follow-up" }))
        .getByText("No leads in this stage."),
    ).toBeInTheDocument();
  });

  it("states once, and only once, that stage changes are switched off", () => {
    renderLeads({ writeEnabled: false });

    expect(screen.getAllByText(/Stage changes are not switched on/u)).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Move .* to another stage/u })).not.toBeInTheDocument();
  });

  it("offers Move to on every card once stage changes are on", () => {
    renderLeads({ writeEnabled: true });

    expect(screen.queryByText(/Stage changes are not switched on/u)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Move .* to another stage/u }))
      .toHaveLength(contacts.length);
  });

  it("says nobody moved when the stage change comes back without a receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
    );
    renderLeads({ writeEnabled: true });

    fireEvent.click(screen.getByRole("button", { name: "Move Nadia Farouk to another stage" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Still talking" }));

    await waitFor(() => {
      expect(screen.getByText(/Nadia Farouk stayed in New lead/u)).toBeInTheDocument();
    });
    expect(
      within(screen.getByRole("region", { name: "New lead" })).getByRole("link", {
        name: "Nadia Farouk",
      }),
    ).toBeInTheDocument();
  });
});

describe("a support request is filed, never performed", () => {
  it("posts to the support route and reports only that it was sent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ thread: { id: "t1" } }), {
      status: 201,
    }));
    vi.stubGlobal("fetch", fetchMock);
    renderLeads();

    fireEvent.click(screen.getByRole("button", { name: "More for Nadia Farouk" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Request deletion" }));

    fireEvent.change(screen.getByLabelText("What should support know?"), {
      target: { value: "She asked us to remove her details." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send to support" }));

    await waitFor(() => {
      expect(screen.getByText("Sent to support.")).toBeInTheDocument();
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/contacts/lead-1/support-request");
    expect(JSON.parse(String(init.body))).toEqual({
      note: "She asked us to remove her details.",
      type: "deletion",
    });

    // The lead is still in the list: filing a request is not a deletion.
    expect(screen.getByRole("link", { name: "Nadia Farouk" })).toBeInTheDocument();
    expect(screen.getAllByText("Sent to support.")).toHaveLength(1);
  });
});
