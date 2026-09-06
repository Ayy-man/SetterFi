// Inline knowledge mode at the prompt layer. The retrieved path's bytes are pinned by
// prompt.test.ts; this file covers the inline block and the one relaxation of the candidate block.
import { describe, expect, it } from "vitest";

import { PLATFORM_GUARDRAILS } from "@/lib/engine/guardrails";
import { assemblePrompt } from "@/lib/engine/prompt";
import type { BrainSnapshot, CoachOffer, RetrievalCitation } from "@/lib/engine/types";

const OFFER: CoachOffer = {
  tenantId: "tenant-a",
  version: 4,
  programName: "Summit",
  products: [],
  brandVoice: "direct",
  voiceAnswers: [],
  qualificationRules: [],
  voiceGuidelines: null,
  proof: [],
  assets: [],
  offerPrices: [],
  creditMin: 640,
  fundingGoalMinCents: null,
  bookingHorizonDays: 30,
};

const BRAIN: BrainSnapshot = {
  version: 7,
  platformFrame: "",
  mission: "",
  qualification: "",
  complianceRules: [],
  entries: [],
  knowledgeMode: "inline",
  compiledPlatform: "[A] IMMUTABLE PLATFORM\n[B] IMMUTABLE BRAIN",
};

const STATE = { state: "agent" as const, currentStep: null, currentStepAsks: 0, disclosurePending: false };
const HISTORY = [{ role: "user" as const, content: "How long does funding take?" }];
const CANDIDATE: RetrievalCitation = {
  entryId: "ranked-1",
  content: "Ranked answer.",
  similarity: 0.8,
  categoryBoost: 0,
  score: 0.8,
  categoryAgreement: false,
};
const INLINE = [
  { entryId: "entry-a", question: "How long does funding take?", content: "Usually a few weeks." },
  { entryId: "entry-b", question: "What does it cost?", content: "The review fee is published on the call." },
];

function assemble(input: Partial<Parameters<typeof assemblePrompt>[0]>) {
  return assemblePrompt({
    brain: BRAIN,
    offer: OFFER,
    state: STATE,
    history: HISTORY,
    tagSecret: "test-secret",
    automatedExperienceDisclosure: "You're chatting with an automated assistant.",
    ...input,
  });
}

describe("assemblePrompt inline knowledge", () => {
  it("renders every published entry under its citable id, outside the platform prefix", () => {
    const result = assemble({ inlineEntries: INLINE });
    const system = result.messages[0].content;
    expect(result.cacheablePrefix).toBe(`${PLATFORM_GUARDRAILS}\n[A] IMMUTABLE PLATFORM\n[B] IMMUTABLE BRAIN`);
    expect(system).toContain("[B:INLINE] THE BRAIN, EVERY PUBLISHED ENTRY");
    expect(system).toContain("[entry_id:entry-a] How long does funding take?\nUsually a few weeks.");
    expect(system).toContain("[entry_id:entry-b] What does it cost?\nThe review fee is published on the call.");
    expect(system).not.toContain("[B:TURN] RENDERED BRAIN CANDIDATES");
    expect(system).toContain("citation_entry_id must be one entry_id above.");
    expect(system.indexOf("[B:INLINE]")).toBeLessThan(system.indexOf("[C] COACH DATA"));
    expect(result.promptCandidateIds).toEqual(["entry-a", "entry-b"]);
  });

  it("refuses an empty inline section and refuses both knowledge shapes at once", () => {
    expect(() => assemble({ inlineEntries: [] })).toThrow("PROMPT_INLINE_ENTRIES_REQUIRED");
    expect(() => assemble({ inlineEntries: INLINE, candidates: [CANDIDATE] }))
      .toThrow("PROMPT_KNOWLEDGE_MODE_AMBIGUOUS");
  });

  it("names objection ids in the inline citation instruction when objections are supplied", () => {
    const result = assemble({
      inlineEntries: INLINE,
      objections: [{ objectionId: "objection-1", label: "Too slow", response: "Published objection answer." }],
    });
    expect(result.messages[0].content)
      .toContain("citation_entry_id must be one entry_id or objection_id above.");
    expect(result.promptObjectionIds).toEqual(["objection-1"]);
  });
});

describe("assemblePrompt retrieved knowledge with no grounded candidate", () => {
  it("renders an empty candidate block and leaves the hold decision to the pipeline", () => {
    const result = assemble({ candidates: [] });
    expect(result.promptCandidateIds).toEqual([]);
    expect(result.messages[0].content).toContain(
      "[B:TURN] RENDERED BRAIN CANDIDATES\nReturn only JSON with exactly reply and citation_entry_id.",
    );
  });

  it("accepts an empty candidate list when a published objection response can be cited", () => {
    const result = assemble({
      candidates: [],
      objections: [{ objectionId: "objection-1", label: "Too slow", response: "Published objection answer." }],
    });
    expect(result.promptCandidateIds).toEqual([]);
    expect(result.promptObjectionIds).toEqual(["objection-1"]);
    expect(result.messages[0].content).toContain("[objection_id:objection-1] Published objection answer.");
  });

  it("leaves the retrieved prompt bytes untouched when no inline entries are passed", () => {
    const before = assemble({ candidates: [CANDIDATE] });
    const after = assemble({ candidates: [CANDIDATE], inlineEntries: undefined });
    expect(after.messages).toEqual(before.messages);
    expect(after.hash).toBe(before.hash);
  });
});
