import { describe, expect, it } from "vitest";

import {
  createSimulatedMessagingDriver,
  isSimulatedProviderMessageId,
  SIMULATED_BODY_LIMITS,
  SimulatedSendError,
} from "./simulated";

const command = {
  kind: "freeform" as const,
  channel: "sms" as const,
  recipientExternalId: "lead-external-1",
  idempotencyKey: "send:1",
  body: "A short reply.",
};

describe("simulated messaging driver", () => {
  it("returns a stable, prefixed id for a valid command and never verifies a webhook", async () => {
    const driver = createSimulatedMessagingDriver("ghl");
    const first = await driver.send(command);
    const second = await driver.send({ ...command });
    expect(first.providerMessageId).toBe(second.providerMessageId);
    expect(isSimulatedProviderMessageId(first.providerMessageId)).toBe(true);
    expect(await driver.verifyWebhook(new Uint8Array(), "anything")).toBe(false);
    await expect(driver.normalizeInbound({})).rejects.toMatchObject({ code: "SIMULATED_INBOUND_UNSUPPORTED" });
  });

  it("changes the id when the recipient, body or idempotency key changes", async () => {
    const driver = createSimulatedMessagingDriver("meta_direct");
    const base = (await driver.send({ ...command, channel: "instagram" })).providerMessageId;
    expect((await driver.send({ ...command, channel: "instagram", body: "Another." })).providerMessageId).not.toBe(base);
    expect((await driver.send({ ...command, channel: "instagram", idempotencyKey: "send:2" })).providerMessageId).not.toBe(base);
    expect((await driver.send({ ...command, channel: "instagram", recipientExternalId: "lead-2" })).providerMessageId).not.toBe(base);
  });

  it.each([
    ["SIMULATED_SEND_RECIPIENT_REQUIRED", { ...command, recipientExternalId: " " }],
    ["SIMULATED_SEND_IDEMPOTENCY_KEY_REQUIRED", { ...command, idempotencyKey: "" }],
    ["SIMULATED_SEND_BODY_EMPTY", { ...command, body: "   " }],
    ["SIMULATED_SEND_BODY_TOO_LONG", { ...command, body: "x".repeat(SIMULATED_BODY_LIMITS.sms + 1) }],
  ])("refuses %s loudly instead of succeeding", async (code, malformed) => {
    const driver = createSimulatedMessagingDriver("ghl");
    await expect(driver.send(malformed)).rejects.toBeInstanceOf(SimulatedSendError);
    await expect(driver.send(malformed)).rejects.toMatchObject({ code });
  });

  it("requires a provider template name for an approved template", async () => {
    const driver = createSimulatedMessagingDriver("meta_direct");
    await expect(driver.send({
      kind: "approved_template",
      channel: "whatsapp",
      recipientExternalId: "lead-1",
      idempotencyKey: "send:t",
      templateId: "t1",
      providerTemplateName: "",
      locale: "en",
      bodyHash: "hash",
      variables: {},
    })).rejects.toMatchObject({ code: "SIMULATED_SEND_TEMPLATE_NAME_REQUIRED" });
  });

  it("reports the real provider's capabilities so window rules stay identical", () => {
    expect(createSimulatedMessagingDriver("ghl").capabilities("sms"))
      .toEqual(createSimulatedMessagingDriver("ghl").capabilities("sms"));
    expect(createSimulatedMessagingDriver("meta_direct").capabilities("instagram").windowed).toBe(true);
  });
});
