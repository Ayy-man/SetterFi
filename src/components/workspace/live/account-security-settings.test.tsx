import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AccountSecuritySettings } from "@/components/workspace/live/account-security-settings";
import {
  beginAccountMfaEnrollment,
  changeAccountPassword,
  disableAccountMfa,
  loadAccountMfaStatus,
  loadAccountSecuritySessions,
  requestAccountEmailChange,
  requestAccountEmailVerification,
  revokeAccountSecuritySession,
  revokeOtherAccountSecuritySessions,
  verifyAccountMfa,
} from "@/lib/auth/account-security-client";

vi.mock("@/lib/auth/account-security-client", () => ({
  beginAccountMfaEnrollment: vi.fn(),
  changeAccountPassword: vi.fn(),
  disableAccountMfa: vi.fn(),
  loadAccountMfaStatus: vi.fn(),
  loadAccountSecuritySessions: vi.fn(),
  requestAccountEmailChange: vi.fn(),
  requestAccountEmailVerification: vi.fn(),
  revokeAccountSecuritySession: vi.fn(),
  revokeOtherAccountSecuritySessions: vi.fn(),
  verifyAccountMfa: vi.fn(),
}));

const SESSIONS_SENTENCE =
  "Review every signed-in device and end access you no longer recognize.";

const currentSession = {
  id: "16f9588f-5933-45c4-83f9-e21b1d077a6a",
  startedAt: "2026-08-30T10:00:00.000Z",
  lastSeenAt: "2026-08-30T11:00:00.000Z",
  ipAddress: "203.0.113.10",
  userAgent: "Mozilla/5.0 Macintosh Safari/605.1.15",
  isCurrent: true,
};
const otherSession = {
  id: "91445f12-29c4-4a9f-9a33-d984f854df99",
  startedAt: "2026-08-29T10:00:00.000Z",
  lastSeenAt: "2026-08-29T11:00:00.000Z",
  ipAddress: "198.51.100.4",
  userAgent: "Mozilla/5.0 Windows Chrome/140.0",
  isCurrent: false,
};
const sessionRead = {
  ok: true as const,
  value: {
    sessions: [currentSession, otherSession],
    audit: { id: 60, action: "auth.sessions.viewed" },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadAccountSecuritySessions).mockResolvedValue(sessionRead);
  vi.mocked(loadAccountMfaStatus).mockResolvedValue({
    ok: true,
    value: { status: "none" },
  });
  vi.mocked(changeAccountPassword).mockResolvedValue({
    ok: true,
    value: {
      message: "Password changed. 2 other sessions have been ended.",
      audit: { id: 61, action: "auth.password.changed" },
    },
  });
  vi.mocked(revokeAccountSecuritySession).mockResolvedValue({
    ok: true,
    value: {
      revokedSessionId: otherSession.id,
      audit: { id: 62, action: "auth.session.revoked" },
    },
  });
  vi.mocked(revokeOtherAccountSecuritySessions).mockResolvedValue({
    ok: true,
    value: {
      revokedCount: 1,
      audit: { id: 63, action: "auth.sessions.others_revoked" },
    },
  });
  vi.mocked(beginAccountMfaEnrollment).mockResolvedValue({
    ok: true,
    value: {
      status: "pending",
      secret: "JBSWY3DPEHPK3PXP",
      audit: { id: 64, action: "auth.mfa.enrolled" },
    },
  });
  vi.mocked(verifyAccountMfa).mockResolvedValue({
    ok: true,
    value: {
      status: "active",
      audit: { id: 65, action: "auth.mfa.activated" },
    },
  });
  vi.mocked(disableAccountMfa).mockResolvedValue({
    ok: true,
    value: {
      status: "none",
      audit: { id: 66, action: "auth.mfa.disabled" },
    },
  });
  vi.mocked(requestAccountEmailVerification).mockResolvedValue({
    ok: true,
    value: {
      message: "If an eligible account matches that email address, we have sent instructions.",
    },
  });
});

function renderSettings(options: {
  emailChangeEnabled?: boolean;
  emailVerified?: boolean;
  mfaEnabled?: boolean;
  securityEnabled?: boolean;
} = {}) {
  return render(
    <AccountSecuritySettings
      currentEmail="coach@example.test"
      emailChangeEnabled={options.emailChangeEnabled ?? false}
      emailVerified={options.emailVerified ?? true}
      mfaEnabled={options.mfaEnabled ?? false}
      securityEnabled={options.securityEnabled ?? true}
    />,
  );
}

