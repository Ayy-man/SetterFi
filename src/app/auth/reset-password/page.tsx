import { cookies } from "next/headers";

import { AuthHeader, AuthNotice, AuthStage } from "@/components/auth/auth-shell";
import { KitButton, KitInput, Prose, Surface, kitButtonClass } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { COACH_READING_CLASS } from "@/components/workspace/live/coach-type";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { PASSWORD_RESET_DONE_COOKIE, type ResetPasswordOutcome } from "@/lib/auth/recovery";

export const metadata = {
  title: "Reset password",
  robots: { index: false, follow: false },
};

type ResetPasswordPageProps = {
  searchParams: Promise<{ next?: string; error?: string; success?: string }>;
};

/** The outcomes that report on a password that has already changed, and so need the receipt. */
const AFTER_THE_CHANGE = new Set<ResetPasswordOutcome>(["sessions-live", "not-recorded"]);

/**
 * This intentionally small credential form is the endpoint of the email recovery flow.
 *
 * It is a plain `method="post"` form to a route handler and stays one, so it works with scripting
 * unavailable -- the redesign here is the face, not the mechanism. Until now it had no face at all:
 * an unstyled `<main>` on the browser's default paper, which is a jarring thing to land on from an
 * email in the middle of a dark console.
 *
 * ## Nothing here says the password changed unless the route says so
 *
 * Every state that reports on a completed change is gated on `PASSWORD_RESET_DONE_COOKIE`, which
 * only `/api/auth/password-reset/complete` sets. The query string routes; the cookie authorises.
 * Before this, `/auth/reset-password?success=1` rendered "Your password was reset. Other sessions
 * were signed out." to anyone who typed it -- a claim about a write, in the past tense, on an auth
 * surface, with nothing behind it. A reader who arrives with the parameter and no receipt gets the
 * form, which is the honest thing to show someone whose password has not been changed.
 */
export default async function ResetPasswordPage({ searchParams }: ResetPasswordPageProps) {
  const { next, error, success } = await searchParams;
  const destination = internalRedirectPath(next, "/login");
  const action = `/api/auth/password-reset/complete?next=${encodeURIComponent(destination)}`;
  const outcome = error as ResetPasswordOutcome | undefined;

  const receipt = (await cookies()).get(PASSWORD_RESET_DONE_COOKIE)?.value === "1";
  const changed = receipt && (success === "1" || (outcome !== undefined && AFTER_THE_CHANGE.has(outcome)));

  if (changed) {
    const signedOut = outcome !== "sessions-live";
    return (
      <AuthStage>
        <AuthHeader
          eyebrow="Password reset"
          subline={signedOut
            ? "Your password was reset. Other sessions were signed out."
            : "Your password was reset. We could not sign out your other sessions."}
          title="Password reset"
        />

        {outcome === "sessions-live" ? (
          <AuthNotice role="alert" tone="failure">
            Your other sessions may still be signed in. Sign in and end them from Account then
            Security, and do that first if you did not start this reset yourself.
          </AuthNotice>
        ) : null}
        {outcome === "not-recorded" ? (
          <AuthNotice role="status" tone="waiting">
            Your new password and the sign-outs are in place. We could not write this to the audit
            log, so it will be missing from your account history.
          </AuthNotice>
        ) : null}

        <Surface className="flex flex-col items-start gap-[var(--s-3)]">
          <Prose className={`${COACH_READING_CLASS} text-[color:var(--muted)]`}>
            You can sign in with the new password now.
          </Prose>
          {/* Signing in is the only thing left to do, so it takes the page's one fill. */}
          <a className={kitButtonClass({ size: "lg", variant: "primary" })} href={internalRedirectPath("/login", "/")}>
            Sign in
          </a>
        </Surface>
      </AuthStage>
    );
  }

  return (
    <AuthStage>
      <AuthHeader
        eyebrow="Password reset"
        subline="Choose a password you are not using anywhere else. Saving it signs you out of your other sessions."
        title="Choose a new password"
      />

      {outcome === "invalid-link" ? (
        <AuthNotice role="alert" tone="failure">
          This reset link is invalid or has expired.
        </AuthNotice>
      ) : null}
      {/* The link is fine and the reader is still signed in to it -- say what to change, and do not
          send them to spend another of three throttled emails on a password they can simply retype. */}
      {outcome === "password-rejected" ? (
        <AuthNotice role="alert" tone="failure">
          That password was not accepted. Use at least twelve characters, and one you are not
          already signing in with here -- this link is still good.
        </AuthNotice>
      ) : null}
      {outcome === "reset-failed" ? (
        <AuthNotice role="alert" tone="failure">
          We could not reset your password. Request a new link and try again.
        </AuthNotice>
      ) : null}

      <Surface>
        <form action={action} className="flex flex-col gap-[var(--s-4)]" method="post">
          <Field htmlFor="password" label="New password" hint="At least twelve characters." required>
            <KitInput autoComplete="new-password" id="password" minLength={12} name="password" required type="password" />
          </Field>
          <div className="flex justify-end">
            <KitButton size="lg" type="submit" variant="primary">Reset password</KitButton>
          </div>
        </form>
      </Surface>
    </AuthStage>
  );
}
