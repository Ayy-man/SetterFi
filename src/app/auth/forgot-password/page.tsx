import { AuthHeader, AuthStage } from "@/components/auth/auth-shell";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";

import { ForgotPasswordForm } from "./forgot-password-form";

export const metadata = {
  title: "Forgot password",
  robots: { index: false, follow: false },
};

type ForgotPasswordPageProps = {
  searchParams: Promise<{ next?: string }>;
};

/**
 * The request half of the email recovery flow. Its counterpart is /auth/reset-password, which the
 * emailed link returns to; this page only asks for the address and hands it to the route.
 */
export default async function ForgotPasswordPage({ searchParams }: ForgotPasswordPageProps) {
  const { next } = await searchParams;

  return (
    <AuthStage>
      <AuthHeader
        eyebrow="Password reset"
        subline="Enter the email address on your account and we will send a link to choose a new password. The link expires, and using it signs you out of other sessions."
        title="Reset your password"
      />
      <ForgotPasswordForm next={internalRedirectPath(next, "/login")} />
    </AuthStage>
  );
}
