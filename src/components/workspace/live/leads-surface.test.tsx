import { fireEvent, render, screen, within } from "@testing-library/react";
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

import {
  callbackLeads,
  filterLeads,
  funnelLeak,
  leadExportRows,
  leadFunnel,
  LeadsSurface,
  silentDays,
} from "@/components/workspace/live/leads-surface";
import { CoachContacts } from "@/components/workspace/live/coach-contacts";
import type { ContactRead } from "@/lib/repositories/contacts";

/**
 * The page's clock, fixed. Every silence figure on the call-back list is measured against it, so
 * these renders assert the same days in January as in June.
 */
const NOW_ISO = "2026-08-24T09:00:00.000Z";

const contacts: ContactRead[] = [
  {
    channels: [{ address: "nadia", channel: "instagram" }],
    credit: "680 to 719",
    goal: "$40,000",
    id: "lead-1",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-24T09:00:00.000Z",
    name: "Nadia Farouk",
    outcome: null,
    pipelineStage: "new_lead",
    timeline: "This month",
  },
  {
    channels: [{ address: "omar", channel: "sms" }],
    credit: "720 or higher",
    goal: "$80,000",
    id: "lead-2",
    isDemo: false,
    isTest: false,
    lastActivityAt: "2026-08-23T09:00:00.000Z",
    name: "Omar Haddad",
    outcome: "BOOK",
    pipelineStage: "booked",
    timeline: "Next quarter",
  },
];

