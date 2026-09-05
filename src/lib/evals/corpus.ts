/**
 * Loader for the reviewed safety corpus under evals/corpus.
 *
 * JSON is the only case-data authority. This module supplies validation and typed projections;
 * unknown rule ids or duplicate keys refuse the whole run before a result can look green.
 */

import { createHash } from "node:crypto";

import compliance from "../../../evals/corpus/compliance.json";
import jailbreak from "../../../evals/corpus/jailbreak.json";
import outputIntegrity from "../../../evals/corpus/output-integrity.json";
import pricing from "../../../evals/corpus/pricing.json";

import { COMPLIANCE_RULE_IDS, type ComplianceRuleId } from "@/lib/brain/contracts";
import { serializeCanonicalJson, type CanonicalJson } from "@/lib/brain/snapshot/canonicalize";
import type { OutputCheckContext } from "@/lib/engine/output-checks";
import { OUTPUT_CHECK_CLASSES, type OutputCheckClass } from "@/lib/engine/types";

export const SAFETY_SUITES = [
  "compliance_guardrails",
  "pricing_discipline",
  "jailbreak_injection",
  "output_integrity",
] as const;
export type SafetySuite = (typeof SAFETY_SUITES)[number];

export const PHASE3_INBOUND_EXPECTATIONS = [
  "scope_attack",
  "tripwire_refuse",
  "tripwire_escalate",
  "suppression_keyword",
  "sanitizer",
] as const;
export type Phase3InboundExpectation = (typeof PHASE3_INBOUND_EXPECTATIONS)[number];

/**
 * What an engine case measures. Clean conversation categories expect a reply that no check
 * touches; refusal expects an in-scope decline; the rest are attacks or traps the checker or
 * moderator must hold.
 */
export const ENGINE_CASE_CATEGORIES = [
  "qualification",
  "objection",
  "booking",
  "brand_voice",
  "refusal",
  "injection",
  "extraction",
  "number_trap",
  "claim_trap",
  "suppression",
] as const;
export type EngineCaseCategory = (typeof ENGINE_CASE_CATEGORIES)[number];

export type SafetyCorpusCase = {
  key: string;
  suite: SafetySuite;
  kind: "checker" | "engine";
  turns: readonly { role: "lead" | "agent"; content: string }[];
  expectation:
    | { verdict: "pass"; class: OutputCheckClass; ruleIds: readonly ComplianceRuleId[] }
    | { verdict: "block"; class: OutputCheckClass; ruleIds: readonly ComplianceRuleId[] };
  inboundExpectation?: Phase3InboundExpectation;
  /** Required on engine cases; checker cases are single drafts and carry none. */
  category?: EngineCaseCategory;
  /** Reviewer notes on what the reply must and must not do; never read by the scorer. */
  notes?: readonly string[];
  context: OutputCheckContext;
};

export type LoadedSafetyCorpus = {
  revision: string;
  cases: readonly SafetyCorpusCase[];
};

const RAW_CORPUS = [compliance, pricing, jailbreak, outputIntegrity] as readonly unknown[];
const RULE_IDS = new Set<string>(COMPLIANCE_RULE_IDS);
const CHECK_CLASSES = new Set<string>(OUTPUT_CHECK_CLASSES);
const INBOUND_EXPECTATIONS = new Set<string>(PHASE3_INBOUND_EXPECTATIONS);
const ENGINE_CATEGORIES = new Set<string>(ENGINE_CASE_CATEGORIES);
const CHANNELS = new Set(["sms", "instagram", "messenger", "whatsapp", "webchat"]);
const NUMBER_KINDS = new Set(["currency", "percentage", "score"]);
const NUMBER_SOURCE_TYPES = new Set([
  "offer_price",
  "qualification_threshold",
  "brain_entry",
  "lead_message",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function refuse(caseKey: string, reason: string): never {
  throw new Error(`SAFETY_CORPUS_INVALID:${caseKey}:${reason}`);
}

function strings(value: unknown, caseKey: string, field: string) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    refuse(caseKey, field);
  }
  return value as string[];
}

function ruleIds(value: unknown, caseKey: string) {
  return strings(value, caseKey, "expectation.ruleIds").map((id) => {
    if (!RULE_IDS.has(id)) refuse(caseKey, `unknown_rule_id:${id}`);
    return id as ComplianceRuleId;
  });
}

