import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COACH_METRIC_KEYS,
  metricDefinition,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import type { CoachChannelStatus } from "@/components/workspace/live/coach-channel-status";
import type {
  CoachLeadComposition,
  CoachMeasurement,
} from "@/lib/repositories/analytics";

import { WorkspaceEnvProvider } from "@/components/workspace/workspace-env";
import { DEMO_SETUP_OVERRIDE_KEY, DEMO_SETUP_OVERRIDE_MS } from "@/lib/demo-setup-override";

import { CoachDashboard, type CoachDashboardProps } from "./coach-dashboard";

const NOW = new Date("2026-09-03T12:00:00.000Z");

function metric(key: MetricKey) {
  const definition = metricDefinition(key);
  return {
    denominator: 10,
    metricKey: key,
    numerator: 5,
    state: "available" as const,
    value: definition.unit === "percent" ? 50 : 5,
    windowEnd: "2026-09-01T00:00:00.000Z",
    windowStart: "2026-08-01T00:00:00.000Z",
  };
}

function measurement(): CoachMeasurement {
  return {
    allowance: {
      limit: 25,
      periodEnd: "2026-09-30T00:00:00.000Z",
      periodStart: "2026-09-01T00:00:00.000Z",
      state: "available",
      used: 18,
    },
    funnel: [],
    isDemo: false,
    keywords: [
      {
        bookedContacts: 9,
        conversations: 96,
        dataLabel: "Real data",
        keyword: "CCA",
        qualifiedContacts: 28,
        respondedConversations: 71,
      },
      {
        bookedContacts: 0,
        conversations: 4,
        dataLabel: "Real data",
        keyword: "REFERRAL",
        qualifiedContacts: 1,
        respondedConversations: 2,
      },
      {
        bookedContacts: 3,
        conversations: 40,
        dataLabel: "Real data",
        keyword: "No keyword",
        qualifiedContacts: 12,
        respondedConversations: 20,
      },
    ],
    metrics: COACH_METRIC_KEYS.map((key) => metric(key)),
    pipeline: [],
    responses: [],
    tenantId: "tenant-synthetic",
    window: "1m",
    windowEnd: "2026-09-01T00:00:00.000Z",
  };
}

/**
 * Six months, because six is the floor the chart draws at all.
 *
 * `SPARKLINE_MIN_POINTS` is 6 and the composition read returns exactly six months, so a two-month
 * fixture was testing the branch a coach never sees. The last one is partial, which is the state
 * the chart has to label rather than let read as a collapse.
 */
const MONTH_LABELS = ["Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"];
const MONTH_KEYS = [
  "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01",
];
const MONTH_TOTALS = [12, 18, 21, 26, 30, 4];

function composition(): CoachLeadComposition {
  return {
    asOf: "2026-09-03T12:00:00.000Z",
    bookedByPeriod: MONTH_KEYS.map((month, index) => ({ booked: index, month })),
    months: MONTH_KEYS.map((month, index) => ({
      active: 2,
      disqualified: 1,
      label: MONTH_LABELS[index],
      month,
      partial: index === MONTH_KEYS.length - 1,
      qualified: 5,
      total: MONTH_TOTALS[index],
    })),
    tenantId: "tenant-synthetic",
    timezone: "America/New_York",
  };
}

const LIVE_STATUS: CoachChannelStatus = {
  carrier: { kind: "in-review", submittedAt: "2026-08-25T00:00:00.000Z" },
  channelsChecked: true,
  liveChannels: ["instagram", "messenger"],
};

const FIRST_RUN_STATUS: CoachChannelStatus = {
  carrier: { kind: "in-review", submittedAt: "2026-08-25T00:00:00.000Z" },
  channelsChecked: true,
  liveChannels: [],
};

/**
 * Sentences the live surface printed under its own headings. None of them may appear on the
 * rehaul body: they moved into the eye, which is the whole point of the copy rule.
 */
const OLD_EXPLAINERS = [
  "Leads the agent is talking to now, not counting finished or ruled-out conversations.",
  "Replies are counted per conversation, not per lead, so they are not shown against this figure.",
  "Counted over open conversations, which is a different population from the leads above.",
  // Both of these are in EYE_COPY verbatim, so neither may appear a second time in the body.
  "Everyone your agent reached this month.",
  "From first message to a call on the calendar.",
];

