import { describe, expect, it, vi } from "vitest";

import type { NightlyEngineEvalResult } from "@/lib/evals/nightly-engine-evals";
import { createEngineEvalJobHandler } from "./handler";

const outcomes = { caught: 3, refused: 3, missed_by_checker: 0, uncaught: 0, clean: 4, false_block: 0 };
const complete: NightlyEngineEvalResult = {
  state: "complete" as const, runId: "run-synthetic", snapshotId: "snapshot-synthetic", draftId: "draft-synthetic", contentHash: "c".repeat(64),
  cases: 10, passed: 10, judge: "moderator" as const, moderatorConfigId: "moderator-synthetic", outcomes,
};

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

  it("writes the pass count, the outcome breakdown, and the judged flag into the receipt counters", async () => {
    const execute = vi.fn(async (_job: string, work: () => Promise<unknown>, options?: { counters?: (result: never) => Record<string, number> }) => {
      const result = await work();
      return Object.assign(result as object, { counters: options?.counters?.(result as never) });
    });
    const response = await createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run: async () => complete, execute: execute as never })(new Request("http://local/api/jobs/engine-evals", { headers: { authorization: "Bearer synthetic-secret" } }));
    expect(response.status).toBe(200);
    await expect(execute.mock.results[0].value).resolves.toMatchObject({ counters: { cases: 10, passed: 10, ...outcomes, judged: 1 } });
    const unjudged: NightlyEngineEvalResult = { ...complete, judge: "unjudged" as const, moderatorConfigId: null, passed: 7, outcomes: { ...outcomes, refused: 0, uncaught: 3 } };
    await createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run: async () => unjudged, execute: execute as never })(new Request("http://local/api/jobs/engine-evals", { headers: { authorization: "Bearer synthetic-secret" } }));
    await expect(execute.mock.results[1].value).resolves.toMatchObject({ counters: { passed: 7, uncaught: 3, unjudged: 1 } });
  });

  it("returns unavailable as a failure and never turns it into a pass", async () => {
    const unavailable = { state: "unavailable" as const, code: "ENGINE_EVAL_UNAVAILABLE" as const, reason: "OPENROUTER_API_KEY is missing." };
    const response = await createEngineEvalJobHandler({ enabled: () => true, secret: "synthetic-secret", run: async () => unavailable })(new Request("http://local/api/jobs/engine-evals", { headers: { authorization: "Bearer synthetic-secret" } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(unavailable);
  });
});
