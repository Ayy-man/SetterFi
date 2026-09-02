/**
 * The one place a workspace surface is allowed to turn an instant into display text.
 *
 * `date.toLocaleString()` and a `timeZone`-less `Intl.DateTimeFormat` both read the ambient
 * zone of whatever runtime evaluates them. Vercel's server runs UTC and a browser runs the
 * viewer's zone, so the same instant serialised as "Aug 17, 4:35 PM" in the SSR HTML and then
 * re-rendered as "Aug 17, 10:05 PM" after hydration — React 19 error #418, on every table that
 * shows a time. Pinning the locale *and* the zone makes the two renders byte-identical.
 *
 * The zone is the platform's reporting zone, the same one the coach dashboard already names in
 * copy. It is a constant rather than a per-tenant read because there is no per-tenant display
 * zone plumbed to the client yet; when one exists it should arrive as a server-serialised prop
 * (identical on both renders by construction) and replace this constant.
 */

export const WORKSPACE_DISPLAY_TIMEZONE = "America/New_York";

const LOCALE = "en-US";

/**
 * "America/New_York" is a database key, not copy. Printed verbatim beside a billing period it
 * reads as a leaked identifier, so a surface that has to name the zone names the city.
 */
export function timezoneDisplayLabel(timezone: string | null | undefined) {
  const city = timezone?.split("/").at(-1)?.replaceAll("_", " ").trim();
  return city ? `${city} time` : null;
}

/** "Aug 17, 2026, 4:35 PM" — audit rows, support threads, anything where the date must be exact. */
export const workspaceTimestampFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** "Aug 17, 4:35 PM" — dense recent-activity columns where the year is noise. */
export const workspaceDateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** "Aug 17, 2026, 4:35 PM" spelled out rather than via dateStyle — compliance evidence rows. */
export const workspaceDateTimeYearFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/** "Aug 17, 2026" — day-grain chart labels and period boundaries. */
export const workspaceDateFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: WORKSPACE_DISPLAY_TIMEZONE,
});

/**
 * "Aug 17, 2026, 4:35 PM UTC" — an instant printed in UTC because the sentence around it says UTC.
 *
 * Everything above renders in the workspace's reporting zone, which is right for a row a coach
 * reads. It is wrong for a measurement's own methodology line: every platform metric in
 * `metric-definitions.ts` declares `clock: "UTC."` beside its window, so an instant translated to
 * New York and printed next to that word would be two clocks in one sentence. The suffix is part
 * of the string rather than left to the reader, because "Aug 17, 2026, 4:35 PM" with no zone is
 * the same ambiguity written more confidently.
 */
const utcTimestampFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});

/** Null for anything that is not a parseable instant: no date at all beats an "Invalid Date". */
export function utcTimestampLabel(iso: string | null | undefined) {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? `${utcTimestampFormat.format(new Date(value))} UTC` : null;
}

/** Digit grouping is locale-dependent too: hi-IN writes 1,23,456 where en-US writes 123,456. */
export const workspaceCountFormat = new Intl.NumberFormat(LOCALE);
