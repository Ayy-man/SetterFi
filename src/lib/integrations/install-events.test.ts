import { afterEach, describe, expect, it, vi } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import { GhlOAuthError, ghlOAuthStateHash } from "./ghl-oauth";
import {
  INSTALL_EVENT_UNKNOWN_CODE,
  installEventCode,
  installEventContext,
  installEventStateRef,
  recordInstallCallbackEvent,
  recordInstallStartRefusal,
} from "./install-events";

// Synthetic stand-ins for the five things that may never reach a row. They are asserted against the
// serialized insert, so a field added later that carries one of them fails this file rather than
// leaking quietly.
const AUTHORIZATION_CODE = "synthetic-authorization-code";
const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.synthetic-access-token";
const REFRESH_TOKEN = "synthetic-refresh-token-value";
const CLIENT_SECRET = "sk_live_synthetic_secret";
const STATE = "synthetic_state_token_0123456789abcdefghijk";
const SECRET_SHAPES = /sk_live|sk_test|Bearer |refresh_token|client_secret|access_token|eyJ/;

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{2,63}$/;

type Insert = { table: string; row: Record<string, unknown> };

function recorder(mode: "ok" | "error" | "reject" = "ok") {
  const inserts: Insert[] = [];
  const client = {
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        if (mode === "reject") throw new Error("audit insert exploded");
        return { error: mode === "error" ? { message: "row rejected" } : null };
      },
    }),
  };
  return { client: client as never, inserts };
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function after(insert: Insert) {
  return (insert.row.payload as { after: Record<string, unknown> }).after;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("installEventCode", () => {
  it("passes a provider error code through verbatim", () => {
    for (const code of [
      "GHL_OAUTH_STATE_EXPIRED",
      "GHL_OAUTH_STATE_INVALID_OR_REPLAYED",
      "GHL_OAUTH_STATE_APP_MISMATCH",
      "GHL_OAUTH_GRANT_REVOKED",
      "GHL_OAUTH_TOKEN_EXCHANGE_FAILED_NETWORK",
      "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
    ]) {
      expect(installEventCode(new GhlOAuthError(code, 400, "error,message"))).toBe(code);
    }
  });

  it("keeps a configuration failure's variable names, which are the whole point of recording it", () => {
    const error = new DriverConfigurationError("ghl_provisioning", [
      "GHL_AGENCY_CLIENT_SECRET",
      "GHL_AGENCY_INSTALL_URL",
    ]);
    expect(installEventCode(error)).toBe("DRIVER_CONFIGURATION_ERROR");
    expect(installEventContext(error)).toEqual({
      code: "DRIVER_CONFIGURATION_ERROR",
      missingEnv: ["GHL_AGENCY_CLIENT_SECRET", "GHL_AGENCY_INSTALL_URL"],
    });
  });

  it("carries a provider status and body shape, which name key names and never values", () => {
    expect(installEventContext(new GhlOAuthError("GHL_OAUTH_GRANT_REVOKED", 401, "error,message")))
      .toEqual({
        code: "GHL_OAUTH_GRANT_REVOKED",
        providerStatus: 401,
        bodyShape: "error,message",
      });
  });

  it("accepts a bare Error whose whole message is already a code", () => {
    expect(installEventCode(new Error("GHL_INSTALL_START_AUDIT_FAILED")))
      .toBe("GHL_INSTALL_START_AUDIT_FAILED");
  });

  it("collapses prose, and everything that is not an error, to the one unknown code", () => {
    const prose: unknown[] = [
      new Error("invalid_grant: The authorization code has expired for user@example.com"),
      new Error(`fetch failed https://services.leadconnectorhq.com/oauth/token?client_secret=${CLIENT_SECRET}`),
      new Error("state expired"),
      new Error("A".repeat(200).split("").join(" ").slice(0, 400)),
      "boom",
      null,
      undefined,
      {},
    ];
    for (const value of prose) {
      expect(installEventCode(value)).toBe(INSTALL_EVENT_UNKNOWN_CODE);
    }
  });

  it("returns a code shape for every input it is given, prose included", () => {
    const inputs: unknown[] = [
      new GhlOAuthError("GHL_OAUTH_STATE_EXPIRED"),
      new DriverConfigurationError("ghl", ["GHL_CLIENT_ID"]),
      new Error("GHL_INSTALL_START_AUDIT_FAILED"),
      new Error("invalid_grant: the code expired"),
      "boom",
      null,
      undefined,
      {},
    ];
    for (const value of inputs) {
      expect(installEventCode(value)).toMatch(CODE_SHAPE);
    }
  });
});

describe("installEventStateRef", () => {
  it("is twelve hex characters that reveal nothing of the state they came from", () => {
    const ref = installEventStateRef(STATE);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(STATE).not.toContain(ref);
    expect(ref).not.toContain(STATE.slice(0, 12));
  });

  it("is stable for one state and different across two, so it can group an attempt", () => {
    expect(installEventStateRef(STATE)).toBe(installEventStateRef(STATE));
    expect(installEventStateRef(STATE)).not.toBe(installEventStateRef(`${STATE}x`));
  });

  it("agrees with the hash the state store already uses, so both sides compute one ref", () => {
    expect(installEventStateRef(STATE)).toBe(ghlOAuthStateHash(STATE).slice(0, 12));
  });
});

describe("recordInstallCallbackEvent", () => {
  const cases = [
    { app: "agent", outcome: "declined", action: "channel.messaging_install.declined" },
    { app: "agent", outcome: "failed", action: "channel.messaging_install.failed" },
    { app: "provisioning", outcome: "declined", action: "platform.provisioning_install.declined" },
    { app: "provisioning", outcome: "failed", action: "platform.provisioning_install.failed" },
  ] as const;

  it("picks its registered key from the app and the outcome", async () => {
    for (const entry of cases) {
      const { client, inserts } = recorder();
      await recordInstallCallbackEvent({
        app: entry.app,
        outcome: entry.outcome,
        code: "GHL_OAUTH_STATE_EXPIRED",
        stateRef: installEventStateRef(STATE),
      }, client);
      expect(inserts).toHaveLength(1);
      expect(inserts[0].table).toBe("audit_log");
      expect(inserts[0].row.action).toBe(entry.action);
    }
  });

  it("writes no actor, because those four keys are registered system-kind", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_STATE_EXPIRED",
      tenantId: "tenant-1",
    }, client);
    expect(inserts[0].row.actor_id).toBeNull();
    expect(inserts[0].row.tenant_id).toBe("tenant-1");
  });

  it("puts the code in reason, so the audit page's existing column reads it unchanged", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_GRANT_REVOKED",
    }, client);
    expect(inserts[0].row.reason).toBe("GHL_OAUTH_GRANT_REVOKED");
    expect(after(inserts[0]).error_code).toBe("GHL_OAUTH_GRANT_REVOKED");
  });

  it("targets the same state and app the started row targets", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "provisioning",
      outcome: "failed",
      code: "GHL_OAUTH_STATE_MISSING",
    }, client);
    expect(inserts[0].row.target_type).toBe("ghl_oauth_state");
    expect(inserts[0].row.target_id).toBe("provisioning");
  });

  it("omits every optional field that was not supplied rather than writing it null", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_STATE_MISSING",
    }, client);
    expect(inserts[0].row.payload).toEqual({
      before: null,
      after: { app: "agent", step: "callback", outcome: "failed", error_code: "GHL_OAUTH_STATE_MISSING" },
    });
  });

  it("carries the optional context when it is supplied", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
      stateRef: installEventStateRef(STATE),
      providerStatus: 200,
      bodyShape: "access_token,expires_in",
      missingEnv: ["GHL_CLIENT_SECRET"],
    }, client);
    expect(after(inserts[0])).toEqual({
      app: "agent",
      step: "callback",
      outcome: "failed",
      error_code: "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
      state_ref: installEventStateRef(STATE),
      provider_status: 200,
      body_shape: "access_token,expires_in",
      missing_env: ["GHL_CLIENT_SECRET"],
    });
  });

  it("keeps a provider error only in the shape a provider error has, and drops prose whole", async () => {
    const kept = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "declined",
      code: "GHL_OAUTH_PROVIDER_DECLINED",
      providerError: "access_denied",
    }, kept.client);
    expect(after(kept.inserts[0]).provider_error).toBe("access_denied");

    const dropped = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "declined",
      code: "GHL_OAUTH_PROVIDER_DECLINED",
      providerError: "Access Denied: the user at user@example.com refused",
    }, dropped.client);
    expect(after(dropped.inserts[0])).not.toHaveProperty("provider_error");
  });

  it("writes an unexpected provider error as a constant, not as the provider's own token", async () => {
    // Lowercase and underscored, so the shape check passes it. The shape was never the semantic
    // check — an attacker controls this parameter on a public redirect URL and can put any
    // snake_case token they like in it, and the row it lands in is read by a human.
    const invented = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "declined",
      code: "GHL_OAUTH_PROVIDER_DECLINED",
      providerError: "account_suspended_contact_support",
    }, invented.client);
    expect(after(invented.inserts[0]).provider_error).toBe("unrecognized");

    // All seven RFC 6749 §4.1.2.1 values still land verbatim, because they are what the row is for.
    for (const value of [
      "invalid_request",
      "unauthorized_client",
      "access_denied",
      "unsupported_response_type",
      "invalid_scope",
      "server_error",
      "temporarily_unavailable",
    ]) {
      const { client, inserts } = recorder();
      await recordInstallCallbackEvent({
        app: "agent",
        outcome: "declined",
        code: "GHL_OAUTH_PROVIDER_DECLINED",
        providerError: value,
      }, client);
      expect(after(inserts[0]).provider_error).toBe(value);
    }
  });

  it("hashes a response body whose key names the provider chose for us", async () => {
    const attacker = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
      bodyShape: "contact_admin_at_evil_example_com_to_unlock_this_account",
    }, attacker.client);
    const shape = after(attacker.inserts[0]).body_shape as string;
    expect(shape).toMatch(/^hash:[0-9a-f]{12}$/);
    expect(shape).not.toContain("evil");

    // Same for a key set that is short enough per key but has too many of them to be a real
    // envelope, and for one that smuggles characters a key name does not have.
    for (const value of ["a,b,c,d,e,f,g,h,i", "access_token,note: call 555-0100"]) {
      const { client, inserts } = recorder();
      await recordInstallCallbackEvent({
        app: "agent",
        outcome: "failed",
        code: "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
        bodyShape: value,
      }, client);
      expect(after(inserts[0]).body_shape).toMatch(/^hash:[0-9a-f]{12}$/);
    }

    // The shapes bodyShape() actually emits still read as themselves.
    for (const value of ["access_token,expires_in", "array", "string", "object", "undefined"]) {
      const { client, inserts } = recorder();
      await recordInstallCallbackEvent({
        app: "agent",
        outcome: "failed",
        code: "GHL_OAUTH_TOKEN_ENVELOPE_INVALID",
        bodyShape: value,
      }, client);
      expect(after(inserts[0]).body_shape).toBe(value);
    }
  });

  it("writes nothing longer than 128 characters anywhere in the row", async () => {
    const { client, inserts } = recorder();
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: "GHL_OAUTH_TOKEN_EXCHANGE_FAILED",
      stateRef: installEventStateRef(STATE),
      bodyShape: "x".repeat(400),
      providerError: "y".repeat(200),
      missingEnv: ["Z".repeat(300)],
    }, client);
    for (const value of strings(inserts[0].row)) expect(value.length).toBeLessThanOrEqual(128);
  });
});

