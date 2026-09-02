import { describe, expect, it } from "vitest";

import { issueConsentBinding, verifyConsentBinding } from "./consent-binding";

const claims = {
  version: 1 as const,
  tenantId: "tenant-1",
  artifactId: "artifact-1",
  contactIdentityId: "identity-1",
  formSubmissionId: "submission-1",
  expiresAt: "2030-01-03T00:00:00.000Z",
};

describe("consent binding", () => {
  it("returns only the signed identity and submission for the expected tenant artifact", () => {
    const token = issueConsentBinding(claims, "synthetic-secret");
    expect(verifyConsentBinding({
      token, secret: "synthetic-secret", tenantId: "tenant-1", artifactId: "artifact-1",
      now: new Date("2030-01-02T00:00:00.000Z"),
    })).toEqual({ contactIdentityId: "identity-1", formSubmissionId: "submission-1" });
  });

  it.each([
    ["wrong secret", { secret: "other-secret" }],
    ["wrong tenant", { tenantId: "tenant-2" }],
    ["wrong artifact", { artifactId: "artifact-2" }],
    ["expired", { now: new Date("2030-01-03T00:00:00.000Z") }],
  ])("refuses %s", (_label, override) => {
    const token = issueConsentBinding(claims, "synthetic-secret");
    expect(verifyConsentBinding({
      token, secret: "synthetic-secret", tenantId: "tenant-1", artifactId: "artifact-1",
      now: new Date("2030-01-02T00:00:00.000Z"), ...override,
    })).toBeNull();
  });

  it("refuses a modified payload even when it remains valid base64 JSON", () => {
    const token = issueConsentBinding(claims, "synthetic-secret");
    const [, signature] = token.split(".");
    const payload = Buffer.from(JSON.stringify({ ...claims, contactIdentityId: "identity-2" }))
      .toString("base64url");
    expect(verifyConsentBinding({
      token: `${payload}.${signature}`, secret: "synthetic-secret", tenantId: "tenant-1",
      artifactId: "artifact-1", now: new Date("2030-01-02T00:00:00.000Z"),
    })).toBeNull();
  });
});

