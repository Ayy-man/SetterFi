import { contactDeleteLive, phase1Live, phase3Live } from "@/lib/env-contract";
import { previewLeadDeletion } from "@/lib/deletion/preview";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";

const noStoreHeaders = { "Cache-Control": "no-store" };

type Dependencies = {
  session(): Promise<RouteActor | null>;
  preview: typeof previewLeadDeletion;
};

function enabled() {
  return phase1Live() && phase3Live() && contactDeleteLive();
}

export function createDeletionPreviewHandler(dependencies: Dependencies) {
  return async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
    if (!enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: noStoreHeaders });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: noStoreHeaders });
    if (!["owner", "admin", "success", "coach"].includes(actor.role ?? "")) {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStoreHeaders });
    }
    try {
      const body: unknown = await request.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
        throw new Error("DELETION_PREVIEW_BODY_INVALID");
      }
      const { id } = await context.params;
      const preview = await dependencies.preview({
        tenantId: actor.tenantId,
        contactId: id,
        actorId: actor.userId,
      });
      return Response.json({ preview }, { headers: noStoreHeaders });
    } catch {
      return Response.json({ error: "Deletion preview was refused." }, { status: 409, headers: noStoreHeaders });
    }
  };
}

export const POST = createDeletionPreviewHandler({ session: loadRouteActor, preview: previewLeadDeletion });
