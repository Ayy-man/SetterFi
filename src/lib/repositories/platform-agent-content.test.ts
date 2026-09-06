import { describe, expect, it, vi } from "vitest";

import {
  approvePlatformAgentContent,
  contentForApproval,
  loadPlatformAgentContentView,
  parsePlatformAgentContentDraft,
  platformAgentContentView,
  savePlatformAgentContentDraft,
  type PlatformAgentContentDependencies,
  type PlatformSettingsContentRow,
} from "./platform-agent-content";

const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held ${key}`]),
) as Record<string, string>;

const DRAFT = {
  automatedExperienceDisclosure: "You're chatting with an automated assistant.",
  platformFrame: "Frame",
  roleBoundary: "Boundary",
  heldReplies: HELD,
};

function row(overrides: Partial<PlatformSettingsContentRow> = {}): PlatformSettingsContentRow {
  return {
    agent_content: {
      automatedExperienceDisclosure: "[DRAFT] disclosure",
      platformFrame: "[DRAFT] frame",
      roleBoundary: "[DRAFT] boundary",
      mission: "[DRAFT] mission",
      qualification: "[DRAFT] qualification",
      heldReplies: Object.fromEntries(Object.keys(HELD).map((key) => [key, `[DRAFT] ${key}`])),
      controlCopy: { STOP: "SETTERFI_DEMO_PLACEHOLDER_STOP_COPY" },
    },
    approved: false,
    agent_content_draft: null,
    agent_content_draft_hash: null,
    agent_content_draft_saved_at: null,
    agent_content_draft_saved_by: null,
    agent_content_approved_at: null,
    ...overrides,
  };
}

function dependencies(state: { row: PlatformSettingsContentRow }, overrides: Partial<PlatformAgentContentDependencies> = {}): PlatformAgentContentDependencies {
  const audits = new Map<string, { id: string; action: string; targetType: string; targetId: string }>();
  return {
    loadSettings: async () => state.row,
    blockers: async (content) => Object.entries(content)
      .filter(([, value]) => typeof value === "string" && value.startsWith("[DRAFT]"))
      .map(([key]) => key),
    saveDraft: vi.fn(async ({ draft }) => {
      state.row = { ...state.row, agent_content_draft: draft, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "2026-09-06T00:00:00Z", agent_content_draft_saved_by: "owner" };
      audits.set("41", { id: "41", action: "platform_content.draft.saved", targetType: "platform_settings", targetId: "singleton" });
      return { draftHash: "1".repeat(64), auditId: "41" };
    }),
    approve: vi.fn(async () => {
      state.row = {
        ...state.row,
        agent_content: { ...(state.row.agent_content as Record<string, unknown>), ...(state.row.agent_content_draft as Record<string, unknown>) },
        approved: true, agent_content_draft: null, agent_content_draft_hash: null, agent_content_draft_saved_at: null,
        agent_content_draft_saved_by: null, agent_content_approved_at: "2026-09-06T01:00:00Z",
      };
      audits.set("42", { id: "42", action: "platform_content.approved", targetType: "platform_settings", targetId: "singleton" });
      return { auditId: "42", contentHash: "2".repeat(64) };
    }),
    loadAudit: async (id) => audits.get(id) ?? null,
    loadActionWords: async (key) => key === "platform_content.approved"
      ? { microcopy: "Platform content approval logged", ariaLabel: "Platform agent content approval recorded in the audit log" }
      : { microcopy: "Platform content draft logged", ariaLabel: "Platform agent content draft recorded in the audit log" },
    ...overrides,
  };
}

describe("parsePlatformAgentContentDraft", () => {
  it("accepts exactly the editable keys with every held class present and trims them", () => {
    expect(parsePlatformAgentContentDraft({ ...DRAFT, platformFrame: "  Frame  " })).toEqual(DRAFT);
  });

  it("refuses extra keys, missing classes, blanks and oversized text", () => {
    expect(parsePlatformAgentContentDraft({ ...DRAFT, mission: "m" })).toBeNull();
    expect(parsePlatformAgentContentDraft({ ...DRAFT, heldReplies: { ...HELD, EXTRA: "x" } })).toBeNull();
    const { NUM: _num, ...missing } = HELD;
    void _num;
    expect(parsePlatformAgentContentDraft({ ...DRAFT, heldReplies: missing })).toBeNull();
    expect(parsePlatformAgentContentDraft({ ...DRAFT, roleBoundary: "   " })).toBeNull();
    expect(parsePlatformAgentContentDraft({ ...DRAFT, platformFrame: "x".repeat(2_001) })).toBeNull();
    expect(parsePlatformAgentContentDraft({ ...DRAFT, heldReplies: { ...HELD, LEN: "x".repeat(601) } })).toBeNull();
    expect(parsePlatformAgentContentDraft(null)).toBeNull();
    expect(parsePlatformAgentContentDraft([DRAFT])).toBeNull();
  });
});

describe("platformAgentContentView", () => {
  it("projects the live row, marks mission and qualification as Brain-owned, and reports no draft", () => {
    const view = platformAgentContentView(row(), ["platformFrame"]);
    expect(view.approved).toBe(false);
    expect(view.live.platformFrame).toBe("[DRAFT] frame");
    expect(view.live.heldReplies.NUM).toBe("[DRAFT] NUM");
    expect(view.brainOwned).toEqual({ mission: "[DRAFT] mission", qualification: "[DRAFT] qualification", source: "brain" });
    expect(view.draft).toBeNull();
    expect(view.approval).toEqual({ blockers: ["platformFrame"], canApprove: false });
  });

  it("returns the saved draft and lets approval proceed only when nothing blocks it", () => {
    const saved = row({ agent_content_draft: DRAFT, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "t", agent_content_draft_saved_by: "owner" });
    expect(platformAgentContentView(saved, []).draft).toEqual({ values: DRAFT, hash: "1".repeat(64), savedAt: "t", savedBy: "owner" });
    expect(platformAgentContentView(saved, []).approval.canApprove).toBe(true);
    expect(platformAgentContentView(saved, ["controlCopy.STOP"]).approval.canApprove).toBe(false);
  });

  it("evaluates approval over the draft laid on the approved row", () => {
    const saved = row({ agent_content_draft: DRAFT, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "t" });
    const merged = contentForApproval(saved);
    expect(merged.platformFrame).toBe("Frame");
    expect(merged.mission).toBe("[DRAFT] mission");
    expect(merged.controlCopy).toEqual({ STOP: "SETTERFI_DEMO_PLACEHOLDER_STOP_COPY" });
    expect(contentForApproval(row())).toEqual(row().agent_content);
  });

  it("ignores a draft column the parser does not recognise rather than serving it", () => {
    const view = platformAgentContentView(row({ agent_content_draft: { platformFrame: "x" }, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "t" }), []);
    expect(view.draft).toBeNull();
  });
});

describe("save and approve", () => {
  it("saves a draft, reads it back, and returns the registered audit words", async () => {
    const state = { row: row() };
    const deps = dependencies(state);
    const result = await savePlatformAgentContentDraft({ actorId: "owner", draft: DRAFT }, deps);
    expect(deps.saveDraft).toHaveBeenCalledWith({ actorId: "owner", draft: DRAFT });
    expect(result.view.draft?.hash).toBe("1".repeat(64));
    expect(result.view.approved).toBe(false);
    expect(result.audit).toEqual({
      auditId: "41", actionKey: "platform_content.draft.saved",
      label: "Platform content draft logged", ariaLabel: "Platform agent content draft recorded in the audit log",
    });
    // Mission and qualification stayed as they were; the draft could not have carried them.
    expect(result.view.brainOwned.mission).toBe("[DRAFT] mission");
  });

  it("refuses a save whose read-back does not carry the hash the RPC returned", async () => {
    const state = { row: row() };
    const deps = dependencies(state, { saveDraft: async () => ({ draftHash: "9".repeat(64), auditId: "41" }) });
    await expect(savePlatformAgentContentDraft({ actorId: "owner", draft: DRAFT }, deps))
      .rejects.toThrow("PLATFORM_CONTENT_AUDIT_READBACK_FAILED");
  });

  it("approves against the saved hash, reads back the flipped row and the audit row", async () => {
    const state = { row: row() };
    const deps = dependencies(state);
    await savePlatformAgentContentDraft({ actorId: "owner", draft: DRAFT }, deps);
    const result = await approvePlatformAgentContent({ actorId: "owner", expectedDraftHash: "1".repeat(64), reason: " Reviewed " }, deps);
    expect(deps.approve).toHaveBeenCalledWith({ actorId: "owner", expectedDraftHash: "1".repeat(64), reason: "Reviewed" });
    expect(result.view.approved).toBe(true);
    expect(result.view.draft).toBeNull();
    expect(result.view.live.platformFrame).toBe("Frame");
    expect(result.contentHash).toBe("2".repeat(64));
    expect(result.audit.actionKey).toBe("platform_content.approved");
    expect(result.audit.label).toBe("Platform content approval logged");
  });

  it("refuses approval input before the RPC: blank reason, malformed hash, blank actor", async () => {
    const state = { row: row() };
    const deps = dependencies(state);
    await expect(approvePlatformAgentContent({ actorId: "owner", expectedDraftHash: "1".repeat(64), reason: "  " }, deps))
      .rejects.toThrow("PLATFORM_CONTENT_REASON_REQUIRED");
    await expect(approvePlatformAgentContent({ actorId: "owner", expectedDraftHash: "nope", reason: "r" }, deps))
      .rejects.toThrow("PLATFORM_CONTENT_DRAFT_STALE");
    await expect(approvePlatformAgentContent({ actorId: " ", expectedDraftHash: "1".repeat(64), reason: "r" }, deps))
      .rejects.toThrow("PLATFORM_CONTENT_ACTOR_REQUIRED");
    expect(deps.approve).not.toHaveBeenCalled();
  });

  it("refuses an approval whose read-back still shows a draft or an unapproved row", async () => {
    const state = { row: row({ agent_content_draft: DRAFT, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "t" }) };
    const deps = dependencies(state, {
      approve: async () => ({ auditId: "42", contentHash: "2".repeat(64) }),
      loadAudit: async () => ({ id: "42", action: "platform_content.approved", targetType: "platform_settings", targetId: "singleton" }),
    });
    await expect(approvePlatformAgentContent({ actorId: "owner", expectedDraftHash: "1".repeat(64), reason: "r" }, deps))
      .rejects.toThrow("PLATFORM_CONTENT_APPROVE_READBACK_MISMATCH");
  });

  it("loads the view with blockers computed from the same content approval would arm", async () => {
    const state = { row: row({ agent_content_draft: DRAFT, agent_content_draft_hash: "1".repeat(64), agent_content_draft_saved_at: "t" }) };
    const blockers = vi.fn(async () => ["controlCopy.STOP"]);
    const view = await loadPlatformAgentContentView(dependencies(state, { blockers }));
    expect(blockers).toHaveBeenCalledWith(contentForApproval(state.row));
    expect(view.approval).toEqual({ blockers: ["controlCopy.STOP"], canApprove: false });
  });
});
