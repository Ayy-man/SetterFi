import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { approvedControlReply } from "@/lib/suppression/control-replies";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

describe("approved carrier control replies", () => {
  it("accepts only a published, receipt-backed, hash-matching artifact", () => {
    const body = "Example Brand: reply STOP to opt out.";
    expect(approvedControlReply({
      kind: "stop",
      version: 2,
      body,
      body_hash: digest(body),
      approval_reference: "Counsel approval 2026-09-12",
      approval_audit_id: 42,
      published_at: "2026-09-12T10:00:00.000Z",
      is_published: true,
    })).toMatchObject({ kind: "stop", version: 2, body, approvalAuditId: 42 });
  });

  it("treats drafts, placeholders, and a stale hash as unapproved and unsendable", () => {
    const base = {
      kind: "help",
      version: 1,
      body: "Reply STOP to opt out.",
      body_hash: digest("Reply STOP to opt out."),
      approval_reference: "Counsel approval",
      approval_audit_id: 7,
      published_at: "2026-09-12T10:00:00.000Z",
      is_published: true,
    } as const;
    expect(approvedControlReply({ ...base, is_published: false })).toBeNull();
    expect(approvedControlReply({ ...base, body: "SETTERFI_DEMO_PLACEHOLDER_HELP_COPY" })).toBeNull();
    expect(approvedControlReply({ ...base, body_hash: "0".repeat(64) })).toBeNull();
  });
});
