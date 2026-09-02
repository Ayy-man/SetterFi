import { describe, expect, it } from "vitest";

import { humanError } from "./errors";

const SEEDED_CODES = [
  "OFFER_DRAFT_READBACK_INCOMPLETE",
  "OFFER_PUBLISH_RECEIPT_INCOMPLETE",
  "OFFER_SAVE_REFUSED",
  "OFFER_PUBLISH_REFUSED",
  "OFFER_READ_FAILED",
  "PLATFORM_PREVIEW_READ_FAILED",
  "ADMIN_BRAIN_READ_FAILED",
  "BILLING_CORRECTIONS_READ_FAILED",
  "COMPLIANCE_READ_FAILED",
  "TEST_AGENT_SESSION_REFUSED",
  "HTTP_401",
  "HTTP_403",
  "HTTP_404",
  "HTTP_409",
  "HTTP_500",
  "HTTP_503",
  "FETCH_TIMEOUT",
] as const;

function sentences(body: string) {
  return body.split(/(?<=[.!?])\s+/);
}

describe("humanError", () => {
  it("keeps an unknown code in technical detail and never exposes it in the body", () => {
    const error = humanError("UNEXPECTED_INTERNAL_FAILURE");

    expect(error.code).toBe("UNEXPECTED_INTERNAL_FAILURE");
    expect(error.body).toContain("Nothing changed");
    expect(error.body).not.toContain("UNEXPECTED_INTERNAL_FAILURE");
    expect(error.body).not.toMatch(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/);
  });

  it.each(SEEDED_CODES)("gives %s the three-part house copy", (code) => {
    const error = humanError(code);
    const bodySentences = sentences(error.body);

    expect(error.code).toBe(code);
    expect(bodySentences).toHaveLength(3);
    expect(bodySentences[1]).toMatch(/^(?:No |Nothing |This screen did not |Your requested change was not )/);
    expect(error.body).not.toContain(code);
  });

  it("uses the stable code before technical detail", () => {
    const error = humanError("ADMIN_BRAIN_READ_FAILED:Invalid API key");

    expect(error.title).toBe("The Brain could not load");
    expect(error.code).toBe("ADMIN_BRAIN_READ_FAILED:Invalid API key");
    expect(error.body).not.toContain("Invalid API key");
  });

  it("names the field when field context is available", () => {
    const error = humanError("HTTP_409", { field: "Minimum credit score" });

    expect(error.body).toContain("Minimum credit score");
    expect(sentences(error.body)[1]).toBe("Your requested change was not applied.");
  });
});
