import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import OnboardingPage from "./page";

vi.mock("next/link", () => ({ default: "a" }));

/**
 * The three reads the page makes, mutable per test.
 *
 * They are the same three coach Home makes: the channel connection list, the A2P registration, and
 * `provisioning_steps`. That is the whole point of the rebuild, so the fixture is shaped like the
 * real reads rather than like a view model.
 */
const reads = {
  businessProfiles: [] as unknown[],
  calendarConnections: [] as { state: string }[],
  connections: [] as unknown[],
  connectionsThrow: false,
  phase5Live: true,
  provisioningSteps: [] as { state: string }[],
  publishedOffer: null as unknown,
  registration: null as Record<string, unknown> | null,
  tableError: null as string | null,
};

beforeEach(() => {
  reads.businessProfiles = [];
  reads.calendarConnections = [];
  reads.connections = [];
  reads.connectionsThrow = false;
  reads.phase5Live = true;
  reads.provisioningSteps = [];
  reads.publishedOffer = null;
  reads.registration = null;
  reads.tableError = null;
});

/**
 * The service client, shaped like the four reads the page makes rather than like one generic
 * chain: each rung reads the table its own step screen reads, and the point of the fixture is that
 * those are four different tables.
 */
function tableRows(table: string): unknown[] {
  if (table === "business_profiles") return reads.businessProfiles;
  if (table === "calendar_connections") return reads.calendarConnections;
  if (table === "provisioning_steps") return reads.provisioningSteps;
  return [];
}

vi.mock("@/lib/env-contract", () => ({ phase5Live: () => reads.phase5Live }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "u1" } }, error: null }) },
  }),
  createSupabaseServiceClient: () => ({
    from: (table: string) => {
      const result = reads.tableError === table
        ? { data: null, error: new Error("unreadable") }
        : { data: tableRows(table), error: null };
      const chain = {
        eq: () => chain,
        limit: () => Promise.resolve(result),
        select: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  }),
}));
vi.mock("@/lib/auth/claims", () => ({
  canAccessWorkspace: () => true,
  parseAppClaims: () => ({ role: "coach", tenantId: "tenant-1" }),
  workspaceForRole: () => "coach",
}));
vi.mock("@/lib/repositories/channel-connections", () => ({
  listChannelConnections: async () => {
    if (reads.connectionsThrow) throw new Error("unreadable");
    return reads.connections;
  },
}));
vi.mock("@/lib/repositories/offer-layer", () => ({
  createOfferLayerRepository: () => ({
    loadOffer: async () => {
      if (reads.tableError === "offers") throw new Error("unreadable");
      return reads.publishedOffer;
    },
  }),
}));
vi.mock("@/lib/repositories/onboarding-evidence", () => ({
  loadCoachA2pRegistration: async () => {
    if (reads.tableError === "a2p") throw new Error("unreadable");
    return reads.registration;
  },
}));

async function renderPage() {
  render(await OnboardingPage());
}

/** The counter in the rail's own header band. */
function counter() {
  return screen.getByRole("heading", { level: 2, name: /of 6 done$/u });
}

function rungs() {
  return [...document.querySelectorAll("[data-slot='onboarding-step-rung']")] as HTMLElement[];
}

const LIVE_INSTAGRAM = {
  channel: "instagram",
  state: "live",
  receipts: { signedRoundTripAt: "2026-08-29T00:00:00.000Z" },
};

