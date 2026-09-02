import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CARRIER_TYPICAL_DAYS,
  CoachIntegrations,
} from "@/components/workspace/live/coach-integrations";
import type { CalendarConnectionSnapshot } from "@/components/workspace/live/coach-integrations";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type { CapiDatasetSnapshot } from "@/lib/repositories/capi-datasets";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";

const navigation = vi.hoisted(() => ({ search: "", refresh: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: navigation.refresh }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

function connection(
  overrides: Partial<ChannelConnectionView> = {},
): ChannelConnectionView {
  return {
    id: "connection-instagram",
    channel: "instagram",
    channelLabel: "Instagram",
    state: "live",
    externalAccountLabel: "@reidfunding",
    capabilities: { postWindow: "none", templates: false, windowed: true },
    receipts: {
      oauthCompletedAt: "2026-08-20T10:00:00.000Z",
      assetVerifiedAt: "2026-08-20T10:05:00.000Z",
      webhookSubscribedAt: "2026-08-20T10:10:00.000Z",
      signedRoundTripAt: null,
    },
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T10:10:00.000Z",
    ...overrides,
  };
}

function template(overrides: Partial<MessageTemplateView> = {}): MessageTemplateView {
  return {
    id: "template-instagram",
    channel: "instagram",
    providerTemplateName: "welcome_back",
    category: null,
    locale: null,
    body: null,
    bodyHash: null,
    variables: [],
    status: "draft",
    submittedAt: null,
    approvedAt: null,
    rejectedAt: null,
    pausedAt: null,
    disabledAt: null,
    statusUpdatedAt: null,
    rejectionDetail: null,
    isDemo: true,
    dataLabel: "Demo",
    ...overrides,
  };
}

function capiDataset(overrides: Partial<CapiDatasetSnapshot> = {}): CapiDatasetSnapshot {
  return {
    id: "capi-dataset-instagram",
    tenantId: "tenant-1",
    channel: "instagram",
    channelConnectionId: "connection-instagram",
    sourceAssetId: "ig-business-1",
    datasetId: "dataset-1",
    status: "connected",
    providerReceipt: {
      provider: "meta",
      mode: "real",
      operation: "get_or_create",
      receiptId: "trace-1",
      accepted: true,
    },
    isMock: false,
    lastError: null,
    provisionedAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

function calendarRead(
  overrides: Partial<CalendarConnectionSnapshot> = {},
): { checked: true; connection: CalendarConnectionSnapshot } {
  return {
    checked: true,
    connection: {
      id: "calendar-primary",
      name: "Client consults",
      provider: "google",
      state: "ready",
      timezone: "America/New_York",
      lastSlotFetchAt: "2026-08-24T11:00:00.000Z",
      lastSlotFetchOk: true,
      lastError: { checked: true, message: null },
      createdAt: "2026-08-20T09:00:00.000Z",
      updatedAt: "2026-08-24T11:00:00.000Z",
      ...overrides,
    },
  };
}

function renderCalendar(overrides: Partial<CalendarConnectionSnapshot> = {}) {
  const rendered = render(
    <CoachIntegrations
      calendar={calendarRead(overrides)}
      connections={[connection()]}
      nowIso="2026-08-24T16:00:00.000Z"
      templates={[]}
    />,
  );
  fireEvent.click(document.querySelector('[data-row-id="calendar:primary"]') as HTMLElement);
  return { ...rendered, sheet: screen.getByRole("complementary", { name: "Calendar connection" }) };
}

function renderConnections(connections: ChannelConnectionView[] | null) {
  return render(
    <CoachIntegrations
      activityByChannel={{
        instagram: { checked: true, at: null },
      }}
      connections={connections}
      nowIso="2026-08-24T12:00:00.000Z"
      templates={[]}
    />,
  );
}

describe("CoachIntegrations", () => {
  afterEach(() => {
    cleanup();
    navigation.search = "";
    navigation.refresh.mockReset();
    vi.unstubAllGlobals();
  });

  it("opens the connection selected by a registered notification destination", () => {
    navigation.search = "connectionId=connection-instagram";
    renderConnections([connection()]);

    expect(document.querySelector('[data-row-id="channel:instagram"]'))
      .toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("complementary", { name: "Instagram connection" })).toBeVisible();
  });

  it("runs an exact provider access check and only confirms a verified durable receipt", async () => {
    let resolveRequest!: (response: Response) => void;
    const request = new Promise<Response>((resolve) => { resolveRequest = resolve; });
    const fetchMock = vi.fn(() => request);
    vi.stubGlobal("fetch", fetchMock);
    renderConnections([connection()]);
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Check provider access" }));
    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });
    expect(await within(sheet).findByText("Provider check pending")).toBeInTheDocument();
    expect(within(sheet).getByText(/No message is being sent/)).toBeInTheDocument();

    resolveRequest(new Response(JSON.stringify({
      receipt: {
        receiptId: "receipt-provider-test",
        auditId: 81,
        replayed: false,
        outcome: "verified",
        code: "PROVIDER_READ_VERIFIED",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    expect(await within(sheet).findByText("Provider access confirmed")).toBeInTheDocument();
    expect(within(sheet).getByText(/did not send a message or create a signed round-trip receipt/))
      .toBeInTheDocument();
    expect(within(sheet).getByText(/Command receipt receipt-provider-test · Audit #81/))
      .toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/channel-actions/connection-instagram/test");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      idempotencyKey: expect.stringContaining("coach-connection:test:connection-instagram:"),
    });
  });

  it("shows a recorded provider refusal without presenting it as success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      receipt: {
        receiptId: "receipt-provider-failed",
        auditId: 82,
        replayed: false,
        outcome: "not_verified",
        code: "PROVIDER_PROBE_FAILED",
      },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    renderConnections([connection()]);
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Check provider access" }));

    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });
    expect(await within(sheet).findByText("Provider check failed")).toBeInTheDocument();
    expect(within(sheet).getByText(/does not claim provider success/)).toBeInTheDocument();
    expect(within(sheet).getByText(/PROVIDER_PROBE_FAILED/)).toBeInTheDocument();
    expect(within(sheet).queryByText("Provider access confirmed")).not.toBeInTheDocument();
  });

  it("requires confirmation before disconnect and reads back the provider revoke receipt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      receipt: {
        receiptId: "receipt-provider-disconnect",
        auditId: 83,
        replayed: false,
        outcome: "verified",
        code: "PROVIDER_REVOKED",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    renderConnections([connection()]);
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alertdialog")).toHaveTextContent(
      "The local connection changes to disconnected only after the provider confirms that revoke.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Disconnect provider" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/channel-actions/connection-instagram/disconnect");
    expect(await screen.findByText("Disconnect confirmed")).toBeInTheDocument();
    expect(screen.getByText(/provider confirmed revocation and SetterFi recorded this connection as disconnected/i))
      .toBeInTheDocument();
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses provider commands in impersonation and keeps reconnect on the working Setup path", () => {
    render(
      <CoachIntegrations
        connections={[connection({ state: "error" })]}
        impersonating
        templates={[]}
      />,
    );
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });

    expect(within(sheet).getByText(/Provider commands are unavailable in a read-only impersonated view/))
      .toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Check provider access" })).not.toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "Reconnect" }))
      .toHaveAttribute("href", "/coach/get-started");
  });

  it("does not offer provider disconnect when the read model cannot positively identify a revocable provider", () => {
    renderConnections([connection({
      capabilities: { postWindow: "none", templates: false, windowed: false },
    })]);
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });

    expect(within(sheet).getByRole("button", { name: "Check provider access" })).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  it("does not render Live on a connection row without a signed round-trip receipt", () => {
    renderConnections([connection()]);

    const row = document.querySelector('[data-row-id="channel:instagram"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).queryByText("Live", { exact: true })).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("Ready to test")).toBeInTheDocument();
  });

  /**
   * Rule: honest states, on the one branch where the stored state and the stored evidence
   * disagree outright. A connection row saved as `live` whose receipts never completed is the
   * worst case this page has -- the database says the channel is running and nothing proves it --
   * and until 2026-08-31 no test covered it, so relabelling that branch "Live" was a one-word
   * edit that stayed green.
   */
  it("refuses to read Live when the stored state says live and the receipts do not", () => {
    renderConnections([
      connection({
        receipts: {
          oauthCompletedAt: "2026-08-20T10:00:00.000Z",
          assetVerifiedAt: null,
          webhookSubscribedAt: null,
          signedRoundTripAt: null,
        },
      }),
    ]);

    const row = document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement;
    expect(within(row).getByText("Setup incomplete")).toBeInTheDocument();
    expect(within(row).queryByText("Live", { exact: true })).not.toBeInTheDocument();
    expect(within(row).getByText(/marked live, but no signed round-trip receipt proves it/))
      .toBeInTheDocument();
  });

  it("counts only channels in the Live channels denominator, never the calendar row", () => {
    renderConnections([connection()]);

    const strip = screen.getByText("Live channels").closest("[data-strip-item]")
      ?? screen.getByText("Live channels").parentElement;
    expect(strip).not.toBeNull();

    // Every row the surface renders, and the subset of them that are actually channels.
    const rendered = document.querySelectorAll("[data-row-id]").length;
    const channels = document.querySelectorAll('[data-row-id^="channel:"]').length;
    expect(channels).toBeGreaterThan(0);
    expect(rendered).toBeGreaterThan(channels); // the calendar row is the difference

    // The denominator must be the channel count, not the row count. If this ever reads
    // "of <rendered>", a fully connected workspace can never show every channel live.
    expect(within(strip as HTMLElement).getByText(`of ${channels}`)).toBeInTheDocument();
    expect(
      within(strip as HTMLElement).queryByText(`of ${rendered}`),
    ).not.toBeInTheDocument();
  });

  it("renders Live when the fixture carries a signed round-trip receipt", () => {
    renderConnections([
      connection({
        receipts: {
          ...connection().receipts,
          signedRoundTripAt: "2026-08-20T10:15:00.000Z",
        },
      }),
    ]);

    const row = document.querySelector('[data-row-id="channel:instagram"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Live", { exact: true })).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText(/Signed round trip received .* Receipt stored\./)).toBeInTheDocument();
  });

  it("lets a terminal SMS registration override conflicting signed live evidence", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{
          checked: true,
          registration: {
            submittedAt: "2026-08-14T16:00:00.000Z",
            registrationState: "blocked",
            terminalRejection: true,
            terminalCode: "carrier-terminal",
          },
        }}
        connections={[
          connection({
            id: "connection-sms",
            channel: "sms",
            channelLabel: "Text messages (SMS)",
            receipts: {
              ...connection().receipts,
              signedRoundTripAt: "2026-08-20T10:15:00.000Z",
            },
          }),
        ]}
        templates={[]}
      />,
    );

    const row = document.querySelector('[data-row-id="channel:sms"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Blocked", { exact: true })).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("Live", { exact: true })).not.toBeInTheDocument();
    expect(within(row as HTMLElement).queryByRole("link", { name: "Test" })).not.toBeInTheDocument();
  });

  /*
   * Hard rule: no GoHighLevel branding anywhere client-visible. The calendar row names the service
   * a coach's calls get booked on, and the stored value for that service is `ghl`, so the row is
   * one label map away from printing the plumbing on the most client-facing page in the workspace.
   * The name it prints instead is the one `src/app/onboarding/calendar/page.tsx` already chose,
   * because a coach who picked it there has to recognise it here.
   */
  it("names the workspace calendar without leaking the provider it is stored as", () => {
    render(
      <CoachIntegrations
        calendar={{
          checked: true,
          connection: {
            id: "calendar-primary",
            name: null,
            provider: "ghl",
            state: "ready",
            timezone: "America/New_York",
            lastSlotFetchAt: "2026-08-24T11:00:00.000Z",
            lastSlotFetchOk: true,
            lastError: { checked: true, message: null },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        }}
        connections={[connection()]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );
    const row = document.querySelector('[data-row-id="calendar:primary"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(/SetterFi workspace calendar/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/gohighlevel|highlevel/i);
  });

  /*
   * The calendar is the row that decides whether a booking can happen at all, and priority sorting
   * alone could drop it anywhere among four channels. The bands separate what the agent talks
   * through from what it books into, and membership is by what a row is for rather than by how
   * healthy it is, so a band cannot empty itself by having good news. The priority order still
   * holds inside a band: a channel the coach has to act on leads it.
   */
  it("splits the rows into what talks and what books, keeping priority inside each band", () => {
    render(
      <CoachIntegrations
        calendar={{
          checked: true,
          connection: {
            id: "calendar-primary",
            name: "Primary calendar",
            provider: "google",
            state: "ready",
            timezone: "America/New_York",
            lastSlotFetchAt: "2026-08-24T11:00:00.000Z",
            lastSlotFetchOk: true,
            lastError: { checked: true, message: null },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        }}
        connections={[connection()]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );
    const talks = screen.getByRole("region", { name: "Where it talks" });
    const books = screen.getByRole("region", { name: "Where it books" });
    expect(talks.querySelector('[data-row-id="calendar:primary"]')).toBeNull();
    expect(books.querySelector('[data-row-id="calendar:primary"]')).not.toBeNull();
    expect(books.querySelectorAll('[data-row-id^="channel:"]')).toHaveLength(0);
    expect(talks.querySelectorAll('[data-row-id^="channel:"]').length).toBeGreaterThan(0);
  });

  it("does not route receipt-dependent Test actions to the sandbox", () => {
    render(
      <CoachIntegrations
        calendar={{
          checked: true,
          connection: {
            id: "calendar-primary",
            name: "Primary calendar",
            provider: "ghl",
            state: "ready",
            timezone: "America/New_York",
            lastSlotFetchAt: null,
            lastSlotFetchOk: null,
            lastError: { checked: true, message: null },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        }}
        connections={[connection()]}
        templates={[]}
      />,
    );

    expect(screen.queryByRole("link", { name: "Test" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/meet-agent"]')).not.toBeInTheDocument();
  });

  it("renders No activity yet when a connection has no inbound or outbound event", () => {
    renderConnections([connection()]);

    const row = document.querySelector('[data-row-id="channel:instagram"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("No activity yet")).toBeInTheDocument();
  });

  it("shows the real carrier day count from a filed registration without a channel row", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{
          checked: true,
          registration: {
            submittedAt: "2026-08-14T16:00:00.000Z",
            registrationState: "awaiting_provider",
            terminalRejection: false,
            terminalCode: null,
          },
        }}
        connections={[]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );

    const row = document.querySelector('[data-row-id="channel:sms"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("Day 10")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/%/)).not.toBeInTheDocument();
  });

  it("keeps a failed registration read distinct from an unfiled registration", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{ checked: false, registration: null }}
        connections={[]}
        templates={[]}
      />,
    );

    const row = document.querySelector('[data-row-id="channel:sms"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("We could not check this")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("Waiting to file")).not.toBeInTheDocument();
  });

  it("sorts and counts coach-owned connection work ahead of carrier-owned work", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{
          checked: true,
          registration: {
            submittedAt: "2026-08-14T16:00:00.000Z",
            registrationState: "awaiting_provider",
            terminalRejection: false,
            terminalCode: null,
          },
        }}
        calendar={{
          checked: true,
          connection: {
            id: "calendar-primary",
            name: "Primary calendar",
            provider: "ghl",
            state: "ready",
            timezone: "America/New_York",
            lastSlotFetchAt: "2026-08-24T11:00:00.000Z",
            lastSlotFetchOk: true,
            lastError: { checked: true, message: null },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        }}
        connections={[connection()]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );

    const messenger = document.querySelector('[data-row-id="channel:messenger"]');
    const sms = document.querySelector('[data-row-id="channel:sms"]');
    expect(messenger).not.toBeNull();
    expect(sms).not.toBeNull();
    expect(messenger?.compareDocumentPosition(sms as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const waitingOnYou = screen.getByText("Waiting on you").parentElement;
    expect(waitingOnYou).not.toBeNull();
    expect(within(waitingOnYou as HTMLElement).getByText("2")).toBeInTheDocument();
  });

  it.each([
    ["connecting", "Connecting"],
    ["flagged", "Flagged for review"],
  ] as const)("does not offer Test while a %s connection cannot be advanced", (state, label) => {
    renderConnections([connection({ state })]);

    const row = document.querySelector('[data-row-id="channel:instagram"]');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText(label)).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText("Test", { exact: true })).not.toBeInTheDocument();
  });

  it("renders a coach-safe stored error and keeps a failed error read distinct", () => {
    const first = render(
      <CoachIntegrations
        connections={[connection()]}
        storedErrorsByConnection={{
          "connection-instagram": {
            checked: true,
            message: "The account permission expired. Reconnect the account before testing again.",
          },
        }}
        templates={[]}
      />,
    );
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    expect(screen.getByText("The account permission expired. Reconnect the account before testing again.")).toBeInTheDocument();
    first.unmount();

    render(
      <CoachIntegrations
        connections={[connection()]}
        storedErrorsByConnection={null}
        templates={[]}
      />,
    );
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    expect(screen.getByText("We could not check the latest stored error.")).toBeInTheDocument();
    expect(screen.queryByText("No error has been recorded for this connection.")).not.toBeInTheDocument();
  });

  it("orders connection history newest first", () => {
    renderConnections([
      connection({
        receipts: {
          oauthCompletedAt: "2026-08-20T10:00:00.000Z",
          assetVerifiedAt: "2026-08-20T10:05:00.000Z",
          webhookSubscribedAt: "2026-08-20T10:10:00.000Z",
          signedRoundTripAt: "2026-08-20T10:15:00.000Z",
        },
      }),
    ]);
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);

    const history = screen.getByText("Connection history").parentElement;
    expect(history).not.toBeNull();
    const items = within(history as HTMLElement).getAllByRole("listitem");
    expect(items[0]).toHaveTextContent("Signed round trip received");
    expect(items.at(-1)).toHaveTextContent("Account permission confirmed");
  });

  it("renders channels as a row list with a receipt line and a selectable row", () => {
    renderConnections([
      connection({
        receipts: {
          ...connection().receipts,
          signedRoundTripAt: "2026-08-20T10:15:00.000Z",
        },
      }),
    ]);

    const row = document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement;
    expect(row).not.toBeNull();
    // A row list, not a sortable table: no column header controls survive the rebuild.
    expect(screen.queryByRole("columnheader")).not.toBeInTheDocument();
    expect(row).toHaveAttribute("role", "button");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(within(row).getByText(/Signed round trip received .* Receipt stored\./)).toBeInTheDocument();

    fireEvent.click(row);

    expect(document.querySelector('[data-row-id="channel:instagram"]'))
      .toHaveAttribute("aria-expanded", "true");
  });

  it("gives every connection card an explicit width inside its flex list item", () => {
    // The card is an inline-size container, so its intrinsic width is zero; as a flex item with no
    // width it rendered 36px wide and wrapped one word per line. jsdom cannot measure layout, so
    // this pins the one class that carries the width.
    renderConnections([connection()]);

    const item = document.querySelector('[role="listitem"]') as HTMLElement;
    expect(item).not.toBeNull();
    const card = item.firstElementChild as HTMLElement;
    expect(card.className.split(/\s+/)).toContain("w-full");
  });

  it("keeps a CSV and JSON export for the connection rows", () => {
    renderConnections([connection()]);

    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
  });

  it("hides conversion claims with the flag off and keeps absent or mock receipts not set up", () => {
    const hidden = renderConnections([connection()]);
    expect(screen.queryByText(/Conversion tracking:/)).not.toBeInTheDocument();
    hidden.unmount();

    const absent = render(
      <CoachIntegrations
        connections={[connection()]}
        conversionTracking={{ enabled: true, checked: true, datasets: [] }}
        templates={[]}
      />,
    );
    const absentRow = document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement;
    expect(within(absentRow).getByText("Conversion tracking: not set up")).toBeInTheDocument();
    expect(within(absentRow).queryByText("Conversion tracking: connected")).not.toBeInTheDocument();
    absent.unmount();

    render(
      <CoachIntegrations
        connections={[connection()]}
        conversionTracking={{
          enabled: true,
          checked: true,
          datasets: [capiDataset({
            isMock: true,
            datasetId: "mock-dataset",
            providerReceipt: {
              provider: "meta", mode: "mock", operation: "get_or_create",
              receiptId: "mock-receipt", accepted: true,
            },
          })],
        }}
        templates={[]}
      />,
    );
    const mockRow = document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement;
    expect(within(mockRow).getByText("Conversion tracking: not set up")).toBeInTheDocument();
    expect(within(mockRow).queryByText("Conversion tracking: connected")).not.toBeInTheDocument();
  });

  it("shows connected only from a stored non-mock receipt and gives Instagram measurement-only copy", () => {
    render(
      <CoachIntegrations
        connections={[connection()]}
        conversionTracking={{ enabled: true, checked: true, datasets: [capiDataset()] }}
        templates={[]}
      />,
    );

    const row = document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement;
    expect(within(row).getByText("Conversion tracking: connected")).toBeInTheDocument();
    expect(within(row).getByText(/QualifiedLead and Purchase are measured for Instagram/))
      .toBeInTheDocument();
    expect(within(row).getByText(/Instagram is measurement only, not ad optimization/))
      .toBeInTheDocument();
    expect(within(row).getByText(/Custom conversion labels are set by the account owner in Ads Manager/))
      .toBeInTheDocument();
  });

  it("sets up from the opened channel and confirms only a real audited receipt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      dataset: {
        channel: "instagram",
        status: "connected",
        isMock: false,
        provisionedAt: "2026-09-01T10:00:00.000Z",
      },
      audit: {
        auditId: "91",
        actionKey: "capi.dataset.provisioned",
        label: "Conversion tracking setup logged",
        ariaLabel: "Conversion tracking dataset setup recorded in the audit log",
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <CoachIntegrations
        connections={[connection()]}
        conversionTracking={{ enabled: true, checked: true, datasets: [] }}
        templates={[]}
      />,
    );
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });
    const setup = within(sheet).getByRole("button", { name: "Set up conversion tracking" });
    expect(within(sheet).getByText("Conversion tracking setup logged")).toBeInTheDocument();
    fireEvent.click(setup);

    expect(await within(sheet).findByText("Conversion tracking connected")).toBeInTheDocument();
    expect(within(sheet).getByText(/A real dataset receipt is stored/)).toBeInTheDocument();
    expect(within(sheet).getByText("Audit #91")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/api/channels/capi/datasets", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ channel: "instagram" }),
    }));
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("does not confirm a successful mock setup response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      dataset: { channel: "instagram", status: "connected", isMock: true },
      audit: { auditId: "92", actionKey: "capi.dataset.provisioned" },
    }), { status: 200, headers: { "content-type": "application/json" } })));
    render(
      <CoachIntegrations
        connections={[connection()]}
        conversionTracking={{ enabled: true, checked: true, datasets: [] }}
        templates={[]}
      />,
    );
    fireEvent.click(document.querySelector('[data-row-id="channel:instagram"]') as HTMLElement);
    const sheet = screen.getByRole("complementary", { name: "Instagram connection" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Set up conversion tracking" }));

    expect(await within(sheet).findByText("Conversion tracking not set up")).toBeInTheDocument();
    expect(within(sheet).queryByText("Conversion tracking connected")).not.toBeInTheDocument();
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  it("names the read time and offers a refresh without inventing a check", () => {
    renderConnections([connection()]);

    expect(screen.getByText(/^Checked /)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
    // No health-check mechanism exists for a channel connection, so no row offers one.
    expect(screen.queryByRole("button", { name: "Test connection" })).not.toBeInTheDocument();
  });

  it("derives the provider-wait strip note from the real filing, never a predicted date", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{
          checked: true,
          registration: {
            submittedAt: "2026-08-14T16:00:00.000Z",
            registrationState: "awaiting_provider",
            terminalRejection: false,
            terminalCode: null,
          },
        }}
        connections={[]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );

    const waiting = screen.getByText("Waiting on a provider").parentElement as HTMLElement;
    expect(within(waiting).getByText(/carrier review day 10$/)).toBeInTheDocument();
    expect(waiting).not.toHaveTextContent("%");
  });

  /**
   * Rule: honest states. "Live" is a signed round trip and nothing more. A newly connected account
   * can send before it should, no stored column expresses where it is in that warm-up, and letting
   * a Live pill imply unrestricted volume is exactly the completion theatre the hard rules ban.
   */
  it("says a Live channel is still warming up rather than letting the pill imply full volume", () => {
    renderConnections([
      connection({
        receipts: {
          ...connection().receipts,
          signedRoundTripAt: "2026-08-20T10:15:00.000Z",
        },
      }),
    ]);

    const strip = screen.getByText("Managed by SetterFi").closest("section") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip).toHaveTextContent(/still warms up before it sends at full volume/i);
    expect(strip).toHaveTextContent(/does not record how far along that is/i);
    // No ramp, no percentage, no predicted day-one volume: none of it is recorded.
    expect(strip.textContent ?? "").not.toMatch(/%/);
  });

  /**
   * Rule: test data is segregated from real analytics and says so on screen. This was a source
   * assertion in `coach-integrations.test.ts` naming the exact `StateBadge` JSX, which went red on
   * a rename and stayed green on a deletion of the surrounding condition. Both arms matter: a
   * marker that never appears fails the rule, and a marker that always appears labels a real
   * coach's live workspace as demo data.
   */
  it("labels demo template data on screen and leaves real data unlabelled", () => {
    const demo = render(
      <CoachIntegrations
        connections={[connection()]}
        nowIso="2026-08-24T12:00:00.000Z"
        templates={[template()]}
      />,
    );
    expect(screen.getByText("Demo workspace data")).toBeInTheDocument();
    expect(document.querySelector('[data-provenance="demo"]')).not.toBeNull();
    demo.unmount();

    render(
      <CoachIntegrations
        connections={[connection()]}
        nowIso="2026-08-24T12:00:00.000Z"
        templates={[template({ dataLabel: null, isDemo: false })]}
      />,
    );
    expect(screen.queryByText("Demo workspace data")).not.toBeInTheDocument();
    expect(document.querySelector('[data-provenance="demo"]')).toBeNull();
  });

  /**
   * Rule: honest states. The page makes two claims about the same external clock -- the managed
   * strip says the carrier wait in weeks as prose, the card's counter says it in days from
   * CARRIER_TYPICAL_DAYS -- and nothing but a reader's arithmetic connected them, so editing the
   * constant would have left the sentence quoting the old wait.
   */
  it("states the carrier wait in weeks that match the day range the counter uses", () => {
    renderConnections([connection()]);

    const strip = screen.getByText("Managed by SetterFi").closest("section") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip).toHaveTextContent(
      `${CARRIER_TYPICAL_DAYS[0] / 7} to ${CARRIER_TYPICAL_DAYS[1] / 7} weeks`,
    );
  });

  /**
   * Rule: honest states, and the failure here was two surfaces disagreeing about the same row in
   * the same second. The card ran a four-way ownership branch and the sheet ran a two-way one, so
   * a carrier-owned SMS row read "The carrier owns the next step." until it was opened, at which
   * point it read "Nothing for you to do." Both sentences now come from one function.
   */
  it("says the same thing about who owns a step on the card and in the opened sheet", () => {
    render(
      <CoachIntegrations
        a2pRegistration={{
          checked: true,
          registration: {
            submittedAt: "2026-08-14T16:00:00.000Z",
            registrationState: "awaiting_provider",
            terminalRejection: false,
            terminalCode: null,
          },
        }}
        connections={[]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );

    const row = document.querySelector('[data-row-id="channel:sms"]') as HTMLElement;
    expect(within(row).getByText("The carrier owns the next step.")).toBeInTheDocument();

    fireEvent.click(row);
    const sheet = screen.getByRole("complementary", { name: /Text messages/ });
    expect(within(sheet).getByText("The carrier owns the next step.")).toBeInTheDocument();
    expect(within(sheet).queryByText("Nothing for you to do.")).not.toBeInTheDocument();
  });

  /**
   * Rule: one accent fill per page, on the single live action, and none when nothing is live.
   * Five cards that each carry an action is five chances to light a second one, and the resting
   * state of this page is a coach waiting on a carrier, where lighting anything would be a lie
   * about there being something to press.
   */
  it("spends one accent fill on coach-owned work and none when every step is a provider's", () => {
    const withWork = render(
      <CoachIntegrations
        connections={[connection()]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );
    // Two rows are the coach's own required work here, and only the first of them is lit.
    expect(screen.getAllByRole("link", { name: /Connect|Reconnect/ }).length).toBeGreaterThan(1);
    expect(document.querySelectorAll('[class*="--accent-fill"]')).toHaveLength(1);
    withWork.unmount();

    const signed = (channel: ChannelConnectionView["channel"]) => connection({
      id: `connection-${channel}`,
      channel,
      receipts: { ...connection().receipts, signedRoundTripAt: "2026-08-20T10:15:00.000Z" },
    });
    render(
      <CoachIntegrations
        calendar={{
          checked: true,
          connection: {
            id: "calendar-primary",
            name: "Primary calendar",
            provider: "ghl",
            state: "ready",
            timezone: "America/New_York",
            lastSlotFetchAt: "2026-08-24T11:00:00.000Z",
            lastSlotFetchOk: true,
            lastError: { checked: true, message: null },
            createdAt: "2026-08-20T09:00:00.000Z",
            updatedAt: "2026-08-24T11:00:00.000Z",
          },
        }}
        connections={[signed("instagram"), signed("messenger"), signed("whatsapp"), signed("sms")]}
        nowIso="2026-08-24T16:00:00.000Z"
        templates={[]}
      />,
    );
    expect(screen.queryAllByRole("link", { name: /Connect|Reconnect/ })).toHaveLength(0);
    expect(document.querySelectorAll('[class*="--accent-fill"]')).toHaveLength(0);
  });

  it("keeps a failed read distinct from an empty connection list", () => {
    renderConnections(null);

    expect(screen.getByRole("heading", { name: "We could not check this" })).toBeInTheDocument();
    expect(screen.queryByText("Not connected")).not.toBeInTheDocument();
  });

  it("reads a verified Google calendar as connected and passing", () => {
    const { sheet } = renderCalendar();

    expect(within(sheet).getByText("Availability confirmed")).toBeInTheDocument();
    expect(screen.getAllByText(/Live availability was read from Client consults on Google Calendar/).length)
      .toBeGreaterThan(0);
  });

  /**
   * Under Google's Testing publishing status a grant dies seven days after consent, so this row
   * spends part of its life expired by design. It has to ask for a reconnect rather than report a
   * fault, and it must never read as connected while it is mid-connection.
   */
  it("asks for a reconnect when the Google authorization expired, and claims nothing while connecting", () => {
    const expired = renderCalendar({ state: "expired" });
    expect(within(expired.sheet).getByText("Reconnect needed")).toBeInTheDocument();
    expect(screen.getAllByText(/needs to be linked again before your agent can book/).length)
      .toBeGreaterThan(0);
    expired.unmount();

    // The stored availability read is left passing on purpose. A connection that was ready, went
    // back to connecting and still carries an old successful read is the one case where the state
    // and the evidence disagree, and the state is what decides whether a booking can happen.
    const { sheet } = renderCalendar({ state: "connecting" });
    expect(within(sheet).getByText("Connecting")).toBeInTheDocument();
    expect(within(sheet).queryByText("Availability confirmed")).not.toBeInTheDocument();
  });

  /**
   * The affordance follows the route, not the wish. A Google calendar has a disconnect route that
   * revokes with the provider first; the workspace calendar has none, so a button there would be a
   * claim the backend cannot honour.
   */
  it("offers disconnect on a Google calendar and never on the workspace calendar", () => {
    const google = renderCalendar();
    expect(within(google.sheet).getByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    google.unmount();

    const { sheet } = renderCalendar({ provider: "ghl", name: null });
    expect(within(sheet).queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
  });

  /**
   * `/api/channel-actions/[connectionId]/[command]` selects from `channel_connections` and refuses
   * any provider outside the two messaging ones, so a calendar id resolves to nothing there. A
   * control that posts to it would fail every time it was pressed.
   */
  it("sends a Google calendar disconnect to the calendar route and never to channel actions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      disconnected: true,
      receipt: { receiptId: "receipt-google-revoke", auditId: 84, outcome: "verified", code: "PROVIDER_REVOKED" },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { sheet } = renderCalendar();

    fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect provider" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/calendars/google/disconnect");
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("channel-actions");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(Object.keys(body)).toEqual(["idempotencyKey"]);
    expect(body.idempotencyKey).toEqual(expect.stringContaining("coach-connection:disconnect:calendar-primary:"));

    expect(await screen.findByText("Disconnect confirmed")).toBeInTheDocument();
    expect(screen.getByLabelText("Calendar disconnection recorded in the audit log")).toBeInTheDocument();
    expect(navigation.refresh).toHaveBeenCalledTimes(1);
  });

  it("says the provider did not confirm when the revoke was refused, and keeps the row connected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "Google did not confirm the revocation.",
      code: "PROVIDER_REVOKE_UNCONFIRMED",
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const { sheet } = renderCalendar();

    fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect provider" }));

    expect(await screen.findByText("Disconnect failed")).toBeInTheDocument();
    expect(screen.getByText(/does not claim the connection was disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/PROVIDER_REVOKE_UNCONFIRMED/)).toBeInTheDocument();
    expect(screen.queryByText("Disconnect confirmed")).not.toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Calendar connection" }))
      .getByText("Availability confirmed")).toBeInTheDocument();
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  /**
   * The provider read is a messaging command: its route refuses a calendar id the same way the
   * disconnect one does. Offering it on this row put a button on a coach's screen that could only
   * ever come back failed.
   */
  /**
   * A second refusal code on the same route, for a primary calendar row that is not Google. It is
   * the same claim either way: the provider did not confirm, so the page does not say the
   * connection was disconnected. The failed branch keys on the receipt it did not get, not on a
   * list of codes it has to keep up to date.
   */
  it("keeps a refusal that is not the revoke code on the failed branch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "No Google calendar connection was found.",
      code: "CALENDAR_CONNECTION_NOT_FOUND",
    }), { status: 409, headers: { "content-type": "application/json" } })));
    const { sheet } = renderCalendar();

    fireEvent.click(within(sheet).getByRole("button", { name: "Disconnect" }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect provider" }));

    expect(await screen.findByText("Disconnect failed")).toBeInTheDocument();
    expect(screen.getByText(/does not claim the connection was disconnected/)).toBeInTheDocument();
    expect(screen.getByText(/CALENDAR_CONNECTION_NOT_FOUND/)).toBeInTheDocument();
    expect(screen.queryByText("Disconnect confirmed")).not.toBeInTheDocument();
    expect(navigation.refresh).not.toHaveBeenCalled();
  });

  it("does not offer the messaging provider check on a calendar row", () => {
    const { sheet } = renderCalendar();

    expect(within(sheet).queryByRole("button", { name: "Check provider access" })).not.toBeInTheDocument();
  });
});
