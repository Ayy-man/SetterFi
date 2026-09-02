import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// The unavailable branch renders the kit's DataState, which reaches for the app router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { AdminAgentsSurface } from "@/components/workspace/live/admin-agents";
import {
  COACH_OWNED_SETTINGS,
  type AgentRoster,
  type AgentRosterEntry,
} from "@/lib/operations/agent-roster";

function entry(over: Partial<AgentRosterEntry> & { tenantId: string }): AgentRosterEntry {
  return {
    clientName: over.tenantId,
    isTest: false,
    state: "live",
    liveVersion: 3,
    publishedAt: "2026-08-20T00:00:00.000Z",
    unpublishedEdits: 0,
    latestEditAt: null,
    openThreads: 12,
    overrides: 4,
    accountState: "active",
    ...over,
  };
}

function roster(over: Partial<AgentRoster> = {}): AgentRoster {
  return {
    brainVersion: 18,
    settingCount: COACH_OWNED_SETTINGS.length,
    threadsUnavailable: false,
    entries: [
      entry({ tenantId: "alpha", clientName: "Alpha Coaching" }),
      entry({
        tenantId: "boyd",
        clientName: "Boyd Advisory",
        state: "never-published",
        liveVersion: null,
        publishedAt: null,
        openThreads: 0,
        overrides: 0,
      }),
    ],
    ...over,
  };
}

function detail() {
  return within(document.querySelector('[data-slot="agent-detail"]') as HTMLElement);
}

