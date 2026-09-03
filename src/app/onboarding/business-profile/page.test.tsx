import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import BusinessProfilePage from "./page";

function json(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); }

afterEach(() => vi.unstubAllGlobals());

describe("BusinessProfilePage", () => {
  it("saves through its API and only calls the profile complete after the audit-backed read-back", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ profile: null }))
      .mockResolvedValueOnce(json({ profile: { id: "profile-1", legalName: "Synthetic LLC", entityType: "llc", hasEin: true, websiteUrl: "https://example.test", addressLine1: "1 Test", addressLine2: null, city: "Austin", region: "TX", postalCode: "78701", countryCode: "US", updatedAt: "2026-09-07T00:00:00Z" }, audit: { id: "42" } }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<BusinessProfilePage />);
    await screen.findByText("Enter the legal business details used for A2P filing.");
    await user.type(screen.getByLabelText("Legal business name"), "Synthetic LLC");
    await user.selectOptions(screen.getByLabelText("Entity type"), "llc");
    expect(screen.getByRole("button", { name: "Save business profile" })).toBeDisabled();
    await user.click(screen.getByLabelText("This business has an EIN"));
    await user.type(screen.getByLabelText("Website URL"), "https://example.test");
    await user.type(screen.getByLabelText("Address line 1"), "1 Test");
    await user.type(screen.getByLabelText("City"), "Austin");
    await user.type(screen.getByLabelText("State / region"), "TX");
    await user.type(screen.getByLabelText("Postal code"), "78701");
    await user.click(screen.getByRole("button", { name: "Save business profile" }));
    await screen.findByText("Business profile saved. Logged in your onboarding audit trail.");
    expect(fetcher).toHaveBeenLastCalledWith("/api/onboarding/business-profile", expect.objectContaining({ method: "POST" }));
  });

  /**
   * The submit goes dead for one reason, and that reason has to reach a reader who cannot see it.
   *
   * Picking `llc` disables "Save business profile" with the explanation rendered as ordinary prose
   * several fields above the button, announced by nothing and named by nothing. A control that
   * stops working with no announced cause is a dead end: the reader tabs to a disabled button and
   * the page has told them nothing about how to get past it. The message is an alert so it is read
   * when it appears, and both the checkbox that clears it and the submit it blocks point at it.
   */
  it("announces why the submit is disabled, and names the message from both controls", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ profile: null })));
    const user = userEvent.setup();
    render(<BusinessProfilePage />);
    await screen.findByText("Enter the legal business details used for A2P filing.");

    expect(screen.queryByRole("alert")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Entity type"), "llc");

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("LLCs and corporations must have an EIN before this profile can be saved.");
    const submit = screen.getByRole("button", { name: "Save business profile" });
    expect(submit).toBeDisabled();
    expect(submit.getAttribute("aria-describedby")).toBe(alert.id);
    expect(screen.getByLabelText("This business has an EIN").getAttribute("aria-describedby")).toBe(alert.id);
    expect(alert.id).not.toBe("");

    // Ticking the box is the way out, and the description goes with the reason.
    await user.click(screen.getByLabelText("This business has an EIN"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Save business profile" }).getAttribute("aria-describedby")).toBeNull();
  });

  /**
   * The route is a server component now, and the flag decides which screen it hands back. With the
   * flag off it must be the pre-rehaul form, unchanged, including the submit's own words.
   */
  it("renders the pre-rehaul form while the rehaul flag is off", async () => {
    vi.stubEnv("SETTERFI_UI_REHAUL", "false");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ profile: null })));
    render(<BusinessProfilePage />);

    await screen.findByText("Enter the legal business details used for A2P filing.");
    expect(screen.getByRole("button", { name: "Save business profile" })).toBeVisible();
    expect(screen.queryByText("Step 1 of 5")).toBeNull();
    vi.unstubAllEnvs();
  });
});
