import { describe, expect, it, vi } from "vitest";

import {
  createAgentInactivitySweepJobHandler,
  type AgentInactivitySweepResult,
} from "./handler";

const request = (secret = "secret") => new Request("https://app.test/api/jobs/agent-inactivity-sweep", {
  method: "POST", headers: { authorization: `Bearer ${secret}` },
});

describe("agent inactivity sweep job", () => {
  it("requires the alert event gate and cron secret", async () => {
    const run = vi.fn().mockResolvedValue({ selected: 0, emitted: 0 });
    expect((await createAgentInactivitySweepJobHandler({ enabled: () => false, secret: "secret", run })(request())).status).toBe(404);
    expect((await createAgentInactivitySweepJobHandler({ enabled: () => true, secret: null, run })(request())).status).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("returns only actual selection and durable emission counts", async () => {
    const result: AgentInactivitySweepResult = { selected: 2, emitted: 3 };
    const response = await createAgentInactivitySweepJobHandler({
      enabled: () => true, secret: "secret", run: async () => result,
    })(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it("writes a cron receipt with the sweep counters", async () => {
    const calls: Array<{ key: string; counters: Record<string, number> }> = [];
    const execute = vi.fn(async (key, work, options) => {
      const result = await work();
      calls.push({ key, counters: options?.counters?.(result) ?? {} });
      return result;
    });
    await createAgentInactivitySweepJobHandler({
      enabled: () => true, secret: "secret", execute: execute as never,
      run: async () => ({ selected: 2, emitted: 3 }),
    })(request());
    expect(calls).toEqual([{ key: "agent-inactivity-sweep", counters: { selected: 2, emitted: 3 } }]);
  });
});
