import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { MessagingInstallPanel } from "@/components/onboarding/messaging-install-panel";
import {
  agencyGrantFacts,
  agencyInstallSummaryLine,
} from "@/components/onboarding/messaging-install-view-models";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import {
  AdminChannelHealth,
  demoMarkedName,
} from "@/components/workspace/live/admin-channel-health";

describe("AdminChannelHealth", () => {
  afterEach(cleanup);

  it.each([
    { enabled: false, scope: "tenant" as const },
    { enabled: true, scope: "unscoped" as const },
    { enabled: true, scope: "tenant" as const },
  ])("renders exactly one h1 for every data state", ({ enabled, scope }) => {
    const { container } = render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        enabled={enabled}
        scope={scope}
        selectedClientId={scope === "tenant" ? "client-one" : null}
        templates={[]}
      />,
    );

    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelector("h1")).toHaveTextContent("Channel health");
  });

  it("keeps the unscoped client picker reachable from the Channel health navigation item", () => {
    render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        scope="unscoped"
        templates={[]}
      />,
    );

    expect(
      screen.getAllByRole("link", { name: /Channel health/i })[0],
    ).toHaveAttribute("href", "/admin/channel-health");
    expect(
      screen.getByRole("combobox", { name: "Choose client" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Select a client from Platform clients"),
    ).not.toBeInTheDocument();
  });

  it("names the receipt behind a positive connection state", () => {
    render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[
          {
            id: "connection-one",
            channel: "instagram",
            channelLabel: "Instagram",
            state: "ready",
            externalAccountLabel: "Reid Funding Group",
            capabilities: {
              postWindow: "none",
              templates: false,
              windowed: true,
            },
            receipts: {
              oauthCompletedAt: "2026-08-20T10:00:00.000Z",
              assetVerifiedAt: "2026-08-20T10:05:00.000Z",
              webhookSubscribedAt: "2026-08-20T10:10:00.000Z",
              signedRoundTripAt: null,
            },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-20T10:10:00.000Z",
          },
        ]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    expect(
      screen.getByText("OAuth and asset receipts stored"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
  });

  it("hides tenant evidence when the selected client cannot be classified", () => {
    render(
      <AdminChannelHealth
        clients={[]}
        clientsUnavailable
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Clients could not load" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Meta review package" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("keeps filing with the operator and separates the Meta wait", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Meta review package" }),
    );

    // Re-pointed at the checklist that replaced the journey here, with the same claim: filing is
    // ours, the review after it is not, and the two are never merged into one wait.
    const filingStep = screen.getByText("Submit review package").closest("li");
    const reviewStep = screen.getByText("Meta review").closest("li");
    expect(filingStep).not.toBeNull();
    expect(reviewStep).not.toBeNull();
    expect(within(filingStep!).getByText("You")).toBeInTheDocument();
    expect(within(reviewStep!).getByText("Meta")).toBeInTheDocument();
  });

  /**
   * Screen 5j draws six steps with the first one marked current and the rest blocked. Nothing in
   * this product stores where a Meta filing has got to: `MetaReviewReceipt` has no repository, no
   * route and no column, so those six states were typed into the source. The list renders as the
   * work required, and says so.
   */
  it("reports no progress against the review steps, because nothing records any", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Meta review package" }));

    const list = screen.getByRole("list", { name: "Meta app review steps" });
    const steps = within(list).getAllByRole("listitem");
    expect(steps).toHaveLength(6);

    // The journey grammar this replaced: a current step, a badge naming who holds it, and a
    // "After <previous step>" badge on everything behind it. None of it was measured.
    expect(list.querySelector("[aria-current]")).toBeNull();
    for (const step of steps) {
      expect(step.textContent).not.toMatch(/Ready for you|Waiting on|^After |Nothing for you to do/);
    }
    expect(
      screen.getByText(/stores no record of a Meta filing/),
    ).toBeInTheDocument();
  });

  /**
   * The contract says an external clock extends only the work it blocks, day for day. A sheet
   * showing six blocking steps and nothing else reads as a hold on the whole build.
   */
  it("scopes the block to the channels it actually blocks, and predicts no decision date", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Meta review package" }));

    expect(screen.getByText(/does not hold the rest of the build/)).toBeInTheDocument();
    /*
     * The checklist ends at Meta's decision, so approval reads as the thing that makes the
     * channel live. `channel_connections_meta_live_receipt_chk` requires a signed round trip and
     * both message references before a meta_direct row may read live, and nothing in this
     * repository writes any of the three: the connect route stamps oauth, asset and subscription
     * receipts and stops at ready.
     */
    expect(screen.getByText(/Approval is not the last link/)).toBeInTheDocument();
    expect(screen.getByText(/nothing yet records the signed round trip/)).toBeInTheDocument();
    expect(screen.getByText(/no day counter runs until a filing reference is stored/)).toBeInTheDocument();
    // Not filed, and it says so: the state pill is derived, never a cheerful default.
    expect(screen.getByText("Not filed")).toBeInTheDocument();
  });

  it("bands the rows by state and drops the state pill column that would repeat the band", () => {
    const { container } = render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[
          {
            id: "connection-one",
            channel: "instagram",
            channelLabel: "Instagram",
            state: "ready",
            externalAccountLabel: "Reid Funding Group",
            capabilities: {
              postWindow: "none",
              templates: false,
              windowed: true,
            },
            receipts: {
              oauthCompletedAt: "2026-08-20T10:00:00.000Z",
              assetVerifiedAt: "2026-08-20T10:05:00.000Z",
              webhookSubscribedAt: "2026-08-20T10:10:00.000Z",
              signedRoundTripAt: null,
            },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-20T10:10:00.000Z",
          },
        ]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const bands = Array.from(
      container.querySelectorAll('[data-slot="data-table-group-row"]'),
    );
    expect(bands.length).toBeGreaterThan(0);
    const headers = Array.from(container.querySelectorAll("thead th")).map(
      (cell) => cell.textContent,
    );
    expect(headers.some((header) => header?.includes("Receipts"))).toBe(true);
    expect(headers.some((header) => header?.trim() === "State")).toBe(false);
  });

  it("puts the receipt table on the ledger treatment, and says what each band means", () => {
    const { container } = render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    expect(
      container.querySelector('[data-slot="data-table"]'),
    ).toHaveAttribute("data-variant", "ledger");
    const annotations = [
      ...container.querySelectorAll('[data-slot="table-group-annotation"]'),
    ].map((node) => node.textContent);
    expect(annotations).toContain(
      "nothing sends or receives here until the receipt is stored",
    );
    // The band is the state, so the sentence under the count is the only place the table admits
    // that its top row is the worst one rather than the first one.
    expect(
      container.querySelector('[data-slot="table-footer-ordering"]')
        ?.textContent,
    ).toContain("the channels short of one first");
  });

  it("says a channel has no receipts in words rather than leaving the cell blank", () => {
    const { container } = render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const absences = Array.from(
      container.querySelectorAll('[data-slot="cell-quiet"]'),
    );
    expect(absences.map((node) => node.textContent)).toContain(
      "no connection receipts stored",
    );
  });

  it("counts the channels still short of a receipt beside the rail item", () => {
    const { container } = render(
      <AdminChannelHealth
        clients={[
          { id: "client-one", isDemo: false, name: "Reid Funding Group" },
        ]}
        connections={[]}
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const counts = Array.from(
      container.querySelectorAll('[data-slot="nav-count"]'),
    ).map((node) => node.textContent);
    expect(counts.length).toBeGreaterThan(0);
    expect(counts.every((value) => value !== "0")).toBe(true);
  });
  /**
   * Rule: no hardcoded counts. Every figure in the health strip is the length of the list banded
   * under the same name in the table, so the two can never disagree, and a channel moving between
   * states moves the figure with it.
   */
  it("derives every health figure from the rows banded under the same name", () => {
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { templates: false, windowed: true },
            channel: "instagram",
            channelLabel: "Instagram",
            createdAt: "2026-08-01T00:00:00.000Z",
            externalAccountLabel: "@reidfunding",
            id: "conn-live",
            receipts: {
              assetVerifiedAt: "2026-08-02T00:00:00.000Z",
              oauthCompletedAt: "2026-08-01T00:00:00.000Z",
              signedRoundTripAt: "2026-08-03T00:00:00.000Z",
              webhookSubscribedAt: "2026-08-02T00:00:00.000Z",
            },
            state: "live",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        ]}
        enabled
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const strip = screen.getByLabelText("Channel health");
    const figureFor = (band: string) => {
      const cell = within(strip).getByText(band).parentElement as HTMLElement;
      return Number(within(cell).getByText(/^\d+$/).textContent);
    };

    // Every channel the table renders is counted exactly once across the three figures.
    const renderedRows = document.querySelectorAll("[data-row-id]").length;
    expect(renderedRows).toBeGreaterThan(0);
    expect(
      figureFor("Missing a receipt")
      + figureFor("Waiting on a provider")
      + figureFor("Signed round trip received"),
    ).toBe(renderedRows);

    // The one connection carrying a signed round trip is the whole of the live figure, and the
    // note under it is the list it was counted from rather than a written-out name.
    expect(figureFor("Signed round trip received")).toBe(1);
    const live = within(strip).getByText("Signed round trip received").parentElement as HTMLElement;
    expect(within(live).getByText("Instagram")).toBeInTheDocument();
  });

  /**
   * Rule: honest provisioning, and no fabricated statistic. The artifact's blast-radius tiles count
   * paused agents and queued leads; nothing behind this page records either against a connection,
   * so the sheet has to say the count is missing rather than print a plausible one.
   */
  it("names what a broken channel affects without inventing a count of agents or leads", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        enabled
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /Instagram/ })[0]);

    const affects = await screen.findByText(/no count is shown here rather than an estimated one/i);
    expect(affects).toBeInTheDocument();
    expect(screen.queryByText(/\d+ agents? paused/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d+ leads? queuing/i)).not.toBeInTheDocument();
  });

  /**
   * Screen 1f opens a broken channel on a cause, and both facts behind that sentence have been
   * columns on `channel_connections` since the first migration -- the read was dropping them. A
   * channel that says "Needs attention" and nothing else sends an operator to Meta's console to
   * find out why, which is the trip this page exists to save.
   */
  it("says what the provider recorded and when the credential expired", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { templates: false, windowed: true },
            channel: "instagram",
            channelLabel: "Instagram",
            createdAt: "2026-08-01T00:00:00.000Z",
            error: "Instagram revoked the token when the account password changed.",
            externalAccountLabel: "@reid.capital",
            id: "conn-broken",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: null,
              signedRoundTripAt: null,
              webhookSubscribedAt: null,
            },
            state: "expired",
            tokenExpiresAt: "2026-08-29T00:00:00.000Z",
            updatedAt: "2026-08-29T00:00:00.000Z",
          },
        ]}
        enabled
        nowIso="2026-08-31T00:00:00.000Z"
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /Instagram/ })[0]);

    // The provider's own words, verbatim: rewriting them into something friendlier would break
    // the only string an operator can search the provider's console for.
    expect(
      await screen.findByText("Instagram revoked the token when the account password changed."),
    ).toBeInTheDocument();
    expect(screen.getByText(/Its credential expired on/)).toBeInTheDocument();
  });

  /**
   * An empty reason column is a fact of its own. Guessing a cause that merely fits the state is
   * the fabrication the rest of this page refuses everywhere else.
   */
  it("says the reason was not recorded rather than inferring one from the state", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        enabled
        nowIso="2026-08-31T00:00:00.000Z"
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /Instagram/ })[0]);

    expect(
      await screen.findByText(/The provider recorded no reason on this connection/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Its credential expired on/)).not.toBeInTheDocument();
  });

  /**
   * Rule: the one fix is derived, not written. The receipt checks are built in the order a
   * connection earns them, so the first outstanding one is the next step and nothing later can be
   * offered ahead of it.
   */
  it("leads the fix with the first outstanding receipt, not a written-out remediation", async () => {
    const user = userEvent.setup();
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { templates: false, windowed: true },
            channel: "instagram",
            channelLabel: "Instagram",
            createdAt: "2026-08-01T00:00:00.000Z",
            externalAccountLabel: "@reidfunding",
            id: "conn-partial",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: "2026-08-01T00:00:00.000Z",
              signedRoundTripAt: null,
              webhookSubscribedAt: null,
            },
            state: "ready",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        ]}
        enabled
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: /Instagram/ })[0]);

    const fix = await screen.findByText(/Confirm the account asset the agent replies from\./);
    expect(fix).toBeInTheDocument();
    // OAuth is already stored, so re-authenticating is not offered as a step at all.
    expect(screen.queryByText(/Re-authenticate the account\./)).not.toBeInTheDocument();
  });
  /**
   * Rule: the carrier wait is a real elapsed day count against the published window, never a
   * percentage and never a predicted decision date. The window itself comes from the shared
   * contract, so the coach's onboarding page and this operator screen cannot print different
   * numbers for the same registration.
   */
  it("prints the carrier day count from the filing and the shared window", () => {
    render(
      <AdminChannelHealth
        a2pSubmittedAt="2026-08-19T16:00:00.000Z"
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { postWindow: "none", templates: false, windowed: false },
            channel: "sms",
            channelLabel: "Text messages (SMS)",
            createdAt: "2026-08-10T00:00:00.000Z",
            externalAccountLabel: "(720) 555-0164",
            id: "conn-sms",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: null,
              signedRoundTripAt: null,
              webhookSubscribedAt: null,
            },
            state: "connecting",
            updatedAt: "2026-08-19T16:00:00.000Z",
          },
        ]}
        enabled
        nowIso="2026-08-31T16:00:00.000Z"
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const strip = screen.getByLabelText("Channel health");
    const waiting = within(strip).getByText("Waiting on a provider").parentElement as HTMLElement;
    expect(within(waiting).getByText(
      new RegExp(`day 12 of the carrier's ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} day window`),
    )).toBeInTheDocument();
    // No percentage, and no date sitting inside the window pretending to be a decision day.
    expect(waiting.textContent ?? "").not.toMatch(/%/);
    expect(waiting.textContent ?? "").not.toMatch(/by \w+ \d/);
  });

  /**
   * Rule: an absence is not a state. With no filing receipt stored there is no day to count, so
   * the note falls back to naming the channels rather than counting from the connection's own age.
   */
  it("counts no carrier days when nothing has been filed", () => {
    render(
      <AdminChannelHealth
        a2pSubmittedAt={null}
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { postWindow: "none", templates: false, windowed: false },
            channel: "sms",
            channelLabel: "Text messages (SMS)",
            createdAt: "2026-08-10T00:00:00.000Z",
            externalAccountLabel: "(720) 555-0164",
            id: "conn-sms",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: null,
              signedRoundTripAt: null,
              webhookSubscribedAt: null,
            },
            state: "connecting",
            updatedAt: "2026-08-19T16:00:00.000Z",
          },
        ]}
        enabled
        nowIso="2026-08-31T16:00:00.000Z"
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const strip = screen.getByLabelText("Channel health");
    const waiting = within(strip).getByText("Waiting on a provider").parentElement as HTMLElement;
    // SMS is genuinely in the waiting band, so this is the band naming it with no day count
    // rather than an empty band that could never have printed one.
    expect(within(waiting).getByText(/Text messages/)).toBeInTheDocument();
    expect(waiting.textContent ?? "").not.toMatch(/day \d/);
  });

  /**
   * Rule: honest states, and no fabricated provider fact. A messaging window belongs to the
   * provider a channel connected through, so it is read off that connection's own capabilities and
   * a channel with nothing stored gets no sentence at all.
   */
  it("states a messaging window only for a channel that has a stored connection", () => {
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { postWindow: "template", templates: true, windowed: true },
            channel: "whatsapp",
            channelLabel: "WhatsApp",
            createdAt: "2026-08-01T00:00:00.000Z",
            externalAccountLabel: "+1 (720) 555-0180",
            id: "conn-wa",
            receipts: {
              assetVerifiedAt: "2026-08-02T00:00:00.000Z",
              oauthCompletedAt: "2026-08-01T00:00:00.000Z",
              signedRoundTripAt: "2026-08-03T00:00:00.000Z",
              webhookSubscribedAt: "2026-08-02T00:00:00.000Z",
            },
            state: "live",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        ]}
        enabled
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    const windows = screen.getByText("Messaging windows").closest('[data-slot="surface"]') as HTMLElement;
    expect(windows).not.toBeNull();
    // The stored connection's own capability, template post-window and all.
    expect(within(windows).getByText(/then an approved template only/i)).toBeInTheDocument();
    // Instagram has no connection here, so the card says nothing about its window.
    expect(within(windows).queryByText("Instagram")).not.toBeInTheDocument();
  });

  /**
   * Rule: the empty state has to carry the reason, not just the instruction. Pooling receipts
   * across tenants is the mistake this surface exists to prevent, so the copy says why rather than
   * leaving "choose a client" to read as an arbitrary gate.
   */
  it("explains why nothing is pooled across clients before anything is chosen", () => {
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        enabled
        scope="unscoped"
        selectedClientId={null}
        templates={[]}
      />,
    );

    // The reason, not just the instruction, and it is not the page subtitle said twice.
    expect(screen.getByText(/pooled across clients on purpose/i)).toBeInTheDocument();
    expect(screen.getByText(/proves nothing about another/i)).toBeInTheDocument();
  });

  /**
   * Rule: the band says a receipt is missing and the cell says the connection is incomplete;
   * neither can say which receipt. The row names it, from the same ordered checks the sheet's fix
   * reads, so a row and its sheet can never disagree about the next step.
   */
  it("names the next receipt a partial connection needs, on the row", () => {
    render(
      <AdminChannelHealth
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[
          {
            capabilities: { postWindow: "none", templates: false, windowed: true },
            channel: "instagram",
            channelLabel: "Instagram",
            createdAt: "2026-08-01T00:00:00.000Z",
            externalAccountLabel: "@reidfunding",
            id: "conn-partial",
            receipts: {
              assetVerifiedAt: null,
              oauthCompletedAt: "2026-08-01T00:00:00.000Z",
              signedRoundTripAt: null,
              webhookSubscribedAt: null,
            },
            state: "ready",
            updatedAt: "2026-08-02T00:00:00.000Z",
          },
        ]}
        enabled
        scope="tenant"
        selectedClientId="client-one"
        templates={[]}
      />,
    );

    expect(screen.getByText(/The account asset check is the next receipt it needs\./))
      .toBeInTheDocument();
    // OAuth is stored, so the row never asks for it again.
    expect(screen.queryByText(/Re-authentication is the next receipt it needs\./))
      .not.toBeInTheDocument();
  });
});

