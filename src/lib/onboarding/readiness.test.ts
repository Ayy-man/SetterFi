import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { READINESS_KEYS, type OfferReadinessResult, type SubscriptionReadinessResult } from "./contracts";
import {
  MAX_READINESS_EVIDENCE_AGE_MS,
  commitGoLive,
  createDemoSubscriptionReadinessPort,
  evaluateReadiness,
  type CalendarReadinessEvidence,
  type MessagingReadinessEvidence,
  type ReadinessDependencies,
  type ReadinessRepository,
  type TenantReadinessEvidence,
  type TestPassReadinessEvidence,
} from "./readiness";

const TENANT = "51000000-0000-4000-8000-000000000001";
const ACTOR = "51000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-08-17T12:00:00.000Z");
const RECENT = new Date(NOW.getTime() - 60_000).toISOString();

type Fixture = {
  tenant: TenantReadinessEvidence | null;
  connections: readonly MessagingReadinessEvidence[];
  calendar: CalendarReadinessEvidence | null;
  offer: OfferReadinessResult;
  brainEvidenceAt: string | null;
  testPass: TestPassReadinessEvidence | null;
  subscription: SubscriptionReadinessResult;
  demoSubscription: SubscriptionReadinessResult;
};

const BASE: Fixture = {
  tenant: { status: "onboarding", isDemo: false, evidenceAt: RECENT },
  connections: [{ channel: "instagram", state: "live", evidenceAt: RECENT }],
  calendar: { state: "ready", lastSlotFetchOk: true, lastSlotFetchAt: RECENT },
  offer: {
    published: true,
    programName: "Synthetic program",
    bookingMode: "direct",
    reviewState: "clear",
    evidenceAt: RECENT,
  },
  brainEvidenceAt: RECENT,
  testPass: { state: "done", completedAt: RECENT },
  subscription: { state: "active", evidenceAt: RECENT, isDemo: false },
  demoSubscription: { state: "trialing", evidenceAt: RECENT, isDemo: true },
};

function dependencies(
  fixtureOverrides: Partial<Fixture> = {},
  options: {
    goLive?: ReadinessRepository["goLive"];
    repositoryOverrides?: Partial<ReadinessRepository>;
    subscriptionReadiness?: ReadinessDependencies["subscriptionReadiness"];
    demoSubscriptionReadiness?: ReadinessDependencies["demoSubscriptionReadiness"];
  } = {},
) {
  const fixture = { ...BASE, ...fixtureOverrides };
  let goLiveCalls = 0;
  const repository: ReadinessRepository = {
    loadTenant: async () => fixture.tenant,
    loadMessagingConnections: async () => fixture.connections,
    loadPrimaryCalendar: async () => fixture.calendar,
    loadPublishedBrainEvidence: async () => fixture.brainEvidenceAt,
    loadTestPass: async () => fixture.testPass,
    goLive: async (input) => {
      goLiveCalls += 1;
      if (options.goLive) return options.goLive(input);
      return { tenantId: input.tenantId, auditId: "9001", wentLiveAt: NOW.toISOString() };
    },
    ...options.repositoryOverrides,
  };
  return {
    dependencies: {
      repository,
      offerReadiness: async () => fixture.offer,
      subscriptionReadiness: options.subscriptionReadiness
        ?? (async () => fixture.subscription),
      demoSubscriptionReadiness: options.demoSubscriptionReadiness
        ?? (async () => fixture.demoSubscription),
      now: () => NOW,
    } satisfies ReadinessDependencies,
    goLiveCalls: () => goLiveCalls,
  };
}

