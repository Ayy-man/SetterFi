/**
 * Lead-local quiet-hours enforcement behind the frozen QuietHoursPort.
 *
 * Civil dates are projected independently for every candidate timezone. Their
 * UTC intervals are then intersected, so DST changes and ambiguous area codes
 * can only narrow the send window and never make it more permissive.
 */

import {
  CONTROL_MESSAGE_PURPOSES,
  type QuietHoursDecision,
  type QuietHoursInput,
  type QuietHoursPort,
} from "@/lib/sends/contracts";

import { resolveLeadTimezones } from "./resolve-timezone";

const PLATFORM_OPEN_MINUTE = 8 * 60;
const PLATFORM_CLOSE_MINUTE = 20 * 60;
const MAX_DEFERRAL_MS = 24 * 60 * 60 * 1_000;
const MAX_JITTER_MS = 5 * 60 * 1_000;
const SEARCH_DAYS = 8;

type CivilDate = { year: number; month: number; day: number };
type CivilDateTime = CivilDate & { hour: number; minute: number; second: number };
type UtcInterval = { open: number; close: number };

export type QuietHoursContext = {
  followupId: string;
  contactTimezone: string | null;
  normalizedPhone: string | null;
  quietHoursStart: string;
  quietHoursEnd: string;
};

export type QuietHoursContextLoader = (
  input: QuietHoursInput,
) => Promise<QuietHoursContext>;

function localParts(instant: number, timezone: string): CivilDateTime {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour),
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function civilToUtc(
  date: CivilDate,
  minuteOfDay: number,
  timezone: string,
) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const target = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  let candidate = target;

  // Intl exposes offsets only through formatted parts. Iteration converges after
  // an offset transition without assuming that a local day is always 24 hours.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = localParts(candidate, timezone);
    const observedAsUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const difference = target - observedAsUtc;
    candidate += difference;
    if (difference === 0) break;
  }

  return candidate;
}

function parseMinuteOfDay(value: string) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/u.exec(value);
  if (!match) throw new Error("QUIET_HOURS_CONFIGURATION_INVALID");
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error("QUIET_HOURS_CONFIGURATION_INVALID");
  return hour * 60 + minute;
}

function lawfulMinutes(context: QuietHoursContext) {
  const requestedOpen = parseMinuteOfDay(context.quietHoursStart);
  const requestedClose = parseMinuteOfDay(context.quietHoursEnd);
  const open = Math.max(PLATFORM_OPEN_MINUTE, requestedOpen);
  const close = Math.min(PLATFORM_CLOSE_MINUTE, requestedClose);
  if (open >= close) throw new Error("QUIET_HOURS_CONFIGURATION_INVALID");
  return { open, close };
}

function clockLabel(minuteOfDay: number) {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function intervalsForTimezone(
  timezone: string,
  occurredAt: number,
  openMinute: number,
  closeMinute: number,
) {
  const local = localParts(occurredAt, timezone);
  const startDate = { year: local.year, month: local.month, day: local.day };
  return Array.from({ length: SEARCH_DAYS }, (_, offset): UtcInterval => {
    const date = addCivilDays(startDate, offset);
    return {
      open: civilToUtc(date, openMinute, timezone),
      close: civilToUtc(date, closeMinute, timezone),
    };
  });
}

function currentIntersection(
  timezones: readonly string[],
  occurredAt: number,
  openMinute: number,
  closeMinute: number,
) {
  const intervals = timezones.map((timezone) =>
    intervalsForTimezone(timezone, occurredAt, openMinute, closeMinute)[0]
  );
  const open = Math.max(...intervals.map((interval) => interval.open));
  const close = Math.min(...intervals.map((interval) => interval.close));
  return occurredAt >= open && occurredAt < close;
}

function nextIntersection(
  timezones: readonly string[],
  occurredAt: number,
  openMinute: number,
  closeMinute: number,
): UtcInterval {
  const schedules = timezones.map((timezone) =>
    intervalsForTimezone(timezone, occurredAt, openMinute, closeMinute)
  );
  const positions = schedules.map(() => 0);

  for (let attempt = 0; attempt < SEARCH_DAYS * timezones.length; attempt += 1) {
    const intervals = schedules.map((schedule, index) => schedule[positions[index]]);
    if (intervals.some((interval) => !interval)) break;
    const open = Math.max(occurredAt, ...intervals.map((interval) => interval.open));
    const close = Math.min(...intervals.map((interval) => interval.close));
    if (open < close) return { open, close };

    let advanced = false;
    for (let index = 0; index < intervals.length; index += 1) {
      if (intervals[index].close <= open) {
        positions[index] += 1;
        advanced = true;
      }
    }
    if (!advanced) positions[0] += 1;
  }

  throw new Error("QUIET_HOURS_INTERSECTION_UNAVAILABLE");
}

function boundedJitter(seed: string) {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % (MAX_JITTER_MS + 1);
}

export function decideQuietHours(
  input: QuietHoursInput,
  context: QuietHoursContext,
): QuietHoursDecision {
  if (CONTROL_MESSAGE_PURPOSES.includes(
    input.purpose as (typeof CONTROL_MESSAGE_PURPOSES)[number],
  )) {
    return { kind: "send_now" };
  }

  const occurredAt = Date.parse(input.occurredAt);
  const originalScheduledAt = input.originalScheduledAt
    ? Date.parse(input.originalScheduledAt)
    : occurredAt;
  if (!Number.isFinite(occurredAt) || !Number.isFinite(originalScheduledAt)) {
    throw new Error("QUIET_HOURS_INSTANT_INVALID");
  }
  if (occurredAt - originalScheduledAt > MAX_DEFERRAL_MS) {
    return { kind: "cancel_stale", reason: "stale" };
  }

  const resolution = resolveLeadTimezones(
    context.contactTimezone,
    context.normalizedPhone,
  );
  const { open, close } = lawfulMinutes(context);
  if (currentIntersection(resolution.timezones, occurredAt, open, close)) {
    return { kind: "send_now" };
  }
  if (input.deferredCount >= 1) {
    return { kind: "cancel_stale", reason: "already_deferred" };
  }

  const intersection = nextIntersection(resolution.timezones, occurredAt, open, close);
  const jitter = boundedJitter(`${input.tenantId}:${context.followupId}`);
  const deferredAt = Math.min(intersection.open + jitter, intersection.close - 1);
  if (deferredAt - originalScheduledAt > MAX_DEFERRAL_MS) {
    return { kind: "cancel_stale", reason: "stale" };
  }

  return {
    kind: "defer_once",
    at: new Date(deferredAt).toISOString(),
    timezoneSource: resolution.source,
    leadLocalTimes: resolution.timezones.map((timezone) => {
      const local = localParts(occurredAt, timezone);
      return `${timezone}: ${clockLabel(local.hour * 60 + local.minute)}`;
    }),
    allowedWindow: `${clockLabel(open)}–${clockLabel(close)}`,
  };
}

export function createQuietHoursPort(loadContext: QuietHoursContextLoader): QuietHoursPort {
  return {
    async resolve(input) {
      return decideQuietHours(input, await loadContext(input));
    },
  };
}
