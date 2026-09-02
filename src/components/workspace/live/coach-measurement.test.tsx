import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  COACH_METRIC_KEYS,
  metricDefinition,
  type MetricKey,
} from "@/lib/analytics/metric-definitions";
import type {
  CoachLeadComposition,
  CoachMeasurement,
} from "@/lib/repositories/analytics";
import { CoachMeasurementSurface } from "./coach-measurement";

vi.mock("@/components/kit/export-menu", () => ({
  ExportMenu: () => <button data-testid="export-menu" type="button">Export</button>,
}));

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
      periodEnd: "2026-09-01T00:00:00.000Z",
      periodStart: "2026-08-01T00:00:00.000Z",
      state: "available",
      used: 8,
    },
    funnel: [],
    isDemo: false,
    keywords: [
      {
        bookedContacts: 2,
        conversations: 8,
        dataLabel: "Real data",
        keyword: "FUNDING",
        qualifiedContacts: 4,
        respondedConversations: 6,
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
    metrics: COACH_METRIC_KEYS.map((key) => key === "coach.active_leads"
      ? {
          ...metric(key),
          denominator: null,
          numerator: null,
          state: "still_filling" as const,
          value: null,
        }
      : metric(key)),
    pipeline: [],
    responses: [],
    tenantId: "tenant-synthetic",
    window: "1m",
    windowEnd: "2026-08-19T04:00:00.000Z",
  };
}

function composition(): CoachLeadComposition {
  return {
    asOf: "2026-08-20T12:00:00.000Z",
    months: [
      { active: 2, disqualified: 1, label: "Jul 2026", month: "2026-07-01", partial: false, qualified: 5, total: 8 },
      { active: 3, disqualified: 1, label: "Aug 2026", month: "2026-08-01", partial: true, qualified: 6, total: 10 },
    ],
    tenantId: "tenant-synthetic",
    timezone: "America/New_York",
  };
}

type Attention = Parameters<typeof CoachMeasurementSurface>[0]["attention"];

const ATTENTION: Attention = {
  blockedSetupSteps: 1,
  blockedStepKey: "a2p_campaign",
  leadsToCallBack: 2,
  longTermFollowUps: 1,
  noShows: 1,
  oldestThreadWaitMinutes: 22,
  openConversations: 312,
  threadsNeedingHuman: 3,
};

type Blocked = Parameters<typeof CoachMeasurementSurface>[0]["blockedChannel"];

function renderSurface({
  attentionValue = ATTENTION,
  billingPeriodValue = null,
  blockedChannelValue = null,
  compositionValue = composition(),
  measurementValue = measurement(),
}: {
  attentionValue?: Attention;
  billingPeriodValue?: { periodStart: string; periodEnd: string } | null;
  blockedChannelValue?: Blocked;
  compositionValue?: CoachLeadComposition;
  measurementValue?: CoachMeasurement;
} = {}) {
  return render(
    <CoachMeasurementSurface
      attention={attentionValue}
      billingPeriod={billingPeriodValue}
      blockedChannel={blockedChannelValue}
      composition={compositionValue}
      measurement={measurementValue}
      window="1m"
    />,
  );
}

/**
 * One panel of the deck, found by the metric it names.
 *
 * These queries used to name two `StatStrip`s by `aria-label` -- "Coach outcome summary" and
 * "Coach performance summary". Both are gone: the page now says its numbers once, in a single
 * `CoachDeck`, because the two strips were the same figures under two headings and the difference
 * needed a source comment to explain. Neither aria-label exists in `src/` any more, so every query
 * through them was resolving to `null` and failing on the null check rather than on anything it
 * meant to assert.
 *
 * Scoping still matters for the same reason it did before: every metric label appears twice on the
 * page, once as its panel heading and once as the `<dt>` of the "How these are measured" list. So
 * this walks the panels and matches on `.coach-panel__name` exactly, rather than taking whatever
 * ancestor the first text match happened to sit in.
 *
 * The names these are called with changed on 2026-09-01, from the metric labels
 * ("Booked contacts", "Active leads", "Lead-to-booked conversion") to the coach language the
 * design canvas names the same six figures in ("Booked", "Active", "Conversion"). That is a
 * rename, not a weakening: every assertion below still names one specific panel and still fails
 * loudly if that panel stops rendering, because `panel()` throws on a name it cannot find. The
 * metric labels did not disappear -- they are the `<dt>`s of the "How these are measured" list,
 * which is why scoping to `.coach-panel__name` is still what keeps these queries honest.
 */
function panel(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll<HTMLElement>(".coach-panel")).find(
    (node) => (node.querySelector(".coach-panel__name")?.textContent ?? "").trim() === label,
  );
  expect(match, `no deck panel is named ${label}`).toBeTruthy();
  return match as HTMLElement;
}

/** The figure slot of a deck panel -- the large reading, or the absent arm's phrase. */
function figureOf(root: HTMLElement) {
  return root.querySelector(".coach-panel__figure");
}

/**
 * The deck's one phrase for having no reading.
 *
 * Capital N, and asserted through this constant rather than inline: `StatStrip` wrote "not yet"
 * lowercase, the deck writes "Not yet", and a stale lowercase literal in one of these tests would
 * pass `toHaveTextContent` anyway -- it matches on substring, case-sensitively, so "not yet" would
 * simply never match and read as a broken component instead of a stale test.
 */
const ABSENT = "Not yet";

function withMetric(
  key: MetricKey,
  replacement: Partial<CoachMeasurement["metrics"][number]>,
) {
  const value = measurement();
  return {
    ...value,
    metrics: value.metrics.map((entry) => entry.metricKey === key
      ? { ...entry, ...replacement }
      : entry),
  };
}

