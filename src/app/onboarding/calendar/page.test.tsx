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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/onboarding/calendar");
});

describe("CalendarOnboardingPage", () => {
  it("records authorization evidence but continues to say booking is unavailable while the connection is connecting", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ connection: null }))
      .mockResolvedValueOnce(json({ connection: { provider: "google", calendarName: "Primary", externalCalendarId: "calendar-1", externalAccountReference: "account-1", authorizationRecordedAt: "2026-09-07T00:00:00Z", state: "connecting" }, audit: { id: "22" } }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<CalendarOnboardingPage />);
    await screen.findByText("Authorize a calendar with its provider before recording its receipt here.");
    await user.selectOptions(screen.getByLabelText("Calendar provider"), "google");
    await user.type(screen.getByLabelText("Provider account reference"), "account-1");
    await user.type(screen.getByLabelText("Provider calendar reference"), "calendar-1");
    await user.type(screen.getByRole("textbox", { name: /Provider-issued authorization receipt reference/ }), "receipt-1");
    await user.click(screen.getByRole("button", { name: "Record authorization receipt" }));
    await screen.findByText("Authorization receipt recorded and logged. Calendar availability has not been verified, so booking is not ready.");
    expect(screen.getByText("External calendar availability has not been verified. Your agent cannot book appointments yet.")).toBeVisible();
    expect(fetcher).toHaveBeenLastCalledWith("/api/onboarding/calendar", expect.objectContaining({ method: "POST" }));
  });

  /**
   * `CLAUDE.md`: "No GoHighLevel branding anywhere client-visible. GHL is backend plumbing only."
   *
   * This page shipped "GoHighLevel Calendar" as a select option until 2026-08-31, on the most
   * client-facing route in the product. The stored value is still `ghl`, because that is what the
   * API and the `calendar_connections` row expect, so the test asserts both halves: the words a
   * coach reads carry no provider brand, and the value the form submits is unchanged.
   */
  it("names the workspace calendar without any provider branding, while still submitting ghl", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ connection: null })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("Authorize a calendar with its provider before recording its receipt here.");

    expect(document.body.textContent ?? "").not.toMatch(/gohighlevel|high\s*level|\bGHL\b/i);
    const provider = screen.getByLabelText("Calendar provider") as HTMLSelectElement;
    expect(provider.value).toBe("ghl");
    expect(Array.from(provider.options).map((option) => option.text))
      .toEqual(["SetterFi workspace calendar", "Google Calendar"]);
  });

  /**
   * `CLAUDE.md`, on the redesign the whole console is being built to: "most rows state the value
   * SetterFi already chose rather than offering a control, so the few things a coach actually owns
   * are the only interactive things on the page."
   *
   * Until 2026-09-02 this route opened straight onto six inputs asking a credit coach to type a
   * provider account reference, a provider calendar reference and a provider-issued authorization
   * receipt reference. No calendar OAuth flow exists in the codebase, so the form was the whole
   * integration and no coach could complete onboarding without SetterFi doing it for them.
   *
   * The fields are not deleted -- `record_onboarding_calendar_authorization` has no other caller,
   * so this form is the only writer of `calendar_connections` in the product. The guard therefore
   * asserts DEMOTION, not absence: every provider identifier sits inside a CLOSED disclosure, and
   * what the coach reads first says SetterFi does this for them. Asserting absence would pass just
   * as well against a page that had lost the ability to record a calendar at all.
   */
  it("states that SetterFi connects the calendar, and keeps every provider identifier inside a closed disclosure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ connection: null })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("Authorize a calendar with its provider before recording its receipt here.");

    expect(screen.getByText(/SetterFi records your booking calendar for you/)).toBeVisible();

    const disclosure = screen.getByText("Set up manually").closest("details");
    expect(disclosure).not.toBeNull();
    expect(disclosure!.open).toBe(false);

    for (const label of [
      "Calendar provider",
      "Provider account reference",
      "Provider calendar reference",
      "Calendar timezone",
    ]) {
      expect(disclosure!.contains(screen.getByLabelText(label))).toBe(true);
    }
    expect(disclosure!.contains(
      screen.getByRole("textbox", { name: /Provider-issued authorization receipt reference/ }),
    )).toBe(true);
    expect(disclosure!.contains(
      screen.getByRole("button", { name: "Record authorization receipt" }),
    )).toBe(true);
  });

  /**
   * The flag is a server value and the page never reads the environment, so "off" arrives as a
   * payload field. Absence is the whole point: a Connect button that 404s is worse than no button,
   * and this is what lets the work ship to the single production project unswitched.
   */
  /**
   * The flag-off payload is exact: `googleConnectAvailable: false`, no grant, an empty picker and
   * an untouched `connection`. What the coach sees in that case is not merely "no button" but the
   * page as it shipped, which is what lets this land on the single production project without
   * changing anything for the client. So the guard reads the sentences too, not just the absences.
   */
  it("renders the page exactly as it shipped while the payload says Google connect is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: false, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);
    await screen.findByText("Authorize a calendar with its provider before recording its receipt here.");

    expect(screen.queryByRole("link", { name: /Connect Google Calendar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Calendar connection recorded in the audit log")).not.toBeInTheDocument();
    expect(screen.getByText(/SetterFi connects your booking calendar for you during onboarding/)).toBeVisible();
    expect(screen.getByText(/SetterFi records your booking calendar for you/)).toBeVisible();
    expect(screen.getByText(/your SetterFi contact will finish it with you/)).toBeVisible();
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
    expect(screen.queryByText("Availability verified")).not.toBeInTheDocument();
  });

  it("offers one Connect button above the manual disclosure when connect is available and no grant exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: null, googleConnectAvailable: true, googleGrant: null, pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    const connect = await screen.findByRole("link", { name: "Connect Google Calendar" });
    expect(connect).toHaveAttribute("href", "/api/calendars/google/connect");
    expect(screen.getAllByRole("link", { name: /Connect Google Calendar/ })).toHaveLength(1);

    const disclosure = screen.getByText("Set up manually").closest("details");
    expect(disclosure!.contains(connect)).toBe(false);
    expect(connect.compareDocumentPosition(disclosure!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText("Calendar connection recorded in the audit log")).toBeVisible();
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

    const visible = document.body.textContent ?? "";
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

    await screen.findByText("Availability verified");
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
    expect(screen.getByText("Availability not verified")).toBeVisible();
    expect(screen.queryByText("Availability verified")).not.toBeInTheDocument();
    expect(screen.getByText("External calendar availability has not been verified. Your agent cannot book appointments yet."))
      .toBeVisible();
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
    expect(screen.getByText(/Google ends calendar permissions on a schedule/)).toBeVisible();
    expect(screen.getByText(/Nothing you did caused it/)).toBeVisible();
    expect(screen.getByText("Availability not verified")).toBeVisible();
  });

  it("names the account the calendar was connected through once a connection exists", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      connection: CONNECTED,
      googleConnectAvailable: true,
      googleGrant: { connectedAs: "coach@livelegacystrong.com", refreshTokenExpiresAt: "2026-09-09T15:04:00.000Z", reauthorizationRequired: false },
      pendingCalendars: [],
    })));
    render(<CalendarOnboardingPage />);

    expect(await screen.findByText("Connected as coach@livelegacystrong.com")).toBeVisible();
    expect(screen.getByText(/Connected on Sep 2, 2026/)).toBeVisible();
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

  /** Flag off, and the route hands back the pre-rehaul screen with its own disclosure intact. */
  it("renders the pre-rehaul screen while the rehaul flag is off", async () => {
    vi.stubEnv("SETTERFI_UI_REHAUL", "false");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ connection: null })));
    render(<CalendarOnboardingPage />);

    await screen.findByText("Authorize a calendar with its provider before recording its receipt here.");
    expect(screen.getByText("Set up manually")).toBeVisible();
    expect(screen.queryByText("Step 4 of 5")).toBeNull();
    vi.unstubAllEnvs();
  });
});
