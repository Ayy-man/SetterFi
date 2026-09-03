import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { namedTierChoices } from "@/app/signup/page";
import { RehaulSignupForm } from "@/components/workspace/rehaul/signup-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

describe("the public plan catalogue", () => {
  it("fails closed when ids or human labels are ambiguous", () => {
    expect(namedTierChoices([
      { id: "tier-growth-a", label: "Growth" },
      { id: "tier-growth-b", label: " growth " },
    ])).toEqual([]);
    expect(namedTierChoices([
      { id: "tier-growth", label: "Growth" },
      { id: "tier-growth", label: "Scale" },
    ])).toEqual([]);
  });
});

/**
 * The signup half of the account-terms mechanism.
 *
 * `terms` arrives only when `SETTERFI_ACCOUNT_TERMS_LIVE` is on and a version is published. The
 * unarmed form is the one that shipped before any of this existed, and it has to stay that form:
 * the route refuses `acceptedTermsVersionKey` when it has no version to match it against, so a
 * form that volunteered the field would break every signup rather than only the ones under the
 * flag.
 *
 * The gating half -- an un-ticked box, a held submit, and no control at all when nothing is
 * published -- is asserted next to the card it draws, in
 * `src/components/workspace/rehaul/auth-card.test.tsx`. What is left here is the half only a
 * submitted body can show, which is whether the field goes out at all.
 */
describe("the signup form's account-terms field", () => {
  const TIERS = [{ id: "tier-growth", label: "Growth" }];
  const TERMS = {
    versionKey: "2026-10-terms-v1",
    termsBody: "Approved account terms body.",
    privacyBody: "Approved account privacy body.",
  };

  // Restored by name rather than with `vi.unstubAllGlobals()`, which would also strip the
  // `IntersectionObserver` stub `src/test/setup-ui.ts` installs the same way -- and `next/link`
  // reaches for it the moment the success view replaces the form.
  const realFetch = globalThis.fetch;
  afterEach(() => {
    vi.stubGlobal("fetch", realFetch);
  });

  function stubSignupEndpoint() {
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
    return fetchMock;
  }

  /*
   * Filled through the `name` each control submits under rather than through its visible label.
   * The card's words are the artboard's and are asserted where the card is; what this file is
   * about is the payload, and the payload is keyed by name.
   */
  async function fillRequiredFields(user: ReturnType<typeof userEvent.setup>) {
    const type = async (name: string, value: string) => {
      await user.type(document.querySelector(`[name="${name}"]`)!, value);
    };
    await type("fullName", "Dana Coach");
    await type("businessName", "Dana Credit");
    await type("slug", "dana-credit");
    await type("email", "dana@example.com");
    await type("password", "supersecret");
    await user.click(screen.getByRole("radio", { name: "Growth" }));
  }

  it("submits the published version key it was handed", async () => {
    const user = userEvent.setup();
    const fetchMock = stubSignupEndpoint();
    render(<RehaulSignupForm enabled referralCode={null} terms={TERMS} tiers={TIERS} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("checkbox", { name: /terms of service/u }));
    await user.click(screen.getByRole("button", { name: "Create my account" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body.acceptedTermsVersionKey).toBe("2026-10-terms-v1");
  });

  it("sends no acceptance field at all when nothing is published", async () => {
    const user = userEvent.setup();
    const fetchMock = stubSignupEndpoint();
    render(<RehaulSignupForm enabled referralCode={null} terms={null} tiers={TIERS} />);

    await fillRequiredFields(user);
    await user.click(screen.getByRole("button", { name: "Create my account" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect("acceptedTermsVersionKey" in body).toBe(false);
  });
});
