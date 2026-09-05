import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AdminSystemHealth } from "@/components/workspace/live/admin-system-health";
import type { SystemHealth } from "@/lib/operations/system-health";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

const jobs: SystemHealth["jobs"] = [
  {
    id: "appointment-reconcile",
    label: "Appointment reconcile",
    schedule: "Daily 03:15 UTC",
    state: "healthy",
    lastRunAt: "2026-08-24T03:15:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-appointment",
    errorDetail: null,
    reason: null,
  },
  {
    id: "compliance-reconcile",
    label: "Compliance reconcile",
    schedule: "Daily 03:15 UTC",
    state: "healthy",
    lastRunAt: "2026-08-24T03:15:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-compliance",
    errorDetail: null,
    reason: null,
  },
  {
    id: "a2p-probe",
    label: "Carrier registration probe",
    schedule: "Daily 03:45 UTC",
    state: "unavailable",
    lastRunAt: null,
    reportedSinceYesterday: false,
    receiptId: null,
    errorDetail: null,
    reason: "No run report has been recorded.",
  },
  {
    id: "stripe-webhooks",
    label: "Billing webhook reconcile",
    schedule: "Every 15 minutes",
    state: "unavailable",
    lastRunAt: "2026-08-24T04:45:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-payments",
    errorDetail: null,
    reason: "The latest run report is outside its expected window.",
  },
  {
    id: "billing-allowances",
    label: "Billing allowance review",
    schedule: "Daily 04:20 UTC",
    state: "healthy",
    lastRunAt: "2026-08-24T04:20:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-allowances",
    errorDetail: null,
    reason: null,
  },
  {
    id: "billing-cost-rollup",
    label: "Billing cost rollup",
    schedule: "Daily 04:40 UTC",
    state: "unavailable",
    lastRunAt: "2026-08-22T04:40:00.000Z",
    reportedSinceYesterday: false,
    receiptId: "receipt-rollup",
    errorDetail: null,
    reason: "The latest run report is outside its expected window.",
  },
  {
    id: "notification-deliveries",
    label: "Notification delivery",
    schedule: "Daily 05:10 UTC",
    state: "failed",
    lastRunAt: "2026-08-24T05:10:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-delivery",
    reason: "The latest run report says this job failed.",
    errorDetail: "PROVISIONING_TENANT_READ_FAILED",
  },
  {
    id: "engine-evals",
    label: "Published engine evaluation",
    schedule: "Daily 05:40 UTC",
    state: "healthy",
    lastRunAt: "2026-08-24T05:40:00.000Z",
    reportedSinceYesterday: true,
    receiptId: "receipt-evaluation",
    errorDetail: null,
    reason: null,
  },
];

const health: SystemHealth = {
  queue: {
    state: "available",
    depth: 1,
    failedAttempts: 2,
    terminalAttempts: 0,
    reason: null,
    rows: [
      {
        id: "delivery-1",
        event: "BOOKING_CREATED",
        destination: "email",
        state: "retryable",
        attempts: 2,
        lastAttemptAt: "2026-08-24T05:42:00.000Z",
        deliveredAt: null,
        testData: false,
      },
    ],
  },
  jobs,
  providers: [
    "Text messages (SMS)",
    "Calendar",
    "Model routing",
    "Instagram and Messenger",
    "Credential storage",
    "Payments",
    "Email",
    "Alerts",
  ].map((label, index) => ({
    id: `integration-${index}`,
    label,
    state: "mock" as const,
    reason: null,
  })),
};

/**
 * The state where every reading on the page is correct and the page still lies.
 *
 * A deployment whose scheduled jobs have never completed draws a truthful zero in the queue
 * depth, a truthful zero in failed attempts, and a delivery table that is legitimately empty --
 * three accurate figures that together read as a calm platform. The only thing separating that
 * screen from a healthy one used to be an eleven-character badge at the top right, which is not
 * where an operator looks.
 *
 * The drift these two catch is the alarm quietly going back to being a badge: a refactor that
 * drops the callout, or that renders it on every state and so stops it meaning anything.
 */