describe("demoMarkedName", () => {
  it("does not append a second marker to a seeded name that already carries one", () => {
    expect(
      demoMarkedName({
        id: "one",
        isDemo: true,
        name: "Elevate Funding Co. (demo)",
      }),
    ).toBe("Elevate Funding Co. (demo)");
  });

  it("still labels a demo tenant whose stored name carries no marker", () => {
    expect(
      demoMarkedName({ id: "two", isDemo: true, name: "Reid Funding Group" }),
    ).toBe("Reid Funding Group (demo)");
  });

  it("leaves a real client's name alone", () => {
    expect(
      demoMarkedName({
        id: "three",
        isDemo: false,
        name: "Reid Funding Group",
      }),
    ).toBe("Reid Funding Group");
  });
});

describe("MessagingInstallPanel", () => {
  afterEach(cleanup);

  it("does not call the agency action a reconnect from a client-location receipt", () => {
    render(
      <MessagingInstallPanel
        connectedClients={{ real: 1, demo: 0 }}
        enabled
        installsChecked
        messagingAgencyState={{
          label: "No stored credential",
          tone: "neutral",
        }}
        provisioningAgencyState={{
          label: "No stored credential",
          tone: "neutral",
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Connect messaging/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Reconnect messaging/i }),
    ).not.toBeInTheDocument();
  });

  /**
   * Rule: the wizard warns about warm-up before it connects, and it says what it cannot know.
   *
   * A newly approved account can send before it should, and no stored column expresses that state,
   * so the warning has to be readable ahead of the connect action rather than after the approval
   * returns -- and it must not draw a ramp, a percentage or a day-one volume no row could produce.
   */
  it("warns about warm-up ahead of the connect action and admits the state is not recorded", () => {
    render(
      <MessagingInstallPanel
        connectedClients={{ real: 0, demo: 0 }}
        enabled
        installsChecked
        messagingAgencyState={{ label: "No stored credential", tone: "neutral" }}
        provisioningAgencyState={{ label: "No stored credential", tone: "neutral" }}
      />,
    );

    const warning = screen.getByRole("note");
    expect(warning).toHaveTextContent(/should not send at full volume on its first day/i);
    expect(warning).toHaveTextContent(/does not record a warm-up state against a connection/i);
    // No percentage and no predicted volume: the honest-state rule applies to warm-up too.
    expect(warning.textContent ?? "").not.toMatch(/%|\d+\s*(DMs|messages)/i);

    // Ahead of the connect action in document order, so it is read before anything is approved.
    const connect = screen.getByRole("button", { name: /Connect messaging/i });
    expect(warning.compareDocumentPosition(connect) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy();
  });

  /**
   * Rule: at most one accent fill per page. Two filled primaries made two live actions on a screen
   * that only ever has one, and a page with both credentials stored spends none at all.
   */
  it("fills only the first approval that is not already stored", () => {
    const { rerender } = render(
      <MessagingInstallPanel
        connectedClients={{ real: 0, demo: 0 }}
        enabled
        installsChecked
        messagingAgencyState={{ label: "No stored credential", tone: "neutral" }}
        provisioningAgencyState={{ label: "No stored credential", tone: "neutral" }}
      />,
    );

    // The filled primary is the only button carrying the accent ground; a secondary does not.
    const filled = () => Array.from(
      document.querySelectorAll<HTMLElement>('[data-slot="button"].bg-primary'),
    );
    expect(filled()).toHaveLength(1);
    expect(filled()[0]).toHaveTextContent(/Connect messaging/i);

    rerender(
      <MessagingInstallPanel
        connectedClients={{ real: 0, demo: 0 }}
        enabled
        installsChecked
        messagingAgencyState={{ label: "Stored credential read", tone: "good" }}
        provisioningAgencyState={{ label: "Stored credential read", tone: "good" }}
      />,
    );

    // Nothing left to approve, so nothing is lit.
    expect(filled()).toHaveLength(0);
  });
});

/**
 * The Aug 21 agency rows, which is the shape production actually holds: a grant stored once, with
 * `updated_at` still equal to `created_at` and all three consent flags null because they were
 * persisted by a later migration. Everything below is synthetic -- no credential, no company id,
 * nothing that came from a provider -- so the rendered DOM is safe to keep as a deliverable.
 */
const STORED_AT = "2026-08-21T14:05:00.000Z";

const staleFacts = agencyGrantFacts({
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  approveAllLocations: null,
  isBulkInstallation: null,
  installToFutureLocations: null,
});

/** The state the install-state column alone would produce for that row. */
const columnState = { label: "Connected", tone: "good" } as const;

function renderStalePanel() {
  return render(
    <MessagingInstallPanel
      connectedClients={{ real: 0, demo: 0 }}
      enabled
      installsChecked
      messagingAgencyState={columnState}
      messagingGrant={{ stored: true, facts: staleFacts }}
      provisioningAgencyState={columnState}
      provisioningGrant={{ stored: true, facts: staleFacts }}
    />,
  );
}

function statusTexts(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-slot="status"]'))
    .map((node) => node.textContent ?? "");
}

