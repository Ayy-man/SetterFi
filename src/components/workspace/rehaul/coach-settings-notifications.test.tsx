import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoachSettingsNotifications } from "@/components/workspace/rehaul/coach-settings-notifications";

/*
 * `AppShell` reaches for the app router and for the workspace env; neither exists in jsdom, and
 * neither is what this file is about. The shell is asserted by the route's own guards
 * (`workspace-navigation.test.ts`, `notification-view-models.test.ts`); what is asserted here is
 * the one question and the statements under it.
 */
vi.mock("@/components/kit/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/coach/settings",
}));

function preferenceResponse(preference: string | null, status = 200) {
  return new Response(JSON.stringify({ preference }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => preferenceResponse("email")));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("CoachSettingsNotifications", () => {
  /**
   * The whole point of the screen. Spec section 2.7 collapses a 29-notice, 58-checkbox matrix to
   * one question, and the audit measured what the matrix cost: 42 accent fills on one page, 117
   * targets under 44px, and 5686px of document. Counting the controls is the test that catches the
   * matrix creeping back one group at a time.
   */
  it("asks one question with three answers and offers no other control", async () => {
    render(<CoachSettingsNotifications enabled />);

    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Where do you want to be told?" })).toBeVisible();

    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(3);
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    // Save is the page's only button. The context eye is chrome every coach screen carries, so it
    // is excluded by name rather than by counting it as one of this page's controls.
    const buttons = screen.getAllByRole("button")
      .filter((button) => button.getAttribute("aria-label") !== "About this screen");
    expect(buttons.map((button) => button.textContent)).toEqual(["Save"]);
  });

  it("spends exactly one accent fill", async () => {
    const { container } = render(<CoachSettingsNotifications enabled />);

    await screen.findByRole("radio", { name: /Email/u });
    const fills = container.querySelectorAll('[class*="--accent-fill"]');
    expect(fills).toHaveLength(1);
    expect(fills[0]!.textContent).toContain("Save");
  });

  it("reads the coach's stored preference and shows it as chosen", async () => {
    render(<CoachSettingsNotifications enabled />);

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/coach/notification-preference",
      expect.anything(),
    ));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Email/u })).toBeChecked());
  });

  /**
   * Text has a preference store and an audit trail behind it and no delivery worker at all --
   * `claim_notification_deliveries` still only claims email. Offering the answer as though it
   * worked would be the product promising a message it has no way to send.
   */
  it("says text and both are not ready, and refuses to let them be picked", async () => {
    render(<CoachSettingsNotifications enabled />);

    await screen.findByRole("radio", { name: /Email/u });
    expect(screen.getAllByText("Not ready yet")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: /Text/u })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Both/u })).toBeDisabled();
  });

  /**
   * Absence is stated where the answer would be. An unreadable preference and a preference of
   * "email" are different facts, and a screen that draws them the same way makes every reading on
   * it unfalsifiable.
   */
  it("says it cannot tell rather than showing a guessed answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => preferenceResponse(null)));
    render(<CoachSettingsNotifications enabled />);

    expect(await screen.findByText(/cannot tell which of these your account is on/u)).toBeVisible();
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("writes the picked answer and reports what came back", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      preferenceResponse(init?.method === "PUT" ? "email" : "text"));
    vi.stubGlobal("fetch", fetchMock);

    render(<CoachSettingsNotifications enabled />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Text/u })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: /Email/u }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText(/Saved, and read back/u)).toBeVisible());
    const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({ preference: "email" });
  });

  it("says nothing changed when the write is refused", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "PUT" ? preferenceResponse(null, 409) : preferenceResponse("text")));

    render(<CoachSettingsNotifications enabled />);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Text/u })).toBeChecked());

    await user.click(screen.getByRole("radio", { name: /Email/u }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Nothing about your account changed/u)).toBeVisible();
  });

  /**
   * The counted sentence the owner console landed and the audit says was never carried across: one
   * sentence in place of "Required" printed eight times with a lock glyph beside every locked box.
   * The count comes from the list's own length, so the sentence and the list cannot drift apart.
   */
  it("states what is already sent as a counted list with nothing pressable in it", async () => {
    render(<CoachSettingsNotifications enabled />);

    const panel = screen
      .getByRole("heading", { name: "What we already send you" })
      .closest("section") as HTMLElement;
    const statements = within(panel).getAllByRole("listitem");
    expect(statements).toHaveLength(4);
    expect(panel).toHaveTextContent("There are 4 of these, and only 4.");
    expect(within(panel).queryByRole("button")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(within(panel).queryByRole("switch")).not.toBeInTheDocument();
    expect(panel).not.toHaveTextContent("Required");
  });

  /**
   * Three facts the artboard prints that no read on this page carries. Each would be a plausible
   * invention, which is what makes them worth a test rather than a comment.
   */
  it("invents no email address, no carrier day count and no card number", async () => {
    render(<CoachSettingsNotifications enabled />);

    await screen.findByRole("radio", { name: /Email/u });
    expect(screen.queryByText(/@/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/day \d+ of/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/ending \d/u)).not.toBeInTheDocument();
  });

  it("offers a way back, since the account menu is not a place on a page", () => {
    render(<CoachSettingsNotifications enabled />);

    expect(screen.getByRole("link", { name: /Back to Home/u }))
      .toHaveAttribute("href", "/coach/home");
  });

  /**
   * With alerts off there is nothing to read or write, and the page says so where the answer would
   * be rather than rendering a control that cannot settle anything. What SetterFi sends is true
   * either way, so that half stays.
   */
  it("withholds the question but keeps the statements when alerts are off", () => {
    render(<CoachSettingsNotifications enabled={false} />);

    expect(screen.getByText(/not sending notifications yet/u)).toBeVisible();
    expect(screen.getByRole("heading", { name: "What we already send you" })).toBeVisible();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});
