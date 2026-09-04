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
