/**
 * Pure alert projections and polling decisions.
 *
 * Network and timer effects stay in the two client components. This module owns the
 * rules that must remain testable without a DOM: locked preferences, receipt-backed
 * unread state, minimum polling cadence, visibility stops, and error backoff.
 */

import type { Preference } from "@/app/api/notification-preferences/handler";
import type { BellNotification } from "@/lib/notifications/bell";

export const NOTIFICATION_POLL_INTERVAL_MS = 30_000;
const NOTIFICATION_ERROR_BACKOFF_MAX_MS = 5 * 60_000;

export type AlertRuleView = {
  ruleId: string;
  event: string;
  scope: "tenant" | "platform";
  name: string;
  /** The rule's authored sentence from `alert_rules.description`. May be empty; see `AlertRuleView`
   * consumers, which fall back rather than render a blank line. */
  description: string;
  category: string;
  audience: string;
  destinations: readonly ("bell" | "email" | "slack")[];
  required: boolean;
  enabled: boolean;
  bell: Preference;
  email: Preference;
  slack: Preference;
};

export type NotificationListState = {
  status: "idle" | "ready" | "error";
  notifications: readonly BellNotification[];
  lastSuccessAt: number | null;
  errorCount: number;
};

export type NotificationPollDecision = {
  action: "poll" | "wait" | "preserve" | "stop";
  nextDueAt: number | null;
};

export type NotificationPollError = {
  at: number;
  count: number;
} | null;

export type JsonRequest = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, "ok" | "json">>;

export const EMPTY_NOTIFICATION_STATE: NotificationListState = {
  status: "idle",
  notifications: [],
  lastSuccessAt: null,
  errorCount: 0,
};

function preferenceFor(
  preferences: readonly Preference[],
  destination: "bell" | "email" | "slack",
) {
  return preferences.find((preference) => preference.destination === destination) ?? null;
}

export function alertRuleViews(preferences: readonly Preference[]): AlertRuleView[] {
  const byRule = new Map<string, Preference[]>();
  for (const preference of preferences) {
    const current = byRule.get(preference.ruleId) ?? [];
    current.push(preference);
    byRule.set(preference.ruleId, current);
  }

  return [...byRule.values()].flatMap((rulePreferences) => {
    const first = rulePreferences[0];
    const bell = preferenceFor(rulePreferences, "bell");
    const email = preferenceFor(rulePreferences, "email");
    const slack = preferenceFor(rulePreferences, "slack");
    if (!first || !bell || !email || !slack) return [];
    return [{
      ruleId: first.ruleId,
      event: first.event,
      scope: first.scope,
      name: first.name,
      description: first.description,
      category: first.category,
      audience: first.audience,
      destinations: first.defaultDestinations,
      required: first.locked,
      enabled: first.defaultEnabled,
      bell,
      email,
      slack,
    }];
  }).sort((left, right) => `${left.event}:${left.scope}`.localeCompare(`${right.event}:${right.scope}`));
}

export function applyPreferenceReadBack(
  current: readonly Preference[],
  readBack: Pick<Preference, "ruleId" | "destination" | "enabled" | "locked"> | null,
) {
  if (!readBack) return current;
  return current.map((preference) =>
    preference.ruleId === readBack.ruleId && preference.destination === readBack.destination
      ? { ...preference, enabled: readBack.enabled, locked: readBack.locked }
      : preference);
}

export function canChangePreference(preference: Preference, nextEnabled: boolean) {
  return !preference.locked && preference.enabled !== nextEnabled;
}

export function notificationUnreadCount(state: NotificationListState) {
  return state.notifications.filter((notification) => notification.readAt === null).length;
}

export function notificationListReadBack(
  current: NotificationListState,
  result: { notifications: readonly BellNotification[]; at: number } | { error: true },
): NotificationListState {
  if ("error" in result) {
    return { ...current, status: "error", errorCount: current.errorCount + 1 };
  }
  return {
    status: "ready",
    notifications: result.notifications,
    lastSuccessAt: result.at,
    errorCount: 0,
  };
}

export function notificationPollSchedule(
  visibility: "visible" | "hidden",
  lastState: Pick<NotificationListState, "lastSuccessAt"> | null,
  now: number,
  lastError: NotificationPollError,
): NotificationPollDecision {
  if (visibility === "hidden") return { action: "stop", nextDueAt: null };
  if (lastError) {
    const backoff = Math.min(
      NOTIFICATION_POLL_INTERVAL_MS * 2 ** Math.max(0, lastError.count - 1),
      NOTIFICATION_ERROR_BACKOFF_MAX_MS,
    );
    return { action: "preserve", nextDueAt: Math.max(now, lastError.at + backoff) };
  }
  if (!lastState?.lastSuccessAt) return { action: "poll", nextDueAt: null };
  const nextDueAt = lastState.lastSuccessAt + NOTIFICATION_POLL_INTERVAL_MS;
  return nextDueAt <= now
    ? { action: "poll", nextDueAt: null }
    : { action: "wait", nextDueAt };
}

export function executeNotificationPollDecision(
  decision: NotificationPollDecision,
  dependencies: {
    now(): number;
    poll(): void | (() => void);
    schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
    cancel(timer: ReturnType<typeof setTimeout>): void;
  },
) {
  let stopPoll: void | (() => void);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const poll = () => {
    stopPoll = dependencies.poll();
  };

  if (decision.action === "poll") poll();
  if ((decision.action === "wait" || decision.action === "preserve")
    && decision.nextDueAt !== null) {
    timer = dependencies.schedule(poll, Math.max(0, decision.nextDueAt - dependencies.now()));
  }

  return () => {
    if (timer !== null) dependencies.cancel(timer);
    stopPoll?.();
  };
}

export async function loadNotificationPreferences(
  enabled: boolean,
  signal: AbortSignal,
  request: JsonRequest = fetch,
) {
  if (!enabled) return { kind: "disabled" as const };
  const response = await request("/api/notification-preferences", {
    cache: "no-store",
    signal,
  });
  if (!response.ok) return { kind: "error" as const };
  const payload = await response.json() as { preferences?: unknown };
  if (!Array.isArray(payload.preferences)) return { kind: "error" as const };
  return { kind: "ready" as const, preferences: payload.preferences as Preference[] };
}

export async function loadBellNotifications(
  enabled: boolean,
  signal: AbortSignal,
  request: JsonRequest = fetch,
) {
  if (!enabled) return { kind: "disabled" as const };
  const response = await request("/api/notifications", { cache: "no-store", signal });
  if (!response.ok) return { kind: "error" as const };
  const payload = await response.json() as { notifications?: unknown };
  if (!Array.isArray(payload.notifications)) return { kind: "error" as const };
  return { kind: "ready" as const, notifications: payload.notifications as BellNotification[] };
}
