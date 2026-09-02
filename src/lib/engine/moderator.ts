/**
 * Verdict-only moderator boundary.
 *
 * The payload is deliberately six fields and excludes both the Brain and coach-data block. Raw
 * provider output is closed-schema parsed so a reviewer can never smuggle replacement copy back.
 */

import type { ModeratorDriver } from "@/lib/integrations/types";
import { MODERATOR_CLASSES, type ModeratorClass } from "@/lib/engine/types";

export type ModeratorPayload = Parameters<ModeratorDriver["moderate"]>[0];
export type ModeratorCall = (inputs: ModeratorPayload) => Promise<unknown>;

export type ModeratorVerdict = {
  verdict: "allow" | "block";
  class: ModeratorClass;
  rule_id?: string;
  reason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function buildModeratorPayload(input: ModeratorPayload): ModeratorPayload {
  return {
    draft: input.draft,
    leadMessage: input.leadMessage,
    numberAllowlist: [...input.numberAllowlist],
    complianceLexicon: [...input.complianceLexicon],
    linkWhitelist: [...input.linkWhitelist],
    roleBoundary: input.roleBoundary,
  };
}

export function parseModeratorVerdict(value: unknown): ModeratorVerdict {
  if (!isRecord(value)) throw new Error("MODERATOR_VERDICT_NOT_OBJECT");
  const keys = Object.keys(value).sort();
  const expected = value.rule_id === undefined
    ? ["class", "reason", "verdict"]
    : ["class", "reason", "rule_id", "verdict"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("MODERATOR_VERDICT_EXTRA_OR_MISSING_KEYS");
  }
  if (value.verdict !== "allow" && value.verdict !== "block") {
    throw new Error("MODERATOR_VERDICT_INVALID");
  }
  if (typeof value.class !== "string" || !MODERATOR_CLASSES.includes(value.class as ModeratorClass)) {
    throw new Error("MODERATOR_CLASS_INVALID");
  }
  if (typeof value.reason !== "string" || !value.reason.trim()) {
    throw new Error("MODERATOR_REASON_REQUIRED");
  }
  if (value.rule_id !== undefined && (typeof value.rule_id !== "string" || !value.rule_id.trim())) {
    throw new Error("MODERATOR_RULE_ID_INVALID");
  }
  return {
    verdict: value.verdict,
    class: value.class as ModeratorClass,
    ...(typeof value.rule_id === "string" ? { rule_id: value.rule_id } : {}),
    reason: value.reason,
  };
}

async function within<T>(promise: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MODERATOR_TIMEOUT")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function moderateDraft({
  driver,
  inputs,
  timeoutMs = 30_000,
}: {
  driver: { moderate: ModeratorCall };
  inputs: ModeratorPayload;
  mode: "production" | "test" | "eval";
  // Matches the real driver's transport abort: the configured moderator is a reasoning model
  // (gpt-5: ~6s at minimal effort, 18s at default), so a shorter race here turns every verdict
  // into a refusal before the provider answers.
  timeoutMs?: number;
}) {
  const payload = buildModeratorPayload(inputs);
  try {
    const verdict = parseModeratorVerdict(await within(driver.moderate(payload), timeoutMs));
    return verdict.verdict === "allow"
      ? { kind: "allowed" as const, verdict, payload }
      : { kind: "blocked" as const, verdict, payload };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "MODERATOR_PROVIDER_ERROR";
    return {
      kind: "refused" as const,
      proceed: false as const,
      moderatorUnavailableIncrement: 1 as const,
      trace: { moderator: "unavailable" as const, reason },
      payload,
    };
  }
}
