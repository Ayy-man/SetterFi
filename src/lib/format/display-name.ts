/**
 * A seeded name, as a reader should see it.
 *
 * `scripts/fixtures/names.mjs` staples `(demo)` onto every tenant, person and plan it writes, so
 * that a row's provenance is legible in the database itself and no demo record can be mistaken for
 * a real one in a query. That rule is right where it lives and this does not weaken it: the suffix
 * stays in the column.
 *
 * It is wrong on screen, though, because the screen already says it. A client row on Clients reads
 * "Reid Funding Group (demo)" and then renders a "Demo" pill immediately after it, and an Inbox
 * row manages the marker three times in two lines -- tenant, assignee, and again in the message
 * body. Six repetitions of one fact per screen is most of what makes those panes read as clutter,
 * and none of the repetitions carry anything the pill does not.
 *
 * So the marker is stripped exactly where a human reads the name, and only there. Every surface
 * that strips it has to show the demo state some other way; on the console that is already the
 * pill beside the name, driven by `is_demo` rather than by the text. Exports, audit rows, error
 * codes and anything a log search has to match keep the raw string, because those are read by
 * machines and by people chasing a specific record.
 */

/** The marker as the seeders write it: a trailing `(demo)`, after optional space, case-insensitive. */
const DEMO_SUFFIX = /\s*\(demo\)\s*$/iu;

/**
 * The name without its seeded provenance marker.
 *
 * Only a trailing marker is removed, and only one: a name that carries `(demo)` in its middle is
 * saying something this does not understand, and guessing at it would be worse than leaving it.
 */
export function displayName(value: string): string {
  return value.replace(DEMO_SUFFIX, "").trim() || value.trim();
}

/**
 * The same, for a value that may be absent.
 *
 * The absence is passed through rather than turned into an empty string, because "no assignee" and
 * "an assignee whose name is blank" are different facts and the caller decides how to say each.
 */
export function displayNameOrNull(value: string | null | undefined): string | null {
  return value == null ? null : displayName(value);
}
