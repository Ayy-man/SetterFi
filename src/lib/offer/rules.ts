/**
 * The coach's own qualification rules.
 *
 * The four stored bounds (credit score, funding goal, monthly revenue, credit repair) cover the
 * questions every funding coach asks. Everything past that is the coach's to write: a subject
 * they name, one condition from a fixed set, and a free value. The rule is stored as data and
 * read back as one English sentence, and that sentence is what the agent's prompt ingests, so the
 * wording lives here once and every surface (editor, setup readback, prompt) says the same thing.
 */

export const OFFER_RULE_OPS = [
  "is",
  "is_not",
  "at_least",
  "at_most",
  "between",
  "includes",
  "excludes",
  "one_of",
  "not_one_of",
  "must_be_true",
  "rules_out",
] as const;

export type OfferRuleOp = (typeof OFFER_RULE_OPS)[number];

export type OfferQualificationRule = {
  /** What the rule is about, in the coach's words: "Location", "Time in business". */
  subject: string;
  op: OfferRuleOp;
  /** Free text; a comma-separated list for the list conditions, empty for the two that take none. */
  value: string;
};

export const OFFER_RULE_BOUNDS = {
  maxRows: 12,
  subjectMax: 60,
  valueMax: 200,
} as const;

/** The condition as the coach reads it in the dropdown. */
export const OFFER_RULE_OP_LABELS: Record<OfferRuleOp, string> = {
  is: "is",
  is_not: "is not",
  at_least: "at least",
  at_most: "at most",
  between: "between",
  includes: "includes",
  excludes: "does not include",
  one_of: "is one of",
  not_one_of: "is not one of",
  must_be_true: "must be true",
  rules_out: "rules them out",
};

/** Conditions that carry no value: the subject alone is the rule. */
export const OFFER_RULE_OPS_WITHOUT_VALUE: readonly OfferRuleOp[] = ["must_be_true", "rules_out"];

/** Conditions whose value is a list the coach types with commas. */
export const OFFER_RULE_LIST_OPS: readonly OfferRuleOp[] = ["one_of", "not_one_of"];

export function ruleTakesValue(op: OfferRuleOp) {
  return !OFFER_RULE_OPS_WITHOUT_VALUE.includes(op);
}

export function ruleIsList(op: OfferRuleOp) {
  return OFFER_RULE_LIST_OPS.includes(op);
}

/** Splits a list value on commas, dropping blanks, so "India, , Bangladesh" reads as two items. */
export function ruleListItems(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function joinItems(items: readonly string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * The rule as one sentence: "Location is not one of India or Bangladesh". Null when the rule is
 * not complete enough to say anything, which the editor shows as a placeholder and the prompt
 * omits.
 */
export function ruleSentence(rule: OfferQualificationRule): string | null {
  const subject = rule.subject.trim();
  if (!subject) return null;
  const value = rule.value.trim();
  switch (rule.op) {
    case "must_be_true":
      return `${subject} must be true`;
    case "rules_out":
      return `${subject} rules them out`;
    case "one_of":
    case "not_one_of": {
      const items = ruleListItems(value);
      if (items.length === 0) return null;
      return `${subject} ${OFFER_RULE_OP_LABELS[rule.op]} ${joinItems(items)}`;
    }
    case "at_least":
    case "at_most":
      return value ? `${subject} is ${OFFER_RULE_OP_LABELS[rule.op]} ${value}` : null;
    case "between":
      return value ? `${subject} is between ${value}` : null;
    default:
      return value ? `${subject} ${OFFER_RULE_OP_LABELS[rule.op]} ${value}` : null;
  }
}

/** Every complete rule as a sentence, in the coach's order. */
export function ruleSentences(rules: readonly OfferQualificationRule[]): string[] {
  return rules.map(ruleSentence).filter((sentence): sentence is string => sentence !== null);
}
