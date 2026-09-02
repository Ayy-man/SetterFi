import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function quotedValues(value: string) {
  return [...value.matchAll(/"([a-z][a-z0-9-]+)"/g)].map((match) => match[1]);
}

describe("Coach Contacts Phase 4 drawer", () => {
  it("loads identity detail from the named GET route only when a live drawer opens", () => {
    const component = source("src/components/workspace/live/coach-contacts.tsx");
    expect(component).toContain("if (!selected || fixtureMode) return");
    expect(component).toContain("fetchIdentityDetail(selected.id, controller.signal)");
    expect(component).toContain('candidate.state === "merged"');
    expect(component).toContain("mergedCandidate.otherContact.id");
    expect(component).toContain("/api/contacts/${encodeURIComponent(contactId)}/identities");
    expect(component).toContain('cache: "no-store"');
    expect(component).toContain("Possible duplicate");
    expect(component).toContain("Histories remain separate until a merge succeeds and is read back.");
  });

  it("keys every identity, merge, undo, deletion, and receipt state to the open contact", () => {
    const component = source("src/components/workspace/live/coach-contacts.tsx");
    const boundary = component.indexOf("function CoachContactsForSelection");
    expect(component).toContain('key={props.selectedId ?? "no-contact"}');
    for (const state of [
      "identityState",
      "mergeCandidateId",
      "undoTarget",
      "receipt",
      "deletePreview",
      "deleteOperation",
    ]) {
      expect(component.indexOf(`const [${state},`, boundary), state).toBeGreaterThan(boundary);
    }
  });

  it("keeps one deletion idempotency key and retry receipt for the life of a preview", () => {
    const component = source("src/components/workspace/live/coach-contacts.tsx");
    expect(component).toContain("idempotencyKey: deleteOperation.idempotencyKey");
    expect(component).toContain("retry: deleteOperation.retry");
    expect(component).toContain("retry: result.retry");
    expect(component.match(/actionIdempotencyKey\("contact-delete", selected\.id\)/g)).toHaveLength(1);
    expect(component).toContain("setDeleteOperation(null)");
  });

  it("requires explicit source, reason and confirmation before receipt-checked merge", () => {
    const component = source("src/components/workspace/live/coach-contacts.tsx");
    expect(component).toContain("Choose the confirmed source");
    expect(component).toContain("Why these two histories belong to one person");
    expect(component).toContain("I checked both separate histories");
    expect(component).toContain('actionKey="contact.merged"');
    expect(component).toContain("candidateReadBack?.state !== \"merged\"");
    expect(component).toContain("undo.auditRowId !== persistedReceipt.id");
    expect(component.indexOf("fetchIdentityDetail(selectedCandidate.otherContact.id)")).toBeLessThan(component.indexOf("setReceipt(persistedReceipt)"));
  });

  it("renders undo only from an audit-row-backed target and uses the registered action", () => {
    const component = source("src/components/workspace/live/coach-contacts.tsx");
    expect(component).toContain("{undoTarget ? (");
    expect(component).toContain("Reversible merge · audit {undoTarget.auditRowId}");
    expect(component).toContain('actionKey="contact.unmerged"');
    expect(component).toContain("mergeAuditId: undoTarget.auditRowId");
    expect(component).toContain("restoredDetail.mergeState.status !== \"active\"");
  });

  it("mirrors the route's Phase 4 export resources without pinning concurrent Phase 3 arms", () => {
    const route = source("src/app/api/exports/[resource]/handler.ts");
    const exportMenu = source("src/components/kit/export-menu.tsx");
    const expectedBlock = route.match(/export const PHASE4_EXPORT_RESOURCES = \[([\s\S]*?)\] as const;/)?.[1] ?? "";
    const serverProps = exportMenu.match(/type ServerExportMenuProps = ServerExportBase & \(([\s\S]*?)\n\);/)?.[1] ?? "";
    const phase4Block = (serverProps.split("// Phase 4")[1] ?? "").split("// Phase 3")[0] ?? "";
    expect(quotedValues(phase4Block)).toEqual(quotedValues(expectedBlock));
  });
});
