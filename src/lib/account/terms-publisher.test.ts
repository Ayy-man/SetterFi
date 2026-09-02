import { describe, expect, it, vi } from "vitest";

import { accountTermsContentHash } from "@/lib/account/terms";
import {
  AccountTermsPublisherError,
  createAccountTermsDraft,
  loadAccountTermsRegistry,
  publishAccountTermsVersion,
  type AccountTermsPublisherDependencies,
  type AccountTermsVersionRow,
} from "@/lib/account/terms-publisher";

const TERMS_BODY = "Approved account terms.";
const PRIVACY_BODY = "Approved account privacy notice.";
const CONTENT_HASH = accountTermsContentHash(TERMS_BODY, PRIVACY_BODY);

function deps(overrides: Partial<AccountTermsPublisherDependencies> = {}): AccountTermsPublisherDependencies {
  return {
    rpc: vi.fn(async () => []),
    listVersions: vi.fn(async () => []),
    ...overrides,
  };
}

function draftRow(versionKey: string): AccountTermsVersionRow {
  return {
    versionKey,
    contentHash: CONTENT_HASH,
    state: "draft",
    createdAt: "2026-10-01T00:00:00.000Z",
    publishedAt: null,
  };
}

describe("the account terms publisher", () => {
  it("hashes the two bodies it is storing rather than trusting a supplied hash", async () => {
    const rpc = vi.fn(async () => [{
      terms_version_id: "11111111-1111-4111-8111-111111111111",
      terms_version_key: "2026-10-terms-v1",
      terms_content_hash: CONTENT_HASH,
      audit_id: 9001,
    }]);

    const receipt = await createAccountTermsDraft({
      actorId: "actor-1",
      versionKey: "  2026-10-terms-v1  ",
      termsBody: TERMS_BODY,
      privacyBody: PRIVACY_BODY,
    }, deps({ rpc }));

    expect(rpc).toHaveBeenCalledWith("create_account_terms_draft", {
      p_actor_id: "actor-1",
      p_version_key: "2026-10-terms-v1",
      p_terms_body: TERMS_BODY,
      p_privacy_body: PRIVACY_BODY,
      p_content_hash: CONTENT_HASH,
    });
    expect(receipt).toEqual({
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      auditId: "9001",
    });
  });

  /**
   * The two bodies are joined with U+001F before hashing, and the table's CHECK recomputes exactly
   * that. A separator-free concatenation would give the same hash to two different documents whose
   * boundary moved, which is the one thing an acceptance record cannot survive.
   */
  it("separates the two bodies so a moved boundary is a different document", () => {
    expect(accountTermsContentHash("ab", "c")).not.toBe(accountTermsContentHash("a", "bc"));
  });

  it("refuses a receipt that does not describe what was sent", async () => {
    const rpc = vi.fn(async () => [{
      terms_version_key: "2026-10-terms-v2",
      terms_content_hash: CONTENT_HASH,
      audit_id: 9001,
    }]);

    await expect(createAccountTermsDraft({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      termsBody: TERMS_BODY,
      privacyBody: PRIVACY_BODY,
    }, deps({ rpc }))).rejects.toThrow("ACCOUNT_TERMS_DRAFT_RECEIPT_INVALID");
  });

  it("carries the database's named refusal out instead of flattening it", async () => {
    const rpc = vi.fn(async () => {
      throw new Error('unexpected exception: ACCOUNT_TERMS_ALREADY_PUBLISHED');
    });

    await expect(publishAccountTermsVersion({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v2",
      contentHash: CONTENT_HASH,
    }, deps({ rpc }))).rejects.toThrow("ACCOUNT_TERMS_ALREADY_PUBLISHED");
  });

  /**
   * The publish path needs its own version of the draft receipt check. Trusting the row would let
   * a function that published something else report the pair the admin asked for, which is exactly
   * the claim the audit trail rests on.
   */
  it("refuses a publish receipt naming a different version than the one requested", async () => {
    const rpc = vi.fn(async () => [{
      terms_version_id: "11111111-1111-4111-8111-111111111111",
      terms_version_key: "2026-10-terms-v9",
      terms_content_hash: CONTENT_HASH,
      terms_published_at: "2026-10-02T09:30:00.000Z",
      audit_id: 9002,
    }]);

    await expect(publishAccountTermsVersion({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
    }, deps({ rpc }))).rejects.toThrow("ACCOUNT_TERMS_PUBLISH_RECEIPT_INVALID");
  });

  it("reduces an unnamed database failure to one code and no message", async () => {
    const rpc = vi.fn(async () => { throw new Error('relation "x" does not exist'); });

    await expect(publishAccountTermsVersion({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
    }, deps({ rpc }))).rejects.toThrow("ACCOUNT_TERMS_WRITE_REFUSED");
  });

  it("will not publish against a hash that is not a hash", async () => {
    const rpc = vi.fn(async () => []);

    await expect(publishAccountTermsVersion({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      contentHash: "not-a-hash",
    }, deps({ rpc }))).rejects.toBeInstanceOf(AccountTermsPublisherError);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("returns the publication timestamp the database recorded, never one it invented", async () => {
    const rpc = vi.fn(async () => [{
      terms_version_id: "11111111-1111-4111-8111-111111111111",
      terms_version_key: "2026-10-terms-v1",
      terms_content_hash: CONTENT_HASH,
      terms_published_at: "2026-10-02T09:30:00.000Z",
      audit_id: "9002",
    }]);

    await expect(publishAccountTermsVersion({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
    }, deps({ rpc }))).resolves.toEqual({
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      publishedAt: "2026-10-02T09:30:00.000Z",
      auditId: "9002",
    });
  });

  it("reads an empty registry as nothing published rather than as a failure", async () => {
    await expect(loadAccountTermsRegistry(deps())).resolves.toEqual({ published: null, drafts: [] });
  });

  it("splits the standing version from the drafts behind it", async () => {
    const registry = await loadAccountTermsRegistry(deps({
      listVersions: async () => [
        draftRow("2026-10-terms-v2"),
        {
          versionKey: "2026-10-terms-v1",
          contentHash: CONTENT_HASH,
          state: "published",
          createdAt: "2026-09-30T00:00:00.000Z",
          publishedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    }));

    expect(registry.published?.versionKey).toBe("2026-10-terms-v1");
    expect(registry.drafts.map((row) => row.versionKey)).toEqual(["2026-10-terms-v2"]);
  });

  /**
   * A partial unique index makes two published rows impossible, so reading two means the registry
   * is not what the schema says it is. Picking one would put a document in front of a signer-upper
   * that nobody can prove was the published one.
   */
  it("refuses to choose between two published versions", async () => {
    await expect(loadAccountTermsRegistry(deps({
      listVersions: async () => ["a", "b"].map((key) => ({
        versionKey: key,
        contentHash: CONTENT_HASH,
        state: "published" as const,
        createdAt: "2026-09-30T00:00:00.000Z",
        publishedAt: "2026-10-01T00:00:00.000Z",
      })),
    }))).rejects.toThrow("ACCOUNT_TERMS_REGISTRY_AMBIGUOUS");
  });
});
