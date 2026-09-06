import { MODERATOR_CLASSES, type ModeratorClass } from "@/lib/engine/types";

/**
 * The redesigned Brain's calls to the admin Brain routes that arrived with it.
 *
 * `brain-api-client.ts` carries the routes the previous Brain used (import, accept, draft, evals,
 * publish, rollback) and stays as it is. The three views this file serves did not exist before:
 * the test conversation (`/test-turn`), the platform content the engine reads outside the Brain
 * draft (`/platform-content`), the assembled prompt (`/prompt`), and the reject arm of import
 * review. Every response is narrowed from `unknown` here so the screen never trusts a payload
 * shape it did not check, and a route that is not deployed yet answers as a typed failure the
 * screen can print rather than a thrown string.
 */

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OwnerBrainApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function request(fetcher: FetchLike, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetcher(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const value = record(payload);
    throw new OwnerBrainApiError(
      response.status,
      typeof value.code === "string" ? value.code : response.status === 404 ? "ROUTE_NOT_DEPLOYED" : `HTTP_${response.status}`,
    );
  }
  return payload;
}

/* --------------------------------------------------------------------------------------------
 * Test conversation
 * ------------------------------------------------------------------------------------------ */

export const TEST_CHANNELS = ["sms", "instagram", "messenger", "whatsapp", "webchat"] as const;
export type TestChannel = (typeof TEST_CHANNELS)[number];
export type TestRevision = "draft" | "live";

export type TestTurnInput = {
  coachTenantId: string;
  revision: TestRevision;
  channel: TestChannel;
  message: string;
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
};

export type TestTurnEvidence = {
  citations: Array<{ entryId: string; question: string }>;
  qualification: { ruleId: string | null; outcome: string | null; step: number | null; of: number | null };
  safety: {
    checks: Array<{ class: string; passed: boolean; ruleId: string | null }>;
    moderator: { verdict: string; ms: number | null };
  };
  promptHash: string;
  tokens: number | null;
  channelLength: { chars: number | null; soft: number | null; hard: number | null };
};

export type TestTurnResult = {
  reply: string;
  held: boolean;
  heldClass: string | null;
  evidence: TestTurnEvidence;
};

export function narrowTestTurn(payload: unknown): TestTurnResult {
  const value = record(payload);
  const evidence = record(value.evidence);
  const qualification = record(evidence.qualification);
  const safety = record(evidence.safety);
  const moderator = record(safety.moderator);
  const length = record(evidence.channelLength);
  return {
    reply: text(value.reply),
    held: value.held === true,
    heldClass: typeof value.heldClass === "string" ? value.heldClass : null,
    evidence: {
      citations: (Array.isArray(evidence.citations) ? evidence.citations : []).map((item) => {
        const citation = record(item);
        return { entryId: text(citation.entryId), question: text(citation.question) };
      }),
      qualification: {
        ruleId: typeof qualification.ruleId === "string" ? qualification.ruleId : null,
        outcome: typeof qualification.outcome === "string" ? qualification.outcome : null,
        step: count(qualification.step),
        of: count(qualification.of),
      },
      safety: {
        checks: (Array.isArray(safety.checks) ? safety.checks : []).map((item) => {
          const check = record(item);
          return {
            class: text(check.class),
            passed: check.passed === true,
            ruleId: typeof check.ruleId === "string" ? check.ruleId : null,
          };
        }),
        moderator: { verdict: text(moderator.verdict), ms: count(moderator.ms) },
      },
      promptHash: text(evidence.promptHash),
      // The route reports `{ prompt, completion, total }`; the pane shows the total.
      tokens: count(evidence.tokens) ?? count(record(evidence.tokens).total),
      channelLength: { chars: count(length.chars), soft: count(length.soft), hard: count(length.hard) },
    },
  };
}

/* --------------------------------------------------------------------------------------------
 * Platform content: the engine's fixed sentences outside the Brain draft
 * ------------------------------------------------------------------------------------------ */

export type PlatformContentFields = {
  automatedExperienceDisclosure: string;
  platformFrame: string;
  roleBoundary: string;
  heldReplies: Record<ModeratorClass, string>;
};

