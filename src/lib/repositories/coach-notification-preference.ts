/**
 * The coach's single notification preference: email, text, or both.
 *
 * The account-menu Notifications page for admin/success/owner keeps the full rule-by-destination
 * matrix (`src/app/api/notification-preferences`, `notification-taxonomy.ts`). A coach never sees
 * that grid: docs/PRODUCT.md's Notifications section collapses it to one control for the coach
 * role, because a coach has no reason to reason about individual alert rules. This module is that
 * collapse, built on top of the same `alert_rules` / `notification_preferences` tables and the
 * same `set_notification_preference` RPC the matrix uses, so nothing about how a preference is
 * stored, audited, or resolved for delivery changes underneath it.
 *
 * The bell is deliberately left out of the choice. It is free to deliver (no provider, no
 * delivery-worker claim), and every coach-suppressible rule already defaults it on, so the coach's
 * choice governs only the two destinations that cost anything to reach them on: email and text.
 *
 * A platform-required rule (`suppressible = false`) is never touched by this module. Only rows
 * this repository itself reads back as controllable are eligible to be written, so a rule the
 * platform has decided must always notify keeps firing on its own destinations regardless of what
 * a coach picks here -- the round-1 brief's "keeping the platform's required rules intact."
 *
 * Text delivery has no provider or worker yet (see the migration
 * `20261012000005_notification_destination_text.sql`): choosing "text" or "both" here records the
 * coach's intent honestly, the same way an email preference is recorded before any email provider
 * confirms delivery, but no message actually reaches a phone until that worker exists. That is a
 * round-2+ item, not a gap in this preference store.
 */

import type { AppClaims } from "@/lib/auth/claims";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const COACH_NOTIFICATION_PREFERENCES = ["email", "text", "both"] as const;
export type CoachNotificationPreference = (typeof COACH_NOTIFICATION_PREFERENCES)[number];

export type CoachNotificationDestination = "email" | "sms";

export type ControllableRow = {
  ruleId: string;
  destination: CoachNotificationDestination;
  enabled: boolean;
};

export type AuditChange = { ruleId: string; destination: CoachNotificationDestination; enabled: boolean };

export type ControllableRowSource = (userId: string) => Promise<ControllableRow[]>;
export type PreferenceWriter = (input: {
  userId: string;
  ruleId: string;
  destination: CoachNotificationDestination;
  enabled: boolean;
}) => Promise<{ enabled: boolean }>;

export class CoachNotificationPreferenceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CoachNotificationPreferenceError";
  }
}

function requireCoachActor(role: AppClaims["role"]) {
  if (role !== "coach" && role !== "coach_member") {
    throw new CoachNotificationPreferenceError("COACH_NOTIFICATION_PREFERENCE_ROLE_INVALID");
  }
}

/**
 * Every coach-suppressible tenant-scoped rule, with the coach's current effective state for its
 * email and text destinations. Mirrors the filtering `createPreferenceRepository().list()` uses
 * (tenant scope, no `demo` category), but only ever returns the two destinations this control
 * governs, and only rules the coach is actually allowed to change.
 */
export async function loadControllableRows(userId: string): Promise<ControllableRow[]> {
  const client = createSupabaseServiceClient();
  const { data: rules, error: ruleError } = await client
    .from("alert_rules")
    .select("id,suppressible,default_destinations,default_enabled")
    .eq("scope", "tenant")
    .not("category", "eq", "demo");
  if (ruleError) throw new CoachNotificationPreferenceError("COACH_NOTIFICATION_PREFERENCE_READ_FAILED");

  const { data: preferences, error: preferenceError } = await client
    .from("notification_preferences")
    .select("rule_id,destination,enabled")
    .eq("user_id", userId);
  if (preferenceError) throw new CoachNotificationPreferenceError("COACH_NOTIFICATION_PREFERENCE_READ_FAILED");

  const overrides = new Map(
    (preferences ?? []).map((row) => [`${row.rule_id}:${row.destination}`, row.enabled]),
  );

  const rows: ControllableRow[] = [];
  for (const rule of rules ?? []) {
    if (rule.suppressible !== true) continue;
    const defaults = Array.isArray(rule.default_destinations) ? rule.default_destinations : [];
    for (const destination of ["email", "sms"] as const) {
      const enabled = overrides.get(`${rule.id}:${destination}`) ?? defaults.includes(destination);
      rows.push({ ruleId: rule.id as string, destination, enabled });
    }
  }
  return rows;
}

