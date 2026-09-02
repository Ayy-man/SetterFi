import { describe, expect, it } from "vitest";

import {
  endImpersonation,
  impersonatedReadContext,
  startImpersonation,
  tagImpersonatedRead,
  type ImpersonationSession,
} from "@/lib/impersonation";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const EXPIRES = "2026-08-17T12:30:00.000Z";

function session(overrides: Partial<ImpersonationSession> = {}): ImpersonationSession {
  return {
    id: "session-1",
    actorId: "actor-1",
    tenantId: "tenant-a",
    reason: "Review onboarding state",
    startedAt: NOW.toISOString(),
    endedAt: null,
    expiresAt: EXPIRES,
    ...overrides,
  };
}

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "actor-1",
    app_metadata: {
      role: "admin",
      tenant_id: null,
      impersonating_tenant: "tenant-a",
      impersonation_session_id: "session-1",
      ...overrides,
    },
  };
}

describe("impersonation lifecycle", () => {
  it("starts a reasoned session and proves the exact thirty-minute read-back", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const result = await startImpersonation(
      { id: "actor-1", role: "success" },
      "tenant-a",
      " Review onboarding state ",
      NOW,
      {
        rpc: async (name, args) => {
          calls.push({ name, args });
          return "session-1";
        },
        loadSession: async () => session(),
      },
    );

    expect(result).toEqual(session());
    expect(calls).toEqual([
      {
        name: "start_impersonation",
        args: {
          p_expected_tenant: "tenant-a",
          p_actor_id: "actor-1",
          p_reason: "Review onboarding state",
          p_now: NOW.toISOString(),
        },
      },
    ]);
  });

  it("refuses build before an RPC can create a session", async () => {
    let called = false;
    await expect(
      startImpersonation(
        { id: "actor-1", role: "build" },
        "tenant-a",
        "Review",
        NOW,
        {
          rpc: async () => {
            called = true;
            return "session-1";
          },
          loadSession: async () => session(),
        },
      ),
    ).rejects.toThrow("IMPERSONATION_ROLE_FORBIDDEN:build");
    expect(called).toBe(false);
  });

  it("ends through the named RPC and makes the persisted session unusable", async () => {
    const endedAt = new Date("2026-08-17T12:10:00.000Z");
    let ended = false;
    const dependencies = {
      rpc: async () => {
        ended = true;
        return 42;
      },
      loadSession: async () => session({ endedAt: ended ? endedAt.toISOString() : null }),
    };
    const result = await endImpersonation(
      "actor-1",
      "session-1",
      endedAt,
      dependencies,
    );
    expect(result.auditId).toBe("42");
    expect(() => impersonatedReadContext(claims(), result.session, endedAt)).toThrow(
      "IMPERSONATION_SESSION_ENDED",
    );
  });
});

describe("impersonatedReadContext", () => {
  it("preserves the hook-issued session ID on an active read context", () => {
    const context = impersonatedReadContext(claims(), session(), NOW);
    expect(context).toEqual({
      kind: "impersonated_read",
      actorId: "actor-1",
      tenantId: "tenant-a",
      sessionId: "session-1",
      reason: "Review onboarding state",
      expiresAt: EXPIRES,
    });
    expect(tagImpersonatedRead(context, { resource: "conversations" })).toEqual({
      resource: "conversations",
      impersonationSessionId: "session-1",
    });
  });

  it("fails closed when the exact session claim does not match", () => {
    expect(() =>
      impersonatedReadContext(
        claims({ impersonation_session_id: "session-forged" }),
        session(),
        NOW,
      ),
    ).toThrow("IMPERSONATION_CLAIM_SESSION_MISMATCH");
  });

  it("fails closed at the expiry boundary", () => {
    expect(() =>
      impersonatedReadContext(claims(), session(), new Date(EXPIRES)),
    ).toThrow("IMPERSONATION_SESSION_EXPIRED");
  });

  it("rejects a shorter session rather than weakening the exact duration contract", () => {
    expect(() =>
      impersonatedReadContext(
        claims(),
        session({ expiresAt: "2026-08-17T12:29:59.999Z" }),
        NOW,
      ),
    ).toThrow("IMPERSONATION_DURATION_INVALID");
  });
});
