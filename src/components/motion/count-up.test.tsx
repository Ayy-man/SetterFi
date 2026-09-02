// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { animate } = vi.hoisted(() => ({
  animate: vi.fn(
    (
      _from: number,
      to: number,
      options: { onUpdate?: (value: number) => void },
    ) => {
      window.requestAnimationFrame(() => options.onUpdate?.(to / 3));
      window.requestAnimationFrame(() => options.onUpdate?.((to * 2) / 3));
      window.requestAnimationFrame(() => options.onUpdate?.(to));
      return { stop: vi.fn() };
    },
  ),
}));

vi.mock("motion/react", async () => {
  const React = await import("react");

  return {
    animate,
    motion: {
      div: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
        function MotionDiv({ children, ...props }, ref) {
          return <div {...props} ref={ref}>{children}</div>;
        },
      ),
    },
    useInView: () => true,
    useReducedMotion: () => false,
  };
});

import { CountUp } from "./index";

function nextFrame() {
  return act(() => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve())));
}

afterEach(() => {
  cleanup();
  animate.mockClear();
});

describe("CountUp", () => {
  it("renders a string verbatim without animating it across three frames", async () => {
    render(<CountUp value="Still filling" />);

    for (let frame = 0; frame < 3; frame += 1) {
      await nextFrame();
      expect(screen.getByText("Still filling").textContent).toBe("Still filling");
    }
    expect(animate).not.toHaveBeenCalled();
  });

  it("finishes a numeric count at its value", async () => {
    render(<CountUp value={41} />);

    await nextFrame();
    await nextFrame();
    await nextFrame();

    expect(screen.getByText("41").textContent).toBe("41");
  });
});
