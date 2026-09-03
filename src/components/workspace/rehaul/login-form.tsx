import Link from "next/link";

import { PendingSubmitButton } from "@/app/signup/signup-form";
import { AuthNotice } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { KitInput, Prose, Surface, kitButtonClass } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { COACH_EYEBROW_CLASS } from "@/components/workspace/live/coach-type";
import { AUTH_FIELDS_CLASS, AUTH_SUBMIT_CLASS, AuthCard } from "@/components/workspace/rehaul/auth-card";
import type { DemoLoginAccount } from "@/lib/auth/demo-logins";
import type { LoginAccessDescriptor } from "@/components/onboarding/view-models";

/**
 * /login, drawn from `Login.body.html`.
 *
 * Everything that decides whether somebody gets in stays in `src/app/login/page.tsx`: the same
 * `submit` server action, the same `next` round-trip through `internalRedirectPath`, the same four
 * error branches, the same already-signed-in read. This file receives them and draws them; it makes
 * no decision of its own and asks the database nothing.
 *
 * What changed is the shape. The artboard is a 440px card whose header band is the whole heading --
 * "Welcome back" rather than an eyebrow over "Sign in" -- with two fields, one full-width submit and
 * the password link centred under it. The demo strip keeps its ghost buttons and loses its sentence,
 * per the copy rule: the eyebrow already says what the row is.
 */
export function RehaulLoginForm({
  demoAccounts,
  error,
  next,
  session,
  setupAccess,
  signupOpen,
  submit,
  unattached,
}: {
  demoAccounts: readonly DemoLoginAccount[];
  error?: string;
  /** Already normalised by `internalRedirectPath`; `null` when there was nothing safe to keep. */
  next: string | null;
  session: { email: string; href: string } | null;
  setupAccess: LoginAccessDescriptor | null;
  signupOpen: boolean;
  submit: (formData: FormData) => Promise<void>;
  unattached: LoginAccessDescriptor | null;
}) {
  if (session) {
    return (
      <AuthCard title="You are already signed in">
        <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]">
          You are signed in as{" "}
          <strong className="font-[600] text-[color:var(--ink)]">{session.email}</strong>.
        </Prose>
        {/* With a session open, continuing is the only live action, so it takes the page's fill. */}
        <Link
          className={kitButtonClass({
            className: AUTH_SUBMIT_CLASS,
            size: "lg",
            variant: "primary",
          })}
          href={session.href}
        >
          Continue
        </Link>
      </AuthCard>
    );
  }

  const notices = (
    <>
      {error === "1" ? (
        <AuthNotice role="alert" tone="failure">
          We could not sign you in. Check your email and password, then try again.
        </AuthNotice>
      ) : null}
      {setupAccess ? (
        <AuthNotice tone="waiting">
          <p>{setupAccess.message}</p>
          {/*
            The two things a coach can do in this state, laid out as controls rather than as words
            inside a sentence: `inline-flex` is what lets the 44px floor reach an anchor.
          */}
          <p className="mt-[var(--s-3)] flex flex-wrap gap-x-[var(--s-5)]">
            <Link className="link-inline inline-flex items-center font-[500]" href={setupAccess.retryHref!}>
              Try signing in again
            </Link>
            <a className="link-inline inline-flex items-center font-[500]" href={setupAccess.supportHref!}>
              Contact support
            </a>
          </p>
        </AuthNotice>
      ) : null}
      {unattached ? (
        <AuthNotice role="alert" tone="failure">
          {unattached.message}
        </AuthNotice>
      ) : null}
      {error === "confirmation-failed" ? (
        <AuthNotice role="alert" tone="failure">
          That confirmation link could not be verified. Request a new link or contact support.
        </AuthNotice>
      ) : null}
    </>
  );

  return (
    <AuthCard
      above={notices}
      below={
        <>
          {/*
            Offered only while /signup can actually take somebody: that page reads `phase5Live()` to
            decide whether it renders a form at all, and an invitation onto a page that refuses it is
            worse than no invitation.
          */}
          {signupOpen ? (
            <p className="m-0 text-center text-[16px] leading-[1.5] text-[color:var(--muted)]">
              New here? <Link className="link-inline font-[500]" href="/signup">Start with SetterFi</Link>
            </p>
          ) : null}
          {demoAccounts.length > 0 ? (
            /*
              Review accounts, so the flattest face on the page: ghost buttons, under the card, with
              the sign-in above keeping the only fill.
            */
            <Surface variant="strip">
              <p className={`m-0 ${COACH_EYEBROW_CLASS}`}>Demo shortcuts</p>
              <div className="mt-[var(--s-3)] flex flex-wrap gap-[var(--s-1)]">
                {demoAccounts.map((account) => (
                  <form action={submit} key={account.role}>
                    {next ? <input name="next" type="hidden" value={next} /> : null}
                    <input name="email" type="hidden" value={account.email} />
                    <input name="password" type="hidden" value={account.password} />
                    <PendingSubmitButton
                      idleLabel={account.label}
                      pendingLabel="Signing in"
                      size="sm"
                      variant="ghost"
                    />
                  </form>
                ))}
              </div>
            </Surface>
          ) : null}
        </>
      }
      title="Welcome back"
    >
      <form action={submit} className={`flex flex-col gap-[18px] ${AUTH_FIELDS_CLASS}`}>
        {next ? <input name="next" type="hidden" value={next} /> : null}
        {/*
          `htmlFor` is explicit on both fields because this is a server component: the controls cross
          the RSC boundary as Flight nodes, so `Field` cannot clone an id onto them. See the note in
          `kit/field.tsx`.
        */}
        <Field htmlFor="login-email" label="Email" required>
          <KitInput autoComplete="email" name="email" required type="email" />
        </Field>
        <PasswordField autoComplete="current-password" htmlFor="login-password" />
        <PendingSubmitButton
          className={AUTH_SUBMIT_CLASS}
          idleLabel="Sign in"
          pendingLabel="Signing in"
        />
        <a className="link-inline self-center text-[16px] font-[500]" href="/auth/forgot-password">
          I forgot my password
        </a>
      </form>
    </AuthCard>
  );
}
