import type { HeldTurnEvidence } from "@/lib/repositories/conversations";

const HELD_CLASS_COPY = {
  NUM: "used a number that is not in your offer",
  CLAIM: "made a promise your compliance rules forbid",
  ECHO: "repeated wording it should not",
  LINK: "included a link that is not approved",
  SCOPE: "went outside what your agent is allowed to discuss",
  LEN: "went over the SMS length",
  JUDGE: "failed a final compliance review",
} as const;

export type HeldEvidenceViewModel = {
  title: string;
  layer: "Checker" | "Moderator";
  rule: string;
  moderatorReason: string | null;
};

/**
 * This is intentionally a coach-facing projection, rather than a generic trace formatter. The
 * trace contains diagnostics coaches must not receive; only the seven evidence classes, a rule
 * identifier and the moderator's supplied reason cross this boundary.
 */
export function heldEvidenceViewModel(
  evidence: HeldTurnEvidence,
): HeldEvidenceViewModel {
  const reason = evidence.class ? HELD_CLASS_COPY[evidence.class] : evidence.layer === "moderator"
    ? "did not pass a final compliance review"
    : "did not pass the reply checks";
  return {
    title: `Held: ${reason}`,
    layer: evidence.layer === "moderator" ? "Moderator" : "Checker",
    rule: evidence.ruleId ?? "Not recorded",
    moderatorReason: evidence.moderatorReason,
  };
}
