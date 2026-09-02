/**
 * Audit rows read back as install attempts, in plain English.
 *
 * Pure over a narrow row type: nothing here knows about Supabase, and nothing reads the clock, so
 * an attempt renders the same on the server and in a test. The join that turns rows into an attempt
 * is `payload.after.state_ref`, written by the route that issued the link and by every event that
 * came back for it.
 */

import { PLATFORM_ROLES } from "@/lib/auth/claims";

const MAX_ATTEMPTS = 10;

export const INSTALL_EVENT_ACTIONS = [
  "channel.messaging_install.started",
  "channel.messaging_install.start_refused",
  "channel.messaging_install.declined",
  "channel.messaging_install.failed",
  "channel.messaging_install.completed",
  "platform.provisioning_install.declined",
  "platform.provisioning_install.failed",
  "platform.provisioning_install.completed",
] as const;

export type InstallEventRow = {
  id: string;
  action: string;
  actorId: string | null;
  tenantId: string | null;
  reason: string | null;
  payload: unknown;
  createdAt: string;
};

export type InstallAttemptsAccess = "off" | "refused" | "allowed";

/**
 * The decision the provisioning page has to make before it reads anything. The attempts list is
 * sixty `audit_log` rows across every tenant, fetched with the service role, so there is no RLS
 * underneath to catch a viewer this function waves through - the answer here is the whole gate.
 *
 * A null role covers three different situations and refuses all of them: no session, a session
 * carrying no role, and a platform user currently viewing as a client.
 *
 * The read set is shared with the route that gates the same surface, so the two cannot disagree
 * about who may see it; it used to be a copy here under a second name, and nothing failed on drift.
 */
export function installAttemptsAccess(input: {
  installEnabled: boolean;
  actorRole: string | null;
  trackerRefused?: boolean;
}): InstallAttemptsAccess {
  if (!input.installEnabled) return "off";
  if (input.trackerRefused) return "refused";
  if (!input.actorRole) return "refused";
  return (PLATFORM_ROLES as readonly string[]).includes(input.actorRole) ? "allowed" : "refused";
}

export type InstallAttemptOutcome = "linked" | "declined" | "failed" | "pending" | "unknown";

export type InstallAttemptEvent = {
  id: string;
  action: string;
  step: string;
  code: string | null;
  missingEnv: string[];
  createdAt: string;
};

export type InstallAttempt = {
  key: string;
  app: string;
  stateRef: string | null;
  outcome: InstallAttemptOutcome;
  startedAt: string;
  events: InstallAttemptEvent[];
};

const STEP_LABELS: Readonly<Record<string, string>> = {
  "channel.messaging_install.started": "issued",
  "channel.messaging_install.start_refused": "refused",
  "channel.messaging_install.declined": "callback",
  "channel.messaging_install.failed": "callback",
  "channel.messaging_install.completed": "stored",
  "platform.provisioning_install.declined": "callback",
  "platform.provisioning_install.failed": "callback",
  "platform.provisioning_install.completed": "stored",
};

const OUTCOMES: Readonly<Record<string, InstallAttemptOutcome>> = {
  "channel.messaging_install.started": "pending",
  "channel.messaging_install.start_refused": "failed",
  "channel.messaging_install.declined": "declined",
  "channel.messaging_install.failed": "failed",
  "channel.messaging_install.completed": "linked",
  "platform.provisioning_install.declined": "declined",
  "platform.provisioning_install.failed": "failed",
  "platform.provisioning_install.completed": "linked",
};

const APP_LABELS: Readonly<Record<string, string>> = {
  agent: "Messaging app",
  provisioning: "Provisioning app",
  unknown: "Unnamed app",
};