describe("MessagingInstallPanel, on a grant nothing has ever refreshed", () => {
  afterEach(cleanup);

  /**
   * Rule: nothing on this panel may read as connected or current from a stale row.
   *
   * `install_state` says `token_ok`, so the column-only answer is "Connected". Nothing in this
   * codebase has touched the row since the day it was stored, so that word is withheld and the
   * reader gets the fact that is known instead.
   */
  it("says how long the grant has sat untouched instead of calling it connected", () => {
    const { container } = renderStalePanel();

    // The "Last refreshed" row of each app's fact list, verbatim.
    expect(screen.getAllByText("Never refreshed since Aug 21, 2026")).toHaveLength(2);
    // Four statuses carry it: each app's state pill, which is the claim a reader weighs first,
    // plus each fact row. The state pill is where "Connected" would otherwise have been.
    expect(statusTexts(container).filter((text) => /never refreshed since Aug 21, 2026/i.test(text)))
      .toHaveLength(4);
    expect(statusTexts(container).filter((text) => /^Stored credential read: Never refreshed/.test(text)))
      .toHaveLength(2);
    for (const text of statusTexts(container)) {
      expect(text).not.toMatch(/connected/i);
    }
    // A timestamp on a row nothing has refreshed reads as recent activity. There is none to print.
    expect(container.textContent ?? "").not.toMatch(/Aug 21, 2026, \d/);
    expect(screen.getAllByText("Grant installed")).toHaveLength(2);
    expect(screen.getAllByText("Aug 21, 2026")).toHaveLength(2);
  });

  /**
   * Rule: a flag the install never reported is not the installer's answer. All three were added by
   * a later migration with no backfill, so every row written before it reads this way.
   */
  it("reports the three consent flags as not recorded rather than as a no", () => {
    renderStalePanel();

    for (const term of [
      "Covers future sub-accounts",
      "All sub-accounts approved at install",
      "Installed in bulk",
    ]) {
      expect(screen.getAllByText(term)).toHaveLength(2);
    }
    expect(screen.getAllByText("Not recorded")).toHaveLength(6);
  });

  /**
   * Rule: the whole point of the call. The approval screen has to have every sub-account selected
   * or the ones left out get no messaging app, so the messaging row says so in one line.
   */
  it("says what has to be selected on the approval screen", () => {
    renderStalePanel();

    expect(screen.getByRole("button", { name: /Reconnect messaging/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reconnect provisioning/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Connect /i })).not.toBeInTheDocument();

    // Only the messaging app: the provisioning app's approval is not per-sub-account.
    expect(screen.getAllByText("On the approval screen, choose all sub-accounts.")).toHaveLength(1);
  });

  it("names the date the grant was last refreshed", () => {
    const { container } = renderStalePanel();
    expect(container.innerHTML).toContain("Never refreshed since Aug 21, 2026");
  });
});