describe("seven-condition readiness", () => {
  it("always returns the exact closed seven-key contract in order", async () => {
    const test = dependencies();
    const result = await evaluateReadiness(TENANT, test.dependencies);
    expect(result.ready).toBe(true);
    expect(result.checks.map((candidate) => candidate.key)).toEqual(READINESS_KEYS);
    expect(result.checks).toHaveLength(7);
  });

  it.each([
    {
      name: "tenant eligibility",
      overrides: { tenant: { ...BASE.tenant!, status: "suspended" as const } },
      key: "tenant_active",
      code: "tenant_not_eligible",
      party: "platform",
    },
    {
      name: "messaging channel",
      overrides: { connections: [] },
      key: "messaging_channel_live",
      code: "messaging_channel_required",
      party: "coach",
    },
    {
      name: "calendar health",
      overrides: { calendar: { ...BASE.calendar!, lastSlotFetchOk: false } },
      key: "primary_calendar_healthy",
      code: "primary_calendar_unhealthy",
      party: "coach",
    },
    {
      name: "published offer",
      overrides: { offer: { ...BASE.offer, programName: null } },
      key: "published_offer_ready",
      code: "published_offer_incomplete",
      party: "coach",
    },
    {
      name: "platform Brain",
      overrides: { brainEvidenceAt: null },
      key: "platform_brain_published",
      code: "platform_brain_publish_pending",
      party: "platform",
    },
    {
      name: "test pass",
      overrides: { testPass: { state: "pending", completedAt: null } },
      key: "test_passed",
      code: "test_pass_required",
      party: "coach",
    },
    {
      name: "subscription",
      overrides: { subscription: { state: "incomplete", evidenceAt: RECENT, isDemo: false } },
      key: "subscription_ready",
      code: "subscription_incomplete",
      party: "coach",
    },
  ] as const)("names $name refusal without collapsing the other checks", async (testCase) => {
    const test = dependencies(testCase.overrides);
    const result = await evaluateReadiness(TENANT, test.dependencies);
    const failed = result.checks.find((candidate) => candidate.key === testCase.key)!;
    expect(result.ready).toBe(false);
    expect(failed).toMatchObject({
      ready: false,
      code: testCase.code,
      blamingParty: testCase.party,
    });
    expect(result.checks).toHaveLength(7);
  });

  it("uses the T6-19 and T6-20 platform-owned copy keys", async () => {
    const brain = await evaluateReadiness(
      TENANT,
      dependencies({ brainEvidenceAt: null }).dependencies,
    );
    expect(brain.checks.find((candidate) => candidate.key === "platform_brain_published"))
      .toMatchObject({ code: "platform_brain_publish_pending", blamingParty: "platform" });

    const offer = await evaluateReadiness(TENANT, dependencies({
      offer: { ...BASE.offer, reviewState: "held" },
    }).dependencies);
    expect(offer.checks.find((candidate) => candidate.key === "published_offer_ready"))
      .toMatchObject({ code: "offer_held", blamingParty: "platform" });
  });

  it("distinguishes stale calendar evidence from unhealthy connection state", async () => {
    const staleAt = new Date(NOW.getTime() - MAX_READINESS_EVIDENCE_AGE_MS - 1).toISOString();
    const result = await evaluateReadiness(TENANT, dependencies({
      calendar: { ...BASE.calendar!, lastSlotFetchAt: staleAt },
    }).dependencies);
    expect(result.checks.find((candidate) => candidate.key === "primary_calendar_healthy"))
      .toMatchObject({ ready: false, code: "primary_calendar_stale" });
  });

  it("keeps a clear immutable offer revision valid after the live-evidence window", async () => {
    const reviewedAt = new Date(NOW.getTime() - MAX_READINESS_EVIDENCE_AGE_MS - 1).toISOString();
    const result = await evaluateReadiness(TENANT, dependencies({
      offer: { ...BASE.offer, evidenceAt: reviewedAt },
    }).dependencies);
    expect(result.checks.find((candidate) => candidate.key === "published_offer_ready"))
      .toMatchObject({ ready: true, code: "published_offer_ready", evidenceAt: reviewedAt });
  });

  it("fails closed with the Phase 6 seam absent instead of inferring from a Stripe id", async () => {
    const test = dependencies({}, { subscriptionReadiness: undefined });
    const withoutPhase6: ReadinessDependencies = {
      ...test.dependencies,
      subscriptionReadiness: undefined,
    };
    const result = await evaluateReadiness(TENANT, withoutPhase6);
    expect(result.checks.find((candidate) => candidate.key === "subscription_ready"))
      .toMatchObject({
        ready: false,
        code: "subscription_contract_unavailable",
        blamingParty: "platform",
      });
  });

  it("still returns seven fail-closed checks when a source adapter throws", async () => {
    const test = dependencies({}, {
      repositoryOverrides: {
        loadMessagingConnections: async () => {
          throw new Error("synthetic read failure");
        },
      },
    });
    const result = await evaluateReadiness(TENANT, test.dependencies);
    expect(result.checks).toHaveLength(7);
    expect(result.checks.find((candidate) => candidate.key === "messaging_channel_live"))
      .toMatchObject({
        ready: false,
        code: "messaging_readiness_unavailable",
        blamingParty: "platform",
      });
  });
});

