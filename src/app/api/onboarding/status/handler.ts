import { phase5Live } from "@/lib/env-contract";
import {
  loadSelfSignupIntentStatus,
  type SelfSignupIntentStatus,
} from "@/lib/repositories/onboarding-signup";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };

type SignupStatusDependencies = {
  enabled(): boolean;
  authenticated(): Promise<boolean>;
  load(): Promise<SelfSignupIntentStatus | null>;
};

export function createSignupStatusHandler(dependencies: SignupStatusDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    if (!(await dependencies.authenticated())) {
      return Response.json({ error: "Authentication required." }, {
        status: 401,
        headers: NO_STORE,
      });
    }
    try {
      return Response.json({ intent: await dependencies.load() }, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/onboarding/status failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Signup status is unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

export const GET = createSignupStatusHandler({
  enabled: phase5Live,
  authenticated: async () => {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.getClaims();
    return !error && typeof data?.claims?.sub === "string";
  },
  load: loadSelfSignupIntentStatus,
});