describe("AdminSystemHealth job-reporting alarm", () => {
  function reporting(state: SystemHealth["jobs"][number]["state"], reason: string | null) {
    return { ...health, reporting: { state, reason } } satisfies SystemHealth;
  }

  it("says in full, above the figures, that nothing has run -- not only in the header badge", () => {
    // Every job in the never-ran state, which is the deployment the artboard draws: the whole
    // schedule firing into nothing. The fixture's own jobs are a mixture, so this rewrites them --
    // a headline counted off the rows has to be given rows that agree with the rollup.
    const nothingRan = {
      ...health,
      jobs: jobs.map((job) => ({ ...job, state: "never-ran" as const, lastRunAt: null, receiptId: null })),
      reporting: { state: "never-ran" as const, reason: null },
    };
    render(<AdminSystemHealth health={nothingRan} />);

    // The positive control first: without it this test passes against a component stubbed to
    // render nothing, which is exactly the vacuous shape three tests in this tree were caught in.
    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();

    // The badge still says the state in eleven characters at the top right, and the callout says
    // the finding. Both, because the badge alone is the arrangement this alarm exists to replace.
    expect(screen.getByText("Scheduled job has never run")).toBeInTheDocument();
    expect(
      screen.getByText("No scheduled job has ever recorded a completed run"),
    ).toBeInTheDocument();
    // The sentence, not just the label. A reader has to be told the zeroes below are real.
    expect(screen.getByText(/rather than because the platform is quiet/u)).toBeInTheDocument();
  });

  /**
   * The reach of the failure, counted off the job rows.
   *
   * "Scheduled job failing" is a state name: an operator reading it cannot tell one broken cron
   * from a schedule that is not landing at all, and those are different mornings. The fixture has
   * exactly one failed job out of eight, so a headline that dropped the filter, or that counted
   * every job, would print a different number here rather than passing anyway.
   */
  it("names how much of the schedule is affected rather than repeating the state name", () => {
    render(<AdminSystemHealth health={reporting("failed", "At least one scheduled job reports a failure.")} />);

    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();

    const failed = jobs.filter((job) => job.state === "failed").length;
    expect(failed).toBe(1);
    expect(failed).toBeLessThan(jobs.length);
    expect(
      screen.getByText(`${failed} of ${jobs.length} scheduled jobs failed their most recent run`),
    ).toBeInTheDocument();

    /*
      And it does not print the rollup's own reason line. Every string `reportingSummary` produces
      is the state restated -- "At least one scheduled job reports a failure" over a badge reading
      "Scheduled job failing" -- so passing it through was the symptom said twice and left the
      operator with nothing to act on. The per-job reasons are still rendered, on the Jobs tab,
      beside the job and its cron expression, which is where a reason is worth reading.
    */
    expect(screen.queryByText("At least one scheduled job reports a failure.")).toBeNull();

    /*
      What it does print is the thing the operator can act on: which job failed and what its
      receipt recorded. The Jobs tab still carries the per-row detail; the banner names it here
      because this card is the first thing read, and "1 of 8 failed" with no name sends the
      reader to another tab to learn which one.
    */
    expect(screen.getByText(/Notification delivery\. Last error: Provisioning tenant read failed\./u)).toBeInTheDocument();
  });

  it("names a failing job without a recorded error as such, rather than inventing one", () => {
    const silent = {
      ...health,
      jobs: jobs.map((job) => job.state === "failed" ? { ...job, errorDetail: null } : job),
      reporting: { state: "failed" as const, reason: null },
    };
    render(<AdminSystemHealth health={silent} />);

    expect(screen.getByText(/Notification delivery\. No error detail was recorded\./u)).toBeInTheDocument();
    expect(screen.queryByText(/Last error:/u)).toBeNull();
  });

  /**
   * The one cause the artboard names is the one this component must not print.
   *
   * `AdminSystem.dc.html` bodies the callout with "every one returns 401, because the deployment
   * holds no CRON_SECRET". `SystemHealth` carries job receipts, queue depth and attempt counts; a
   * run that never happened leaves no row saying why it did not, so that sentence would be a
   * specific misconfiguration asserted on the evidence of an absence. An operator who chased a
   * CRON_SECRET that was set correctly would stop trusting the card.
   */
  it("does not name a cause the read cannot know", () => {
    render(<AdminSystemHealth health={reporting("never-ran", null)} />);

    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();
    // Matched narrowly on purpose: the integrations tab legitimately lists "Credential storage",
    // so a broad word like "credential" would fail this on text that is not a claim at all.
    expect(screen.queryByText(/CRON_SECRET|returns 401|holds no secret/u)).toBeNull();
  });

  /**
   * An unfinished run is not a fault and a failed read is already reported twice over. An alarm
   * that fires on a healthy day is an alarm nobody reads, so these two states stay badges.
   */
  it("stays quiet on a healthy platform and on a run that has simply not finished", () => {
    for (const state of ["healthy", "in-progress"] as const) {
      const { unmount } = render(<AdminSystemHealth health={reporting(state, null)} />);
      expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();
      expect(screen.queryByText(/rather than because the platform is quiet/u)).toBeNull();
      unmount();
    }
  });
});

