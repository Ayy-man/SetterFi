import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { referralCodeFromParam } from "@/components/onboarding/view-models";
import { REFERRAL_QUERY_PARAM } from "@/lib/affiliates/referral-attribution";

/**
 * The affiliate's referral link, end to end: URL → prefilled field → submitted payload.
 *
 * `GET /api/affiliate/referrals` has always built `/signup?ref=<code>`, and until this landed
 * nothing in the tree read the parameter back. The failure was silent in both directions -- the
 * prospect saw an empty optional box and the affiliate saw no error, because the RPC simply never
 * received a code -- which is why the portal was rendering the bare code and refusing the Copy-link
 * control. A test that only checked the shape-checker would not have caught it: the defect was that
 * the read did not exist, not that it was wrong.
 *
 * So the first test drives the real page. It renders `SignupPage` with the referral parameter in
 * its `searchParams`, fills the form the way a coach would, submits, and asserts the code arrives
 * in the body `POST /api/onboarding/signup` receives.
 *
 * Scope: these are the mechanics of the read only. The two-sided contract -- that the affiliate
 * route and this page name the same parameter, and that either both halves are wired or neither is
 * -- belongs to `referral-attribution.test.ts` in the affiliate lane, because a contract asserted
 * from one end twice is two half-guards that drift. Even the parameter name here comes from
 * `REFERRAL_QUERY_PARAM` rather than a literal, so this file cannot be the place the two ends
 * disagree.
 */

vi.mock("@/lib/env-contract", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/env-contract")>()),
  phase5Live: () => true,
}));

vi.mock("@/app/api/onboarding/signup/route", () => ({
  GET: async () => Response.json({ tiers: [{ id: "tier-growth", label: "Growth" }] }),
}));

const REF = "SF-A1B2C3D4E5F6";

// `fetch` is restored by name rather than with `vi.unstubAllGlobals()`, which would also strip the
// `IntersectionObserver` and `ResizeObserver` stubs `src/test/setup-ui.ts` installs the same way --
// and `next/link` reaches for the first of those the moment the success card renders.
const realFetch = globalThis.fetch;
afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
});

/** The parameter is always addressed through the shared constant, never as a typed `"ref"`. */
async function renderSignupPage(value: string | string[]) {
  const { default: SignupPage } = await import("@/app/signup/page");
  render(await SignupPage({ searchParams: Promise.resolve({ [REFERRAL_QUERY_PARAM]: value }) }));
}

function fillRequiredFields() {
  const type = (label: RegExp, value: string) => {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  };
  type(/full name/i, "Dana Reid");
  type(/business name/i, "Reid Funding Group");
  type(/workspace address/i, "reid-funding");
  type(/^email/i, "dana@example.test");
  type(/^password/i, "correct horse battery");
  type(/business timezone/i, "America/Chicago");
  fireEvent.click(screen.getByRole("radio", { name: "Growth" }));
}

function stubSignupEndpoint() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ state: "completed", referral: { status: "applied" } }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the affiliate referral link", () => {
  it("carries its code from the URL into the field and on into the submitted signup", async () => {
    const fetchMock = stubSignupEndpoint();
    await renderSignupPage(REF);

    expect(screen.getByLabelText(/referral code/i)).toHaveValue(REF);
    expect(screen.getByText(/from the link you followed/i)).toBeInTheDocument();

    fillRequiredFields();
    // "Create my account and start setup" since the coach-language port on 2026-09-01; the
    // pattern is loose enough to survive the trailing clause and tight enough to still be the
    // submit rather than any other button on the form.
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/onboarding/signup");
    expect(JSON.parse(String(init.body))).toMatchObject({ referralCode: REF });
  });

  /**
   * The prospect's half of the bargain. The field is prefilled rather than locked, so clearing it
   * has to submit cleanly -- `null`, the same thing a signup with no code at all sends -- rather
   * than an empty string the route would have to special-case.
   */
  it("submits cleanly when the signer-upper clears the prefilled code", async () => {
    const fetchMock = stubSignupEndpoint();
    await renderSignupPage(REF);

    fireEvent.change(screen.getByLabelText(/referral code/i), { target: { value: "" } });
    fillRequiredFields();
    fireEvent.click(screen.getByRole("button", { name: /create my account/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).referralCode).toBeNull();
  });

  it("prefills nothing when the parameter is not shaped like a code", async () => {
    await renderSignupPage("https://elsewhere.test/?x=<script>");

    expect(screen.getByLabelText(/referral code/i)).toHaveValue("");
    expect(screen.getByText(/^Optional$/)).toBeInTheDocument();
  });

  it("prefills nothing when the parameter is repeated, which is not a code", async () => {
    await renderSignupPage(["SF-ONE", "SF-TWO"]);

    expect(screen.getByLabelText(/referral code/i)).toHaveValue("");
  });
});

/**
 * The shape check on its own. The ceiling is 64 because that is the ceiling
 * `POST /api/onboarding/signup` already enforces: a value the route would reject should never be
 * put in front of a signer-upper looking as if it were valid.
 */
describe("referralCodeFromParam", () => {
  it("keeps a plausible code and trims it", () => {
    expect(referralCodeFromParam(` ${REF} `)).toBe(REF);
    expect(referralCodeFromParam("legacy_code.2")).toBe("legacy_code.2");
  });

  it("rejects anything that is not one", () => {
    for (const value of ["", "   ", "a b", "SF/../etc", "<script>", "-leading", undefined, null, 7, ["SF-X"]]) {
      expect(referralCodeFromParam(value), String(value)).toBeNull();
    }
  });

  it("rejects a code longer than the route's own 64-character ceiling", () => {
    expect(referralCodeFromParam("S".repeat(64))).toBe("S".repeat(64));
    expect(referralCodeFromParam("S".repeat(65))).toBeNull();
  });
});
