import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImpersonationBanner } from "@/components/kit/impersonation-banner";

const PROPS = {
  expiresAt: "2026-09-01T10:30:00.000Z",
  sessionId: "imp_9f31",
  startedAt: "2026-09-01T10:00:00.000Z",
  tenantName: "Reid Funding Group",
};

/**
 * `window.location.assign` is what the banner calls after a successful end, and jsdom's own
 * implementation throws "Not implemented". Replacing the whole `location` object is heavier than
 * this needs to be, so only the one method is stubbed and the test reads what it was called with.
 */
function stubAssign() {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign },
  });
  return assign;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ImpersonationBanner", () => {
  it("names the workspace being read rather than a tenant id", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("You are viewing Reid Funding Group’s workspace. Read-only.");
    expect(banner.textContent).not.toContain(PROPS.sessionId);
  });

  /**
   * The tenant-isolation rule, on screen. Reading a coach's workspace crosses a tenant boundary,
   * the read is audit-logged, and the coach sees the visit on their own trail -- the product rule
   * says this must be stated plainly and never weakened or hidden, so the words are pinned here.
   * The drift this catches is a later pass "tidying" the banner down to a two-word chip.
   */
  it("says the read is logged and that the coach can see the visit", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/Logged/u);
    expect(banner).toHaveTextContent(
      /This visit is on Reid Funding Group’s audit trail with your name on it/u,
    );
  });

  /**
   * Read-only has to say what to do instead, not only what is blocked.
   *
   * An owner who is told "no" and given no route will go looking for a way around it, which on a
   * console with a service-role client nearby is exactly the wrong instinct to provoke. The
   * canvas puts this sentence on the page it happened to draw; it lives in the banner because the
   * banner is the one thing on every page of the session.
   */
  it("names the route out, not only the block", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("Nothing here can be changed from this session.");
    expect(banner).toHaveTextContent(
      /ask them to make the change or open a support request from the owner console/u,
    );
  });

  /**
   * Whose session this is, in the band. An owner console is a shared login in practice, and a
   * person returning to a machine left open has to be able to tell before they act. The drift
   * this catches is the operator line being dropped as redundant with the workspace name -- they
   * are the two different halves of "who is reading whom".
   */
  it("names the operator and their capacity when one is supplied", () => {
    render(
      <ImpersonationBanner {...PROPS} operator={{ name: "Dana Whitlock", role: "client success" }} />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Dana Whitlock, client success");
  });

  it("says nothing rather than printing an id when the operator cannot be resolved", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent("You are viewing Reid Funding Group’s workspace");
    expect(banner.textContent).not.toMatch(/undefined|null/u);
  });

  /**
   * The session is a hard thirty minutes, so an expiry is expressible as a time and is stated as
   * one. What must never appear is a percentage or a progress bar over it: the honest-states rule
   * bans exactly that shape, and a banner with a shrinking bar is the most tempting place to add
   * one.
   */
  it("states when the session ends without drawing a percentage", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/The session ends on its own at/u);
    expect(banner.textContent).not.toMatch(/%/u);
  });

  /**
   * The narrowing trap, pinned.
   *
   * The identity sentence shares a flex line with two `shrink-0` neighbours -- the clock and the
   * way out -- and a bare `flex-1 min-w-0` block collapses to one word per line before the row
   * wraps, because wrapping only fires once an item cannot fit at its min-content width. The
   * coach inbox shipped the same bug in its other form and rendered every lead as "Jo...". The
   * basis is what makes the controls wrap under the sentence instead of squeezing it, so it is
   * pinned rather than left as a class somebody tidies away.
   */
  it("gives the identity sentence a width to defend against the shrink-0 controls", () => {
    render(<ImpersonationBanner {...PROPS} />);

    const sentence = screen
      .getByText(/You are viewing/u)
      .closest("div") as HTMLElement;
    expect(sentence.className).toMatch(/basis-\[320px\]/u);
    // The neighbours it has to survive. Both refuse to shrink, so neither may share the line
    // without the identity block having a width of its own to defend.
    expect(
      document.querySelector('[data-slot="impersonation-end"]')?.className,
    ).toMatch(/shrink-0/u);
    expect(sentence.parentElement?.firstElementChild?.className).toMatch(/shrink-0/u);
  });

  it("counts elapsed time up from the session start", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-09-01T10:07:12.000Z"));
    render(<ImpersonationBanner {...PROPS} />);

    await waitFor(() => {
      expect(
        document.querySelector('[data-slot="impersonation-elapsed"]'),
      ).toHaveTextContent("7m 12s in this workspace");
    });
  });

  /**
   * Navigation stays live during a session and only writes go inert, so the banner's own control
   * has to actually work. Before this component `/api/platform/impersonation/end` had no caller
   * anywhere in the app and the only way out of a session was to wait thirty minutes; this pins
   * that the way out exists and hits the right endpoint with the right session.
   */
  it("ends the session against the end endpoint and leaves for the console", async () => {
    const assign = stubAssign();
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();

    render(<ImpersonationBanner {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Leave this workspace" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/admin/platform-clients"));
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/platform/impersonation/end");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ sessionId: "imp_9f31" });
  });

  /**
   * A refused end must not read as a successful one. The failure mode this catches is a banner
   * that disappears or goes quiet on an error, leaving an operator convinced they are out of a
   * workspace they are still inside -- which is the one thing worse than not having a way out.
   */
  it("says the operator is still inside when ending is refused", async () => {
    stubAssign();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 409 })));
    const user = userEvent.setup();

    render(<ImpersonationBanner {...PROPS} />);
    await user.click(screen.getByRole("button", { name: "Leave this workspace" }));

    const failure = await screen.findByText(
      /you are still in Reid Funding Group’s workspace/u,
    );
    expect(failure).toBeInTheDocument();
    // Still offering a way out, and still saying which workspace this is.
    expect(screen.getByRole("button", { name: "Leave this workspace" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Reid Funding Group");
  });
});

