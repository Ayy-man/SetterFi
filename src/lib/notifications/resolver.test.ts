import { describe, expect, it, vi } from "vitest";

import { createMockEmailDriver } from "@/lib/integrations/email/mock";
import { createRealEmailDriver } from "@/lib/integrations/email/real";
import {
  EMITTED_ALERT_RULE_BINDING_COUNT,
  EMITTED_ALERT_RULE_BINDINGS,
} from "@/lib/notifications/source-contract";

import {
  resolveAlertDestinations,
  type AlertDestinationRepository,
  type AlertDestinationRule,
  type AlertPreference,
} from "./resolver";

const tenantUser = { id: "coach-1", tenantId: "tenant-1", email: "coach@example.test" };
const platformUser = { id: "admin-1", tenantId: null, email: "admin@example.test" };

function harness(input: {
  billingContactEmail?: string | null;
  billingUser?: typeof tenantUser | null;
  preferences?: AlertPreference[];
} = {}) {
  const repository: AlertDestinationRepository = {
    listAudienceUsers: async ({ tenantId }) => tenantId === null ? [platformUser] : [tenantUser],
    getTenantRouting: async () => ({
      successOwnerId: null,
      billingContactEmail: input.billingContactEmail ?? null,
    }),
    getUser: async () => null,
    findTenantUserByEmail: async () => input.billingUser ?? null,
    listPreferences: async () => input.preferences ?? [],
  };
  return repository;
}

function rule(overrides: Partial<AlertDestinationRule> = {}): AlertDestinationRule {
  return {
    id: "rule-1",
    scope: "tenant",
    audienceRoles: ["coach"],
    includeSuccessOwner: false,
    includeBillingContact: false,
    defaultDestinations: ["bell", "email"],
    suppressible: true,
    ...overrides,
  };
}

describe("resolveAlertDestinations", () => {
  it("resolves every emitted scoped binding through the derived owner-array catalog", async () => {
    const resolved = await Promise.all(EMITTED_ALERT_RULE_BINDINGS.map(async (binding) => {
      const recipients = await resolveAlertDestinations(rule({ scope: binding.scope }), {
        tenantId: binding.scope === "tenant" ? "tenant-1" : null,
        isTest: false,
      }, harness());
      return { binding, recipients };
    }));

    expect(resolved).toHaveLength(EMITTED_ALERT_RULE_BINDING_COUNT);
    expect(resolved.every(({ recipients }) =>
      recipients.length === 1
      && recipients[0].destinations.join(",") === "bell,email")).toBe(true);
  });

  it("keeps platform and tenant rows distinct for dual-scope compliance events", async () => {
    const scoped = EMITTED_ALERT_RULE_BINDINGS.filter(({ eventKey }) =>
      eventKey === "conversation.tripwire_escalated"
      || eventKey === "suppression.provider_unconfirmed");

    expect(scoped.map(({ eventKey, scope }) => `${eventKey}:${scope}`)).toEqual([
      "conversation.tripwire_escalated:platform",
      "conversation.tripwire_escalated:tenant",
      "suppression.provider_unconfirmed:platform",
      "suppression.provider_unconfirmed:tenant",
    ]);
  });

  it("persists a nonsuppressible billing contact email without inventing a user", async () => {
    const recipients = await resolveAlertDestinations(rule({
      includeBillingContact: true,
      suppressible: false,
    }), { tenantId: "tenant-1", isTest: false }, harness({
      billingContactEmail: "billing@example.test",
      preferences: [
        { userId: tenantUser.id, destination: "bell", enabled: false },
        { userId: tenantUser.id, destination: "email", enabled: false },
      ],
    }));

    expect(recipients).toEqual([
      {
        userId: tenantUser.id,
        recipientEmail: tenantUser.email,
        destinations: ["bell", "email"],
      },
      {
        userId: null,
        recipientEmail: "billing@example.test",
        destinations: ["email"],
      },
    ]);
  });

  it("applies suppressible preferences per user without muting another recipient", async () => {
    const recipients = await resolveAlertDestinations(rule(), {
      tenantId: "tenant-1",
      isTest: false,
    }, harness({
      preferences: [{ userId: tenantUser.id, destination: "email", enabled: false }],
    }));

    expect(recipients[0].destinations).toEqual(["bell"]);
  });

  it("turns a tenant test fact into a labelled-bell destination with zero outbound intent", async () => {
    const recipients = await resolveAlertDestinations(rule(), {
      tenantId: "tenant-1",
      isTest: true,
    }, harness());

    expect(recipients).toEqual([{
      userId: tenantUser.id,
      recipientEmail: tenantUser.email,
      destinations: ["bell"],
    }]);
    expect(recipients.flatMap((recipient) => recipient.destinations))
      .not.toEqual(expect.arrayContaining(["email"]));
  });

  it("suppresses a test fact at platform scope instead of paging platform staff", async () => {
    await expect(resolveAlertDestinations(rule({ scope: "platform" }), {
      tenantId: "tenant-1",
      isTest: true,
    }, harness())).resolves.toEqual([]);
  });

  it("keeps the seeded placeholder copy inspectable in mock and refused before real I/O", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const emailInput = {
      deliveryId: "delivery-1",
      attemptNumber: 1,
      to: "synthetic@example.test",
      from: "alerts@example.test",
      subject: "SETTERFI_DEMO_PLACEHOLDER_EMAIL_SUBJECT_APPOINTMENT_BOOKED",
      text: "SETTERFI_DEMO_PLACEHOLDER_EMAIL_BODY_APPOINTMENT_BOOKED",
    };
    const mockEmail = createMockEmailDriver();

    await mockEmail.deliverEmail(emailInput);
    expect(mockEmail.records[0].placeholderCopy).toBe(true);
    await expect(createRealEmailDriver({
      apiKey: "synthetic-key",
      from: emailInput.from,
    }, { fetch: fetcher }).deliverEmail(emailInput)).resolves.toMatchObject({
      kind: "terminal",
      errorCode: "ALERT_COPY_UNAPPROVED",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