/**
 * The figure that goes wrong when the platform is doing nothing.
 *
 * Queue depth, failed attempts and terminal attempts are all truthfully zero on a deployment
 * whose scheduled jobs have never run, so the strip read as calm on exactly the screen that had
 * the worst news. This counts jobs carrying a stored run receipt, off the same rows the Jobs tab
 * lists, so it cannot disagree with them.
 *
 * The drift these catch: the count quietly becoming a constant, and the failure tone becoming
 * permanent -- a figure that is always clay is decoration, and stops being read as a claim.
 */
describe("AdminSystemHealth run-receipt figure", () => {
  function figureNamed(container: HTMLElement, label: string) {
    const entry = Array.from(container.querySelectorAll<HTMLElement>("*"))
      .find((node) => node.textContent?.trim() === label);
    return entry?.parentElement ?? null;
  }

  it("counts jobs carrying a receipt, from the same rows the Jobs tab lists", () => {
    const { container } = render(<AdminSystemHealth health={health} />);

    expect(screen.getByRole("heading", { name: "System" })).toBeInTheDocument();
    // The fixture has receipts on every job but the carrier probe, so this is 8 of 9 rather than
    // a number that would still be right if the filter were dropped.
    const withReceipts = jobs.filter((job) => job.receiptId !== null).length;
    expect(withReceipts).toBeGreaterThan(0);
    expect(withReceipts).toBeLessThan(jobs.length);
    expect(figureNamed(container, "Jobs with a run receipt")).toHaveTextContent(String(withReceipts));
  });

  /**
   * The figure reads zero and stays neutral, and the callout is what carries the alarm.
   *
   * `FigureStrip` forces any zero to the neutral tone, because for every other figure it draws a
   * zero is good news or no news. This one is the inverse, so the component cannot colour it and
   * the sentence above has to do the work. This pins that arrangement: if someone later removes
   * the callout on the assumption the strip is shouting, the second assertion fails.
   */
  it("reads zero without colour, and leaves the alarm to the callout above it", () => {
    const none = {
      ...health,
      jobs: jobs.map((job) => ({ ...job, receiptId: null })),
      reporting: { state: "never-ran" as const, reason: null },
    };
    const { container } = render(<AdminSystemHealth health={none} />);

    const figure = figureNamed(container, "Jobs with a run receipt");
    expect(figure).toHaveTextContent("0");
    expect(figure?.querySelector('[data-slot="figure"]')?.getAttribute("data-tone")).toBe("neutral");
    expect(screen.getByText(/rather than because the platform is quiet/u)).toBeInTheDocument();
  });
});

