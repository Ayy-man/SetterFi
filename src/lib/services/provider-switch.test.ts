import { describe, expect, it } from "vitest";

import {
  switchChannelProvider,
  type ProviderSwitchDependencies,
  type ProviderSwitchSnapshot,
} from "@/lib/services/provider-switch";

function initialSnapshot(): ProviderSwitchSnapshot {
  return {
    connections: [
      {
        id: "connection-outgoing",
        tenantId: "tenant-a",
        channel: "instagram",
        provider: "ghl",
        state: "live",
      },
      {
        id: "connection-incoming",
        tenantId: "tenant-a",
        channel: "instagram",
        provider: "meta_direct",
        state: "ready",
      },
    ],
    openConversations: [
      { id: "conversation-a", tenantId: "tenant-a", contactId: "contact-a", messageCount: 4 },
      { id: "conversation-b", tenantId: "tenant-a", contactId: "contact-b", messageCount: 7 },
    ],
    identities: [
      {
        tenantId: "tenant-a",
        contactId: "contact-a",
        provider: "ghl",
        externalId: "outgoing-a",
      },
      {
        tenantId: "tenant-a",
        contactId: "contact-b",
        provider: "ghl",
        externalId: "outgoing-b",
      },
    ],
  };
}

const completeBackfill = [
  { outgoingExternalId: "outgoing-a", incomingExternalId: "incoming-a", contactId: "contact-a" },
  { outgoingExternalId: "outgoing-b", incomingExternalId: "incoming-b", contactId: "contact-b" },
];

const input = {
  expectedTenantId: "tenant-a",
  channel: "instagram" as const,
  outgoingConnectionId: "connection-outgoing",
  incomingConnectionId: "connection-incoming",
  backfill: completeBackfill,
  actorUserId: "actor-a",
  reason: "Move the synthetic channel to its verified connection",
  idempotencyKey: "switch-a",
};

function dependencies() {
  let snapshot = structuredClone(initialSnapshot());
  let calls = 0;
  const deps: ProviderSwitchDependencies = {
    switchProvider: async () => {
      calls += 1;
      snapshot = {
        ...snapshot,
        connections: snapshot.connections.map((connection) => ({
          ...connection,
          state: connection.id === "connection-outgoing" ? "disconnected" : "live",
        })),
        identities: [
          ...snapshot.identities,
          ...completeBackfill.map((item) => ({
            tenantId: "tenant-a",
            contactId: item.contactId,
            provider: "meta_direct" as const,
            externalId: item.incomingExternalId,
          })),
        ],
      };
      return { state: "live", applied_identity_count: 2, audit_id: 71 };
    },
    loadSnapshot: async () => structuredClone(snapshot),
    loadAudit: async () => ({
      id: 71,
      tenantId: "tenant-a",
      action: "channel.provider.switched",
      targetId: "connection-incoming",
    }),
  };
  return { deps, snapshot: () => structuredClone(snapshot), calls: () => calls };
}

describe("switchChannelProvider", () => {
  it("blocks an incomplete open-conversation mapping before the atomic RPC changes state", async () => {
    const state = dependencies();
    const before = state.snapshot();
    await expect(
      switchChannelProvider({ ...input, backfill: completeBackfill.slice(0, 1) }, state.deps),
    ).rejects.toMatchObject({ code: "IDENTITY_BACKFILL_REQUIRED" });
    expect(state.calls()).toBe(0);
    expect(state.snapshot()).toEqual(before);
  });

  it("reads back one live connection, complete incoming identities, and unchanged conversations", async () => {
    const state = dependencies();
    const result = await switchChannelProvider(input, state.deps);
    expect(result).toEqual({
      state: "live",
      appliedIdentityCount: 2,
      auditId: 71,
      outgoingConnectionId: "connection-outgoing",
      incomingConnectionId: "connection-incoming",
    });
    const after = state.snapshot();
    expect(after.connections.filter((connection) => connection.state === "live"))
      .toHaveLength(1);
    expect(after.openConversations).toEqual(initialSnapshot().openConversations);
    expect(after.identities.filter((identity) => identity.provider === "meta_direct"))
      .toMatchObject([
        { contactId: "contact-a", externalId: "incoming-a" },
        { contactId: "contact-b", externalId: "incoming-b" },
      ]);
  });

  it("returns a stable idempotency code without contact identifiers or provider payload text", async () => {
    const state = dependencies();
    state.deps.switchProvider = async () => {
      throw new Error("IDEMPOTENCY_PAYLOAD_MISMATCH contact-a sensitive-value");
    };
    const error = await switchChannelProvider(input, state.deps).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect((error as Error).message).toBe("IDEMPOTENCY_PAYLOAD_MISMATCH");
  });

  it("rejects cross-tenant readback before making a provider switch call", async () => {
    const state = dependencies();
    state.deps.loadSnapshot = async () => ({
      ...initialSnapshot(),
      openConversations: [
        { id: "conversation-x", tenantId: "tenant-b", contactId: "contact-x", messageCount: 1 },
      ],
    });
    await expect(switchChannelProvider(input, state.deps)).rejects.toMatchObject({
      code: "PROVIDER_SWITCH_SCOPE_MISMATCH",
    });
    expect(state.calls()).toBe(0);
  });
});
