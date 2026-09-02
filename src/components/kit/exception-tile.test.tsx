import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ExceptionTile } from "@/components/kit/exception-tile";

describe("ExceptionTile", () => {
  it("stands at its own density, between a stat tile and a table row", () => {
    render(
      <ExceptionTile
        count={3}
        href="/coach/measurement#stalled"
        note="Review"
        title="Stalled conversations"
        tone="warning"
      />,
    );

    const tile = document.querySelector('[data-slot="exception-tile"]') as HTMLElement;
    // Looser than the table row it sits above, tighter than the stat tile it sits below.
    expect(tile).toHaveClass("px-[var(--s-4)]", "py-[var(--s-3)]");
    // The title and its note are two lines, not one wrapped sentence with a bold opening.
    expect(tile).toHaveClass("gap-y-[var(--s-1)]");
  });

  it("says nothing needs a person rather than showing a bare zero", () => {
    // Handed the loudest tone the page can pass, so the override is what the assertion sees.
    render(
      <ExceptionTile
        count={0}
        href="/coach/measurement"
        title="Stalled conversations"
        tone="critical"
      />,
    );

    const tile = document.querySelector('[data-slot="exception-tile"]') as HTMLElement;
    // An empty queue is good news and reads neutral: the count keeps no tone of its own.
    expect(tile).toHaveAttribute("data-tone", "neutral");
    expect(screen.getByText("Nothing needs you")).toBeVisible();
  });
});