describe("AccountSecuritySettings", () => {
  it("loads the server session list and revokes a selected session only after a reason", async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Safari on macOS")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();

    vi.mocked(loadAccountSecuritySessions).mockResolvedValueOnce({
      ok: true,
      value: {
        sessions: [currentSession],
        audit: { id: 67, action: "auth.sessions.viewed" },
      },
    });
    await user.click(screen.getByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("button", { name: "Revoke access" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Reason" }), "This old laptop was replaced.");
    await user.click(screen.getByRole("button", { name: "Revoke access" }));

    await waitFor(() => expect(revokeAccountSecuritySession).toHaveBeenCalledWith(
      otherSession.id,
      "This old laptop was replaced.",
    ));
    expect(await screen.findByText("Session access ended")).toBeInTheDocument();
    expect(screen.getByText(/audit receipt #62/i)).toBeInTheDocument();
    expect(screen.queryByText("Chrome on Windows")).not.toBeInTheDocument();
  });

  it("validates and changes a password, then reads the session list back", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText("Chrome on Windows");
    await user.click(screen.getByRole("button", { name: /Password/ }));

    await user.type(screen.getByLabelText(/Current password/), "current-password");
    await user.type(screen.getByLabelText(/New password/), "replacement-password");
    await user.type(screen.getByLabelText(/Confirm new password/), "different-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("The new passwords do not match. Your existing password is still active.")).toBeInTheDocument();
    expect(changeAccountPassword).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/Confirm new password/));
    await user.type(screen.getByLabelText(/Confirm new password/), "replacement-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(changeAccountPassword).toHaveBeenCalledWith({
      currentPassword: "current-password",
      password: "replacement-password",
    }));
    expect(await screen.findByText("Password changed")).toBeInTheDocument();
    expect(screen.getByText(/audit receipt #61/i)).toBeInTheDocument();
    expect(loadAccountSecuritySessions).toHaveBeenCalledTimes(2);
  });

  it("activates the one-time authenticator key only after the user records the recovery limitation", async () => {
    const user = userEvent.setup();
    vi.mocked(loadAccountMfaStatus)
      .mockResolvedValueOnce({ ok: true, value: { status: "none" } })
      .mockResolvedValueOnce({ ok: true, value: { status: "active" } });
    renderSettings({ mfaEnabled: true });
    await screen.findByText("Chrome on Windows");
    await user.click(screen.getByRole("button", { name: /Authenticator verification/ }));
    expect(await screen.findByRole("button", { name: "Start setup" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Start setup" }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    const activate = screen.getByRole("button", { name: "Verify and activate" });
    await user.type(screen.getByLabelText(/Authenticator code/), "123456");
    expect(activate).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /I saved this key securely/ }));
    await user.click(activate);

    await waitFor(() => expect(verifyAccountMfa).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText("Extra verification active")).toBeInTheDocument();
    expect(screen.getByText(/Sign-in itself does not yet request this code/i)).toBeInTheDocument();
    expect(screen.getByText(/audit receipt #65/i)).toBeInTheDocument();
  });

  it("fails closed on email identity mismatch and an interrupted authenticator setup", async () => {
    const user = userEvent.setup();
    vi.mocked(loadAccountMfaStatus).mockResolvedValue({
      ok: true,
      value: { status: "pending" },
    });
    renderSettings({ mfaEnabled: true });
    await screen.findByText("Chrome on Windows");
    await screen.findByText("Setup pending");

    await user.click(screen.getByRole("button", { name: /Email address/ }));
    expect(screen.getByText("coach@example.test")).toBeInTheDocument();
    expect(screen.getAllByText("Verified")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Resend verification" })).not.toBeInTheDocument();
    expect(screen.getByText("Not released")).toBeInTheDocument();
    expect(screen.getByText(/email-change release gate is off, so no change endpoint is called/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /change email/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Authenticator verification/ }));
    expect(await screen.findByText("Setup interrupted")).toBeInTheDocument();
    expect(screen.getByText(/There is no recovery or pending-factor reset route/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start setup" })).not.toBeInTheDocument();
  });

  it("offers provider verification only for the signed-in unverified email and does not claim delivery", async () => {
    const user = userEvent.setup();
    renderSettings({ emailVerified: false });
    await screen.findByText("Chrome on Windows");

    await user.click(screen.getByRole("button", { name: /Email address/ }));
    expect(screen.getByText("Needs verification")).toBeInTheDocument();
    expect(screen.getByText("coach@example.test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resend verification" }));

    await waitFor(() => expect(requestAccountEmailVerification).toHaveBeenCalledWith(
      "coach@example.test",
    ));
    expect(await screen.findByText("Verification request accepted")).toBeInTheDocument();
    expect(screen.getByText(/does not confirm provider delivery/i)).toBeInTheDocument();
  });
  it("starts a change from the released flow and does not claim the address moved", async () => {
    const user = userEvent.setup();
    vi.mocked(requestAccountEmailChange).mockResolvedValue({
      ok: true,
      value: {
        expiresAt: "2026-08-30T12:00:00.000Z",
        audit: { id: 71, action: "auth.email_change.requested" },
      },
    });
    renderSettings({ emailChangeEnabled: true });
    await screen.findByText("Chrome on Windows");

    await user.click(screen.getByRole("button", { name: /Email address/ }));
    expect(screen.queryByText(/email-change release gate is off/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/New email address/), "second@example.test");
    await user.type(screen.getByLabelText(/Current password/), "current-password");
    await user.click(screen.getByRole("button", { name: "Change email" }));

    await waitFor(() => expect(requestAccountEmailChange).toHaveBeenCalledWith({
      newEmail: "second@example.test",
      currentPassword: "current-password",
      mfaCode: null,
    }));
    expect(await screen.findByText("Confirmation requested")).toBeInTheDocument();
    expect(screen.getByText(/Sign-in still uses coach@example.test/)).toBeInTheDocument();
    expect(screen.getByText(/audit receipt #71/i)).toBeInTheDocument();
  });

  /**
   * The dual-density contract, which is the whole reason this page draws its own panel.
   *
   * `/account/security` is the one route both workspaces open, so the same tree renders under
   * `data-shell-role="coach"` and under `data-shell-role="admin"`. Every size on it is therefore a
   * coach custom property with the console's own value as the fallback -- `coach.css` declares
   * `--coach-body` and friends on the coach shell only, so the fallback is what an admin gets.
   * jsdom loads no stylesheet, so what is checked here is the contract in the class string itself:
   * that each size names a `--coach-*` property AND carries the console value behind it. A future
   * edit that "simplifies" one of these to a bare `text-[16px]` drags the owner console to coach
   * density on this page, and it fails here rather than in a screenshot nobody takes.
   *
   * **The fallbacks moved from literals to `--t-*` tokens, and the assertions moved with them.**
   * These used to name numbers -- `var(--coach-panel-name,15px)` and five like it. Naming the
   * number made the test pass on a value nothing declared: the console's section title is 14px at
   * `tokens.css:978`, so the 15 this file pinned was a snapshot of a kit component that had since
   * moved on, and the pin was holding it there. What the docstring above actually claims is that
   * a coach property carries *the console value* behind it, so asserting that the fallback is a
   * root token is the assertion that claim describes; a literal was only ever a proxy for it.
   * Each part still names which token, so this is no weaker than pinning a number -- it is the
   * same specificity against something that is declared.
   */
  it("sizes every panel part from a coach property with the console value as its fallback", async () => {
    renderSettings();
    // Positive control: the panel really rendered before anything is asserted about its classes.
    expect(await screen.findByText("Chrome on Windows")).toBeInTheDocument();
    expect(screen.getByText("Active sessions")).toBeInTheDocument();

    const eyebrow = screen.getByText("Devices");
    expect(eyebrow).toHaveAttribute("data-slot", "security-panel-eyebrow");
    expect(eyebrow.className).toContain("text-[length:var(--coach-eyebrow,var(--t-label))]");

    expect(screen.getByText("Active sessions").className)
      .toContain("text-[length:var(--coach-panel-name,var(--t-section-title))]");
    expect(screen.getByText(SESSIONS_SENTENCE).className)
      .toContain("text-[length:var(--coach-body,var(--t-body))]");
    expect(screen.getByText("2 active").className)
      .toContain("text-[length:var(--coach-eyebrow,var(--t-mono-crumb))]");

    // The row inside the panel takes the same treatment, at the row's own console sizes.
    expect(screen.getByText("Other devices").className)
      .toContain("text-[length:var(--coach-body,var(--t-row))]");
    expect(screen.getByText(/keeps the current device signed in/).className)
      .toContain("text-[length:var(--coach-body,var(--t-body))]");

    /*
     * And the shape, over every size on the page rather than the six named above. The list is what
     * says which token each part takes; this says no part anywhere resolves to a hand-picked
     * number outside the coach shell, which is the failure the six could not see -- there were
     * fourteen of these and this test knew about six.
     */
    const sized = Array.from(
      document.querySelectorAll<HTMLElement>("[class*='var(--coach-']"),
    );
    expect(sized.length, "elements sizing themselves from a coach property").toBeGreaterThan(6);
    const literalFallbacks = sized
      .flatMap((node) => Array.from(node.className.matchAll(/var\(--coach-[a-z-]+,\s*([^)]*\d[^)]*)\)/gu)))
      .map(([whole]) => whole);
    expect(
      [...new Set(literalFallbacks)],
      "A --coach-* token is declared only on the coach shell, so a numeric fallback is a second, unmanaged scale for every other reader -- it renders a value nothing declares and no lane owns. Name a root --t-* token instead.",
    ).toEqual([]);
  });

  /**
   * The overline ban, and the eyebrow that replaced it.
   *
   * Round-1 demo feedback was that coaches over 55 could not read the kit's 9.5px uppercase
   * `Overline`, so the category above a panel name is a 12px sentence-case eyebrow instead. This
   * catches the drift of someone reaching for `Overline` to draw one of these four categories --
   * which renders `data-slot="overline"` and would be invisible to a test that only checked the
   * words were present.
   */
  it("draws each panel's category as a sentence-case eyebrow, never as an uppercase overline", async () => {
    const { container } = renderSettings();
    await screen.findByText("Chrome on Windows");

    for (const category of ["Devices", "Extra checks"]) {
      expect(screen.getByText(category)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Sign-in")).toHaveLength(2);
    expect(container.querySelectorAll("[data-slot='overline']")).toHaveLength(0);
  });

  /**
   * The inbox failure, which this list has exactly the shape of.
   *
   * The inbox rendered every lead as "Jo..." because a shrink-0 mono timestamp shared a flex line
   * with a truncating name in a narrow column. A signed-in device is the same shape -- an identity
   * that must be read in full next to metadata that will not shrink -- and at 16px it is worse.
   * So the identity line carries the device and its "This device" pill and nothing else, and the
   * started time, the last-seen time and the IP address are three separate lines stacked under it.
   * Placement is asserted rather than width, because `truncate` is invisible to jsdom and a width
   * assertion here would pass on a layout that clips.
   */
  it("keeps a device's identity on its own line with every timestamp stacked underneath", async () => {
    const { container } = renderSettings();
    await screen.findByText("Chrome on Windows");

    const identities = container.querySelectorAll("[data-slot='session-identity']");
    expect(identities).toHaveLength(2);
    // The current device's identity line: the device and its pill, and no time and no address.
    const current = Array.from(identities)
      .find((node) => node.textContent?.includes("Safari on macOS"))!;
    expect(current.textContent).toBe("Safari on macOSThis device");
    expect(current.textContent).not.toMatch(/Started|Last seen|\d{1,3}\.\d{1,3}\./);

    const meta = container.querySelector("[data-slot='session-meta']")!;
    expect(meta.className).toContain("flex-col");
    expect(meta.querySelector("[data-slot='session-started']")!.textContent)
      .toMatch(/^Started /);
    expect(meta.querySelector("[data-slot='session-last-seen']")!.textContent)
      .toMatch(/^Last seen /);
    expect(meta.querySelector("[data-slot='session-ip']")!.textContent).toBe("203.0.113.10");
    // Three separate elements, not one line: no element holds two of the three facts.
    expect(meta.querySelector("[data-slot='session-started']")!.textContent)
      .not.toMatch(/Last seen|203\.0\.113\.10/);
  });

  /**
   * The one control on this page that opts out of the coach surface's 44px floor.
   *
   * `coach.css` raises `min-height` to `--coach-target` on every `input`, which on a 16px square
   * checkbox does not grow the control -- it stretches it into a 16x44 rectangle that stops
   * reading as a checkbox at all. The exemption hands the target to the label that toggles it. If
   * the attribute is dropped, the coach shell silently deforms the one gate standing between a
   * coach and an authenticator they cannot recover.
   */
  it("hands the setup-key acknowledgement's press target to its label, not to a stretched checkbox", async () => {
    const user = userEvent.setup();
    renderSettings({ mfaEnabled: true });
    await screen.findByText("Chrome on Windows");
    await user.click(screen.getByRole("button", { name: /Authenticator verification/ }));
    await user.click(await screen.findByRole("button", { name: "Start setup" }));

    const checkbox = await screen.findByRole("checkbox", { name: /I saved this key securely/ });
    expect(checkbox).toHaveAttribute("data-coach-target", "exempt");

    /*
     * The floor the label picks up in the checkbox's place, and the assertion is about where the
     * chain *ends* rather than what it spells. This shipped as `var(--coach-target,auto)`, which
     * gave the floor to a coach and nothing to anyone else -- `auto` is not a small minimum, it is
     * no minimum -- and `/account/security` renders under all three shells. `--t-target` is 44px
     * at the root with `console.css` re-authoring it to the console's 32px, so every shell now
     * ends on a number somebody owns.
     *
     * A keyword terminator is what this is really guarding against, so it is asserted directly:
     * the day someone reintroduces one, the affiliate shell loses its press target silently, and
     * nothing else on this page would say so.
     */
    const label = checkbox.closest("label")!.className;
    expect(label).toContain("min-h-[var(--coach-target,var(--t-target))]");
    expect(
      /min-h-\[var\([^\]]*\b(?:auto|none|unset|initial)\)?\]/u.test(label),
      "The press-target floor must end in a token, not a keyword: `auto` reads as a decision and renders as no floor for any shell that does not name its own target.",
    ).toBe(false);
  });

  /**
   * The visible half of "privileged actions are audit-logged".
   *
   * The receipt line is the microcopy a reviewer looks for, and the port resized it rather than
   * dropping it. It is asserted here on a mutation rather than on a read, because a receipt that
   * only appears on the session list would tell a coach nothing about the change they just made.
   */
  it("keeps the logged microcopy on a privileged change and sizes it to be read", async () => {
    const user = userEvent.setup();
    renderSettings();
    await screen.findByText("Chrome on Windows");
    await user.click(screen.getByRole("button", { name: /Password/ }));
    await user.type(screen.getByLabelText(/Current password/), "current-password");
    await user.type(screen.getByLabelText(/New password/), "replacement-password");
    await user.type(screen.getByLabelText(/Confirm new password/), "replacement-password");
    await user.click(screen.getByRole("button", { name: "Change password" }));

    const receipt = await screen.findByText(/Logged after server confirmation/);
    expect(receipt).toHaveAttribute("data-slot", "account-security-receipt");
    expect(receipt.textContent).toContain("audit receipt #61");
    /*
     * The size, held to what this test's name claims: the receipt is *read*, not merely present.
     * It pinned `12px` behind the coach property, which is the size this page gives machine
     * metadata -- an IP address, a key -- and a receipt for a privileged action is not metadata.
     * `--t-body` is the console's reading size, so the admin half of this page now states its
     * audit line at the size the rest of its sentences are set in.
     */
    expect(receipt.className).toContain("text-[length:var(--coach-eyebrow,var(--t-body))]");
  });

  it("keeps the current address on a refused change and says so", async () => {
    const user = userEvent.setup();
    vi.mocked(requestAccountEmailChange).mockResolvedValue({
      ok: false,
      message: "The email address could not be changed.",
      status: 400,
      retryAfter: null,
    });
    renderSettings({ emailChangeEnabled: true });
    await screen.findByText("Chrome on Windows");

    await user.click(screen.getByRole("button", { name: /Email address/ }));
    await user.type(screen.getByLabelText(/New email address/), "taken@example.test");
    await user.type(screen.getByLabelText(/Current password/), "current-password");
    await user.click(screen.getByRole("button", { name: "Change email" }));

    expect(await screen.findByText("Email not changed")).toBeInTheDocument();
    expect(screen.getByText("The email address could not be changed.")).toBeInTheDocument();
  });
});
