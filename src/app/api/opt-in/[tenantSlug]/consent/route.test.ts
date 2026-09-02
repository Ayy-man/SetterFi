import { describe, expect, it, vi } from "vitest";

import { validateWebFormConsentEvidence } from "@/lib/compliance/consent-evidence";
import {
  consumeTenantRateLimit,
  tenantRateLimitCallerKey,
  type TenantRateLimitRpcClient,
} from "@/lib/rate-limit/tenant-rate-limit";

import { createConsentHandler } from "./handler";

const artifact = {
  tenantId: "tenant-resolved-from-slug",
  isDemo: false,
  artifactId: "artifact-current",
  templateVersion: "approved-v1",
  marketingLanguage: "Synthetic marketing consent language.",
  nonMarketingLanguage: "Synthetic service consent language.",
};
function dependencies() {
  return {
    enabled: () => true,
    limit: vi.fn().mockResolvedValue({ allowed: true, remaining: 11, retryAfter: 0, store: "shared" as const, reason: null }),
    resolve: vi.fn().mockResolvedValue(artifact),
    validate: validateWebFormConsentEvidence,
    verifyBinding: vi.fn().mockReturnValue({
      contactIdentityId: "identity-1",
      formSubmissionId: "form-1",
    }),
    record: vi.fn().mockResolvedValue({ auditId: "81", actionKey: "consent.web_form_recorded" as const, evidence: {} as never }),
    now: () => new Date("2030-01-02T00:00:00.000Z"),
  };
}
function request(body: unknown, origin = "https://setterfi.test") {
  return new Request("https://setterfi.test/api/opt-in/synthetic-coaching/consent", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
}
function context(slug = "synthetic-coaching") { return { params: Promise.resolve({ tenantSlug: slug }) }; }
const selected = { artifactId: "artifact-current", consentToken: "signed-consent-binding", marketing: true, nonMarketing: true };

function atomicTenantRateLimitClient(): TenantRateLimitRpcClient {
  const windows = new Map<string, { startedAt: number; hits: number }>();
  return {
    rpc: async (_name, args) => {
      const now = new Date(args.p_now).getTime();
      const key = [args.p_tenant_id, args.p_route_key, args.p_caller_key].join("|");
      const existing = windows.get(key);
      const expired = !existing || now >= existing.startedAt + args.p_window_seconds * 1_000;
      const window = expired ? { startedAt: now, hits: 0 } : existing;
      if (window.hits >= args.p_limit) {
        windows.set(key, window);
        return {
          data: [{
            allowed: false,
            remaining: 0,
            retry_after: Math.max(1, args.p_window_seconds - Math.floor((now - window.startedAt) / 1_000)),
          }],
          error: null,
        };
      }
      window.hits += 1;
      windows.set(key, window);
      return {
        data: [{
          allowed: true,
          remaining: args.p_limit - window.hits,
          retry_after: 0,
        }],
        error: null,
      };
    },
  };
}

function databaseBackedLimit(client: TenantRateLimitRpcClient) {
  return (request: Request, resolvedArtifact: typeof artifact) => consumeTenantRateLimit({
    tenantId: resolvedArtifact.tenantId,
    routeKey: "opt-in-consent",
    callerKey: tenantRateLimitCallerKey(request),
    limit: 12,
    windowMs: 15 * 60 * 1_000,
  }, {
    client,
    now: () => new Date("2030-01-02T00:00:00.000Z"),
  });
}

describe("POST /api/opt-in/[tenantSlug]/consent", () => {
  it("records selected consent without a session through the exact repository contract", async () => {
    const deps = dependencies();
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(201);
    expect(deps.resolve).toHaveBeenCalledWith("synthetic-coaching");
    expect(deps.verifyBinding).toHaveBeenCalledWith({
      token: "signed-consent-binding",
      tenantId: "tenant-resolved-from-slug",
      artifactId: "artifact-current",
      now: new Date("2030-01-02T00:00:00.000Z"),
    });
    expect(deps.record).toHaveBeenCalledWith({
      tenantId: "tenant-resolved-from-slug",
      artifactId: "artifact-current",
      contactIdentityId: "identity-1",
      renderedLanguage: "Synthetic marketing consent language.\n\nSynthetic service consent language.",
      pageUrl: "https://setterfi.test/opt-in/synthetic-coaching",
      submittedAt: "2030-01-02T00:00:00.000Z",
      formSubmissionId: "form-1",
      disclosureVersion: "approved-v1",
      purposes: ["follow_up", "agent_reply"],
      channels: ["sms"],
    });
    await expect(response.json()).resolves.toMatchObject({
      outcome: "consent_recorded",
      consentRecorded: true,
      message: "Your selected messaging consent was recorded.",
      receipt: { auditId: "81", actionKey: "consent.web_form_recorded" },
    });
  });

  it("reports an unrecorded no-selection outcome without writing consent or a send", async () => {
    const deps = dependencies();
    const response = await createConsentHandler(deps)(request({ artifactId: "artifact-current", consentToken: null, marketing: false, nonMarketing: false }), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      outcome: "no_consent_selected",
      consentRecorded: false,
      isDemo: false,
      message: "No messaging consent was selected, so no consent evidence was recorded.",
    });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { ...selected, consentToken: null }],
    ["caller-selected identity", { ...selected, contactIdentityId: "identity-other" }],
  ])("refuses a %s binding before persistence", async (_label, body) => {
    const deps = dependencies();
    const response = await createConsentHandler(deps)(request(body), context());
    expect(response.status).toBe(400);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("refuses a token that does not bind the resolved tenant, artifact, identity, and submission", async () => {
    const deps = dependencies();
    deps.verifyBinding.mockReturnValue(null);
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(403);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it.each([
    ["origin", request(selected, "https://elsewhere.test"), context(), 403],
    ["slug", request(selected), context("Synthetic-Coaching"), 404],
    ["artifact", request({ ...selected, artifactId: "caller-selected" }), context(), 400],
  ])("refuses %s mismatch before persistence", async (_label, req, ctx, status) => {
    const deps = dependencies();
    const response = await createConsentHandler(deps)(req, ctx);
    expect(response.status).toBe(status);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("returns Retry-After without resolving tenant data", async () => {
    const deps = dependencies();
    deps.limit.mockResolvedValue({ allowed: false, remaining: 0, retryAfter: 29, store: "shared", reason: null });
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("29");
    expect(deps.resolve).toHaveBeenCalledWith("synthetic-coaching");
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("refuses when the shared limiter store cannot be read", async () => {
    const deps = dependencies();
    deps.limit.mockResolvedValue({
      allowed: false,
      remaining: 0,
      retryAfter: 900,
      store: "error",
      reason: "RATE_LIMIT_STORE_UNAVAILABLE",
    });
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("900");
    await expect(response.json()).resolves.toMatchObject({ code: "RATE_LIMIT_STORE_UNAVAILABLE" });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("holds one database-backed window across independent handler instances", async () => {
    const client = atomicTenantRateLimitClient();
    const firstDependencies = dependencies();
    const secondDependencies = dependencies();
    // dependencies() types limit as a Mock, so the database-backed implementation is wrapped
    // rather than assigned raw.
    firstDependencies.limit = vi.fn(databaseBackedLimit(client));
    secondDependencies.limit = vi.fn(databaseBackedLimit(client));
    const firstHandler = createConsentHandler(firstDependencies);
    const secondHandler = createConsentHandler(secondDependencies);

    for (let index = 0; index < 12; index += 1) {
      const handler = index % 2 === 0 ? firstHandler : secondHandler;
      await expect(handler(request(selected), context())).resolves.toMatchObject({ status: 201 });
    }

    const blocked = await secondHandler(request(selected), context());
    expect(blocked.status).toBe(429);
    expect(firstDependencies.record).toHaveBeenCalledTimes(6);
    expect(secondDependencies.record).toHaveBeenCalledTimes(6);
  });

  it("fails loudly when the Phase 3 validator seam is absent", async () => {
    const deps = { ...dependencies(), validate: null };
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: "PHASE3_CONSENT_CONTRACT_MISSING" });
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("refuses unverified validator output before repository work", async () => {
    const deps = dependencies();
    deps.validate = vi.fn().mockReturnValue({ kind: "unverified", reason: "invalid" });
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(400);
    expect(deps.record).not.toHaveBeenCalled();
  });

  it("normalizes repository failures without raw details", async () => {
    const deps = dependencies();
    deps.record.mockRejectedValue(new Error("SQL provider credential detail"));
    const response = await createConsentHandler(deps)(request(selected), context());
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).not.toMatch(/sql|provider|credential/i);
  });
});
