import { internalRedirectPath } from "@/lib/auth/internal-redirect";
import { resetPasswordPath } from "@/lib/auth/recovery";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type RecoveryCallbackDependencies = {
  exchangeCode(code: string): Promise<boolean>;
  verifyRecoveryToken(tokenHash: string): Promise<boolean>;
};

function redirect(request: Request, path: string) {
  const safePath = internalRedirectPath(path, "/login");
  return new Response(null, {
    status: 303,
    headers: { ...NO_STORE, Location: new URL(safePath, request.url).toString() },
  });
}

/** Exchanges only recovery credentials into a short-lived server session for the reset form. */
export function createRecoveryCallbackHandler(dependencies: RecoveryCallbackDependencies) {
  return async function GET(request: Request) {
    const url = new URL(request.url);
    const next = internalRedirectPath(url.searchParams.get("next"), "/login");
    const tokenHash = url.searchParams.get("token_hash")?.trim();
    const type = url.searchParams.get("type");
    const code = url.searchParams.get("code")?.trim();

    try {
      const valid = tokenHash
        ? type === "recovery" && await dependencies.verifyRecoveryToken(tokenHash)
        : code ? await dependencies.exchangeCode(code) : false;
      if (!valid) return redirect(request, resetPasswordPath(next, { error: "invalid-link" }));
      return redirect(request, resetPasswordPath(next));
    } catch {
      return redirect(request, resetPasswordPath(next, { error: "invalid-link" }));
    }
  };
}

export const GET = createRecoveryCallbackHandler({
  exchangeCode: async (code) => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.exchangeCodeForSession(code);
    return !error;
  },
  verifyRecoveryToken: async (tokenHash) => {
    const client = await createSupabaseServerClient();
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "recovery" });
    return !error;
  },
});