export type PlatformContentView = {
  /** The values the engine reads today. Null until the live content has been approved once. */
  approved: PlatformContentFields | null;
  /** The values the engine reads, approved or not (the seed before the first approval). */
  live: PlatformContentFields;
  /** A saved, unapproved draft. Null when the live values are the latest saved ones. */
  draft: PlatformContentFields | null;
  /** The saved draft's content hash; approval must quote it back. */
  draftHash: string | null;
  /** Slots that still block approval, e.g. `controlCopy.STOP`; empty when approvable. */
  blockers: string[];
  canApprove: boolean;
  /** Read-only here: these two are owned by the Brain draft and only echoed for context. */
  mission: string;
  qualification: string;
};

export function emptyPlatformContent(): PlatformContentFields {
  return {
    automatedExperienceDisclosure: "",
    platformFrame: "",
    roleBoundary: "",
    heldReplies: Object.fromEntries(MODERATOR_CLASSES.map((cls) => [cls, ""])) as Record<ModeratorClass, string>,
  };
}

function narrowFields(value: unknown): PlatformContentFields | null {
  const row = record(value);
  if (!Object.keys(row).length) return null;
  const held = record(row.heldReplies);
  return {
    automatedExperienceDisclosure: text(row.automatedExperienceDisclosure),
    platformFrame: text(row.platformFrame),
    roleBoundary: text(row.roleBoundary),
    heldReplies: Object.fromEntries(MODERATOR_CLASSES.map((cls) => [cls, text(held[cls])])) as Record<ModeratorClass, string>,
  };
}

export function narrowPlatformContent(payload: unknown): PlatformContentView {
  // PUT and approve wrap the view under `view`; GET returns it at the top level.
  const outer = record(payload);
  const value = outer.view && typeof outer.view === "object" ? record(outer.view) : outer;
  const live = narrowFields(value.live) ?? emptyPlatformContent();
  const draftRow = record(value.draft);
  const draft = narrowFields(draftRow.values);
  const approval = record(value.approval);
  const brainOwned = record(value.brainOwned);
  return {
    approved: value.approved === true ? live : null,
    live,
    draft,
    draftHash: typeof draftRow.hash === "string" ? draftRow.hash : null,
    blockers: (Array.isArray(approval.blockers) ? approval.blockers : []).filter((item): item is string => typeof item === "string"),
    canApprove: approval.canApprove === true,
    mission: text(brainOwned.mission),
    qualification: text(brainOwned.qualification),
  };
}

/* --------------------------------------------------------------------------------------------
 * The assembled prompt
 * ------------------------------------------------------------------------------------------ */

export const PROMPT_SOURCES = ["system", "platform", "brain", "coach", "runtime"] as const;
export type PromptSource = (typeof PROMPT_SOURCES)[number];

export type PromptBlockView = { label: string; title: string; source: PromptSource; text: string };

export type AssembledPromptView = {
  blocks: PromptBlockView[];
  promptHash: string;
  tokens: number | null;
  knowledgeMode: string | null;
};

export function narrowAssembledPrompt(payload: unknown): AssembledPromptView {
  const value = record(payload);
  return {
    blocks: (Array.isArray(value.blocks) ? value.blocks : []).map((item) => {
      const block = record(item);
      const source = PROMPT_SOURCES.includes(block.source as PromptSource) ? block.source as PromptSource : "runtime";
      return { label: text(block.label), title: text(block.title), source, text: text(block.text) };
    }),
    promptHash: text(value.promptHash),
    tokens: count(value.tokens),
    knowledgeMode: typeof value.knowledgeMode === "string" ? value.knowledgeMode : null,
  };
}

/* --------------------------------------------------------------------------------------------
 * Client
 * ------------------------------------------------------------------------------------------ */

