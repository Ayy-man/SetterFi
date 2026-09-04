import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createContactSupportRequestHandler,
} from "@/app/api/contacts/[id]/support-request/handler";
import type { CoachSupportThreadRead } from "@/lib/repositories/support";
import type { SupportSession } from "@/lib/support/service";

const coach: SupportSession = {
  userId: "coach-user",
  role: "coach",
  tenantId: "tenant-1",
  impersonatingTenant: null,
};

const thread: CoachSupportThreadRead = {
  id: "thread-1",
  tenantId: "tenant-1",
  subject: "Report a duplicate: Denise Alvarez",
  status: "open",
  assignedTo: null,
  relatedContactId: "contact-1",
  isTest: true,
  createdAt: "2026-09-04T00:00:00.000Z",
  updatedAt: "2026-09-04T00:00:00.000Z",
  messages: [{
    id: "message-1",
    authorId: "coach-user",
    authorName: "Coach",
    body: "Lead: Denise Alvarez (contact-1)\n\nSame lead texted us from two numbers.",
    isTest: true,
    createdAt: "2026-09-04T00:00:00.000Z",
  }],
};

type Dependencies = Parameters<typeof createContactSupportRequestHandler>[0];

function post(value: unknown) {
  return new Request("http://localhost/api/contacts/contact-1/support-request", {
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
    session: async () => coach,
    lookupContact: async () => ({ name: "Denise Alvarez" }),
    create: async () => thread,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("contact support-request route", () => {
  it("returns 404 while the support flag gate is off, before reading a session", async () => {
    const session = vi.fn(async () => coach);
    const handler = createContactSupportRequestHandler(dependencies({
      enabled: () => false,
      session,
    }));

    const response = await handler(post({ type: "duplicate", note: "Two numbers, same lead." }), context());

    expect(response.status).toBe(404);
    expect(session).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    const response = await createContactSupportRequestHandler(dependencies({
      session: async () => null,
    }))(post({ type: "duplicate", note: "note" }), context());

    expect(response.status).toBe(401);
  });

  it("returns 403 for an impersonated session without attempting the write", async () => {
    const create = vi.fn(dependencies().create);
    const response = await createContactSupportRequestHandler(dependencies({
      session: async () => ({ ...coach, impersonatingTenant: "tenant-2" }),
      create,
    }))(post({ type: "duplicate", note: "note" }), context());

    expect(response.status).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-coach role", async () => {
    const response = await createContactSupportRequestHandler(dependencies({
      session: async () => ({ ...coach, role: "admin", tenantId: null }),
    }))(post({ type: "duplicate", note: "note" }), context());

    expect(response.status).toBe(403);
  });

  it.each([
    { type: "duplicate", note: "" },
    { type: "duplicate" },
    { type: "not-a-kind", note: "note" },
    { type: "duplicate", note: "note", extra: true },
  ])("returns 400 for an invalid body %j", async (body) => {
    const create = vi.fn(dependencies().create);
    const response = await createContactSupportRequestHandler(dependencies({ create }))(
      post(body),
      context(),
    );

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns 404 when the lead is not found in this tenant, without writing", async () => {
    const create = vi.fn(dependencies().create);
    const response = await createContactSupportRequestHandler(dependencies({
      lookupContact: async () => null,
      create,
    }))(post({ type: "deletion", note: "Lead asked us to delete their data." }), context());

    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("never mutates the contact: it only creates a support thread tagged with the lead", async () => {
    const create = vi.fn(async () => thread);
    const response = await createContactSupportRequestHandler(dependencies({ create }))(
      post({ type: "duplicate", note: "Same lead texted us from two numbers." }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ thread });
    expect(create).toHaveBeenCalledWith(coach, {
      subject: "Report a duplicate: Denise Alvarez",
      body: "Lead: Denise Alvarez (contact-1)\n\nSame lead texted us from two numbers.",
      relatedContactId: "contact-1",
    });
  });

  it("builds the deletion-request subject and body the same way", async () => {
    const create = vi.fn(async () => ({ ...thread, subject: "Request deletion: Denise Alvarez" }));
    const response = await createContactSupportRequestHandler(dependencies({ create }))(
      post({ type: "deletion", note: "Lead asked us to delete their data." }),
      context(),
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(coach, {
      subject: "Request deletion: Denise Alvarez",
      body: "Lead: Denise Alvarez (contact-1)\n\nLead asked us to delete their data.",
      relatedContactId: "contact-1",
    });
  });

  it("returns 409 when the support write is refused, logging the cause but not leaking it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const create = vi.fn(async () => {
      throw new Error("SUPPORT_THREAD_CREATE_READBACK_MISMATCH");
    });
    const response = await createContactSupportRequestHandler(dependencies({ create }))(
      post({ type: "duplicate", note: "note" }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "This request could not be sent to support. Refresh the lead and try again.",
    });
  });
});
