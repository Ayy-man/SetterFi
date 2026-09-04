import { hasImpersonationMarker } from "@/lib/auth/claims";
import { loadRouteActor, type RouteActor } from "@/lib/auth/actors";
import {
  COACH_NOTIFICATION_PREFERENCES,
  type CoachNotificationPreference,
} from "@/lib/repositories/coach-notification-preference";

const headers = { "Cache-Control": "no-store" };

type AuditChange = { ruleId: string; destination: "email" | "sms"; enabled: boolean };

type Dependencies = {
  session(): Promise<RouteActor | null>;
  read(userId: string, role: RouteActor["role"]): Promise<CoachNotificationPreference | null>;
  readEmail(actor: { userId: string; tenantId: string }): Promise<string | null>;
  write(
    userId: string,
    role: RouteActor["role"],
    preference: CoachNotificationPreference,
    audit: (actorId: string, change: AuditChange) => Promise<void>,
  ): Promise<CoachNotificationPreference>;
  audit(actorId: string, change: AuditChange): Promise<void>;
};

function coach(actor: RouteActor | null): actor is RouteActor {
  return Boolean(
    actor && (actor.role === "coach" || actor.role === "coach_member") &&
    !hasImpersonationMarker(actor),
  );
}

export function createCoachNotificationPreferenceHandlers(dependencies: Dependencies) {
  async function actorOrForbidden() {
    const actor = await dependencies.session();
    return coach(actor) ? actor : null;
  }

  async function GET() {
    const actor = await actorOrForbidden();
    if (!actor) return Response.json({ error: "Forbidden." }, { status: 403, headers });
    try {
      const [preference, email] = await Promise.all([
        dependencies.read(actor.userId, actor.role),
        dependencies.readEmail({ userId: actor.userId, tenantId: actor.tenantId }),
      ]);
      return Response.json({ preference, email }, { headers });
    } catch (error) {
      console.error(
        "/api/coach/notification-preference unavailable.",
        error instanceof Error ? error.message : "COACH_NOTIFICATION_PREFERENCE_READ_FAILED",
      );
      return Response.json({ code: "COACH_NOTIFICATION_PREFERENCE_READ_FAILED" }, {
        status: 503, headers,
      });
    }
  }

  async function PUT(request: Request) {
    const actor = await actorOrForbidden();
    if (!actor) return Response.json({ error: "Forbidden." }, { status: 403, headers });
    try {
      const raw: unknown = await request.json();
      if (
        !raw || typeof raw !== "object" || Array.isArray(raw) ||
        Object.keys(raw as Record<string, unknown>).join(",") !== "preference" ||
        !COACH_NOTIFICATION_PREFERENCES.includes(
          (raw as Record<string, unknown>).preference as CoachNotificationPreference,
        )
      ) {
        throw new Error("COACH_NOTIFICATION_PREFERENCE_BODY_INVALID");
      }
      const preference = (raw as Record<string, unknown>).preference as CoachNotificationPreference;
      const settled = await dependencies.write(
        actor.userId,
        actor.role,
        preference,
        dependencies.audit,
      );
      return Response.json({ preference: settled }, { headers });
    } catch {
      return Response.json({ code: "COACH_NOTIFICATION_PREFERENCE_WRITE_REFUSED" }, {
        status: 409, headers,
      });
    }
  }

  return { GET, PUT };
}
