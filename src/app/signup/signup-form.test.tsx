import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SignupForm } from "@/app/signup/signup-form";
import { namedTierChoices } from "@/app/signup/page";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("SignupForm", () => {
  it("fails the public catalogue closed when ids or human labels are ambiguous", () => {
    expect(namedTierChoices([
      { id: "tier-growth-a", label: "Growth" },
      { id: "tier-growth-b", label: " growth " },
    ])).toEqual([]);
    expect(namedTierChoices([
      { id: "tier-growth", label: "Growth" },
      { id: "tier-growth", label: "Scale" },
    ])).toEqual([]);
  });

  /**
   * The plans differ on their allowance, and until now the cards priced them on money alone -- the
   * number that varies least. Three arms, and the third is the point: an allowance the catalogue
   * could not state is absent rather than rendered as zero, because "0 booked calls included" is a
   * claim about what a customer is buying and a silent card is not.
   */
  it("states what each plan includes, and states nothing when the catalogue could not say", async () => {
    render(
      <SignupForm
        enabled
        tiers={[
          { callAllowance: 10, id: "tier-growth", label: "Growth" },
          { callAllowance: 1, id: "tier-solo", label: "Solo" },
          { id: "tier-unknown", label: "Unknown" },
        ]}
      />,
    );

    await screen.findByRole("radio", { name: "Growth" });
    const cardFor = (name: string) => screen.getByRole("radio", { name }).closest("label")!;

    expect(cardFor("Growth").textContent).toContain("10 booked calls included");
    // Singular, because a card that reads "1 booked calls included" reads as a template failure.
    expect(cardFor("Solo").textContent).toContain("1 booked call included");
    expect(cardFor("Unknown").textContent).not.toMatch(/booked call/u);
    expect(cardFor("Unknown").textContent).not.toMatch(/\b0\b/u);

    /*
     * The half of the artboard's line that is NOT here. No column, contract field or env value in
     * this product records a per-call overage price, so any figure after "then" would be invented
     * on the one page where an invented number becomes a price a customer is owed at.
     */
    const catalogue = screen.getByRole("radio", { name: "Growth" }).closest("div")!;
    expect(catalogue.textContent).not.toMatch(/then \$|each after|per extra|overage/iu);
    // And no manufactured recommendation: the catalogue returns no such flag.
    expect(catalogue.textContent).not.toMatch(/most coaches|recommended|most popular/iu);
  });

  it("does not render a plan option whose display name is blank", async () => {
    render(
      <SignupForm
        enabled
        tiers={[
          { id: "tier-growth", label: "Growth" },
          { id: "tier-blank", label: "   " },
        ]}
      />,
    );

    expect(await screen.findByRole("radio", { name: "Growth" })).toBeVisible();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.queryByDisplayValue("tier-blank")).not.toBeInTheDocument();
  });

  it("shows authoritative commercial terms without changing the plan control name", async () => {
    render(
      <SignupForm
        enabled
        tiers={[{
          id: "tier-growth",
          label: "Growth",
          commercialTerms: {
            currency: "USD",
            amountCents: 49_900,
            interval: "month",
            effectiveFrom: "2026-09-01T00:00:00.000Z",
            effectiveTo: null,
          },
        }]}
      />,
    );

    expect(await screen.findByRole("radio", { name: "Growth" })).toBeVisible();
    // The figure and the period are separate objects, at separate sizes: a coach comparing three
    // cards reads the number first, and "$499 / month" set the amount at a caption's weight with
    // the slash carrying as much of the line as the price did.
    expect(screen.getByText("$499")).toBeVisible();
    expect(screen.getByText("a month")).toBeVisible();
    expect(screen.queryByText("$499 / month")).not.toBeInTheDocument();
  });

  it("says a plan can be changed once, in the panel head, rather than over the first card", () => {
    const view = render(
      <SignupForm enabled tiers={[{ id: "tier-growth", label: "Growth" }]} />,
    );

    const notes = screen.getAllByText("You can move up or down a plan any month.");
    expect(notes).toHaveLength(1);
    // The panel's own sentence slot, which is where a fact about every card belongs. As a loose
    // paragraph above the grid it read as a caption on whichever card happened to sit under it,
    // and `.coach-panel__sentence` is the class that tells the two apart.
    expect(notes[0]).toHaveClass("coach-panel__sentence");
    expect(view.container.querySelectorAll(".coach-panel__sentence")).toHaveLength(1);
  });
});

