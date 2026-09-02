/**
 * Deterministic STOP, HELP, and START classification before any model or prompt work.
 *
 * STOP is recognized on every channel because revocation follows the human. HELP and START are
 * reserved control words only on phone-bearing channels, where treating ordinary Meta chat as a
 * carrier command would create false state transitions.
 */

import type { MessagingChannel } from "@/lib/booking/types";
import { normalizeControlText } from "@/lib/suppression/normalize";

export type SuppressionKeywordResult =
  | { kind: "stop"; tier: "keyword" | "intent"; matched: string }
  | { kind: "help"; matched: string }
  | { kind: "start"; matched: string }
  | { kind: "none" };

const STOP_KEYWORDS = [
  "stop",
  "quit",
  "end",
  "revoke",
  "opt out",
  "cancel",
  "unsubscribe",
  "stopall",
  "optout",
  "unsub",
  "remove",
  "alto",
  "parar",
  "basta",
  "cancelar",
] as const;

const STOP_INTENTS = [
  "don t text me",
  "do not text me",
  "don t message me",
  "do not message me",
  "take me off your list",
  "remove me from your list",
  "leave me alone",
  "stop contacting me",
  "stop messaging me",
  "no more texts",
  "no more messages",
] as const;

const COURTESY_SUFFIXES = ["please", "pls", "thanks", "thank you"] as const;
const PHONE_CONTROL_CHANNELS = new Set<MessagingChannel>(["sms", "whatsapp"]);

function exactOrCourtesy(value: string, candidate: string) {
  return value === candidate || COURTESY_SUFFIXES.some((suffix) => value === `${candidate} ${suffix}`);
}

export function classifySuppressionKeyword(
  channel: MessagingChannel,
  body: string,
): SuppressionKeywordResult {
  const normalized = normalizeControlText(body);
  const keyword = STOP_KEYWORDS.find((candidate) => exactOrCourtesy(normalized, candidate));
  if (keyword) return { kind: "stop", tier: "keyword", matched: keyword };
  const intent = STOP_INTENTS.find((candidate) => exactOrCourtesy(normalized, candidate));
  if (intent) return { kind: "stop", tier: "intent", matched: intent };
  if (!PHONE_CONTROL_CHANNELS.has(channel)) return { kind: "none" };
  if (exactOrCourtesy(normalized, "help") || exactOrCourtesy(normalized, "info")) {
    return { kind: "help", matched: normalized.startsWith("info") ? "info" : "help" };
  }
  if (exactOrCourtesy(normalized, "start") || exactOrCourtesy(normalized, "unstop")) {
    return { kind: "start", matched: normalized.startsWith("unstop") ? "unstop" : "start" };
  }
  return { kind: "none" };
}
