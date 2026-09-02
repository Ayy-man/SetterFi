import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import LoginPage from "./page";

/**
 * The one link off the front door, against the page it points at.
 *
 * `/signup` decides whether it is open by calling `phase5Live()`: with the flag off it renders
 * "Account setup is not available yet. Self-serve onboarding is currently off." This link read
 * nothing, so on a deployment with onboarding off the first screen of the product invited every
 * visitor into that refusal.
 *
 * The check drives the same environment variable `/signup` reads rather than mocking a boolean,
 * which is the point of the fix: a second flag for the invitation could drift from the flag on the
 * destination, and the drift would look exactly like what was already shipping.
 */

const FLAG = "SETTERFI_PHASE5_LIVE";

/**
 * `SETTERFI_AUTH_MODE` is set alongside it because `authMode()` throws on an unset value rather
 * than defaulting, and this page calls it before it reaches the link. "open" is the fixture that
 * resolves no session, which is the signed-out visitor this test is about.
 */
function withFlag(value: string | undefined) {
  const previous = { flag: process.env[FLAG], mode: process.env.SETTERFI_AUTH_MODE };
  process.env.SETTERFI_AUTH_MODE = "open";
  if (value === undefined) delete process.env[FLAG];
  else process.env[FLAG] = value;
  return () => {
    if (previous.flag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = previous.flag;
    if (previous.mode === undefined) delete process.env.SETTERFI_AUTH_MODE;
    else process.env.SETTERFI_AUTH_MODE = previous.mode;
  };
}

function search() {
  return Promise.resolve({});
}

afterEach(cleanup);

describe("the sign-up invitation on /login", () => {
  it("is not offered while self-serve onboarding is switched off", async () => {
    const restore = withFlag(undefined);
    try {
      render(await LoginPage({ searchParams: search() }));
      // The positive control: the page has to have rendered before an absence means anything.
      expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Set up your agent" })).toBeNull();
      expect(document.querySelector('a[href="/signup"]')).toBeNull();
    } finally {
      restore();
    }
  });

  it("is offered once the flag /signup itself reads is on", async () => {
    const restore = withFlag("true");
    try {
      render(await LoginPage({ searchParams: search() }));
      const link = screen.getByRole("link", { name: "Set up your agent" });
      expect(link).toHaveAttribute("href", "/signup");
    } finally {
      restore();
    }
  });
});
