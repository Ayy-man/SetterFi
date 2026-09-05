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
  method: "POST",
  body: Readonly<Record<string, unknown>>,
) {
  const response = await fetcher(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
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
  };
}