export function createOwnerBrainApi(fetcher: FetchLike = fetch) {
  return {
    async runTestTurn(input: TestTurnInput): Promise<TestTurnResult> {
      return narrowTestTurn(await request(fetcher, "/api/admin/brain/test-turn", {
        method: "POST",
        body: JSON.stringify(input),
      }));
    },
    async readPlatformContent(): Promise<PlatformContentView> {
      return narrowPlatformContent(await request(fetcher, "/api/admin/brain/platform-content", { method: "GET" }));
    },
    async savePlatformContentDraft(fields: PlatformContentFields): Promise<PlatformContentView> {
      return narrowPlatformContent(await request(fetcher, "/api/admin/brain/platform-content", {
        method: "PUT",
        body: JSON.stringify(fields),
      }));
    },
    async approvePlatformContent(input: { expectedDraftHash: string; reason: string }): Promise<PlatformContentView> {
      return narrowPlatformContent(await request(fetcher, "/api/admin/brain/platform-content/approve", {
        method: "POST",
        body: JSON.stringify(input),
      }));
    },
    async readAssembledPrompt(input: { coachTenantId: string; revision: TestRevision }): Promise<AssembledPromptView> {
      const query = new URLSearchParams({ coachTenantId: input.coachTenantId, revision: input.revision });
      return narrowAssembledPrompt(await request(fetcher, `/api/admin/brain/prompt?${query.toString()}`, { method: "GET" }));
    },
    /**
     * Acceptance with the reviewer's edited answer. The previous client posted the source text
     * unchanged; the review pane now edits the answer in place, so the edited text travels with
     * the decision and the server re-scans it before the row can become shared.
     */
    acceptImportItem(input: {
      batchId: string;
      itemId: string;
      sourceRef: string;
      disposition: string;
      tenantId: string | null;
      /** The reviewer's rewrite, or null when the source text is sent unchanged. */
      edit: { responseTemplate?: string; category?: string } | null;
      resolvedFlagIds: string[];
      numberBindings: Array<Record<string, unknown>>;
      bareXResolutions: Array<{ offset: number; token: string }>;
    }) {
      const { batchId, itemId, tenantId, edit, ...rest } = input;
      // The route refuses unknown keys, so the optional two travel only when they carry a value.
      const body = {
        ...rest,
        ...(tenantId ? { tenantId } : {}),
        ...(edit ? { edit } : {}),
      };
      return request(
        fetcher,
        `/api/admin/brain/imports/${encodeURIComponent(batchId)}/items/${encodeURIComponent(itemId)}/accept`,
        { method: "POST", body: JSON.stringify(body) },
      );
    },
    rejectImportItem(input: { batchId: string; itemId: string; reason: string }) {
      return request(
        fetcher,
        `/api/admin/brain/imports/${encodeURIComponent(input.batchId)}/items/${encodeURIComponent(input.itemId)}/reject`,
        { method: "POST", body: JSON.stringify({ reason: input.reason }) },
      );
    },
  };
}

export type OwnerBrainApi = ReturnType<typeof createOwnerBrainApi>;

const FAILURE_COPY: Readonly<Record<string, string>> = {
  RUNTIME_OFFER_NOT_PUBLISHED: "This coach has not published an offer yet, so there is nothing to run against. Pick another coach.",
  RUNTIME_BRAIN_NOT_PUBLISHED: "No Brain version is live yet. Publish one, or test the draft.",
  RUNTIME_TENANT_NOT_READY: "This coach's workspace is not ready for an agent yet.",
  BRAIN_DRAFT_NOT_FOUND: "There is no saved draft. Save one first, or switch to the live version.",
  BRAIN_TEST_TURN_RATE_LIMITED: "Too many test turns for this coach in the last minute. Wait a moment.",
  DRIVER_CONFIGURATION_ERROR: "The model driver is not configured on this deployment.",
  PLATFORM_AGENT_CONTENT_UNAPPROVED_NON_DEMO: "Platform text is not approved yet, so only a test tenant can run a turn.",
};

/** What the screen prints when a route answers with a failure. */
export function ownerBrainApiFailure(cause: unknown): string {
  if (cause instanceof OwnerBrainApiError) {
    if (cause.code === "ROUTE_NOT_DEPLOYED") return "This part of The Brain is not deployed yet.";
    return FAILURE_COPY[cause.code] ?? cause.code;
  }
  return cause instanceof Error ? cause.message : "The request did not complete.";
}
