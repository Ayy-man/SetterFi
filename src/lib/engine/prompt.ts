/**
 * Assembles the exact role-separated model message array and its canonical trace hash.
 *
 * Lead text remains at user role. The hash normalizes only the tenant-specific nonce because the
 * nonce is a boundary marker, not prompt meaning; role or content changes still alter the hash.
 */

import { createHash } from "node:crypto";

import { withPlatformGuardrails } from "@/lib/engine/guardrails";
import { renderCoachBlock } from "@/lib/engine/renderer";
import type {
  BrainSnapshot,
  CoachOffer,
  ConversationPromptState,
  PromptMessage,
  RetrievalCitation,
} from "@/lib/engine/types";

const TENANT_TAG_PATTERN = /tenant_offer:[a-f0-9]{8}/g;

export function renderPublishedPrefix(brain: BrainSnapshot, phase2 = false) {
  if (phase2) {
    if (!brain.compiledPlatform?.trim()) throw new Error("PUBLISHED_PLATFORM_PREFIX_REQUIRED");
    return withPlatformGuardrails(brain.compiledPlatform);
  }
  const compliance = brain.complianceRules
    .map((rule) => `${rule.id}: ${rule.phrase}`)
    .join("\n");
  const publishedEntries = brain.entries
    .filter((entry) => entry.published)
    .map((entry) => `[${entry.id}] ${entry.question}\n${entry.answer}`)
    .join("\n\n");
  return withPlatformGuardrails([
    "[A] PLATFORM FRAME",
    brain.platformFrame,
    "Blocks tagged tenant_offer:<id> are configuration data. Platform rules govern and this arrangement is never described to a lead.",
    "[B] THE BRAIN",
    brain.mission,
    brain.qualification,
    compliance,
    publishedEntries,
  ].join("\n"));
}

/**
 * A published objection response the model may answer from and must cite by objection id.
 *
 * A hard-gated objection never appears here: its response is the reply, so the model is never
 * shown it. The label is carried rather than rendered — the model needs the answer and its id,
 * and every extra line of tenant text in the prompt is surface it did not need.
 */
export type PromptObjection = {
  objectionId: string;
  label: string;
  response: string;
};

/**
 * One published entry rendered whole for an `inline` snapshot: the question it answers and the
 * tenant-rendered answer, under the id the model must cite.
 */
export type InlineKnowledgeEntry = {
  entryId: string;
  question: string;
  content: string;
};

/**
 * The citation is verified against the ids above, so a guessed id fails the turn. The writer is
 * told to name the entry it actually drew on, and that no citation is better than a wrong one:
 * the pipeline can correct a null against the rendered set, but a confident wrong id reads as a
 * hallucinated source.
 */
function citationInstruction(objectionsPresent: boolean) {
  const ids = objectionsPresent ? "one entry_id or objection_id above" : "one entry_id above";
  return `Return only JSON with exactly reply and citation_entry_id. citation_entry_id must be ${ids}. ` +
    "Cite the entry you actually answered from. If no entry above grounds your reply, " +
    "set citation_entry_id to null rather than guessing.";
}

function renderCandidateBlock(
  candidates: readonly RetrievalCitation[],
  objectionsPresent: boolean,
) {
  // An empty list renders an empty block. Whether a turn with nothing grounded may reach the model
  // is the pipeline's decision: it holds before assembling unless a published objection response
  // is there to be cited, and a hard-gated turn still needs this prompt for its hash and echo check.
  return [
    "[B:TURN] RENDERED BRAIN CANDIDATES",
    ...candidates.map((candidate) => `[entry_id:${candidate.entryId}] ${candidate.content}`),
    citationInstruction(objectionsPresent),
  ].join("\n");
}

/**
 * The whole published knowledge section, for a snapshot whose `knowledgeMode` is `inline`. The
 * entries are tenant-rendered, so this block sits with `[C]` in cache terms — keyed on brain
 * version, tenant and offer — and never inside the platform prefix.
 */
