import "@testing-library/jest-dom/vitest";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  BookedMark,
  ChatIcon,
  KIT_ICON_SIZE,
  LiveMark,
  PausedMark,
  SmsMark,
  SortAscending,
  TestMark,
  VettingMark,
} from "@/components/kit/icons";

function svg(container: HTMLElement) {
  return container.querySelector("svg") as SVGSVGElement;
}

describe("kit icons", () => {
  it("draws a Phosphor glyph at the fixed 16px box in the inherited colour", () => {
    const { container } = render(<ChatIcon />);
    const glyph = svg(container);

    expect(glyph).toHaveAttribute("width", String(KIT_ICON_SIZE));
    expect(glyph).toHaveAttribute("height", String(KIT_ICON_SIZE));
    // currentColor is the whole contract: a glyph takes the colour of the row it sits in, so
    // a muted cell and an ink cell never need two different icon imports.
    expect(glyph.getAttribute("fill")).toBe("currentColor");
  });

  it("hides an unlabelled glyph from the reader and names a labelled one", () => {
    const { container: bare } = render(<SortAscending />);
    expect(svg(bare)).toHaveAttribute("aria-hidden", "true");

    const { container: named } = render(
      <SortAscending label="Sorted ascending" />,
    );
    const labelled = svg(named);
    expect(labelled).toHaveAttribute("role", "img");
    expect(labelled).toHaveAttribute("aria-label", "Sorted ascending");
  });

  it("lets a caller size a glyph up without letting it change weight or colour", () => {
    const { container } = render(<ChatIcon size={20} />);
    const glyph = svg(container);

    expect(glyph).toHaveAttribute("width", "20");
    expect(glyph.getAttribute("fill")).toBe("currentColor");
  });

  it("pins the glyph weight, so a caller cannot slip a bold icon into a regular row", () => {
    // `weight` is not in the public prop type; this is the runtime half of that guarantee.
    const forced = { weight: "bold" } as Record<string, unknown>;
    const { container: overridden } = render(<ChatIcon {...forced} />);
    const { container: plain } = render(<ChatIcon />);

    expect(svg(overridden).innerHTML).toBe(svg(plain).innerHTML);
  });

  it.each([
    ["SmsMark", SmsMark],
    ["BookedMark", BookedMark],
    ["VettingMark", VettingMark],
    ["PausedMark", PausedMark],
    ["TestMark", TestMark],
  ])(
    "draws %s on the 16px grid at 1.5 stroke with round caps",
    (_name, Mark) => {
      const { container } = render(<Mark />);
      const mark = svg(container);

      expect(mark).toHaveAttribute("viewBox", "0 0 16 16");
      expect(mark).toHaveAttribute("stroke-width", "1.5");
      expect(mark).toHaveAttribute("stroke", "currentColor");
      expect(mark).toHaveAttribute("stroke-linecap", "round");
    },
  );

  it("marks test data with a dashed ring, so a seeded row reads as seeded", () => {
    const { container } = render(<TestMark />);
    const dashed = container.querySelector("circle[stroke-dasharray]");

    expect(dashed).not.toBeNull();
    expect(dashed).toHaveAttribute("stroke-dasharray", "2.4 2.2");
  });

  it("gives the live mark a ring it can pulse and a solid centre it keeps", () => {
    const { container } = render(<LiveMark pulse />);

    expect(container.querySelector('[data-slot="live-mark"]')).not.toBeNull();
    expect(
      container.querySelector('[data-slot="live-mark-ring"]'),
    ).not.toBeNull();
    // The centre dot is filled, not stroked: it is the thing that is on, and it stays on
    // whether or not the ring is mid-pulse.
    expect(
      container.querySelector('circle[fill="currentColor"]'),
    ).not.toBeNull();
  });
});
