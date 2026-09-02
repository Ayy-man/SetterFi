import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { contactManagementLive } from "@/lib/env-contract";
import { removeContactTag } from "@/lib/contacts/service";

const NO_STORE = { "Cache-Control": "no-store" };
const WRITE_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  remove: typeof removeContactTag;
};

export function createContactTagDeleteHandler(dependencies: Dependencies) {
  return async function DELETE(_request: Request, context: { params: Promise<{ id: string; tagId: string }> }) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (!WRITE_ROLES.includes(actor.role as typeof WRITE_ROLES[number])) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    const { id: contactId, tagId } = await context.params;
    if (!contactId.trim() || !tagId.trim()) {
      return Response.json({ error: "Contact tag request is invalid." }, { status: 400, headers: NO_STORE });
    }
    try {
      const result = await dependencies.remove({
        tenantId: actor.tenantId, contactId: contactId.trim(), actorId: actor.userId, tagId: tagId.trim(),
      });
      return Response.json({ ...result, audit: { id: result.auditId, action: "contact.tag.removed" } }, { headers: NO_STORE });
    } catch {
      return Response.json({ error: "Contact tag removal was refused." }, { status: 409, headers: NO_STORE });
    }
  };
}

export const DELETE = createContactTagDeleteHandler({
  enabled: contactManagementLive,
  session: loadRouteActor,
  remove: removeContactTag,
});
