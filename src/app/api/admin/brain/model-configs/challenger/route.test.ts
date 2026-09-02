import { describe, expect, it, vi } from "vitest";

import { createChallengerModelConfigHandler } from "./handler";

const request = (body: unknown) => new Request(
  "https://setterfi.test/api/admin/brain/model-configs/challenger",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  },
);

const actor = { userId: "actor-1", role: "admin" as const };

describe("challenger model-config route", () => {
  it("404s before auth or repository access while the nested eval flag is off", async () => {
    const session = vi.fn(async () => actor);
    const create = vi.fn();
    const response = await createChallengerModelConfigHandler({
      enabled: () => false,
      session,
      create,
    })(request({ model: "vendor/model", params: {} }));
    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["success", "build", "coach"] as const)(
    "returns 403 to %s before privileged creation",
    async (role) => {
      const create = vi.fn();
      const response = await createChallengerModelConfigHandler({
        enabled: () => true,
        session: async () => ({ userId: "actor-1", role }),
        create,
      })(request({ model: "vendor/model", params: {} }));
      expect(response.status).toBe(403);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("accepts exactly model and params and returns the read-backed inactive generator", async () => {
    const create = vi.fn(async () => ({
      id: "config-b",
      model: "vendor/model-b",
      params: { temperature: 0 },
      role: "generator" as const,
      active: false,
      auditId: "41",
    }));
    const response = await createChallengerModelConfigHandler({
      enabled: () => true,
      session: async () => actor,
      create,
    })(request({ model: "vendor/model-b", params: { temperature: 0 } }));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      state: "created",
      receipt: { id: "config-b", role: "generator", active: false, auditId: "41" },
    });
    expect(create).toHaveBeenCalledWith({
      actorId: actor.userId,
      model: "vendor/model-b",
      params: { temperature: 0 },
    });
  });

  it.each([
    {},
    { model: "", params: {} },
    { model: "vendor/model", params: [] },
    { model: "vendor/model", params: {}, active: true },
  ])("rejects an unclosed body %# without repository work", async (body) => {
    const create = vi.fn();
    const response = await createChallengerModelConfigHandler({
      enabled: () => true,
      session: async () => actor,
      create,
    })(request(body));
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns no created state when repository read-back fails", async () => {
    const response = await createChallengerModelConfigHandler({
      enabled: () => true,
      session: async () => actor,
      create: async () => { throw new Error("EVAL_CHALLENGER_READBACK_MISMATCH"); },
    })(request({ model: "vendor/model", params: {} }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      state: "refused",
      code: "EVAL_CHALLENGER_REFUSED",
    });
  });
});
