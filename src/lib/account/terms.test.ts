import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  accountTermsContentHash,
  AccountTermsError,
  loadCurrentAccountTerms,
  publishedAccountTerms,
} from "@/lib/account/terms";

const TERMS = "Approved account terms.";
const PRIVACY = "Approved account privacy notice.";
const HASH = accountTermsContentHash(TERMS, PRIVACY);

describe("account terms registry", () => {
  it("returns an explicit none-published state without inventing legal copy", async () => {
    await expect(loadCurrentAccountTerms(async () => null)).resolves.toEqual({ state: "none_published" });
  });

  it("returns the exact published version and verifies its content hash", async () => {
    await expect(loadCurrentAccountTerms(async () => ({
      version_key: "2026-09-terms-v1",
      content_hash: HASH,
      published_at: "2026-09-01T00:00:00.000Z",
      terms_body: TERMS,
      privacy_body: PRIVACY,
    }))).resolves.toEqual({
      state: "published",
      versionKey: "2026-09-terms-v1",
      contentHash: HASH,
      publishedAt: "2026-09-01T00:00:00.000Z",
      termsBody: TERMS,
      privacyBody: PRIVACY,
    });
  });

  it("fails closed when stored text and its claimed hash disagree", () => {
    expect(() => publishedAccountTerms({
      version_key: "2026-09-terms-v1",
      content_hash: createHash("sha256").update("wrong", "utf8").digest("hex"),
      published_at: "2026-09-01T00:00:00.000Z",
      terms_body: TERMS,
      privacy_body: PRIVACY,
    })).toThrow(new AccountTermsError("ACCOUNT_TERMS_CONTENT_HASH_INVALID"));
  });
});
