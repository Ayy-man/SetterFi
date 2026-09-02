import { describe, expect, it } from "vitest";

import { BrainApiError, createBrainApiClient } from "./brain-api-client";

function response(body: unknown, status = 200) {
  return Promise.resolve(Response.json(body, { status }));
}

describe("Brain API client", () => {
  it("sends only configured source authority to import", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = createBrainApiClient(async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return response({ status: "complete" });
    });
    await client.importConfigured();
    expect(calls).toEqual([{ path: "/api/admin/brain/import", body: { source: "configured" } }]);
  });

  it("sends reviewed resolutions without source content", async () => {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = createBrainApiClient(async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return response({ state: "accepted" });
    });
    await client.acceptImportItem({
      batchId: "batch/id",
      itemId: "item/id",
      sourceRef: "synthetic-1",
      disposition: "shared",
      resolvedFlagIds: ["flag-1"],
      numberBindings: [],
      bareXResolutions: [],
    });
    expect(calls[0].path).toBe("/api/admin/brain/imports/batch%2Fid/items/item%2Fid/accept");
    expect(calls[0].body).toEqual({
      sourceRef: "synthetic-1", disposition: "shared", resolvedFlagIds: ["flag-1"],
      numberBindings: [], bareXResolutions: [],
    });
    expect(calls[0].body).not.toHaveProperty("responseTemplate");
  });

  it("keeps draft, eval, publish, rollback, and agent payloads exact", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const client = createBrainApiClient(async (input, init) => {
      calls.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      return response({ state: "ok" });
    });
    await client.createDraft({ entities: [] });
    await client.runEval({ draftId: "draft", contentHash: "a".repeat(64) });
    await client.publish({ draftId: "draft", evalRunId: "run", expectedCurrentVersion: 3, reason: "Reviewed" });
    await client.rollback({ expectedCurrentVersion: 4, selectedVersion: 2, reason: "Restore" });
    await client.runAgent("Synthetic question", ["Earlier synthetic turn"]);
    expect(calls).toEqual([
      { path: "/api/admin/brain/draft", body: { draft: { entities: [] } } },
      { path: "/api/admin/brain/evals", body: { draftId: "draft", contentHash: "a".repeat(64), kind: "checker" } },
      { path: "/api/admin/brain/publish", body: { draftId: "draft", evalRunId: "run", expectedCurrentVersion: 3, reason: "Reviewed" } },
      { path: "/api/admin/brain/rollback", body: { expectedCurrentVersion: 4, selectedVersion: 2, reason: "Restore" } },
      { path: "/api/agent", body: { message: "Synthetic question", history: ["Earlier synthetic turn"] } },
    ]);
  });

  it("preserves a named route refusal rather than turning it into success", async () => {
    const client = createBrainApiClient(() => response({ state: "blocked", code: "BRAIN_EVAL_STALE" }, 409));
    await expect(client.publish({ draftId: "d", evalRunId: "e", expectedCurrentVersion: 1, reason: "r" }))
      .rejects.toEqual(new BrainApiError(409, "BRAIN_EVAL_STALE"));
  });
});