describe("LeadsSurface", () => {
  beforeEach(() => {
    navigation.pathname = "/coach/contacts";
    navigation.replace.mockReset();
    navigation.searchParams = new URLSearchParams("q=nadia");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The drift this catches: an `Overline` creeping back onto a coach screen.
   *
   * The atomic is 9.5px mono, uppercase, tracked at 0.09em, and `src/app/overline-size.test.ts`
   * pins that size at its source because it had already drifted three times. It is a legitimate
   * role on the owner console and it is the worst legibility case in the product for a credit
   * coach over 55, which is the reader this side of the app is built for -- the redesign canvas
   * removes it from the coach surfaces entirely. Both leads views are checked, because the board
   * carries its own eyebrow on the managed-by-SetterFi strip and the table does not render it.
   *
   * This asserts the type role is gone, not that a particular string is: the funnel heading still
   * reads "Where leads leak" and is still what `aria-labelledby` points at. What changed is that
   * it is a 12px sentence-case eyebrow instead of the atomic.
   */
  it("spends no 9.5px uppercase overline on either leads view", () => {
    for (const view of ["table", "board"] as const) {
      const rendered = render(
        <LeadsSurface
          appointmentEvidence={{}}
          nowIso={NOW_ISO}
          defaultView={view}
          initialContacts={contacts}
          writeEnabled
        />,
      );

      // The positive control, and this assertion is load-bearing rather than decorative.
      //
      // Everything below it is `toHaveLength(0)` against a `querySelectorAll`, which is exactly as
      // true of a view that renders no overline as it is of a view that renders nothing at all.
      // Verified by mutation: with `LeadsSurface` stubbed to `return null` this test passed, so as
      // written it forbade nothing. Proving the view actually drew itself is what converts the
      // absence below into a claim about the design.
      expect(
        rendered.getAllByText("Nadia Farouk").length,
        `the ${view} view rendered nothing, so the overline check below proves nothing`,
      ).toBeGreaterThan(0);

      expect(
        rendered.container.querySelectorAll('[data-slot="overline"]'),
        `the ${view} view renders an Overline`,
      ).toHaveLength(0);
      rendered.unmount();
    }
  });

  it("uses the same filtered row count for table and board", () => {
    const view = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={contacts}
        writeEnabled={false}
      />,
    );

    expect(document.querySelector('[data-leads-view="table"]')).toHaveAttribute(
      "data-filtered-count",
      "1",
    );
    expect(screen.getByText("Nadia Farouk")).toBeInTheDocument();

    navigation.searchParams = new URLSearchParams("q=nadia&view=board");
    view.rerender(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={contacts}
        writeEnabled={false}
      />,
    );

    expect(document.querySelector('[data-leads-view="board"]')).toHaveAttribute(
      "data-filtered-count",
      "1",
    );
    expect(screen.getByRole("group", { name: "Open Nadia Farouk" })).toBeInTheDocument();
  });

  /*
   * One Download, on the filter row, in both views -- which is where `Leads.dc.html` and
   * `LeadsBoard.dc.html` each draw exactly one. It was two: inside the table's own toolbar band on
   * the list and inside the board's stage strip on the board, each of them inside the thing being
   * exported. Both are bound to the same filtered rows, so what moved is the position, not the
   * dataset.
   */
  it("keeps one Download on the filter row in both views", () => {
    for (const view of ["table", "board"] as const) {
      navigation.searchParams = new URLSearchParams(`q=nadia&view=${view}`);
      const rendered = render(
        <LeadsSurface
          appointmentEvidence={{}}
          nowIso={NOW_ISO}
          defaultView="table"
          initialContacts={contacts}
          writeEnabled={false}
        />,
      );

      const downloads = rendered.container.querySelectorAll('button[aria-label="Download"]');
      expect(downloads, `the ${view} view draws one Download`).toHaveLength(1);
      expect(
        downloads[0].closest('[data-slot="filter-bar"]'),
        `the ${view} view's Download sits on the filter row`,
      ).not.toBeNull();
      rendered.unmount();
    }

    // The call-back view draws two stages out of seven, so the whole-set export does not belong
    // on it. It never had one; this keeps it that way rather than shipping a Download that hands
    // back more leads than the screen is showing.
    navigation.searchParams = new URLSearchParams("q=nadia&view=callback");
    const callback = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={contacts}
        writeEnabled={false}
      />,
    );
    expect(callback.container.querySelectorAll('button[aria-label="Download"]')).toHaveLength(0);
    callback.unmount();

    navigation.searchParams = new URLSearchParams("q=nadia");
  });

  it("builds both view exports from complete rows in the shared filtered dataset", () => {
    const filtered = filterLeads(contacts, {
      channels: ["instagram"],
      outcomes: ["pending"],
      query: "nadia",
      stages: ["new_lead"],
    });

    expect(leadExportRows(filtered)).toEqual([{
      channels: [{ address: "nadia", channel: "instagram" }],
      contactId: "lead-1",
      creditRange: "680 to 719",
      decision: null,
      demoData: false,
      fundingGoal: "$40,000",
      lastActivity: "2026-08-24T09:00:00.000Z",
      name: "Nadia Farouk",
      optedOut: false,
      pipelineStage: "new_lead",
      testData: false,
      timeline: "This month",
      timezone: null,
    }]);
  });

  it("clears contact-specific identity state before another lead renders", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("lead-1")) {
        return Promise.resolve(new Response(JSON.stringify({
          candidates: [],
          contactId: "lead-1",
          identities: [{
            address: "nadia",
            channel: "instagram",
            channelLabel: "Instagram for Nadia",
            consentState: "unknown",
            id: "identity-1",
            normalizedEmail: null,
            normalizedPhone: null,
          }],
          isDemo: false,
          isTest: false,
          mergeState: { mergedAt: null, mergedIntoContactId: null, status: "active" },
          name: "Nadia Farouk",
          undo: null,
        }), { status: 200 }));
      }
      return new Promise<Response>(() => undefined);
    }));
    const props = {
      contacts,
      onContactDeleted: vi.fn(),
      onContactMerged: vi.fn(),
      onContactUnmerged: vi.fn(),
      onSelectedChange: vi.fn(),
    };
    const view = render(<CoachContacts {...props} selectedId="lead-1" />);
    expect(await screen.findByText("Instagram for Nadia")).toBeInTheDocument();

    view.rerender(<CoachContacts {...props} selectedId="lead-2" />);

    expect(screen.queryByText("Instagram for Nadia")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Omar Haddad" })).toBeInTheDocument();
  });

  it("documents the board keys that exist, and only those", () => {
    navigation.searchParams = new URLSearchParams("q=nadia&view=board");
    const { rerender } = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled
      />,
    );

    const help = screen.getByRole("region", { name: "Moving a lead without the mouse" });
    const keys = within(help).getAllByText(/^(Tab|Enter|M|Space|Esc|↑|↓|←|→)$/)
      .map((key) => key.textContent);
    expect(new Set(keys)).toEqual(new Set(["Tab", "Enter", "M", "Space", "Esc", "↑", "↓", "←", "→"]));
    // No key opens the conversation or the contact yet, so the legend must not claim one.
    expect(help).not.toHaveTextContent(/opens the conversation/i);

    rerender(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled={false}
      />,
    );

    // The replacement names the reason and what did not happen. "Unavailable in this view" told a
    // coach nothing about whether a move had gone through anyway.
    const readOnlyHelp = screen.getByRole("region", { name: "Moving a lead without the mouse" });
    expect(readOnlyHelp).toHaveTextContent(
      "Stage changes are not switched on in this environment, so the move keys do nothing here. Nothing has changed stage, and no lead was messaged.",
    );
    expect(within(readOnlyHelp).queryByText("Space")).not.toBeInTheDocument();

    // The board says the same thing beside the disabled Move to, so the control is never grey and
    // silent.
    expect(screen.getByText(
      "Stage changes are not switched on in this environment, so Move to is off on every card. Nothing has changed stage, and no lead was messaged.",
    )).toBeVisible();
  });

  it("opens the appointment evidence flow before moving a lead to Booked", async () => {
    navigation.searchParams = new URLSearchParams("q=nadia&view=board");
    render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled
      />,
    );

    const card = screen.getByRole("group", { name: "Open Nadia Farouk" });
    card.focus();
    fireEvent.keyDown(card, { key: "m" });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Call booked" }));

    expect(await screen.findAllByRole("heading", { name: "Move to Call booked" })).toHaveLength(2);
    expect(screen.getByLabelText("Appointment date")).toBeInTheDocument();
    expect(screen.getByLabelText(/Where it was booked/)).toBeInTheDocument();
    expect(screen.getByText("Required before the move can be saved")).toBeInTheDocument();
  });
});

