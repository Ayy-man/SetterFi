import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { MatrixCheckbox } from "@/components/kit/matrix-checkbox";

describe("MatrixCheckbox", () => {
  it("names the box by column and row without printing the column beside it", async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <MatrixCheckbox
        checked={false}
        columnLabel="Email"
        onCheckedChange={onCheckedChange}
        rowLabel="Appointment booked"
      />,
    );

    const box = screen.getByRole("checkbox", { name: "Email for Appointment booked" });
    // The column header carries the visible word; the cell does not repeat it.
    expect(screen.queryByText("Email", { selector: "label > span:not(.sr-only)" })).toBeNull();

    await user.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("marks a locked cell with a lock and a reason, not opacity alone", () => {
    render(
      <MatrixCheckbox
        checked
        columnLabel="Bell"
        locked
        lockedReason="Required notice, always on"
        onCheckedChange={() => {}}
        rowLabel="Payment failed"
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Bell for Payment failed" }))
      .toHaveAttribute("aria-disabled", "true");
    expect(document.querySelector('[data-slot="matrix-checkbox-lock"]')).not.toBeNull();
    expect(screen.getByText("Locked: Required notice, always on")).toBeInTheDocument();
  });

  it("shows the column word where there is no header row to carry it", () => {
    render(
      <MatrixCheckbox
        checked={false}
        columnLabel="Slack"
        onCheckedChange={() => {}}
        rowLabel="Payment failed"
        showColumnLabel
      />,
    );

    expect(screen.getByText("Slack")).toBeVisible();
  });
});
