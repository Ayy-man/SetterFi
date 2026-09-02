import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createResendWebhookHandler, type VerifiedResendEvent } from "./handler";

const NOW = new Date("2026-08-18T12:00:00.000Z");
const KEY = Buffer.from("synthetic-resend-key");
const SECRET = `whsec_${KEY.toString("base64")}`;
const EVENT_ID = "msg_synthetic";

function body(type = "email.delivered") {
  return JSON.stringify({ type, created_at: NOW.toISOString(), data: { email_id: "email_synthetic" } });
}

function signature(raw: string, timestamp: number, id = EVENT_ID) {
  return createHmac("sha256", KEY).update(`${id}.${timestamp}.${raw}`).digest("base64");
}

function request(options: { raw?: string; timestamp?: number; signature?: string; id?: string } = {}) {
  const raw = options.raw ?? body();
  const timestamp = options.timestamp ?? Math.floor(NOW.getTime() / 1_000);
  const id = options.id ?? EVENT_ID;
  return new Request("http://local/api/webhooks/resend", {
    method: "POST", body: raw, headers: {
      "svix-id": id,
      "svix-timestamp": String(timestamp),
      "svix-signature": options.signature ?? `v1,${signature(raw, timestamp, id)}`,
    },
  });
}

function setup(overrides: Partial<Parameters<typeof createResendWebhookHandler>[0]> = {}) {
  const persist = vi.fn<(event: VerifiedResendEvent) => Promise<{ inserted: true; status: "received" }>>(
    async () => ({ inserted: true, status: "received" }),
  );
  const apply = vi.fn<(event: VerifiedResendEvent) => Promise<void>>(async () => undefined);
  const handler = createResendWebhookHandler({
    enabled: () => true, signingSecret: SECRET, now: () => NOW, persist, apply, ...overrides,
  });
  return { handler, persist, apply };
}

describe("Resend webhook", () => {
  it("rejects missing credentials before reading, parsing, or persisting", async () => {
    const values = setup({ signingSecret: null });
    const arrayBuffer = vi.fn();
    const response = await values.handler({ headers: new Headers(), arrayBuffer } as unknown as Request);
    expect(response.status).toBe(401);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(values.persist).not.toHaveBeenCalled();
  });

  it("verifies exact raw bytes and accepts a valid v1 among multiple signatures", async () => {
    const raw = body();
    const timestamp = Math.floor(NOW.getTime() / 1_000);
    const values = setup();
    const response = await values.handler(request({
      raw, timestamp, signature: `v1,${Buffer.alloc(32).toString("base64")} v2,ignored v1,${signature(raw, timestamp)}`,
    }));
    expect(response.status).toBe(200);
    expect(values.persist).toHaveBeenCalledTimes(1);
    expect(values.apply).toHaveBeenCalledTimes(1);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([-300, 300])("accepts the explicit %i-second boundary", async (offset) => {
    const timestamp = Math.floor(NOW.getTime() / 1_000) + offset;
    expect((await setup().handler(request({ timestamp }))).status).toBe(200);
  });

  it.each([-301, 301])("rejects %i seconds outside tolerance without persistence", async (offset) => {
    const values = setup();
    const timestamp = Math.floor(NOW.getTime() / 1_000) + offset;
    expect((await values.handler(request({ timestamp }))).status).toBe(401);
    expect(values.persist).not.toHaveBeenCalled();
  });

  it("rejects forged and raw-mutated signatures without persistence", async () => {
    const original = body();
    const timestamp = Math.floor(NOW.getTime() / 1_000);
    for (const candidate of [
      request({ raw: `${original} `, signature: `v1,${signature(original, timestamp)}` }),
      request({ raw: original, signature: `v1,${Buffer.alloc(32).toString("base64")}` }),
    ]) {
      const values = setup();
      expect((await values.handler(candidate)).status).toBe(401);
      expect(values.persist).not.toHaveBeenCalled();
    }
  });

  it.each(["email.delivered", "email.bounced", "email.complained", "email.failed"])(
    "persists and applies signed %s by provider reference",
    async (type) => {
      const values = setup();
      expect((await values.handler(request({ raw: body(type) }))).status).toBe(200);
      expect(values.apply).toHaveBeenCalledWith(expect.objectContaining({ eventType: type, providerReference: "email_synthetic" }));
    },
  );

  it("returns 200 for a valid duplicate and applies it exactly once", async () => {
    let processed = false;
    const persist = vi.fn(async () => processed
      ? { inserted: false, status: "processed" as const }
      : { inserted: true, status: "received" as const });
    const apply = vi.fn(async () => { processed = true; });
    const values = setup({ persist, apply });
    const first = await values.handler(request());
    const second = await values.handler(request());
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("rejects signed malformed JSON only after verification and persists nothing", async () => {
    const values = setup();
    expect((await values.handler(request({ raw: "{" }))).status).toBe(400);
    expect(values.persist).not.toHaveBeenCalled();
  });
});
