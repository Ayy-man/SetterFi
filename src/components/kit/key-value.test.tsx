import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KeyValue } from "@/components/kit/key-value";

describe("KeyValue", () => {
  it("keeps adjacent labels and values separated in text content", () => {
    render(
      <dl data-testid="details">
        <KeyValue label="Agent status" value="Active" />
        <KeyValue label="Last lead message" value="Aug 17" />
      </dl>,
    );

    const details = screen.getByTestId("details");
    expect(details.textContent).toMatch(/Agent status\s+Active\s+Last lead message\s+Aug 17/);
    expect(details.textContent).not.toContain("ActiveLast");
    expect(details.querySelectorAll("dt")).toHaveLength(2);
    expect(details.querySelectorAll("dd")).toHaveLength(2);
  });

  it("uses an element with CSS styling as the inline separator", () => {
    render(
      <dl>
        <KeyValue label="Saved timezone" value="America/Chicago" />
      </dl>,
    );

    const separator = document.querySelector('[data-slot="key-value-separator"]');
    expect(separator).toBeInstanceOf(HTMLSpanElement);
    expect(separator).toHaveTextContent("");
  });
});
