import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
        conversations: 0,
        dataLabel: "Real data",
        keyword: "REFERRAL",
        qualifiedContacts: 0,
        respondedConversations: 0,
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

function composition(): CoachLeadComposition {
  return {
    asOf: "2026-09-03T12:00:00.000Z",
    bookedByPeriod: [
      { booked: 4, month: "2026-08-01" },
      { booked: 7, month: "2026-09-01" },
    ],
    months: [
      { active: 2, disqualified: 1, label: "Aug 2026", month: "2026-08-01", partial: false, qualified: 5, total: 8 },
      { active: 3, disqualified: 1, label: "Sep 2026", month: "2026-09-01", partial: true, qualified: 6, total: 10 },
    ],
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

function renderDashboard(overrides: Partial<CoachDashboardProps> = {}) {
  return render(
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
    />,
  );
}

describe("CoachDashboard", () => {
  it("greets the coach, prints the booked figure and its allowance, and keeps the old explainers off the page", () => {
    renderDashboard();

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Welcome back, Reid");

    const booked = screen.getByRole("region", { name: "Booked" });
    expect(booked.textContent).toContain("5");
    expect(booked.textContent).toContain("18 / 25");
    expect(booked.textContent).toContain("7 to go on your 25-call plan.");

    for (const sentence of OLD_EXPLAINERS) {
      expect(document.body.textContent).not.toContain(sentence);
    }
  });

  it("draws the window pills as links that carry the window", () => {
    renderDashboard({ window: "3m" });

    const pills = screen.getByRole("navigation", { name: "Performance window" });
    expect(pills.textContent).toBe("1D1W1M3MAll");
    expect(screen.getByRole("link", { name: "3M" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "1W" })).toHaveAttribute("href", "/coach/home?window=1w");
  });

  it("draws the six-month chart as leads against booked calls", () => {
    renderDashboard();

    const trend = screen.getByRole("region", { name: "Leads and booked calls" });
    // Both legend totals are sums of the same six months, so the two lines are comparable.
    expect(trend.textContent).toContain("Leads · 18");
    expect(trend.textContent).toContain("Booked · 11");
    expect(trend.textContent).not.toContain("Qualified");
    // The month still filling reads low, so the chart says which one it is.
    expect(trend.textContent).toContain("Sep 2026 is still filling.");
  });

  it("shows the keyword row with its counts and a funnel line", () => {
    renderDashboard();

    const row = screen.getByRole("row", { name: /CCA/u });
    for (const count of ["96", "71", "28", "9"]) {
      expect(row.textContent).toContain(count);
    }
    expect(screen.getByRole("img", { name: /CCA funnel: 96 opt-ins/u })).toBeTruthy();
  });

  it("names the empty keyword table without explaining the feature", () => {
    const empty = measurement();
    renderDashboard({ measurement: { ...empty, keywords: [] } });

    expect(document.body.textContent).toContain("No keyword rows yet.");
    expect(document.body.textContent).not.toContain(
      "Keyword rows appear once a conversation is attributed to a keyword.",
    );
  });

  it("renders the setup checklist with a texting day counter instead of the figures when nothing is live", () => {
    renderDashboard({
      attention: { blockedSetupSteps: 2, leadsToCallBack: 0, threadsNeedingHuman: 0 },
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
    expect(screen.getByRole("link", { name: "Ask us" })).toHaveAttribute("href", "/coach/help");
    expect(screen.getByRole("heading", { name: "Texting registration" })).toBeTruthy();
    // A day counter, never a percentage or a predicted date.
    expect(document.body.textContent).toContain("Day 10");
    expect(document.body.textContent).not.toContain("%");
    // The figures are absent rather than invented, and the keyword table is not on this state.
    expect(screen.queryByRole("navigation", { name: "Performance window" })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Which keyword/u })).toBeNull();
  });
});
