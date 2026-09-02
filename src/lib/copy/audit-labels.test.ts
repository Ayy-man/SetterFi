import { describe, expect, it } from "vitest";

import { AUDIT_ACTION_KEYS, AUDIT_ACTIONS } from "@/lib/audit/actions";
import { auditActionLabel } from "@/lib/copy/audit-labels";

describe("auditActionLabel", () => {
  it.each(AUDIT_ACTION_KEYS)("gives %s registry copy and a human sentence", (key) => {
    const label = auditActionLabel(key);

    expect(label).toContain(AUDIT_ACTIONS[key].microcopy);
    expect(label).toContain(AUDIT_ACTIONS[key].ariaLabel);
    expect(label).not.toContain(key);
  });
});
