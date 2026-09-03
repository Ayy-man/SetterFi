import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONTEXT_EYE_SCREENS,
  ContextEye,
  contextEyeStorageKey,
} from "@/components/workspace/rehaul/context-eye";

const COPY =
  "Rows sort by how long they have waited. A lead handoff leaves the list the moment the coach takes it over.";

function eyeButton() {
  return screen.getByRole("button", { name: "About this screen" });
}

describe("ContextEye", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
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

  it("hides the eye for this screen and records it in sessionStorage", async () => {
    const user = userEvent.setup();
    render(<ContextEye copy={COPY} screen="eye-hide" />);

    await user.click(eyeButton());
    await user.click(screen.getByRole("button", { name: "Hide for now" }));

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });
    expect(window.sessionStorage.getItem(contextEyeStorageKey("eye-hide"))).toBe(
      "1",
    );
  });

  it("stays hidden on a later mount of the same screen, and only that screen", async () => {
    window.sessionStorage.setItem(contextEyeStorageKey("eye-stored"), "1");

    const { unmount } = render(<ContextEye copy={COPY} screen="eye-stored" />);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });
    unmount();

    render(<ContextEye copy={COPY} screen="eye-stored-sibling" />);
    expect(eyeButton()).toBeInTheDocument();
  });

  it("renders the eye rather than throwing when sessionStorage is unavailable", async () => {
    const user = userEvent.setup();
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("storage blocked");
    });

    render(<ContextEye copy={COPY} screen="eye-throws" />);
    expect(eyeButton()).toBeInTheDocument();

    // Hiding still works for this visit; it just cannot be remembered.
    await user.click(eyeButton());
    await user.click(screen.getByRole("button", { name: "Hide for now" }));
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "About this screen" }),
      ).not.toBeInTheDocument();
    });
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

  it("leaves the shared screen list empty for others to extend", () => {
    expect(CONTEXT_EYE_SCREENS).toEqual([]);
  });
});
