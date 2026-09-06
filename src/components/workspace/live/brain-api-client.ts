import type { ImportDisposition } from "@/lib/brain/contracts";

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class BrainApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
  }
}

async function requestJson(
  fetcher: FetchLike,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: Readonly<Record<string, unknown>>,
) {
  const response = await fetcher(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const value = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    throw new BrainApiError(response.status, typeof value.code === "string" ? value.code : `HTTP_${response.status}`);
  }
  return payload;
}

export function createBrainApiClient(fetcher: FetchLike = fetch) {
  return {
    importConfigured() {
      return requestJson(fetcher, "/api/admin/brain/import", "POST", { source: "configured" });
    },
    acceptImportItem(input: {
      batchId: string;
      itemId: string;
      sourceRef: string;
      disposition: ImportDisposition;
      /** Required when `disposition` is `tenant_specific`; the route refuses it otherwise. */
      tenantId?: string | null;
      /** The reviewer's rewrite. Required before a content-flagged row may go to the shared Brain. */
      edit?: { responseTemplate?: string; category?: string } | null;
      resolvedFlagIds: string[];
      numberBindings: Array<Record<string, unknown>>;
      bareXResolutions: Array<{ offset: number; token: string }>;
    }) {
      return requestJson(
        fetcher,
        `/api/admin/brain/imports/${encodeURIComponent(input.batchId)}/items/${encodeURIComponent(input.itemId)}/accept`,
        "POST",
        {
          sourceRef: input.sourceRef,
          disposition: input.disposition,
          resolvedFlagIds: input.resolvedFlagIds,
          numberBindings: input.numberBindings,
          bareXResolutions: input.bareXResolutions,
          ...(input.tenantId ? { tenantId: input.tenantId } : {}),
          ...(input.edit ? { edit: input.edit } : {}),
        },
      );
    },
    rejectImportItem(input: { batchId: string; itemId: string; sourceRef: string; reason: string }) {
      return requestJson(
        fetcher,
        `/api/admin/brain/imports/${encodeURIComponent(input.batchId)}/items/${encodeURIComponent(input.itemId)}/reject`,
        "POST",
        { sourceRef: input.sourceRef, reason: input.reason },
      );
    },
    createDraft(draft: Readonly<Record<string, unknown>>) {
      return requestJson(fetcher, "/api/admin/brain/draft", "POST", { draft });
    },
    runEval(input: { draftId: string; contentHash: string }) {
      return requestJson(fetcher, "/api/admin/brain/evals", "POST", { ...input, kind: "checker" });
    },
    publish(input: { draftId: string; evalRunId: string; expectedCurrentVersion: number; reason: string }) {
      return requestJson(fetcher, "/api/admin/brain/publish", "POST", input);
    },
    rollback(input: { expectedCurrentVersion: number; selectedVersion: number; reason: string }) {
      return requestJson(fetcher, "/api/admin/brain/rollback", "POST", input);
    },
    runAgent(message: string, history: string[] = []) {
      return requestJson(fetcher, "/api/agent", "POST", { message, history });
    },
    /** An owner test turn against a chosen coach and Brain revision; nothing is sent or written. */
    runTestTurn(input: {
      coachTenantId: string;
      revision: "draft" | "live";
      channel: "sms" | "instagram" | "messenger" | "whatsapp" | "webchat";
      message: string;
      history?: Array<{ role: "user" | "assistant"; content: string }>;
    }) {
      return requestJson(fetcher, "/api/admin/brain/test-turn", "POST", {
        coachTenantId: input.coachTenantId,
        revision: input.revision,
        channel: input.channel,
        message: input.message,
        history: input.history ?? [],
      });
    },
    loadPlatformContent() {
      return requestJson(fetcher, "/api/admin/brain/platform-content", "GET");
    },
    /** Saves an unapproved draft; the row the pipeline reads is untouched until approval. */
    savePlatformContentDraft(input: {
      automatedExperienceDisclosure: string;
      platformFrame: string;
      roleBoundary: string;
      heldReplies: Record<string, string>;
    }) {
      return requestJson(fetcher, "/api/admin/brain/platform-content", "PUT", input);
    },
    approvePlatformContent(input: { expectedDraftHash: string; reason: string }) {
      return requestJson(fetcher, "/api/admin/brain/platform-content/approve", "POST", input);
    },
    inspectPrompt(input: { coachTenantId: string; revision: "draft" | "live" }) {
      const query = new URLSearchParams({ coachTenantId: input.coachTenantId, revision: input.revision });
      return requestJson(fetcher, `/api/admin/brain/prompt?${query.toString()}`, "GET");
    },
  };
}