/**
 * The funnel is the reason 1g exists, and the rule it has to hold is that a step which cannot be
 * divided says so in words. A 0% there claims every lead was lost at that step, which is a
 * different and much worse claim than "there is no denominator".
 */
describe("the call-back list", () => {
  const callbackContacts: ContactRead[] = [
    {
      channels: [{ address: "+1 (415) 555-0142", channel: "sms" }],
      credit: null,
      goal: null,
      id: "lead-callback-1",
      isDemo: false,
      isTest: false,
      lastActivityAt: "2026-08-01T09:00:00.000Z",
      name: "Jordan Pike",
      outcome: null,
      pipelineStage: "no_show",
      timeline: null,
    },
    {
      channels: [{ address: "casey.dm", channel: "instagram" }],
      credit: null,
      goal: null,
      id: "lead-callback-2",
      isDemo: false,
      isTest: false,
      lastActivityAt: "2026-08-20T09:00:00.000Z",
      name: "Casey Moreno",
      outcome: null,
      pipelineStage: "long_term_followup",
      timeline: null,
    },
    ...contacts,
  ];

  it("holds only the two stages the Dashboard tile counts, longest silent first", () => {
    expect(callbackLeads(callbackContacts).map((contact) => contact.id))
      .toEqual(["lead-callback-1", "lead-callback-2"]);
    expect(silentDays("2026-08-01T09:00:00.000Z", Date.parse("2026-08-24T09:00:00.000Z"))).toBe(23);
    expect(silentDays("not a date", Date.parse("2026-08-24T09:00:00.000Z"))).toBeNull();
  });

  /**
   * Screen 2e heads this list "7 due today" and gives every row a "Let the setter retry" button.
   * There is no due date on a contact and no coach-triggered follow-up endpoint anywhere in the
   * API, so neither can render: a chip that says "due today" over a `last_activity_at` is a
   * fabricated deadline, and a retry button with nothing behind it is a control for something with
   * no storage. What renders is the silence the row does carry, and a call link only where a
   * number is genuinely on file.
   */
  it("offers a call only where a number exists, and never promises a retry it cannot make", () => {
    navigation.searchParams = new URLSearchParams("view=callback");
    const view = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={callbackContacts}
        writeEnabled
      />,
    );

    const list = view.getByRole("list", { name: "Leads to call back" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    // The lead with a phone number gets a real dialable link; the DM-only lead gets no button.
    expect(within(rows[0] as HTMLElement).getByRole("link", { name: "Call now" }))
      .toHaveAttribute("href", "tel:+14155550142");
    expect(within(rows[1] as HTMLElement).queryByRole("link", { name: "Call now" })).toBeNull();
    expect(rows[1]).toHaveTextContent("no phone number on file");

    // Now that the clock is threaded rather than sampled at render, the silence figure is a fixed
    // assertion rather than one that drifts with the wall clock, and so is the tone threshold it
    // crosses. Colour is never the only carrier: the row says "23d silent" in words beside it.
    expect(rows[0]).toHaveTextContent("23d silent");
    expect(rows[0]?.querySelector('[data-slot="queue-item"]')).toHaveAttribute("data-tone", "warning");
    expect(rows[1]).toHaveTextContent("4d silent");
    expect(rows[1]?.querySelector('[data-slot="queue-item"]')).toHaveAttribute("data-tone", "neutral");

    expect(list.textContent).not.toMatch(/due today|overdue|let the setter retry|snooze/iu);
    expect(view.container.textContent).toContain("no control here that re-opens a thread on demand");
  });

  /**
   * `followups.scheduled_at` is a real due date with a real index behind it, but it is the
   * setter's cadence rather than an obligation on the coach, so the row names whose date it is.
   *
   * The three arms matter separately. A scheduled touch prints a date. No scheduled touch prints
   * a resting absence, which is the common case in these two stages because a reply, a takeover,
   * an opt-out or a hard disqualification all cancel the cadence. And a read that failed or came
   * back truncated prints nothing at all, because "none scheduled" is a claim it never
   * established.
   */
  it("names the setter's next touch as the setter's, and says nothing when it could not read one", () => {
    navigation.searchParams = new URLSearchParams("view=callback");

    const known = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={callbackContacts}
        nextSetterTouch={{ "lead-callback-1": "2026-09-02T17:00:00.000Z" }}
        writeEnabled
      />,
    );
    const knownRows = within(known.getByRole("list", { name: "Leads to call back" }))
      .getAllByRole("listitem");

    expect(knownRows[0]).toHaveTextContent("Setter's next touch Sep 2, 2026");
    // The cadence was canceled on this one, which is ordinary rather than broken.
    expect(knownRows[1]).toHaveTextContent("No automated touch scheduled");
    expect(known.container.textContent).toContain("SetterFi's own cadence, not a deadline for you");
    known.unmount();

    // A failed or truncated read. Neither row may report an absence the read did not find.
    const unknown = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={callbackContacts}
        nextSetterTouch={null}
        writeEnabled
      />,
    );
    const unknownList = unknown.getByRole("list", { name: "Leads to call back" });

    expect(unknownList.querySelectorAll('[data-slot="callback-next-touch"]')).toHaveLength(0);
    expect(unknownList.textContent).not.toMatch(/next touch|no automated touch/iu);
  });
});

