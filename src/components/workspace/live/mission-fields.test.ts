import { describe, expect, it } from "vitest";

import { MISSION_FIELD_COPY, missionFieldCopy } from "./mission-fields";

// The six columns brain_mission is read with; the tab renders exactly these.
const PERSISTED_KEYS = ["identity", "goal", "tone", "criteria", "guardrails", "dq"] as const;

describe("missionFieldCopy", () => {
  it("gives every persisted field a written name and a line of guidance", () => {
    for (const key of PERSISTED_KEYS) {
      const copy = missionFieldCopy(key);
      // Written as a label a person reads, not echoed back as a column name.
      expect(copy.title).not.toBe(key);
      expect(copy.title).toMatch(/^[A-Z]/u);
      expect(copy.title).not.toMatch(/_/u);
      expect(copy.help.length).toBeGreaterThan(20);
    }
  });

  it("spells out the abbreviation nobody can guess", () => {
    expect(missionFieldCopy("dq").title).toBe("Disqualification rules");
  });

  it("leaves an unwritten field looking unfinished rather than inventing a name", () => {
    expect(missionFieldCopy("not_a_field")).toEqual({ title: "not_a_field", help: "" });
  });

  it("keys the copy by the persisted column name, which stays the storage key", () => {
    expect(Object.keys(MISSION_FIELD_COPY).sort()).toEqual([...PERSISTED_KEYS].sort());
  });
});
