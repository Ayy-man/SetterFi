import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import NotFound from "@/app/not-found";

/**
 * The wrong-address page, and the one thing about it that is per-role.
 *
 * `NotFound.dc.html` draws one sentence and one button with no code on the page. The two things
 * the coach board leaves out are aimed at its reader: a coach who mistyped a URL does not read
 * status codes, so the 76px `404` is the page's most prominent element saying nothing they can
 * use, and a second way out on a dead end is a choice to make before they can leave. Admin and
 * affiliate keep both, so every assertion below is paired against the other role rather than
 * asserted alone: an absence with no positive control beside it passes against a page that
 * rendered nothing at all.
 */

const claims = vi.hoisted(() => ({ role: "coach" as string | null }));

vi.mock("@/lib/auth/mode", () => ({ authMode: () => "supabase" }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getClaims: async () => ({
        data: claims.role === null
          ? null
          : { claims: { app_metadata: { role: claims.role }, sub: "user-1" } },
        error: null,
      }),
    },
  }),
}));

/*
 * `CoachScale` pulls in the coach stylesheet through a side-effecting import, which jsdom has no
 * loader for and which is not what this file is about. The element it renders is kept so the
 * page's own tree is unchanged.
 */
vi.mock("@/components/coach-scale", () => ({
  CoachScale: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

async function renderAs(role: string | null) {
  claims.role = role;
  render(await NotFound());
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the wrong-address page", () => {
  it("says the same thing to everyone", async () => {
    await renderAs("coach");

    expect(screen.getByRole("heading", { level: 1, name: "This page is not here" })).toBeVisible();
    expect(screen.getByText(/Nothing is wrong with your account/u)).toBeVisible();
  });

  it("prints no status code for a coach, and still prints one for the console", async () => {
    await renderAs("coach");
    expect(screen.queryByText("404")).not.toBeInTheDocument();

    document.body.innerHTML = "";
    await renderAs("admin");
    expect(screen.getByText("404")).toBeInTheDocument();
  });

  it("offers a coach one way back, and the console its two", async () => {
    await renderAs("coach");
    const coachLinks = screen.getAllByRole("link");
    expect(coachLinks.map((link) => link.textContent?.trim())).toEqual(["Back to Home"]);
    expect(coachLinks[0]).toHaveAttribute("href", "/coach/home");

    document.body.innerHTML = "";
    await renderAs("admin");
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  /**
   * A session the page cannot read is not a coach, and must not be treated as one: the reader
   * could be anybody, so they get the page's full complement of ways out rather than the coach
   * board's single one.
   */
  it("treats an unreadable session as not a coach", async () => {
    await renderAs(null);

    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toBeVisible();
  });
});
