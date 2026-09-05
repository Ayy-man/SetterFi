/**
 * The sole physical messaging-dispatch boundary for Phase 3.
 *
 * Permission, consent, suppression, and persistence happen before this port. Provider selection
 * remains injected so Phase 4 owns adapter implementations and this module owns only dispatch.
 */

import {
  driverSelection,
  requireEnvironment,
  type EnvironmentSource,
} from "@/lib/env-contract";
import {
  GHL_CONFIGURATION_NAMES,
  META_CONFIGURATION_NAMES,
} from "@/lib/integrations/selector";
import { createSimulatedMessagingDriver } from "@/lib/integrations/simulated";
import type {
  ApprovedTemplateCommand,
  AuthorizedOutboundCommand,
  IdentityProvider,
  MessagingDriver,
} from "@/lib/integrations/types";
import type {
  MessagingDispatchInput,
  MessagingDispatchPort,
} from "@/lib/sends/contracts";

export type ProviderDispatchConfiguration =
  | { provider: "ghl"; values: Record<(typeof GHL_CONFIGURATION_NAMES)[number], string> }
  | { provider: "meta_direct"; values: Record<(typeof META_CONFIGURATION_NAMES)[number], string> };

export type ProviderDispatchRoute = {
  provider: IdentityProvider;
  tenantId?: string;
  /**
   * True only for a route the resolver has already authorised as a demo tenant's. The send then
   * goes to the simulated arm regardless of the environment's driver selection, so a demo tenant
   * never reaches a real provider and the production process never fakes a real tenant's send.
   */
  simulated?: boolean;
  approvedTemplate: Omit<ApprovedTemplateCommand, "kind" | "channel" | "recipientExternalId" | "variables"> | null;
  authorizedCommand?: AuthorizedOutboundCommand;
  externalAccountId?: string;
};

export type ProviderDispatchDependencies = {
  resolveRoute(input: MessagingDispatchInput): Promise<ProviderDispatchRoute>;
  createMock(provider: IdentityProvider): MessagingDriver;
  createReal(configuration: ProviderDispatchConfiguration, route: ProviderDispatchRoute): MessagingDriver;
  createSimulated?(provider: IdentityProvider): MessagingDriver;
  /**
   * The same fact `resolveRoute` puts on `route.simulated`, answerable from the tenant alone so
   * the gateway can ask it before a target or content exists. Absent means never simulated.
   */
  simulatedTenant?(tenantId: string): Promise<boolean>;
  environment?: EnvironmentSource;
  now?: () => string;
};

function selectedDriver(
  provider: IdentityProvider,
  route: ProviderDispatchRoute,
  dependencies: ProviderDispatchDependencies,
) {
  const environment = dependencies.environment ?? process.env;
  if (route.simulated) {
    return (dependencies.createSimulated ?? createSimulatedMessagingDriver)(provider);
  }
  if (provider === "ghl") {
    if (driverSelection("ghl", "SETTERFI_GHL_DRIVER", environment) === "mock") {
      return dependencies.createMock(provider);
    }
    return dependencies.createReal({
      provider,
      values: requireEnvironment("ghl", GHL_CONFIGURATION_NAMES, environment),
    }, route);
  }
  if (driverSelection("meta", "SETTERFI_META_DRIVER", environment) === "mock") {
    return dependencies.createMock(provider);
  }
  return dependencies.createReal({
    provider,
    values: requireEnvironment("meta", META_CONFIGURATION_NAMES, environment),
  }, route);
}

function commandFor(
  input: MessagingDispatchInput,
  route: ProviderDispatchRoute,
): AuthorizedOutboundCommand {
  if (route.authorizedCommand) {
    if (route.authorizedCommand.channel !== input.channel ||
      route.authorizedCommand.recipientExternalId !== input.recipientExternalId) {
      throw new Error("PROVIDER_AUTHORIZED_COMMAND_SCOPE_MISMATCH");
    }
    return { ...route.authorizedCommand, idempotencyKey: input.idempotencyKey };
  }
  if (input.content.kind === "freeform") {
    return {
      kind: "freeform",
      channel: input.channel,
      recipientExternalId: input.recipientExternalId,
      idempotencyKey: input.idempotencyKey,
      body: input.content.body,
    };
  }
  if (!route.approvedTemplate) throw new Error("PROVIDER_TEMPLATE_ROUTE_REQUIRED");
  return {
    kind: "approved_template",
    channel: input.channel,
    recipientExternalId: input.recipientExternalId,
    idempotencyKey: input.idempotencyKey,
    ...route.approvedTemplate,
    variables: input.content.variables,
  };
}

export async function dispatchAuthorizedMessagingDriver(
  driver: Pick<MessagingDriver, "send">,
  command: AuthorizedOutboundCommand,
) {
  return driver.send(command);
}

export function createProviderDispatchPort(
  dependencies: ProviderDispatchDependencies,
): MessagingDispatchPort {
  // Once this port has told the gateway a tenant simulates, every send it makes for that tenant
  // stays simulated. The gateway skips the test-recipient allowlist on that answer, so a tenant
  // row that flips to non-demo between the two reads must not hand the send to a real driver.
  const simulatedTenants = new Set<string>();
  return {
    async simulates({ tenantId }) {
      const simulated = (await dependencies.simulatedTenant?.(tenantId)) === true;
      if (simulated) simulatedTenants.add(tenantId);
      return simulated;
    },
    async send(input) {
      const resolved = await dependencies.resolveRoute(input);
      const route = simulatedTenants.has(input.tenantId) ? { ...resolved, simulated: true } : resolved;
      const driver = selectedDriver(route.provider, route, dependencies);
      const receipt = await dispatchAuthorizedMessagingDriver(driver, commandFor(input, route));
      if (!receipt.providerMessageId.trim()) throw new Error("PROVIDER_SEND_RECEIPT_INVALID");
      return {
        providerMessageId: receipt.providerMessageId,
        acceptedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
      };
    },
  };
}
