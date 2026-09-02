import { describe, expect, it, vi } from "vitest";

import type { GoogleOAuthStateRecord } from "@/lib/integrations/google-calendar-oauth";

import { beginGoogleConnect, createGoogleConnectHandler } from "./handler";

const actor = {
  userId: "coach-1",
  tenantId: "tenant-1",
  role: "coach" as const,
  impersonatingTenant: null,
};

const environment = {
  APP_BASE_URL: "https://setterfi.test",
  GOOGLE_CALENDAR_CLIENT_ID: "client-id",
  GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
};

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn().mockResolvedValue(actor),
    begin: vi.fn().mockResolvedValue({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    }),
  };
}

function get(search = "") {
  return new Request(`https://setterfi.test/api/calendars/google/connect${search}`);
}

function recordingStates() {
  const saved: GoogleOAuthStateRecord[] = [];
  return {
    saved,
    store: {
      save: async (record: GoogleOAuthStateRecord) => { saved.push(record); },
      consume: async () => null,
    },
  };
}

describe("google calendar connect route", () => {
  it("is absent from the product with the flag unset, and never redirects", async () => {
    const deps = { ...dependencies(), enabled: () => false };
    const response = await createGoogleConnectHandler(deps)(get());
    expect(response.status).toBe(404);
    expect(response.headers.get("Location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it.each([
    [null, 401],
    [{ ...actor, role: "admin" as const }, 403],
    [{ ...actor, impersonatingTenant: "tenant-1" }, 403],
  ])("refuses an actor who may not start a connect", async (candidate, status) => {
    const deps = dependencies();
    deps.session.mockResolvedValue(candidate);
    const response = await createGoogleConnectHandler(deps)(get());
    expect(response.status).toBe(status);
    expect(deps.begin).not.toHaveBeenCalled();
  });

  it("sends the coach to Google with a 303 and no store", async () => {
    const deps = dependencies();
    const response = await createGoogleConnectHandler(deps)(get());
    expect(response.status).toBe(303);
    expect(response.headers.get("Location"))
      .toBe("https://accounts.google.com/o/oauth2/v2/auth?state=abc");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(deps.begin).toHaveBeenCalledWith({
      actorId: "coach-1",
      tenantId: "tenant-1",
      returnPath: null,
    });
  });

  it("passes a requested return path through to the issuer", async () => {
    const deps = dependencies();
    await createGoogleConnectHandler(deps)(get("?returnPath=/coach/integrations"));
    expect(deps.begin.mock.calls[0][0].returnPath).toBe("/coach/integrations");
  });

  it("refuses rather than redirecting when the issuer rejects the request", async () => {
    const deps = dependencies();
    deps.begin.mockRejectedValue(new Error("GOOGLE_OAUTH_RETURN_PATH_INVALID"));
    const response = await createGoogleConnectHandler(deps)(get("?returnPath=//evil.test"));
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });
});

describe("beginGoogleConnect", () => {
  it("carries offline access and a forced consent prompt on every connect", async () => {
    const states = recordingStates();
    const { authorizationUrl } = await beginGoogleConnect(
      { actorId: "coach-1", tenantId: "tenant-1", returnPath: null },
      { states: states.store, environment },
    );
    const query = new URL(authorizationUrl).searchParams;
    expect(query.get("access_type")).toBe("offline");
    // Without this a coach who already granted comes back with no refresh token at all.
    expect(query.get("prompt")).toBe("consent");
    expect(query.get("redirect_uri"))
      .toBe("https://setterfi.test/api/calendars/google/callback");
    expect(query.get("response_type")).toBe("code");
  });

  it("writes exactly one state row, holding the hash and never the state itself", async () => {
    const states = recordingStates();
    const { authorizationUrl } = await beginGoogleConnect(
      { actorId: "coach-1", tenantId: "tenant-1", returnPath: null },
      { states: states.store, environment },
    );
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    expect(states.saved).toHaveLength(1);
    expect(states.saved[0]).toMatchObject({
      tenantId: "tenant-1",
      actorId: "coach-1",
      returnPath: "/onboarding/calendar",
    });
    expect(states.saved[0].stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(states.saved[0].stateHash).not.toBe(state);
    expect(JSON.stringify(states.saved[0])).not.toContain(state);
  });

  it.each([
    ["a blank value", ""],
    ["a scheme-relative path", "//evil.test/steal"],
    ["an absolute foreign origin", "https://evil.test/steal"],
  ])("refuses %s as a return path", async (_label, returnPath) => {
    const states = recordingStates();
    await expect(beginGoogleConnect(
      { actorId: "coach-1", tenantId: "tenant-1", returnPath },
      { states: states.store, environment },
    )).rejects.toThrow();
    expect(states.saved).toHaveLength(0);
  });
});
