import { describe, expect, it } from "vitest";

import {
  CUSTOM_STOP_LABEL,
  RANGE_STOPS,
} from "@/components/workspace/rehaul/coach-home-range";
import { HOME_BUBBLES } from "@/components/workspace/rehaul/coach-home-figures";
import { STOP_WIDTHS } from "./loading";

/**
 * The skeleton is a promise about controls it draws bones for rather than mounts.
 *
 * `STOP_WIDTHS` is a hand-measured bone per stop and `RANGE_STOPS` plus the Custom stop is what
 * the real control maps over, so adding a stop puts one in the control and none in the skeleton --
 * and the strip changes width at the moment the page settles, which is the jump the bones exist to
 * prevent. Nothing in the type system connects the two.
 *
 * The assertions read both lengths rather than spelling the number, because a test that says `6`
 * twice still passes on the one change worth catching.
 */
describe("coach home loading bones", () => {
  it("draws one bone per stop the range control renders, Custom included", () => {
    expect(CUSTOM_STOP_LABEL).toBe("Custom");
    expect(STOP_WIDTHS.length).toBe(RANGE_STOPS.length + 1);
  });

  it("reserves one panel per bubble the page lands", () => {
    // Six, and the same six: the boundary maps the exported table rather than a copy of it, so
    // this asserts the table is the shape the artboard draws rather than that two lists agree.
    expect(HOME_BUBBLES).toHaveLength(6);
    expect(HOME_BUBBLES.map((bubble) => bubble.name)).toEqual([
      "Booked calls",
      "Active leads",
      "New leads",
      "Disqualified",
      "Conversion",
      "Average time to book",
    ]);
  });
});
