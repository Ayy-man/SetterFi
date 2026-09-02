import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { contactManagementLive } from "@/lib/env-contract";
import { importContacts } from "@/lib/contacts/service";

const NO_STORE = { "Cache-Control": "no-store" };
const WRITE_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  importContacts: typeof importContacts;
};

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function body(value: unknown): { rows: unknown[]; idempotencyKey: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "idempotencyKey,rows" || !Array.isArray(input.rows) ||
    input.rows.length > 500 || typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0 || input.idempotencyKey.trim().length > 128) return null;
  return { rows: input.rows, idempotencyKey: input.idempotencyKey.trim() };
}

export function createContactImportHandler(dependencies: Dependencies) {
  return async function POST(request: Request) {
    if (!dependencies.enabled()) return response({ error: "Not found." }, 404);
    const actor = await dependencies.session();
    if (!actor) return response({ error: "Authentication required." }, 401);
    if (!WRITE_ROLES.includes(actor.role as typeof WRITE_ROLES[number])) {
      return response({ error: "Forbidden." }, 403);
    }
    let parsed: ReturnType<typeof body>;
    try {
      parsed = body(await request.json());
    } catch {
      parsed = null;
    }
    if (!parsed) return response({ error: "Contact import request is invalid." }, 400);
    try {
      const result = await dependencies.importContacts({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        rows: parsed.rows,
        idempotencyKey: parsed.idempotencyKey,
      });
      const rejected = result.outcomes.filter((outcome) => outcome.outcome === "rejected").length;
      return response({ outcomes: result.outcomes, audit: { id: result.auditId, action: "contact.imported" },
        status: rejected === 0 ? "complete" : "complete_with_rejections" }, 201);
    } catch {
      return response({ error: "Contact import was refused." }, 409);
    }
  };
}

export const POST = createContactImportHandler({
  enabled: contactManagementLive,
  session: loadRouteActor,
  importContacts,
});
