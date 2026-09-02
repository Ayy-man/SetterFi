import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LoggedButton } from "@/components/kit/logged-button";
import { AUDIT_ACTIONS } from "@/lib/audit/actions";

describe("LoggedButton", () => {
  it("keeps the audit microcopy out of the button name", () => {
    render(
      <LoggedButton actionKey="brain.published" variant="primary">
        Publish to all agents
      </LoggedButton>,
    );

    const button = screen.getByRole("button", { name: "Publish to all agents" });
    const caption = screen.getByText(AUDIT_ACTIONS["brain.published"].microcopy);
    expect(caption).toBeVisible();
    expect(button).not.toContainElement(caption);
    expect(caption.closest('[data-slot="logged-button"]')).toContainElement(button);
  });
});