describe("channel and demo readiness semantics", () => {
  it("lets live Meta satisfy messaging while SMS remains permanently blocked", async () => {
    const result = await evaluateReadiness(TENANT, dependencies({
      connections: [
        { channel: "instagram", state: "live", evidenceAt: RECENT },
        { channel: "sms", state: "blocked_permanent", evidenceAt: RECENT },
      ],
    }).dependencies);
    expect(result.checks.find((candidate) => candidate.key === "messaging_channel_live"))
      .toMatchObject({ ready: true, code: "messaging_channel_live" });
  });

  it("lets live SMS satisfy the same condition with Meta absent and adds no eighth predicate", async () => {
    const result = await evaluateReadiness(TENANT, dependencies({
      connections: [{ channel: "sms", state: "live", evidenceAt: RECENT }],
    }).dependencies);
    expect(result.ready).toBe(true);
    expect(result.checks).toHaveLength(7);
    expect(result.checks.find((candidate) => candidate.key === "messaging_channel_live")?.ready)
      .toBe(true);
  });

  it("forces a demo tenant through labelled demo subscription evidence", async () => {
    let realCalls = 0;
    let demoCalls = 0;
    const test = dependencies({
      tenant: { ...BASE.tenant!, isDemo: true },
    }, {
      subscriptionReadiness: async () => {
        realCalls += 1;
        return BASE.subscription;
      },
      demoSubscriptionReadiness: async () => {
        demoCalls += 1;
        return BASE.demoSubscription;
      },
    });
    const result = await evaluateReadiness(TENANT, test.dependencies);
    expect(result.ready).toBe(true);
    expect(realCalls).toBe(0);
    expect(demoCalls).toBe(1);
  });

  it("provides an explicit labelled demo adapter", async () => {
    const adapter = createDemoSubscriptionReadinessPort(() => NOW);
    await expect(adapter(TENANT)).resolves.toEqual({
      state: "trialing",
      evidenceAt: NOW.toISOString(),
      isDemo: true,
    });
  });
});

describe("transactional go-live", () => {
  it("does not call the mutation RPC while any named check is refused", async () => {
    const test = dependencies({ connections: [] });
    const result = await commitGoLive({ tenantId: TENANT, actorId: ACTOR }, test.dependencies);
    expect(result).toMatchObject({ kind: "refused", code: "messaging_channel_required" });
    expect(test.goLiveCalls()).toBe(0);
  });

  it("passes current external evidence to the RPC and requires its persisted audit receipt", async () => {
    let input: Parameters<ReadinessRepository["goLive"]>[0] | null = null;
    const test = dependencies({}, {
      goLive: async (candidate) => {
        input = candidate;
        return { tenantId: TENANT, auditId: "9001", wentLiveAt: NOW.toISOString() };
      },
    });
    const result = await commitGoLive({ tenantId: TENANT, actorId: ACTOR }, test.dependencies);
    expect(result).toEqual({
      kind: "live",
      readiness: expect.objectContaining({ ready: true }),
      receipt: { tenantId: TENANT, auditId: "9001", wentLiveAt: NOW.toISOString() },
    });
    expect(input).toEqual({
      tenantId: TENANT,
      actorId: ACTOR,
      offerReviewClear: true,
      offerReviewEvidenceAt: RECENT,
      subscriptionState: "active",
      subscriptionEvidenceAt: RECENT,
    });
  });

  it("returns the database's stale-client refusal when a channel changes after preflight", async () => {
    const test = dependencies({}, {
      goLive: async () => {
        throw new Error("READINESS_MESSAGING_CHANNEL_LIVE_REQUIRED");
      },
    });
    const result = await commitGoLive({ tenantId: TENANT, actorId: ACTOR }, test.dependencies);
    expect(result).toMatchObject({
      kind: "refused",
      code: "READINESS_MESSAGING_CHANNEL_LIVE_REQUIRED",
      readiness: { ready: true },
    });
  });

  it("rejects an RPC success shape without the tenant.went_live audit receipt", async () => {
    const test = dependencies({}, {
      goLive: async () => ({ tenantId: TENANT, auditId: "", wentLiveAt: NOW.toISOString() }),
    });
    await expect(commitGoLive({ tenantId: TENANT, actorId: ACTOR }, test.dependencies))
      .rejects.toThrow(/GO_LIVE_AUDIT_RECEIPT_REQUIRED/);
  });
});

describe("live readiness repository column shapes", () => {
  const source = readFileSync(new URL("./readiness.ts", import.meta.url), "utf8");

  it("reads the brain snapshot stamp by the column the table actually has", () => {
    // The stubbed repository above cannot catch a wrong column name, and `settled()` swallows the
    // PostgREST error, so a typo here degrades silently into a permanently unavailable check.
    const brain = readFileSync(
      new URL("../../../supabase/migrations/20260818000001_phase2_brain.sql", import.meta.url),
      "utf8",
    );
    const table = brain.slice(brain.indexOf("create table public.brain_snapshots"));
    expect(table.slice(0, table.indexOf(");"))).toContain("published_at");
    expect(source).toContain('.select("published_at")');
    expect(source).not.toContain('.from("brain_snapshots")\n        .select("created_at")');
  });

  it("requires the exact live channel state the readiness check tests for", () => {
    expect(source).toContain('connection.state === "live"');
  });
});