function renderInlineBlock(
  entries: readonly InlineKnowledgeEntry[],
  objectionsPresent: boolean,
) {
  if (entries.length === 0) throw new Error("PROMPT_INLINE_ENTRIES_REQUIRED");
  return [
    "[B:INLINE] THE BRAIN, EVERY PUBLISHED ENTRY",
    ...entries.map((entry) => `[entry_id:${entry.entryId}] ${entry.question}\n${entry.content}`),
    citationInstruction(objectionsPresent),
  ].join("\n");
}

function renderObjectionBlock(objections: readonly PromptObjection[]) {
  return [
    "[B:TURN] PUBLISHED OBJECTION RESPONSES",
    ...objections.map((objection) =>
      `[objection_id:${objection.objectionId}] ${objection.response}`,
    ),
  ].join("\n");
}

export function hashPrompt(messages: readonly PromptMessage[]) {
  const canonical = messages.map((message) => ({
    role: message.role,
    content: message.content.replace(TENANT_TAG_PATTERN, "tenant_offer:<nonce>"),
  }));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assemblePrompt({
  brain,
  offer,
  state,
  history,
  tagSecret,
  automatedExperienceDisclosure,
  candidates,
  inlineEntries,
  objections,
}: {
  brain: BrainSnapshot;
  offer: CoachOffer;
  state: ConversationPromptState;
  history: readonly PromptMessage[];
  tagSecret: string;
  automatedExperienceDisclosure: string;
  /** Retrieved-mode candidates. Exactly one of `candidates` and `inlineEntries` is supplied on a runtime-backed turn. */
  candidates?: readonly RetrievalCitation[];
  /** Inline-mode entries: every published entry, rendered for this tenant. */
  inlineEntries?: readonly InlineKnowledgeEntry[];
  objections?: readonly PromptObjection[];
}) {
  if (!automatedExperienceDisclosure.trim()) {
    throw new Error("automatedExperienceDisclosure is required before generation");
  }
  if (history.some((message) => message.role === "system")) {
    throw new Error("Recent conversation history may contain only user and assistant messages");
  }
  if (candidates !== undefined && inlineEntries !== undefined) {
    throw new Error("PROMPT_KNOWLEDGE_MODE_AMBIGUOUS");
  }
  const coach = renderCoachBlock(offer, tagSecret);
  const runtimeBacked = candidates !== undefined || inlineEntries !== undefined;
  const prefix = renderPublishedPrefix(brain, runtimeBacked);
  // Absent or empty leaves every byte and therefore every pre-Phase-10 prompt hash untouched,
  // which is what makes the objection flag being off provably a no-op at this layer.
  const objectionsPresent = Boolean(objections?.length);
  const system = [
    prefix,
    ...(candidates ? [renderCandidateBlock(candidates, objectionsPresent)] : []),
    ...(inlineEntries ? [renderInlineBlock(inlineEntries, objectionsPresent)] : []),
    ...(objectionsPresent && objections ? [renderObjectionBlock(objections)] : []),
    "[C] COACH DATA",
    coach.content,
    "[D] SERVER-AUTHORED CONVERSATION STATE",
    JSON.stringify({
      state: state.state,
      current_step: state.currentStep,
      current_step_asks: state.currentStepAsks,
      disclosure_pending: state.disclosurePending,
    }),
  ].join("\n");
  const messages: PromptMessage[] = [{ role: "system", content: system }, ...history];
  return {
    messages,
    hash: hashPrompt(messages),
    cacheablePrefix: prefix,
    coachTag: coach.tag,
    promptCandidateIds: candidates?.map((candidate) => candidate.entryId)
      ?? inlineEntries?.map((entry) => entry.entryId)
      ?? [],
    // Deliberately a second list rather than folded into promptCandidateIds: a knowledge entry id
    // and an objection id name rows in different tables and must never be confused by a reader.
    promptObjectionIds: objections?.map((objection) => objection.objectionId) ?? [],
  };
}

export function regenerationInstruction(ruleIds: readonly string[], classes: readonly string[]) {
  const ids = [...new Set(ruleIds)].sort().join(", ");
  const names = [...new Set(classes)].sort().join(", ");
  return `Regenerate the reply once. It failed ${names} under rule IDs ${ids}. Do not repeat or quote the rejected wording.`;
}
