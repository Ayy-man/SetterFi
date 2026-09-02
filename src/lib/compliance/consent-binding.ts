import { createHmac, timingSafeEqual } from "node:crypto";

type ConsentBindingClaims = {
  version: 1;
  tenantId: string;
  artifactId: string;
  contactIdentityId: string;
  formSubmissionId: string;
  expiresAt: string;
};

function encodedClaims(claims: ConsentBindingClaims) {
  return Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
}

function signature(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

export function issueConsentBinding(claims: ConsentBindingClaims, secret: string) {
  if (!secret.trim() || !claims.tenantId.trim() || !claims.artifactId.trim()
    || !claims.contactIdentityId.trim() || !claims.formSubmissionId.trim()
    || !Number.isFinite(Date.parse(claims.expiresAt))) {
    throw new Error("CONSENT_BINDING_INPUT_INVALID");
  }
  const payload = encodedClaims(claims);
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyConsentBinding(input: {
  token: string;
  secret: string;
  tenantId: string;
  artifactId: string;
  now: Date;
}): Pick<ConsentBindingClaims, "contactIdentityId" | "formSubmissionId"> | null {
  const [payload, candidate, extra] = input.token.split(".");
  if (!payload || !candidate || extra !== undefined || !input.secret.trim()) return null;
  const expected = signature(payload, input.secret);
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
    if (Object.keys(claims).sort().join(",") !== [
      "artifactId", "contactIdentityId", "expiresAt", "formSubmissionId", "tenantId", "version",
    ].sort().join(",") || claims.version !== 1 || claims.tenantId !== input.tenantId
      || claims.artifactId !== input.artifactId || typeof claims.contactIdentityId !== "string"
      || !claims.contactIdentityId.trim() || typeof claims.formSubmissionId !== "string"
      || !claims.formSubmissionId.trim() || typeof claims.expiresAt !== "string"
      || !Number.isFinite(Date.parse(claims.expiresAt))
      || Date.parse(claims.expiresAt) <= input.now.getTime()) return null;
    return {
      contactIdentityId: claims.contactIdentityId,
      formSubmissionId: claims.formSubmissionId,
    };
  } catch {
    return null;
  }
}

