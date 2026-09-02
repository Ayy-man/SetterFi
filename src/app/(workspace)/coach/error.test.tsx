import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import CoachError from "@/app/(workspace)/coach/error";

/*
 * The error boundary is the one coach screen with no page header above it, which is what made its
 * heading level wrong and what makes it worth pinning.
 *
 * `DeckPanel` names itself with an `h2` by default, correctly: everywhere else a panel is one
 * region among several under a title that already owns the `h1`. Here the panel is the whole page,
 * so the document opened at level two and had no top-level heading at all -- a screen reader's
 * heading list started midway down an outline with no top, and the "jump to the main heading"
 * gesture reached nothing on the screen a coach lands on when everything else has failed.
 * `CoachError.dc.html` draws it as an `<h1>`.
 *
 * The size is the other half, and this docstring used to wave it away: "the size is unchanged and
 * is not this test's business -- `coach.css` styles `.coach-panel__name` by class, so both levels
 * render identically". Both halves of that were true and the conclusion was wrong. The class does
 * style the heading, at 20px/500/-0.015em, and `CoachError.dc.html:102` draws it at 26px/600 --
 * so "identically" meant identically wrong at both levels, and the page rendered six pixels short
 * for four rounds because the only thing watching this heading had written the size off.
 *
 * It is watched now, and the expectation is parsed out of the artboard rather than typed here.
 * The defect was a callsite that failed to ask for the drawn size while every guard around it
 * passed, so what has to be asserted is this page's rendered heading against this page's drawing.
 */
describe("coach error boundary", () => {
  const reset = vi.fn();

  beforeEach(() => {
    // The boundary logs the error it was handed; without this the suite prints a real stack.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderBoundary(error: Error & { digest?: string }) {
    return render(<CoachError error={error} reset={reset} />);
  }

  it("opens the document at level one", () => {
    const { container } = renderBoundary(new Error("segment threw"));

    const heading = screen.getByRole("heading", { level: 1, name: "Something on our side broke" });
    expect(heading.tagName).toBe("H1");
    expect(heading).toHaveClass("coach-panel__name");

    // And it is the ONLY level-one heading, which is the half of the outline rule a second,
    // visually-hidden heading would have broken while still passing the assertion above.
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });

  it("draws that heading at the size, weight and tracking CoachError.dc.html:102 draws", () => {
    // CoachError.dc.html:102, recorded verbatim on 2026-09-02. The artboards are not part of this
    // repository, so the line is carried here and parsed exactly as the drawing was.
    const artboard =
      '<h1 style="margin: 0; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.15; color: var(--ink);">Something on our side broke</h1>';
    // Read the premise before comparing against it: if the citation moves, these come back
    // undefined and the assertions below would be comparing the heading against nothing.
    expect(artboard, "CoachError.dc.html:102 is no longer the h1 -- find the line again")
      .toContain("<h1");
    const drawn = (property: string) => {
      const value = new RegExp(`${property}:\\s*([^;]+);`).exec(artboard)?.[1].trim();
      expect(value, `${property} is gone from CoachError.dc.html:102`).toBeDefined();
      return value!;
    };

    renderBoundary(new Error("segment threw"));
    const { className } = screen.getByRole("heading", { level: 1 });

    expect(className, `drawn at ${drawn("font-size")}`).toContain(`text-[${drawn("font-size")}]!`);
    expect(className, `drawn at ${drawn("font-weight")}`).toContain(`font-[${drawn("font-weight")}]!`);
    expect(className, `drawn at ${drawn("letter-spacing")}`)
      .toContain(`tracking-[${drawn("letter-spacing")}]!`);
  });

  /**
   * The panel's accessible name has to be the heading, not a duplicate of it. `headingId` wires
   * `aria-labelledby` to the same node, so moving the level must not orphan the reference.
   */
  it("keeps the panel labelled by the heading it just changed the level of", () => {
    const { container } = renderBoundary(new Error("segment threw"));

    const section = container.querySelector("section.coach-panel");
    const labelledBy = section?.getAttribute("aria-labelledby");
    expect(labelledBy).toBe("coach-error-title");
    expect(container.querySelector(`#${labelledBy}`)?.tagName).toBe("H1");
  });

  /**
   * The claim the screen exists to make, and the one it must not make.
   *
   * A React segment that threw while drawing a chart says nothing about whether the setter is
   * still answering DMs -- it runs in the webhook path on the server. The digest is the only
   * identifier that exists; a client-side throw has none, and the fallback names the failure class
   * rather than inventing a reference number that matches nothing in any log.
   */
  it("says the dashboard broke and the agent did not, and prints the digest support can look up", () => {
    renderBoundary(Object.assign(new Error("segment threw"), { digest: "SF-7K42-DQ91" }));

    expect(screen.getByText(/Your agent is still answering leads/u)).toBeInTheDocument();
    expect(screen.getByText("SF-7K42-DQ91")).toBeInTheDocument();
  });
});
