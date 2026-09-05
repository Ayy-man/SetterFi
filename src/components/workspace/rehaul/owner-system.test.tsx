import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const navigation = vi.hoisted(() => ({
  pathname: "/admin/system",
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => navigation.searchParams,
}));

import {
  OwnerSystem,
  type SystemPlatformSnapshot,
} from "@/components/workspace/rehaul/owner-system";
import type { SystemHealth } from "@/lib/operations/system-health";

const NOW_ISO = "2026-09-03T12:00:00.000Z";

const health: SystemHealth = {
  queue: {
    state: "available",
    depth: 4,
    failedAttempts: 2,
    terminalAttempts: 1,
    rows: [
      {
        id: "delivery-1",
        event: "appointment_reminder",
        destination: "email",
        state: "failed",
        attempts: 3,
        lastAttemptAt: "2026-09-02T21:14:00.000Z",
        deliveredAt: null,
        testData: false,
      },
      {
        id: "delivery-2",
        event: "handoff_requested",
        destination: "bell",
        state: "delivered",
        attempts: 1,
        lastAttemptAt: "2026-09-02T20:00:00.000Z",
        deliveredAt: "2026-09-02T20:00:04.000Z",
        testData: false,
      },
    ],
    reason: null,
  },
  jobs: [
    {
      id: "followups",
      label: "Followups",
      schedule: "0 * * * *",
      state: "healthy",
      lastRunAt: "2026-09-03T09:30:00.000Z",
      reportedSinceYesterday: true,
      receiptId: "receipt-1",
      reason: null,
      errorDetail: null,
      missingConfiguration: null,
    },
    {
      id: "a2p-probe",
      label: "A2P Probe",
      schedule: "0 3 * * *",
      state: "stale",
      lastRunAt: "2026-09-01T03:00:00.000Z",
      reportedSinceYesterday: false,
      receiptId: "receipt-2",
      reason: "The latest run report is outside its expected window.",
      errorDetail: null,
      missingConfiguration: null,
    },
    {
      id: "ghl-install-reconcile",
      label: "GHL Install Reconcile",
      schedule: "0 4 * * *",
      state: "healthy",
      lastRunAt: "2026-09-03T04:00:00.000Z",
      reportedSinceYesterday: true,
      receiptId: "receipt-3",
      reason: null,
      errorDetail: null,
      missingConfiguration: null,
    },
  ],
  providers: [
    { id: "text-messages", label: "Text messages (SMS)", state: "real", reason: null },
    { id: "payments", label: "Payments", state: "mock", reason: "Part of this integration is using mock data." },
    { id: "social-messaging", label: "Instagram and Messenger", state: "unavailable", reason: "Required setup is incomplete." },
  ],
  reporting: { state: "stale", reason: "At least one scheduled job report is stale." },
};

const platform: SystemPlatformSnapshot = {
  deliveriesByDay: [
    { day: "2026-08-28", delivered: 180, failed: 0 },
    { day: "2026-08-29", delivered: 164, failed: 1 },
    { day: "2026-08-30", delivered: 171, failed: 0 },
    { day: "2026-08-31", delivered: 198, failed: 3 },
    { day: "2026-09-01", delivered: 205, failed: 0 },
    { day: "2026-09-02", delivered: 187, failed: 0 },
    { day: "2026-09-03", delivered: 179, failed: 2 },
  ],
  textingRegistrationByTenant: [
    {
      tenantId: "tenant-a",
      registrationState: "awaiting_provider",
      submittedAt: "2026-08-25T12:00:00.000Z",
      daysElapsed: 9,
    },
    {
      tenantId: "tenant-b",
      registrationState: "pending",
      submittedAt: "2026-08-18T12:00:00.000Z",
      daysElapsed: 16,
    },
    {
      tenantId: "tenant-c",
      registrationState: "done",
      submittedAt: "2026-07-01T12:00:00.000Z",
      daysElapsed: 64,
    },
  ],
};

function renderAt(search: string, snapshot: SystemPlatformSnapshot | null = platform) {
  navigation.searchParams = new URLSearchParams(search);
  return render(<OwnerSystem health={health} nowIso={NOW_ISO} platform={snapshot} />);
}

