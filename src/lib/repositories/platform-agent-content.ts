/**
 * Owner editing of the platform agent content the reply pipeline sends verbatim.
 *
 * The pipeline reads `platform_settings.agent_content` plus `approved` (see
 * `@/lib/webhooks/live-preview`). Edits made here land in `agent_content_draft`, a column nothing
 * in the pipeline reads, and only `approve_platform_agent_content` copies a draft over the approved
 * row. Mission and qualification are compiled into the Brain snapshot and edited there; this module
 * returns them read-only so the editor can show what the legacy prompt path would use.
 */

import { MODERATOR_CLASSES, type ModeratorClass } from "@/lib/engine/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export const PLATFORM_CONTENT_EDITABLE_TEXT_FIELDS = [
  "automatedExperienceDisclosure",
  "platformFrame",
  "roleBoundary",
] as const;

export const PLATFORM_CONTENT_LIMITS = { text: 2_000, heldReply: 600, reason: 500 } as const;

export const PLATFORM_CONTENT_DRAFT_SAVED_ACTION = "platform_content.draft.saved" as const;
export const PLATFORM_CONTENT_APPROVED_ACTION = "platform_content.approved" as const;

export type PlatformAgentContentDraftInput = {
  automatedExperienceDisclosure: string;
  platformFrame: string;
  roleBoundary: string;
  heldReplies: Record<ModeratorClass, string>;
};

export type PlatformAgentContentAudit = {
  auditId: string;
  actionKey: typeof PLATFORM_CONTENT_DRAFT_SAVED_ACTION | typeof PLATFORM_CONTENT_APPROVED_ACTION;
  label: string;
  ariaLabel: string;
};

export type PlatformAgentContentView = {
  /** Whether the approved row is armed for non-demo tenants today. */
  approved: boolean;
  approvedAt: string | null;
  /** What the pipeline reads right now. Blank strings mean the slot has never been written. */
  live: PlatformAgentContentDraftInput;
  /** Read-only here; edited through the Brain draft and compiled into the snapshot. */
  brainOwned: { mission: string; qualification: string; source: "brain" };
  draft: {
    values: PlatformAgentContentDraftInput;
    hash: string;
    savedAt: string;
    savedBy: string | null;
  } | null;
  approval: {
    /** Slots that would make `approve` refuse, evaluated over the draft laid on the approved row. */
    blockers: readonly string[];
    canApprove: boolean;
  };
};

export type PlatformSettingsContentRow = {
  agent_content: unknown;
  approved: boolean;
  agent_content_draft: unknown;
  agent_content_draft_hash: string | null;
  agent_content_draft_saved_at: string | null;
  agent_content_draft_saved_by: string | null;
  agent_content_approved_at: string | null;
};

export type PlatformAgentContentDependencies = {
  loadSettings(): Promise<PlatformSettingsContentRow | null>;
  blockers(content: Record<string, unknown>): Promise<readonly string[]>;
  saveDraft(input: { actorId: string; draft: PlatformAgentContentDraftInput }): Promise<{ draftHash: string; auditId: string }>;
  approve(input: { actorId: string; expectedDraftHash: string; reason: string }): Promise<{ auditId: string; contentHash: string }>;
  loadAudit(auditId: string): Promise<{ id: string; action: string; targetType: string; targetId: string } | null>;
  /**
   * The registered words for an action, from `audit_actions`. These two keys are seeded by
   * `20261013000015_platform_content_drafts.sql` and are not mirrored in the TypeScript registry,
   * so the table is the only source a "Logged" pill may quote.
   */
  loadActionWords(actionKey: string): Promise<{ microcopy: string; ariaLabel: string } | null>;
};

