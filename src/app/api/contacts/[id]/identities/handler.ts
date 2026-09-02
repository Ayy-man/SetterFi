/** Contact identity detail is projected explicitly so repository-only fields cannot reach a client. */

import { phase4Live } from "@/lib/env-contract";
import {
  getContactIdentityDetail,
  type ContactIdentityDetail,
} from "@/lib/repositories/contacts";
import {
  loadRouteActor,
  type RouteActor,
} from "@/lib/auth/actors";

const noStoreHeaders = { "Cache-Control": "no-store" };

type IdentityRouteDependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  load(tenantId: string, contactId: string): Promise<ContactIdentityDetail>;
};

function identityDetailResponse(detail: ContactIdentityDetail) {
  return {
    contactId: detail.contactId,
    name: detail.name,
    isDemo: detail.isDemo,
    isTest: detail.isTest,
    identities: detail.identities.map((identity) => ({
      id: identity.id,
      channel: identity.channel,
      channelLabel: identity.channelLabel,
      address: identity.address,
      normalizedPhone: identity.normalizedPhone,
      normalizedEmail: identity.normalizedEmail,
      consentState: identity.consentState,
    })),
    candidates: detail.candidates.map((candidate) => ({
      id: candidate.id,
      otherContact: { ...candidate.otherContact },
      source: candidate.source,
      evidenceKey: candidate.evidenceKey,
      evidence: candidate.evidence,
      state: candidate.state,
      createdAt: candidate.createdAt,
      testBoundary: candidate.testBoundary,
      dataLabel: candidate.dataLabel,
    })),
    mergeState: { ...detail.mergeState },
    undo: detail.undo ? { auditRowId: detail.undo.auditRowId } : null,
  };
}

export function createContactIdentityHandler(dependencies: IdentityRouteDependencies) {
  return async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    }
    const actor = await dependencies.session();
    if (!actor) {
      return Response.json(
        { error: "Authentication required." },
        { status: 401, headers: noStoreHeaders },
      );
    }
    try {
      const id = (await context.params).id.trim();
      if (!id) throw new Error("CONTACT_ID_REQUIRED");
      const detail = await dependencies.load(actor.tenantId, id);
      if (detail.contactId !== id) throw new Error("CONTACT_DETAIL_READBACK_MISMATCH");
      return Response.json(identityDetailResponse(detail), { headers: noStoreHeaders });
    } catch (error) {
      /*
       * The body stays generic -- a coach who asks for someone else's contact must not learn from
       * the answer whether that contact exists -- but the reason is logged, the way the pipeline
       * stage route logs its refusal code. Without this, every distinct failure here reaches the
       * runtime log as an identical bare 404: a tenant mismatch, a Postgres read error, and a
       * contact that genuinely is not there are indistinguishable, and the panel's "Identity
       * details could not load" is the only thing anyone can see. A 404 carrying no code in the
       * log means this route refused before the try -- the Phase 4 gate is off.
       */
      console.error(
        "Contact identity detail refused.",
        error instanceof Error ? error.message : "CONTACT_IDENTITY_DETAIL_REFUSED",
      );
      return Response.json({ error: "Contact not found." }, { status: 404, headers: noStoreHeaders });
    }
  };
}

export const GET = createContactIdentityHandler({
  enabled: phase4Live,
  session: loadRouteActor,
  load: getContactIdentityDetail,
});
