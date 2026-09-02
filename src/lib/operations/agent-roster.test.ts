import { describe, expect, it } from "vitest";

import {
  COACH_OWNED_SETTINGS,
  agentStateFrom,
  buildAgentRoster,
  overrideCount,
  type RawOfferLayer,
  type RawTenant,
} from "./agent-roster";

function tenant(id: string, name = id): RawTenant {
  return { id, name, status: "active" };
}

function layer(over: Partial<RawOfferLayer> & { tenant_id: string; version: number }): RawOfferLayer {
  return {
    status: "draft",
    published_at: null,
    updated_at: null,
    ...over,
  };
}

describe("overrideCount", () => {
  it("counts a column with a value and never counts an absent one", () => {
    expect(overrideCount(layer({ tenant_id: "a", version: 1 }))).toBe(0);
    expect(
      overrideCount(layer({ tenant_id: "a", version: 1, program_name: "Funding Fast Track" })),
    ).toBe(1);
  });

  /**
   * `products` defaults to `'{}'` on every row, so counting an empty array as an override would
   * report the entire platform as having customised a setting nobody touched -- and the
   * inheritance strip would understate what comes from the brain for every client at once.
   */
  it("refuses to read a column's own default as a coach's choice", () => {
    expect(overrideCount(layer({ tenant_id: "a", version: 1, products: [] }))).toBe(0);
    expect(overrideCount(layer({ tenant_id: "a", version: 1, products: ["biz CC"] }))).toBe(1);
    expect(overrideCount(layer({ tenant_id: "a", version: 1, refund_posture: "   " }))).toBe(0);
  });
});

describe("agentStateFrom", () => {
  it("reads no offer layer at all as never published", () => {
    expect(agentStateFrom([])).toMatchObject({
      state: "never-published",
      liveVersion: null,
      unpublishedEdits: 0,
    });
  });

  it("takes the newest published version as the live one, over its superseded history", () => {
    const derived = agentStateFrom([
      layer({ tenant_id: "a", version: 1, status: "superseded", published_at: "2026-08-01T00:00:00.000Z" }),
      layer({ tenant_id: "a", version: 2, status: "published", published_at: "2026-08-20T00:00:00.000Z" }),
    ]);
    expect(derived).toMatchObject({
      state: "live",
      liveVersion: 2,
      publishedAt: "2026-08-20T00:00:00.000Z",
      unpublishedEdits: 0,
    });
  });

  /**
   * The pending count is the whole reason this reads the lineage rather than a flag: a coach with
   * three saved drafts above their live version has three unpublished edits, and an admin deciding
   * whether to chase them needs the number, not a badge.
   */
  it("counts every draft standing above the live version, and none below it", () => {
    const derived = agentStateFrom([
      layer({ tenant_id: "a", version: 1, status: "draft" }),
      layer({ tenant_id: "a", version: 2, status: "published", published_at: "2026-08-20T00:00:00.000Z" }),
      layer({ tenant_id: "a", version: 3, status: "draft", updated_at: "2026-08-25T00:00:00.000Z" }),
      layer({ tenant_id: "a", version: 4, status: "draft", updated_at: "2026-08-28T00:00:00.000Z" }),
    ]);
    expect(derived.unpublishedEdits).toBe(2);
    expect(derived.latestEditAt).toBe("2026-08-28T00:00:00.000Z");
    // The settings the agent answers with are the published ones, not the newest draft.
    expect(derived.settingsRow?.version).toBe(2);
  });
});

describe("buildAgentRoster", () => {
  const tenants = [tenant("a", "Alpha Coaching"), tenant("b", "Boyd Advisory")];

  it("gives every client an agent, including one with no offer layer at all", () => {
    const roster = buildAgentRoster({
      tenants,
      offerLayers: [layer({ tenant_id: "a", version: 1, status: "published", published_at: "x" })],
      openThreads: [],
      brainVersion: 18,
    });
    expect(roster.entries).toHaveLength(2);
    expect(roster.entries.map((entry) => entry.state)).toContain("never-published");
    expect(roster.settingCount).toBe(COACH_OWNED_SETTINGS.length);
  });

  /**
   * A client that has drafted but never published is not the same as one that has never been set
   * up. Collapsing them would send an admin chasing a coach who has already done the work.
   */
  it("tells a drafted agent apart from one that has never been set up", () => {
    const roster = buildAgentRoster({
      tenants,
      offerLayers: [layer({ tenant_id: "a", version: 1, status: "draft" })],
      openThreads: [],
      brainVersion: 18,
    });
    const byId = new Map(roster.entries.map((entry) => [entry.tenantId, entry]));
    expect(byId.get("a")?.state).toBe("draft");
    expect(byId.get("b")?.state).toBe("never-published");
  });

  it("carries a thread count that could not be read as absent rather than as zero", () => {
    const roster = buildAgentRoster({
      tenants,
      offerLayers: [],
      openThreads: null,
      brainVersion: 18,
    });
    expect(roster.threadsUnavailable).toBe(true);
    expect(roster.entries.every((entry) => entry.openThreads === null)).toBe(true);

    const measured = buildAgentRoster({
      tenants,
      offerLayers: [],
      openThreads: [{ tenant_id: "a" }, { tenant_id: "a" }],
      brainVersion: 18,
    });
    const byId = new Map(measured.entries.map((entry) => [entry.tenantId, entry]));
    expect(byId.get("a")?.openThreads).toBe(2);
    // A client with no open thread genuinely has none, which is a measured zero, not an absence.
    expect(byId.get("b")?.openThreads).toBe(0);
  });

  /** Whatever needs a person sorts above whatever does not, the same argument the client book makes. */
  it("leads with the agents that need somebody, not with the busiest", () => {
    const roster = buildAgentRoster({
      tenants: [tenant("live", "Live Co"), tenant("pending", "Pending Co"), tenant("none", "None Co")],
      offerLayers: [
        layer({ tenant_id: "live", version: 1, status: "published", published_at: "x" }),
        layer({ tenant_id: "pending", version: 1, status: "published", published_at: "x" }),
        layer({ tenant_id: "pending", version: 2, status: "draft" }),
      ],
      // The settled live agent is the busiest, and it still may not lead.
      openThreads: [{ tenant_id: "live" }, { tenant_id: "live" }, { tenant_id: "live" }],
      brainVersion: 18,
    });
    expect(roster.entries.map((entry) => entry.tenantId)).toEqual(["none", "pending", "live"]);
  });

  it("keeps a seeded tenant in the roster wearing its label rather than dropping it", () => {
    const roster = buildAgentRoster({
      tenants,
      offerLayers: [],
      openThreads: [],
      brainVersion: 18,
      testTenantIds: new Set(["b"]),
    });
    expect(roster.entries).toHaveLength(2);
    expect(roster.entries.find((entry) => entry.tenantId === "b")?.isTest).toBe(true);
  });
});