describe("OwnerSystem", () => {
  it("heads the page with the reporting state and shows a queue figure", () => {
    renderAt("");

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Job reports stale");
    // Jobs with a run receipt: all three fixture jobs carry one.
    const strip = screen.getByLabelText("Delivery summary");
    expect(within(strip).getByText("Jobs with a run receipt")).toBeInTheDocument();
    expect(within(strip).getByText("3")).toBeInTheDocument();
    expect(within(strip).getByText("Failed attempts")).toBeInTheDocument();
  });

  it("prints no explainer sentence from the folded surface", () => {
    renderAt("");

    expect(
      screen.queryByText(/whether the platform is actually doing anything/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Integration mode and setup state, without deployment configuration names\./i),
    ).not.toBeInTheDocument();
  });

  it("names no messaging vendor anywhere on the page", () => {
    const { container } = renderAt("");

    expect(container.textContent).not.toMatch(/GHL|GoHighLevel|Twilio/i);
    expect(screen.getAllByText("Channel install reconcile").length).toBeGreaterThan(0);
  });

  it("lists every service and both kinds of incident on the status tab", () => {
    renderAt("");

    expect(screen.getAllByTestId("owner-system-service-row")).toHaveLength(6);
    const incidents = screen.getAllByTestId("owner-system-incident");
    expect(incidents).toHaveLength(2);
    expect(incidents[0]).toHaveTextContent("Appointment reminder was not delivered");
    expect(incidents[1]).toHaveTextContent("Texting registration: no recent report");
  });

  /*
   * A failed job used to draw a red dot beside an amber pill, which said "waiting" and "broken" in
   * the same row. Amber is the pending colour, so the failure keeps the red dot and the pill goes
   * neutral: one state, one colour, and the dot in the pill agrees with the dot on the row.
   */
  it("gives a failed job one colour, not two", () => {
    const failing: SystemHealth = {
      ...health,
      jobs: [{ ...health.jobs[0]!, state: "failed", reason: "The last run threw." }],
    };
    navigation.searchParams = new URLSearchParams("");
    render(<OwnerSystem health={failing} nowIso={NOW_ISO} />);

    const row = screen.getAllByTestId("owner-system-service-row")
      .find((candidate) => candidate.textContent?.includes("Failed"))!;
    const dots = [...row.querySelectorAll('[data-slot="status-dot"]')];
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.getAttribute("data-tone")).toBe("bad");
    expect(row.querySelector('[data-slot="pill"]')?.getAttribute("data-tone")).toBe("neutral");
  });

  const notConfigured: SystemHealth = {
    ...health,
    jobs: [
      {
        ...health.jobs[0]!,
        state: "not-configured",
        reason: "The job driver is not configured in this environment.",
        errorDetail: "OPENROUTER_API_KEY",
        missingConfiguration: { variables: ["OPENROUTER_API_KEY"], since: "2026-08-31T09:30:00.000Z" },
      },
      {
        ...health.jobs[1]!,
        state: "not-configured",
        lastRunAt: "2026-09-03T03:00:00.000Z",
        reason: "The job driver is not configured in this environment.",
        errorDetail: "SETTERFI_GHL_PROVISIONING_DRIVER, GHL_CLIENT_ID",
        missingConfiguration: {
          variables: ["SETTERFI_GHL_PROVISIONING_DRIVER", "GHL_CLIENT_ID"],
          since: "2026-09-03T03:00:00.000Z",
        },
      },
      health.jobs[2]!,
    ],
    reporting: { state: "not-configured", reason: "At least one scheduled job driver is not configured." },
  };

  it("shows a skipped driver as not configured in amber", () => {
    navigation.searchParams = new URLSearchParams("?tab=jobs");
    render(<OwnerSystem health={notConfigured} nowIso={NOW_ISO} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Job driver not configured");
    const row = screen.getAllByTestId("owner-system-job-row")[0]!;
    expect(within(row).getByText("Not configured")).toBeInTheDocument();
    expect(row.querySelector('[data-slot="pill"]')?.getAttribute("data-tone")).toBe("amber");
  });

  it("names the missing variables verbatim under the pill, with how long they have been missing", () => {
    navigation.searchParams = new URLSearchParams("?tab=jobs");
    render(<OwnerSystem health={notConfigured} nowIso={NOW_ISO} />);

    const rows = screen.getAllByTestId("owner-system-job-row");
    const followups = within(rows[0]!).getByTestId("owner-system-missing-configuration");
    expect(within(followups).getByText("OPENROUTER_API_KEY")).toBeInTheDocument();
    expect(within(followups).getByText("since 3 days ago")).toBeInTheDocument();
    expect(within(rows[0]!).queryByText("Last error")).not.toBeInTheDocument();

    const probe = within(rows[1]!).getByTestId("owner-system-missing-configuration");
    expect(within(probe).getByText("SETTERFI_GHL_PROVISIONING_DRIVER")).toBeInTheDocument();
    expect(within(probe).getByText("GHL_CLIENT_ID")).toBeInTheDocument();
    expect(within(probe).getByText("since 9 hours ago")).toBeInTheDocument();

    // The healthy third row carries no such block.
    expect(screen.getAllByTestId("owner-system-missing-configuration")).toHaveLength(2);
  });

  it("sums the waiting jobs into one line at the top of the jobs section", () => {
    navigation.searchParams = new URLSearchParams("?tab=jobs");
    render(<OwnerSystem health={notConfigured} nowIso={NOW_ISO} />);

    expect(screen.getByTestId("owner-system-jobs-waiting-on-configuration")).toHaveTextContent(
      "2 jobs waiting on configuration: OPENROUTER_API_KEY, SETTERFI_GHL_PROVISIONING_DRIVER, GHL_CLIENT_ID",
    );
  });

  it("prints no configuration line when nothing is waiting", () => {
    renderAt("?tab=jobs");

    expect(screen.queryByTestId("owner-system-jobs-waiting-on-configuration")).not.toBeInTheDocument();
    expect(screen.queryByTestId("owner-system-missing-configuration")).not.toBeInTheDocument();
  });

  it("draws the seven-day delivery bars from the snapshot", () => {
    renderAt("");

    const card = screen.getByTestId("owner-system-deliveries");
    expect(within(card).getByText("Deliveries, last 7 days")).toBeInTheDocument();
    // 180 + 164 + 171 + 198 + 205 + 187 + 179, and 1 + 3 + 2 failures.
    expect(within(card).getByText("1,284 sent · 6 failed")).toBeInTheDocument();
    expect(within(card).getByText("Aug 28 → Sep 3")).toBeInTheDocument();

    const bars = [...card.querySelectorAll("rect")];
    expect(bars).toHaveLength(7);
    for (const bar of bars) expect(bar.getAttribute("rx")).toBe("4");
    expect(bars.at(-1)?.getAttribute("fill-opacity")).toBe("1");
    expect(bars[0]?.getAttribute("fill-opacity")).toBe("0.28");
    // One baseline, no gridlines.
    expect(card.querySelectorAll("line")).toHaveLength(1);
    // Every exact figure is still readable without the picture.
    expect(within(card).getByRole("table")).toHaveTextContent("Aug 28");
  });

  it("draws no delivery card and no registration pill without a snapshot", () => {
    renderAt("", null);

    expect(screen.queryByTestId("owner-system-deliveries")).not.toBeInTheDocument();
    expect(screen.queryByTestId("owner-system-registration-pill")).not.toBeInTheDocument();
  });

  it("counts the open texting registrations and dates each one in days", () => {
    renderAt("");

    const pill = screen.getByTestId("owner-system-registration-pill");
    // The finished tenant is not counted; both open ones are, and one of them is waiting.
    expect(pill).toHaveTextContent("2 texting registrations waiting");
    expect(pill.querySelector('[data-slot="pill"]')?.getAttribute("data-tone")).toBe("amber");

    const row = screen.getAllByTestId("owner-system-service-row")
      .find((candidate) => candidate.textContent?.includes("Texting registration"))!;
    expect(row).toHaveTextContent("2 clients waiting");
    expect(row).toHaveTextContent("Day 16, day 9");
    expect(row.textContent).not.toMatch(/%|Sep|Aug/);
  });

  it("keeps amber off a registration that is settled rather than pending", () => {
    renderAt("", {
      ...platform,
      textingRegistrationByTenant: [
        {
          tenantId: "tenant-a",
          registrationState: "blocked",
          submittedAt: "2026-08-25T12:00:00.000Z",
          daysElapsed: 9,
        },
      ],
    });

    const pill = screen.getByTestId("owner-system-registration-pill");
    expect(pill).toHaveTextContent("1 texting registration not complete");
    expect(pill.querySelector('[data-slot="pill"]')?.getAttribute("data-tone")).toBe("neutral");
    const row = screen.getAllByTestId("owner-system-service-row")
      .find((candidate) => candidate.textContent?.includes("Texting registration"))!;
    expect(row).toHaveTextContent("Day 9 blocked");
  });

  it("swaps in the jobs and integrations bodies from the tab query", () => {
    const jobs = renderAt("?tab=jobs");
    expect(screen.getAllByTestId("owner-system-job-row")).toHaveLength(3);
    expect(screen.queryAllByTestId("owner-system-service-row")).toHaveLength(0);
    jobs.unmount();

    renderAt("?tab=integrations");
    expect(screen.getAllByTestId("owner-system-integration-row")).toHaveLength(3);
    expect(screen.getByText("Needs setup")).toBeInTheDocument();
  });
});
