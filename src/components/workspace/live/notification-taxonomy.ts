/**
 * The words and the order every notification surface uses for the same three database columns.
 *
 * `alert_rules` carries `category`, `scope` and, through `notification_preferences`, a
 * `destination`. All three are stored as identifiers, and each of the three surfaces that render
 * them (the console notifications page, the coach settings page, the account sheet) had its own
 * copy of the mapping from identifier to reader-facing word. That is how the account sheet ended
 * up printing no section headings at all while `alert-settings.tsx` printed nine, and how a
 * category the seed data added later ("channel") reached the sheet's icon map under a name the
 * database never uses ("channels").
 *
 * Nothing here invents a taxonomy. The categories are the distinct values the migrations seed into
 * `alert_rules.category`, the scopes are the column's own two values, and the destinations are read
 * off whatever the preferences API returned rather than listed anywhere. A category, or a
 * destination, that arrives without an entry here still renders: it falls back to its own words,
 * title-cased, so a new seed row is a heading rather than a blank.
 */

import type { AlertRuleView } from "@/components/workspace/live/notification-view-models";

/**
 * What a reader calls each seeded category.
 *
 * Keys are the literal `alert_rules.category` values from the migrations: `agent`, `billing`,
 * `booking`, `brain`, `channel`, `compliance`, `conversation`, `onboarding`, `safety`. The plural
 * "channels" is deliberately not a key, because the column never holds it.
 */
export const CATEGORY_LABELS: Record<string, string> = {
  agent: "Your setter",
  billing: "Billing",
  brain: "The Brain",
  booking: "Bookings",
  channel: "Channels",
  compliance: "Compliance",
  conversation: "Conversations",
  onboarding: "Setup",
  safety: "Safety",
};

/**
 * A category the seed data has not named yet still needs a heading, and printing the raw column
 * value would put a database identifier on a reader's screen. Title-casing the words is the honest
 * fallback: it says exactly what the row says, in the reader's alphabet.
 */
export function categoryLabel(category: string) {
  const known = CATEGORY_LABELS[category];
  if (known) return known;
  const words = category.split(/[_\s-]+/u).filter(Boolean);
  if (words.length === 0) return "Other notices";
  return words
    .map((word, index) => (index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/** The two values of `alert_rules.scope`, as a reader says them. */
export function scopeLabel(scope: AlertRuleView["scope"]) {
  return scope === "platform" ? "Platform" : "Client account";
}

export type NotificationRuleGroup = {
  category: string;
  label: string;
  rules: readonly AlertRuleView[];
};

/**
 * The rules grouped into sections, in the order the categories first appear.
 *
 * First-appearance order rather than an alphabet: the API returns rules ordered by event key, so
 * this follows the server's own ordering and a reader who exports the table sees the sections in
 * the order the rows come back.
 */
export function groupRulesByCategory(
  rules: readonly AlertRuleView[],
): readonly NotificationRuleGroup[] {
  const groups = new Map<string, AlertRuleView[]>();
  for (const rule of rules) {
    const current = groups.get(rule.category);
    if (current) current.push(rule);
    else groups.set(rule.category, [rule]);
  }
  return [...groups].map(([category, categoryRules]) => ({
    category,
    label: categoryLabel(category),
    rules: categoryRules,
  }));
}

/**
 * The scope word a row needs in order to be told apart from another row, or null.
 *
 * Two `alert_rules` rows are distinct when they differ in `event_key` or `scope`, and the seed
 * convention is that a platform-scoped rule and its tenant-scoped twin are named differently:
 * "Tripwire escalation" against "Conversation escalated", "SMS registration permanently blocked"
 * against "SMS registration permanently unavailable". Three pairs broke that convention and were
 * seeded with one name across both scopes, so the console listed what looked like the same
 * notification twice with two independent sets of checkboxes.
 *
 * `20261012000002_disambiguate_platform_alert_rule_names.sql` renames those three. This stays as
 * the general guard, because the names live in a table the client's own team edits: any future
 * collision is disambiguated on screen by the column that actually makes the rows different,
 * rather than by somebody noticing. A name that is unique in the rendered set gets nothing, so the
 * qualifier appears where it does work and nowhere else.
 */
export function scopeQualifiers(
  rules: readonly AlertRuleView[],
): ReadonlyMap<string, string | null> {
  const counts = new Map<string, number>();
  for (const rule of rules) counts.set(rule.name, (counts.get(rule.name) ?? 0) + 1);
  return new Map(rules.map((rule) => [
    rule.ruleId,
    (counts.get(rule.name) ?? 0) > 1 ? scopeLabel(rule.scope) : null,
  ]));
}

/** What a reader calls each delivery destination, per surface. */
export const DESTINATION_LABELS: Record<string, string> = {
  bell: "Bell",
  email: "Email",
};

/**
 * The coach's words for the same destinations. "Bell" is the console's name for a column in a
 * matrix; a coach's question is where a notice turns up, not which row of
 * `notification_preferences` it writes.
 */
export const COACH_DESTINATION_LABELS: Record<string, string> = {
  bell: "In the app",
  email: "Email",
};

export function destinationLabel(destination: string, labels: Record<string, string>) {
  return labels[destination] ?? categoryLabel(destination);
}

export type DestinationColumn = { destination: string; label: string };

/**
 * The destination columns to draw, read off the preferences the API actually returned.
 *
 * This is the point of the function. The column set used to be a literal in each surface, so
 * retiring a destination meant finding every one of those literals: when Slack was removed from
 * `notification_preferences.destination` the same three-item list had to be edited in the console
 * matrix, the coach list, the export columns and the sheet. Derived from the payload, a
 * destination that stops being stored stops being drawn, and one that is added appears with its
 * own label or a title-cased fallback, with no edit here.
 *
 * Order is first appearance, which is the order the route builds its rows in, so the columns hold
 * still between loads.
 */
export function destinationColumns(
  preferences: readonly { destination: string }[],
  labels: Record<string, string> = DESTINATION_LABELS,
): readonly DestinationColumn[] {
  const seen: string[] = [];
  for (const preference of preferences) {
    if (!seen.includes(preference.destination)) seen.push(preference.destination);
  }
  return seen.map((destination) => ({
    destination,
    label: destinationLabel(destination, labels),
  }));
}
