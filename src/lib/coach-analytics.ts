/**
 * Coach analytics range maths, kept out of the screen component so it can be tested
 * without rendering React and so the preset numbers and the custom-range numbers
 * provably come from one curve.
 */

export type CoachAnalytics = {
  label: string;
  leads: number;
  active: number;
  booked: number;
  disqualified: number;
  conversion: string;
  timeToBook: string;
  funnel: number[];
};

/**
 * Day-count anchors behind each preset range, so a custom span is derived from the
 * same curve the presets already draw rather than from a second set of numbers that
 * would drift away from them. Lead volume per day falls as the window widens
 * (11/day today, ~6.7/day across all time), which is why this interpolates between
 * anchors instead of multiplying one flat daily rate.
 */
const ANALYTICS_ANCHORS = [
  { days: 1, leads: 11, active: 7, booked: 1, disqualified: 2, timeToBookDays: 0.108, funnel: [11, 8, 3, 1] },
  { days: 7, leads: 57, active: 18, booked: 5, disqualified: 11, timeToBookDays: 1.8, funnel: [57, 39, 14, 5] },
  { days: 30, leads: 214, active: 31, booked: 18, disqualified: 37, timeToBookDays: 3.2, funnel: [214, 138, 54, 18] },
  { days: 90, leads: 611, active: 46, booked: 52, disqualified: 104, timeToBookDays: 3.0, funnel: [611, 405, 161, 52] },
  { days: 220, leads: 1482, active: 63, booked: 129, disqualified: 248, timeToBookDays: 2.9, funnel: [1482, 1014, 386, 129] },
] as const;

export const PRESET_ANALYTICS: Record<"1d" | "1w" | "1m" | "3m" | "all", CoachAnalytics> = {
  "1d": { label: "Today", leads: 11, active: 7, booked: 1, disqualified: 2, conversion: "9.1%", timeToBook: "2.6h", funnel: [11, 8, 3, 1] },
  "1w": { label: "Last 7 days", leads: 57, active: 18, booked: 5, disqualified: 11, conversion: "8.8%", timeToBook: "1.8d", funnel: [57, 39, 14, 5] },
  "1m": { label: "This month", leads: 214, active: 31, booked: 18, disqualified: 37, conversion: "8.4%", timeToBook: "3.2d", funnel: [214, 138, 54, 18] },
  "3m": { label: "Last 3 months", leads: 611, active: 46, booked: 52, disqualified: 104, conversion: "8.5%", timeToBook: "3.0d", funnel: [611, 405, 161, 52] },
  all: { label: "All time", leads: 1482, active: 63, booked: 129, disqualified: 248, conversion: "8.7%", timeToBook: "2.9d", funnel: [1482, 1014, 386, 129] },
};

function formatTimeToBookDays(days: number) {
  return days < 1 ? `${(days * 24).toFixed(1)}h` : `${days.toFixed(1)}d`;
}

/**
 * Inclusive day count, so picking the same date twice reads as one day rather than
 * zero. Returns null for an unparseable or reversed range, which the caller renders
 * as "pick both dates" instead of an empty dashboard.
 */
export function customRangeDays(from: string, to: string): number | null {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function analyticsForDays(days: number, label: string): CoachAnalytics {
  const longest = ANALYTICS_ANCHORS[ANALYTICS_ANCHORS.length - 1];
  const clamped = Math.min(longest.days, Math.max(1, days));
  const found = ANALYTICS_ANCHORS.findIndex((anchor) => anchor.days >= clamped);
  const upperIndex = found === -1 ? ANALYTICS_ANCHORS.length - 1 : found;
  const upper = ANALYTICS_ANCHORS[upperIndex];
  const lower = ANALYTICS_ANCHORS[Math.max(0, upperIndex - 1)];
  const span = upper.days - lower.days;
  const ratio = span === 0 ? 0 : (clamped - lower.days) / span;
  const between = (from: number, to: number) => Math.round(from + (to - from) * ratio);

  const leads = between(lower.leads, upper.leads);
  const booked = between(lower.booked, upper.booked);

  return {
    label,
    leads,
    active: between(lower.active, upper.active),
    booked,
    disqualified: between(lower.disqualified, upper.disqualified),
    conversion: `${leads ? ((booked / leads) * 100).toFixed(1) : "0.0"}%`,
    timeToBook: formatTimeToBookDays(
      lower.timeToBookDays + (upper.timeToBookDays - lower.timeToBookDays) * ratio,
    ),
    funnel: lower.funnel.map((value, index) => between(value, upper.funnel[index])),
  };
}
