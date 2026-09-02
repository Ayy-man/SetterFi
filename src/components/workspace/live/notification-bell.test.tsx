import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NotificationBell } from "./notification-bell";

vi.mock("./notification-view-models", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./notification-view-models")>();
  return {
    ...actual,
    EMPTY_NOTIFICATION_STATE: {
      status: "ready",
      notifications: [
        {
          id: "notification-1",
          kind: "delivery",
          title: "Delivery issue",
          body: "One text message needs attention.",
          link: "/admin/channel-health",
          isTest: true,
          readAt: null,
          createdAt: "created",
          deliveryLabel: "Failed",
        },
      ],
      lastSuccessAt: 1,
      errorCount: 0,
    },
    executeNotificationPollDecision: vi.fn(() => undefined),
  };
});

describe("NotificationBell", () => {
  it("opens the token-backed popover and pairs the unread dot with text", async () => {
    const user = userEvent.setup();
    render(<NotificationBell enabled role="admin" />);

    const trigger = screen.getByRole("button", {
      name: "Platform alerts, 1 unread",
    });
    expect(within(trigger).getByText("1 unread")).toHaveClass("sr-only");

    await user.click(trigger);

    // The seeded-row marker is its own element, not a prefix on the title. Asserting them
    // separately is what makes the label impossible to satisfy by re-wording the title.
    expect(await screen.findByText("Delivery issue")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Delivery issue" }))
      .toHaveAttribute("href", "/admin/channel-health");
    expect(screen.getByText("Test")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage notifications" }),
    ).toHaveAttribute("href", "/admin/alerts");

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByText("Delivery issue")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
  });

  it("draws the bell at the kit's one icon size, from the kit's own set", () => {
    render(<NotificationBell enabled role="admin" />);

    const glyph = screen
      .getByRole("button", { name: "Platform alerts, 1 unread" })
      .querySelector("svg");
    expect(glyph).not.toBeNull();
    // Phosphor regular at 16, which is what every glyph in the product is: a bell drawn at some
    // other size beside a 16px row of controls is the mixed-icon-set look this pass removed.
    expect(glyph).toHaveAttribute("width", "16");
    expect(glyph).toHaveAttribute("height", "16");
  });

  it("keeps disabled coach alerts honest and links to coach preferences", async () => {
    const user = userEvent.setup();
    render(<NotificationBell enabled={false} role="coach" />);

    await user.click(
      screen.getByRole("button", { name: "Coach alerts, 1 unread" }),
    );

    expect(
      await screen.findByText("Alert preferences are not enabled"),
    ).toBeInTheDocument();
    expect(screen.getByText("Not enabled")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Manage notifications" }),
    ).toHaveAttribute("href", "/coach/settings#notifications");
  });
});
