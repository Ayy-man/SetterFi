import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DateField } from "@/components/kit/date-field";
import { Field } from "@/components/kit/field";
import { Input } from "@/components/ui/input";
import { workspaceDateFormat } from "@/lib/format/datetime";

describe("Field", () => {
  it("labels the control and describes it with the hint when there is no error", () => {
    render(
      <Field hint="Use the public plan name" label="Plan name">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText("Plan name");
    const hint = screen.getByText("Use the public plan name");

    expect(input).toHaveAttribute("aria-describedby", hint.id);
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("describes the control with its field-specific error", () => {
    render(
      <Field error="Enter a plan name" hint="Use the public plan name" label="Plan name">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText("Plan name");
    const error = screen.getByRole("alert");

    expect(input).toHaveAttribute("aria-describedby", error.id);
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("uses one workspace calendar day for display, bounds, and selection", () => {
    const onChange = vi.fn();
    const instant = new Date("2026-09-01T00:00:00.000Z");

    render(
      <DateField
        label="Start date"
        max={new Date("2026-09-02T00:00:00.000Z")}
        min={instant}
        onChange={onChange}
        value={instant}
      />,
    );

    const input = screen.getByLabelText("Start date");
    expect(input).toHaveValue("2026-08-31");
    expect(input).toHaveAttribute("min", "2026-08-31");
    expect(input).toHaveAttribute("max", "2026-09-01");
    expect(input).toHaveAttribute("title", "Aug 31, 2026");

    fireEvent.change(input, { target: { value: "2026-09-01" } });

    expect(onChange).toHaveBeenCalledOnce();
    expect(workspaceDateFormat.format(onChange.mock.calls[0][0])).toBe("Sep 1, 2026");
  });
});
