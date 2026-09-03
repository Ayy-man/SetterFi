import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  loginAccessDescriptor,
  signupIntentDestination,
} from "@/components/onboarding/view-models";
import { parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { demoLoginAccounts } from "@/lib/auth/demo-logins";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { authMode } from "@/lib/auth/mode";
import { RehaulLoginForm } from "@/components/workspace/rehaul/login-form";
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
    <RehaulLoginForm
      demoAccounts={demoAccounts}
      error={error}
      next={internalRedirectPath(next, null)}
      session={session}
      setupAccess={setupAccess}
      signupOpen={phase5Live()}
      submit={submit}
      unattached={unattached}
    />
  );
}
