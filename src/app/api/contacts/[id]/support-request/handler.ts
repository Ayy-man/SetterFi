/**
 * "Report a duplicate" / "Request deletion" from the coach Leads list.
 *
 * Both are the same primitive: a coach-authored message to support, tagged with the lead it is
 * about. Neither one merges, deletes, or otherwise mutates the contact -- that stays a human
 * decision made from the support queue (or, for deletion, the separate admin compliance flow).
 */

import { hasImpersonationMarker } from "@/lib/auth/claims";
import { phase8SupportLive } from "@/lib/env-contract";
import { getContactIdentityDetail } from "@/lib/repositories/contacts";
import { createSupportRepository, type CoachSupportThreadRead } from "@/lib/repositories/support";
import {
  createSupportService,
  loadSupportSession,
  type SupportSession,
} from "@/lib/support/service";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export const CONTACT_SUPPORT_REQUEST_KINDS = {
  duplicate: "Report a duplicate",
  deletion: "Request deletion",
} as const;
export type ContactSupportRequestKind = keyof typeof CONTACT_SUPPORT_REQUEST_KINDS;

const BODY_KEYS = ["type", "note"] as const;
const NOTE_MAX_LENGTH = 2000;

export type ContactSupportRequestLookup = (input: {
  tenantId: string;
  contactId: string;
}) => Promise<{ name: string } | null>;

type ContactSupportRequestDependencies = {
  enabled(): boolean;
  session(): Promise<SupportSession | null>;
  lookupContact: ContactSupportRequestLookup;
  create(
    session: SupportSession,
    input: { subject: string; body: string; relatedContactId: string },
  ): Promise<CoachSupportThreadRead>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isRequestKind(value: unknown): value is ContactSupportRequestKind {
  return typeof value === "string" && value in CONTACT_SUPPORT_REQUEST_KINDS;
}

function parseBody(value: unknown): { kind: ContactSupportRequestKind; note: string } | null {
  if (!isRecord(value) || !hasExactKeys(value, BODY_KEYS) || !isRequestKind(value.type)
    || typeof value.note !== "string") {
    return null;
  }
  const note = value.note.trim();
  if (note.length < 1 || note.length > NOTE_MAX_LENGTH) return null;
  return { kind: value.type, note };
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE_HEADERS });
}

function authorizeCoach(session: SupportSession | null) {
  if (!session) return 401;
  if (hasImpersonationMarker(session) || !session.tenantId
    || !["coach", "coach_member"].includes(session.role)) return 403;
  return null;
}

export function createContactSupportRequestHandler(
  dependencies: ContactSupportRequestDependencies,
) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!dependencies.enabled()) return json({ error: "Not found." }, 404);

    const session = await dependencies.session();
    const refusal = authorizeCoach(session);
    if (refusal) {
      return json({ error: refusal === 401 ? "Authentication required." : "Forbidden." }, refusal);
    }
    const actor = session as SupportSession;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ message: "The request body is invalid." }, 400);
    }
    const parsed = parseBody(rawBody);
    const contactId = (await context.params).id.trim();
    if (!parsed || !contactId) return json({ message: "The request body is invalid." }, 400);

    let contact: { name: string } | null;
    try {
      contact = await dependencies.lookupContact({
        tenantId: actor.tenantId as string,
        contactId,
      });
    } catch {
      return json({ message: "This lead could not be found." }, 404);
    }
    if (!contact) return json({ message: "This lead could not be found." }, 404);

    const kindLabel = CONTACT_SUPPORT_REQUEST_KINDS[parsed.kind];
    const subject = `${kindLabel}: ${contact.name}`;
    const body = `Lead: ${contact.name} (${contactId})\n\n${parsed.note}`;

    try {
      const thread = await dependencies.create(actor, {
        subject,
        body,
        relatedContactId: contactId,
      });
      return json({ thread }, 201);
    } catch (error) {
      console.error(
        "Contact support request refused.",
        error instanceof Error ? error.message : "NON_ERROR_THROWN",
      );
      return json(
        { message: "This request could not be sent to support. Refresh the lead and try again." },
        409,
      );
    }
  };
}

const supportRepository = createSupportRepository();
const supportService = createSupportService(supportRepository);

export const POST = createContactSupportRequestHandler({
  enabled: phase8SupportLive,
  session: loadSupportSession,
  lookupContact: async ({ tenantId, contactId }) => {
    try {
      const detail = await getContactIdentityDetail(tenantId, contactId);
      return { name: detail.name };
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CONTACT_NOT_FOUND" || code === "CONTACT_TENANT_MISMATCH") return null;
      throw error;
    }
  },
  create: (session, input) => supportService.createCoachThread(session, input),
});
