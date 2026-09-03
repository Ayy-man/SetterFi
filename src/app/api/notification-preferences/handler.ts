import type { NotificationDestination } from "@/lib/notifications/events";
import { hasImpersonationMarker, type AppClaims } from "@/lib/auth/claims";
import { phase8AlertsLive } from "@/lib/env-contract";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

import { loadAlertActor } from "@/lib/auth/actors";

const headers = { "Cache-Control": "no-store" };
const DESTINATIONS = ["bell", "email", "slack"] as const;

export type Preference = {
  ruleId: string;
  event: string;
  scope: "tenant" | "platform";
  name: string;
  /**
   * The rule's authored one-line sentence, straight from `alert_rules.description`. The column is
   * `not null`, but it is read here as data rather than as a promise: a surface rendering it has to
   * cope with an empty string, because an empty description would otherwise draw a blank line where
   * the reader expects the consequence.
   */
  description: string;
  category: string;
  audience: string;
  defaultDestinations: NotificationDestination[];
  defaultEnabled: boolean;
  destination: NotificationDestination;
  enabled: boolean;
  locked: boolean;
};
type PreferenceRepository = {
  list(userId: string, role: AppClaims["role"]): Promise<Preference[]>;
  set(userId: string, input: { ruleId: string; destination: NotificationDestination; enabled: boolean }): Promise<Pick<Preference, "ruleId" | "destination" | "enabled" | "locked">>;
};

export type PreferenceChangeRecord = {
  ruleId: string;
  destination: NotificationDestination;
  enabled: boolean;
};

function ruleAudience(rule: {
  audience_roles: unknown;
  include_success_owner: unknown;
  include_billing_contact: unknown;
}) {
  const audience = Array.isArray(rule.audience_roles)
    ? rule.audience_roles.filter((role): role is string => typeof role === "string")
    : [];
  if (rule.include_success_owner === true) audience.push("success_owner");
  if (rule.include_billing_contact === true) audience.push("billing_contact");
  return audience.join("; ");
}

/**
 * The audit row for a preference change, written the way `/auth/signout` writes its own: a direct
 * service-client insert, platform-scoped, with no tenant to attribute it to.
 *
 * The payload names the rule and the destination and stores the value the database actually
 * settled on, never the value the browser asked for. `notification_preferences` holds a locked
 * flag, so a request to enable a required notice can come back clamped, and a record of the ask
 * rather than the outcome would be a log of intentions.
 */
export async function writePreferenceAuditEvent(
  actorId: string,
  change: PreferenceChangeRecord,
) {
  const client = createSupabaseServiceClient();
  const { error } = await client.from("audit_log").insert({
    actor_id: actorId,
    subject_user_id: actorId,
    tenant_id: null,
    action: "notification.preference.changed",
    target_type: "notification_preference",
    target_id: change.ruleId,
    payload: {
      destination: change.destination,
      enabled: String(change.enabled),
    },
    source: "api",
  });
  if (error) throw new Error("NOTIFICATION_PREFERENCE_AUDIT_WRITE_FAILED");
}

/**
 * Exported so the suite can drive the real query against a fake client. The columns this select
 * names are load-bearing for the coach settings surface, which renders `description` as each row's
 * consequence line, and an injected repository would never notice the column going missing.
 */