function context(value: unknown, caseKey: string): OutputCheckContext {
  if (!isRecord(value)) refuse(caseKey, "context");
  const numberSources = value.numberSources;
  const complianceRules = value.complianceRules;
  if (!Array.isArray(numberSources) || !Array.isArray(complianceRules)) refuse(caseKey, "context_arrays");
  const parsedNumbers = numberSources.map((entry, index) => {
    if (!isRecord(entry) || !NUMBER_KINDS.has(String(entry.kind)) ||
      !NUMBER_SOURCE_TYPES.has(String(entry.sourceType)) || typeof entry.value !== "number" ||
      !Number.isFinite(entry.value) || typeof entry.sourceId !== "string") {
      refuse(caseKey, `context.numberSources[${index}]`);
    }
    return entry as OutputCheckContext["numberSources"][number];
  });
  const parsedRules = complianceRules.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.phrase !== "string") {
      refuse(caseKey, `context.complianceRules[${index}]`);
    }
    if (!RULE_IDS.has(entry.id)) refuse(caseKey, `unknown_rule_id:${entry.id}`);
    return { id: entry.id as `${string}-${number}`, phrase: entry.phrase };
  });
  if (typeof value.systemText !== "string" || typeof value.roleBoundary !== "string" ||
    typeof value.channel !== "string" || !CHANNELS.has(value.channel)) {
    refuse(caseKey, "context_scalars");
  }
  return {
    numberSources: parsedNumbers,
    complianceRules: parsedRules,
    linkWhitelist: strings(value.linkWhitelist, caseKey, "context.linkWhitelist"),
    systemText: value.systemText,
    echoExemptions: strings(value.echoExemptions, caseKey, "context.echoExemptions"),
    roleBoundary: value.roleBoundary,
    channel: value.channel as OutputCheckContext["channel"],
  };
}

function parseFile(value: unknown): { suite: SafetySuite; cases: SafetyCorpusCase[] } {
  if (!isRecord(value) || typeof value.suite !== "string" ||
    !SAFETY_SUITES.includes(value.suite as SafetySuite) || !Array.isArray(value.cases)) {
    refuse("file", "shape");
  }
  const suite = value.suite as SafetySuite;
  return {
    suite,
    cases: value.cases.map((entry, index) => {
      const fallbackKey = `${suite}:${index}`;
      if (!isRecord(entry) || typeof entry.key !== "string" || !entry.key.trim()) {
        refuse(fallbackKey, "key");
      }
      const key = entry.key;
      if (entry.kind !== "checker" && entry.kind !== "engine") refuse(key, "kind");
      if (!Array.isArray(entry.turns) || entry.turns.length === 0) refuse(key, "turns");
      const turns = entry.turns.map((turn, turnIndex) => {
        if (!isRecord(turn) || (turn.role !== "lead" && turn.role !== "agent") ||
          typeof turn.content !== "string" || !turn.content.trim()) {
          refuse(key, `turns[${turnIndex}]`);
        }
        return { role: turn.role, content: turn.content } as const;
      });
      if (!isRecord(entry.expectation) ||
        (entry.expectation.verdict !== "pass" && entry.expectation.verdict !== "block")) {
        refuse(key, "expectation");
      }
      const ids = ruleIds(entry.expectation.ruleIds, key);
      if (typeof entry.expectation.class !== "string" || !CHECK_CLASSES.has(entry.expectation.class)) {
        refuse(key, "expectation.class");
      }
      const expectation = entry.expectation.verdict === "pass"
        ? { verdict: "pass" as const, class: entry.expectation.class as OutputCheckClass, ruleIds: ids }
        : (() => {
            if (ids.length === 0) {
              refuse(key, "expectation.block");
            }
            return {
              verdict: "block" as const,
              class: entry.expectation.class as OutputCheckClass,
              ruleIds: ids,
            };
          })();
      if (entry.kind === "checker" && turns.at(-1)?.role !== "agent") {
        refuse(key, "checker_final_agent_turn");
      }
      if (entry.inboundExpectation !== undefined &&
        (typeof entry.inboundExpectation !== "string" ||
          !INBOUND_EXPECTATIONS.has(entry.inboundExpectation))) {
        refuse(key, "inboundExpectation");
      }
      if (entry.kind === "engine") {
        if (typeof entry.category !== "string" || !ENGINE_CATEGORIES.has(entry.category)) {
          refuse(key, "category");
        }
      } else if (entry.category !== undefined) {
        refuse(key, "checker_category");
      }
      if (entry.notes !== undefined &&
        (strings(entry.notes, key, "notes").some((note) => !note.trim()))) {
        refuse(key, "notes");
      }
      return {
        key,
        suite,
        kind: entry.kind,
        turns,
        expectation,
        ...(entry.inboundExpectation === undefined
          ? {}
          : { inboundExpectation: entry.inboundExpectation as Phase3InboundExpectation }),
        ...(entry.category === undefined ? {} : { category: entry.category as EngineCaseCategory }),
        ...(entry.notes === undefined ? {} : { notes: entry.notes as string[] }),
        context: context(entry.context ?? value.context, key),
      };
    }),
  };
}

export function loadSafetyCorpus(
  sources: readonly unknown[] = RAW_CORPUS,
  options: { requireAllSuites?: boolean } = {},
): LoadedSafetyCorpus {
  const files = sources.map(parseFile);
  const cases = files.flatMap((file) => file.cases);
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.key)) refuse(testCase.key, "duplicate_case_key");
    seen.add(testCase.key);
  }
  if (options.requireAllSuites !== false) {
    for (const suite of SAFETY_SUITES) {
      if (!files.some((file) => file.suite === suite)) refuse("file", `missing_suite:${suite}`);
    }
  }
  const revision = createHash("sha256")
    .update(serializeCanonicalJson(sources as unknown as CanonicalJson))
    .digest("hex");
  return { revision, cases };
}
