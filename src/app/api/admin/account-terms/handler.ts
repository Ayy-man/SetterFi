/**
 * The platform-admin write surface for the account-terms registry: create a draft, publish one.
 *
 * **This route is deliberately not gated on `accountTermsLive`.** The flag arms the read and
 * accept side: signup only asks for acceptance once it is on, and `/api/account/terms` only serves
 * the document once it is on. Publishing has to happen before that, because switching the flag on
 * against an empty registry is exactly the failure this closes. Gating the publisher on the same
 * flag would make the version impossible to create until the flag was already live.
 *
 * Authority is the actor's platform role, checked here and again inside the RPC.
 */

import {
  ACCOUNT_TERMS_BODY_MAX,
  ACCOUNT_TERMS_VERSION_KEY_MAX,
  createAccountTermsDraft,
  publishAccountTermsVersion,
  type AccountTermsDraftReceipt,
  type AccountTermsPublishReceipt,
} from "@/lib/account/terms-publisher";
import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";

const NO_STORE = { "Cache-Control": "no-store" };
const HEX64 = /^[0-9a-f]{64}$/;

export type AccountTermsAdminDependencies = {
  session(): Promise<PlatformActor | null>;
  createDraft(input: {
    actorId: string;
    versionKey: string;
    termsBody: string;
    privacyBody: string;
  }): Promise<AccountTermsDraftReceipt>;
  publish(input: {
    actorId: string;
    versionKey: string;
    contentHash: string;
  }): Promise<AccountTermsPublishReceipt>;
};

type DraftRequest = { action: "draft"; versionKey: string; termsBody: string; privacyBody: string };
type PublishRequest = { action: "publish"; versionKey: string; contentHash: string };

/**
 * The refusals an admin is entitled to see stated. Everything else collapses to one message,
 * because a database error text on an admin screen is a leak, not an explanation.
 */
const REFUSAL_MESSAGE: Record<string, string> = {
  ACCOUNT_TERMS_ALREADY_PUBLISHED:
    "A version is already published. The registry holds one published version, and it cannot be replaced or withdrawn here.",
  ACCOUNT_TERMS_VERSION_KEY_TAKEN: "That version key already exists. Choose another key.",
  ACCOUNT_TERMS_DRAFT_NOT_FOUND: "That draft no longer matches the registry. Reload and try again.",
  ACCOUNT_TERMS_ACTOR_FORBIDDEN: "This account may not publish account terms.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(body).sort().join(",") === [...keys].sort().join(",");
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && Boolean(value.trim()) && value.length <= max;
}

export function parseAccountTermsRequest(value: unknown): DraftRequest | PublishRequest | null {
  if (!isRecord(value)) return null;
  if (value.action === "draft") {
    if (
      !exactKeys(value, ["action", "versionKey", "termsBody", "privacyBody"])
      || !boundedText(value.versionKey, ACCOUNT_TERMS_VERSION_KEY_MAX)
      || !boundedText(value.termsBody, ACCOUNT_TERMS_BODY_MAX)
      || !boundedText(value.privacyBody, ACCOUNT_TERMS_BODY_MAX)
    ) return null;
    return {
      action: "draft",
      versionKey: value.versionKey.trim(),
      termsBody: value.termsBody,
      privacyBody: value.privacyBody,
    };
  }
  if (value.action === "publish") {
    if (
      !exactKeys(value, ["action", "versionKey", "contentHash"])
      || !boundedText(value.versionKey, ACCOUNT_TERMS_VERSION_KEY_MAX)
      || typeof value.contentHash !== "string"
      || !HEX64.test(value.contentHash)
    ) return null;
    return { action: "publish", versionKey: value.versionKey.trim(), contentHash: value.contentHash };
  }
  return null;
}

function isPublishingAdmin(actor: PlatformActor | null): actor is PlatformActor {
  return actor?.role === "owner" || actor?.role === "admin";
}

function refusal(error: unknown) {
  const code = error instanceof Error ? error.message : "ACCOUNT_TERMS_WRITE_REFUSED";
  return Response.json(
    {
      state: "refused",
      code,
      error: REFUSAL_MESSAGE[code] ?? "The account terms registry refused this change.",
    },
    { status: 409, headers: NO_STORE },
  );
}

export function createAccountTermsAdminHandler(dependencies: AccountTermsAdminDependencies) {
  return async function POST(request: Request) {
    const actor = await dependencies.session();
    if (!isPublishingAdmin(actor)) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    let parsed: DraftRequest | PublishRequest | null = null;
    try {
      parsed = parseAccountTermsRequest(await request.json());
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return Response.json(
        { error: "The account terms request is invalid." },
        { status: 400, headers: NO_STORE },
      );
    }
    try {
      if (parsed.action === "draft") {
        const receipt = await dependencies.createDraft({
          actorId: actor.userId,
          versionKey: parsed.versionKey,
          termsBody: parsed.termsBody,
          privacyBody: parsed.privacyBody,
        });
        return Response.json({ state: "drafted", ...receipt }, { status: 201, headers: NO_STORE });
      }
      const receipt = await dependencies.publish({
        actorId: actor.userId,
        versionKey: parsed.versionKey,
        contentHash: parsed.contentHash,
      });
      return Response.json({ state: "published", ...receipt }, { headers: NO_STORE });
    } catch (error) {
      return refusal(error);
    }
  };
}

export const POST = createAccountTermsAdminHandler({
  session: loadPlatformActor,
  createDraft: createAccountTermsDraft,
  publish: publishAccountTermsVersion,
});
