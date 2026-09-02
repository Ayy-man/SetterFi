import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type AuthAuditEvent = {
  action:
    | "auth.password_reset.requested"
    | "auth.email_verification.requested"
    | "auth.password_reset.completed"
    | "auth.signed_out";
  actorId: string | null;
  tenantId: string | null;
  actorIp: string | null;
  targetId?: string | null;
  payload?: Record<string, string>;
};

/** Auth outcomes are written with the service client because public recovery requests have no session. */
export async function writeAuthAuditEvent(event: AuthAuditEvent) {
  const client = createSupabaseServiceClient();
  const { error } = await client.from("audit_log").insert({
    actor_id: event.actorId,
    subject_user_id: event.actorId,
    tenant_id: event.tenantId,
    action: event.action,
    target_type: "account",
    target_id: event.targetId ?? event.actorId,
    payload: event.payload ?? null,
    source: "api",
    actor_ip: event.actorIp,
  });
  if (error) throw new Error("AUTH_AUDIT_WRITE_FAILED");
}

export function requestIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}
