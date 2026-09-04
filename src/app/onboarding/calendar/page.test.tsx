import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import CalendarOnboardingPage from "./page";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }
function status(code: number, value: unknown) {
  return new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } });
}

/**
 * The page reads the callback outcome off the address it was returned to. Tests set it the same
 * way the browser would, and the reset is not optional: jsdom keeps one location per file, so a
 * leftover outcome would silently colour the next test's copy.
 */
function returnedWith(outcome: string) {
  window.history.replaceState({}, "", `/onboarding/calendar?calendar=${outcome}`);
}

const CONNECTED: Record<string, unknown> = {
  provider: "google",
  calendarName: "Client consults",
  externalCalendarId: "consults@group.calendar.google.com",
  externalAccountReference: "coach@livelegacystrong.com",
  authorizationRecordedAt: "2026-09-02T15:04:00.000Z",
  state: "ready",
};

/** The provider read-back panel, which is the top of the screen rather than the fallback form. */
function providerPanel() {
  return document.querySelector("[data-slot='rehaul-calendar-provider']") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/onboarding/calendar");
});

describe("CalendarOnboardingPage", () => {
  /**
   * Until 2026-09-05 this route drew a "Record it by hand" panel asking the coach for a provider
   * account reference, a provider calendar reference and an authorization receipt reference.
   * Those are SetterFi's own identifiers for a calendar SetterFi connected by hand; a coach never
   * holds them. `POST /api/onboarding/calendar` still records one, and the person who does that is
   * us, so the screen carries no field for any of them.
   */
  it("asks the coach for no provider identifier anywhere on the screen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: false, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("No calendar connected yet");

    expect(screen.queryByText("Record it by hand")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/reference|receipt|access token/i);
  });

  /**
   * `CLAUDE.md`: "No GoHighLevel branding anywhere client-visible. GHL is backend plumbing only."
   *
   * This page shipped "GoHighLevel Calendar" as a select option until 2026-08-31, on the most
   * client-facing route in the product. The stored value is still `ghl`, because that is what the
   * API and the `calendar_connections` row expect, so the test asserts both halves: the words a
   * coach reads carry no provider brand, and the value the form submits is unchanged.
   */
  it("names the workspace calendar without any provider branding", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: { provider: "ghl", calendarName: "Consults", externalCalendarId: "calendar-1", externalAccountReference: "account-1", authorizationRecordedAt: "2026-09-07T00:00:00Z", state: "ready" },
      googleConnectAvailable: false, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("SetterFi workspace calendar, Consults");

    expect(document.body.textContent ?? "").not.toMatch(/gohighlevel|high\s*level|\bGHL\b/i);
    // The identifiers behind the row stay behind it.
    expect(document.body.textContent ?? "").not.toContain("calendar-1");
    expect(document.body.textContent ?? "").not.toContain("account-1");
    expect(screen.getByText("Availability verified, so your agent can book")).toBeVisible();
    // Verified and not connectable by press: nothing to do here, so no ask either.
    expect(document.querySelector("[data-slot='rehaul-calendar-ask']")).toBeNull();
  });

  /**
   * The flag is a server value and the page never reads the environment, so "off" arrives as a
   * payload field. Absence is the whole point: a Connect button that 404s is worse than no button.
   * What replaces it is a sentence naming who connects the calendar instead, not a form.
   */
  it("offers no Connect button while Google connect is unavailable, and says a person connects it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: false, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("No calendar connected yet");

    expect(screen.queryByRole("link", { name: /Connect Google Calendar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByText("No account recorded")).not.toBeInTheDocument();
    expect(document.querySelector("[data-slot='rehaul-calendar-ask']"))
      .toHaveTextContent(/a person will connect it with you/);
  });

  /**
   * A transient refresh failure is not an expiry, and the difference decides what the coach does
   * next. Telling somebody to reconnect a live authorization sends them through Google's consent
   * screen to fix something that was never broken, and the grant they already hold stays unused.
   */
  it("offers a retry rather than a reconnect when availability could not be checked right now", async () => {
    returnedWith("choose");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        connection: null,
        googleConnectAvailable: true,
        googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: null, reauthorizationRequired: false },
        pendingCalendars: [{ id: "consults@group.calendar.google.com", name: "Client consults", timeZone: "America/New_York" }],
      }))
      .mockResolvedValueOnce(status(503, {
        error: "Calendar verification is unavailable.",
        code: "CALENDAR_VERIFICATION_UNAVAILABLE",
      }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<CalendarOnboardingPage />);

    await user.click(await screen.findByRole("radio", { name: /Client consults/ }));
    await user.click(screen.getByRole("button", { name: "Use this calendar" }));

    expect(await screen.findByText(/could not check that calendar's availability right now/)).toBeVisible();
    expect(document.body.textContent ?? "").not.toMatch(/reconnect/i);
    // The picker survives, because pressing the same button again is the whole recovery.
    expect(screen.getByRole("radio", { name: /Client consults/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this calendar" })).toBeEnabled();
    expect(screen.queryByText("Availability verified, so your agent can book")).not.toBeInTheDocument();
  });

  it("offers exactly one Connect button when connect is available and no grant exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: true, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    const connect = await screen.findByRole("link", { name: "Connect Google Calendar" });
    expect(connect).toHaveAttribute("href", "/api/calendars/google/connect");
    expect(screen.getAllByRole("link", { name: /Connect Google Calendar/ })).toHaveLength(1);
    expect(document.querySelector("[data-slot='rehaul-calendar-ask']")).toBeNull();
    // Every write path on the screen carries the same accountability line.
    expect(screen.getAllByLabelText("Calendar connection recorded in the audit log").length)
      .toBeGreaterThan(0);
  });

  /**
   * A Google calendar id is the account's email address on the primary entry and an opaque group
   * address on every other one. Neither is a thing a coach recognises, and printing one on an
   * onboarding screen is a leak dressed up as detail, so the picker carries names and the id only
   * rides in the value that gets posted back.
   */
  it("offers the returned calendars by name and renders no identifier for any of them", async () => {
    returnedWith("choose");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null,
      googleConnectAvailable: true,
      googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: null, reauthorizationRequired: false },
      pendingCalendars: [
        { id: "coach@livelegacystrong.com", name: "Coach calendar", timeZone: "America/New_York" },
        { id: "consults@group.calendar.google.com", name: "Client consults", timeZone: "America/New_York" },
      ],
    })));
    render(<CalendarOnboardingPage />);

    const picker = await screen.findByRole("radiogroup", { name: /which calendar/i });
    expect(within(picker).getByRole("radio", { name: /Coach calendar/ })).toBeInTheDocument();
    expect(within(picker).getByRole("radio", { name: /Client consults/ })).toBeInTheDocument();
    expect(within(picker).getAllByRole("radio")).toHaveLength(2);

    // Scoped to the picker: the account the grant was made through is named on the panel above,
    // which is the coach's own address and not a calendar identifier.
    const visible = picker.textContent ?? "";
    expect(visible).not.toContain("coach@livelegacystrong.com");
    expect(visible).not.toContain("consults@group.calendar.google.com");
  });

  it("posts only the chosen calendar id and reads the verified answer back onto the state card", async () => {
    returnedWith("choose");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        connection: null,
        googleConnectAvailable: true,
        googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: null, reauthorizationRequired: false },
        pendingCalendars: [
          { id: "coach@livelegacystrong.com", name: "Coach calendar", timeZone: "America/New_York" },
          { id: "consults@group.calendar.google.com", name: "Client consults", timeZone: "America/New_York" },
        ],
      }))
      .mockResolvedValueOnce(json({
        connection: CONNECTED,
        verified: true,
        outcome: "AVAILABILITY_VERIFIED",
        receipt: { receiptId: "receipt-1", auditId: 91, outcome: "verified", code: "AVAILABILITY_VERIFIED" },
      }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<CalendarOnboardingPage />);

    await user.click(await screen.findByRole("radio", { name: /Client consults/ }));
    await user.click(screen.getByRole("button", { name: "Use this calendar" }));

    await screen.findByText("Availability verified, so your agent can book");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/calendars/google/select");
    const body = JSON.parse(String((fetcher.mock.calls[1]?.[1] as RequestInit).body));
    expect(body).toEqual({ externalCalendarId: "consults@group.calendar.google.com" });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("keeps the amber card when the select call could not read availability", async () => {
    returnedWith("choose");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        connection: null,
        googleConnectAvailable: true,
        googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: null, reauthorizationRequired: false },
        pendingCalendars: [{ id: "consults@group.calendar.google.com", name: "Client consults", timeZone: "America/New_York" }],
      }))
      .mockResolvedValueOnce(json({
        connection: { ...CONNECTED, state: "connecting" },
        verified: false,
        outcome: "AVAILABILITY_NOT_VERIFIED",
        receipt: null,
      }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<CalendarOnboardingPage />);

    await user.click(await screen.findByRole("radio", { name: /Client consults/ }));
    await user.click(screen.getByRole("button", { name: "Use this calendar" }));

    await screen.findByText(/SetterFi could not read availability from Client consults yet/);
    expect(screen.getByText("Availability not verified, so your agent cannot book yet")).toBeVisible();
    expect(screen.queryByText("Availability verified, so your agent can book")).not.toBeInTheDocument();
  });

  /**
   * Under Google's Testing publishing status a grant dies seven days after consent, so `expired`
   * is the ordinary condition of this product rather than a fault. The copy has to say what
   * happened and keep the way back visible without telling a real coach they broke something.
   */
  it("treats an expired authorization as routine and keeps the reconnect action in view", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: { ...CONNECTED, state: "expired" },
      googleConnectAvailable: true,
      googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: "2026-09-09T15:04:00.000Z", reauthorizationRequired: true },
      pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    const reconnect = await screen.findByRole("link", { name: "Reconnect Google Calendar" });
    expect(reconnect).toHaveAttribute("href", "/api/calendars/google/connect");
    expect(screen.getByText("Availability not verified, so your agent cannot book yet")).toBeVisible();

    // The reassurance is the context eye's now, so it is read where the screen actually keeps it.
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "About this screen" }));
    const eye = await screen.findByRole("dialog", { name: "About this screen" });
    expect(eye).toHaveTextContent(/Google ends calendar permissions on a schedule/);
    expect(eye).toHaveTextContent(/nothing you did caused that/);
  });

  it("names the account the calendar was connected through once a connection exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: CONNECTED,
      googleConnectAvailable: true,
      googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: "2026-09-09T15:04:00.000Z", reauthorizationRequired: false },
      pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    expect(await screen.findByText("coach@livelegacystrong.com")).toBeVisible();
    const panel = providerPanel();
    expect(panel).toHaveTextContent("Connected as");
    expect(panel).toHaveTextContent("Google Calendar");
  });

  /**
   * A coach pressing Cancel in Google's window did the ordinary thing. Reading that back as an
   * error would be the page inventing a fault out of a decision the coach was entitled to make.
   */
  it("reads a declined consent as a normal outcome rather than a failure", async () => {
    returnedWith("declined");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: true, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    expect(await screen.findByText(/Nothing was changed, and you can connect whenever you are ready/))
      .toBeVisible();
    expect(screen.getByRole("link", { name: "Connect Google Calendar" })).toBeVisible();
  });

  it("says the authorization has run out rather than claiming a connection when select answers 409", async () => {
    returnedWith("choose");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({
        connection: null,
        googleConnectAvailable: true,
        googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: null, reauthorizationRequired: false },
        pendingCalendars: [{ id: "consults@group.calendar.google.com", name: "Client consults", timeZone: "America/New_York" }],
      }))
      .mockResolvedValueOnce(status(409, { error: "Calendar authorization has expired.", code: "GOOGLE_GRANT_EXPIRED" }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<CalendarOnboardingPage />);

    await user.click(await screen.findByRole("radio", { name: /Client consults/ }));
    await user.click(screen.getByRole("button", { name: "Use this calendar" }));

    expect(await screen.findByText(/authorization ran out before this calendar could be saved/)).toBeVisible();
    expect(screen.queryByText("Availability verified")).not.toBeInTheDocument();
  });
});
