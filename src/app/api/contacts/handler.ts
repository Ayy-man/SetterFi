import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import { contactManagementLive } from "@/lib/env-contract";
import { createContact, parseContactIdentityInput } from "@/lib/contacts/service";

const NO_STORE = { "Cache-Control": "no-store" };
const WRITE_ROLES = ["coach", "coach_member", "owner", "admin", "success"] as const;

type Dependencies = {
  enabled(): boolean;
  session(): Promise<RouteActor | null>;
  create: typeof createContact;
};

function response(body: unknown, status = 200) {
  return Response.json(body, { status, headers: NO_STORE });
}

function body(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(",") !== "contact,idempotencyKey" ||
    typeof input.idempotencyKey !== "string" || input.idempotencyKey.trim().length === 0 ||
    input.idempotencyKey.trim().length > 128) return null;
  const contact = parseContactIdentityInput(input.contact);
  return contact ? { contact, idempotencyKey: input.idempotencyKey.trim() } : null;
}

export function createManualContactHandler(dependencies: Dependencies) {
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
    if (!parsed) return response({ error: "Contact creation request is invalid." }, 400);
    try {
      const result = await dependencies.create({
        tenantId: actor.tenantId,
        actorId: actor.userId,
        contact: parsed.contact,
        idempotencyKey: parsed.idempotencyKey,
      });
      return response({ contact: result, audit: { id: result.auditId, action: "contact.created.manual" } }, 201);
    } catch {
      return response({ error: "Contact creation was refused." }, 409);
    }
  };
}

export const POST = createManualContactHandler({
  enabled: contactManagementLive,
  session: loadRouteActor,
  create: createContact,
});
