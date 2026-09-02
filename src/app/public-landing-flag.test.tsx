import { NextRequest, NextResponse } from "next/server";
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createProxy } from "@/proxy";

/**
 * The public marketing page, and the flag that is the whole of the decision to open the front door.
 *
 * `/` serves two different pages for two different readers: the three-way role picker it has
 * always served, and -- only when `SETTERFI_PUBLIC_LANDING_LIVE` is exactly "true" -- the public
 * sales page. This is not a look-and-feel flag. Turning it on changes who can load `/` without a
 * session, on a project with one environment that deploys straight to the client's Vercel project,
 * which is why it exists at all and why default-off is the assertion that matters most here.
 *
 * `src/app/entry-surfaces.test.ts` is deliberately untouched by this file. Its three assertions
 * about `/` -- that it stands on `AuthStage`, names no colour, and spends no accent fill -- are
 * source assertions on `page.tsx`, and they stay true because the marketing page lives in its own
 * module rather than inside that file. Nothing was relaxed to let the page through, and this file
 * is the new coverage rather than an edit to the old.
 */

function request(path: string) {
  return new NextRequest(`https://setterfi.test${path}`);
}

/** A signed-out browser under real auth: a session that loads and carries no claims. */
function signedOutSupabase(publicLanding: boolean) {
  return createProxy({
    loadSession: vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null }),
    mode: () => "supabase",
    password: () => null,
    passwordAuthorized: vi.fn(),
    publicLanding: () => publicLanding,
  });
}

describe("the public landing flag, at the gate", () => {
  /**
   * The default, and the assertion this file exists for. A flag that silently defaults on is the
   * same as no flag, and the thing it would have opened is the product's front door.
   */
  it("keeps / behind the gate when the flag is off, which is what a deployment does by default", async () => {
    const response = await signedOutSupabase(false)(request("/"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://setterfi.test/login?next=%2F");
  });

  /** The other direction, so the flag is proved to do something rather than merely to exist. */
  it("lets a signed-out browser have / when the flag is on", async () => {
    const response = await signedOutSupabase(true)(request("/"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  /**
   * The failure this shape was chosen to avoid. `/` cannot go in `PUBLIC_PREFIXES`, because that
   * list matches on prefix and every path in the app begins with a slash -- so listing it there
   * would open the admin console, the coach workspace and every API route in one line. This is the
   * test that would have caught that, and it is the reason the allowance is an exact-path check in
   * the proxy rather than an entry in the inventory.
   */
  it("opens only / and nothing beneath it, even with the flag on", async () => {
    const handler = signedOutSupabase(true);

    for (const path of ["/admin/overview", "/coach/home", "/affiliate", "/onboarding"]) {
      const response = await handler(request(path));
      expect(response.status, `${path} was left open`).toBe(307);
    }
  });

  /**
   * The same allowance under the shared-password gate. A marketing page behind a password prompt
   * is the same non-door as one behind a login, and a flag that means different things depending
   * on which gate a deployment happens to run is a flag nobody can reason about.
   */
  it("means the same thing under the shared-password gate as under real auth", async () => {
    const passwordAuthorized = vi.fn().mockResolvedValue(false);
    const handler = createProxy({
      loadSession: vi.fn(),
      mode: () => "password",
      password: () => "configured",
      passwordAuthorized,
      publicLanding: () => true,
    });

    const response = await handler(request("/"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(passwordAuthorized).not.toHaveBeenCalled();
  });

  /** With no `publicLanding` dependency supplied at all, the gate stays shut. */
  it("treats an absent flag as off rather than as unset-therefore-permissive", async () => {
    const handler = createProxy({
      loadSession: vi.fn().mockResolvedValue({ response: NextResponse.next(), claims: null }),
      mode: () => "supabase",
      password: () => null,
      passwordAuthorized: vi.fn(),
    });

    expect((await handler(request("/"))).status).toBe(307);
  });
});

/**
 * The other half: which page `/` actually renders. The gate and the page have to agree, because a
 * public page the gate still turns away is a worse failure than no page at all -- it looks like a
 * broken deployment rather than an unreleased feature.
 */
describe("the public landing flag, at the page", () => {
  // `SETTERFI_AUTH_MODE` is set because the role-picker branch reads the live gate to write its
  // access note, and `authMode()` throws rather than guessing when the mode is unconfigured. That
  // is the correct behaviour for a page that tells a visitor whether permissions are enforced --
  // it must never say "open" because a variable was missing -- so the test supplies a mode instead
  // of the page being made to tolerate its absence.
  async function renderHome(flag: string | undefined) {
    vi.resetModules();
    const previous = {
      landing: process.env.SETTERFI_PUBLIC_LANDING_LIVE,
      mode: process.env.SETTERFI_AUTH_MODE,
    };
    process.env.SETTERFI_AUTH_MODE = "open";
    if (flag === undefined) delete process.env.SETTERFI_PUBLIC_LANDING_LIVE;
    else process.env.SETTERFI_PUBLIC_LANDING_LIVE = flag;
    try {
      const { default: Home } = await import("@/app/page");
      // Awaited rather than passed to `createElement`, because `Home` became an async server
      // component when the marketing page stopped hard-coding its prices: it now resolves the
      // signup tier catalogue on the server and hands the plans down. Nothing this file asserts
      // changed -- which page `/` serves under which flag value is still the whole question.
      render(await Home());
    } finally {
      for (const [name, value] of [
        ["SETTERFI_PUBLIC_LANDING_LIVE", previous.landing],
        ["SETTERFI_AUTH_MODE", previous.mode],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  }

  it("renders the role picker by default, exactly as it did before the flag existed", async () => {
    await renderHome(undefined);

    expect(screen.getByRole("navigation", { name: "Workspace views" })).toBeVisible();
    expect(screen.queryByRole("link", { name: /Start your setup/u })).toBeNull();
  });

  it("renders the marketing page when the flag is on", async () => {
    await renderHome("true");

    expect(screen.getByRole("heading", {
      level: 1,
      name: /Every funding DM answered, qualified and booked, without you\./u,
    })).toBeVisible();
    expect(screen.queryByRole("navigation", { name: "Workspace views" })).toBeNull();
  });

  /**
   * "true" and nothing else, which is how every other gate in `env-contract.ts` reads. A flag that
   * accepts "1" or "TRUE" is a flag that turns itself on when someone copies a value from another
   * tool's documentation.
   */
  it("is off for every value that is not exactly true", async () => {
    for (const value of ["", "1", "TRUE", "yes", "false"]) {
      // The loop renders into one document, so each pass has to clear the last. Without this the
      // second iteration finds two pickers and the query throws "found multiple elements" -- which
      // reads as a failure of the thing under test rather than of the test's own bookkeeping.
      cleanup();
      await renderHome(value);
      expect(
        screen.queryByRole("navigation", { name: "Workspace views" }),
        `${JSON.stringify(value)} was treated as on`,
      ).toBeVisible();
    }
  });
});
