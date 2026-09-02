import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";

test("provides the jsdom component harness", () => {
  render(<div>ok</div>);

  expect(screen.getByText("ok")).toBeInTheDocument();
  expect(typeof window).toBe("object");
  expect(window.matchMedia("(min-width: 1px)").matches).toBe(false);
});
