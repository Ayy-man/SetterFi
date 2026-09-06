import { describe, expect, it, vi } from "vitest";

import {
  PlatformAgentContentError,
  type PlatformAgentContentView,
} from "@/lib/repositories/platform-agent-content";

import { createPlatformContentApproveHandler } from "./approve/handler";
import { createPlatformContentReadHandler, createPlatformContentSaveHandler } from "./handler";

const admin = { userId: "platform-admin", role: "admin" as const };
const HELD = Object.fromEntries(
  ["NUM", "CLAIM", "ECHO", "LINK", "SCOPE", "LEN", "JUDGE", "REVOKE"].map((key) => [key, `Held ${key}`]),
) as Record<string, string>;
const CONTROL = { STOP: "You're unsubscribed.", HELP: "Reply STOP to opt out.", START: "You're back on." };
const draft = {
  automatedExperienceDisclosure: "You're chatting with an automated assistant.",
  platformFrame: "Frame",
  roleBoundary: "Boundary",
  scopeDeflection1: "Let's keep to the programme.",
  scopeDeflection2: "I can only help with the programme.",
  scopeClosing: "I'll leave it there.",
  heldReplies: HELD,
  controlCopy: CONTROL,
};
const view: PlatformAgentContentView = {
  approved: false,
  approvedAt: null,
  live: { ...draft, heldReplies: HELD as PlatformAgentContentView["live"]["heldReplies"] },
  brainOwned: { mission: "m", qualification: "q", source: "brain" },
  draft: null,
  approval: { blockers: [], canApprove: false },
};
const audit = { auditId: "41", actionKey: "platform_content.draft.saved" as const, label: "Platform content draft logged", ariaLabel: "x" };

const json = (method: string, payload?: unknown) => new Request("http://localhost/api/admin/brain/platform-content", {
  method,
  headers: { "content-type": "application/json" },
  ...(payload === undefined ? {} : { body: typeof payload === "string" ? payload : JSON.stringify(payload) }),
});

describe("GET /api/admin/brain/platform-content", () => {
  it("gates on Phase 2 and admin role, then returns the view", async () => {
    const load = vi.fn(async () => view);
    expect((await createPlatformContentReadHandler({ enabled: () => false, session: async () => admin, load })()).status).toBe(404);
    expect((await createPlatformContentReadHandler({ enabled: () => true, session: async () => ({ userId: "s", role: "success" }), load })()).status).toBe(403);
    expect(load).not.toHaveBeenCalled();
    const response = await createPlatformContentReadHandler({ enabled: () => true, session: async () => admin, load })();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual(view);
  });
});

describe("PUT /api/admin/brain/platform-content", () => {
  function handler(save = vi.fn(async () => ({ view, audit }))) {
    return { handle: createPlatformContentSaveHandler({ enabled: () => true, session: async () => admin, save }), save };
  }

  it("refuses anything but the exact editable shape without touching the repository", async () => {
    const { handle, save } = handler();
    for (const payload of ["nope", { ...draft, mission: "m" }, { ...draft, heldReplies: { NUM: "x" } }, { ...draft, controlCopy: { STOP: "s" } }, { draft }]) {
      const response = await handle(json("PUT", payload));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "PLATFORM_CONTENT_DRAFT_BODY_INVALID" });
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("saves under the session actor and returns the view with its audit receipt", async () => {
    const { handle, save } = handler();
    const response = await handle(json("PUT", draft));
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith({ actorId: admin.userId, draft });
    expect(await response.json()).toEqual({ state: "draft", view, audit });
  });

  it("maps repository refusals to their status", async () => {
    const forbidden = await handler(vi.fn(async () => { throw new PlatformAgentContentError("PLATFORM_CONTENT_ADMIN_REQUIRED"); })).handle(json("PUT", draft));
    expect(forbidden.status).toBe(403);
    const missing = await handler(vi.fn(async () => { throw new PlatformAgentContentError("PLATFORM_SETTINGS_ROW_REQUIRED"); })).handle(json("PUT", draft));
    expect(missing.status).toBe(409);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const unknown = await handler(vi.fn(async () => { throw new Error("boom"); })).handle(json("PUT", draft));
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ state: "refused", code: "PLATFORM_CONTENT_DRAFT_REFUSED" });
    error.mockRestore();
  });
});

describe("POST /api/admin/brain/platform-content/approve", () => {
  const approvedView = { ...view, approved: true, approvedAt: "2026-09-06T01:00:00Z" };
  const approvedAudit = { ...audit, auditId: "42", actionKey: "platform_content.approved" as const, label: "Platform content approval logged" };
  const body = { expectedDraftHash: "1".repeat(64), reason: "Reviewed with the client" };

  function handler(approve = vi.fn(async () => ({ view: approvedView, audit: approvedAudit, contentHash: "2".repeat(64) }))) {
    return { handle: createPlatformContentApproveHandler({ enabled: () => true, session: async () => admin, approve }), approve };
  }

  it("requires the exact body with a 64-hex hash and a bounded reason", async () => {
    const { handle, approve } = handler();
    for (const payload of ["x", { reason: "r" }, { ...body, expectedDraftHash: "short" }, { ...body, reason: " " }, { ...body, reason: "x".repeat(501) }, { ...body, extra: 1 }]) {
      const response = await handle(json("POST", payload));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ state: "refused", code: "PLATFORM_CONTENT_APPROVE_BODY_INVALID" });
    }
    expect(approve).not.toHaveBeenCalled();
  });

  it("approves under the session actor and returns the flipped view, audit and content hash", async () => {
    const { handle, approve } = handler();
    const response = await handle(json("POST", { ...body, reason: "  Reviewed  " }));
    expect(response.status).toBe(200);
    expect(approve).toHaveBeenCalledWith({ actorId: admin.userId, expectedDraftHash: "1".repeat(64), reason: "Reviewed" });
    expect(await response.json()).toEqual({ state: "approved", view: approvedView, audit: approvedAudit, contentHash: "2".repeat(64) });
  });

  it("returns 409 with the blocking slots when approval is refused, and 409 on a stale hash", async () => {
    const blocked = await handler(vi.fn(async () => {
      throw new PlatformAgentContentError("PLATFORM_CONTENT_NOT_APPROVABLE", "controlCopy.STOP,scopeClosing");
    })).handle(json("POST", body));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ state: "blocked", code: "PLATFORM_CONTENT_NOT_APPROVABLE", blockers: ["controlCopy.STOP", "scopeClosing"] });
    const stale = await handler(vi.fn(async () => { throw new PlatformAgentContentError("PLATFORM_CONTENT_DRAFT_STALE"); })).handle(json("POST", body));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ state: "blocked", code: "PLATFORM_CONTENT_DRAFT_STALE" });
  });

  it("gates on Phase 2 and admin role before reading the body", async () => {
    const approve = vi.fn();
    expect((await createPlatformContentApproveHandler({ enabled: () => false, session: async () => admin, approve })(json("POST", body))).status).toBe(404);
    expect((await createPlatformContentApproveHandler({ enabled: () => true, session: async () => null, approve })(json("POST", body))).status).toBe(403);
    expect(approve).not.toHaveBeenCalled();
  });
});
