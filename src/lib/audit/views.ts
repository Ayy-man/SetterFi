/**
 * The four saved views on the audit screen, and the one definition of what each of them contains.
 *
 * This used to live inside the client component, which meant the counts on the segmented control
 * were counts of the loaded page: "Pauses 3" over a log holding two hundred pauses, because page
 * one happened to carry three. A reader treats that number as the answer to "how much of this
 * happened", and paging changed it. The rule now lives here so the loader can apply it in the
 * query and count against the whole window, and the component can still classify a row it already
 * holds without a second read.
 *
 * Both halves are spelled once: `auditCategoryOf` is the predicate, `auditViewFilter` is the same
 * rule as a PostgREST expression, and a test walks the whole registry asserting the two agree.
 */

import { AUDIT_ACTIONS } from "./actions";

export const AUDIT_VIEWS = [
  { key: "all", label: "Everything", category: null },
  { key: "publish", label: "Publishes", category: "publish" },
  { key: "takeover", label: "Takeovers", category: "takeover" },
  { key: "pause", label: "Pauses", category: "pause" },
] as const satisfies readonly { key: string; label: string; category: EventCategoryKey | null }[];

export type AuditViewKey = (typeof AUDIT_VIEWS)[number]["key"];

/**
 * Tones follow the artifact's own hues: teal for a publish, amber for a person stepping into a
 * live thread, clay for something that stopped, periwinkle for machine activity.
 */
export const EVENT_CATEGORY_KEYS = ["publish", "takeover", "pause", "automatic", "change"] as const;

export type EventCategoryKey = (typeof EVENT_CATEGORY_KEYS)[number];

/** A publish changes what an agent says next, and the suffix is how the log spells it. */
export const PUBLISH_SUFFIX = ".published";

/** The two publishes that do not wear the suffix: a rollback and an accepted import both land one. */
export const PUBLISH_ACTIONS = ["brain.import.accepted", "brain.rolled_back"] as const;

/** A person stepped into a live conversation the agent was holding. */
export const TAKEOVER_ACTIONS = [
  "conversation.escalated",
  "conversation.message.sent.human",
  "conversation.takeover.claimed",
  "conversation.takeover.released",
  "followup.claimed",
] as const;

/**
 * The agent stopped talking. Every key here is an event after which some lead did not get an
 * answer: a channel or calendar came off, a subscription was suspended, registration was blocked,
 * a provisioning step failed, or a specific reply was refused at the guardrail.
 */
export const PAUSE_ACTIONS = [
  "billing.tenant.suspended",
  "calendar.disconnected",
  "channel.disconnected",
  "conversation.scope_blocked",
  "conversation.tripwire.refused",
  "onboarding.a2p_blocked_permanent",
  "onboarding.step_failed",
  "send.refused.no_consent",
  "send.refused.suppressed",
  "send.refused.window_expired",
] as const;

const TAKEOVER_KEYS = new Set<string>(TAKEOVER_ACTIONS);
const PAUSE_KEYS = new Set<string>(PAUSE_ACTIONS);
const PUBLISH_KEYS = new Set<string>(PUBLISH_ACTIONS);

function isSystemAction(action: string) {
  return Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, action)
    ? AUDIT_ACTIONS[action as keyof typeof AUDIT_ACTIONS].actorKind === "system"
    : false;
}

/** A publish changes what an agent says next, so it outranks every other reading of the key. */
export function auditCategoryOf(action: string): EventCategoryKey {
  if (action.endsWith(PUBLISH_SUFFIX) || PUBLISH_KEYS.has(action)) return "publish";
  if (TAKEOVER_KEYS.has(action)) return "takeover";
  if (PAUSE_KEYS.has(action)) return "pause";
  if (isSystemAction(action)) return "automatic";
  return "change";
}

export function isAuditViewKey(value: string | null | undefined): value is AuditViewKey {
  return AUDIT_VIEWS.some((view) => view.key === value);
}

export function auditViewDefinition(view: AuditViewKey) {
  return AUDIT_VIEWS.find((entry) => entry.key === view) ?? AUDIT_VIEWS[0];
}

function inList(actions: readonly string[]) {
  return `action.in.(${actions.map((action) => `"${action}"`).join(",")})`;
}

/**
 * The same rule as a PostgREST `or` expression, for the row query and for the view's own count.
 *
 * `null` for Everything, which takes no clause at all rather than one listing every key the log
 * could hold. Publishes cannot be enumerated: the suffix is the rule, and the log carries keys the
 * frozen registry does not, so a list would silently drop a real publish written by a later
 * migration. It is a `like` on the suffix with the two exceptions beside it.
 */
export function auditViewFilter(view: AuditViewKey): string | null {
  if (view === "publish") return `action.like.*${PUBLISH_SUFFIX},${inList(PUBLISH_ACTIONS)}`;
  if (view === "takeover") return inList(TAKEOVER_ACTIONS);
  if (view === "pause") return inList(PAUSE_ACTIONS);
  return null;
}
