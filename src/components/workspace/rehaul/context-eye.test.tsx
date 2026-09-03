import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_EYE_SCREENS,
  ContextEye,
  resetContextEyeHides,
} from "@/components/workspace/rehaul/context-eye";

const COPY =
  "Rows sort by how long they have waited. A lead handoff leaves the list the moment the coach takes it over.";

function eyeButton() {
  return screen.getByRole("button", { name: "About this screen" });
}

describe("ContextEye", () => {
  beforeEach(() => {
    resetContextEyeHides();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a closed eye whose copy is nowhere in the DOM until it is opened", () => {
    render(<ContextEye copy={COPY} screen="owner-inbox" />);

    expect(eyeButton()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(COPY)).not.toBeInTheDocument();
    expect(screen.queryByText("About this screen")).not.toBeInTheDocument();
  });

  it("opens a panel carrying the heading, the copy and the review-only caption", async () => {
    const user = userEvent.setup();
    render(<ContextEye copy={COPY} screen="owner-inbox" />);

    await user.click(eyeButton());

    const panel = await screen.findByRole("dialog");
    expect(panel).toHaveAccessibleName("About this screen");
    expect(panel).toHaveTextContent(COPY);
    expect(panel).toHaveTextContent("review only");
    expect(eyeButton()).toHaveAttribute("aria-expanded", "true");
    expect(eyeButton()).toHaveAttribute("aria-controls", panel.id);
  });

  it("closes on Escape and returns focus to the button", async () => {
    const user = userEvent.setup();
    render(<ContextEye copy={COPY} screen="owner-inbox" />);

    await user.click(eyeButton());
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(eyeButton()).toHaveFocus();
    expect(eyeButton()).toHaveAttribute("aria-expanded", "false");
  });

  it("hides the eye for this screen, and only that screen, for the rest of the visit", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ContextEye copy={COPY} screen="eye-hide" />);

    await user.click(eyeButton());
    await user.click(screen.getByRole("button", { name: "Hide for now" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });
    unmount();

    // A client-side navigation back to the same screen keeps it hidden.
    const again = render(<ContextEye copy={COPY} screen="eye-hide" />);
    expect(
      screen.queryByRole("button", { name: "About this screen" }),
    ).not.toBeInTheDocument();
    again.unmount();

    render(<ContextEye copy={COPY} screen="eye-hide-sibling" />);
    expect(eyeButton()).toBeInTheDocument();
  });

  it("writes no browser storage, so a refresh brings the eye back", async () => {
    const user = userEvent.setup();
    const setSession = vi.spyOn(window.sessionStorage, "setItem");

    const { unmount } = render(<ContextEye copy={COPY} screen="eye-refresh" />);
    await user.click(eyeButton());
    await user.click(screen.getByRole("button", { name: "Hide for now" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });

    expect(setSession).not.toHaveBeenCalled();
    unmount();

    // A reload re-evaluates the module, which is the whole of the hide.
    resetContextEyeHides();
    render(<ContextEye copy={COPY} screen="eye-refresh" />);
    expect(eyeButton()).toBeInTheDocument();
  });

  it("pins itself to the page container by default and to the viewport on request", () => {
    const { container, unmount } = render(
      <ContextEye copy={COPY} screen="owner-inbox" />,
    );
    const root = container.querySelector<HTMLElement>('[data-slot="context-eye"]');
    expect(root?.className).toContain("absolute");
    expect(root?.className).not.toContain("fixed");
    unmount();

    const second = render(
      <ContextEye copy={COPY} position="fixed" screen="owner-inbox" />,
    );
    const fixedRoot = second.container.querySelector<HTMLElement>(
      '[data-slot="context-eye"]',
    );
    expect(fixedRoot?.className).toContain("fixed");
  });

  it("disables its transitions under prefers-reduced-motion", async () => {
    const user = userEvent.setup();
    render(<ContextEye copy={COPY} screen="owner-inbox" />);

    expect(eyeButton().className).toContain("motion-reduce:transition-none");

    await user.click(eyeButton());
    const panel = await screen.findByRole("dialog");
    expect(panel.className).toContain("motion-reduce:transition-none");
    expect(panel.className).toContain("motion-reduce:transform-none");
  });

  describe('placement="header"', () => {
    it("renders an inline 32px control instead of the floating bottom-right one", () => {
      const { container } = render(
        <ContextEye copy={COPY} placement="header" screen="owner-inbox" />,
      );

      const root = container.querySelector<HTMLElement>('[data-slot="context-eye"]');
      expect(root).toHaveAttribute("data-placement", "header");
      expect(root?.className).toContain("inline-flex");
      // The floating corner is what the header placement exists to leave, so none of it survives.
      expect(root?.className).not.toContain("absolute");
      expect(root?.className).not.toContain("fixed");
      expect(root?.className).not.toContain("bottom-6");

      expect(eyeButton().className).toContain("size-8");
      expect(eyeButton().className).not.toContain("rounded-full");
    });

    it("wears the coach control size when the screen it docks into runs one", () => {
      const { container } = render(
        <ContextEye copy={COPY} placement="header" scale="coach" screen="coach-leads" />,
      );

      expect(container.querySelector('[data-slot="context-eye"]')).toHaveAttribute(
        "data-scale",
        "coach",
      );
      expect(eyeButton().className).toContain("size-[46px]");
      expect(eyeButton().className).not.toContain("size-8");
    });

    it("keeps the amber unread dot on the docked button", () => {
      const { container } = render(
        <ContextEye copy={COPY} placement="header" screen="owner-inbox" />,
      );

      const dot = eyeButton().querySelector<HTMLElement>("span[aria-hidden]");
      expect(dot?.className).toContain("bg-[var(--warning)]");
      // Top-right of the control rather than inside it, which is where a 32px button has room.
      expect(dot?.className).toContain("-top-1");
      expect(container.querySelectorAll("span[aria-hidden]")).toHaveLength(1);
    });

    it("opens the panel downward from the header rather than upward from the corner", async () => {
      const user = userEvent.setup();
      const { container } = render(
        <ContextEye copy={COPY} placement="header" screen="owner-inbox" />,
      );

      await user.click(eyeButton());

      const panel = await screen.findByRole("dialog");
      expect(panel).toHaveTextContent(COPY);
      expect(panel.className).toContain("top-full");
      expect(panel.className).toContain("origin-top-right");
      expect(panel.className).not.toContain("bottom-[68px]");

      const arrow = container.querySelector<HTMLElement>(
        '[data-slot="context-eye-panel"] > [aria-hidden="true"]:last-child',
      );
      expect(arrow?.className).toContain("-top-2");
    });

    it("still hides for the rest of the visit from the docked control", async () => {
      const user = userEvent.setup();
      const { unmount } = render(
        <ContextEye copy={COPY} placement="header" screen="eye-header-hide" />,
      );

      await user.click(eyeButton());
      await user.click(screen.getByRole("button", { name: "Hide for now" }));

      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: "About this screen" }),
        ).not.toBeInTheDocument();
      });
      unmount();

      render(<ContextEye copy={COPY} placement="header" screen="eye-header-hide" />);
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });
  });

  it("leaves the shared screen list empty for others to extend", () => {
    expect(CONTEXT_EYE_SCREENS).toEqual([]);
  });
});
