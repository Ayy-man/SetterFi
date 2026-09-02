import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CurrencyInput } from "@/components/kit/currency-input";

function renderCurrencyInput(onChangeCents = vi.fn()) {
  render(
    <CurrencyInput
      currency="USD"
      label="Price"
      onChangeCents={onChangeCents}
      valueCents={null}
    />,
  );

  return {
    input: screen.getByLabelText("Price"),
    onChangeCents,
  };
}

describe("CurrencyInput", () => {
  it.each([
    ["299", 29900],
    ["2,990.50", 299050],
    ["299.005", 29901],
  ])("converts %s major units with recorded rounding", async (typed, expected) => {
    const user = userEvent.setup();
    const { input, onChangeCents } = renderCurrencyInput();

    await user.type(input, typed);

    expect(onChangeCents).toHaveBeenLastCalledWith(expected);
  });

  it("emits null when cleared rather than changing an empty field to zero", async () => {
    const user = userEvent.setup();
    const onChangeCents = vi.fn();

    render(
      <CurrencyInput
        currency="USD"
        label="Amount"
        onChangeCents={onChangeCents}
        valueCents={29900}
      />,
    );

    await user.clear(screen.getByLabelText("Amount"));

    expect(onChangeCents).toHaveBeenLastCalledWith(null);
  });

  it("echoes the formatted value that will be saved", async () => {
    const user = userEvent.setup();
    const { input } = renderCurrencyInput();

    await user.type(input, "299");

    expect(screen.getByText("Saves as $299.00")).toBeVisible();
  });

  it("ignores currency symbols but does not reinterpret letters as a number", async () => {
    const user = userEvent.setup();
    const { input, onChangeCents } = renderCurrencyInput();

    await user.type(input, "$299");
    expect(onChangeCents).toHaveBeenLastCalledWith(29900);

    onChangeCents.mockClear();
    await user.clear(input);
    onChangeCents.mockClear();
    await user.type(input, "1e3");
    expect(onChangeCents).toHaveBeenCalledTimes(1);
    expect(onChangeCents).toHaveBeenLastCalledWith(100);
  });

  it("uses a human-facing price label", () => {
    renderCurrencyInput();

    expect(screen.getByText("Price", { selector: "label" })).toBeVisible();
    expect(screen.getByText("Price", { selector: "label" }).textContent).not.toMatch(
      new RegExp(",\\s*" + "ce" + "nts", "i"),
    );
  });

  it("uses the approved neutral invalid border on the currency wrapper", () => {
    render(
      <CurrencyInput
        currency="USD"
        error="Enter a valid price"
        label="Price"
        onChangeCents={vi.fn()}
        valueCents={null}
      />,
    );

    const input = screen.getByLabelText("Price");
    const wrapper = input.closest('[data-slot="input-group"]');

    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(wrapper).toHaveClass(
      "has-[[data-slot][aria-invalid=true]]:border-[var(--ink)]",
    );
    expect(wrapper?.className).not.toContain("border-destructive");
  });

  it("reflects an external value change without rewriting equivalent user formatting", async () => {
    const user = userEvent.setup();
    const onChangeCents = vi.fn();
    const { rerender } = render(
      <CurrencyInput
        currency="USD"
        label="Price"
        onChangeCents={onChangeCents}
        valueCents={null}
      />,
    );

    const input = screen.getByLabelText("Price");
    await user.type(input, "2,990.50");

    rerender(
      <CurrencyInput
        currency="USD"
        label="Price"
        onChangeCents={onChangeCents}
        valueCents={299050}
      />,
    );
    expect(input).toHaveValue("2,990.50");

    rerender(
      <CurrencyInput
        currency="USD"
        label="Price"
        onChangeCents={onChangeCents}
        valueCents={50000}
      />,
    );
    expect(input).toHaveValue("500.00");
  });
});