describe("the marketplace install card on channel health", () => {
  afterEach(cleanup);

  const summary = agencyInstallSummaryLine({ state: columnState, facts: staleFacts });

  /**
   * Rule: the card is findable without choosing a client, because one agency approval covers every
   * client -- and it may not read better than the panel it points at.
   */
  it("states both apps and links to the panel, before any client is chosen", () => {
    const { container } = render(
      <AdminChannelHealth
        agencyInstalls={[
          { app: "agent", label: summary.label, title: "Messaging app", tone: summary.tone },
          { app: "provisioning", label: summary.label, title: "Provisioning app", tone: summary.tone },
        ]}
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        scope="unscoped"
        templates={[]}
      />,
    );

    expect(screen.getByText("Marketplace installs")).toBeInTheDocument();
    expect(screen.getByText("Messaging app")).toBeInTheDocument();
    expect(screen.getByText("Provisioning app")).toBeInTheDocument();
    expect(screen.getAllByText("Never refreshed since Aug 21, 2026")).toHaveLength(2);
    for (const text of statusTexts(container)) {
      expect(text).not.toMatch(/connected/i);
    }
    expect(screen.getByRole("link", { name: /Open marketplace installs/i }))
      .toHaveAttribute("href", "/admin/provisioning#marketplace-installs");
  });

  it("shows no card at all when the read did not run", () => {
    render(
      <AdminChannelHealth
        agencyInstalls={null}
        clients={[{ id: "client-one", isDemo: false, name: "Reid Funding Group" }]}
        connections={[]}
        scope="unscoped"
        templates={[]}
      />,
    );

    expect(screen.queryByText("Marketplace installs")).not.toBeInTheDocument();
  });
});
