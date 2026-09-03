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

import { OwnerSystem } from "@/components/workspace/rehaul/owner-system";
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
    },
  ],
  providers: [
    { id: "text-messages", label: "Text messages (SMS)", state: "real", reason: null },
    { id: "payments", label: "Payments", state: "mock", reason: "Part of this integration is using mock data." },
    { id: "social-messaging", label: "Instagram and Messenger", state: "unavailable", reason: "Required setup is incomplete." },
  ],
  reporting: { state: "stale", reason: "At least one scheduled job report is stale." },
};

function renderAt(search: string) {
  navigation.searchParams = new URLSearchParams(search);
  return render(<OwnerSystem health={health} nowIso={NOW_ISO} />);
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