/**
 * The signup half of the account-terms mechanism.
 *
 * `terms` arrives only when `SETTERFI_ACCOUNT_TERMS_LIVE` is on and a version is published. The
 * unarmed form is the one that shipped before any of this existed, and it has to stay byte-for-byte
 * that form: the route refuses `acceptedTermsVersionKey` when it has no version to match it
 * against, so a form that volunteered the field would break every signup rather than only the
 * ones under the flag.
 */
describe("SignupForm account terms", () => {
  const TIERS = [{ id: "tier-growth", label: "Growth" }];
  const TERMS = {
    versionKey: "2026-10-terms-v1",
    termsBody: "Approved account terms body.",
    privacyBody: "Approved account privacy body.",
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A successful signup swaps the form for the "Continue" link, and `next/link` prefetch reaches
   * for `IntersectionObserver`, which jsdom does not implement. Stubbing it keeps the two
   * submit tests asserting what they are about rather than dying in the view that follows them.
   */
  function stubLinkPrefetchObserver() {
    vi.stubGlobal("IntersectionObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    });
  }

  async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByRole("textbox", { name: /Full name/u }), "Dana Coach");
    await user.type(screen.getByRole("textbox", { name: /Business name/u }), "Dana Credit");
    await user.type(screen.getByRole("textbox", { name: /Workspace address/u }), "dana-credit");
    await user.type(screen.getByRole("textbox", { name: /Email/u }), "dana@example.com");
    await user.type(document.querySelector("input[name='password']")!, "supersecret");
    await user.click(screen.getByRole("radio", { name: "Growth" }));
  }

  it("renders no acceptance control when nothing is published", async () => {
    render(<SignupForm enabled tiers={TIERS} />);

    expect(await screen.findByRole("radio", { name: "Growth" })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /terms of service/u })).not.toBeInTheDocument();
    expect(screen.queryByText(/Read the terms of service/u)).not.toBeInTheDocument();
  });

  it("asks for acceptance un-ticked, and holds the submit until it is given", async () => {
    const user = userEvent.setup();
    render(<SignupForm enabled terms={TERMS} tiers={TIERS} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: "I accept the SetterFi terms of service and privacy policy.",
    });
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("Read the terms of service")).toBeVisible();
    expect(screen.getByText("Read the privacy policy")).toBeVisible();
    expect(screen.getByText(TERMS.termsBody)).toBeInTheDocument();

    await fillRequiredFields(user);
    /*
     * "Create my account and start setup", not "Create account". The submit was renamed with the
     * coach-language port on 2026-09-01: the signup artboard labels it with what actually happens
     * next, because the button does two things and a coach who thinks it only makes an account is
     * surprised by the setup flow it drops them into. The assertion is pinned to the visible name
     * on purpose -- it is what a screen reader announces, so a silent relabel should fail here.
     */
    expect(screen.getByRole("button", { name: "Create my account and start setup" })).toBeDisabled();

    await user.click(checkbox);
    expect(screen.getByRole("button", { name: "Create my account and start setup" })).toBeEnabled();
  });

  it("submits the published version key it was handed", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify({
        state: "ready",
        replayed: false,
        referral: {
          status: "none",
          coachCode: null,
          message: null,
          affiliateEnrollment: "not_requested",
          attributionLocked: true,
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    stubLinkPrefetchObserver();
    render(<SignupForm enabled terms={TERMS} tiers={TIERS} />);

    await screen.findByRole("radio", { name: "Growth" });
    await fillRequiredFields(user);
    await user.click(screen.getByRole("checkbox", { name: /terms of service/u }));
    await user.click(screen.getByRole("button", { name: "Create my account and start setup" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.acceptedTermsVersionKey).toBe("2026-10-terms-v1");
  });

  it("sends no acceptance field at all when nothing is published", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(
      JSON.stringify({
        state: "ready",
        replayed: false,
        referral: {
          status: "none",
          coachCode: null,
          message: null,
          affiliateEnrollment: "not_requested",
          attributionLocked: true,
        },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    stubLinkPrefetchObserver();
    render(<SignupForm enabled tiers={TIERS} />);

    await screen.findByRole("radio", { name: "Growth" });
    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Create my account and start setup" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect("acceptedTermsVersionKey" in body).toBe(false);
  });
});
