import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { CoachScale } from "@/components/coach-scale";
import {
  CoachContextEyeSurface,
  ContextEye,
  resetContextEyeHides,
} from "@/components/workspace/rehaul/context-eye";

/*
 * One component, one behaviour per surface.
 *
 * The 2026-09-04 coach visual audit measured four behaviours for `ContextEye` across eleven coach
 * screens: header at coach scale on six, header at *owner* scale on conversations, floating on
 * help and on all five onboarding sub-routes, and absent on the onboarding root. None of those is
 * a bug anybody wrote; it is what a per-callsite prop with one global default does across three
 * lanes. The surface now carries the default and the callsite only overrides it.
 *
 * The console half of the assertion matters as much as the coach half. Nothing on the owner
 * console renders the provider, so its eleven callsites keep the 32px floating control they were
 * drawn at, and a regression that moved them would fail here rather than in a screenshot.
 */

const COPY = "What this screen is for.";

afterEach(() => {
  resetContextEyeHides();
});

function eyeRoot(): HTMLElement {
  return screen.getByRole("button", { name: "About this screen" }).closest("[data-slot=context-eye]")!;
}

describe("the surface decides the eye's placement and scale", () => {
  it("floats at the console's density with no surface around it", () => {
    render(<ContextEye copy={COPY} screen="owner-thing" />);

    expect(eyeRoot().dataset.placement).toBe("floating");
    expect(eyeRoot().dataset.scale).toBeUndefined();
    expect(screen.getByRole("button", { name: "About this screen" }).className).toContain("size-11");
  });

  it("takes the header at the coach's density under the coach shell's surface", () => {
    render(
      <CoachContextEyeSurface>
        <ContextEye copy={COPY} screen="coach-thing" />
      </CoachContextEyeSurface>,
    );

    expect(eyeRoot().dataset.placement).toBe("header");
    expect(eyeRoot().dataset.scale).toBe("coach");
    // 46px is the height of the Export button it stands beside on a coach surface.
    expect(screen.getByRole("button", { name: "About this screen" }).className).toContain("size-[46px]");
  });

  it("takes the same default under CoachScale, which is what onboarding renders", () => {
    // Onboarding and the auth surfaces never mount an `AppShell`, so `CoachScale` is where they
    // pick up the coach language. The eye has to travel with it or the two halves of the coach
    // density disagree on five sub-routes.
    render(
      <CoachScale>
        <ContextEye copy={COPY} screen="onboarding-thing" />
      </CoachScale>,
    );

    expect(eyeRoot().dataset.placement).toBe("header");
    expect(eyeRoot().dataset.scale).toBe("coach");
  });

  it("still lets a callsite override the surface", () => {
    render(
      <CoachContextEyeSurface>
        <ContextEye copy={COPY} placement="floating" screen="coach-override" />
      </CoachContextEyeSurface>,
    );

    expect(eyeRoot().dataset.placement).toBe("floating");
  });

  it("opens the panel downward from a header eye, so it cannot cover the row it docks to", async () => {
    const user = userEvent.setup();
    render(
      <CoachContextEyeSurface>
        <ContextEye copy={COPY} screen="coach-open" />
      </CoachContextEyeSurface>,
    );

    await user.click(screen.getByRole("button", { name: "About this screen" }));
    const panel = screen.getByRole("dialog");

    // The placement is not only where the button sits: the popover's origin follows it, and a
    // header eye that opened upward would cover the control row it is docked to.
    expect(panel.className).toContain("top-full");
    expect(panel.className).toContain("origin-top-right");
  });
});
