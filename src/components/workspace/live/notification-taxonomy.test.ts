import { describe, expect, it } from "vitest";

import {
  categoryLabel,
  destinationColumns,
  groupRulesByCategory,
  scopeLabel,
  scopeQualifiers,
} from "@/components/workspace/live/notification-taxonomy";
import type { AlertRuleView } from "@/components/workspace/live/notification-view-models";

function rule(overrides: Partial<AlertRuleView> & { ruleId: string }): AlertRuleView {
  const preference = {
    ruleId: overrides.ruleId,
    event: "appointment.booked",
    scope: "tenant" as const,
    name: "Appointment booked",
    description: "",
    category: "booking",
    audience: "coach",
    defaultDestinations: ["bell" as const],
    defaultEnabled: true,
    destination: "bell" as const,
    enabled: true,
    locked: false,
  };
  return {
    event: "appointment.booked",
    scope: "tenant",
    name: "Appointment booked",
    description: "",
    category: "booking",
    audience: "coach",
    destinations: ["bell"],
    required: false,
    enabled: true,
    bell: preference,
    email: { ...preference, destination: "email", enabled: false },
    ...overrides,
  };
}

describe("category words", () => {
  it("names the categories the migrations actually seed", () => {
    // "channel", singular, is what `alert_rules.category` holds. The account sheet carried an entry
    // for "channels", which matched nothing, so every channel rule fell through to the fallback.
    expect(categoryLabel("channel")).toBe("Channels");
    expect(categoryLabel("onboarding")).toBe("Setup");
    expect(categoryLabel("agent")).toBe("Your setter");
  });

  it("gives a category nobody has named a heading rather than a blank", () => {
    expect(categoryLabel("provider_health")).toBe("Provider health");
    expect(categoryLabel("")).toBe("Other notices");
  });
});

describe("grouping", () => {
  it("follows the order the categories first appear in, not an alphabet", () => {
    const groups = groupRulesByCategory([
      rule({ ruleId: "a", category: "safety" }),
      rule({ ruleId: "b", category: "booking" }),
      rule({ ruleId: "c", category: "safety" }),
    ]);

    expect(groups.map((group) => group.category)).toEqual(["safety", "booking"]);
    expect(groups.map((group) => group.label)).toEqual(["Safety", "Bookings"]);
    expect(groups[0]!.rules.map((entry) => entry.ruleId)).toEqual(["a", "c"]);
  });
});

describe("the scope qualifier", () => {
  /*
   * Three seeded pairs carry one name across both scopes, so the console listed what looked like
   * the same notification twice. They are different rules with different audiences and their own
   * stored preferences, so the answer is to say which is which, not to drop one.
   */
  it("qualifies a name that appears twice, and leaves a unique name alone", () => {
    const qualifiers = scopeQualifiers([
      rule({ ruleId: "platform", name: "Setup waiting on provider", scope: "platform" }),
      rule({ ruleId: "tenant", name: "Setup waiting on provider" }),
      rule({ ruleId: "alone", name: "Appointment booked" }),
    ]);

    expect(qualifiers.get("platform")).toBe("Platform");
    expect(qualifiers.get("tenant")).toBe("Client account");
    expect(qualifiers.get("alone")).toBeNull();
  });

  it("says each scope the way the console says it", () => {
    expect(scopeLabel("platform")).toBe("Platform");
    expect(scopeLabel("tenant")).toBe("Client account");
  });
});

describe("the destination columns", () => {
  /*
   * The column set follows the payload, which is what stops a destination retirement from being a
   * hunt through four separate literals: removing Slack from the store had to be done in the
   * console matrix, the coach list, the export columns and the account sheet.
   */
  it("draws what the payload holds, once each, in the order it arrived", () => {
    const columns = destinationColumns([
      { destination: "email" },
      { destination: "bell" },
      { destination: "email" },
    ]);

    expect(columns).toEqual([
      { destination: "email", label: "Email" },
      { destination: "bell", label: "Bell" },
    ]);
  });

  it("draws nothing when the payload holds nothing", () => {
    expect(destinationColumns([])).toEqual([]);
  });

  it("takes the surface's own words, and falls back for a destination nobody has named", () => {
    expect(destinationColumns([{ destination: "bell" }], { bell: "In the app" }))
      .toEqual([{ destination: "bell", label: "In the app" }]);
    expect(destinationColumns([{ destination: "carrier_pigeon" }]))
      .toEqual([{ destination: "carrier_pigeon", label: "Carrier pigeon" }]);
  });
});
