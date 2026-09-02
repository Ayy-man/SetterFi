import { describe, expect, it, vi } from "vitest";

import { createEngineEvalJobHandler } from "./handler";

const complete = { state: "complete" as const, runId: "run-synthetic", snapshotId: "snapshot-synthetic", draftId: "draft-synthetic", contentHash: "c".repeat(64), cases: 6 };

describe("engine eval cron job", () => {
  it("returns 404 before auth or work while the flag is off", async () => {
    const run = vi.fn(async () => complete);
    const response = await createEngineEvalJobHandler({ enabled: () => false, secret: "synthetic-secret", run })(new Request("http://local/api/jobs/engine-evals"));
    expect(response.status).toBe(404);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires the cron bearer before running", async () => {
    const run = vi.fn(async () => complete);
    const handler = createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run });
    expect((await handler(new Request("http://local/api/jobs/engine-evals"))).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns the exact completed published evidence", async () => {
    const run = vi.fn(async () => complete);
    const response = await createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run })(new Request("http://local/api/jobs/engine-evals", { headers: { authorization: "Bearer synthetic-secret" } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(complete);
  });

  it("returns unavailable as a failure and never turns it into a pass", async () => {
    const unavailable = { state: "unavailable" as const, code: "ENGINE_EVAL_UNAVAILABLE" as const, reason: "OPENROUTER_API_KEY is missing." };
    const response = await createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run: async () => unavailable })(new Request("http://local/api/jobs/engine-evals", { headers: { authorization: "Bearer synthetic-secret" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
  });
});
