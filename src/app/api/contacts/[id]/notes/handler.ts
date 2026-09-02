import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { contactManagementLive } from "@/lib/env-contract";
import { addContactNote, listContactNotes } from "@/lib/contacts/service";

const NO_STORE = { "Cache-Control": "no-store" };
const WRITE_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  add: typeof addContactNote;
  list: typeof listContactNotes;
};

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function noteBody(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).join(",") !== "body" || typeof input.body !== "string") return null;
  const body = input.body.trim();
  return body.length > 0 && body.length <= 2000 ? body : null;
}

export function createContactNotesHandler(dependencies: Dependencies) {
  return {
    GET: async (_request: Request, context: { params: Promise<{ id: string }> }) => {
      if (!dependencies.enabled()) return response({ error: "Not found." }, 404);
      const actor = await dependencies.session();
      if (!actor) return response({ error: "Authentication required." }, 401);
      const contactId = (await context.params).id.trim();
      if (!contactId) return response({ error: "Contact not found." }, 404);
      try {
        return response({ notes: await dependencies.list({ tenantId: actor.tenantId, contactId }) });
      } catch {
        return response({ error: "Contact not found." }, 404);
      }
    },
    POST: async (request: Request, context: { params: Promise<{ id: string }> }) => {
      if (!dependencies.enabled()) return response({ error: "Not found." }, 404);
      const actor = await dependencies.session();
      if (!actor) return response({ error: "Authentication required." }, 401);
      if (!WRITE_ROLES.includes(actor.role as typeof WRITE_ROLES[number])) {
        return response({ error: "Forbidden." }, 403);
      }
      const contactId = (await context.params).id.trim();
      let parsed: string | null;
      try { parsed = noteBody(await request.json()); } catch { parsed = null; }
      if (!contactId || !parsed) return response({ error: "Contact note request is invalid." }, 400);
      try {
        const note = await dependencies.add({ tenantId: actor.tenantId, contactId, actorId: actor.userId, body: parsed });
        return response({ note, audit: { id: note.auditId, action: "contact.note.added" } }, 201);
      } catch {
        return response({ error: "Contact note was refused." }, 409);
      }
    },
  };
}

const handler = createContactNotesHandler({
  enabled: contactManagementLive,
  session: loadRouteActor,
  add: addContactNote,
  list: listContactNotes,
});
export const GET = handler.GET;
export const POST = handler.POST;
