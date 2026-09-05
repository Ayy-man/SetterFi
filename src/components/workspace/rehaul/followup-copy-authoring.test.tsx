import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FollowupCopyApprovals } from "./followup-copy-approvals";
import { FollowupCopyAuthoring } from "./followup-copy-authoring";

const item = {
  id: "template-a", tenantId: "tenant-a", tenantName: "Synthetic coaching", channel: "sms" as const,
  purpose: "value_nudge" as const, body: "Still interested?", status: "draft" as const,
  rejectionDetail: null, updatedAt: "2026-10-13T10:00:00.000Z",
};

afterEach(() => vi.unstubAllGlobals());

describe("FollowupCopyAuthoring", () => {
  it("shows every sending purpose per connected channel with the SMS character limit", () => {
    render(<FollowupCopyAuthoring channels={[{ channel: "sms", channelLabel: "Text messages (SMS)" }]} enabled initialItems={[item]} />);
    expect(screen.getByRole("heading", { name: "Follow-up copy" })).toBeVisible();
    expect(screen.getAllByRole("button", { name: "Save draft" })).toHaveLength(6);
    expect(screen.getByText("17/160 characters")).toBeVisible();
    expect(screen.getByDisplayValue("Still interested?")).toBeVisible();
  });

  it("saves a draft through the tenant-scoped route and reports the persisted receipt", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ templateId: "template-a", status: "draft" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    render(<FollowupCopyAuthoring channels={[{ channel: "sms", channelLabel: "Text messages (SMS)" }]} enabled initialItems={[item]} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Save draft" })[2]);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/coach/followup-copy", expect.objectContaining({ method: "PUT" })));
    expect(await screen.findByText("Draft saved and logged.")).toBeVisible();
  });
});

describe("FollowupCopyApprovals", () => {
  it("requires a reason before an admin can approve and sends the platform decision", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ status: "approved", auditId: "77" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    render(<FollowupCopyApprovals initialItems={[{ ...item, status: "submitted" }]} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByText("Add a reason before recording this decision.")).toBeVisible();
    fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "Copy is accurate." } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/admin/followup-copy", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("Copy approved and logged.")).toBeVisible();
  });
});
