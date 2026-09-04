import { loadRouteActor } from "@/lib/auth/actors";
import {
  readCoachNotificationPreference,
  writeCoachNotificationPreference,
  type AuditChange,
} from "@/lib/repositories/coach-notification-preference";
import { readCoachOwnEmail } from "@/lib/repositories/coach-profile";
import { writePreferenceAuditEvent } from "@/app/api/notification-preferences/handler";
import type { NotificationDestination } from "@/lib/notifications/events";

import { createCoachNotificationPreferenceHandlers } from "./handler";

/**
 * `writePreferenceAuditEvent` is typed against the general matrix's `NotificationDestination`
 * ("bell" | "email"), which does not carry "sms" -- and should not, since the matrix never writes
 * that destination. The audit row itself is untyped payload (a plain insert, no DB-generated
 * types back it), so recording an "sms" preference change through the same writer is safe; this
 * adapter only widens the compile-time boundary at the one place a coach preference can name a
 * destination the general matrix doesn't know about.
 */
async function auditCoachPreferenceChange(actorId: string, change: AuditChange) {
  await writePreferenceAuditEvent(actorId, {
    ruleId: change.ruleId,
    destination: change.destination as NotificationDestination,
    enabled: change.enabled,
  });
}

const handlers = createCoachNotificationPreferenceHandlers({
  session: loadRouteActor,
  read: readCoachNotificationPreference,
  readEmail: readCoachOwnEmail,
  write: writeCoachNotificationPreference,
  audit: auditCoachPreferenceChange,
});

export const GET = handlers.GET;
export const PUT = handlers.PUT;