describe("recordInstallStartRefusal", () => {
  it("uses one key for both apps and names the app in the target, as the started row does", async () => {
    for (const app of ["agent", "provisioning", "unknown"] as const) {
      const { client, inserts } = recorder();
      await recordInstallStartRefusal({
        app,
        actorId: "00000000-0000-4000-8000-000000000001",
        tenantId: null,
        code: "GHL_INSTALL_START_ROLE_FORBIDDEN",
      }, client);
      expect(inserts[0].row.action).toBe("channel.messaging_install.start_refused");
      expect(inserts[0].row.target_type).toBe("ghl_oauth_state");
      expect(inserts[0].row.target_id).toBe(app);
    }
  });

  it("carries the actor, because the caller is known by the time anything is refused", async () => {
    const { client, inserts } = recorder();
    await recordInstallStartRefusal({
      app: "agent",
      actorId: "00000000-0000-4000-8000-000000000001",
      tenantId: "tenant-1",
      code: "DRIVER_CONFIGURATION_ERROR",
      missingEnv: ["GHL_AGENCY_CLIENT_SECRET"],
    }, client);
    expect(inserts[0].row.actor_id).toBe("00000000-0000-4000-8000-000000000001");
    expect(inserts[0].row.tenant_id).toBe("tenant-1");
    expect(inserts[0].row.reason).toBe("DRIVER_CONFIGURATION_ERROR");
    expect(after(inserts[0])).toEqual({
      app: "agent",
      step: "start",
      outcome: "refused",
      error_code: "DRIVER_CONFIGURATION_ERROR",
      missing_env: ["GHL_AGENCY_CLIENT_SECRET"],
    });
  });
});