export class PlatformAgentContentError extends Error {
  constructor(readonly code: string, readonly detail: string | null = null) {
    super(detail ? `${code}:${detail}` : code);
    this.name = "PlatformAgentContentError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value: unknown, max: number) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text && text.length <= max ? text : null;
}

/** Narrows a request body to the exact editable shape; anything extra or blank is refused. */
export function parsePlatformAgentContentDraft(value: unknown): PlatformAgentContentDraftInput | null {
  if (!isRecord(value)) return null;
  const expected = [...PLATFORM_CONTENT_EDITABLE_TEXT_FIELDS, "heldReplies"].sort().join(",");
  if (Object.keys(value).sort().join(",") !== expected) return null;
  const texts: Partial<Record<(typeof PLATFORM_CONTENT_EDITABLE_TEXT_FIELDS)[number], string>> = {};
  for (const field of PLATFORM_CONTENT_EDITABLE_TEXT_FIELDS) {
    const text = boundedText(value[field], PLATFORM_CONTENT_LIMITS.text);
    if (!text) return null;
    texts[field] = text;
  }
  const held = value.heldReplies;
  if (!isRecord(held) || Object.keys(held).sort().join(",") !== [...MODERATOR_CLASSES].sort().join(",")) {
    return null;
  }
  const heldReplies = {} as Record<ModeratorClass, string>;
  for (const checkClass of MODERATOR_CLASSES) {
    const text = boundedText(held[checkClass], PLATFORM_CONTENT_LIMITS.heldReply);
    if (!text) return null;
    heldReplies[checkClass] = text;
  }
  return {
    automatedExperienceDisclosure: texts.automatedExperienceDisclosure!,
    platformFrame: texts.platformFrame!,
    roleBoundary: texts.roleBoundary!,
    heldReplies,
  };
}

function stringOrBlank(value: unknown) {
  return typeof value === "string" ? value : "";
}

/** Lenient projection for the editor: a missing slot renders blank rather than refusing the page. */
function editableValues(content: unknown): PlatformAgentContentDraftInput {
  const row = isRecord(content) ? content : {};
  const held = isRecord(row.heldReplies) ? row.heldReplies : {};
  return {
    automatedExperienceDisclosure: stringOrBlank(row.automatedExperienceDisclosure),
    platformFrame: stringOrBlank(row.platformFrame),
    roleBoundary: stringOrBlank(row.roleBoundary),
    heldReplies: Object.fromEntries(
      MODERATOR_CLASSES.map((checkClass) => [checkClass, stringOrBlank(held[checkClass])]),
    ) as Record<ModeratorClass, string>,
  };
}

export function platformAgentContentView(
  row: PlatformSettingsContentRow,
  blockers: readonly string[],
): PlatformAgentContentView {
  const content = isRecord(row.agent_content) ? row.agent_content : {};
  const draftValues = parsePlatformAgentContentDraft(row.agent_content_draft);
  const draft = draftValues && row.agent_content_draft_hash && row.agent_content_draft_saved_at
    ? {
        values: draftValues,
        hash: row.agent_content_draft_hash,
        savedAt: row.agent_content_draft_saved_at,
        savedBy: row.agent_content_draft_saved_by,
      }
    : null;
  return {
    approved: row.approved === true,
    approvedAt: row.agent_content_approved_at,
    live: editableValues(content),
    brainOwned: {
      mission: stringOrBlank(content.mission),
      qualification: stringOrBlank(content.qualification),
      source: "brain",
    },
    draft,
    approval: { blockers, canApprove: draft !== null && blockers.length === 0 },
  };
}

/** The content approval would arm: the saved draft laid over the approved row, or the row alone. */
export function contentForApproval(row: PlatformSettingsContentRow): Record<string, unknown> {
  const content = isRecord(row.agent_content) ? row.agent_content : {};
  return isRecord(row.agent_content_draft) ? { ...content, ...row.agent_content_draft } : content;
}

async function requireSettings(dependencies: PlatformAgentContentDependencies) {
  const row = await dependencies.loadSettings();
  if (!row) throw new PlatformAgentContentError("PLATFORM_SETTINGS_ROW_REQUIRED");
  return row;
}

async function buildView(dependencies: PlatformAgentContentDependencies) {
  const row = await requireSettings(dependencies);
  const blockers = await dependencies.blockers(contentForApproval(row));
  return platformAgentContentView(row, blockers);
}

/** Registry-backed read-back: the receipt is the persisted row and its registered words. */
async function auditReceipt(
  dependencies: PlatformAgentContentDependencies,
  auditId: string,
  actionKey: PlatformAgentContentAudit["actionKey"],
): Promise<PlatformAgentContentAudit> {
  const [row, words] = await Promise.all([
    dependencies.loadAudit(auditId),
    dependencies.loadActionWords(actionKey),
  ]);
  if (!row || row.id !== auditId || row.action !== actionKey || row.targetType !== "platform_settings" ||
    row.targetId !== "singleton") {
    throw new PlatformAgentContentError("PLATFORM_CONTENT_AUDIT_READBACK_FAILED");
  }
  if (!words) throw new PlatformAgentContentError("PLATFORM_CONTENT_AUDIT_ACTION_UNREGISTERED");
  return { auditId, actionKey, label: words.microcopy, ariaLabel: words.ariaLabel };
}

export async function loadPlatformAgentContentView(
  dependencies: PlatformAgentContentDependencies = livePlatformAgentContentDependencies(),
) {
  return buildView(dependencies);
}

export async function savePlatformAgentContentDraft(
  input: { actorId: string; draft: PlatformAgentContentDraftInput },
  dependencies: PlatformAgentContentDependencies = livePlatformAgentContentDependencies(),
): Promise<{ view: PlatformAgentContentView; audit: PlatformAgentContentAudit }> {
  if (!input.actorId.trim()) throw new PlatformAgentContentError("PLATFORM_CONTENT_ACTOR_REQUIRED");
  const saved = await dependencies.saveDraft(input);
  const [view, audit] = await Promise.all([
    buildView(dependencies),
    auditReceipt(dependencies, saved.auditId, PLATFORM_CONTENT_DRAFT_SAVED_ACTION),
  ]);
  if (view.draft?.hash !== saved.draftHash) {
    throw new PlatformAgentContentError("PLATFORM_CONTENT_DRAFT_READBACK_MISMATCH");
  }
  return { view, audit };
}

export async function approvePlatformAgentContent(
  input: { actorId: string; expectedDraftHash: string; reason: string },
  dependencies: PlatformAgentContentDependencies = livePlatformAgentContentDependencies(),
): Promise<{ view: PlatformAgentContentView; audit: PlatformAgentContentAudit; contentHash: string }> {
  if (!input.actorId.trim()) throw new PlatformAgentContentError("PLATFORM_CONTENT_ACTOR_REQUIRED");
  const reason = boundedText(input.reason, PLATFORM_CONTENT_LIMITS.reason);
  if (!reason) throw new PlatformAgentContentError("PLATFORM_CONTENT_REASON_REQUIRED");
  if (!/^[0-9a-f]{64}$/.test(input.expectedDraftHash)) {
    throw new PlatformAgentContentError("PLATFORM_CONTENT_DRAFT_STALE");
  }
  const approved = await dependencies.approve({ ...input, reason });
  const [view, audit] = await Promise.all([
    buildView(dependencies),
    auditReceipt(dependencies, approved.auditId, PLATFORM_CONTENT_APPROVED_ACTION),
  ]);
  if (!view.approved || view.draft !== null) {
    throw new PlatformAgentContentError("PLATFORM_CONTENT_APPROVE_READBACK_MISMATCH");
  }
  return { view, audit, contentHash: approved.contentHash };
}

function rpcError(error: { message: string }): never {
  // Postgres raises the code as the message; NOT_APPROVABLE carries the blocking slots after it.
  const [code, ...rest] = error.message.split(":");
  const known = /^PLATFORM_(?:CONTENT|SETTINGS)_[A-Z_]+$/.test(code);
  throw new PlatformAgentContentError(
    known ? code : "PLATFORM_CONTENT_WRITE_FAILED",
    known && rest.length ? rest.join(":") : null,
  );
}

function singleRow(data: unknown) {
  const row = Array.isArray(data) ? data[0] : data;
  return isRecord(row) ? row : null;
}

export function livePlatformAgentContentDependencies(): PlatformAgentContentDependencies {
  const client = createSupabaseServiceClient();
  return {
    loadSettings: async () => {
      const { data, error } = await client.from("platform_settings")
        .select("agent_content,approved,agent_content_draft,agent_content_draft_hash,agent_content_draft_saved_at,agent_content_draft_saved_by,agent_content_approved_at")
        .eq("singleton", true)
        .maybeSingle();
      if (error) throw new PlatformAgentContentError("PLATFORM_CONTENT_READ_FAILED");
      return data ? (data as PlatformSettingsContentRow) : null;
    },
    blockers: async (content) => {
      const { data, error } = await client.rpc("platform_agent_content_blockers", { p_content: content });
      if (error || !Array.isArray(data)) throw new PlatformAgentContentError("PLATFORM_CONTENT_BLOCKERS_READ_FAILED");
      return data.filter((slot): slot is string => typeof slot === "string");
    },
    saveDraft: async ({ actorId, draft }) => {
      const { data, error } = await client.rpc("save_platform_agent_content_draft", {
        p_actor_id: actorId,
        p_draft: draft,
      });
      if (error) rpcError(error);
      const row = singleRow(data);
      if (!row || typeof row.draft_hash !== "string" || (typeof row.audit_id !== "number" && typeof row.audit_id !== "string")) {
        throw new PlatformAgentContentError("PLATFORM_CONTENT_DRAFT_RECEIPT_INVALID");
      }
      return { draftHash: row.draft_hash, auditId: String(row.audit_id) };
    },
    approve: async ({ actorId, expectedDraftHash, reason }) => {
      const { data, error } = await client.rpc("approve_platform_agent_content", {
        p_actor_id: actorId,
        p_expected_draft_hash: expectedDraftHash,
        p_reason: reason,
      });
      if (error) rpcError(error);
      const row = singleRow(data);
      if (!row || typeof row.content_hash !== "string" || (typeof row.audit_id !== "number" && typeof row.audit_id !== "string")) {
        throw new PlatformAgentContentError("PLATFORM_CONTENT_APPROVE_RECEIPT_INVALID");
      }
      return { auditId: String(row.audit_id), contentHash: row.content_hash };
    },
    loadAudit: async (auditId) => {
      const { data, error } = await client.from("audit_log")
        .select("id,action,target_type,target_id")
        .eq("id", auditId)
        .maybeSingle();
      if (error || !data) return null;
      return {
        id: String(data.id),
        action: String(data.action),
        targetType: String(data.target_type),
        targetId: String(data.target_id),
      };
    },
    loadActionWords: async (actionKey) => {
      const { data, error } = await client.from("audit_actions")
        .select("key,microcopy,aria_label")
        .eq("key", actionKey)
        .maybeSingle();
      if (error || !data || data.key !== actionKey) return null;
      return { microcopy: String(data.microcopy), ariaLabel: String(data.aria_label) };
    },
  };
}