/**
 * The environment the workspace layout publishes.
 *
 * The demo setup override is gated on two values that only exist here -- the `SETTERFI_DEMO_LOGINS`
 * flag and `tenants.is_demo` for the signed-in tenant -- so a spec that wants the control has to
 * say so, and the default below deliberately says the opposite.
 */
function renderDashboard(
  overrides: Partial<CoachDashboardProps> = {},
  env: { demoAccountSwitching?: boolean; isDemo?: boolean } = {},
) {
  return render(
    <WorkspaceEnvProvider
      account={{
        business: "Synthetic Demo Tenant",
        firstName: "Reid",
        fullName: "Marcus Reid",
        isDemo: env.isDemo ?? false,
      }}
      demoAccountSwitching={env.demoAccountSwitching ?? false}
      demoViews={[]}
      mode="supabase"
    >
    <CoachDashboard
      attention={{ blockedSetupSteps: 0, leadsToCallBack: 2, threadsNeedingHuman: 3 }}
      billingPeriod={null}
      channelStatus={LIVE_STATUS}
      composition={composition()}
      greeting="Reid"
      measurement={measurement()}
      now={NOW}
      window="1m"
      {...overrides}
    />
    </WorkspaceEnvProvider>,
  );
}

/** The first-run screen on a seeded tenant, with both gates open. */
function renderDemoFirstRun(overrides: Partial<CoachDashboardProps> = {}) {
  return renderDashboard(
    {
      attention: { blockedSetupSteps: 1, leadsToCallBack: 0, threadsNeedingHuman: 0 },
      channelStatus: FIRST_RUN_STATUS,
      measurement: { ...measurement(), isDemo: true },
      ...overrides,
    },
    { demoAccountSwitching: true, isDemo: true },
  );
}

/** Opens the eye and returns the override toggle, or null when the eye does not carry one. */
async function openOverrideToggle() {
  await userEvent.click(screen.getByRole("button", { name: "About this screen" }));
  return screen.queryByRole("button", { name: /setup/iu });
}

