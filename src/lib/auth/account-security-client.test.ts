import { afterEach, describe, expect, it, vi } from "vitest";

import {
  changeAccountPassword,
  loadAccountSecuritySessions,
  requestAccountEmailVerification,
  revokeAccountSecuritySession,
} from "@/lib/auth/account-security-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("account-security browser contracts", () => {
  it("accepts only the public session projection plus its exact audit receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      sessions: [{
        id: "16f9588f-5933-45c4-83f9-e21b1d077a6a",
        startedAt: "2026-08-30T10:00:00.000Z",
        lastSeenAt: null,
        ipAddress: null,
        userAgent: null,
        isCurrent: true,
      }],
      audit: { id: 90, action: "auth.sessions.viewed" },
    })));

    await expect(loadAccountSecuritySessions()).resolves.toEqual({
      ok: true,
      value: {
        sessions: [{
          id: "16f9588f-5933-45c4-83f9-e21b1d077a6a",
          startedAt: "2026-08-30T10:00:00.000Z",
          lastSeenAt: null,
          ipAddress: null,
          userAgent: null,
          isCurrent: true,
        }],
        audit: { id: 90, action: "auth.sessions.viewed" },
      },
    });
  });

  it("does not turn a successful HTTP status with the wrong receipt into product success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      message: "Password changed.",
      audit: { id: 91, action: "something.else" },
    })));

    await expect(changeAccountPassword({
      currentPassword: "current-password",
      password: "replacement-password",
    })).resolves.toEqual({
      ok: false,
      message: "The password could not be changed. Your existing password is still active.",
      status: 200,
      retryAfter: null,
    });
  });

  it("sends same-origin JSON mutations and preserves throttling guidance", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { error: "Too many account-security requests." },
      { status: 429, headers: { "retry-after": "61" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeAccountSecuritySession(
      "91445f12-29c4-4a9f-9a33-d984f854df99",
      "Unrecognized device",
    )).resolves.toEqual({
      ok: false,
      message: "Too many account-security requests.",
      status: 429,
      retryAfter: 61,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/account/security/sessions/91445f12-29c4-4a9f-9a33-d984f854df99",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ reason: "Unrecognized device" }),
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("requests verification only for the provider email and accepts the exact generic contract", async () => {
    const fetchMock = vi.fn(async () => Response.json(
      { message: "If an eligible account matches that email address, we have sent instructions." },
      { status: 202 },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(requestAccountEmailVerification("coach@example.test")).resolves.toEqual({
      ok: true,
      value: {
        message: "If an eligible account matches that email address, we have sent instructions.",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/resend-verification",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "coach@example.test", next: "/account/security" }),
      }),
    );
  });

  it("does not treat an unexpected verification response as provider acceptance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { message: "Verification email sent." },
      { status: 202 },
    )));

    await expect(requestAccountEmailVerification("coach@example.test")).resolves.toEqual({
      ok: false,
      message: "Verification instructions could not be requested. The sign-in email is unchanged.",
      status: 202,
      retryAfter: null,
    });
  });
});
