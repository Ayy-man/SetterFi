/**
 * What the install flow leaves behind when it refuses, and the two rules that make it safe to.
 *
 * Nothing but an allow-listed code shape is ever written. A caught provider error is prose that can
 * carry request context - the same reason `callback/route.ts:66` refuses to read
 * `error_description` - so it is dropped whole rather than truncated, because a truncated secret is
 * still a secret. Everything the routes have that is worth keeping (an error code, a status, the
 * key names of a response body, the names of missing environment variables) already has a shape,
 * and the shape gates it while a known-value list decides it.
 *
 * The two fields an external party still influences are handled by that second rule. A provider
 * `error` is written only when it is one of the seven values the specification defines; anything
 * else that is still shaped like a code becomes the constant `unrecognized`, because the shape was
 * never the semantic check and an attacker controls this parameter on a public redirect URL. A
 * response body's key set is reduced to a hash unless it is short and strict enough that the
 * provider could not have chosen its content.
 *
 * A failed write is swallowed. This module observes a flow it must never be able to break, so no
 * writer returns anything a caller could branch on.
 */

import { createHash } from "node:crypto";

import { DriverConfigurationError } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { GhlOAuthError, ghlOAuthStateHash, type GhlOAuthApp } from "./ghl-oauth";

type ServiceClient = ReturnType<typeof createSupabaseServiceClient>;

export const INSTALL_EVENT_UNKNOWN_CODE = "GHL_INSTALL_UNEXPECTED_ERROR";

/** Prose cannot match this: prose has spaces and lowercase. That is the whole no-leak argument. */
const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;
/** An OAuth `error` parameter, as the specification writes them. Anything else is a sentence. */
const PROVIDER_ERROR_SHAPE = /^[a-z_]{1,40}$/;
/** RFC 6749 §4.1.2.1. The only seven values an authorization endpoint is defined to return. */
const PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);
/** Written in place of a value that passed the shape check but is not one of the seven. */
const UNRECOGNIZED_PROVIDER_ERROR = "unrecognized";
/**
 * A short strict key list: lower-snake names, each at most twenty-four characters, at most eight
 * of them. Tight enough that the provider cannot compose a sentence inside it.
 */
const BODY_KEY_LIST = /^[a-z][a-z0-9_]{0,23}(,[a-z][a-z0-9_]{0,23}){0,7}$/;
/** The bare type names `bodyShape()` in ghl-oauth.ts emits when the payload is not an object. */
const BODY_TYPES: ReadonlySet<string> = new Set([
  "array",
  "string",
  "number",
  "boolean",
  "undefined",
  "object",
]);
const STATE_REF_SHAPE = /^[0-9a-f]{12}$/;
const MAX_MISSING_ENV = 12;

export type InstallEventApp = GhlOAuthApp | "unknown";

export type InstallEventContext = {
  code: string;
  providerStatus?: number;
  bodyShape?: string;
  missingEnv?: string[];
};

function shaped(value: unknown) {
  return typeof value === "string" && CODE_SHAPE.test(value) ? value : null;
}

/**
 * The security boundary. One allow-list, applied to a provider code, a configuration code, and
 * finally a bare message - anything else becomes the single unknown code.
 */
export function installEventCode(error: unknown): string {
  if (error instanceof GhlOAuthError) return shaped(error.code) ?? INSTALL_EVENT_UNKNOWN_CODE;
  if (error instanceof DriverConfigurationError) {
    return shaped(error.code) ?? INSTALL_EVENT_UNKNOWN_CODE;
  }
  if (error instanceof Error) return shaped(error.message) ?? INSTALL_EVENT_UNKNOWN_CODE;
  return INSTALL_EVENT_UNKNOWN_CODE;
}

/**
 * Everything a caught error can contribute, extracted once so no route repeats the instanceof.
 * Variable *names* are recorded deliberately - a deploy missing GHL_AGENCY_CLIENT_SECRET is the
 * failure this whole task exists to make readable. Values never are.
 */
export function installEventContext(error: unknown): InstallEventContext {
  const code = installEventCode(error);
  if (error instanceof GhlOAuthError) {
    return {
      code,
      ...(typeof error.status === "number" ? { providerStatus: error.status } : {}),
      ...(typeof error.bodyShape === "string" ? { bodyShape: error.bodyShape } : {}),
    };
  }
  if (error instanceof DriverConfigurationError) {
    return { code, missingEnv: [...error.variableNames] };
  }
  return { code };
}

/**
 * Twelve hex characters of the state's sha256. Not reversible, not a prefix of the token, and it
 * is what lets an issued link and the callback that came back for it read as one attempt.
 */
export function installEventStateRef(state: string) {
  return installEventHashRef(ghlOAuthStateHash(state));
}

/** The same ref from a hash already in hand, so the success path never re-reads a raw state. */
export function installEventHashRef(stateHash: string) {
  return stateHash.slice(0, 12);
}

