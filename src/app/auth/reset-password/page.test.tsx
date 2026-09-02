import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_RESET_DONE_COOKIE } from "@/lib/auth/recovery";

const receipt: { value: string | undefined } = { value: undefined };

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === PASSWORD_RESET_DONE_COOKIE && receipt.value !== undefined ? { value: receipt.value } : undefined,
  }),
}));

const { default: ResetPasswordPage } = await import("./page");

async function renderPage(
  searchParams: { next?: string; error?: string; success?: string },
  cookie?: string,
) {
  receipt.value = cookie;
  render(await ResetPasswordPage({ searchParams: Promise.resolve(searchParams) }));
}

/** The form is what a reader gets whenever the page is not entitled to report on a change. */
function formIsShowing() {
  return screen.queryByRole("button", { name: /reset password/i }) !== null;
}

beforeEach(() => {
  receipt.value = undefined;
});

describe("/auth/reset-password", () => {
  /**
   * The claim the flow is built on, unasserted until now. All three sentences in this flow said
   * other sessions were ended while the only session call was `signOut({ scope: "local" })`, which
   * the Supabase reference defines as the current session only.
   */
  it("reports the sessions as ended only on the outcome where they were", async () => {
    await renderPage({ success: "1" }, "1");

    expect(screen.getByText(/other sessions were signed out/i)).toBeInTheDocument();
  });

  it("says the sessions may still be live rather than repeating the success sentence", async () => {
    await renderPage({ error: "sessions-live" }, "1");

    expect(screen.getByText(/your other sessions may still be signed in/i)).toBeInTheDocument();
    expect(screen.queryByText(/other sessions were signed out/i)).not.toBeInTheDocument();
    // The password did change, and refusing to say so is the same defect pointing the other way.
    expect(screen.getByText(/your password was reset/i)).toBeInTheDocument();
  });

  it("keeps the audit refusal without denying the change", async () => {
    await renderPage({ error: "not-recorded" }, "1");

    expect(screen.getByText(/could not write this to the audit log/i)).toBeInTheDocument();
    expect(screen.getByText(/your password was reset/i)).toBeInTheDocument();
    expect(screen.queryByText(/we could not reset your password/i)).not.toBeInTheDocument();
  });

  /**
   * The query string routes; the cookie authorises. Without this the page renders "Your password
   * was reset. Other sessions were signed out." to anyone who types the parameter -- a claim about
   * a write, in the past tense, on an auth surface, with nothing behind it.
   */
  it("shows the form, not a success sentence, to anyone who supplies the parameter themselves", async () => {
    await renderPage({ success: "1" });

    expect(screen.queryByText(/your password was reset/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/other sessions were signed out/i)).not.toBeInTheDocument();
    expect(formIsShowing()).toBe(true);
  });

  it("gives the same treatment to the two outcomes that also report a completed change", async () => {
    await renderPage({ error: "sessions-live" });
    expect(screen.queryByText(/your password was reset/i)).not.toBeInTheDocument();
    expect(formIsShowing()).toBe(true);
  });

  /**
   * The link is fine and the recovery session is still in the reader's cookie. Sending them for a
   * new one spends one of three throttled emails on a problem the email cannot fix -- and this is
   * reachable exactly when scripting is unavailable, the mode this form exists to serve.
   */
  it("blames the password, not the link, when the password is the thing that was refused", async () => {
    await renderPage({ error: "password-rejected" });

    // Scoped to the notice: the field's own hint also says twelve characters, and matching that
    // instead would let this pass with no notice rendered at all.
    const notice = screen.getByRole("alert").textContent ?? "";
    expect(notice).toMatch(/at least twelve characters/i);
    expect(notice).toMatch(/this link\s+is still good/i);
    expect(notice).not.toMatch(/request a new link/i);
    expect(formIsShowing()).toBe(true);
  });

  it("still sends the reader for a new link when nothing was changed", async () => {
    await renderPage({ error: "reset-failed" });

    expect(screen.getByText(/we could not reset your password/i)).toBeInTheDocument();
    expect(screen.getByText(/request a new link/i)).toBeInTheDocument();
  });

  it("names an expired link as expired", async () => {
    await renderPage({ error: "invalid-link" });

    expect(screen.getByText(/invalid or has expired/i)).toBeInTheDocument();
    expect(formIsShowing()).toBe(true);
  });
});