describe("AdminAgentsSurface", () => {
  it("counts agents as clients and says so, rather than implying a larger roster", () => {
    render(<AdminAgentsSurface roster={roster()} />);

    /*
     * The artifact's "14 across 8 clients" is a product SetterFi is not; the header states the
     * one-per-client rule so a reader never wonders where the other agents went.
     *
     * The canvas port put its purpose sentence between the rule and the counts, so this matches
     * the two halves separately rather than as one run. The claim is unchanged and is the reason
     * the test exists: the count is the CLIENT count, and the header says so in the same breath.
     */
    expect(screen.getByText(/One setter per client\./)).toBeInTheDocument();
    expect(screen.getByText(/2 clients, 1 answering leads/)).toBeInTheDocument();
    expect(screen.getByText(/caught before a lead meets it/)).toBeInTheDocument();
  });

  /**
   * Three states, three sentences. A live agent with pending edits is working correctly on older
   * instructions; a drafted one is answering nothing at all. Collapsing them into one coloured
   * word is what sends an admin after the wrong coach.
   */
  it("says what an agent is doing in words, and never reads a never-published one as live", async () => {
    render(<AdminAgentsSurface roster={roster()} />);

    expect(detail().getByText(/Answering leads on version 3\. Nothing is saved above it\./))
      .toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Boyd Advisory/ }));
    expect(
      detail().getByText(/never been published, so it has not answered a lead/),
    ).toBeInTheDocument();
    // A published version of zero would be the honest-states failure this replaces.
    expect(detail().getByText("nothing published")).toBeInTheDocument();
    expect(detail().queryByText("v0")).toBeNull();
  });

  it("states pending edits as a count, and only when there are some", async () => {
    render(
      <AdminAgentsSurface
        roster={roster({
          entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching", unpublishedEdits: 2 })],
        })}
      />,
    );

    expect(
      detail().getByText(/2 newer edits are saved and not published/),
    ).toBeInTheDocument();
    expect(detail().getByText(/Waiting to be published/)).toBeInTheDocument();
  });

  it("draws no pending block for an agent with nothing saved above its live version", () => {
    render(<AdminAgentsSurface roster={roster()} />);
    expect(document.querySelector('[data-slot="pending-edits"]')).toBeNull();
  });

  /**
   * The inheritance strip is the screen's one real claim about the brain, so it is counted from
   * the offer layer rather than written as a literal, and it names the version it inherits from.
   */
  it("counts inherited settings from the overrides rather than asserting a number", () => {
    render(
      <AdminAgentsSurface
        roster={roster({
          brainVersion: 18,
          settingCount: 18,
          entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching", overrides: 4 })],
        })}
      />,
    );

    const strip = within(document.querySelector('[data-slot="inheritance-strip"]') as HTMLElement);
    expect(strip.getByText("14 of 18")).toBeInTheDocument();
    expect(strip.getByText(/settings come from The Brain v18/)).toBeInTheDocument();
  });

  it("declines to name a brain version when none is published", () => {
    render(<AdminAgentsSurface roster={roster({ brainVersion: null })} />);

    const strip = within(document.querySelector('[data-slot="inheritance-strip"]') as HTMLElement);
    expect(strip.getByText(/Which version is published could not be read/)).toBeInTheDocument();
    expect(strip.queryByText(/The Brain v/)).toBeNull();
  });

  it("reads an unavailable thread count as unavailable rather than as zero", () => {
    render(
      <AdminAgentsSurface
        roster={roster({
          threadsUnavailable: true,
          entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching", openThreads: null })],
        })}
      />,
    );

    expect(detail().getByText("not readable right now")).toBeInTheDocument();
    expect(screen.getByText(/thread count unavailable/)).toBeInTheDocument();
  });

  /**
   * The artifact pairs "44% booked" with "312 open threads". The platform has no per-agent booking
   * rate, so the rate is absent everywhere rather than substituted from a different denominator.
   */
  it("shows no booking rate anywhere, because none exists per agent", () => {
    const { container } = render(<AdminAgentsSurface roster={roster()} />);
    expect(container.textContent).not.toMatch(/%\s*booked|booked\s*%/iu);
  });

  it("keeps a seeded client in the list wearing its label", () => {
    render(
      <AdminAgentsSurface
        roster={roster({
          entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching", isTest: true })],
        })}
      />,
    );
    expect(screen.getAllByText(/Seeded test client, excluded from analytics/).length)
      .toBeGreaterThan(0);
  });

  it("filters the list by state and counts every segment", async () => {
    render(<AdminAgentsSurface roster={roster()} />);

    const segments = screen.getByRole("group", { name: "Agent view" });
    expect(within(segments).getByRole("button", { name: /Draft/ })).toHaveTextContent("1");

    await userEvent.click(within(segments).getByRole("button", { name: /Live/ }));
    const list = within(document.querySelector('[data-slot="agent-list"]') as HTMLElement);
    expect(list.getByText("Alpha Coaching")).toBeInTheDocument();
    expect(list.queryByText("Boyd Advisory")).toBeNull();
  });

  /**
   * Publishing is not wired from this screen, so there is no live action to light. A fill here
   * would be a control that does nothing, which is exactly the failure the brief warns about --
   * this pin means nobody can add one without first adding a real publish.
   */
  it("spends no accent fill: nothing on this page acts", () => {
    const { container } = render(<AdminAgentsSurface roster={roster()} />);
    expect(
      container.querySelectorAll('[data-slot="kit-button"][data-variant="primary"]'),
    ).toHaveLength(0);
  });

  /**
   * A paused client's agent is not a draft and it is not broken, and the sentence has to say the
   * true thing.
   *
   * `tenants.status` was always selected by `readTenants` and always dropped by
   * `buildAgentRoster`, so the screen could show a perfectly published agent as "answering leads
   * on version 3" while the client's account was switched off and nobody was being replied to.
   * That is a false sentence on the one screen whose job is catching agents that are not working.
   */
  it("never reads a paused client's agent as answering leads", () => {
    render(<AdminAgentsSurface roster={roster({
      entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching", accountState: "paused" })],
    })} />);

    const detail = within(document.querySelector('[data-slot="agent-detail"]') as HTMLElement);
    expect(detail.getByText(/this client's account is paused/i)).toBeInTheDocument();
    expect(detail.queryByText(/^Answering leads on version/)).toBeNull();
  });

  /**
   * The queue exists so an operator does not have to work the filter segments one at a time to
   * find what is not answering. Every row carries a sentence, which is the Never-Colour-Alone rule
   * doing real work here: paused and never-published are different jobs with different people to
   * chase, and a coloured mark alone cannot tell them apart.
   */
  it("gathers every agent that is not answering leads, each with the reason in words", () => {
    render(<AdminAgentsSurface roster={roster({
      entries: [
        entry({ tenantId: "alpha", clientName: "Alpha Coaching" }),
        entry({ tenantId: "paused", clientName: "Paused Co", accountState: "paused" }),
        entry({ tenantId: "never", clientName: "Never Co", state: "never-published", liveVersion: null }),
      ],
    })} />);

    const queue = within(document.querySelector('[data-slot="agents-waiting"]') as HTMLElement);
    expect(queue.getByText("Paused Co")).toBeInTheDocument();
    expect(queue.getByText("Never Co")).toBeInTheDocument();
    // The one that IS answering stays out of the queue.
    expect(queue.queryByText("Alpha Coaching")).toBeNull();
    expect(queue.getByText(/account is paused, so the setter is answering nobody/)).toBeInTheDocument();
    expect(queue.getByText(/has never been published/)).toBeInTheDocument();
  });

  it("draws no waiting queue at all when every agent is answering", () => {
    render(<AdminAgentsSurface roster={roster({
      entries: [entry({ tenantId: "alpha", clientName: "Alpha Coaching" })],
    })} />);

    expect(document.querySelector('[data-slot="agents-waiting"]')).toBeNull();
  });

  /**
   * Every table in the product exports CSV and JSON. This screen had no export at all, so the
   * roster could only be read, and an operator chasing unpublished agents across a spreadsheet
   * retyped it. The drift this catches is the control being dropped again in a later pass.
   */
  it("offers the roster as an export", () => {
    render(<AdminAgentsSurface roster={roster()} />);

    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });

  it("sends every setting to the one place that owns it, rather than editing it twice", () => {
    render(<AdminAgentsSurface roster={roster()} />);

    const owned = [...document.querySelectorAll('[data-slot="owned-elsewhere"]')];
    expect(owned.length).toBeGreaterThan(0);
    for (const row of owned) {
      expect(row.getAttribute("href")).toMatch(/^\/(coach|admin)\//u);
    }
  });
});
