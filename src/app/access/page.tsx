import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AuthHeader, AuthNotice, AuthStage } from "@/components/auth/auth-shell";
import { KitButton, KitInput, Prose, Surface } from "@/components/kit/atomics";
import { Field } from "@/components/kit/field";
import { COACH_READING_CLASS } from "@/components/workspace/live/coach-type";
import { ACCESS_COOKIE, accessPassword, accessToken, safeEqual } from "@/lib/access";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { authMode } from "@/lib/auth/mode";

export const metadata: Metadata = {
  title: "Access",
  description: "This SetterFi deployment is password protected.",
  robots: { index: false, follow: false },
};

// The gate note reads the live auth mode, so it must not be baked at build time -- the same reason
// `/` is `force-dynamic`, and the reason a statically rendered sentence about configuration is a
// claim about whatever the build machine happened to have set.
export const dynamic = "force-dynamic";

type AccessPageProps = {
  searchParams: Promise<{ next?: string; error?: string }>;
};

/**
 * What this gate is, read off the deployment rather than asserted.
 *
 * The second sentence used to read "Per-user sign-in, roles, and tenant scoping arrive with the
 * backend build." All three arrived: `/login` signs in through `supabase.auth.signInWithPassword`,
 * `loadPlatformActor` and `loadRouteActor` resolve the role, and tenant scoping is RLS across the
 * migrations. It was true the day it was written and it expired without anything telling it to --
 * on the first page a new technical reviewer opens, which is the worst place in the product to
 * understate what has been built.
 *
 * So it follows `authMode()` the way `accessNote()` on `/` already does, which is the pattern that
 * stops this sentence expiring a second time: the wall and per-user sign-in are independent here,
 * because one environment serves both the client's review and real sessions, and the shared
 * password can stand in front of either. A configuration error is not a claim this page is in a
 * position to make, so it falls back to the half of the sentence that is true regardless.
 *
 * The environment is an argument with a default rather than a read of `process.env` inside, which
 * is the whole reason `page.test.ts` can exercise all three modes and the throw against synthetic
 * values -- no stub, no module mock, and the assertions run the real `authMode()` rather than a
 * restatement of it. A sentence that expired once is exactly the kind that needs a guard watching
 * the *branch* rather than the words.
 */
export function gateNote(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const shared = "A shared password for the review deployment, not a user account.";
  try {
    if (authMode(environment) === "supabase") {
      return `${shared} Past it, sign in with your own account: roles and tenant scoping are enforced from there, not simulated.`;
    }
  } catch {
    return shared;
  }
  return `${shared} Per-user sign-in is not switched on for this deployment, so nothing past this gate is scoped to a person.`;
}

async function submit(formData: FormData) {
  "use server";

  const password = accessPassword();
  const target = internalRedirectPath(
    typeof formData.get("next") === "string" ? String(formData.get("next")) : "/",
    "/",
  );
  if (!password) redirect(target);

  const supplied = String(formData.get("password") ?? "");
  const expected = await accessToken(password);

  if (!safeEqual(await accessToken(supplied), expected)) {
    redirect(`/access?next=${encodeURIComponent(target)}&error=1`);
  }

  (await cookies()).set(ACCESS_COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });

  redirect(target);
}

export default async function AccessPage({ searchParams }: AccessPageProps) {
  const { next, error } = await searchParams;

  return (
    <AuthStage>
      <AuthHeader
        eyebrow="Access"
        subline="This deployment is password protected. Enter the shared demo password to continue."
        title="Enter the demo password"
      />

      {error ? (
        <AuthNotice role="alert" tone="failure">
          That password didn’t match. Try again.
        </AuthNotice>
      ) : null}

      <Surface>
        <form action={submit} className="flex flex-col gap-[var(--s-4)]">
          <input name="next" type="hidden" value={internalRedirectPath(next, "/")} />
          {/*
            `htmlFor` is explicit because this page is a server component: the control crosses the
            RSC boundary as a Flight node, so `Field` cannot clone an id onto it and wires it
            through context instead. Pinning it here means the label and the control agree on one
            value rather than on whatever `useId` minted this render. See `kit/field.tsx`.
          */}
          <Field htmlFor="access-password" label="Demo password" required>
            <KitInput autoComplete="current-password" name="password" required type="password" />
          </Field>
          {/* The gate has exactly one thing to do, so it spends the page's one fill on it. */}
          <div className="flex justify-end">
            <KitButton size="lg" type="submit" variant="primary">Continue</KitButton>
          </div>
        </form>
      </Surface>

      {/*
        The flattest face on the page, because it states what this deployment already is rather than
        offering anything to act on -- and it stays explicit that this is not a login.
      */}
      <Surface variant="strip">
        <Prose className={`${COACH_READING_CLASS} text-[color:var(--faint)]`}>
          {gateNote()}
        </Prose>
      </Surface>
    </AuthStage>
  );
}