describe("CoachDashboard", () => {
  it("greets the coach and states what the agent is doing in one sentence, not a row of chips", () => {
    renderDashboard();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome back, Reid");

    const status = document.querySelector("[data-slot='home-status']");
    expect(status?.textContent).toBe(
      "Your agent is live on Instagram and Messenger. Text messages are on day 10 of about 21.",
    );

    for (const sentence of OLD_EXPLAINERS) {
      expect(document.body.textContent).not.toContain(sentence);
    }
  });

  /*
   * The six bubbles, on one anatomy. The 2026-09-04 audit's third defect on this screen was three
   * cards where the artboard draws six, and its fifth was that the cards it did draw had three
   * different shapes.
   */
  it("draws six bubbles in the artboard's order, each with a band, a figure and a sentence", () => {
    renderDashboard();

    const bubbles = [...document.querySelectorAll("[data-slot^='home-bubble-']")];
    expect(bubbles).toHaveLength(6);
    expect(bubbles.map((panel) => panel.querySelector("h2")?.textContent)).toEqual([
      "Booked calls",
      "Active leads",
      "New leads",
      "Disqualified",
      "Conversion",
      "Average time to book",
    ]);

    for (const bubble of bubbles) {
      // One name, one eyebrow, at most one control in the band.
      expect(bubble.querySelectorAll("h2")).toHaveLength(1);
      expect(bubble.querySelectorAll(".coach-panel__eyebrow")).toHaveLength(1);
      expect(bubble.querySelectorAll("a").length).toBeLessThanOrEqual(1);
      // A figure, or an absence line where the figure would be. Never both, never neither.
      const figures = bubble.querySelectorAll(".coach-panel__figure");
      const absences = bubble.querySelectorAll("[data-slot='bubble-absence']");
      expect(figures.length + absences.length).toBe(1);
    }
  });

  it("counts the window in the eyebrow rather than fixing it to one month", () => {
    const view = renderDashboard({ window: "1m" });
    expect(document.body.textContent).toContain("Last month");
    view.unmount();

    renderDashboard({ window: "3m" });
    expect(document.body.textContent).toContain("Last three months");
    expect(document.body.textContent).not.toContain("Last month");
  });

  /*
   * The one bubble whose eyebrow is not the window. `coach.active_leads` reads the stored stage at
   * the moment the page loads, which is what the artboard's "Right now" says.
   */
  it("names Active leads as a reading of now and splits it only from the rows that carry the split", () => {
    const view = renderDashboard();

    const active = () => document.querySelector("[data-slot='home-bubble-active']");
    expect(active()?.textContent).toContain("Right now");
    expect(active()?.textContent).toContain("Agent handling");
    expect(active()?.textContent).toContain("Needs you");
    expect(active()?.querySelectorAll("[data-slot='bubble-footer-row']")).toHaveLength(2);
    view.unmount();

    /*
     * The other arm, and the one that matters. `coach.active_leads_agent_handling` and
     * `coach.active_leads_needs_you` reached the measurement RPC in
     * `20261012000006_active_leads_agent_split.sql`; against a database the migration has not
     * reached, the rows are simply not in the payload. The footer then says so in words rather
     * than halving the total, which is the only other thing it could do.
     */
    const unsplit = measurement();
    renderDashboard({
      measurement: {
        ...unsplit,
        metrics: unsplit.metrics.filter(
          (metric) => !(metric.metricKey as string).startsWith("coach.active_leads_"),
        ),
      },
    });

    expect(active()?.textContent).toContain("cannot yet split these");
    expect(active()?.querySelectorAll("[data-slot='bubble-footer-row']")).toHaveLength(0);
  });

  it("prints the conversion sentence off the rate's own numerator and denominator", () => {
    renderDashboard();

    const conversion = document.querySelector("[data-slot='home-bubble-conversion']");
    expect(conversion?.textContent).toContain("50%");
    expect(conversion?.textContent).toContain("5 booked calls out of the 10 new leads.");
  });

  /*
   * The audit's fourth defect: `72 hr` set the unit at figure size in mono, so "hr" read as part
   * of the number. The unit stays inside the glyph run, which is the rule VOCABULARY.md states and
   * the owner console's `5.8d` already follows.
   */
  it("keeps a duration's unit inside the figure's own glyph run", () => {
    renderDashboard();

    const figure = document
      .querySelector("[data-slot='home-bubble-time-to-book']")
      ?.querySelector(".coach-panel__figure");
    expect(figure?.textContent).toBe("5s");
    expect(document.body.textContent).not.toContain(" hr");
  });

  it("states an absent reading in words where the figure would be, and ends the card there", () => {
    const thin = measurement();
    renderDashboard({
      measurement: {
        ...thin,
        metrics: thin.metrics.map((metric) =>
          metric.metricKey === "coach.average_time_to_book"
            ? { ...metric, denominator: 0, numerator: 0, state: "unavailable" as const, value: null }
            : metric
        ),
      },
    });

    const panel = document.querySelector("[data-slot='home-bubble-time-to-book']");
    expect(panel?.querySelector("[data-slot='bubble-absence']")?.textContent)
      .toBe("No call was booked in this window.");
    expect(panel?.querySelectorAll(".coach-panel__figure")).toHaveLength(0);
    // No sentence and no footer under an absence: the card ends after the words.
    expect(panel?.querySelectorAll(".coach-panel__sentence")).toHaveLength(0);
    expect(panel?.querySelectorAll(".coach-panel__footer")).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------------------------
   * The date range control
   * ---------------------------------------------------------------------------------------- */

  it("draws six range stops, five as links that carry the window and Custom as a form", async () => {
    renderDashboard({ window: "3m" });

    const control = screen.getByRole("group", { name: "Date range" });
    expect(control.textContent).toBe("1 day1 week1 month3 monthsAllCustom");
    expect(screen.getByRole("link", { name: "3 months" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "1 week" }))
      .toHaveAttribute("href", "/coach/home?window=1w");

    // Custom cannot be a link: the page needs a pair of dates before it can read a custom window,
    // and there is no honest default range to send it.
    expect(screen.queryByRole("link", { name: "Custom" })).toBeNull();
    expect(document.querySelector("[data-slot='home-range-custom-form']")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Custom" }));
    const form = document.querySelector("[data-slot='home-range-custom-form']");
    expect(form?.getAttribute("action")).toBe("/coach/home");
    expect(form?.getAttribute("method")).toBe("get");
    expect(form?.querySelector("input[name='window']")).toHaveValue("custom");
  });

  it("opens the custom range already showing the dates the figures were read over", () => {
    renderDashboard({ customFrom: "2026-08-01", customTo: "2026-08-31", window: "custom" });

    expect(screen.getByLabelText("From")).toHaveValue("2026-08-01");
    expect(screen.getByLabelText("To")).toHaveValue("2026-08-31");
    // No preset is current while a custom range is.
    expect(document.querySelectorAll("[aria-current='page']")).toHaveLength(0);
  });

  /* ------------------------------------------------------------------------------------------
   * The six-month chart
   * ---------------------------------------------------------------------------------------- */

  it("draws six bars, marks the partial month solid and says how far into it we are", () => {
    renderDashboard();

    /*
     * One SVG, drawn for the desk. The phone gets the same six readings as HTML rows instead,
     * because a viewBox scales its own type and the 14px floor does not scale with it. Both
     * renderings are in the tree at once and CSS picks one, so each is asserted on its own.
     */
    const chart = screen.getByRole("img", { name: "Leads by month, the last six months" });
    expect(chart.querySelectorAll("[data-slot='month-bar']")).toHaveLength(5);
    expect(chart.querySelectorAll("[data-slot='month-bar-partial']")).toHaveLength(1);
    for (const label of ["Apr 2026", "May 2026", "Jun 2026", "Jul 2026", "Aug 2026", "Sep 2026"]) {
      expect(chart.textContent).toContain(label);
    }
    expect(chart.textContent).toContain(" so far");

    // The phone rows carry the same six bars and the same mark on the partial month.
    const rows = document.querySelectorAll("li [data-slot^='month-bar']");
    expect(rows).toHaveLength(6);
    expect(document.querySelectorAll("li [data-slot='month-bar-partial']")).toHaveLength(1);
    // Counted in the tenant's timezone off the composition's own asOf, not the reader's clock.
    expect(document.body.textContent).toContain("Sep 2026 has 3 days in it so far.");
  });

  it("states the shortfall instead of drawing a shorter chart under six months", () => {
    const short = composition();
    renderDashboard({ composition: { ...short, months: short.months.slice(0, 3) } });

    expect(screen.queryAllByRole("img", { name: /Leads by month/u })).toHaveLength(0);
    expect(document.body.textContent)
      .toContain("Six months of history are needed before the bars can be drawn. You have 3 so far.");
  });

  /* ------------------------------------------------------------------------------------------
   * The keyword table
   * ---------------------------------------------------------------------------------------- */

  it("puts the denominator on every keyword row and names the population of the No keyword row", () => {
    renderDashboard();

    const cca = screen.getByRole("row", { name: /CCA/u });
    expect(cca.textContent).toContain("28");
    expect(cca.textContent).toContain("of 96 leads");
    // Response and booked rates, each out of that keyword's own senders.
    expect(cca.textContent).toContain("74%");
    expect(cca.textContent).toContain("9.4%");

    const none = screen.getByRole("row", { name: /No keyword/u });
    expect(none.textContent).toContain("of 40 leads who sent none");
  });

  it("replaces the rates with words under ten senders rather than printing a rate off four people", () => {
    renderDashboard();

    const thin = screen.getByRole("row", { name: /REFERRAL/u });
    expect(thin.querySelector("[data-slot='keyword-thin']")?.textContent)
      .toBe("Rates show after 10 leads have sent it. 4 leads so far.");
    expect(thin.textContent).not.toContain("%");
  });

  it("orders by qualified leads and keeps the No keyword row last", () => {
    renderDashboard();

    const table = document
      .querySelector("[aria-labelledby='home-keywords-heading']")
      ?.querySelector("tbody");
    const names = [...(table?.querySelectorAll("tr th") ?? [])].map((cell) => cell.textContent);
    // REFERRAL has one qualified lead against No keyword's twelve, so ordering by qualified leads
    // alone would put No keyword second. It is pinned last instead: the row that means "no keyword
    // at all" reading as the best keyword is the one misreading this table cannot afford.
    expect(names).toEqual(["CCA", "REFERRAL", "No keyword"]);
  });

  it("names the empty keyword table without explaining the feature", () => {
    const empty = measurement();
    renderDashboard({ measurement: { ...empty, keywords: [] } });

    expect(document.body.textContent).toContain("No lead has sent a keyword in this window yet.");
    expect(document.body.textContent).not.toContain(
      "Keyword rows appear once a conversation is attributed to a keyword.",
    );
  });

  /* ------------------------------------------------------------------------------------------
   * First run
   * ---------------------------------------------------------------------------------------- */

  it("renders the setup rail and a hero that says something, with no figure cards, when nothing is live", () => {
    renderDashboard({
      attention: {
        blockedSetupSteps: 2,
        blockedStepKey: "a2p_brand",
        leadsToCallBack: 0,
        threadsNeedingHuman: 0,
      },
      channelStatus: FIRST_RUN_STATUS,
    });

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome, Reid");
    expect(screen.getByRole("heading", { name: "Your setup" })).toBeTruthy();
    // The blocked-step count is a read of provisioning_steps, so it can stand in the status line.
    expect(document.body.textContent).toContain("2 steps are waiting on you");
    // The counter denominates over the rungs whose state this page actually read.
    expect(document.body.textContent).toContain("0 of 3 done");
    // The pill claims only what the read established: nothing is live, not that nothing exists.
    expect(document.body.textContent).toContain("Not live yet");
    expect(document.body.textContent).not.toContain("Not connected");
    expect(screen.getByRole("heading", { name: "Texting registration" })).toBeTruthy();
    // A day counter, never a percentage or a predicted date.
    expect(document.body.textContent).toContain("Day 10");
    expect(document.body.textContent).not.toContain("%");

    // The hero always has something to say, and it is words rather than an empty chart.
    expect(document.querySelector("[data-slot='home-first-run-hero']")?.textContent)
      .toContain("Your first leads will appear here.");
    expect(screen.getByRole("heading", { name: "Try a conversation" })).toBeTruthy();
    expect(document.querySelectorAll(".coach-panel__figure")).toHaveLength(0);

    // No window to pick when there are no figures to pick one for, and no keyword table.
    expect(screen.queryByRole("group", { name: "Date range" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Which keyword/u })).toBeNull();
    // One support entry point, not two: "Ask us" left the header for the support bubble.
    expect(screen.queryByRole("link", { name: "Ask us" })).toBeNull();
  });
});

/**
 * The setup rail's four internal-consistency rules.
 *
 * Note 1 of `docs/plans/2026-09-04-coach-rehaul-notes.md` found four ways the rail disagreed with
 * itself: four cards over a denominator of three, four rows drawn as three different components,
 * the blocked count printed twice on one screen, and a spine with fewer nodes than rows. Each is
 * pinned here, because each was a rule the code held by hand in two places at once and every one
 * of them is the kind of thing that drifts back the next time a row is added.
 */
describe("CoachDashboard setup rail", () => {
  function rail() {
    return screen.getByRole("list", { name: "Your setup" });
  }

  function rows() {
    return [...rail().querySelectorAll(":scope > li")];
  }

  /** The "n of m done" reading, from the line the heading sits on. */
  function counter() {
    const heading = screen.getByRole("heading", { name: "Your setup" });
    const text = heading.parentElement?.textContent ?? "";
    const read = /(\d+) of (\d+) done/u.exec(text);
    if (!read) throw new Error(`The rail printed no counter: ${text}`);
    return { denominator: Number(read[2]), numerator: Number(read[1]) };
  }

  function occurrences(phrase: string) {
    return (document.body.textContent ?? "").split(phrase).length - 1;
  }

  function firstRun(attention: Partial<CoachDashboardProps["attention"]> = {}) {
    return renderDashboard({
      attention: {
        blockedSetupSteps: 0,
        leadsToCallBack: 0,
        threadsNeedingHuman: 0,
        ...attention,
      },
      channelStatus: FIRST_RUN_STATUS,
    });
  }

  /*
   * Rule 1. The denominator is the number of rows, because both are read off one array. A reader
   * counting cards has to arrive at the number printed beside the heading, and the old rail failed
   * that by drawing a fourth card the counter had deliberately excluded.
   */
  it("denominates over exactly the rows a reader can count, blocked step or not", () => {
    const view = firstRun();
    expect(rows()).toHaveLength(2);
    expect(counter()).toEqual({ denominator: 2, numerator: 0 });
    view.unmount();

    firstRun({ blockedSetupSteps: 2, blockedStepKey: "a2p_brand" });
    expect(rows()).toHaveLength(3);
    expect(counter()).toEqual({ denominator: 3, numerator: 0 });
  });

  it("keeps the rest-of-setup link out of the rail, because it names no state to be done in", () => {
    firstRun();

    const link = screen.getByRole("link", { name: "See the rest of your setup" });
    expect(link).toHaveAttribute("href", "/coach/get-started");
    // It is not a row, so it is not counted, so the count and the cards cannot disagree over it.
    expect(rail().contains(link)).toBe(false);
  });

  /*
   * Rule 2. One anatomy on every row: a header band carrying the eyebrow, the name and at most one
   * action, and no footer action bar anywhere. Three of the four rows used to carry one and the
   * fourth did not.
   */
  it("gives every row the same anatomy: one name, one state, at most one action, and no numbering", () => {
    firstRun({ blockedSetupSteps: 1, blockedStepKey: "a2p_brand" });

    for (const row of rows()) {
      expect(row.querySelectorAll("h2")).toHaveLength(1);
      expect(row.querySelectorAll("a").length).toBeLessThanOrEqual(1);
      // Every band offers its one action from the band itself, so no row grows a footer of them.
      const band = row.querySelector("h2")?.closest("div")?.parentElement;
      for (const link of row.querySelectorAll("a")) {
        expect(band?.contains(link), link.textContent ?? "").toBe(true);
      }
      // The rail's length changes with the blocked read, so a number would name a different row
      // on two accounts.
      expect(row.textContent ?? "").not.toMatch(/Step \d/u);
    }
  });

  it("never spends one action label on two destinations", () => {
    firstRun({ blockedSetupSteps: 1, blockedStepKey: "a2p_brand" });

    const byLabel = new Map<string, Set<string>>();
    for (const link of screen.getAllByRole("link")) {
      const label = (link.textContent ?? "").trim();
      const targets = byLabel.get(label) ?? new Set<string>();
      targets.add(link.getAttribute("href") ?? "");
      byLabel.set(label, targets);
    }
    for (const [label, targets] of byLabel) {
      expect([...targets], label).toHaveLength(1);
    }
    // The specific pair that failed this before: two cards, both reading "See setup".
    expect(screen.queryAllByRole("link", { name: "See setup" })).toHaveLength(0);
  });

  /*
   * Rule 3. The header counts the blocked steps; the row names one of them. Neither says the
   * other's fact, and the row's name comes from the key the page already reads beside the count.
   */
  it("names the blocked step instead of counting the blocked steps a second time", () => {
    firstRun({ blockedSetupSteps: 1, blockedStepKey: "a2p_brand" });

    expect(occurrences("1 step is waiting on you")).toBe(1);
    expect(document.body.textContent).not.toContain("1 step is blocked");
    // "Business registration" is STEP_LABELS.a2p_brand, the coach-facing name of the same key.
    expect(screen.getByRole("heading", { name: "Business registration" })).toBeTruthy();
  });

  it("falls back to an unnumbered name when the blocked step's key was not readable", () => {
    firstRun({ blockedSetupSteps: 3 });

    expect(occurrences("3 steps are waiting on you")).toBe(1);
    expect(document.body.textContent).not.toContain("3 steps are blocked");
    expect(screen.getByRole("heading", { name: "A step in your setup" })).toBeTruthy();
  });

  /*
   * Rule 4. One node per row, and a spine that stops at the last one. The old rail drew a single
   * absolutely positioned line behind the list, which had to guess where the bottom node sat.
   */
  it("draws one spine node per row and no connector past the last one", () => {
    firstRun({ blockedSetupSteps: 1, blockedStepKey: "a2p_brand" });

    const drawn = rows();
    expect(rail().querySelectorAll("[data-slot='rung-node']")).toHaveLength(drawn.length);
    expect(rail().querySelectorAll("[data-slot='rung-spine']")).toHaveLength(drawn.length - 1);
    for (const [index, row] of drawn.entries()) {
      expect(row.querySelectorAll("[data-slot='rung-node'] svg")).toHaveLength(1);
      expect(row.querySelectorAll("[data-slot='rung-spine']")).toHaveLength(
        index === drawn.length - 1 ? 0 : 1,
      );
    }
  });

  it("holds the same four rules while the demo override is showing the setup complete", async () => {
    renderDemoFirstRun();

    await userEvent.click(screen.getByRole("button", { name: "About this screen" }));
    await userEvent.click(screen.getByRole("button", { name: "Show setup as complete" }));

    expect(rows()).toHaveLength(2);
    expect(counter()).toEqual({ denominator: 2, numerator: 2 });
    expect(rail().querySelectorAll("[data-slot='rung-node']")).toHaveLength(2);
    expect(rail().querySelectorAll("[data-slot='rung-spine']")).toHaveLength(1);
    // No blocked row, so nothing on the page counts blocked steps at all.
    expect(document.body.textContent).not.toContain("waiting on you");
    expect(document.body.textContent).not.toContain("Blocked");
    // The rest-of-setup link outlives the override, because the override says nothing about it.
    expect(screen.getByRole("link", { name: "See the rest of your setup" })).toBeTruthy();
  });
});

/**
 * The demo setup override.
 *
 * A presentation-only, per-viewer, ten-minute stamp that lets a demo show the setup rail as
 * finished. The release boundary in `README.md` is what shapes every spec here: it writes nothing,
 * it exists only where the tenant is seeded and demo logins are on, it expires on its own, and it
 * says on the page that it is on.
 */
describe("CoachDashboard demo setup override", () => {
  function provenance() {
    const line = document.querySelector("[data-provenance]");
    if (!line) throw new Error("The dashboard printed no provenance line.");
    return line;
  }

  /**
   * A real `localStorage`, because this environment has none.
   *
   * The `ui` project runs jsdom without web storage, so `window.localStorage` is `undefined` here.
   * That is genuinely one of the arms the override has to survive, and `demo-setup-override.test.ts`
   * covers it directly; these specs are about what the screen draws when storage does work, so they
   * install one rather than asserting against the absence of it.
   */
  function installStorage() {
    const map = new Map<string, string>();
    const storage: Storage = {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key) => map.get(key) ?? null,
      key: (index) => [...map.keys()][index] ?? null,
      removeItem: (key) => {
        map.delete(key);
      },
      setItem: (key, value) => {
        map.set(key, value);
      },
    };
    Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  }

  beforeEach(() => {
    installStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "localStorage");
    vi.useRealTimers();
  });

  it("offers no control on a real coach's account, whichever gate is the one that is shut", async () => {
    const real = { ...measurement(), isDemo: false };

    // Demo logins on, tenant real.
    renderDashboard(
      { attention: { blockedSetupSteps: 1, leadsToCallBack: 0, threadsNeedingHuman: 0 },
        channelStatus: FIRST_RUN_STATUS,
        measurement: real },
      { demoAccountSwitching: true, isDemo: false },
    );
    expect(await openOverrideToggle()).toBeNull();
    expect(provenance().getAttribute("data-provenance")).toBe("real");
  });

  it("offers no control when the tenant is seeded but demo logins are off", async () => {
    renderDashboard(
      { attention: { blockedSetupSteps: 1, leadsToCallBack: 0, threadsNeedingHuman: 0 },
        channelStatus: FIRST_RUN_STATUS,
        measurement: { ...measurement(), isDemo: true } },
      { demoAccountSwitching: false, isDemo: true },
    );

    expect(await openOverrideToggle()).toBeNull();
  });

  it("offers the control on a demo tenant, and switching it on makes the header, the counter and the cards agree", async () => {
    renderDemoFirstRun();

    // Before: the state the product owner called broken. One step waiting, nothing live, and a
    // counter reading zero.
    expect(document.body.textContent).toContain("1 step is waiting on you");
    expect(document.body.textContent).toContain("0 of 3 done");

    const toggle = await openOverrideToggle();
    expect(toggle).not.toBeNull();
    await userEvent.click(toggle as HTMLElement);

    // The header line no longer says a step is waiting, and says what a finished setup would say.
    expect(document.body.textContent).toContain("Your agent is live on Instagram and Messenger");
    expect(document.body.textContent).not.toContain("step is waiting on you");
    // The counter agrees with the rungs it denominates over: two read, two done.
    expect(document.body.textContent).toContain("2 of 2 done");
    // The cards agree with both.
    expect(document.body.textContent).toContain("Live");
    expect(document.body.textContent).toContain("Registered");
    expect(document.body.textContent).not.toContain("Not live yet");
    expect(document.body.textContent).not.toContain("Not filed");
    expect(document.body.textContent).not.toContain("Blocked");
    // And the page says out loud that it is doing this.
    expect(provenance().getAttribute("data-provenance")).toBe("demo-override");
    expect(provenance().textContent).toContain("Setup is shown complete for this demo");
  });

  it("turns off in the same place it turned on, and puts the real state back", async () => {
    renderDemoFirstRun();

    await userEvent.click(screen.getByRole("button", { name: "About this screen" }));
    await userEvent.click(screen.getByRole("button", { name: "Show setup as complete" }));
    await userEvent.click(screen.getByRole("button", { name: "Show the real setup" }));

    expect(document.body.textContent).toContain("1 step is waiting on you");
    expect(document.body.textContent).toContain("0 of 3 done");
    expect(document.body.textContent).toContain("Not live yet");
    expect(provenance().getAttribute("data-provenance")).toBe("demo");
  });

  it("ignores an expired stamp and an unparseable one, and renders real state for both", async () => {
    for (const stored of [
      JSON.stringify({ expiresAt: Date.now() - 1 }),
      "{oh dear",
      JSON.stringify({ expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000 }),
    ]) {
      window.localStorage.setItem(DEMO_SETUP_OVERRIDE_KEY, stored);
      const view = renderDemoFirstRun();

      expect(provenance().getAttribute("data-provenance"), stored).toBe("demo");
      expect(document.body.textContent, stored).toContain("1 step is waiting on you");
      expect(document.body.textContent, stored).toContain("Not live yet");
      // The read is also the sweep, so a bad value does not sit there being re-read every visit.
      expect(window.localStorage.getItem(DEMO_SETUP_OVERRIDE_KEY), stored).toBeNull();

      view.unmount();
    }
  });

  it("drops the override when the ten minutes lapse, on a page nobody reloaded", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.localStorage.setItem(
      DEMO_SETUP_OVERRIDE_KEY,
      JSON.stringify({ expiresAt: Date.now() + DEMO_SETUP_OVERRIDE_MS }),
    );

    renderDemoFirstRun();
    expect(provenance().getAttribute("data-provenance")).toBe("demo-override");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEMO_SETUP_OVERRIDE_MS + 1000);
    });

    expect(provenance().getAttribute("data-provenance")).toBe("demo");
    expect(document.body.textContent).toContain("1 step is waiting on you");
  });

  it("renders the page correctly when the storage accessor itself throws", async () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("The operation is insecure.");
      },
    });

    {
      renderDemoFirstRun();

      // The page is whole, and it shows real state rather than a half-applied override.
      expect(screen.getByRole("heading", { name: "Your setup" })).toBeTruthy();
      expect(provenance().getAttribute("data-provenance")).toBe("demo");
      expect(document.body.textContent).toContain("0 of 3 done");

      // The control still works for this page view; it just cannot outlive it.
      const toggle = await openOverrideToggle();
      expect(toggle).not.toBeNull();
      await userEvent.click(toggle as HTMLElement);
      expect(provenance().getAttribute("data-provenance")).toBe("demo-override");
      expect(document.body.textContent).toContain("2 of 2 done");
    }
  });
});
