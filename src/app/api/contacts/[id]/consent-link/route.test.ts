import { describe, expect, it, vi } from "vitest";

import type { RouteActor } from "@/lib/auth/actors";

import { createConsentLinkHandler } from "./handler";

const actor: RouteActor = {
  tenantId: "tenant-a",
  userId: "actor-a",
  role: "coach" as const,
  impersonatingTenant: null,
  impersonationSessionId: null,
};
const request = (body: unknown = { identityId: "identity-a" }) => new Request(
  "https://setterfi.test/api/contacts/contact-a/consent-link",
  { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
);
const context = { params: Promise.resolve({ id: "contact-a" }) };

function dependencies() {
  return {
    enabled: () => true,
    session: vi.fn(async () => actor),
    configuration: () => ({ appBaseUrl: "https://setterfi.test", secret: "synthetic-secret" }),
    resolve: vi.fn(async () => ({ tenantSlug: "synthetic-coach", artifactId: "artifact-a" })),
    reserve: vi.fn(async () => undefined),
    now: () => new Date("2026-08-27T00:00:00.000Z"),
  };
}

describe("consent link issuer", () => {
  it("reserves a short-lived one-use binding before returning its signed URL", async () => {
    const deps = dependencies();
    const response = await createConsentLinkHandler(deps)(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.expiresAt).toBe("2026-08-27T00:30:00.000Z");
    const url = new URL(payload.url);
    expect(url.origin + url.pathname).toBe("https://setterfi.test/opt-in/synthetic-coach");
    expect(url.searchParams.get("token")).toMatch(/^[^.]+\.[^.]+$/);
    expect(deps.reserve).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      artifactId: "artifact-a",
      contactIdentityId: "identity-a",
      expiresAt: "2026-08-27T00:30:00.000Z",
      actorId: "actor-a",
    }));
  });

  it("fails closed without auth, configuration, or an exact tenant-scoped identity", async () => {
    const unauthenticated = dependencies();
    unauthenticated.session = vi.fn(async () => null as never);
    expect((await createConsentLinkHandler(unauthenticated)(request(), context)).status).toBe(401);

    const unconfigured = dependencies();
    unconfigured.configuration = () => null as never;
    expect((await createConsentLinkHandler(unconfigured)(request(), context)).status).toBe(503);

    const missing = dependencies();
    missing.resolve = vi.fn(async () => null as never);
    expect((await createConsentLinkHandler(missing)(request(), context)).status).toBe(404);
    expect(missing.reserve).not.toHaveBeenCalled();
  });

  /*
   * A refusal must not cost the lead a redemption.
   *
   * `reserve` used to run before the token and the URL were built, so anything that threw after it
   * returned a 409 with one of the contact's one-use redemptions already spent -- and the coach's
   * natural response, pressing the button again, spent another. A bad base URL is the reachable
   * version of that: `configuration()` validates it at startup, so this stands for every failure
   * between the reservation and the response rather than for this one input.
   */
  it("spends no redemption when the link cannot be built", async () => {
    const unbuildable = dependencies();
    unbuildable.configuration = () => ({ appBaseUrl: "not-a-url", secret: "synthetic-secret" });

    const response = await createConsentLinkHandler(unbuildable)(request(), context);

    expect(response.status).toBe(409);
    expect(unbuildable.reserve).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies and roles that cannot issue consent links", async () => {
    const malformed = dependencies();
    expect((await createConsentLinkHandler(malformed)(request({ identityId: "" }), context)).status).toBe(400);

    const forbidden = dependencies();
    forbidden.session = vi.fn(async () => ({ ...actor, role: "affiliate" as const }));
    expect((await createConsentLinkHandler(forbidden)(request(), context)).status).toBe(403);
  });
});
