import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RehaulLoginForm } from "@/components/workspace/rehaul/login-form";
import { RehaulSignupForm } from "@/components/workspace/rehaul/signup-form";

/**
 * The two entry cards, drawn from `Login.body.html` and `Signup.body.html`.
 *
 * Each assertion is in one of three groups: the artboard's heading and its one live action, the
 * fields the server action still needs, and the help text the rehaul removes. That third group is
 * the one worth keeping honest -- a skin that quietly re-grows an explainer under every label is
 * the failure this rehaul is against, and an absence only means something once the positive
 * control above it has passed.
 */

afterEach(cleanup);

describe("the rehaul sign-in card", () => {
  const submit = async () => {};

  it("draws the artboard's heading, both fields and the one submit", () => {
    render(
      <RehaulLoginForm
        demoAccounts={[]}
        next={null}
        session={null}
        setupAccess={null}
        signupOpen
        submit={submit}
        unattached={null}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Email/)).toHaveAttribute("name", "email");
    expect(screen.getByLabelText(/^Password/)).toHaveAttribute("name", "password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "I forgot my password" }))
      .toHaveAttribute("href", "/auth/forgot-password");
  });

  it("offers the quiet way across to signup, and keeps the demo strip wordless", () => {
    render(
      <RehaulLoginForm
        demoAccounts={[{ email: "coach@example.com", label: "Coach", password: "x", role: "coach" }]}
        next="/coach"
        session={null}
        setupAccess={null}
        signupOpen
        submit={submit}
        unattached={null}
      />,
    );

    expect(screen.getByRole("link", { name: "Start with SetterFi" })).toHaveAttribute("href", "/signup");
    expect(screen.getByRole("button", { name: "Coach" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Review accounts only");
    // The redirect the action round-trips is still on the form the flag now draws.
    expect(document.querySelector('input[name="next"]')).toHaveAttribute("value", "/coach");
  });

  it("says the sign-in failed in the same words, above the card", () => {
    render(
      <RehaulLoginForm
        demoAccounts={[]}
        error="1"
        next={null}
        session={null}
        setupAccess={null}
        signupOpen={false}
        submit={submit}
        unattached={null}
      />,
    );

    expect(screen.getByRole("alert").textContent).toContain("We could not sign you in");
    expect(screen.queryByRole("link", { name: "Start with SetterFi" })).toBeNull();
  });
});

describe("the rehaul signup card", () => {
  const tiers = [
    { callAllowance: 10, id: "tier-starter", label: "Starter" },
    { callAllowance: 30, id: "tier-growth", label: "Growth" },
    { id: "tier-scale", label: "Scale" },
  ];

  it("draws the plan chips as names, with nothing preselected", async () => {
    render(<RehaulSignupForm enabled referralCode={null} terms={null} tiers={tiers} />);

    expect(screen.getByRole("heading", { level: 1, name: "Start with SetterFi" })).toBeInTheDocument();
    for (const name of ["Starter", "Growth", "Scale"]) {
      expect(screen.getByRole("radio", { name })).not.toBeChecked();
    }
    // Names only: the allowance and the price both belong where the plan is charged.
    expect(document.body.textContent).not.toContain("booked calls included");
    expect(screen.getByRole("button", { name: "Create my account" })).toBeDisabled();
  });

  it("keeps every field the signup route reads, and drops the page's help text", async () => {
    render(<RehaulSignupForm enabled referralCode="ORBIT-9" terms={null} tiers={tiers} />);

    for (const name of ["fullName", "businessName", "email", "password", "slug", "timezone", "referralCode"]) {
      expect(document.querySelector(`[name="${name}"]`)).not.toBeNull();
    }
    expect(document.querySelector('[name="referralCode"]')).toHaveValue("ORBIT-9");
    expect(document.querySelector('[name="password"]')).toHaveAttribute("minlength", "8");

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Use at least eight characters");
    expect(text).not.toContain("Lowercase letters, numbers, and hyphens");
    expect(text).not.toContain("This is the clock your reports use");
    expect(text).not.toContain("Text messaging takes about");
  });

  it("stays shut, in the old words, when no named plan is published", () => {
    render(<RehaulSignupForm enabled referralCode={null} terms={null} tiers={[]} />);

    expect(screen.getByRole("heading", { level: 1, name: "Account setup is not available yet" }))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("No named plan is available");
  });

  it("holds the submit until the published terms are accepted", async () => {
    const { rerender } = render(
      <RehaulSignupForm
        enabled
        referralCode={null}
        terms={{ privacyBody: "Privacy.", termsBody: "Terms.", versionKey: "2026-09-01" }}
        tiers={tiers}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /terms of service/ })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Create my account" })).toBeDisabled();
    expect(document.body.textContent).toContain("Version 2026-09-01");
    rerender(<RehaulSignupForm enabled referralCode={null} terms={null} tiers={tiers} />);
    expect(screen.queryByRole("checkbox", { name: /terms of service/ })).toBeNull();
  });
});

// `useFormStatus` needs no router, but the signup form's siblings import one through the kit.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
