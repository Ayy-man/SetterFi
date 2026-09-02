import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { contactManagementLive } from "@/lib/env-contract";
import { addContactTag, listContactTags } from "@/lib/contacts/service";

const NO_STORE = { "Cache-Control": "no-store" };
const WRITE_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  add: typeof addContactTag;
  list: typeof listContactTags;
};

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function tagBody(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).join(",") !== "label" || typeof input.label !== "string") return null;
  const label = input.label.trim();
  return label.length > 0 && label.length <= 80 ? label : null;
}

export function createContactTagsHandler(dependencies: Dependencies) {
  return {
    GET: async (_request: Request, context: { params: Promise<{ id: string }> }) => {
      if (!dependencies.enabled()) return response({ error: "Not found." }, 404);
      const actor = await dependencies.session();
      if (!actor) return response({ error: "Authentication required." }, 401);
      const contactId = (await context.params).id.trim();
      if (!contactId) return response({ error: "Contact not found." }, 404);
      try {
        return response({ tags: await dependencies.list({ tenantId: actor.tenantId, contactId }) });
      } catch {
        return response({ error: "Contact not found." }, 404);
      }
    },
    POST: async (request: Request, context: { params: Promise<{ id: string }> }) => {
      if (!dependencies.enabled()) return response({ error: "Not found." }, 404);
      const actor = await dependencies.session();
      if (!actor) return response({ error: "Authentication required." }, 401);
      if (!WRITE_ROLES.includes(actor.role as typeof WRITE_ROLES[number])) return response({ error: "Forbidden." }, 403);
      const contactId = (await context.params).id.trim();
      let parsed: string | null;
      try { parsed = tagBody(await request.json()); } catch { parsed = null; }
      if (!contactId || !parsed) return response({ error: "Contact tag request is invalid." }, 400);
      try {
        const result = await dependencies.add({ tenantId: actor.tenantId, contactId, actorId: actor.userId, label: parsed });
        return response({ tag: result.tag, added: result.added, audit: { id: result.auditId, action: "contact.tag.added" } }, 201);
      } catch {
        return response({ error: "Contact tag was refused." }, 409);
      }
    },
  };
}

const handler = createContactTagsHandler({
  enabled: contactManagementLive,
  session: loadRouteActor,
  add: addContactTag,
  list: listContactTags,
});
export const GET = handler.GET;
export const POST = handler.POST;
