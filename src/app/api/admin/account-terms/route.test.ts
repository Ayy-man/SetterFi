import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { accountTermsContentHash } from "@/lib/account/terms";
import { AccountTermsPublisherError } from "@/lib/account/terms-publisher";

import { createAccountTermsAdminHandler, parseAccountTermsRequest } from "./handler";

const TERMS_BODY = "Approved account terms.";
const PRIVACY_BODY = "Approved account privacy notice.";
const CONTENT_HASH = accountTermsContentHash(TERMS_BODY, PRIVACY_BODY);

function request(body: unknown) {
  return new Request("https://setterfi.local/api/admin/account-terms", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function dependencies(overrides: Partial<Parameters<typeof createAccountTermsAdminHandler>[0]> = {}) {
  return {
    session: async () => ({ userId: "actor-1", role: "owner" as const }),
    createDraft: vi.fn(async () => ({
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      auditId: "9001",
    })),
    publish: vi.fn(async () => ({
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      publishedAt: "2026-10-02T00:00:00.000Z",
      auditId: "9002",
    })),
    ...overrides,
  };
}

const draftBody = {
  action: "draft",
  versionKey: "2026-10-terms-v1",
  termsBody: TERMS_BODY,
  privacyBody: PRIVACY_BODY,
};

describe("POST /api/admin/account-terms", () => {
  it("records a draft against the signed-in actor and returns its audit receipt", async () => {
    const deps = dependencies();
    const response = await createAccountTermsAdminHandler(deps)(request(draftBody));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      state: "drafted",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      auditId: "9001",
    });
    expect(deps.createDraft).toHaveBeenCalledWith({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      termsBody: TERMS_BODY,
      privacyBody: PRIVACY_BODY,
    });
  });

  it("publishes the exact version and hash pair the admin was shown", async () => {
    const deps = dependencies();
    const response = await createAccountTermsAdminHandler(deps)(request({
      action: "publish",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: "published",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
      publishedAt: "2026-10-02T00:00:00.000Z",
      auditId: "9002",
    });
    expect(deps.publish).toHaveBeenCalledWith({
      actorId: "actor-1",
      versionKey: "2026-10-terms-v1",
      contentHash: CONTENT_HASH,
    });
  });

  /**
   * The registry holds one published row behind a partial unique index. The refusal is the
   * database's, and it has to arrive as a sentence an admin can act on rather than as a generic
   * failure that reads like the request never landed.
   */
  it("states the one-published constraint when a second version is published", async () => {
    const response = await createAccountTermsAdminHandler(dependencies({
      publish: vi.fn(async () => {
        throw new AccountTermsPublisherError("ACCOUNT_TERMS_ALREADY_PUBLISHED");
      }),
    }))(request({ action: "publish", versionKey: "2026-10-terms-v2", contentHash: CONTENT_HASH }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      state: "refused",
      code: "ACCOUNT_TERMS_ALREADY_PUBLISHED",
      error:
        "A version is already published. The registry holds one published version, and it cannot be replaced or withdrawn here.",
    });
  });

  it("does not leak a database message for a refusal it has no sentence for", async () => {
    const response = await createAccountTermsAdminHandler(dependencies({
      publish: vi.fn(async () => { throw new Error("duplicate key value violates unique constraint"); }),
    }))(request({ action: "publish", versionKey: "2026-10-terms-v1", contentHash: CONTENT_HASH }));

    expect(response.status).toBe(409);
    const payload = await response.json() as { error: string };
    expect(payload.error).toBe("The account terms registry refused this change.");
  });

  it.each([
    ["no session", null],
    ["a success reviewer", { userId: "actor-2", role: "success" as const }],
    ["a build operator", { userId: "actor-3", role: "build" as const }],
    ["a coach", { userId: "actor-4", role: "coach" as const }],
  ])("refuses %s before reading the body", async (_label, actor) => {
    const deps = dependencies({ session: async () => actor });
    const response = await createAccountTermsAdminHandler(deps)(request(draftBody));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden." });
    expect(deps.createDraft).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("refuses a body it does not recognise rather than guessing the action", async () => {
    const deps = dependencies();
    for (const body of [
      { action: "unpublish", versionKey: "2026-10-terms-v1" },
      { action: "draft", versionKey: "2026-10-terms-v1", termsBody: TERMS_BODY },
      { action: "draft", versionKey: "  ", termsBody: TERMS_BODY, privacyBody: PRIVACY_BODY },
      { ...draftBody, contentHash: CONTENT_HASH },
      { action: "publish", versionKey: "2026-10-terms-v1", contentHash: "not-a-hash" },
    ]) {
      const response = await createAccountTermsAdminHandler(deps)(request(body));
      expect(response.status).toBe(400);
    }
    expect(deps.createDraft).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it("takes no publish verb that would withdraw the standing version", () => {
    expect(parseAccountTermsRequest({ action: "unpublish", versionKey: "x" })).toBeNull();
    // The well-formed shape too: rejecting the ill-formed one only proves the key check works.
    expect(parseAccountTermsRequest({
      action: "unpublish",
      versionKey: "x",
      contentHash: CONTENT_HASH,
    })).toBeNull();
    expect(parseAccountTermsRequest({
      action: "withdraw",
      versionKey: "x",
      contentHash: CONTENT_HASH,
    })).toBeNull();
    expect(parseAccountTermsRequest({
      action: "publish",
      versionKey: "x",
      contentHash: CONTENT_HASH,
      supersedes: "y",
    })).toBeNull();
  });

  /**
   * The point of the whole mechanism: a version has to exist before `SETTERFI_ACCOUNT_TERMS_LIVE`
   * can be switched on. A publisher gated on that flag could never create the first version, so
   * the absence of the gate is the requirement rather than an oversight.
   */
  it("is not gated on the acceptance flag it exists to make switchable", () => {
    const source = readFileSync(new URL("./handler.ts", import.meta.url), "utf8");
    // The comment at the top of the handler names the flag in order to say why it is absent, so
    // the guard reads the imports rather than the prose: no env gate can be applied without one.
    expect(source).not.toMatch(/from "@\/lib\/env-contract"/u);
    expect(source).not.toMatch(/process\.env/u);
  });
});
