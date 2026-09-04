import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT ${path}`);
});
vi.mock("next/navigation", () => ({ redirect: (path: string) => redirect(path) }));

import OnboardingPage from "./page";

/**
 * The setup root is Setup. This route used to draw a third list about one setup, and the rule is
 * now one list off one read, drawn on `/coach/get-started` and compact on Home. The step screens
 * under `/onboarding/*` are unchanged and their back links land here, so the redirect is what
 * keeps them arriving at the list.
 */
describe("the setup root", () => {
  it("redirects to Setup before reading anything", () => {
    expect(() => OnboardingPage()).toThrow("NEXT_REDIRECT /coach/get-started");
    expect(redirect).toHaveBeenCalledWith("/coach/get-started");
  });
});