describe("the recorder as a security boundary", () => {
  // No bodyShape here: it is key names by construction (`bodyShape()` in ghl-oauth.ts) and a
  // realistic one legitimately reads `access_token,expires_in`. Its guards are the shape and the
  // 128-character cap, asserted above.
  it("writes none of the five secrets, whichever entry point is fed them", async () => {
    const { client, inserts } = recorder();
    await recordInstallStartRefusal({
      app: "agent",
      actorId: "00000000-0000-4000-8000-000000000001",
      tenantId: null,
      code: `GHL_START ${CLIENT_SECRET}`,
      stateRef: STATE,
      missingEnv: [REFRESH_TOKEN, CLIENT_SECRET],
    }, client);
    await recordInstallCallbackEvent({
      app: "agent",
      outcome: "failed",
      code: installEventCode(new Error(`token exchange failed with ${ACCESS_TOKEN}`)),
      stateRef: STATE,
      tenantId: null,
      providerError: AUTHORIZATION_CODE,
      missingEnv: [REFRESH_TOKEN],
    }, client);

    for (const insert of inserts) {
      const serialized = JSON.stringify(insert.row);
      for (const secret of [AUTHORIZATION_CODE, ACCESS_TOKEN, REFRESH_TOKEN, CLIENT_SECRET, STATE]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).not.toMatch(SECRET_SHAPES);
    }
  });

  it("resolves normally when the insert rejects or comes back with an error", async () => {
    const console_error = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const mode of ["reject", "error"] as const) {
      console_error.mockClear();
      const { client } = recorder(mode);
      await expect(recordInstallCallbackEvent({
        app: "agent",
        outcome: "failed",
        code: "GHL_OAUTH_STATE_EXPIRED",
      }, client)).resolves.toBeUndefined();
      expect(console_error).toHaveBeenCalledTimes(1);
      expect(String(console_error.mock.calls[0][0])).toMatch(/^\[install-event]/);
      const logged = JSON.stringify(console_error.mock.calls[0]);
      expect(logged).toContain("channel.messaging_install.failed");
      expect(logged).toContain("GHL_OAUTH_STATE_EXPIRED");
      expect(logged).not.toMatch(SECRET_SHAPES);
    }
  });

  it("says nothing at all when the write lands", async () => {
    const console_error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = recorder();
    await recordInstallStartRefusal({
      app: "agent",
      actorId: "00000000-0000-4000-8000-000000000001",
      tenantId: null,
      code: "GHL_INSTALL_START_ROLE_FORBIDDEN",
    }, client);
    expect(console_error).not.toHaveBeenCalled();
  });
});
