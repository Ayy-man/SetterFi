import { describe, expect, it } from "vitest";

import { a2pRegistrationDay, a2pRegistrationLabel } from "@/lib/onboarding/a2p-clock";

describe("a2pRegistrationDay", () => {
  it("counts the filing day as day 1", () => {
    expect(a2pRegistrationDay("2026-08-15T00:00:00.000Z", Date.parse("2026-08-15T09:00:00.000Z")))
      .toBe(1);
  });

  it("advances one day per elapsed 24 hours", () => {
    expect(a2pRegistrationDay("2026-08-15T00:00:00.000Z", Date.parse("2026-08-17T12:00:00.000Z")))
      .toBe(3);
  });

  it("accepts a Date as readily as an epoch", () => {
    expect(a2pRegistrationDay("2026-08-15T00:00:00.000Z", new Date("2026-08-17T12:00:00.000Z")))
      .toBe(3);
  });

  it("never runs backwards past day 1", () => {
    expect(a2pRegistrationDay("2026-08-20T00:00:00.000Z", Date.parse("2026-08-15T00:00:00.000Z")))
      .toBe(1);
  });

  it("returns null rather than inventing day 1 when nothing is filed or the stamp is junk", () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    expect(a2pRegistrationDay(null, now)).toBeNull();
    expect(a2pRegistrationDay(undefined, now)).toBeNull();
    expect(a2pRegistrationDay("", now)).toBeNull();
    expect(a2pRegistrationDay("not-a-date", now)).toBeNull();
  });
});

describe("a2pRegistrationLabel", () => {
  it("shows the day when there is one and says so plainly when there is not", () => {
    expect(a2pRegistrationLabel(3)).toBe("Registering · day 3");
    expect(a2pRegistrationLabel(null)).toBe("Registering · carrier review takes 2–3 weeks");
  });

  it("never shows a percentage or a predicted completion date", () => {
    for (const day of [null, 1, 21, 40]) {
      expect(a2pRegistrationLabel(day)).not.toMatch(/%|complete by|estimated|by \d/i);
    }
  });
});
