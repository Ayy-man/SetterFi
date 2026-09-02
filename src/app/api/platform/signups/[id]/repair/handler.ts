import { signupRepairLive } from "@/lib/env-contract";
import { loadPlatformActor, type PlatformActor } from "@/lib/auth/actors";
import { repairSignup, type SignupRepairResult } from "@/lib/onboarding/signup";

const NO_STORE = { "Cache-Control": "no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Context = { params: Promise<{ id: string }> };

type RepairInput = {
  expectedTenantId: string | null;
  email: string;
  fullName: string;
  businessName: string;
  slug: string;
  tierId: string;
  timezone: string;
  reason: string;
};

export type SignupRepairRouteDependencies = {
  enabled(): boolean;
  session(): Promise<PlatformActor | null>;
  repair(input: RepairInput & { expectedAuthUserId: string; actorId: string }): Promise<SignupRepairResult>;
};

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parse(value: unknown): RepairInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const keys = Object.keys(body).sort().join(",");
  if (keys !== "businessName,email,expectedTenantId,fullName,reason,slug,tierId,timezone") return null;
  const expectedTenantId = body.expectedTenantId === null ? null : text(body.expectedTenantId);
  const email = text(body.email)?.toLowerCase() ?? null;
  const fullName = text(body.fullName);
  const businessName = text(body.businessName);
  const slug = text(body.slug)?.toLowerCase() ?? null;
  const tierId = text(body.tierId);
  const timezone = text(body.timezone);
  const reason = text(body.reason);
  if (
    (body.expectedTenantId !== null && (!expectedTenantId || !UUID.test(expectedTenantId)))
    || !email || !EMAIL.test(email) || !fullName || fullName.length > 160
    || !businessName || businessName.length > 160 || !slug || !SLUG.test(slug) || slug.length > 63
    || !tierId || !UUID.test(tierId) || !timezone || timezone.length > 120
    || !reason || reason.length > 500
  ) return null;
  return { expectedTenantId, email, fullName, businessName, slug, tierId, timezone, reason };
}

function response(result: SignupRepairResult) {
  return {
    repair: {
      state: result.state,
      intentId: result.intentId,
      tenantId: result.tenantId,
      ...(result.state === "cannot_resume" ? { code: result.code } : {}),
    },
    audit: { id: result.auditId },
  };
}

export function createSignupRepairHandler(dependencies: SignupRepairRouteDependencies) {
  return async function POST(request: Request, context: Context) {
    if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers: NO_STORE });
    const actor = await dependencies.session();
    if (!actor) return Response.json({ error: "Authentication required." }, { status: 401, headers: NO_STORE });
    if (actor.role !== "owner" && actor.role !== "admin") {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: NO_STORE });
    }
    try {
      const { id } = await context.params;
      const input = parse(await request.json());
      if (!UUID.test(id) || !input) throw new Error("SIGNUP_REPAIR_INPUT_INVALID");
      const result = await dependencies.repair({ ...input, expectedAuthUserId: id, actorId: actor.userId });
      if (!Number.isSafeInteger(result.auditId) || result.auditId <= 0) {
        throw new Error("SIGNUP_REPAIR_AUDIT_REQUIRED");
      }
      return Response.json(response(result), {
        status: result.state === "cannot_resume" ? 409 : 200,
        headers: NO_STORE,
      });
    } catch (error) {
      const status = error instanceof SyntaxError || error instanceof Error && error.message === "SIGNUP_REPAIR_INPUT_INVALID"
        ? 400
        : 409;
      return Response.json({ error: status === 400 ? "Signup repair details are invalid." : "Signup repair was refused." }, {
        status,
        headers: NO_STORE,
      });
    }
  };
}

export const POST = createSignupRepairHandler({
  // Repair attaches a stranded Auth identity to the intent it belongs to, so it stays behind its
  // own gate nested under Phase 5: the onboarding rollout has to be on before repairing one of
  // its signups means anything, and the repair itself is switched on separately from it.
  enabled: signupRepairLive,
  session: loadPlatformActor,
  repair: repairSignup,
});
