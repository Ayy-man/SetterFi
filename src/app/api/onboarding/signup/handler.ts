import { loadCurrentAccountTerms, type AccountTermsState } from "@/lib/account/terms";
import { accountTermsLive, phase5Live, tierOfferTermsLive } from "@/lib/env-contract";
import {
  orchestrateSignup,
  SIGNUP_CONFIRMATION_CALLBACK,
  type SignupAuthResult,
  type SignupCapturedFields,
  type SignupOrchestrationResult,
} from "@/lib/onboarding/signup";
import { callerKey, rateLimit, type RateLimitResult } from "@/lib/rate-limit";
import {
  isIanaTimezone,
  listSignupTierCatalog,
  recordSignupAccountTermsAcceptance,
  tierOfferInForce,
  type SignupTierCatalogChoice,
} from "@/lib/repositories/onboarding-signup";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type SignupInput = SignupCapturedFields & {
  password: string;
  acceptedTermsVersionKey: string | null;
};

type SignupDependencies = {
  enabled(): boolean;
  limit(request: Request): RateLimitResult;
  validTier(tierId: string): Promise<boolean>;
  /**
   * The published document the server itself believes in. The request may name a version key, but
   * never supplies its content or hash — those come from here.
   */
  currentTerms(): Promise<AccountTermsState>;
  termsRequired(): boolean;
  recordTermsAcceptance(input: {
    authUserId: string;
    versionKey: string;
    contentHash: string;
    requestContext: Record<string, string>;
  }): Promise<unknown>;
  signUp(input: SignupInput, callbackUrl: string): Promise<{
    auth: SignupAuthResult;
    refreshSession(): Promise<boolean>;
  }>;
  complete(
    auth: SignupAuthResult,
    captured: SignupCapturedFields,
    refreshSession: () => Promise<boolean>,
    recordTermsAcceptance?: (authUserId: string) => Promise<unknown>,
  ): Promise<SignupOrchestrationResult>;
};

type SignupCatalogDependencies = {
  enabled(): boolean;
  list(): Promise<readonly SignupTierCatalogChoice[]>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(body: Record<string, unknown>) {
  const allowed = new Set([
    "email",
    "password",
    "fullName",
    "businessName",
    "slug",
    "tierId",
    "timezone",
    "referralCode",
    "affiliateOptIn",
    "acceptedTermsVersionKey",
  ]);
  return Object.keys(body).every((key) => allowed.has(key));
}

function parseInput(value: unknown): SignupInput | null {
  if (!isRecord(value) || !exactKeys(value)) return null;
  const email = typeof value.email === "string" ? value.email.trim().toLowerCase() : "";
  const password = typeof value.password === "string" ? value.password : "";
  const fullName = typeof value.fullName === "string" ? value.fullName.trim() : "";
  const businessName = typeof value.businessName === "string" ? value.businessName.trim() : "";
  const slug = typeof value.slug === "string" ? value.slug.trim().toLowerCase() : "";
  const tierId = typeof value.tierId === "string" ? value.tierId.trim() : "";
  const timezone = typeof value.timezone === "string" ? value.timezone.trim() : "";
  const acceptedTermsVersionKey = value.acceptedTermsVersionKey === null
    || value.acceptedTermsVersionKey === undefined
    ? null
    : typeof value.acceptedTermsVersionKey === "string"
      ? value.acceptedTermsVersionKey.trim() || null
      : undefined;
  const referralCode = value.referralCode === null || value.referralCode === undefined
    ? null
    : typeof value.referralCode === "string"
      ? value.referralCode.trim() || null
      : undefined;
  if (
    !EMAIL.test(email)
    || password.length < 8
    || !fullName
    || fullName.length > 160
    || !businessName
    || businessName.length > 160
    || !SLUG.test(slug)
    || slug.length > 63
    || !UUID.test(tierId)
    || !isIanaTimezone(timezone)
    || referralCode === undefined
    || (typeof referralCode === "string" && referralCode.length > 64)
    || typeof value.affiliateOptIn !== "boolean"
    || acceptedTermsVersionKey === undefined
    || (typeof acceptedTermsVersionKey === "string" && acceptedTermsVersionKey.length > 128)
  ) return null;
  return {
    email,
    password,
    fullName,
    businessName,
    slug,
    tierId,
    timezone,
    referralCode,
    affiliateOptIn: value.affiliateOptIn,
    acceptedTermsVersionKey,
  };
}

/**
 * Only what the server observed about the request. Nothing here can be chosen by the body, because
 * a receipt whose context the accepter wrote is not evidence of anything.
 */
function observedRequestContext(request: Request): Record<string, string> {
  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const context: Record<string, string> = {
    origin: new URL(request.url).origin,
    observed_at: new Date().toISOString(),
  };
  const clientAddress = forwardedFor.split(",")[0]?.trim();
  if (clientAddress) context.client_address = clientAddress;
  const userAgent = request.headers.get("user-agent")?.trim();
  if (userAgent) context.user_agent = userAgent.slice(0, 512);
  return context;
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

export function createSignupHandler(dependencies: SignupDependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    if (!isSameOrigin(request)) {
      return Response.json({ error: "Request origin was refused." }, { status: 403, headers: NO_STORE });
    }
    const limited = dependencies.limit(request);
    if (!limited.allowed) {
      return Response.json(
        { error: "Too many signup attempts. Try again later." },
        { status: 429, headers: { ...NO_STORE, "Retry-After": String(limited.retryAfter) } },
      );
    }

    let input: SignupInput | null = null;
    try {
      input = parseInput(await request.json());
    } catch {
      input = null;
    }
    if (!input) {
      return Response.json({ error: "Signup details are invalid." }, { status: 400, headers: NO_STORE });
    }

    try {
      if (!(await dependencies.validTier(input.tierId))) {
        return Response.json({ error: "Signup details are invalid." }, { status: 400, headers: NO_STORE });
      }

      // Terms are resolved before the auth identity is created. Refusing afterwards would leave a
      // Supabase user behind with no intent, which is the stranded-identity case signup repair
      // exists to clean up — better not to manufacture one.
      const terms = dependencies.termsRequired()
        ? await dependencies.currentTerms()
        : { state: "none_published" as const };
      const published = terms.state === "published" ? terms : null;
      if (published) {
        if (input.acceptedTermsVersionKey !== published.versionKey) {
          return Response.json(
            { error: "The current account terms must be accepted to continue." },
            { status: 400, headers: NO_STORE },
          );
        }
      } else if (input.acceptedTermsVersionKey !== null) {
        // Accepting a version the server cannot produce would be recorded nowhere, so the request
        // is refused rather than silently dropping the field it sent.
        return Response.json({ error: "Signup details are invalid." }, { status: 400, headers: NO_STORE });
      }

      const callbackUrl = new URL(SIGNUP_CONFIRMATION_CALLBACK, request.url).toString();
      const { auth, refreshSession } = await dependencies.signUp(input, callbackUrl);
      const {
        password: _password,
        acceptedTermsVersionKey: _acceptedTermsVersionKey,
        ...captured
      } = input;
      void _password;
      void _acceptedTermsVersionKey;
      const requestContext = published ? observedRequestContext(request) : null;
      const result = await dependencies.complete(
        auth,
        captured,
        refreshSession,
        published
          ? (authUserId: string) => dependencies.recordTermsAcceptance({
            authUserId,
            versionKey: published.versionKey,
            contentHash: published.contentHash,
            requestContext: requestContext ?? {},
          })
          : undefined,
      );
      const status = result.state === "still_setting_up"
        ? 202
        : result.replayed
          ? 200
          : 201;
      return Response.json(result, { status, headers: NO_STORE });
    } catch {
      return Response.json(
        { error: "Signup could not be completed." },
        { status: 400, headers: NO_STORE },
      );
    }
  };
}

export function createSignupCatalogHandler(dependencies: SignupCatalogDependencies) {
  return async function GET() {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    }
    try {
      return Response.json({ tiers: await dependencies.list() }, { headers: NO_STORE });
    } catch (cause) {
      console.error(
        "/api/onboarding/signup failed.",
        cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
      );
      return Response.json({ error: "Signup choices are unavailable." }, {
        status: 503,
        headers: NO_STORE,
      });
    }
  };
}

