export type AuthMode = "open" | "password" | "supabase";
type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export class AuthConfigurationError extends Error {
  readonly code = "AUTH_CONFIGURATION_ERROR";

  constructor(readonly missingOrInvalid: readonly string[]) {
    super(`Authentication configuration is incomplete: ${missingOrInvalid.join(", ")}`);
    this.name = "AuthConfigurationError";
  }
}

export function isProductionDeployment(environment: AuthEnvironment = process.env) {
  if (environment.VERCEL_ENV === "production") return true;
  if (environment.VERCEL_ENV === "preview" || environment.VERCEL_ENV === "development") {
    return false;
  }
  return environment.NODE_ENV === "production";
}

/**
 * Resolves one explicit, complete authentication mode. Invalid or incomplete configuration throws
 * before the proxy can admit a request, which makes a deployment failure closed rather than open.
 */
export function authMode(environment: AuthEnvironment = process.env): AuthMode {
  const selected = environment.SETTERFI_AUTH_MODE?.trim();
  if (selected === "supabase") {
    const missing = [
      !environment.NEXT_PUBLIC_SUPABASE_URL?.trim() && "NEXT_PUBLIC_SUPABASE_URL",
      !environment.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() && "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ].filter((value): value is string => Boolean(value));
    if (missing.length) throw new AuthConfigurationError(missing);
    return "supabase";
  }
  if (selected === "password") {
    if (!environment.SETTERFI_ACCESS_PASSWORD?.trim()) {
      throw new AuthConfigurationError(["SETTERFI_ACCESS_PASSWORD"]);
    }
    return "password";
  }
  if (selected === "open") {
    if (isProductionDeployment(environment)) {
      throw new AuthConfigurationError(["SETTERFI_AUTH_MODE=open"]);
    }
    return "open";
  }
  throw new AuthConfigurationError(["SETTERFI_AUTH_MODE"]);
}
