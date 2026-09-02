import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PendingSubmitButton } from "@/app/signup/signup-form";
import { AuthNotice, AuthPanel, AuthStage } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import { KitInput, Prose, Surface, kitButtonClass } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { COACH_EYEBROW_CLASS } from "@/components/workspace/live/coach-type";
import {
  loginAccessDescriptor,
  signupIntentDestination,
} from "@/components/onboarding/view-models";
import { parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { demoLoginAccounts } from "@/lib/auth/demo-logins";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { authMode } from "@/lib/auth/mode";
import { phase5Live } from "@/lib/env-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to SetterFi.",
  robots: { index: false, follow: false },
};

type LoginPageProps = {
  searchParams: Promise<{ next?: string; error?: string }>;
};

function claimsFromAccessToken(accessToken: string) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString());
    return parseAppClaims(payload);
  } catch {
    return null;
  }
}

async function submit(formData: FormData) {
  "use server";

  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const next = internalRedirectPath(
    typeof formData.get("next") === "string" ? String(formData.get("next")) : undefined,
    null,
  );

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.session) {
    redirect(`/login?error=1${next ? `&next=${encodeURIComponent(next)}` : ""}`);
  }

  if (next) redirect(next);

  const claims = claimsFromAccessToken(data.session.access_token);
  const home = workspaceForRole(claims?.role ?? null);
  if (home) redirect(`/${home}`);

  const { GET: loadSignupStatus } = await import("@/app/api/onboarding/status/route");
  const status = await loadSignupStatus();
  if (status.ok) {
    const payload = await status.json() as { intent?: unknown };
    const destination = signupIntentDestination(payload.intent);
    if (destination === "/onboarding") {
      const refreshed = await supabase.auth.refreshSession();
      if (!refreshed.error && refreshed.data.session) redirect(destination);
      redirect("/login?error=still-setting-up");
    }
    if (destination) redirect(destination);
  }
  redirect("/login?error=2");
}

async function currentSession() {
  if (authMode() !== "supabase") return null;
  const supabase = await createSupabaseServerClient();
  const [{ data: userData }, { data: claimsData }] = await Promise.all([
    supabase.auth.getUser(),
    supabase.auth.getClaims(),
  ]);
  if (!userData.user?.email) return null;
  const claims = parseAppClaims(claimsData?.claims);
  const home = workspaceForRole(claims.role);
  return {
    email: userData.user.email,
    href: home ? `/${home}` : "/onboarding",
  };
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const [{ next, error }, session] = await Promise.all([searchParams, currentSession()]);
  const setupAccess = error === "still-setting-up"
    ? loginAccessDescriptor({
        state: "still_setting_up",
        intentId: "route-confirmed",
        errorCode: null,
      })
    : null;
  const unattached = error === "2" || error === "workspace-not-attached"
    ? loginAccessDescriptor({ state: "not_onboarding" })
    : null;
  const demoAccounts = demoLoginAccounts();

  return (
    <AuthStage>
      {session ? (
        <AuthPanel eyebrow="Your workspace" title="You are already signed in">
          <Prose className="text-[16px] leading-[1.55] text-[color:var(--body)]">
            You are signed in as{" "}
            <strong className="font-[600] text-[color:var(--ink)]">{session.email}</strong>.
          </Prose>
          {/*
            The page's one accent fill. With a session already open, continuing into the workspace
            is the only live action there is, so the fill follows it here and the sign-in form --
            which is not rendered in this branch -- never competes for it.
          */}
          <Link
            className={kitButtonClass({
              className: "mt-[var(--s-4)] h-[var(--coach-target-primary)] w-full text-[18px]",
              size: "lg",
              variant: "primary",
            })}
            href={session.href}
          >
            Continue
          </Link>
        </AuthPanel>
      ) : (
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
                These two are the only things a coach can do in this state, so they are laid out
                as controls rather than as words inside a sentence: `inline-flex` is what lets the
                44px floor in `coach.css` reach them, since `min-height` does nothing to an inline
                anchor. The links inside the notice's prose stay inline on purpose -- a sentence
                whose every link is 44px tall is not a sentence any more.
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

          <AuthPanel eyebrow="Your workspace" title="Sign in">
            <form action={submit} className="flex flex-col gap-[var(--s-5)]">
              {internalRedirectPath(next, null) ? <input name="next" type="hidden" value={internalRedirectPath(next, null)!} /> : null}
              {/*
                `htmlFor` is explicit on both fields because this page is a server component: the
                controls cross the RSC boundary as Flight nodes, so `Field` cannot clone an id onto
                them and wires them through context instead. Pinning the id here means the label,
                the hint and anything naming the control from outside all agree on one value rather
                than on whatever `useId` minted this render. See the note in `kit/field.tsx`.
              */}
              <Field htmlFor="login-email" label="Email" required>
                <KitInput autoComplete="email" name="email" required type="email" />
              </Field>
              <PasswordField autoComplete="current-password" htmlFor="login-password" />
              {/*
                Full width at 60px. The artboard draws the submit as the widest object on the
                screen, and it is the only thing on this page anyone came here to press -- a 34px
                button floated to the right of a 468px card was the console's shape, not this one.
              */}
              <PendingSubmitButton
                className="h-[var(--coach-target-primary)] w-full text-[18px]"
                idleLabel="Sign in"
                pendingLabel="Signing in"
              />
              <a
                className="link-inline self-center text-[16px] font-[500]"
                href="/auth/forgot-password"
              >
                I forgot my password
              </a>
            </form>
          </AuthPanel>

          {/*
            Offered only while `/signup` can actually take somebody. That page reads `phase5Live()`
            to decide whether it renders a form or the sentence "Account setup is not available
            yet", and this link read nothing at all, so the front door invited every visitor into a
            dead end. It reads the same call rather than a flag of its own: a second switch is a
            second thing to remember to flip, and the failure it permits -- an invitation onto a
            page that refuses it -- is exactly the one being fixed here.
          */}
          {phase5Live() ? (
            <p className="m-0 text-center text-[16px] leading-[1.5] text-[color:var(--muted)]">
              New here? <Link className="link-inline font-[500]" href="/signup">Set up your agent</Link>
            </p>
          ) : null}

          {demoAccounts.length > 0 ? (
            /*
              Review accounts, so the flattest face on the page: a strip states what the deployment
              already decided rather than offering a coach something to act on, and its buttons stay
              ghost so the sign-in above keeps the only fill.
            */
            <Surface variant="strip">
              <p className={`m-0 ${COACH_EYEBROW_CLASS}`}>Demo shortcuts</p>
              <Prose className="mt-[var(--s-2)] text-[16px] leading-[1.5] text-[color:var(--faint)]">
                Review accounts only. These shortcuts are off wherever real coaches can reach.
              </Prose>
              <div className="mt-[var(--s-3)] flex flex-wrap gap-[var(--s-1)]">
                {demoAccounts.map((account) => (
                  <form action={submit} key={account.role}>
                    {internalRedirectPath(next, null) ? <input name="next" type="hidden" value={internalRedirectPath(next, null)!} /> : null}
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
      )}
    </AuthStage>
  );
}
