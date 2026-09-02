import { phase5Live } from "@/lib/env-contract";
import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { resolveSignupAccessState, type SignupAccessState } from "@/lib/onboarding/signup";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type ConfirmationDependencies = {
  enabled(): boolean;
  exchange(tokenHash: string): Promise<string | null>;
  resolve(authUserId: string): Promise<SignupAccessState>;
};

function redirect(request: Request, path: string) {
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: new URL(path, request.url).toString() },
  });
}

export function createConfirmationHandler(dependencies: ConfirmationDependencies) {
  return async function GET(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    const url = new URL(request.url);
    const tokenHash = url.searchParams.get("token_hash")?.trim();
    if (!tokenHash) return redirect(request, "/login?error=confirmation-failed");

    try {
      const authUserId = await dependencies.exchange(tokenHash);
      if (!authUserId) return redirect(request, "/login?error=confirmation-failed");
      const access = await dependencies.resolve(authUserId);
      if (access.state === "ready") {
        return redirect(request, internalRedirectPath(url.searchParams.get("next"), "/onboarding"));
      }
      if (access.state === "still_setting_up") {
        return redirect(request, "/onboarding?state=still-setting-up");
      }
      return redirect(request, "/login?error=workspace-not-attached");
    } catch {
      return redirect(request, "/login?error=confirmation-failed");
    }
  };
}

export const GET = createConfirmationHandler({
  enabled: phase5Live,
  exchange: async (tokenHash) => {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    return error ? null : data.user?.id ?? null;
  },
  resolve: resolveSignupAccessState,
});
