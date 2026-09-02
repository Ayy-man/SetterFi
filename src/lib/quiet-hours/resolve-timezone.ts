/**
 * Resolves the conservative timezone set used for lead-local quiet hours.
 *
 * A supplied IANA zone is direct evidence. Phone provenance is weaker, so an
 * ambiguous NPA keeps every candidate and an unknown NPA falls back to the
 * intersection of the four continental US zones rather than guessing one.
 */

import { NPA_TIMEZONES } from "./npa-timezones.generated";

export const CONTINENTAL_FALLBACK_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
] as const;

export type TimezoneResolution = {
  timezones: readonly string[];
  source: "contact" | "npa" | "continental_intersection";
};

function isValidIanaTimezone(timezone: string | null | undefined) {
  if (!timezone?.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function extractUsNpa(normalizedPhone: string | null | undefined) {
  const digits = normalizedPhone?.replace(/\D/gu, "") ?? "";
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1, 4);
  if (digits.length === 10) return digits.slice(0, 3);
  return null;
}

export function resolveLeadTimezones(
  contactTimezone: string | null | undefined,
  normalizedPhone: string | null | undefined,
): TimezoneResolution {
  const timezone = contactTimezone?.trim();
  if (timezone && isValidIanaTimezone(timezone)) {
    return { timezones: [timezone], source: "contact" };
  }

  const npa = extractUsNpa(normalizedPhone);
  const candidates = npa && npa in NPA_TIMEZONES
    ? NPA_TIMEZONES[npa as keyof typeof NPA_TIMEZONES]
    : null;
  if (candidates?.length) return { timezones: candidates, source: "npa" };

  return {
    timezones: CONTINENTAL_FALLBACK_TIMEZONES,
    source: "continental_intersection",
  };
}