/**
 * Every colour on the band comes from a token, and the reason is a bug this component shipped with.
 *
 * It was authored while the product was dark-only, and it transcribed the dark palette's warning
 * family into its class strings as raw rgba. That was invisible for as long as nothing rendered
 * it. Mounting the banner put dark-solved amber onto the light palette a viewer with no stored
 * theme gets, where `--warning-text` measured 4.39 on the band and 3.62 on the exit button against
 * a 4.5 floor -- an AA failure on the one control that gets an operator out of a tenant's
 * workspace. A literal cannot flip with the theme, so no amount of re-solving the tokens would
 * ever have reached it; `eb3bd1f` re-cut every light hairline and wash and this file did not move.
 *
 * The guard is on the source rather than on a computed colour because jsdom resolves no custom
 * properties, so a rendered-value assertion here would measure nothing. What it catches is the
 * thing that actually went wrong: a colour written into this component instead of taken from the
 * palette.
 */
describe("the band's colours", () => {
  it("spends no raw colour literal, so the palette can move under it", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/kit/impersonation-banner.tsx"),
      "utf8",
    );

    // Class strings only. The docstring names the old literal on purpose, to say what was wrong.
    const classValues = [...source.matchAll(/className="([^"]*)"/gu)].map((match) => match[1]);
    const literals = classValues.filter((value) =>
      /rgba?\(\s*\d|#[0-9a-fA-F]{3,8}\b|oklch\(/u.test(value),
    );

    expect(literals).toEqual([]);
  });

  it("takes its amber from the warning family, which both palettes define", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/kit/impersonation-banner.tsx"),
      "utf8",
    );

    expect(source).toContain("bg-[var(--warning-wash)]");
    expect(source).toContain("border-[var(--warning-line)]");
  });
});

/**
 * The band sits above a coach shell, so it is sized to the coach shell's floor.
 *
 * It shipped at the console's density -- a 40px exit button and 12.5px copy -- over a surface
 * whose floor is 44px and 16px with no exceptions, which made the one strip that has to be read on
 * every page of the session the smallest thing on the screen. It cannot inherit the floor: every
 * rule in `coach.css` is scoped to `[data-shell-role="coach"]` on the shell root and this renders
 * above that root, so the sizes are stated in the component and pinned here from
 * `AdminImpersonation.dc.html`.
 *
 * The assertions read the class strings rather than computed styles because jsdom applies no
 * stylesheet; what they catch is the drift that actually happened, which is a size typed into this
 * file against the wrong density.
 */
describe("the band's density", () => {
  const COACH_BODY_FLOOR = 16;
  const COACH_TARGET_FLOOR = 44;

  function classOf(selector: string) {
    render(<ImpersonationBanner {...PROPS} operator={{ name: "Dana Whitlock", role: "client success" }} />);
    const element = document.querySelector(selector);
    expect(element, `${selector} is not on the band, so nothing below was checked`).not.toBeNull();
    return (element as HTMLElement).className;
  }

  it("gives the way out a target the coach surface would accept", () => {
    const height = /h-\[(\d+(?:\.\d+)?)px\]/u.exec(classOf('[data-slot="impersonation-end"]'));
    expect(height, "the exit button no longer states a height").not.toBeNull();
    expect(Number(height![1])).toBeGreaterThanOrEqual(COACH_TARGET_FLOOR);
  });

  it("sets no type on the band under the coach surface's 16px body floor", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/kit/impersonation-banner.tsx"),
      "utf8",
    );
    const sizes = [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/gu)].map((m) => Number(m[1]));

    // The positive control: an empty match set would pass the loop while reading nothing.
    expect(sizes.length).toBeGreaterThan(2);
    for (const size of sizes) {
      expect(size, `${size}px is under the coach surface's ${COACH_BODY_FLOOR}px floor`)
        .toBeGreaterThanOrEqual(COACH_BODY_FLOOR);
    }
  });
});
