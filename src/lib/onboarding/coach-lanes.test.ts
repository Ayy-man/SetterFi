import { describe, expect, it } from "vitest";

import type { StepAttempt } from "./contracts";
import {
  createCalendarConnectExecutor,
  createMetaConnectExecutor,
  createOfferLayerExecutor,
  createWhatsappConnectExecutor,
  type CoachConnectionSnapshot,
  type CoachLaneDependencies,
} from "./coach-lanes";

const TENANT = "51000000-0000-4000-8000-000000000001";

function attempt(stepKey: StepAttempt["stepKey"]): StepAttempt {
  return {
    tenantId: TENANT,
    stepKey,
    attemptId: "51000000-0000-4000-8000-000000000099",
    idempotencyKey: `${TENANT}:${stepKey}`,
    isDemo: false,
  };
}

function dependencies(overrides: Partial<CoachLaneDependencies> = {}): CoachLaneDependencies {
  return {
    loadConnections: async () => [],
    resolveMetaConnection: async () => ({
      senderId: "synthetic-sender",
      accessToken: "synthetic-test-token",
      host: "https://graph.facebook.com",
    }),
    whatsappCapability: async () => "enabled",
    loadPrimaryCalendar: async () => null,
    offerReadiness: async () => ({
      published: false,
      programName: null,
      bookingMode: null,
      reviewState: "clear",
      evidenceAt: null,
    }),
    ...overrides,
  };
}

function connection(
  state: CoachConnectionSnapshot["state"],
  channel: CoachConnectionSnapshot["channel"] = "instagram",
): CoachConnectionSnapshot {
  return { connectionId: `connection-${channel}`, channel, state };
}

describe("Meta coach lane", () => {
  it("keeps an OAuth redirect in awaiting_coach until the persisted connection is ready", async () => {
    const executor = createMetaConnectExecutor(dependencies({
      loadConnections: async () => [connection("connecting")],
    }));
    await expect(executor(attempt("meta_connect"))).resolves.toEqual({
      kind: "awaiting_coach",
      code: "meta_connection_action_required",
    });
  });

  it("maps provider review to Meta's clock rather than claiming connection success", async () => {
    const executor = createMetaConnectExecutor(dependencies({
      loadConnections: async () => [connection("pending_review")],
    }));
    await expect(executor(attempt("meta_connect"))).resolves.toEqual({
      kind: "awaiting_provider",
      party: "meta",
      externalRef: { connection_id: "connection-instagram", channel: "instagram" },
    });
  });

  it.each(["ready", "live"] as const)(
    "completes %s only after the merged resolver proves usable credentials",
    async (state) => {
      const resolved: string[] = [];
      const executor = createMetaConnectExecutor(dependencies({
        loadConnections: async () => [connection(state)],
        resolveMetaConnection: async (tenantId, channel) => {
          resolved.push(`${tenantId}:${channel}`);
          return {
            senderId: "synthetic-sender",
            accessToken: "synthetic-test-token",
            host: "https://graph.facebook.com",
          };
        },
      }));
      await expect(executor(attempt("meta_connect"))).resolves.toEqual({
        kind: "done",
        externalRef: { connection_id: "connection-instagram", channel: "instagram" },
      });
      expect(resolved).toEqual([`${TENANT}:instagram`]);
    },
  );

  it("fails with the named Phase 4 prerequisite when its resolver seam is absent", async () => {
    const executor = createMetaConnectExecutor(dependencies({
      loadConnections: async () => [connection("ready")],
      resolveMetaConnection: undefined,
    }));
    await expect(executor(attempt("meta_connect"))).rejects.toThrow(
      /PHASE4_META_CONNECT_SEAM_MISSING/,
    );
  });
});

describe("WhatsApp coach lane", () => {
  it("blocks when Embedded Signup capability is off instead of looking pending", async () => {
    const executor = createWhatsappConnectExecutor(dependencies({
      whatsappCapability: async () => "disabled",
    }));
    await expect(executor(attempt("whatsapp_connect"))).resolves.toMatchObject({
      kind: "blocked",
      code: "WHATSAPP_EMBEDDED_SIGNUP_DISABLED",
    });
  });

  it("maps the weekly-cap queue to platform work", async () => {
    const executor = createWhatsappConnectExecutor(dependencies({
      whatsappCapability: async () => "weekly_cap_queued",
    }));
    await expect(executor(attempt("whatsapp_connect"))).resolves.toEqual({
      kind: "awaiting_platform",
      code: "whatsapp_weekly_cap_queued",
    });
  });

  it("maps submitted phone review to the provider clock", async () => {
    const executor = createWhatsappConnectExecutor(dependencies({
      loadConnections: async () => [connection("pending_review", "whatsapp")],
    }));
    await expect(executor(attempt("whatsapp_connect"))).resolves.toEqual({
      kind: "awaiting_provider",
      party: "meta",
      externalRef: { connection_id: "connection-whatsapp", channel: "whatsapp" },
    });
  });

  it("completes a ready connection through the same Phase 4 resolver", async () => {
    const executor = createWhatsappConnectExecutor(dependencies({
      loadConnections: async () => [connection("ready", "whatsapp")],
    }));
    await expect(executor(attempt("whatsapp_connect"))).resolves.toEqual({
      kind: "done",
      externalRef: { connection_id: "connection-whatsapp", channel: "whatsapp" },
    });
  });
});

describe("calendar and offer coach lanes", () => {
  it("completes calendar connection only from the existing ready row", async () => {
    const missing = createCalendarConnectExecutor(dependencies());
    await expect(missing(attempt("calendar_connect"))).resolves.toEqual({
      kind: "awaiting_coach",
      code: "primary_calendar_connection_required",
    });
    const ready = createCalendarConnectExecutor(dependencies({
      loadPrimaryCalendar: async () => ({ connectionId: "calendar-1", state: "ready" }),
    }));
    await expect(ready(attempt("calendar_connect"))).resolves.toEqual({
      kind: "done",
      externalRef: { calendar_connection_id: "calendar-1" },
    });
  });

  it("keeps incomplete offer fields with the coach and a review hold with the platform", async () => {
    const incomplete = createOfferLayerExecutor(dependencies());
    await expect(incomplete(attempt("offer_layer"))).resolves.toEqual({
      kind: "awaiting_coach",
      code: "offer_required_fields_incomplete",
    });
    const held = createOfferLayerExecutor(dependencies({
      offerReadiness: async () => ({
        published: true,
        programName: "Synthetic program",
        bookingMode: "direct",
        reviewState: "held",
        evidenceAt: "2026-08-17T12:00:00.000Z",
      }),
    }));
    await expect(held(attempt("offer_layer"))).resolves.toEqual({
      kind: "awaiting_platform",
      code: "offer_held",
    });
  });

  it("completes only a published, review-clear offer with both gate fields", async () => {
    const executor = createOfferLayerExecutor(dependencies({
      offerReadiness: async () => ({
        published: true,
        programName: "Synthetic program",
        bookingMode: "direct",
        reviewState: "clear",
        evidenceAt: "2026-08-17T12:00:00.000Z",
      }),
    }));
    await expect(executor(attempt("offer_layer"))).resolves.toEqual({
      kind: "done",
      externalRef: { offer_evidence_at: "2026-08-17T12:00:00.000Z" },
    });
  });
});