function after(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") return {};
  const inner = (payload as { after?: unknown }).after;
  return inner && typeof inner === "object" ? inner as Record<string, unknown> : {};
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function installAppLabel(app: string) {
  return APP_LABELS[app] ?? APP_LABELS.unknown;
}

/**
 * Which app an event belongs to, read off the action itself.
 *
 * Only the routes that refuse or fail an install write `app` into the payload;
 * the two success callbacks build `after` by hand and leave it out. Rows arrive
 * newest-first, so a finished install's completion row was the first one seen
 * for its state_ref and seeded the group as "unknown" -- and the `started` row
 * that did name the app came later and could not correct it. So every attempt
 * that actually worked was labelled "Unnamed app", which is the one case where
 * we certainly do know.
 *
 * The action namespace has carried the answer the whole time and is written by
 * the same code path that writes the row, so it cannot drift from it.
 */
export function installAppFromAction(action: string): string | null {
  if (action.startsWith("channel.messaging_install.")) return "agent";
  if (action.startsWith("platform.provisioning_install.")) return "provisioning";
  return null;
}

export function installAttempts(rows: readonly InstallEventRow[]): InstallAttempt[] {
  const grouped = new Map<string, { app: string; stateRef: string | null; events: InstallAttemptEvent[] }>();

  for (const row of rows) {
    const context = after(row.payload);
    const stateRef = text(context.state_ref);
    // A callback with no state has no attempt to belong to. Keying it on its own row id keeps it
    // visible instead of merging it into one it has nothing to do with.
    const key = stateRef ?? `row:${row.id}`;
    const group = grouped.get(key) ?? { app: "unknown", stateRef, events: [] };
    // The first row that can name the app names it for the whole group: an
    // attempt is one install, and which row lands first is down to the sort, not
    // to which one carries the field. Within a row the payload wins over the
    // action, because the route wrote it deliberately.
    const named = text(context.app) ?? installAppFromAction(row.action);
    if (group.app === "unknown" && named) group.app = named;
    group.events.push({
      id: row.id,
      action: row.action,
      step: STEP_LABELS[row.action] ?? "event",
      code: text(context.error_code) ?? text(row.reason),
      missingEnv: Array.isArray(context.missing_env)
        ? context.missing_env.filter((name): name is string => typeof name === "string")
        : [],
      createdAt: row.createdAt,
    });
    grouped.set(key, group);
  }

  return [...grouped.entries()]
    .map(([key, group]) => {
      const events = [...group.events].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const last = events[events.length - 1];
      return {
        key,
        app: group.app,
        stateRef: group.stateRef,
        // Not "pending": that renders as "Approval not back yet", which is a false claim about an
        // event that plainly did come back. An action nobody has mapped yet is unknown, not open.
        outcome: OUTCOMES[last.action] ?? "unknown",
        startedAt: events[0].createdAt,
        events,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_ATTEMPTS);
}

/**
 * A closed set of sentences. An unrecognised code does not get one invented for it - a sentence we
 * did not write for a code we did not expect would be a claim about an outcome nobody checked - and
 * it does not get echoed back either, because the component already prints the raw code beside the
 * gloss and would render the identifier twice. It gets a sentence that says exactly that.
 */
const GLOSSES: Readonly<Record<string, string>> = {
  GHL_OAUTH_STATE_MISSING:
    "The approval came back without the one-time marker the install link carried, so there was nothing to match it to. Nothing was stored.",
  GHL_OAUTH_STATE_EXPIRED:
    "The install link had already expired by the time the approval came back. Nothing was stored - issue a new link and approve it within ten minutes.",
  GHL_OAUTH_STATE_INVALID_OR_REPLAYED:
    "The marker on this approval was never issued here, or it had already been used once. Nothing was stored.",
  GHL_OAUTH_STATE_APP_MISMATCH:
    "The approval came back to the other app's callback, so it was refused. Nothing was stored.",
  GHL_OAUTH_CODE_MISSING:
    "The approval came back without the one-time code needed to exchange it for a token. Nothing was stored.",
  GHL_OAUTH_PROVIDER_DECLINED:
    "The approval was declined on the provider's side. Nothing was stored.",
  GHL_OAUTH_GRANT_REVOKED:
    "The token endpoint answered 400 or 401, which means the approval was already spent or withdrawn. Nothing was stored.",
  GHL_OAUTH_TOKEN_ENVELOPE_INVALID:
    "The token came back but did not name the company or location it belongs to, so there was nothing to attach it to. Nothing was stored.",
  GHL_OAUTH_TOKEN_EXCHANGE_FAILED:
    "The token endpoint refused the exchange. Nothing was stored.",
  GHL_OAUTH_TOKEN_EXCHANGE_FAILED_NETWORK:
    "The token endpoint could not be reached at all. Nothing was stored, and this one is worth retrying.",
  GHL_OAUTH_TOKEN_EXCHANGE_FAILED_MALFORMED_JSON:
    "The token endpoint answered with something that was not JSON. Nothing was stored.",
  GHL_INSTALL_START_ROLE_FORBIDDEN:
    "The person who clicked is not an owner or admin, so no install link was issued.",
  GHL_INSTALL_START_IMPERSONATION_FORBIDDEN:
    "An install cannot be started while viewing the platform as a client. No install link was issued.",
  GHL_INSTALL_START_REQUEST_INVALID:
    "The request did not name an app we install, so no install link was issued.",
  GHL_INSTALL_START_AUDIT_FAILED:
    "The install link was issued but its record could not be written, so the attempt was abandoned rather than left unlogged.",
  GHL_INSTALL_AUDIT_FAILED:
    "The connection was stored but its record could not be written, so the approval was reported as incomplete.",
  GHL_AGENCY_INSTALL_AUDIT_FAILED:
    "The connection was stored but its record could not be written, so the approval was reported as incomplete.",
  GHL_INSTALL_TENANT_UNRESOLVED:
    "Nothing named which client this location belongs to, so the connection could not have carried a message in either direction. Nothing was stored.",
  GHL_INSTALL_LOCATION_BOUND_ELSEWHERE:
    "This location already belongs to another client, and an approval does not get to move it. Nothing was stored.",
  GHL_INSTALL_START_TENANT_FORBIDDEN:
    "The request named a client other than the one the person signing in belongs to, so no install link was issued.",
  GHL_AGENCY_INSTALL_USER_TYPE_UNEXPECTED:
    "The approval came back covering a single location where an agency-wide one was required. Nothing was stored.",
  GHL_OAUTH_STATE_ALREADY_COMPLETED:
    "The marker on this approval had already been used by an install that finished, so this is a repeat of something that already worked. Nothing was stored, and nothing needs to be.",
  GHL_AGENCY_INSTALL_LEASE_LOST:
    "Another refresh of the agency connection was running at the same time and won it. This one's token was discarded on purpose rather than overwrite the winner's, and what the winner left could not be used either - worth retrying.",
  GHL_INSTALL_LEASE_LOST:
    "Two refreshes of this one client's connection collided and the other won. This one's token was discarded rather than overwrite it, and the winner's could not be used either - worth retrying.",
  GHL_INSTALL_SECRET_WRITE_FAILED:
    "The install record was written but the credential beside it was not, so the connection exists and cannot authenticate. It needs approving again.",
  GHL_INSTALL_UNEXPECTED_ERROR:
    "Something failed that we do not have a name for. The details were dropped rather than logged, because they can carry request context.",
};

const UNNAMED_CODE =
  "No explanation has been written for this code yet, so what it means has to come from the record itself and from whoever added it.";

export function installEventGloss(code: string, context?: { missingEnv?: readonly string[] }) {
  if (code === "DRIVER_CONFIGURATION_ERROR") {
    const names = context?.missingEnv?.length ? context.missingEnv.join(", ") : "unnamed";
    return `This deployment is missing configuration, so nothing could be started: ${names}.`;
  }
  return GLOSSES[code] ?? UNNAMED_CODE;
}