describe("the leads funnel", () => {
  it("names the reason a step cannot be compared instead of printing 0%", () => {
    const steps = leadFunnel([]);

    expect(steps.map((step) => step.count)).toEqual([0, 0, 0, 0]);
    expect(steps[0].drop).toBeNull();
    for (const step of steps.slice(1)) {
      expect(step.drop?.kind).toBe("absent");
      expect(step.drop?.kind === "absent" ? step.drop.reason : "").toMatch(/nothing for/u);
    }
    expect(funnelLeak(steps)).toBe("No leads match these filters, so there is nothing to measure.");
  });

  it("refuses to divide a step that holds more leads than the one before it", () => {
    // A lead can be booked without the agent's own decision recorded against it, so the two
    // counts are not nested and their ratio is not a conversion.
    const steps = leadFunnel([
      { ...contacts[0], id: "lead-a", outcome: "BOOK", pipelineStage: "qualifying" },
      { ...contacts[0], id: "lead-b", outcome: null, pipelineStage: "booked" },
      { ...contacts[0], id: "lead-c", outcome: null, pipelineStage: "booked" },
    ]);

    const booked = steps.find((step) => step.key === "booked");
    expect(booked?.count).toBe(2);
    expect(booked?.drop?.kind).toBe("absent");
    expect(booked?.drop?.kind === "absent" ? booked.drop.reason : "").toContain("do not divide");
  });

  it("computes the drop from the step before it and names the biggest one", () => {
    const rows = [
      ...Array.from({ length: 4 }, (unused, index) => ({
        ...contacts[0],
        id: `open-${index}`,
        outcome: null,
        pipelineStage: "new_lead",
      })),
      { ...contacts[1], id: "ready-1", outcome: "BOOK" as const, pipelineStage: "qualifying" },
      { ...contacts[1], id: "booked-1", outcome: "BOOK" as const, pipelineStage: "booked" },
    ];

    const steps = leadFunnel(rows);
    expect(steps.map((step) => step.count)).toEqual([6, 2, 2, 1]);
    // 6 leads, 2 with a decision: two thirds are lost before a decision is recorded.
    expect(steps[1].drop).toEqual({ kind: "drop", percent: 67 });
    expect(steps[2].drop).toEqual({ kind: "drop", percent: 0 });
    expect(steps[3].drop).toEqual({ kind: "drop", percent: 50 });
    expect(funnelLeak(steps)).toBe(
      "17% of the leads in view are booked. The biggest drop is between Leads and Decision recorded.",
    );
  });

  it("shows the unmeasurable steps as words on the page, and never as a percentage", () => {
    navigation.searchParams = new URLSearchParams();
    render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="table"
        initialContacts={[]}
        writeEnabled={false}
      />,
    );

    const funnel = screen.getByRole("region", { name: "Where leads leak" });
    expect(funnel).toHaveTextContent("No lead reached Leads");
    expect(funnel.textContent).not.toMatch(/%/u);
  });

  /**
   * The ordering complaint from the round-1 walkthrough, as a rule rather than a memory.
   *
   * The board is the reason a coach opens this page, and it had a wall of explanation stacked on
   * top of it: the funnel's three method paragraphs, the stage-rule accordion, and the strip
   * naming what SetterFi manages. None of that is wrong, and none of it was cut -- it is all still
   * on the page, below the thing it explains. What this pins is the relation, so a later edit that
   * reintroduces an explanatory block above the board fails here instead of shipping.
   *
   * The three chosen are the three that moved. Anything that is genuinely about the board rather
   * than about the pipeline still belongs above it -- the notice saying stage changes are off is
   * deliberately not in this list, because a coach needs that before they try to drag, not after
   * they scroll past the board.
   */
  it("draws the board above every block that only explains it", () => {
    navigation.searchParams = new URLSearchParams("view=board");
    const { container } = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled
      />,
    );

    // The positive control. Every assertion below is a document-position check against this node,
    // and all of them are vacuously satisfiable by a page that drew no board at all.
    const board = container.querySelector("[data-kanban-column]");
    expect(board, "the board did not render, so the ordering below proves nothing").not.toBeNull();

    const explainers: readonly [string, HTMLElement][] = [
      ["the stage-rule accordion", screen.getByRole("button", { name: /How a lead changes stage/u })],
      ["the managed-by-SetterFi strip", screen.getByText("Managed by SetterFi")],
      [
        "the keyboard reference",
        screen.getByRole("region", { name: "Moving a lead without the mouse" }),
      ],
    ];

    for (const [name, explainer] of explainers) {
      expect(
        Boolean(board!.compareDocumentPosition(explainer) & Node.DOCUMENT_POSITION_FOLLOWING),
        `${name} is drawn above the board, which is what the coach came here to look at`,
      ).toBe(true);
    }
  });

  /**
   * Demoted, not deleted -- and the funnel's caveat demoted without going quiet.
   *
   * Both reference blocks ship shut. The risk in shutting the funnel's one is specific: the row of
   * percentages above it reads as a journey unless something says it is not, so the short form of
   * that caveat is the summary line itself and stays on screen closed. The long form, and the
   * explanation of who the stopped leads are, are inside.
   */
  it("ships both reference blocks shut, with the funnel caveat still readable closed", () => {
    navigation.searchParams = new URLSearchParams("view=board");
    const { container } = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled
      />,
    );

    const method = container.querySelector<HTMLDetailsElement>('[data-slot="funnel-method"]');
    expect(method, "the funnel method note did not render").not.toBeNull();
    expect(method!.open).toBe(false);
    expect(method!.querySelector("summary")).toHaveTextContent("not the path it took");
    expect(method).toHaveTextContent(
      "The stages a lead passed through are not recorded, so this reads the decision on each lead, not its history.",
    );

    const keyboard = container.querySelector<HTMLDetailsElement>(
      '[data-slot="board-keyboard-disclosure"]',
    );
    expect(keyboard, "the keyboard reference did not render").not.toBeNull();
    expect(keyboard!.open).toBe(false);
    // Shut is not gone: every key the board handles is still documented inside it.
    expect(keyboard).toHaveTextContent("lifts the card");
  });

  /**
   * A funnel step's name has to be able to say which stage it is.
   *
   * It carried a clipping class, which was correct in the layout it was written for and wrong
   * everywhere else: at desktop the four wells sit in one row and every name fits, so nothing was
   * ever cut. At 500px they wrap three-then-one, the tiles narrow, and "Decision recorded" renders
   * as "Decision reco..." -- a figure whose label cannot name its own stage, at the only width
   * where a coach cannot fall back to reading the row. The rule was written about a row rather
   * than about a name, so it held at exactly the widths where it did not matter.
   *
   * jsdom lays nothing out, so this reads the shipped classes rather than a rendered width. That
   * is the right subject anyway: no viewport is exempt, so the assertion is that the name carries
   * no clipping at all rather than that it survives one particular size.
   */
  it("never clips a funnel step's name", () => {
    navigation.searchParams = new URLSearchParams("view=board");
    const { container } = render(
      <LeadsSurface
        appointmentEvidence={{}}
        nowIso={NOW_ISO}
        defaultView="board"
        initialContacts={contacts}
        writeEnabled
      />,
    );

    const names = [...container.querySelectorAll<HTMLElement>("[data-funnel-step-name]")];
    // The positive control: an empty list satisfies every assertion below without proving one.
    expect(names.length, "the funnel drew no step names to check").toBe(4);
    expect(names.map((name) => name.textContent?.trim())).toContain("Decision recorded");

    // Each of these alone is enough to end a name in an ellipsis or hold it on one line.
    const clipping = ["truncate", "text-ellipsis", "overflow-hidden", "whitespace-nowrap"];
    for (const name of names) {
      const found = clipping.filter((rule) => name.classList.contains(rule));
      expect(
        found,
        `the step named "${name.textContent?.trim()}" is clipped, so it cannot name its stage when the tile narrows`,
      ).toEqual([]);
    }
  });
});