export function createPreferenceRepository(): PreferenceRepository {
  const client = createSupabaseServiceClient();
  return {
    list: async (userId, role) => {
      let ruleQuery = client.from("alert_rules")
        .select("id,event_key,scope,name,description,category,audience_roles,include_success_owner,include_billing_contact,suppressible,default_destinations,default_enabled")
        .order("event_key").order("scope");
      /*
       * A coach sees tenant-scoped rules, minus anything in the `demo` category.
       *
       * The category filter is not hypothetical tidiness. On 2026-08-24 somebody inserted
       * `phase8.demo.slack:tenant` into hosted `alert_rules` by hand during a demo and left it
       * there: scope `tenant`, `default_enabled = true`, pointing at a demo Slack channel. Scope
       * was the only thing this query filtered on and `audience_roles` is display metadata that
       * never filters, so that row reached every coach on the live platform, and
       * `alert-settings.tsx` title-cased its unknown category into a heading reading "Demo".
       *
       * That breaks two hard rules at once -- test data segregated and labelled on-screen, and
       * honest states. Filtering here stops it being client-visible. It does NOT make it correct:
       * the row is still live and still enabled, and the real fix is deleting it. Ayman has that
       * call; this is the stopgap, and it should come out once the row is gone.
       *
       * An admin is deliberately not filtered. Hiding the row from the only people who can delete
       * it is how it survives.
       */
      if (role === "coach" || role === "coach_member") {
        ruleQuery = ruleQuery.eq("scope", "tenant").not("category", "eq", "demo");
      }
      const { data: rules, error: ruleError } = await ruleQuery;
      const { data: preferences, error: preferenceError } = await client.from("notification_preferences")
        .select("rule_id,destination,enabled").eq("user_id", userId);
      if (ruleError || preferenceError) throw new Error("NOTIFICATION_PREFERENCES_READ_FAILED");
      const overrides = new Map((preferences ?? []).map((preference) => [
        `${preference.rule_id}:${preference.destination}`, preference.enabled,
      ]));
      return (rules ?? []).flatMap((rule) => {
        const defaultDestinations = Array.isArray(rule.default_destinations)
          ? rule.default_destinations.filter(
            (destination): destination is NotificationDestination =>
              DESTINATIONS.includes(destination as NotificationDestination),
          )
          : [];
        return DESTINATIONS.map((destination) => ({
          ruleId: rule.id,
          event: rule.event_key,
          scope: rule.scope as "tenant" | "platform",
          name: rule.name,
          description: typeof rule.description === "string" ? rule.description : "",
          category: rule.category,
          audience: ruleAudience(rule),
          defaultDestinations,
          defaultEnabled: rule.default_enabled,
          destination,
          enabled: overrides.get(`${rule.id}:${destination}`)
            ?? defaultDestinations.includes(destination),
          locked: !rule.suppressible,
        }));
      });
    },
    set: async (userId, input) => {
      const { data, error } = await client.rpc("set_notification_preference", {
        p_user_id: userId,
        p_rule_id: input.ruleId,
        p_destination: input.destination,
        p_enabled: input.enabled,
      });
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row) throw new Error("NOTIFICATION_PREFERENCE_WRITE_REFUSED");
      return { ruleId: input.ruleId, destination: input.destination, enabled: row.enabled, locked: row.locked };
    },
  };
}

type Dependencies = {
  enabled(): boolean;
  session: typeof loadAlertActor;
  repository(): PreferenceRepository;
  audit(actorId: string, change: PreferenceChangeRecord): Promise<void>;
};

export function createNotificationPreferenceHandlers(dependencies: Dependencies) {
  return {
    GET: async () => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
      const actor = await dependencies.session();
      if (!actor || hasImpersonationMarker(actor)) return Response.json({ error: "Authentication required." }, { status: 401, headers });
      try {
        return Response.json({
          preferences: await dependencies.repository().list(actor.userId, actor.role),
        }, { headers });
      } catch (cause) {
        console.error(
          "/api/notification-preferences failed.",
          cause instanceof Error ? cause.message : "NON_ERROR_THROWN",
        );
        return Response.json({ error: "Notification preferences unavailable." }, { status: 503, headers });
      }
    },
    PUT: async (request: Request) => {
      if (!dependencies.enabled()) return Response.json({ error: "Not found." }, { status: 404, headers });
      const actor = await dependencies.session();
      if (!actor || hasImpersonationMarker(actor)) return Response.json({ error: "Authentication required." }, { status: 401, headers });
      try {
        const body: unknown = await request.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_BODY");
        const value = body as Record<string, unknown>;
        if (Object.keys(value).sort().join(",") !== "destination,enabled,ruleId"
          || typeof value.ruleId !== "string" || !value.ruleId.trim()
          || !DESTINATIONS.includes(value.destination as NotificationDestination)
          || typeof value.enabled !== "boolean") throw new Error("INVALID_BODY");
        const preference = await dependencies.repository().set(actor.userId, {
          ruleId: value.ruleId,
          destination: value.destination as NotificationDestination,
          enabled: value.enabled,
        });
        /*
         * Recorded before the response, and a failure to record fails the request -- the same
         * order `/auth/signout` uses, and for the same reason: the panel prints "Notification
         * change logged" beside this control, so a 200 has to mean both the change and its record
         * landed. The preference travels back in the error body regardless, because the row did
         * change and a client left showing the old value would be the second wrong answer.
         */
        try {
          await dependencies.audit(actor.userId, {
            ruleId: preference.ruleId,
            destination: preference.destination,
            enabled: preference.enabled,
          });
        } catch {
          return Response.json(
            { error: "Notification preference change could not be recorded.", preference },
            { status: 503, headers },
          );
        }
        return Response.json({ preference }, { headers });
      } catch {
        return Response.json({ error: "Notification preference update refused." }, { status: 409, headers });
      }
    },
  };
}

const handlers = createNotificationPreferenceHandlers({
  enabled: phase8AlertsLive,
  session: loadAlertActor,
  repository: createPreferenceRepository,
  audit: writePreferenceAuditEvent,
});
export const GET = handlers.GET;
export const PUT = handlers.PUT;