describe("AdminSystemHealth", () => {
  it("renders operator labels without deployment configuration names or raw timestamps", async () => {
    const user = userEvent.setup();
    const { container } = render(<AdminSystemHealth health={health} />);

    expect(screen.getByText("Booking created")).toBeInTheDocument();
    /*
      The technical-detail fold is the one place a raw value belongs -- it already carries receipt
      ids, and now the failed job's error code verbatim, so an operator can copy it into a log
      search. Everything outside the fold is prose an operator reads, and that is what must not
      contain a machine name.
    */
    const readable = () => Array.from(container.querySelectorAll("*"))
      .filter((node) => !node.closest('[data-slot="technical-detail"]') && node.children.length === 0)
      .map((node) => node.textContent ?? "").join(" ");
    expect(readable()).not.toMatch(/[A-Z]+_[A-Z_]+/);
    expect(readable()).not.toMatch(/[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+/);
    expect(readable()).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    expect(
      screen.getByText("2 of 8 jobs have not reported since yesterday"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(screen.getAllByText("Mock")).toHaveLength(8);
    expect(readable()).not.toMatch(/[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+/);
  });

  /**
   * "Failed" with no reason was the production screen: the badge said a job was failing, the
   * row said the report said so, and the receipt's `error_detail` -- the one field that says
   * why -- was recorded and never rendered. The row now carries it in sentence case, the fold
   * carries it verbatim for a log search, and a job that did not fail carries neither.
   */
  it("says why a failed job failed, on its row and verbatim behind the fold", async () => {
    const user = userEvent.setup();
    render(<AdminSystemHealth health={health} />);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    const rows = screen.getAllByTestId("system-job-row");
    const failedRow = rows.find((row) => within(row).queryByText("Notification delivery"));
    expect(failedRow).toBeDefined();
    expect(within(failedRow!).getByText("Last error")).toBeInTheDocument();
    expect(within(failedRow!).getByText("Provisioning tenant read failed")).toBeInTheDocument();
    expect(screen.getAllByText("Last error")).toHaveLength(1);

    const fold = document.querySelector('[data-slot="technical-detail"]');
    expect(fold?.textContent).toContain("Notification delivery last error");
    expect(fold?.textContent).toContain("PROVISIONING_TENANT_READ_FAILED");
  });

  it("keeps a free-text error detail verbatim rather than mangling it as a machine code", async () => {
    const user = userEvent.setup();
    const detail = "fetch failed: getaddrinfo ENOTFOUND db.synthetic.test";
    render(<AdminSystemHealth health={{
      ...health,
      jobs: jobs.map((job) => job.state === "failed" ? { ...job, errorDetail: detail } : job),
    }} />);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    const failedRow = screen.getAllByTestId("system-job-row")
      .find((row) => within(row).queryByText("Notification delivery"));
    expect(within(failedRow!).getByText(detail)).toBeInTheDocument();
  });

  it("shows a deliberately unavailable driver as not configured in amber", async () => {
    const user = userEvent.setup();
    render(<AdminSystemHealth health={{
      ...health,
      jobs: jobs.map((job) => job.id === "a2p-probe" ? {
        ...job,
        state: "not-configured",
        errorDetail: "SETTERFI_GHL_PROVISIONING_DRIVER",
        reason: "The job driver is not configured in this environment.",
      } : job),
      reporting: { state: "not-configured", reason: "At least one scheduled job driver is not configured." },
    }} />);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    const row = screen.getAllByTestId("system-job-row")
      .find((candidate) => within(candidate).queryByText("Carrier registration probe"));
    const status = within(row!).getByText("Not configured");
    expect(status.closest("[data-slot='status']")?.getAttribute("data-tone")).toBe("warning");
    expect(within(row!).getByText("Setterfi ghl provisioning driver")).toBeInTheDocument();
  });

  /**
   * Never-Colour-Alone, on the row that most tempts a designer to drop to a dot.
   *
   * This used to require an `<svg>` inside a `state-badge`, which was the old badge's way of
   * satisfying the rule. The row now uses the kit's bare `Status`, which spends a coloured dot
   * *and* the state in words -- so the rule is satisfied more directly than it was, and this test
   * asserts the rule rather than the markup that used to implement it. A row whose state collapsed
   * to a bare dot would still fail here, which is the thing worth protecting.
   */
  it("says every job's state in words, never in colour alone", async () => {
    const user = userEvent.setup();
    render(<AdminSystemHealth health={health} />);

    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    const rows = screen.getAllByTestId("system-job-row");
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      const status = within(row).getByText(/Healthy|Failed|Not configured|No recent report/);
      const badge = status.closest("[data-slot='status']");
      expect(badge, "the state must be a Status, not loose coloured text").not.toBeNull();
      // The label is the accessible state. A dot alone would leave this empty.
      expect(badge?.querySelector("[data-slot='status-label']")?.textContent?.trim()).toBeTruthy();
    }
  });

  it("opens on the queue, the decision view, before jobs or integrations", () => {
    render(<AdminSystemHealth health={health} />);

    const tabs = screen.getAllByRole("tab");
    // The label alone stays the accessible name; the count rides beside it as decoration, so a
    // reader is not told "Jobs 8" every time focus lands on the tab.
    expect(
      tabs.map((tab) => tab.getAttribute("aria-label") ?? tab.textContent),
    ).toEqual(["Status1", "Jobs8", "Integrations8"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Active queue")).toBeVisible();
  });

  it("carries the row tallies as tab counts rather than a pill that reads as a state", async () => {
    const user = userEvent.setup();
    render(<AdminSystemHealth health={health} />);

    expect(screen.getByRole("tab", { name: "Jobs" }).textContent).toBe("Jobs8");
    await user.click(screen.getByRole("tab", { name: "Jobs" }));
    expect(screen.queryByText("8 jobs tracked")).not.toBeInTheDocument();
  });

  it("omits a tab count rather than printing a zero for an empty queue", () => {
    render(
      <AdminSystemHealth
        health={{
          ...health,
          queue: {
            ...health.queue,
            depth: 0,
            failedAttempts: 0,
            terminalAttempts: 0,
            rows: [],
          },
        }}
      />,
    );

    expect(screen.getByRole("tab", { name: "Status" }).textContent).toBe(
      "Status",
    );
  });

  it("bands the delivery queue by state and drops the column the band repeats", () => {
    const { container } = render(<AdminSystemHealth health={health} />);

    const bands = [
      ...container.querySelectorAll('[data-slot="data-table-group-row"]'),
    ].map((row) => row.textContent);
    expect(bands.some((band) => band?.includes("Still trying"))).toBe(true);
    const headers = [...container.querySelectorAll("thead th")].map(
      (cell) => cell.textContent,
    );
    expect(headers.some((header) => header?.trim() === "State")).toBe(false);
    expect(headers.some((header) => header?.includes("Last attempt"))).toBe(
      true,
    );
  });

  it("says a never-attempted delivery in words rather than leaving the cell empty", () => {
    const { container } = render(
      <AdminSystemHealth
        health={{
          ...health,
          queue: {
            ...health.queue,
            rows: [
              {
                ...health.queue.rows[0],
                id: "delivery-2",
                attempts: 0,
                lastAttemptAt: null,
              },
            ],
          },
        }}
      />,
    );

    const absences = [
      ...container.querySelectorAll('[data-slot="cell-quiet"]'),
    ].map((node) => node.textContent);
    expect(absences).toContain("never attempted");
    expect(container.textContent).not.toContain("No attempt yet");
  });

  it("counts failed attempts, not queue depth, beside the rail item", () => {
    const { container } = render(<AdminSystemHealth health={health} />);

    const counts = [
      ...container.querySelectorAll('[data-slot="nav-count"]'),
    ].map((node) => node.textContent);
    expect(counts).toContain("2");
    expect(counts).not.toContain("1");
  });

  it("renders queue reads that fail as unavailable rather than empty", () => {
    render(
      <AdminSystemHealth
        health={{
          ...health,
          queue: {
            state: "unavailable",
            depth: null,
            failedAttempts: null,
            terminalAttempts: null,
            reason: "Delivery activity could not be read.",
            rows: [],
          },
        }}
      />,
    );

    expect(
      screen.getByText("Delivery activity unavailable"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No recent delivery activity"),
    ).not.toBeInTheDocument();
  });

  it("puts the delivery queue on the ledger treatment, with a sentence on every band", () => {
    const { container } = render(<AdminSystemHealth health={health} />);

    expect(
      container.querySelector('[data-slot="data-table"]'),
    ).toHaveAttribute("data-variant", "ledger");
    const annotations = [
      ...container.querySelectorAll('[data-slot="table-group-annotation"]'),
    ].map((node) => node.textContent);
    expect(annotations).toContain(
      "the queue is still working these, so there is nothing to do yet",
    );
    expect(
      container.querySelector('[data-slot="data-table-footer-note"]')
        ?.textContent,
    ).toContain("Nothing here records whether anyone read it.");
  });
});
