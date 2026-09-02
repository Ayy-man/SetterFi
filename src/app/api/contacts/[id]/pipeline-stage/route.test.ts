import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPipelineStageHandler,
} from "@/app/api/contacts/[id]/pipeline-stage/handler";
import type { RouteActor } from "@/lib/auth/actors";

const actor: RouteActor = {
  userId: "actor-1",
  tenantId: "tenant-1",
  role: "coach",
  impersonatingTenant: null,
  impersonationSessionId: null,
};

const body = {
  stage: "qualifying" as const,
  expectedStage: "new_lead" as const,
  reason: "Reviewed with the coach",
  appointmentId: null,
  idempotencyKey: "pipeline-contact-1-qualifying",
};

type Dependencies = Parameters<typeof createPipelineStageHandler>[0];

function post(value: unknown) {
  return new Request("http://localhost/api/contacts/contact-1/pipeline-stage", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function context() {
  return { params: Promise.resolve({ id: "contact-1" }) };
}

function dependencies(overrides: Partial<Dependencies> = {}): Dependencies {
  return {
    enabled: () => true,
    session: async () => actor,
    setStage: async (tenantId, input) => ({
      contact: {
        id: input.contactId,
        tenantId,
        pipelineStage: input.stage,
        stageSetBy: input.setBy,
        stageSetAt: "2026-08-24T09:00:00.000Z",
      },
      audit: { id: 41, actionKey: "contact.pipeline_stage.set" },
    }),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pipeline stage route", () => {
  it("returns 404 while the write flag gate is off", async () => {
    const session = vi.fn(async () => actor);
    const handler = createPipelineStageHandler(dependencies({ enabled: () => false, session }));

    const response = await handler(post(body), context());

    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const response = await createPipelineStageHandler(dependencies({
      session: async () => null,
    }))(post(body), context());

    expect(response.status).toBe(401);
  });

  it("returns 403 for impersonation before attempting the mutation", async () => {
    const setStage = vi.fn(dependencies().setStage);
    const response = await createPipelineStageHandler(dependencies({
      session: async () => ({ ...actor, impersonatingTenant: "tenant-2" }),
      setStage,
    }))(post(body), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ message: "Impersonated sessions are read-only" });
    expect(setStage).not.toHaveBeenCalled();
  });

  it("returns 403 for a role outside the explicit write allowlist", async () => {
    const response = await createPipelineStageHandler(dependencies({
      session: async () => ({ ...actor, role: "affiliate" }),
    }))(post(body), context());

    expect(response.status).toBe(403);
  });

  it("returns 400 when the body contains an extra key", async () => {
    const setStage = vi.fn(dependencies().setStage);
    const response = await createPipelineStageHandler(dependencies({ setStage }))(
      post({ ...body, setBy: "system" }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(setStage).not.toHaveBeenCalled();
  });

  it("explains a stale or invalid transition without attempting the write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const setStage = vi.fn(async () => {
      throw new Error("PIPELINE_EXPECTED_STAGE_STALE");
    });
    const response = await createPipelineStageHandler(dependencies({ setStage }))(
      post(body),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: "PIPELINE_EXPECTED_STAGE_STALE",
      message: "This contact moved before your change. Refresh and try again.",
    });
    expect(setStage).toHaveBeenCalledOnce();
  });

  it.each(["coach", "coach_member", "owner", "admin", "success"] as const)(
    "returns the contact and positive audit id for the allowed %s role",
    async (role) => {
      const setStage = vi.fn(dependencies().setStage);
      const response = await createPipelineStageHandler(dependencies({
        session: async () => ({ ...actor, role }),
        setStage,
      }))(post(body), context());

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        contact: { id: "contact-1", pipelineStage: "qualifying" },
        audit: { id: 41, actionKey: "contact.pipeline_stage.set" },
      });
      expect(setStage).toHaveBeenCalledWith("tenant-1", {
        contactId: "contact-1",
        expectedStage: "new_lead",
        stage: "qualifying",
        setBy: "user",
        actorId: "actor-1",
        reason: "Reviewed with the coach",
        appointmentId: null,
        idempotencyKey: "pipeline-contact-1-qualifying",
      });
    },
  );

  it("leaves idempotency to the row-locked database mutation", async () => {
    const receipts = new Map<string, Awaited<ReturnType<Dependencies["setStage"]>>>();
    let writes = 0;
    const setStage: Dependencies["setStage"] = async (tenantId, input) => {
      const replay = receipts.get(input.idempotencyKey);
      if (replay) return replay;
      writes += 1;
      const result = {
        contact: {
          id: input.contactId,
          tenantId,
          pipelineStage: input.stage,
          stageSetBy: input.setBy,
          stageSetAt: "2026-08-24T09:00:00.000Z",
        },
        audit: { id: 73, actionKey: "contact.pipeline_stage.set" as const },
      };
      receipts.set(input.idempotencyKey, result);
      return result;
    };
    const handler = createPipelineStageHandler(dependencies({
      setStage,
    }));

    const first = await handler(post(body), context());
    const replay = await handler(post(body), context());

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect((await first.json()).audit.id).toBe(73);
    expect((await replay.json()).audit.id).toBe(73);
    expect(writes).toBe(1);
  });
});