describe("the setup root", () => {
  /**
   * The defect Note 3 recorded, asserted as a property rather than as a number.
   *
   * `/onboarding` said 3 of 7 while `/coach/home` said 0 of 3 for one account. Fixing the constant
   * would have left the two expressions of the count still maintained by hand, so what is pinned
   * here is that the denominator equals the number of rungs drawn and the numerator equals the
   * number of them in the done state. Neither can be edited into disagreement.
   */
  it("counts the rungs it draws, on both halves of the fraction", async () => {
    reads.connections = [LIVE_INSTAGRAM];
    reads.businessProfiles = [{ id: "profile-1" }];
    await renderPage();

    const rows = rungs();
    expect(rows).toHaveLength(6);
    const done = rows.filter((row) => row.dataset.state === "done");
    expect(done).toHaveLength(2);
    expect(counter()).toHaveTextContent("2 of 6 done");
  });

  /**
   * The channel fact this page and coach Home both state comes from one read of one table, so the
   * two surfaces cannot disagree about whether a coach's agent is answering. Only `live` counts:
   * `ready` is an OAuth that finished, not a channel a lead can reach.
   */
  it("calls the channel rung done only for a connection whose row says live", async () => {
    reads.connections = [{ channel: "instagram", state: "ready", receipts: {} }];
    await renderPage();

    const connect = rungs()[1];
    expect(connect).toHaveTextContent("Connect Instagram and Messenger");
    expect(connect.dataset.state).not.toBe("done");
    expect(counter()).toHaveTextContent("0 of 6 done");
  });

  /**
   * A failed read is an absence, not a zero. Saying "you have not connected anything" on the
   * strength of a query that never ran is the confident wrong answer the honest-states rule exists
   * to stop, and it would be said to a coach whose Instagram is live.
   */
  it("says a step could not be read rather than drawing it as not done", async () => {
    reads.connectionsThrow = true;
    await renderPage();

    const connect = rungs()[1];
    expect(connect.dataset.state).toBe("unknown");
    expect(within(connect).getByText("We could not check this")).toBeVisible();
    expect(screen.getByText(/Some of your setup could not be read just now/u)).toBeVisible();
  });

  /**
   * The resume button is the page's one filled action, and it names the step it goes to so the
   * reader knows the destination before pressing it. The audit's defect 3 was the accent spent on
   * a panel of prose while the real action sat grey beneath it.
   */
  it("spends its one accent fill on the button that resumes the current step", async () => {
    reads.businessProfiles = [{ id: "profile-1" }];
    await renderPage();

    const fills = document.querySelectorAll("[class*='var(--accent-fill)']");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toHaveTextContent("Continue with connect instagram and messenger");
    expect(fills[0].getAttribute("href")).toBe("/onboarding/connect");
    expect(document.querySelectorAll("[data-drench]")).toHaveLength(0);
  });

  /**
   * Later steps carry a plain ring and no state pill, which is what removes the "2, 3, 4, 6"
   * sequence a reader could find a hole in. Nothing on the rail is numbered.
   */
  it("numbers nothing on the rail and gives later steps no pill", async () => {
    await renderPage();

    const later = rungs().filter((row) => row.dataset.state === "later");
    expect(later.length).toBeGreaterThan(0);
    for (const row of later) {
      expect(row.textContent ?? "").not.toMatch(/\b[1-6]\b/u);
    }
  });

  /**
   * With the setup flow switched off every read would describe a pipeline that is not running, so
   * the rail says each step could not be read rather than drawing six untouched steps as work the
   * coach has failed to do.
   */
  it("makes no claim about any step while the setup flow is off", async () => {
    reads.phase5Live = false;
    await renderPage();

    expect(rungs().every((row) => row.dataset.state === "unknown")).toBe(true);
    expect(counter()).toHaveTextContent("0 of 6 done");
  });

  /** Nothing is waiting, so nothing is offered: a resume button here would land on a done screen. */
  it("offers no resume button once every step is proved", async () => {
    reads.connections = [LIVE_INSTAGRAM];
    reads.registration = {
      registrationState: "done",
      submittedAt: "2026-08-01T00:00:00.000Z",
      terminalRejection: false,
    };
    reads.businessProfiles = [{ id: "profile-1" }];
    reads.calendarConnections = [{ state: "ready" }];
    reads.provisioningSteps = [{ state: "done" }];
    reads.publishedOffer = { id: "offer-1" };
    await renderPage();

    expect(counter()).toHaveTextContent("6 of 6 done");
    expect(screen.getByText("Nothing here is left to finish.")).toBeVisible();
    expect(document.querySelectorAll("[class*='var(--accent-fill)']")).toHaveLength(0);
  });
});
