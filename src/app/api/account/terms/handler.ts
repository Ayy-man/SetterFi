import { accountTermsLive } from "@/lib/env-contract";
import { loadCurrentAccountTerms, type AccountTermsState } from "@/lib/account/terms";

const NO_STORE = { "Cache-Control": "no-store" };

export type AccountTermsRouteDependencies = {
  enabled(): boolean;
  load(): Promise<AccountTermsState>;
};

export function createAccountTermsHandler(dependencies: AccountTermsRouteDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    try {
      return Response.json({ terms: await dependencies.load() }, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/account/terms failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Account terms are unavailable." }, { status: 503, headers: NO_STORE });
    }
  };
}

export const GET = createAccountTermsHandler({
  enabled: accountTermsLive,
  load: loadCurrentAccountTerms,
});
