import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PASSWORD_RESET_DONE_COOKIE } from "@/lib/auth/recovery";

const receipt: { value: string | undefined } = { value: undefined };

/**
 * The recovery session the page reads before it draws a form. It is stubbed rather than mocked away
 * because the presence of it is now what decides which of two pages a reader gets, and the tests
 * below that are about the receipt states would otherwise be asserting against the signed-out page.
 */
const session: { claims: unknown; error: unknown; throws: boolean } = {
  claims: { sub: "recovery-user" },
  error: null,
  throws: false,
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => {
    if (session.throws) throw new Error("SUPABASE_UNREACHABLE");
    return { auth: { getClaims: async () => ({ data: session.claims ? { claims: session.claims } : null, error: session.error }) } };
  },
}));

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
  session.claims = { sub: "recovery-user" };
  session.error = null;
  session.throws = false;
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

  /**
   * The other half of "the query string routes, the credential authorises".
   *
   * `/auth/recovery` spends the emailed `code` or `token_hash` on a session and redirects here with
   * nothing but `next`, so this page has never had a token to read and its form was drawn for
   * everybody -- somebody who typed the path, somebody on a tab from yesterday, somebody whose link
   * had already been spent. All three got a password box that could only fail on submit, which is
   * the same shape of dishonesty as the success sentence above: a surface offering an action it
   * cannot perform.
   */
  describe("without a recovery session", () => {
    it("sends the reader to the email rather than drawing a form it cannot post", async () => {
      session.claims = null;
      await renderPage({});

      expect(formIsShowing()).toBe(false);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/open this from your email link/i);
      expect(screen.getByRole("link", { name: /request a reset link/i }))
        .toHaveAttribute("href", "/auth/forgot-password");
    });

    it("still names an expired link as expired, above the instruction to ask for another", async () => {
      session.claims = null;
      await renderPage({ error: "invalid-link" });

      expect(screen.getByRole("alert").textContent).toMatch(/invalid or has expired/i);
      expect(formIsShowing()).toBe(false);
    });

    it("claims no change was made, because none was", async () => {
      session.claims = null;
      await renderPage({ success: "1" });

      expect(screen.queryByText(/your password was reset/i)).not.toBeInTheDocument();
      expect(screen.getByText(/no password was changed/i)).toBeInTheDocument();
    });

    it.each([
      ["the read reports an error", () => { session.error = { message: "unavailable" }; }],
      ["the client cannot be built at all", () => { session.throws = true; }],
    ])("refuses the form when %s, the way the complete route refuses the post", async (_name, break_) => {
      break_();
      await renderPage({});

      expect(formIsShowing()).toBe(false);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/open this from your email link/i);
    });

    /**
     * The positive control. A page that drew the signed-out state unconditionally would satisfy
     * every assertion above, and the receipt tests would be the only thing left holding the form on
     * screen at all.
     */
    it("still draws the form for a reader who does hold one", async () => {
      await renderPage({});

      expect(formIsShowing()).toBe(true);
      expect(screen.queryByText(/open this from your email link/i)).not.toBeInTheDocument();
    });

    /**
     * The receipt outranks the session, and it has to: the complete route signs the reader out
     * before redirecting, so the reader who just changed their password holds no session by the
     * time this page renders. Ordering these the other way would replace "your password was reset"
     * with "open this from your email link" at exactly the moment it had been.
     */
    it("keeps the receipt state for the reader whose reset just signed them out", async () => {
      session.claims = null;
      await renderPage({ success: "1" }, "1");

      expect(screen.getByText(/other sessions were signed out/i)).toBeInTheDocument();
      expect(screen.queryByText(/open this from your email link/i)).not.toBeInTheDocument();
    });
  });
});
