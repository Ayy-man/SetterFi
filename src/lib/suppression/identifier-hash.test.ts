import { describe, expect, it } from "vitest";

import { DriverConfigurationError } from "@/lib/env-contract";

import {
  hashSuppressionIdentifier,
  IdentifierHashInputError,
} from "./identifier-hash";

const IDENTIFIER_SENTINEL = "+15555550123";
const PEPPER_SENTINEL = "pepper-sentinel-that-must-never-render";

describe("suppression identifier hashing", () => {
  it("returns a deterministic lowercase HMAC without rendering either sentinel", () => {
    const environment = { SETTERFI_SUPPRESSION_PEPPER: PEPPER_SENTINEL };
    const first = hashSuppressionIdentifier(IDENTIFIER_SENTINEL, environment);
    const second = hashSuppressionIdentifier(IDENTIFIER_SENTINEL, environment);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toContain(IDENTIFIER_SENTINEL);
    expect(first).not.toContain(PEPPER_SENTINEL);
  });

  it("fails closed by variable name when the pepper is absent", () => {
    try {
      hashSuppressionIdentifier(IDENTIFIER_SENTINEL, {});
      throw new Error("expected missing pepper to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DriverConfigurationError);
      expect(error).toMatchObject({
        driver: "suppression",
        variableNames: ["SETTERFI_SUPPRESSION_PEPPER"],
      });
      expect(String(error)).not.toContain(IDENTIFIER_SENTINEL);
      expect(String(error)).not.toContain(PEPPER_SENTINEL);
    }
  });

  it.each(["", ` ${IDENTIFIER_SENTINEL}`, `${IDENTIFIER_SENTINEL} `, "value\nother"])(
    "rejects non-normalized input without reflecting %j",
    (value) => {
      expect(() => hashSuppressionIdentifier(value, {
        SETTERFI_SUPPRESSION_PEPPER: PEPPER_SENTINEL,
      })).toThrow(IdentifierHashInputError);
      try {
        hashSuppressionIdentifier(value, { SETTERFI_SUPPRESSION_PEPPER: PEPPER_SENTINEL });
      } catch (error) {
        if (value) expect(String(error)).not.toContain(value);
        expect(String(error)).not.toContain(PEPPER_SENTINEL);
      }
    },
  );
});
