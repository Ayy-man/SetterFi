/**
 * Canonical normalization for suppression text and channel identifiers.
 *
 * Keyword matching and HMAC input share these helpers so Unicode or formatting variants cannot
 * create a second suppression identity while raw values remain outside persistence.
 */

import type { MessagingChannel } from "@/lib/booking/types";

const PHONE_CHANNELS = new Set<MessagingChannel>(["sms", "whatsapp"]);

export function normalizeControlText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function normalizeSuppressionIdentifier(channel: MessagingChannel, value: string) {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  if (!PHONE_CHANNELS.has(channel)) return normalized.length <= 200 ? normalized : null;
  const compact = normalized.replace(/[\s().-]+/gu, "");
  return /^\+[1-9][0-9]{7,14}$/u.test(compact) ? compact : null;
}

export function suppressionIdentifierLast4(normalizedIdentifier: string) {
  return [...normalizedIdentifier].slice(-4).join("");
}