describe("CoachMeasurementSurface", () => {
  it("commits each preset window before submitting it exactly once", async () => {
    const submittedWindows: FormDataEntryValue[] = [];
    const requestSubmit = vi
      .spyOn(HTMLFormElement.prototype, "requestSubmit")
      .mockImplementation(function (this: HTMLFormElement) {
        submittedWindows.push(new FormData(this).get("window") ?? "missing");
      });
    const { container } = renderSurface();

    fireEvent.click(container.querySelector('[data-segment="1w"]') as HTMLButtonElement);
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(1));
    expect(submittedWindows).toEqual(["1w"]);

    fireEvent.click(container.querySelector('[data-segment="3m"]') as HTMLButtonElement);
    await waitFor(() => expect(requestSubmit).toHaveBeenCalledTimes(2));
    expect(submittedWindows).toEqual(["1w", "3m"]);
    requestSubmit.mockRestore();
  });

  it("renders one export menu for its one visible table", () => {
    const { container } = renderSurface();
    expect(container.querySelectorAll('[data-testid="export-menu"]')).toHaveLength(1);
  });

  it("puts a number or an honest 'not yet' in every metric figure slot, never prose", () => {
    const { container } = renderSurface();
    const semanticFigures = Array.from(container.querySelectorAll("figure"));
    const metricFigures = Array.from(container.querySelectorAll(".coach-panel__figure"));

    // The figure slot holds exactly two kinds of thing: a reading, or the strip's one phrase for
    // having none. A sentence in a figure slot is the failure this guards -- "No conversations
    // yet in this window" belongs on the note line under the figure, not where the number goes.
    //
    // A duration reading carries its unit inside the figure, because `formatMetric` renders one
    // through Intl's `unit` style: "5 sec", "8.4 min", "2 hr". That is a reading with a letter in
    // it, not prose, so the shape is spelled out rather than the letter test being dropped -- a
    // figure still fails on anything that is not a number, a number with its unit, or "not yet".
    const DURATION_READING = /^-?[\d,.]+\s(?:sec|min|hr)$/u;
    for (const figure of [...semanticFigures, ...metricFigures]) {
      const text = (figure.textContent ?? "").trim();
      if (/[A-Za-z]/u.test(text) && !DURATION_READING.test(text)) expect(text).toBe(ABSENT);
    }
    expect(metricFigures.length).toBeGreaterThan(0);
  });

  /*
   * `Main.dc.html` draws four columns of plain counts. What stood here was five columns with
   * three of them rendered as percentages of the conversation count -- rates that were derivable
   * from figures already on the row, and that needed a whole absent-figure treatment for a
   * keyword with no conversations, where the honest reading is a count of zero.
   *
   * This keeps the original guard's real subject: no manufactured share. The keyword with no
   * conversations now reads 0 in every column, and no cell on the table says "%" at all.
   */
  it("toggles exact keyword stages between counts and documented percentages", () => {
    const { getByLabelText, getByText } = renderSurface();
    const table = getByLabelText("Keyword performance");

    const headers = Array.from(table.querySelectorAll("thead th"))
      .map((cell) => (cell.textContent ?? "").trim())
      .filter(Boolean);
    expect(headers).toEqual(["Keyword", "Opt-ins", "Qualified", "Booked"]);
    expect(table.textContent).not.toContain("%");
    expect(table.textContent).not.toContain("Responded");

    const empty = getByText("REFERRAL").closest("tr");
    expect(
      Array.from(empty?.querySelectorAll("td") ?? []).map((cell) => (cell.textContent ?? "").trim()),
    ).toEqual(["REFERRAL", "0", "0", "0"]);

    const populated = getByText("FUNDING").closest("tr");
    expect(
      Array.from(populated?.querySelectorAll("td") ?? []).map((cell) => (cell.textContent ?? "").trim()),
    ).toEqual(["FUNDING", "8", "4", "2"]);

    fireEvent.click(screen.getByRole("button", { name: "Percent" }));
    expect(table.textContent).toContain("100%");
    expect(table.textContent).toContain("50%");
    expect(table.textContent).toContain("25%");
    const emptyPercent = getByText("REFERRAL").closest("tr");
    expect(emptyPercent).toHaveTextContent("0%");
    expect(emptyPercent).toHaveTextContent("not yet");
    expect(screen.getByText(/share of all keyword opt-ins/i)).toBeVisible();
  });

  it.each([0, null])(
    "renders conversion as unavailable when its denominator is %s",
    (denominator) => {
      const measurementValue = withMetric("coach.conversion_rate", {
        denominator,
        numerator: 0,
        state: "still_filling",
        value: null,
      });
      const { container } = renderSurface({ measurementValue });
      const metricRoot = panel(container, "Conversion");

      const figure = figureOf(metricRoot);
      // A conversion with no denominator has no reading at all, so the panel says so in words
      // rather than showing a 0% that claims nobody converted. Asserted as the whole text of the
      // figure slot, not as a substring: "0%" plus the phrase somewhere in the same box would
      // satisfy `toHaveTextContent` and is exactly the failure being guarded against.
      expect(figure?.textContent?.trim()).toBe(ABSENT);
      // The absent arm is a styled child rather than the `data-state`/`italic` markers `StatStrip`
      // carried, so what is asserted is that the slot is rendering the absent treatment at all --
      // a bare formatted number would have no element wrapping it.
      expect(figure?.querySelector("span")).toBeTruthy();
      expect(metricRoot.textContent).toContain("There is no eligible activity for this calculation.");
      expect(metricRoot.textContent).not.toContain("Day");
    },
  );

  /**
   * Inverted, deliberately, and this is the assertion that matters most in the file.
   *
   * This test used to require a day counter on an analytics panel: `day 1` over "of about 1
   * needed". That requirement is what produced the defect the client saw -- `dayProgress` measures
   * the *selected analytics window*, not the age of the account, so on the default 1M window it
   * returns day 31 of 31 and all six panels read "Day 31 / of about 31 days needed before this
   * reads". That is meaningless as a number (the window has fully elapsed) and false as a sentence
   * (nothing is waiting on 31 days of anything).
   *
   * The honest-states rule does require a real day counter, but it belongs to provisioning, where
   * elapsed days are the honest answer to "how long" for a process with no predictable end -- A2P
   * carrier review. An analytics window that simply accumulated no completed event is not that, and
   * spending the day counter here dilutes the one place it means something.
   *
   * So the assertion is now the opposite of what it was: an analytics panel with no reading prints
   * the absent phrase and says nothing is complete yet, and prints no day count at all. If a future
   * change reintroduces one, this fails.
   */
  it("never prints a day counter for an un-elapsed analytics window", () => {
    const measurementValue = withMetric("coach.active_leads", {
      state: "still_filling",
      value: null,
      windowEnd: "2026-08-21T00:00:00.000Z",
      windowStart: "2026-08-20T00:00:00.000Z",
    });
    const { container } = renderSurface({ measurementValue });
    const metricRoot = panel(container, "Active");

    expect(figureOf(metricRoot)?.textContent?.trim()).toBe(ABSENT);
    expect(metricRoot.textContent).toContain("Nothing has completed in this window yet.");
    // Neither the counter itself nor the sentence it used to sit under.
    expect(metricRoot.textContent).not.toMatch(/\bday \d/iu);
    expect(metricRoot.textContent).not.toContain("needed");
    // And it is not the whole deck quietly regressing: the page-wide check that no panel anywhere
    // carries the provisioning treatment, which is how "Day 31" reached six panels at once.
    expect(container.querySelector(".coach-panel")?.textContent).not.toMatch(/\bday \d/iu);
  });

  it("renders unavailable when a history metric has no valid clock", () => {
    // `state`/`value` are spelled out even though `measurement()` already special-cases
    // `coach.active_leads` to still-filling/null. They are what sends this metric down the
    // history-clock arm at all -- `availableMetric` returns a value whatever the window bounds
    // say -- so the test's whole meaning rests on them, and leaving them implicit in a fixture
    // fifty lines away means an unrelated edit there silently turns this into an assertion about
    // a metric that renders a number.
    const measurementValue = withMetric("coach.active_leads", {
      state: "still_filling",
      value: null,
      windowEnd: null,
      windowStart: null,
    });
    const { container } = renderSurface({ measurementValue });
    const metricRoot = panel(container, "Active");

    expect(figureOf(metricRoot)?.textContent?.trim()).toBe(ABSENT);
    expect(metricRoot.textContent).toContain("No valid history clock is available for this window.");
  });

  /**
   * The line between this page and `FigureStrip`, asserted rather than commented.
   *
   * `FigureStrip` has one absent arm covering both "we could not read this" and "we read it and
   * the answer is none". On an analytics page those are different claims about the coach's
   * business: nobody booked a call this window, versus we cannot tell you whether anyone did. A
   * swap onto that component would render this fixture as an absence, and this test is what stops
   * it.
   */
  it("prints a measured zero as 0 and an unreadable metric as not yet", () => {
    const measurementValue = withMetric("coach.booked_contacts", {
      denominator: 12,
      numerator: 0,
      state: "available",
      value: 0,
    });
    const { container } = renderSurface({ measurementValue });

    const booked = panel(container, "Booked");
    // Exactly "0", and nothing else in the slot: a measured zero is a real reading the query
    // returned, and the whole point of the arm is that it must not be routed through the absent
    // treatment, which would turn a true answer into a different and false claim.
    expect(figureOf(booked)?.textContent?.trim()).toBe("0");
    expect(booked.textContent).not.toContain(ABSENT);

    // The other arm, on the same render: active leads has no reading at all in this fixture.
    const active = panel(container, "Active");
    expect(figureOf(active)?.textContent?.trim()).toBe(ABSENT);
  });

  /**
   * Screen 2a draws a sentence under every queue count. Each of those turned out to be a column,
   * so each has to render from the column rather than from a phrase written into the surface: a
   * queue line that says "the oldest has waited 22 min" while nothing measured a wait is the same
   * fabricated statistic the design rules ban, only harder to notice because it looks specific.
   */
  it("says why each queue is waiting from the facts it was handed, and nothing when it has none", () => {
    const { container } = renderSurface();
    const queue = container.querySelector('[aria-labelledby="coach-attention-heading"]');

    expect(queue?.textContent).toContain("The oldest has waited 22 min.");
    expect(queue?.textContent).toContain("1 no show and 1 long term follow up.");
    // The blocked step names itself from `step_key`, never from the operator-authored
    // `blocked_reason`, which has no contract about who is allowed to read it.
    expect(queue?.textContent).toContain("Campaign registration is blocked");

    // A caller with no derived facts renders three counts and no sentences at all.
    const bare = renderSurface({
      attentionValue: { blockedSetupSteps: 1, leadsToCallBack: 2, threadsNeedingHuman: 3 },
    });
    const bareQueue = bare.container.querySelector('[aria-labelledby="coach-attention-heading"]');
    expect(bareQueue?.textContent).toContain("Threads needing a human");
    expect(bareQueue?.textContent).not.toMatch(/has waited|no show|blocked/u);
    /*
     * The open-conversation readout is off the page. It sat in the header's action slot and
     * `SIMPLIFICATION-SPEC.md` §2.1 KILLs it there; `Main.dc.html` draws the greeting and the
     * range picker beside it and nothing else. The count itself is not lost -- it is what the
     * Active panel's two stats sum to -- so what is asserted now is that no header figure came
     * back, rather than that one is present.
     */
    expect(bare.queryByText(/\d+ open conversations/u)).toBeNull();
  });

  /**
   * The artifact's header pill reads "Setter live · 312 open threads". Liveness is a claim about
   * channel receipts this page never reads, so the readout counts and says nothing else. This
   * guard is what stops the pill's other half being pasted back in.
   */
  it("counts open conversations without claiming the setter is live", () => {
    const { container } = renderSurface();
    expect(container.textContent).not.toMatch(/setter live|all set|everything is running/iu);
  });

  const BLOCKED = {
    channelLabel: "Instagram",
    connectionId: "conn-1",
    // Null by default because it is the common case: only the credential-quarantine migration
    // ever wrote this column, so most blocked connections carry no recorded cause.
    providerReason: null,
    signedRoundTripAt: null,
    state: "expired",
    stoppedAt: "2026-08-30T18:41:00.000Z",
    unprocessedEvents: 14,
  };

  /**
   * The three claims screen 5c makes that the code does not support, pinned as absences.
   *
   * The artifact reads "14 threads are being held, nothing is dropped, and they replay in order
   * the moment you reconnect". Replay is one named receipt at a time through
   * `/api/channel-actions/[connectionId]/replay`, nothing runs it on reconnect, and nothing
   * orders it. "Held" is also the word `process-inbound` uses for a reply the safety screen
   * withheld, so it is avoided here entirely. This test is what stops the comfortable sentence
   * coming back, since it reads as reassurance rather than as a claim anyone would check.
   */
  it("says messages are recorded without promising a replay nothing performs", () => {
    const { container } = renderSurface({ blockedChannelValue: BLOCKED });
    const queue = container.querySelector('[aria-labelledby="coach-attention-heading"]');

    expect(queue?.textContent).toContain("Your Instagram sign in stopped working");
    expect(queue?.textContent).toContain("Nothing is lost, and nothing is sent until you reconnect.");
    expect(queue?.textContent).not.toMatch(/replay|in order|held|nothing is dropped/iu);

    // The one fill goes to the outage: reconnecting unblocks every other line on the card.
    const fill = within(queue as HTMLElement).getByRole("link", { name: "Reconnect Instagram" });
    expect(fill.className).toContain("bg-[var(--accent-fill)]");
    expect(queue?.querySelectorAll(".bg-\\[var\\(--accent-fill\\)\\]")).toHaveLength(1);
  });

  /**
   * `outbound_send_attempts.status` has an `indeterminate` arm whose column comment says provider
   * acceptance cannot be ruled out. The artifact's "what leads see: nothing, no failed sends"
   * asserts exactly what that state exists to deny, so the dialog must never say it.
   */
  it("opens the outage detail without claiming what leads did or did not see", () => {
    renderSurface({ blockedChannelValue: BLOCKED });
    fireEvent.click(screen.getByRole("button", { name: "See what is affected" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("14 events, not yet grouped into threads");
    // The absent arm, and only the absent arm: this fixture's `error` is null, so the row is
    // omitted rather than rendered blank. The two tests below cover the column carrying a value.
    expect(dialog.textContent).not.toMatch(/recorded reason/iu);
    // The signed round trip is a real gate with no writer yet (docs/GAPS.md, 2026-08-31), so the
    // step names the gate and refuses to promise how long it takes.
    expect(dialog.textContent).toContain("Nothing reads connected until that comes back");
    expect(dialog.textContent).toContain("we do not promise how long it takes");
    expect(dialog.textContent).toContain("separate step somebody runs per message");
    expect(dialog.textContent).not.toMatch(/what leads see|no failed sends|nothing was missed/iu);
  });

  /**
   * `20260905000010_backend_security_sagas.sql:62` sets this exact token, with `state = 'error'`,
   * on every connection whose credential was quarantined as undecryptable pre-envelope ciphertext.
   * It runs once as a migration and its rows persist, so a coach can be blocked by it today. The
   * dialog refused to read the column for a while on the false premise that every writer sets
   * null, which left that coach with no cause on screen while the database held it.
   */
  it("states the recorded reason in words, rather than the token the database stores", () => {
    renderSurface({
      blockedChannelValue: { ...BLOCKED, providerReason: "LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED" },
    });
    fireEvent.click(screen.getByRole("button", { name: "See what is affected" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Recorded reason");
    expect(dialog.textContent).toContain("predates our current credential system");
    expect(dialog.textContent).not.toContain("LEGACY_CREDENTIAL_REAUTHORIZATION_REQUIRED");
  });

  // Translate what can be enumerated, show the rest verbatim, hide nothing. A cause we have no
  // wording for is still the only cause on file, and swallowing it would be the same defect as
  // refusing the column was.
  it("shows an untranslated reason verbatim rather than hiding it", () => {
    renderSurface({ blockedChannelValue: { ...BLOCKED, providerReason: "SOME_FUTURE_TOKEN" } });
    fireEvent.click(screen.getByRole("button", { name: "See what is affected" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Recorded reason");
    expect(dialog.textContent).toContain("SOME_FUTURE_TOKEN");
  });

  it("counts events as unknown rather than zero when the read failed", () => {
    renderSurface({ blockedChannelValue: { ...BLOCKED, unprocessedEvents: null } });
    fireEvent.click(screen.getByRole("button", { name: "See what is affected" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("could not be counted just now");
    expect(dialog.textContent).not.toMatch(/\b0 events\b/u);
  });

  it("waits for two active months before drawing the trend", () => {
    const compositionValue = {
      ...composition(),
      months: [
        { active: 0, disqualified: 0, label: "Jul 2026", month: "2026-07-01", partial: false, qualified: 0, total: 0 },
        { active: 3, disqualified: 1, label: "Aug 2026", month: "2026-08-01", partial: true, qualified: 6, total: 10 },
      ],
    };
    const { container, getByText } = renderSurface({ compositionValue });

    expect(getByText("Lead volume appears after two calendar months record activity.")).toBeTruthy();
    expect(container.querySelector(".trend__chart path")).toBeNull();
  });
});

describe("the deck", () => {
  function panels(container: HTMLElement) {
    const found = Array.from(container.querySelectorAll<HTMLElement>(".coach-panel"));
    expect(found.length, "the deck did not render").toBeGreaterThan(0);
    return found;
  }

  it("gives every panel a figure, because a panel without one is a heading over nothing", () => {
    const { container } = renderSurface();
    const found = panels(container);

    expect(found).toHaveLength(6);
    for (const item of found) {
      expect(figureOf(item), `${item.querySelector(".coach-panel__name")?.textContent} has no figure`)
        .toBeTruthy();
    }
  });

  // The artifact's fourth tile is "8s first reply". Nothing measures the gap between an inbound
  // message and our answer, so the tile cannot be filled from a row, and a plausible latency is
  // the exact kind of number this product does not print.
  it("never claims a reply-latency figure", () => {
    const { container } = renderSurface();
    expect(container.textContent).not.toMatch(/first reply|reply time|response time/iu);
  });

  /**
   * The same rule this file always enforced, against the structure that replaced the one it was
   * written for.
   *
   * It used to read "shares no figure with the performance strip", and checked that the outcome
   * strip and the performance strip named disjoint metrics -- two strips on one page being honest
   * only while they answer different questions. Those two strips were merged into this one deck
   * precisely because they kept failing that rule in the reader's eyes even when they passed it in
   * the markup. The rule survives the merge: no metric may be drawn twice as a figure, so a coach
   * never has to work out whether two numbers on one screen are the same number.
   */
  it("draws no metric twice", () => {
    const { container } = renderSurface();
    const names = panels(container).map((item) =>
      (item.querySelector(".coach-panel__name")?.textContent ?? "").trim(),
    );

    expect(names.length).toBeGreaterThan(0);
    expect(names).toEqual([...new Set(names)]);
  });

  it("names the window it counts, and points at the control in the head that sets it", () => {
    const { container } = renderSurface();
    expect(container.textContent).toContain("1 month of leads, set above");
  });

  /**
   * The defect the client photographed on 2026-09-01: six panels reading "Not yet" over a book
   * of 37 active leads. The RPC marks every preset window `still_filling` until local midnight,
   * so a coach who never picks a custom range never gets an `available` row, and refusing the
   * state refused every number on the page for the life of the account. An open window is a
   * reading with a caveat: the figure prints, and the caveat prints once under the deck rather
   * than as "Not yet" on every panel.
   */
  it("prints a still-filling count as its number and marks the open window once, under the deck", () => {
    const measurementValue = withMetric("coach.new_leads", {
      denominator: 37,
      numerator: 37,
      state: "still_filling",
      value: 37,
      windowEnd: "2026-09-02T00:00:00.000Z",
      windowStart: "2026-08-02T00:00:00.000Z",
    });
    const { container } = renderSurface({ measurementValue });
    const metricRoot = panel(container, "Leads");

    expect(figureOf(metricRoot)?.textContent?.trim()).toBe("37");
    expect(metricRoot.textContent).not.toContain(ABSENT);
    expect(container.textContent).toContain("Counted through today, so this window is still filling.");
  });

  it("does not claim a window is still filling when every row has closed", () => {
    const measurementValue = withMetric("coach.active_leads", {
      denominator: 10,
      numerator: 5,
      state: "available",
      value: 5,
    });
    const { container } = renderSurface({ measurementValue });
    expect(container.textContent).not.toContain("still filling");
  });

  /**
   * The deck names its figures in coach language, and the metric labels stay reachable.
   *
   * Two drifts in one assertion. The first is a deck that reverts to `metricDefinition().label`,
   * which is written for whoever reasons about the query and reads like a schema on the surface
   * built for the coach who told us the product was hard to read. The second is the overcorrection
   * -- renaming the panels and letting the exact metric label disappear from the page, which would
   * leave "Not a fit" on screen with nothing anywhere saying which population it counts.
   */
  it("names the six figures the way a coach says them, and keeps the metric labels in the disclosure", () => {
    const { container } = renderSurface();
    const names = panels(container).map((item) =>
      (item.querySelector(".coach-panel__name")?.textContent ?? "").trim(),
    );

    expect(names).toEqual([
      "Booked",
      "Not a fit",
      "Active",
      "Conversion",
      "Leads",
      "Avg time to book",
    ]);
    for (const label of [
      metricDefinition("coach.disqualified_leads").label,
      metricDefinition("coach.conversion_rate").label,
      metricDefinition("coach.average_time_to_book").label,
      metricDefinition("coach.qualified_leads").label,
    ]) {
      expect(container.textContent, `${label} is on screen nowhere`).toContain(label);
    }
  });

  /**
   * The deck is dealt, not tiled.
   *
   * `auto-fit` sized all six panels off one 210px floor, which is what made the deck read as a
   * table of tiles: every panel the same height whatever its content, so the not-a-fit panel's two
   * footer rows stretched the panel beside it. `Main.dc.html` draws three columns, each panel as
   * tall as its own content, with the first column dropped 34px and the third 14px. The order is
   * the load-bearing half: it is column-major, and the two accents land in different columns
   * because of it, so a change that deals the items across the columns instead fails here.
   */
  it("deals the deck into three staggered columns in the canvas's order", () => {
    const { container } = renderSurface();
    const columns = Array.from(container.querySelectorAll<HTMLElement>("[data-deck-column]"));

    expect(columns).toHaveLength(3);
    expect(columns.map((column) => Array.from(
      column.querySelectorAll<HTMLElement>(".coach-panel__name"),
    ).map((node) => node.textContent))).toEqual([
      ["Booked", "Not a fit"],
      ["Active", "Conversion"],
      ["Leads", "Avg time to book"],
    ]);
    // No stagger. The canvas offsets the first column 34px and the third 14px; the built page read
    // as broken alignment rather than as a hand-dealt deck, so all three share one top line.
    columns.forEach((column) => expect(column.className).not.toMatch(/pt-\[\d+px\]/u));
  });

  /**
   * The allowance bar, and the case where it must not be drawn.
   *
   * The figures already say "8 / 25" in words, so the bar adds one thing only: how close to the
   * edge the month is. That is worth drawing where there is an allowance to divide by and is a
   * lie where there is not -- a limit of zero makes the share undefined, and a bar with no width
   * over "0 / 0" still reads as a plan with a limit in it. So that case keeps the words and drops
   * the bar rather than drawing an empty one.
   */
  it("draws the allowance bar only where a real allowance exists to divide by", () => {
    const { container } = renderSurface();
    const meter = panel(container, "Booked").querySelector<HTMLElement>('[data-slot="meter"]');

    expect(meter, "the Booked panel drew no allowance bar").toBeTruthy();
    expect((meter?.firstElementChild as HTMLElement).style.width).toBe("32%");

    // A recorded billing period whose limit is zero: the reading exists, the share does not.
    const noAllowance = renderSurface({
      measurementValue: {
        ...measurement(),
        allowance: {
          limit: 0,
          periodEnd: "2026-09-01T00:00:00.000Z",
          periodStart: "2026-08-01T00:00:00.000Z",
          state: "available",
          used: 0,
        },
      },
    });
    const absent = panel(noAllowance.container, "Booked");
    expect(absent.querySelector('[data-slot="meter"]')).toBeNull();
    expect(absent.textContent).toContain("Monthly plan progress");
  });

  /**
   * Two footer shapes, and which panel gets which is the claim being made.
   *
   * `Main.dc.html` draws the not-a-fit and active footers as dot-led rows read down, because each
   * is two named halves of the figure above it, and draws the conversion and leads footers as a
   * side-by-side pair read across, because each is a funnel step beside the step before it. Giving
   * every panel one shape is what made the old deck read as a table: a reader who sees the same
   * two-up layout under every figure has no way to tell a split from a sequence.
   */
  it("splits a figure down and reads a funnel across", () => {
    const { container } = renderSurface();

    for (const [name, rows] of [
      ["Not a fit", ["Worth keeping warm", "Ended politely"]],
      ["Active", ["Agent handling", "Needs you"]],
    ] as const) {
      const found = Array.from(
        panel(container, name).querySelectorAll<HTMLElement>('[data-slot="deck-stat"]'),
      );
      expect(found.map((node) => node.querySelector('[data-slot="deck-stat-label"]')?.textContent))
        .toEqual(rows);
      // The dot is what makes a row a row. One per reading, and it is decoration: the label
      // beside it carries the same distinction in words.
      for (const row of found) {
        expect(row.querySelector("[aria-hidden]"), `${name} drew a row without its dot`).toBeTruthy();
      }
    }

    for (const name of ["Conversion", "Leads"] as const) {
      const found = panel(container, name).querySelectorAll('[data-slot="deck-stat"]');
      expect(found).toHaveLength(2);
      // The pair keeps the stacked label-over-figure cell, which is the class the coach stylesheet
      // lays out side by side.
      expect(found[0].className).toContain("coach-panel__stat");
    }
  });

  /**
   * Two drenches per screen and not a third, which is the rule the deck was rebuilt around.
   *
   * It was one until the design canvas was audited. `Main.dc.html` draws two saturated panels and
   * comments the second "the second and last accent spend on this page", and `CLAUDE.md` states
   * the same budget as a number: the accent spent no more than twice per screen. So the count is
   * two, and which two is pinned by name as well -- Booked, the outcome the coach opened the page
   * for, and Conversion, the one figure that judges the whole funnel rather than counting a stage
   * of it. The failure mode this catches is unchanged and is the reason the names are here: a lane
   * adding a saturated panel because its figure feels important, and every figure on this page
   * feels important to whoever added it.
   */
  it("drenches exactly the two panels the canvas drenches, and heroes one", () => {
    const { container } = renderSurface();
    const drenched = panels(container).filter((item) => item.getAttribute("data-drench"));

    expect(drenched.map((item) => item.querySelector(".coach-panel__name")?.textContent))
      .toEqual(["Booked", "Conversion"]);
    expect(drenched.map((item) => item.getAttribute("data-drench"))).toEqual(["live", "info"]);
    // The hero is still one panel: the larger top corners lead the deck, and two panels leading it
    // is no lead at all.
    expect(panels(container).filter((item) => item.getAttribute("data-hero"))).toHaveLength(1);
    expect(drenched[0].getAttribute("data-hero")).toBe("true");
  });

  /**
   * The four supporting readings the design canvas draws that our reads cannot produce.
   *
   * This is the assertion that stops the artboard from being ported literally. Splitting ruled-out
   * leads into kept-warm and ended-politely needs `contacts.outcome`, which no coach metric key
   * projects; the `pipeline_stage` alternative would count a kept-warm lead inside the Active
   * panel as well as this one. "Answered back" would have to come from the keyword rollup, which
   * counts conversations where the figure above it counts contacts. So each keeps its label, prints
   * no number, and the panel says why -- and a future change that quietly fills one of them in with
   * a lookalike figure fails here.
   */
  it("keeps the shape of the readings it cannot source, and prints no lookalike figure", () => {
    const { container } = renderSurface();

    const notAFit = panel(container, "Not a fit");
    // The positive control: the panel itself rendered a real figure, so the absences below are
    // absences rather than a panel that failed to render at all.
    expect(figureOf(notAFit)?.textContent?.trim()).toBe("5");
    for (const label of ["Worth keeping warm", "Ended politely"]) {
      // Addressed by `data-slot` rather than by the class the pair layout happens to use: this
      // footer is the canvas's dot-led row list now, and the assertion is about the reading
      // keeping its slot, not about which of the two footer shapes it keeps it in.
      const stat = Array.from(notAFit.querySelectorAll('[data-slot="deck-stat"]')).find(
        (node) => node.querySelector('[data-slot="deck-stat-label"]')?.textContent === label,
      );
      expect(stat, `${label} lost its slot instead of keeping it`).toBeTruthy();
      expect(stat?.querySelector('[data-absent="true"]')).toBeTruthy();
      expect(stat?.textContent).not.toMatch(/\d/u);
    }
    expect(notAFit.textContent).toContain("not stored split into these two");

    const leads = panel(container, "Leads");
    const answered = Array.from(leads.querySelectorAll('[data-slot="deck-stat"]')).find(
      (node) => node.querySelector('[data-slot="deck-stat-label"]')?.textContent === "Answered back",
    );
    expect(answered?.querySelector('[data-absent="true"]')).toBeTruthy();
    expect(leads.textContent).toContain("counted per conversation, not per lead");
    // And the reading beside it, which does come from the same cohort, is a real number.
    expect(leads.textContent).toContain("Qualified");
  });

  /**
   * A footer counted over a different population says so, rather than leaving the layout to imply
   * it is a slice of the figure above.
   *
   * Open conversations are not the active-contact cohort and the billing period is not the
   * analytics window. Both pairs are honest numbers in the wrong-looking place, and the note is the
   * only thing that makes the placement safe.
   */
  it("names the population whenever a footer is not counted over the figure's own", () => {
    const { container } = renderSurface();

    const active = panel(container, "Active");
    // 312 open conversations less the 3 needing a human. Both halves come from the same table at
    // the same instant, and their total is already printed in the page header.
    expect(active.textContent).toContain("309");
    expect(active.textContent).toContain("Agent handling");
    expect(active.textContent).toContain("Needs you");
    expect(active.textContent).toContain("Counted over open conversations");

    const booked = panel(container, "Booked");
    expect(booked.textContent).toContain("Monthly plan progress");
    expect(booked.textContent).toContain("8 / 25");
    expect(booked.textContent).toContain("Counted over your billing period");
  });

  /**
   * The basis line comes from the average's own denominator, not from a second count of bookings.
   *
   * `coach.average_time_to_book` averages over cohort contacts with a first non-canceled
   * appointment, and that population is what `denominator` carries. Reading `coach.booked_contacts`
   * instead would usually agree and would stop agreeing the moment either definition moved, which
   * is the drift a stated basis exists to make impossible -- so the fixture gives the two metrics
   * different numbers and this asserts which one reached the screen.
   */
  it("states how many calls the average was measured over, from the metric's own denominator", () => {
    const measurementValue = withMetric("coach.average_time_to_book", { denominator: 18 });
    const { container } = renderSurface({ measurementValue });
    const timeToBook = panel(container, "Avg time to book");

    expect(timeToBook.textContent).toContain("Measured over the 18 calls booked this month.");
    expect(timeToBook.textContent).toContain(
      "Average time from a lead's first message to a call on your calendar.",
    );
  });

  /**
   * The sentences follow the window control, and the design canvas's "this month" is not hard-coded.
   *
   * The canvas draws every sentence against a month because a month is what it happens to show. A
   * literal port would print "ruled out this month" on the 1D window, which is a false statement
   * about the coach's own business made by copy rather than by a number -- and copy is the half of
   * the honest-states rule that nothing else on this page checks.
   */
  it("says which window each sentence counts over rather than always saying this month", () => {
    const { container } = render(
      <CoachMeasurementSurface
        attention={ATTENTION}
        composition={composition()}
        measurement={{ ...measurement(), window: "1d" }}
        window="1d"
      />,
    );

    expect(container.textContent).toContain("Leads your agent ruled out today");
    expect(container.textContent).toContain("Everyone your agent reached today.");
    expect(container.textContent).not.toContain("ruled out this month");
  });
});

describe("the company trend", () => {
  /**
   * The axis writes months out, and the partial-month footnote is a sentence rather than a
   * truncation.
   *
   * "Aug 2026 is still filling" was doing the right job in the wrong voice: the abbreviation reads
   * as a word that got cut off, and the coach scale has the width for the whole one. What is
   * load-bearing underneath the wording is unchanged -- the month named is the composition's own
   * `partial` flag, never a guess from today's date.
   */
  it("writes its months out and says in words why the last one is short", () => {
    const { container } = renderSurface();

    expect(container.textContent).toContain("Company trend");
    expect(container.textContent).toContain("August");
    expect(container.textContent).toContain("July");
    expect(container.textContent).toContain(
      "August is lighter because the month is not over yet.",
    );
    expect(container.textContent).not.toContain("Aug 2026 is still filling");
  });

  /**
   * The chart gets a download and the page keeps exactly one export menu.
   *
   * A second `ExportMenu` here would claim there are two exportable tables on the screen when
   * there is one, and the six numbers behind this chart are already in the browser, so a server
   * round-trip would only add a way for the download to fail.
   */
  it("offers the trend as a file without adding a second export menu", () => {
    const { container, getByRole } = renderSurface();

    expect(getByRole("button", { name: "Download" })).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="export-menu"]')).toHaveLength(1);
  });

  it("names the keyword table by what a coach is asking it", () => {
    const { container } = renderSurface();

    expect(container.textContent).toContain("Where your leads come from");
    expect(container.textContent).toContain("Which keyword brings the best leads");
    // The denominator sentence keeps each percentage reproducible from exported counts.
    expect(container.textContent).toContain(
      "Percent view uses each keyword's share of all keyword opt-ins",
    );
    expect(container.textContent).toContain("Booked");
  });
});

describe("the greeting", () => {
  /**
   * A name is the cheapest thing on the design canvas to fake and the most obviously wrong when it
   * addresses the wrong person, so the surface prints one only when it was handed one.
   *
   * The null arm covers three situations that must render identically: the read failed, the row
   * has no name, and a platform user is reading this page under impersonation. The last is the
   * one that matters -- that reader has a real name and it is the wrong name for this page.
   */
  it("greets the coach when it was given a name, and falls back to the page's own title otherwise", () => {
    const { container } = render(
      <CoachMeasurementSurface
        attention={ATTENTION}
        composition={composition()}
        greeting="Marcus"
        measurement={measurement()}
        window="1m"
      />,
    );
    expect(container.textContent).toContain("Welcome back, Marcus");

    const { container: anonymous } = renderSurface();
    expect(anonymous.textContent).toContain("Dashboard");
    expect(anonymous.textContent).not.toContain("Welcome back");
  });
});

/**
 * The console's overline, off the coach surface, read at the DOM rather than at the import.
 *
 * `coach-type-floor.test.ts` bans `<Overline>` from coach-only modules, which is the total check --
 * it sees every branch, including the reconnect dialog that only mounts when a channel is out.
 * This is the direct one: whatever the page is built out of, nothing it actually renders may carry
 * the atomic's marker. The two fail for different reasons, which is the point of having both, and
 * both directions were proved rather than asserted. Passing `overline` to the shared
 * `SurfaceHeader` puts the atomic on this page through a kit component admin routes also reach,
 * so it is not a coach-only module: the import ban stays green and this one fails. Restoring the
 * overline inside the reconnect dialog, which no render in this suite opens, fails the import ban
 * while this one stays green.
 *
 * What neither catches is a page that hand-rolls the 9.5px recipe without importing the atomic --
 * no `<Overline` to ban, no `data-slot` to find. The literal scan in `coach-type-floor.test.ts` is
 * what covers that, and it is why all three exist.
 *
 * Seven of them were live here: the range picker's own label, the two custom-range fields, the
 * attention strip's heading, two headings inside the reconnect dialog, and every term in the "How
 * these are measured" list. `Main.dc.html` puts none on this page -- its panel labels are 14px
 * sentence-case `--muted`, and its only uppercase mono is a 13px chip.
 */
describe("coach Home carries no console overline", () => {
  it("renders no overline marker, on the default arm or the empty attention arm", () => {
    const { container } = renderSurface();
    // The positive control: a surface that rendered nothing would pass the assertion below.
    expect(container.querySelectorAll(".coach-panel").length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-slot="overline"]')).toHaveLength(0);

    // The empty arm is a different component path -- it returns before the queue is built -- and
    // it held the `coach-attention-heading` h2, which was one of the seven.
    const { container: quiet } = renderSurface({
      attentionValue: {
        blockedSetupSteps: 0,
        blockedStepKey: null,
        leadsToCallBack: 0,
        longTermFollowUps: 0,
        noShows: 0,
        oldestThreadWaitMinutes: null,
        openConversations: 0,
        threadsNeedingHuman: 0,
      },
    });
    expect(quiet.querySelector("#coach-attention-heading")).not.toBeNull();
    expect(quiet.querySelectorAll('[data-slot="overline"]')).toHaveLength(0);
  });

  /**
   * The heading levels are load-bearing and had to survive the restyling. `Overline` took an `as`
   * prop, so the attention strip's label was a real `h2` labelling its section and the measured
   * list's terms were real `dt`s -- moving to a class rather than to a `<span>` is what keeps both.
   */
  it("keeps the attention strip's h2 and the measured list's terms as themselves", () => {
    const { container } = renderSurface({
      attentionValue: {
        blockedSetupSteps: 0,
        blockedStepKey: null,
        leadsToCallBack: 0,
        longTermFollowUps: 0,
        noShows: 0,
        oldestThreadWaitMinutes: null,
        openConversations: 0,
        threadsNeedingHuman: 0,
      },
    });

    const heading = container.querySelector("#coach-attention-heading");
    expect(heading?.tagName).toBe("H2");
    expect(heading).toHaveClass("coach-eyebrow");
    expect(
      container.querySelector('[aria-labelledby="coach-attention-heading"]'),
    ).not.toBeNull();
  });

  it("labels the measured list with terms, at the coach eyebrow rather than the console's", () => {
    const { container } = renderSurface();
    const terms = Array.from(container.querySelectorAll("dt.coach-eyebrow"));
    expect(terms.length).toBeGreaterThan(0);
    for (const term of terms) {
      expect(term.className).not.toContain("text-[9.5px]");
    }
  });
});

/**
 * The reconnect dialog is portalled, so it has to carry the coach role in with it.
 *
 * Radix mounts `DialogContent` to `document.body`, outside the `[data-shell-role="coach"]` root
 * `AppShell` stamps, and every rule in `coach.css` -- `.coach-eyebrow` and every `--coach-*` token
 * alike -- is written under that attribute. A portalled label therefore matches nothing: the
 * browser drops the declaration and the text falls back to inherited size, on screen, with no
 * error anywhere. This is the third time the escape has been found in this codebase (`--r-pill`
 * squaring a chip on sixteen surfaces; the account menu rendering at console density because
 * Radix portalled it), and the first two were found by eye rather than by a test.
 *
 * Asserted as an ancestor rather than by computed style because jsdom applies no stylesheet: what
 * can be checked here is that the scoping attribute is between the label and the document, which
 * is the exact condition the CSS needs.
 */
describe("the reconnect dialog keeps the coach scale inside the portal", () => {
  function openReconnect() {
    const view = renderSurface({
      blockedChannelValue: {
        channelLabel: "Instagram",
        connectionId: "conn-1",
        providerReason: "OAuthException 190",
        signedRoundTripAt: null,
        state: "signed_out",
        stoppedAt: "2026-08-31T10:00:00.000Z",
        unprocessedEvents: 4,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "See what is affected" }));
    return view;
  }

  it("puts the coach role between a portalled label and the document", () => {
    openReconnect();

    const heading = screen.getByRole("heading", { name: "What happens next" });
    // The positive control: this only means anything if the dialog really opened into a portal.
    expect(heading.closest('[data-slot="dialog-content"]')).not.toBeNull();
    expect(heading).toHaveClass("coach-eyebrow");

    // The scoping attribute has to be an ANCESTOR of the label, not merely present on the page --
    // the page's own shell root carries it too, and the portal is not inside that root.
    expect(heading.closest('[data-shell-role="coach"]')).not.toBeNull();
  });
});

describe("what left coach Home", () => {
  /*
   * "Yours to set" is off this page. It was a stated, non-editable copy of `/coach/agent`'s four
   * sections, and `SIMPLIFICATION-SPEC.md` §2.1 MERGEs it into that page -- which now draws all
   * four cards open with a state pill on each, so the summary was a list of links to a list.
   * `Main.dc.html` draws neither it nor the "Performance" heading that held the range picker.
   * The set-versus-default distinction the deleted test guarded is guarded on the page that owns
   * it now, in `coach-offer.queue.test.tsx`.
   */
  it("draws neither the yours-to-set list nor a Performance heading", () => {
    renderSurface();
    expect(screen.queryByText("Yours to set, four things")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Performance" })).not.toBeInTheDocument();
    // The range picker survived the section it was inside, and moved into the page head.
    expect(screen.getByRole("group", { name: "Performance window" })).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Performance window" }).closest("[data-page-head]"),
    ).not.toBeNull();
  });
});

/**
 * The attention card's shape rules, which are the three defects the 2026-09-02 pass fixed.
 *
 * Before it, the card's three rows disagreed about what an action looks like: row one had a 34px
 * accent-filled `Link` floated to the far right of the whole card, rows two and three had accent
 * text links at a different x, and row one therefore had no action on its own line at all. A coach
 * scanning down met three affordances for one kind of move. It also framed itself in
 * `--warning-line` over a warning wash while sitting inside the page's own framed pane, and it
 * dropped any row whose count reached zero.
 */
describe("the attention card is one component rather than three rows of different ones", () => {
  function rows(container: HTMLElement) {
    const queue = container.querySelector('[aria-labelledby="coach-attention-heading"]');
    return Array.from(queue!.querySelectorAll("li"));
  }

  /**
   * The one-treatment rule. Every row's action is the same element with the same class recipe, so
   * this compares the rendered class strings to each other rather than to a literal -- a literal
   * would go stale the moment `kitButtonClass` changes, and would not catch the actual defect,
   * which is rows disagreeing.
   */
  it("gives every row the same action element, in the same column, at the same weight", () => {
    const { container } = renderSurface();
    const actions = rows(container).map((row) => row.querySelector("a"));

    expect(actions).toHaveLength(3);
    expect(actions.every((action) => action !== null)).toBe(true);
    expect(actions.map((action) => action!.tagName)).toEqual(["A", "A", "A"]);

    const recipes = new Set(actions.map((action) => action!.className));
    expect(recipes.size).toBe(1);
    // The column, not just the face: an action that agrees on styling but sits at a different x is
    // the same defect. All three are the grid's third track.
    expect(actions.every((action) => action!.className.includes("col-start-3"))).toBe(true);
    // And the weight: one of these must not be the page's fill while the other two are links.
    expect(actions.some((action) => action!.className.includes("--accent-fill"))).toBe(false);
  });

  /**
   * The accent budget. Home already spends its accent on the Booked deck panel and on the range
   * picker's selected segment, so the attention card gets none -- unless a channel has stopped,
   * which is the one action on the card that unblocks every line under it. The blocked arm is
   * asserted separately above; this is the ordinary arm, which is what a coach sees on almost
   * every visit.
   */
  it("spends no accent fill when no channel has stopped", () => {
    const { container } = renderSurface();
    const queue = container.querySelector('[aria-labelledby="coach-attention-heading"]');

    expect(queue!.querySelectorAll('[class*="--accent-fill"]')).toHaveLength(0);
    // The frame went with it. State is the warning dot beside the title and the warning figure on
    // the rows above zero, never a second border in a second colour inside the page's own pane.
    expect(queue!.className).not.toContain("--warning-line");
    expect(queue!.className).toContain("surface-card");
  });

  /**
   * Honest states. A row whose count reaches zero states the zero; only a card with nothing on it
   * at all collapses, and then it says so in one line. The old card filtered the list to counts
   * above zero, so a cleared queue and an uncounted one looked identical.
   */
  it("states a zero rather than dropping the row, and collapses only when everything is zero", () => {
    const { container } = renderSurface({
      attentionValue: {
        blockedSetupSteps: 0,
        blockedStepKey: null,
        leadsToCallBack: 2,
        longTermFollowUps: 1,
        noShows: 1,
        oldestThreadWaitMinutes: null,
        openConversations: 0,
        threadsNeedingHuman: 0,
      },
    });
    const queue = container.querySelector('[aria-labelledby="coach-attention-heading"]');

    expect(rows(container)).toHaveLength(3);
    expect(queue?.textContent).toContain("Threads needing a human");
    expect(queue?.textContent).toContain("Blocked setup steps");

    const empty = renderSurface({
      attentionValue: {
        blockedSetupSteps: 0,
        blockedStepKey: null,
        leadsToCallBack: 0,
        longTermFollowUps: 0,
        noShows: 0,
        oldestThreadWaitMinutes: null,
        openConversations: 0,
        threadsNeedingHuman: 0,
      },
    });
    const quiet = empty.container.querySelector('[aria-labelledby="coach-attention-heading"]');
    expect(quiet?.querySelectorAll("li")).toHaveLength(0);
    expect(quiet?.textContent).toContain("Nothing is waiting on you right now.");
  });

  /** The pill is gone: the heading already said the card was the one that needs you. */
  it("carries no uppercase mono NEEDS YOU badge beside the title", () => {
    const { container } = renderSurface();
    expect(container.textContent).not.toContain("NEEDS YOU");
  });
});

/**
 * Coach home and `/coach/billing` answering the same question about the same tenant.
 *
 * The allowance footer used to read the measurement RPC alone. That RPC reports the allowance
 * available only when it finds a current period in `analytics_billing_subscriptions` AND a
 * `tiers.call_allowance` behind that row's `tier_id`, so it says `unavailable` for two different
 * reasons and the footer printed the same sentence for both: "There is no active billing period to
 * count an allowance against." On the hosted project that sentence is false for every tenant with
 * a subscription, because the analytics mirror holds no rows while `billing_subscriptions` holds
 * six, so `/coach/billing` prints a period the dashboard denies exists.
 *
 * The page now takes the period from the same repository read `/coach/billing` makes, which
 * carries `isCurrentBillingPeriod` with it, and the footer separates the two claims: the period is
 * named when a record exists, and the count is withheld when nothing maps an allowance to it. The
 * honest absent sentence survives for the case it was written for, which is neither read finding a
 * period.
 */
describe("coach home allowance footer against the billing page", () => {
  function withoutAllowance() {
    return {
      ...measurement(),
      allowance: {
        limit: null,
        periodEnd: null,
        periodStart: null,
        state: "unavailable" as const,
        used: null,
      },
    };
  }

  it("names the period the billing page is showing instead of denying it exists", () => {
    const { container } = renderSurface({
      billingPeriodValue: {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
      measurementValue: withoutAllowance(),
    });
    const booked = panel(container, "Booked");

    expect(booked.textContent).not.toContain("There is no active billing period");
    expect(booked.textContent).toContain("no plan allowance is recorded");
    expect(booked.textContent).toContain("Monthly plan progress");
  });

  it("withholds the count rather than drawing a bar it has no denominator for", () => {
    const { container } = renderSurface({
      billingPeriodValue: {
        periodStart: "2026-08-01T00:00:00.000Z",
        periodEnd: "2026-09-01T00:00:00.000Z",
      },
      measurementValue: withoutAllowance(),
    });
    const booked = panel(container, "Booked");

    expect(booked.querySelector('[data-slot="meter"]')).toBeNull();
    expect(booked.textContent).not.toContain("0 / 0");
  });

  it("keeps the absent sentence when neither read found a period", () => {
    const { container } = renderSurface({ measurementValue: withoutAllowance() });
    const booked = panel(container, "Booked");

    expect(booked.textContent).toContain("There is no active billing period to count an allowance against.");
    expect(booked.querySelector('[data-slot="meter"]')).toBeNull();
  });

  it("prefers the measured allowance over the projection when the RPC has one", () => {
    const { container } = renderSurface({
      billingPeriodValue: {
        periodStart: "2020-01-01T00:00:00.000Z",
        periodEnd: "2020-02-01T00:00:00.000Z",
      },
    });
    const booked = panel(container, "Booked");

    expect(booked.textContent).toContain("Counted over your billing period");
    expect(booked.textContent).not.toContain("no plan allowance is recorded");
    expect(booked.textContent).not.toContain("2020");
  });
});