export type GhlInstallStartRefusal = {
  app: InstallEventApp;
  actorId: string;
  tenantId: string | null;
  code: string;
  stateRef?: string;
  missingEnv?: readonly string[];
};

export type GhlInstallCallbackEvent = {
  app: GhlOAuthApp;
  outcome: "declined" | "failed";
  code: string;
  stateRef?: string;
  tenantId?: string | null;
  providerStatus?: number;
  bodyShape?: string;
  providerError?: string;
  missingEnv?: readonly string[];
};

const CALLBACK_ACTIONS: Readonly<Record<GhlOAuthApp, Record<"declined" | "failed", string>>> = {
  agent: {
    declined: "channel.messaging_install.declined",
    failed: "channel.messaging_install.failed",
  },
  provisioning: {
    declined: "platform.provisioning_install.declined",
    failed: "platform.provisioning_install.failed",
  },
};

const START_REFUSED_ACTION = "channel.messaging_install.start_refused";

function optional(key: string, value: string | null) {
  return value === null ? {} : { [key]: value };
}

function environmentNames(values: readonly string[] | undefined) {
  const names = (values ?? []).map(shaped).filter((name): name is string => name !== null);
  return names.length ? { missing_env: names.slice(0, MAX_MISSING_ENV) } : {};
}

function status(value: number | undefined) {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? { provider_status: value }
    : {};
}

function match(pattern: RegExp, value: string | undefined) {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

/**
 * The shape check first, as the cheap prose filter, then the allow-list as the semantic one. A
 * sentence is still dropped whole; a shaped token we do not recognise is recorded as having been
 * unrecognisable, which is the fact worth keeping without keeping the value.
 */
function providerErrorValue(value: string | undefined) {
  const shaped = match(PROVIDER_ERROR_SHAPE, value);
  if (shaped === null) return null;
  return PROVIDER_ERRORS.has(shaped) ? shaped : UNRECOGNIZED_PROVIDER_ERROR;
}

/**
 * Twelve hex characters, the same convention `installEventHashRef` uses, so the two hashed values
 * in a payload read the same way. Two identical bodies still hash alike, which is what makes a
 * recurring malformed response recognisable without recording what it said.
 */
function hashedBodyShape(value: string) {
  return `hash:${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function bodyShapeValue(value: string | undefined) {
  if (typeof value !== "string" || !value) return null;
  return BODY_TYPES.has(value) || BODY_KEY_LIST.test(value) ? value : hashedBodyShape(value);
}

async function writeInstallEvent(
  client: ServiceClient,
  row: Record<string, unknown>,
  code: string,
) {
  try {
    const { error } = await client.from("audit_log").insert(row);
    if (!error) return;
  } catch {
    // Falls through to the same line: a rejected promise and a returned error are the same
    // outcome to a caller that is not allowed to have one.
  }
  console.error("[install-event] audit write failed", { action: row.action, code });
}

export async function recordInstallStartRefusal(
  input: GhlInstallStartRefusal,
  client: ServiceClient = createSupabaseServiceClient(),
) {
  const code = shaped(input.code) ?? INSTALL_EVENT_UNKNOWN_CODE;
  await writeInstallEvent(client, {
    actor_id: input.actorId,
    tenant_id: input.tenantId,
    action: START_REFUSED_ACTION,
    target_type: "ghl_oauth_state",
    target_id: input.app,
    reason: code,
    payload: {
      before: null,
      after: {
        app: input.app,
        step: "start",
        outcome: "refused",
        error_code: code,
        ...optional("state_ref", match(STATE_REF_SHAPE, input.stateRef)),
        ...environmentNames(input.missingEnv),
      },
    },
  }, code);
}

export async function recordInstallCallbackEvent(
  input: GhlInstallCallbackEvent,
  client: ServiceClient = createSupabaseServiceClient(),
) {
  const code = shaped(input.code) ?? INSTALL_EVENT_UNKNOWN_CODE;
  const action = CALLBACK_ACTIONS[input.app][input.outcome];
  await writeInstallEvent(client, {
    // Null actor on purpose: these four keys are registered system-kind and the insert trigger
    // forbids an actor on them.
    actor_id: null,
    tenant_id: input.tenantId ?? null,
    action,
    target_type: "ghl_oauth_state",
    target_id: input.app,
    reason: code,
    payload: {
      before: null,
      after: {
        app: input.app,
        step: "callback",
        outcome: input.outcome,
        error_code: code,
        ...optional("state_ref", match(STATE_REF_SHAPE, input.stateRef)),
        ...status(input.providerStatus),
        ...optional("body_shape", bodyShapeValue(input.bodyShape)),
        ...optional("provider_error", providerErrorValue(input.providerError)),
        ...environmentNames(input.missingEnv),
      },
    },
  }, code);
}
