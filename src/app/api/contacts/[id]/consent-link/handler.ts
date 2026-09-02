import { randomUUID } from "node:crypto";

import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { issueConsentBinding } from "@/lib/compliance/consent-binding";
import { environmentValue, phase5Live } from "@/lib/env-contract";
import { optInArtifactIsPublished } from "@/lib/onboarding/artifacts";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const NO_STORE = { "Cache-Control": "no-store" };
const LINK_TTL_MS = 30 * 60 * 1_000;

type ConsentLinkDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  configuration(): { appBaseUrl: string; secret: string } | null;
  resolve(input: { tenantId: string; contactId: string; identityId: string }): Promise<{
    tenantSlug: string;
    artifactId: string;
  } | null>;
  reserve(input: {
    tenantId: string;
    artifactId: string;
    contactIdentityId: string;
    formSubmissionId: string;
    expiresAt: string;
    actorId: string;
  }): Promise<void>;
  now(): Date;
};

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).join(",") !== "identityId" || typeof row.identityId !== "string"
    || !row.identityId.trim()) return null;
  return { identityId: row.identityId.trim() };
}

export function createConsentLinkHandler(dependencies: ConsentLinkDependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (!["owner", "admin", "coach"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    const configuration = dependencies.configuration();
    if (!configuration) {
      return Response.json({ error: "Consent links are unavailable." }, { status: 503, headers: NO_STORE });
    }
    try {
      const parsed = body(await request.json());
      if (!parsed) return Response.json({ error: "Consent link request is invalid." }, { status: 400, headers: NO_STORE });
      const { id: contactId } = await context.params;
      const target = await dependencies.resolve({
        tenantId: actor.tenantId,
        contactId,
        identityId: parsed.identityId,
      });
      if (!target) return Response.json({ error: "Consent target was not found." }, { status: 404, headers: NO_STORE });
      const now = dependencies.now();
      const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();
      const formSubmissionId = randomUUID();
      /*
       * The token and the URL are built before the redemption is reserved, and the order is the
       * point rather than a tidy-up.
       *
       * `reserve` spends one of a contact's redemptions. It used to run first, so anything that
       * failed after it -- `issueConsentBinding` on a malformed secret, `new URL` on a base that
       * parsed at startup and no longer does -- returned a 409 with the redemption already gone,
       * and the coach's retry spent another. Nothing here writes until every step that can fail
       * has produced a value, so a refusal costs the lead nothing.
       */
      const token = issueConsentBinding({
        version: 1,
        tenantId: actor.tenantId,
        artifactId: target.artifactId,
        contactIdentityId: parsed.identityId,
        formSubmissionId,
        expiresAt,
      }, configuration.secret);
      const url = new URL(`/opt-in/${encodeURIComponent(target.tenantSlug)}`, configuration.appBaseUrl);
      url.searchParams.set("token", token);
      await dependencies.reserve({
        tenantId: actor.tenantId,
        artifactId: target.artifactId,
        contactIdentityId: parsed.identityId,
        formSubmissionId,
        expiresAt,
        actorId: actor.userId,
      });
      return Response.json({ url: url.toString(), expiresAt }, { status: 201, headers: NO_STORE });
    } catch {
      return Response.json({ error: "Consent link could not be created." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const POST = createConsentLinkHandler({
  enabled: phase5Live,
  session: loadRouteActor,
  configuration: () => {
    const appBaseUrl = environmentValue("APP_BASE_URL");
    const secret = environmentValue("SETTERFI_TAG_SECRET");
    if (!appBaseUrl || !secret) return null;
    try {
      const url = new URL(appBaseUrl);
      if (url.protocol !== "https:" && url.hostname !== "localhost") return null;
      return { appBaseUrl: url.origin, secret };
    } catch {
      return null;
    }
  },
  /*
   * The artifact this link points at has to be one the opt-in page will actually render.
   *
   * `is_current` and a `confirmed_at` are not that test. `optin-artifact.tsx` refuses to draw the
   * consent form for an unpublished artifact, so without this a coach could mint a link and text
   * it to a lead, and the lead would land on "Messaging choices not published" -- a page that
   * cannot record the consent the link was issued to collect, with a redemption already spent
   * against it. The rule itself lives in `optInArtifactIsPublished`, which is also what the
   * go-live path calls; the two cannot drift apart while they share it.
   */
  resolve: async ({ tenantId, contactId, identityId }) => {
    const client = createSupabaseServiceClient();
    const [{ data: identity, error: identityError }, { data: tenant, error: tenantError }, { data: artifact, error: artifactError }] =
      await Promise.all([
        client.from("contact_identities").select("id")
          .eq("tenant_id", tenantId).eq("contact_id", contactId).eq("id", identityId).maybeSingle(),
        client.from("tenants").select("slug, is_demo").eq("id", tenantId).eq("status", "active").maybeSingle(),
        client.from("onboarding_optin_artifacts").select("id, placeholder")
          .eq("tenant_id", tenantId).eq("is_current", true).not("confirmed_at", "is", null).maybeSingle(),
      ]);
    if (identityError || tenantError || artifactError) throw new Error("CONSENT_LINK_TARGET_READ_FAILED");
    if (!identity || !tenant || !artifact) return null;
    if (!optInArtifactIsPublished(
      { placeholder: Boolean(artifact.placeholder) },
      { isDemo: Boolean(tenant.is_demo) },
    )) return null;
    return { tenantSlug: String(tenant.slug), artifactId: String(artifact.id) };
  },
  reserve: async (input) => {
    const client = createSupabaseServiceClient();
    const { error } = await client.from("consent_binding_redemptions").insert({
      tenant_id: input.tenantId,
      artifact_id: input.artifactId,
      contact_identity_id: input.contactIdentityId,
      form_submission_id: input.formSubmissionId,
      expires_at: input.expiresAt,
      issued_by: input.actorId,
    });
    if (error) throw new Error("CONSENT_LINK_RESERVATION_FAILED");
  },
  now: () => new Date(),
});
