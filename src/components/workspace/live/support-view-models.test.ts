import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type {
  CoachSupportThreadRead,
  PlatformSupportThreadRead,
} from "@/lib/repositories/support";
import {
  coachSupportThreadView,
  platformSupportThreadView,
  reassignmentControlState,
  supportLoadState,
} from "./support-view-models";

const coachThread: CoachSupportThreadRead = {
  id: "thread-1",
  tenantId: "tenant-1",
  subject: "Calendar connection",
  status: "open",
  assignedTo: null,
  isTest: true,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T01:00:00.000Z",
  messages: [{
    id: "message-1",
    authorId: "coach-1",
    authorName: "Coach",
    body: "Please help",
    isTest: true,
    createdAt: "2026-08-18T00:00:00.000Z",
  }],
};

const platformThread: PlatformSupportThreadRead = {
  id: "thread-2",
  tenantId: "tenant-2",
  tenantName: "Demo coach",
  tenantIsDemo: true,
  subject: "Invite",
  status: "waiting_on_coach",
  assignedTo: null,
  successOwner: null,
  isTest: false,
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T01:00:00.000Z",
  messages: [{
    ...coachThread.messages[0],
    internal: true,
  }],
};

describe("support view models", () => {
  it("keeps disabled, loading, error and empty distinct from a ready response", () => {
    expect(supportLoadState({ enabled: false, loading: true, error: "ignored", rows: [] })).toEqual({
      kind: "disabled",
      message: "Phase 8 support is not enabled",
    });
    expect(supportLoadState({ enabled: true, loading: true, error: null, rows: [] }).kind).toBe("loading");
    expect(supportLoadState({ enabled: true, loading: false, error: "Read failed", rows: [] })).toEqual({
      kind: "error",
      message: "Read failed",
    });
    expect(supportLoadState({ enabled: true, loading: false, error: null, rows: [] }).kind).toBe("empty");
    expect(supportLoadState({ enabled: true, loading: false, error: null, rows: [coachThread] }).kind).toBe("ready");
  });

  it("derives coach rows from a type that cannot carry internal notes", () => {
    const view = coachSupportThreadView(coachThread);
    expect(view.assignedLabel).toBe("Unassigned");
    expect(view.dataLabel).toBe("Test");
    expect(view.messages[0]).not.toHaveProperty("internal");
    /*
     * The source half of the same rule: the page a coach reads must not be able to reach a
     * staff-only field, whatever the view model does with the row it is handed.
     *
     * The positive control was `resource="coach-support-messages"`, the audited write the page's
     * composer filed. That export left with the composer: the 2026-09-04 rebuild reduced this
     * surface to the guides list and a read-only record of past requests, so the page files no
     * writes at all and there is no audited resource left to name. Re-adding one to keep a control
     * green would be the guard editing the product.
     *
     * The type is the honest control instead, and a stricter one. `CoachSupportThreadRead` has no
     * internal-note field, so a page that reads it cannot render one by mistake; a page that
     * reached for `PlatformSupportThreadRead` could, which is why its absence is asserted here
     * rather than left to the negative above. Together they say the file reads the coach type,
     * reads only the coach type, and touches none of the three spellings of a staff-only note.
     */
    const source = readFileSync(new URL("./coach-support.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/\.internal\b|internal_note|resource="support-messages"/);
    expect(source, "the coach page reads the coach type").toContain("CoachSupportThreadRead");
    expect(source, "and no admin one").not.toContain("PlatformSupportThreadRead");
  });

  it("retains staff-only internal evidence only in the platform projection", () => {
    const view = platformSupportThreadView(platformThread);
    expect(view.messages[0].internal).toBe(true);
    expect(view.assignedLabel).toBe("Unassigned");
    expect(view.successOwnerLabel).toBe("Unassigned");
    expect(view.dataLabel).toBe("Demo");
  });

  it("refuses Reassigned and Logged unless tenant, assignee and audit read-back all match", () => {
    const receipt = {
      state: "Reassigned",
      tenantId: "tenant-1",
      successOwner: "success-1",
      audit: { id: 41, actionKey: "tenant.success_owner.reassigned" },
    };
    expect(reassignmentControlState({
      expectedTenant: "tenant-1",
      expectedAssignee: "success-1",
      receipt,
    })).toEqual({ kind: "reassigned", label: "Reassigned", auditId: 41 });
    expect(reassignmentControlState({
      expectedTenant: "tenant-1",
      expectedAssignee: "success-2",
      receipt,
    })).toEqual({ kind: "pending", label: "Owner unchanged", auditId: null });
    expect(reassignmentControlState({
      expectedTenant: "tenant-1",
      expectedAssignee: "success-1",
      receipt: { ...receipt, audit: { id: 0, actionKey: "tenant.success_owner.reassigned" } },
    }).kind).toBe("pending");
  });
});
