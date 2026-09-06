/**
 * The assembled system prompt for a coach and Brain revision, split into its labelled blocks.
 *
 * The text comes from `assemblePrompt`, the same function the engine calls on every turn, and the
 * blocks are cut out of its output rather than rebuilt from parts: the module refuses to answer if
 * the blocks do not join back into the exact system message. The tenant tag nonce is redacted the
 * same way `hashPrompt` canonicalizes it, so the text shown hashes to the hash shown.
 */

import { createHash } from "node:crypto";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { engineBrainFromRuntimeBundle, engineOfferFromRuntimeBundle } from "@/lib/engine/pipeline";
import { assemblePrompt, hashPrompt } from "@/lib/engine/prompt";
import type { ConversationPromptState, PromptMessage } from "@/lib/engine/types";
import { environmentValue } from "@/lib/env-contract";
import {
  loadApprovedPlatformAgentContent,
  type ApprovedPlatformAgentContent,
} from "@/lib/webhooks/live-preview";

import { loadRevisionRuntime, type BrainRevision, type RevisionRuntime } from "./brain-revision-runtime";

export type PromptBlockSource = "system" | "platform" | "brain" | "coach" | "runtime";

export type PromptBlock = {
  label: string;
  title: string;
  source: PromptBlockSource;
  text: string;
  /** True for the per-turn retrieval block, whose content exists only once a lead message does. */
  placeholder?: true;
};

export type PromptInspection = {
  blocks: readonly PromptBlock[];
  promptHash: string;
  /** Characters divided by four, the same estimate the Brain uses for `platformTokens`. */
  tokens: number;
  tokenMethod: "chars_div_4";
  chars: number;
  revision: {
    kind: BrainRevision;
    snapshotId: string;
    brainVersion: number;
    contentHash: string;
    offerVersion: number;
    draftId: string | null;
  };
};

const TENANT_TAG_PATTERN = /tenant_offer:[a-f0-9]{8}/g;
const BLOCK_HEADER = /^\[([A-Z0-9:]+)\] (.*)$/;

/** Stands in for the candidates retrieval renders per turn; `renderCandidateBlock` refuses none. */
export const RETRIEVAL_PLACEHOLDER_CANDIDATE = {
  entryId: "retrieved-per-turn",
  content: "Up to five Brain entries retrieved for the lead's message are rendered here on every turn.",
  similarity: 0,
  categoryBoost: 0 as const,
  score: 0,
  categoryAgreement: false,
};

const SOURCE_BY_LABEL: Record<string, PromptBlockSource> = {
  A0: "system",
  A: "platform",
  B: "brain",
  "B:TURN": "runtime",
  C: "coach",
  D: "runtime",
};

export function redactTenantTag(text: string) {
  return text.replace(TENANT_TAG_PATTERN, "tenant_offer:<nonce>");
}

/**
 * Cuts the system message at every `[LABEL] TITLE` header line. Text before the first header, or a
 * compiled platform with no headers of its own, becomes one Brain block rather than being dropped.
 */
export function splitPromptBlocks(system: string): PromptBlock[] {
  const blocks: PromptBlock[] = [];
  let current: PromptBlock | null = null;
  for (const line of system.split("\n")) {
    const header = line.match(BLOCK_HEADER);
    if (header && SOURCE_BY_LABEL[header[1]]) {
      if (current) blocks.push(current);
      current = {
        label: `[${header[1]}]`,
        title: header[2].trim(),
        source: SOURCE_BY_LABEL[header[1]],
        text: line,
        ...(header[1] === "B:TURN" ? { placeholder: true as const } : {}),
      };
      continue;
    }
    if (!current) {
      current = { label: "[B]", title: "Compiled platform", source: "brain", text: line };
      continue;
    }
    current.text = `${current.text}\n${line}`;
  }
  if (current) blocks.push(current);
  if (blocks.map((block) => block.text).join("\n") !== system) throw new Error("PROMPT_BLOCKS_DRIFT");
  return blocks;
}

export function inspectAssembledPrompt(input: {
  bundle: PublishedRuntimeBundle;
  content: ApprovedPlatformAgentContent;
  tagSecret: string;
  state?: ConversationPromptState;
}) {
  const prompt = assemblePrompt({
    brain: engineBrainFromRuntimeBundle(input.bundle),
    offer: engineOfferFromRuntimeBundle(input.bundle),
    state: input.state ?? { state: "agent", currentStep: null, currentStepAsks: 0, disclosurePending: false },
    history: [],
    tagSecret: input.tagSecret,
    automatedExperienceDisclosure: input.content.automatedExperienceDisclosure,
    candidates: [RETRIEVAL_PLACEHOLDER_CANDIDATE],
  });
  const system = prompt.messages[0].content;
  const blocks = splitPromptBlocks(system).map((block) => ({ ...block, text: redactTenantTag(block.text) }));
  return { blocks, promptHash: prompt.hash, chars: system.length, messages: prompt.messages };
}

/** The hash `hashPrompt` produces for messages whose nonce is already redacted; pins the redaction. */
export function hashRedactedMessages(messages: readonly PromptMessage[]) {
  return createHash("sha256")
    .update(JSON.stringify(messages.map((message) => ({ role: message.role, content: redactTenantTag(message.content) }))))
    .digest("hex");
}

export type PromptInspectionDependencies = {
  loadRevision(input: { tenantId: string; revision: BrainRevision }): Promise<RevisionRuntime>;
  loadContent(tenantId: string): Promise<ApprovedPlatformAgentContent>;
  tagSecret(): string | null;
};

export async function loadPromptInspection(
  input: { tenantId: string; revision: BrainRevision },
  dependencies: PromptInspectionDependencies = livePromptInspectionDependencies(),
): Promise<PromptInspection> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("PROMPT_TENANT_REQUIRED");
  const tagSecret = dependencies.tagSecret();
  if (!tagSecret) throw new Error("SETTERFI_TAG_SECRET_REQUIRED");
  const [revision, content] = await Promise.all([
    dependencies.loadRevision({ tenantId, revision: input.revision }),
    dependencies.loadContent(tenantId),
  ]);
  const inspected = inspectAssembledPrompt({ bundle: revision.bundle, content, tagSecret });
  if (hashPrompt(inspected.messages) !== inspected.promptHash) throw new Error("PROMPT_HASH_DRIFT");
  return {
    blocks: inspected.blocks,
    promptHash: inspected.promptHash,
    tokens: Math.ceil(inspected.chars / 4),
    tokenMethod: "chars_div_4",
    chars: inspected.chars,
    revision: {
      kind: revision.revision,
      snapshotId: revision.bundle.snapshotId,
      brainVersion: revision.bundle.brainVersion,
      contentHash: revision.bundle.contentHash,
      offerVersion: revision.bundle.offerVersion,
      draftId: revision.draftId,
    },
  };
}

export function livePromptInspectionDependencies(): PromptInspectionDependencies {
  return {
    loadRevision: (input) => loadRevisionRuntime(input),
    loadContent: loadApprovedPlatformAgentContent,
    tagSecret: () => environmentValue("SETTERFI_TAG_SECRET") ?? null,
  };
}
