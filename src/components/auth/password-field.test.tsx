import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PasswordField } from "@/components/auth/password-field";

describe("PasswordField", () => {
  it("starts hidden, so a password is never on screen by default", () => {
    render(<PasswordField autoComplete="current-password" />);
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Show password" })).toBeVisible();
  });

  it("shows the password, and says so in words rather than by swapping a glyph", () => {
    render(<PasswordField autoComplete="current-password" />);

    const toggle = screen.getByRole("button", { name: "Show password" });
    // The word, not an icon: this side of the product is built for readers who found the
    // console's iconography confusing, and the eye's two states differ by a small slash.
    expect(toggle).toHaveTextContent("Show");

    fireEvent.click(toggle);
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveTextContent("Hide");
  });

  it("hides it again on a second press", () => {
    render(<PasswordField autoComplete="current-password" />);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide password" }));
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute("type", "password");
  });

  it("announces the change for anyone not watching the button they pressed", () => {
    const view = render(<PasswordField autoComplete="current-password" />);
    const live = () => view.container.querySelector('[aria-live="polite"]');
    expect(live()).toHaveTextContent("Password is hidden");
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(live()).toHaveTextContent("Password is showing");
  });

  it("keeps the reveal out of the submitted form", () => {
    render(<PasswordField autoComplete="new-password" minLength={8} />);
    const toggle = screen.getByRole("button", { name: "Show password" });
    // A bare button inside a form submits it. Anything but type="button" would send the signup
    // form the moment a coach tried to check what they had typed.
    expect(toggle).toHaveAttribute("type", "button");
    expect(toggle).not.toHaveAttribute("name");
  });

  it("keeps the field's own requirements when it is revealed", () => {
    render(<PasswordField autoComplete="new-password" minLength={8} />);
    fireEvent.click(screen.getByRole("button", { name: "Show password" }));
    const input = screen.getByLabelText(/^Password/);
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("minlength", "8");
    expect(input).toHaveAttribute("autocomplete", "new-password");
  });
});
