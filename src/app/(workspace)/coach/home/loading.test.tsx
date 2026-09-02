import { describe, expect, it } from "vitest";

import { WINDOW_OPTIONS } from "@/components/workspace/live/coach-measurement";
import { STOP_WIDTHS } from "./loading";

/**
 * The skeleton is a promise about a control it does not import.
 *
 * `STOP_WIDTHS` is a hand-measured bone per window and `WINDOW_OPTIONS` is the list the real
 * `MeasurementPicker` maps over, so adding a window puts a stop in the picker and none in the
 * skeleton -- and the picker changes width at the moment the page settles, which is the jump the
 * bones exist to prevent. Nothing in the type system connects the two.
 *
 * The assertion reads both lengths rather than spelling the number, because a test that says `6`
 * twice still passes on the one change worth catching: a window added to the picker and the widths
 * left alone. Comparing the arrays to each other fails on exactly that.
 */
describe("coach home loading bones", () => {
  it("draws one bone per performance window the picker renders", () => {
    expect(STOP_WIDTHS.length).toBe(WINDOW_OPTIONS.length);
  });
});