export const GET = createSignupCatalogHandler({
  enabled: phase5Live,
  list: listSignupTierCatalog,
});

export const POST = createSignupHandler({
  enabled: phase5Live,
  limit: (request) => rateLimit(callerKey(request, "onboarding-signup"), {
    limit: 8,
    windowMs: 15 * 60 * 1_000,
  }),
  validTier: async (tierId) => {
    const client = createSupabaseServiceClient();
    const { data, error } = await client
      .from("tiers")
      .select("id")
      .eq("id", tierId)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error("SIGNUP_TIER_LOOKUP_FAILED");
    if (data?.id !== tierId) return false;
    // Active is not the same as sellable. Once dated terms are in force, an active tier with no
    // offer covering this instant has no price anyone agreed to, so a direct POST that skipped the
    // catalogue is refused rather than quoted a superseded one.
    if (!tierOfferTermsLive()) return true;
    return tierOfferInForce(tierId, new Date());
  },
  signUp: async (input, callbackUrl) => {
    const client = await createSupabaseServerClient();
    const { data, error } = await client.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        emailRedirectTo: callbackUrl,
        data: { full_name: input.fullName },
      },
    });
    if (error || !data.user) throw new Error("SIGNUP_AUTH_REFUSED");
    return {
      auth: {
        user: { id: data.user.id, email: data.user.email ?? null },
        session: data.session,
      },
      refreshSession: async () => {
        const refreshed = await client.auth.refreshSession();
        return !refreshed.error && refreshed.data.session !== null;
      },
    };
  },
  currentTerms: loadCurrentAccountTerms,
  termsRequired: accountTermsLive,
  recordTermsAcceptance: recordSignupAccountTermsAcceptance,
  complete: (auth, captured, refreshSession, recordTermsAcceptance) => orchestrateSignup(auth, captured, {
    persistIntent: async (input) => {
      const { persistSignupIntent } = await import("@/lib/repositories/onboarding-signup");
      return persistSignupIntent(input);
    },
    completeSignup: async (input) => {
      const { completeOnboardingSignup } = await import("@/lib/repositories/onboarding-signup");
      return completeOnboardingSignup(input);
    },
    recordFailure: async (authUserId, errorCode) => {
      const { recordSignupIntentFailure } = await import("@/lib/repositories/onboarding-signup");
      return recordSignupIntentFailure(authUserId, errorCode);
    },
    loadIntent: async (authUserId) => {
      const { loadSignupIntentByAuthUser } = await import("@/lib/repositories/onboarding-signup");
      return loadSignupIntentByAuthUser(authUserId);
    },
    refreshSession,
    recordTermsAcceptance,
  }),
});
