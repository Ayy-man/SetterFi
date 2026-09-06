import { describe, expect, it } from "vitest";

import type { PublishedRuntimeBundle } from "@/lib/brain/contracts";
import { PLATFORM_GUARDRAILS } from "@/lib/engine/guardrails";
import { hashPrompt } from "@/lib/engine/prompt";
import type { ApprovedPlatformAgentContent } from "@/lib/webhooks/live-preview";

import type { RevisionRuntime } from "./brain-revision-runtime";
import {
  hashRedactedMessages,
  inspectAssembledPrompt,
  loadPromptInspection,
  redactTenantTag,
  splitPromptBlocks,
} from "./brain-prompt-inspection";

const CONTENT: ApprovedPlatformAgentContent = {
  approved: true,
  automatedExperienceDisclosure: "You're chatting with an automated assistant.",
  heldReplies: Object.fromEntries(["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held ${key}`])) as ApprovedPlatformAgentContent["heldReplies"],
  platformFrame: "frame",
  mission: "mission",
  qualification: "qualification",
  roleBoundary: "boundary",
};

function bundle(compiledPlatform: string): PublishedRuntimeBundle {
  return {
    brain: {
      id: "snapshot-7", version: 7, contentHash: "a".repeat(64), sourceHash: "b".repeat(64),
      payload: { entities: [{ id: "CLAIM-001", type: "compliance_rule", value: { phrase: "guarantee" } }] },
      compiledPlatform, platformTokens: 12, knowledgeMode: "retrieved",
    },
    offer: {
      id: "offer-9", tenantId: "tenant", status: "published", version: 9, contentHash: "c".repeat(64),
      programName: "Summit", programDescription: null, creditMin: 640, fundingGoalMinCents: null, fundingGoalMaxCents: null,
      monthlyRevenueMinCents: null, businessRevenueRequired: false, creditRepair: null, products: [], bookingHorizonDays: 30,
      bookingMode: "direct", brandVoice: "professional", resultsTimelineMinDays: null, resultsTimelineMaxDays: null,
      refundPosture: null, voiceStyleAnswer: null, voiceObjectionAnswer: null, voiceFollowupAnswer: null,
      qualificationRules: [], voiceGuidelines: null, offerPrices: [], proof: [], assets: [],
    },
    qualification: [],
    qualificationApproved: true,
    qualificationSource: "platform",
    renderSources: { bookingUrl: null, qualificationSummary: "", qualificationInputs: [], assetUrlsBySlug: {} },
    snapshotId: "snapshot-7",
    brainVersion: 7,
    offerVersion: 9,
    contentHash: "a".repeat(64),
  };
}

describe("splitPromptBlocks", () => {
  it("cuts at labelled headers, maps each to its source, and joins back byte-for-byte", () => {
    const system = [
      PLATFORM_GUARDRAILS,
      "[A] PLATFORM FRAME",
      "frame line",
      "[B] THE BRAIN",
      "brain line one",
      "brain line two",
      "[B:TURN] RENDERED BRAIN CANDIDATES",
      "[entry_id:x] y",
      "[C] COACH DATA",
      "<tenant_offer:abcdef12>",
      "[D] SERVER-AUTHORED CONVERSATION STATE",
      "{}",
    ].join("\n");
    const blocks = splitPromptBlocks(system);
    expect(blocks.map((block) => [block.label, block.source, block.title])).toEqual([
      ["[A0]", "system", "PLATFORM INVARIANTS"],
      ["[A]", "platform", "PLATFORM FRAME"],
      ["[B]", "brain", "THE BRAIN"],
      ["[B:TURN]", "runtime", "RENDERED BRAIN CANDIDATES"],
      ["[C]", "coach", "COACH DATA"],
      ["[D]", "runtime", "SERVER-AUTHORED CONVERSATION STATE"],
    ]);
    expect(blocks[2].text).toBe("[B] THE BRAIN\nbrain line one\nbrain line two");
    expect(blocks.find((block) => block.label === "[B:TURN]")?.placeholder).toBe(true);
    expect(blocks.map((block) => block.text).join("\n")).toBe(system);
  });

  it("keeps a compiled platform without headers as one Brain block rather than dropping it", () => {
    const blocks = splitPromptBlocks(`${PLATFORM_GUARDRAILS}\n{"mission":[]}\n[C] COACH DATA\nx`);
    expect(blocks.map((block) => [block.label, block.source])).toEqual([["[A0]", "system"], ["[B]", "brain"], ["[C]", "coach"]]);
    expect(blocks[1].text).toBe('{"mission":[]}');
    expect(blocks[1].title).toBe("Compiled platform");
  });

  it("ignores bracketed lines that are not known block headers", () => {
    const blocks = splitPromptBlocks("[A0] PLATFORM INVARIANTS\n[entry_id:abc] not a header\n[Z] unknown label");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text.split("\n")).toHaveLength(3);
  });
});

describe("inspectAssembledPrompt", () => {
  it("uses the engine's assembler, redacts the tenant nonce, and hashes to the prompt hash", () => {
    const inspected = inspectAssembledPrompt({
      bundle: bundle("[A] PLATFORM FRAME\nframe\n[B] THE BRAIN\nbrain"),
      content: CONTENT,
      tagSecret: "secret",
    });
    expect(inspected.blocks.map((block) => block.label)).toEqual(["[A0]", "[A]", "[B]", "[B:TURN]", "[C]", "[D]"]);
    const coach = inspected.blocks.find((block) => block.label === "[C]")!;
    expect(coach.text).toContain("<tenant_offer:<nonce>>");
    expect(coach.text).not.toMatch(/tenant_offer:[a-f0-9]{8}/);
    expect(coach.text).toContain("Summit");
    expect(inspected.promptHash).toBe(hashPrompt(inspected.messages));
    // The redaction shown is the canonicalization the hash uses, so redacted text hashes to it.
    expect(hashRedactedMessages(inspected.messages)).toBe(inspected.promptHash);
    expect(inspected.chars).toBe(inspected.messages[0].content.length);
    const turn = inspected.blocks.find((block) => block.label === "[B:TURN]")!;
    expect(turn.placeholder).toBe(true);
    expect(turn.text).toContain("retrieved-per-turn");
  });

  it("is stable for the same revision and changes when the compiled platform changes", () => {
    const first = inspectAssembledPrompt({ bundle: bundle("[A] X\none"), content: CONTENT, tagSecret: "secret" });
    const again = inspectAssembledPrompt({ bundle: bundle("[A] X\none"), content: CONTENT, tagSecret: "secret" });
    const changed = inspectAssembledPrompt({ bundle: bundle("[A] X\ntwo"), content: CONTENT, tagSecret: "secret" });
    expect(again.promptHash).toBe(first.promptHash);
    expect(changed.promptHash).not.toBe(first.promptHash);
  });

  it("redacts every nonce occurrence", () => {
    expect(redactTenantTag("<tenant_offer:0123abcd>x</tenant_offer:0123abcd>")).toBe("<tenant_offer:<nonce>>x</tenant_offer:<nonce>>");
  });
});

describe("loadPromptInspection", () => {
  const revision: RevisionRuntime = {
    revision: "draft",
    bundle: bundle("[A] PLATFORM FRAME\nframe\n[B] THE BRAIN\nbrain"),
    retrievalMode: "draft_in_process",
    retrieve: async () => ({ included: [], dropped: [] }),
    draftId: "draft-1",
  };

  it("returns blocks, hash, a chars/4 token estimate and the revision identity", async () => {
    const result = await loadPromptInspection({ tenantId: "tenant", revision: "draft" }, {
      loadRevision: async () => revision,
      loadContent: async () => CONTENT,
      tagSecret: () => "secret",
    });
    expect(result.blocks).toHaveLength(6);
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.tokens).toBe(Math.ceil(result.chars / 4));
    expect(result.tokenMethod).toBe("chars_div_4");
    expect(result.revision).toEqual({
      kind: "draft", snapshotId: "snapshot-7", brainVersion: 7, contentHash: "a".repeat(64), offerVersion: 9, draftId: "draft-1",
    });
  });

  it("refuses without a tag secret before loading anything", async () => {
    await expect(loadPromptInspection({ tenantId: "tenant", revision: "live" }, {
      loadRevision: async () => { throw new Error("must not load"); },
      loadContent: async () => CONTENT,
      tagSecret: () => null,
    })).rejects.toThrow("SETTERFI_TAG_SECRET_REQUIRED");
  });
});