async function defaultPreferenceWriter(input: {
  userId: string;
  ruleId: string;
  destination: CoachNotificationDestination;
  enabled: boolean;
}): Promise<{ enabled: boolean }> {
  const client = createSupabaseServiceClient();
  const { data, error } = await client.rpc("set_notification_preference", {
    p_user_id: input.userId,
    p_rule_id: input.ruleId,
    p_destination: input.destination,
    p_enabled: input.enabled,
  });
  const written = Array.isArray(data) ? data[0] : data;
  if (error || !written) {
    throw new CoachNotificationPreferenceError("COACH_NOTIFICATION_PREFERENCE_WRITE_REFUSED");
  }
  return { enabled: written.enabled };
}

/**
 * Derives the coach's one preference from the underlying rows. Returns `null` when the rows do
 * not agree on a single answer -- a coach who has never touched this control reads as "email"
 * because every suppressible rule defaults its email destination on and its text destination off,
 * but a tenant with no controllable rules at all, or rows an admin hand-edited into an
 * inconsistent state, renders absent rather than a guessed value, matching this repository's rule
 * that unresolved evidence renders absent, never a manufactured answer.
 */
export async function readCoachNotificationPreference(
  userId: string,
  role: AppClaims["role"],
  source: ControllableRowSource = loadControllableRows,
): Promise<CoachNotificationPreference | null> {
  requireCoachActor(role);
  const rows = await source(userId);
  const emailRows = rows.filter((row) => row.destination === "email");
  const smsRows = rows.filter((row) => row.destination === "sms");
  if (emailRows.length === 0 || smsRows.length === 0) return null;

  const emailOn = emailRows.every((row) => row.enabled);
  const emailOff = emailRows.every((row) => !row.enabled);
  const smsOn = smsRows.every((row) => row.enabled);
  const smsOff = smsRows.every((row) => !row.enabled);

  if (emailOn && smsOff) return "email";
  if (emailOff && smsOn) return "text";
  if (emailOn && smsOn) return "both";
  return null;
}

/**
 * Writes the coach's single preference across every controllable rule at once. Only rows whose
 * enabled state actually needs to change are written, each through the same
 * `set_notification_preference` RPC and audit path the general matrix uses, so a locked
 * (platform-required) rule stays enforced there too if a race ever hands one back as controllable.
 */
export async function writeCoachNotificationPreference(
  userId: string,
  role: AppClaims["role"],
  preference: CoachNotificationPreference,
  audit: (actorId: string, change: AuditChange) => Promise<void>,
  deps: { source?: ControllableRowSource; writer?: PreferenceWriter } = {},
): Promise<CoachNotificationPreference> {
  requireCoachActor(role);
  if (!COACH_NOTIFICATION_PREFERENCES.includes(preference)) {
    throw new CoachNotificationPreferenceError("COACH_NOTIFICATION_PREFERENCE_VALUE_INVALID");
  }
  const source = deps.source ?? loadControllableRows;
  const writer = deps.writer ?? defaultPreferenceWriter;
  const wantEmail = preference !== "text";
  const wantSms = preference !== "email";
  const rows = await source(userId);

  for (const row of rows) {
    const want = row.destination === "email" ? wantEmail : wantSms;
    if (row.enabled === want) continue;
    const written = await writer({
      userId, ruleId: row.ruleId, destination: row.destination, enabled: want,
    });
    // A locked rule clamps the write server-side rather than rejecting it; skip the audit entry
    // for a destination the RPC declined to change, since nothing actually happened to record.
    if (written.enabled === row.enabled) continue;
    await audit(userId, { ruleId: row.ruleId, destination: row.destination, enabled: written.enabled });
  }

  const settled = await readCoachNotificationPreference(userId, role, source);
  return settled ?? preference;
}
