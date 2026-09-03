import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/provisioning",
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import {
  AdminProvisioning,
  provisioningViewRows,
} from "@/components/onboarding/admin-provisioning";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import type { ProvisioningTrackerRow } from "@/lib/onboarding/contracts";

const NOW = "2026-08-29T12:00:00.000Z";

function trackerRow(
  overrides: Partial<ProvisioningTrackerRow> = {},
): ProvisioningTrackerRow {
  return {
    signupIntentId: "intent-1",
    tenantId: "tenant-1",
    businessName: "Northstar Funding",
    signupState: "started",
    currentStep: "a2p_brand",
    state: "awaiting_provider",
    attempts: 1,
    errorCode: null,
    blockingParty: "provider",
    blockingProvider: "carrier",
    stalledSince: null,
    isDemo: null,
    contentScreenId: null,
    contentScreenState: null,
    ...overrides,
  };
}

function renderTracker(
  rows: ProvisioningTrackerRow[],
  submitted: Record<string, string | null> = {},
) {
  return render(
    <AdminProvisioning
      a2pSubmittedAtByTenant={submitted}
      initialRows={rows}
      nowIso={NOW}
    />,
  );
}

describe("AdminProvisioning", () => {
  it("says the carrier wait in days, with no percentage and no finish date", () => {
    renderTracker([trackerRow()], { "tenant-1": "2026-08-18T12:00:00.000Z" });

    const callout = screen.getByRole("status");
    expect(callout).toHaveTextContent("Text messaging is with the carrier");
    // Eleven whole days since the filing, said as a day count. A percentage or a predicted date
    // here would be the exact claim CLAUDE.md forbids about A2P.
    expect(callout).toHaveTextContent("day 11");
    expect(callout).toHaveTextContent("two to three weeks");
    expect(callout.textContent).not.toMatch(/%/);
  });

  /**
   * The published carrier window is one number in `contracts.ts`, and this expectation is built
   * from it rather than typed again. Three surfaces render the range; when each one declared its
   * own [14, 21] they agreed by coincidence, and the first edit to one of them would have shipped
   * two different published windows with nothing failing.
   */
  it("reads the carrier window from the contract rather than a copy of its own", () => {
    renderTracker([trackerRow()], { "tenant-1": "2026-08-18T12:00:00.000Z" });

    expect(screen.getByText("Day 11")).toHaveAttribute(
      "title",
      `Filed with the carrier 11 days ago. Typical is ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days.`,
    );
  });

  /**
   * The qualifier has to be on the surface, not in an attribute.
   *
   * Amber on a bare "Day 27" asserts that something is late. The sentence that makes that honest,
   * that the filing is past a *typical* window and not past anything the carrier promised, lived
   * only in `title` for three audit rounds -- invisible to touch, invisible to keyboard, and not
   * reliably announced. This asserts it against the rendered text, so moving it back into an
   * attribute fails. The window is read from the contract rather than typed again, so widening
   * `CARRIER_TYPICAL_DAYS` cannot leave this passing over copy that no longer matches.
   */
  it("shows the carrier window as text beside a count past it, not only in a tooltip", () => {
    const daysWaited = CARRIER_TYPICAL_DAYS[1] + 6;
    const submittedAt = new Date(
      new Date(NOW).getTime() - daysWaited * 86_400_000,
    ).toISOString();
    renderTracker([trackerRow()], { "tenant-1": submittedAt });

    const note = screen.getByText(
      `past typical ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days`,
    );
    expect(note).toBeInTheDocument();
    // Text, not an attribute: whatever carries the qualifier has to be readable without a hover.
    expect(note.textContent).toContain(String(CARRIER_TYPICAL_DAYS[1]));
    // Past the window is past a published range, never a broken commitment nobody made.
    const cell = note.closest("td") ?? note.parentElement;
    expect(cell?.textContent).toContain(`Day ${daysWaited}`);
    expect(cell?.textContent).not.toMatch(/overdue|late|missed|failed/i);
    expect(cell?.textContent).not.toMatch(/%/);
  });

  it("qualifies a carrier count inside the window with the same visible range", () => {
    renderTracker([trackerRow()], { "tenant-1": "2026-08-18T12:00:00.000Z" });

    expect(
      screen.getByText(`typical ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} days`),
    ).toBeInTheDocument();
  });

  it("counts every coach behind the oldest filing rather than one callout per row", () => {
    renderTracker(
      [
        trackerRow(),
        trackerRow({
          signupIntentId: "intent-2",
          tenantId: "tenant-2",
          businessName: "Ledger Lift",
        }),
      ],
      {
        "tenant-1": "2026-08-18T12:00:00.000Z",
        "tenant-2": "2026-08-27T12:00:00.000Z",
      },
    );

    const callout = screen.getByRole("status");
    expect(callout).toHaveTextContent("2 coaches are registering");
    expect(callout).toHaveTextContent("day 11");
  });

  it("bands the tracker by who has to move each row", () => {
    renderTracker([
      trackerRow(),
      trackerRow({
        signupIntentId: "intent-3",
        blockingParty: "platform",
        blockingProvider: null,
        currentStep: "ghl_snapshot",
        state: "pending",
      }),
    ]);

    // The bands are named for the wait, not the category, per screen 4a: the page's job is to say
    // who has to move each row, and the summary strip above the table uses the same three phrases.
    expect(
      screen.getByRole("columnheader", { name: /Waiting on a provider/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /Waiting on the platform/ }),
    ).toBeInTheDocument();
  });

  it("names the missing filing receipt instead of counting days from today", () => {
    renderTracker([trackerRow()], {});

    expect(screen.getByText("awaiting submission receipt")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

/**
 * Screen 4b: the unblock is the page's one privileged override, so the reason is mandatory, it is
 * composed in a dialog rather than a browser prompt, and the dialog does not overstate what the
 * write does.
 *
 * `sms_live` -- the step 4b draws -- deliberately cannot reach here: a blocked A2P step is
 * terminal in `actionsFor`, because a carrier decline is not something this tracker may override.
 * The fixture uses `ghl_snapshot`, which is a step the platform genuinely owns.
 */
describe("AdminProvisioning unblock", () => {
  function blockedRow() {
    return trackerRow({
      blockingParty: "platform",
      blockingProvider: null,
      currentStep: "ghl_snapshot",
      state: "blocked",
    });
  }

  async function openUnblockDialog() {
    renderTracker([blockedRow()]);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Northstar Funding" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /^Unblock/ }));
    return screen.findByRole("alertdialog");
  }

  it("takes the reason in a dialog and refuses to write without one", async () => {
    // Spied rather than `stubGlobal`, because `unstubAllGlobals` would also drop the
    // IntersectionObserver the shared UI setup installs and take the rest of the file with it.
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    const dialog = await openUnblockDialog();

    // The browser prompt this replaced could not show the step, the state or the consequence, and
    // gave the operator a single line to compose an audit receipt in.
    expect(prompt).not.toHaveBeenCalled();
    const confirm = within(dialog).getByRole("button", { name: /^Unblock the step/ });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText(/Why this is safe to override/), {
      target: { value: "Snapshot re-cut by hand; ticket 88214 has the receipt." },
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    prompt.mockRestore();
  });

  it("does not claim the step completes, because unblocking only returns it to pending", async () => {
    const dialog = await openUnblockDialog();

    expect(within(dialog).getByText(/returns to pending and runs again/)).toBeInTheDocument();
    expect(within(dialog).getByText(/it is not marked complete/)).toBeInTheDocument();
  });
});

describe("AdminProvisioning summary", () => {
  it("says the tracker could not be read rather than reporting four measured zeroes", () => {
    render(
      <AdminProvisioning
        initialError="Provisioning tracker is unavailable."
        initialRows={[]}
        nowIso={NOW}
      />,
    );

    const tiles = screen.getAllByTestId("stat-tile");
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(within(tile).getByText("The tracker has not answered.")).toBeInTheDocument();
      expect(within(tile).queryByText("0")).not.toBeInTheDocument();
    }
  });

  it("offers owner filters the rows can actually match", async () => {
    renderTracker([trackerRow()]);

    fireEvent.click(screen.getByRole("button", { name: /Owner/ }));

    // The static list this replaced offered "Provider-owned", which the Owner column never
    // produces: a carrier row resolves to its provider, so the option filtered to nothing.
    expect(
      await screen.findByRole("menuitemcheckbox", { name: /Mobile carrier/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitemcheckbox", { name: /Provider-owned/ }),
    ).not.toBeInTheDocument();
  });
});

describe("AdminProvisioning nav count", () => {
  it("counts only the rows somebody here can move, not the carrier wait", () => {
    // The rail only offers Provisioning once self-serve onboarding is live, so the destination
    // that carries the count has to exist before the count can be asserted on.
    vi.stubEnv("SETTERFI_PHASE5_LIVE", "true");
    renderTracker([
      // Provider-owned: a real wait, but not work anyone on this team can pick up.
      trackerRow(),
      trackerRow({
        signupIntentId: "intent-2",
        blockingParty: "platform",
        blockingProvider: null,
        currentStep: "ghl_snapshot",
        state: "pending",
      }),
    ]);

    const rail = screen.getByRole("navigation", { name: "Primary" });
    // The rail folded to eight destinations: /admin/provisioning has no row of its own and its
    // depth lands on Clients, the row `foldedNavTarget` maps it onto.
    const item = within(rail).getByRole("link", { name: /Clients/ });
    expect(
      item.closest("li")?.querySelector('[data-slot="nav-count"]'),
    ).toHaveTextContent("1");
    vi.unstubAllEnvs();
  });

  it("sits under Run in the breadcrumb trail", () => {
    renderTracker([trackerRow()]);

    expect(
      screen.getByRole("navigation", { name: "Breadcrumb" }),
    ).toHaveTextContent("Run");
  });
});

/**
 * The canvas's view switch, and the segment it deliberately does not have.
 *
 * `AdminProvisioning.dc.html` draws `In progress / Live / Stalled`. A live client has left this
 * tracker, so a `Live` segment would always be empty and would read as "no clients are live" on a
 * platform where plenty are -- which is the failure mode this project calls a control that lies
 * rather than a control that is missing.
 */
describe("the provisioning view switch", () => {
  const moving = {
    id: "a", stalled: false, terminal: false,
  } as unknown as Parameters<typeof provisioningViewRows>[0][number];
  const stalled = {
    id: "b", stalled: true, terminal: false,
  } as unknown as Parameters<typeof provisioningViewRows>[0][number];
  const blocked = {
    id: "c", stalled: false, terminal: true,
  } as unknown as Parameters<typeof provisioningViewRows>[0][number];

  it("splits the rows on the states a row actually carries", () => {
    const rows = [moving, stalled, blocked];
    expect(provisioningViewRows(rows, "progress")).toEqual([moving]);
    // A permanently blocked carrier filing is not moving either, and the reader looking for work
    // that has stopped is looking for both.
    expect(provisioningViewRows(rows, "stalled")).toEqual([stalled, blocked]);
    expect(provisioningViewRows(rows, "all")).toEqual(rows);
  });

  it("offers no Live segment, because no row here can be live", () => {
    render(
      <AdminProvisioning
        initialRows={[trackerRow()]}
        nowIso={NOW}
      />,
    );

    const bar = screen.getByLabelText("Provisioning view");
    expect(within(bar).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining("In progress"),
      expect.stringContaining("Stalled"),
      expect.stringContaining("Everything"),
    ]);
    expect(within(bar).queryByText(/^Live$/u)).toBeNull();
  });

  /**
   * The default is Everything, not the artboard's first segment. Opening on In progress would open
   * this page with every stalled row already hidden -- the rows most likely to need somebody, on
   * the page that exists to surface them.
   */
  it("hides nothing before a reader asks it to", () => {
    render(
      <AdminProvisioning
        initialRows={[
          trackerRow({ signupIntentId: "intent-stalled", state: "blocked", blockingParty: "provider" }),
        ]}
        nowIso={NOW}
      />,
    );

    expect(screen.getByText("Northstar Funding")).toBeInTheDocument();
  });
});
