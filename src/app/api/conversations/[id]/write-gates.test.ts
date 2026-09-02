import { describe, expect, it } from "vitest";

import { createClaimHandler } from "./claim/handler";
import { createHumanMessageHandler } from "./messages/handler";
import { createReleaseHandler } from "./release/handler";

const actor = {
  userId: "coach-a",
  tenantId: "tenant-a",
  role: "coach" as const,
  impersonatingTenant: null,
  impersonationSessionId: null,
};

const context = { params: Promise.resolve({ id: "conversation-a" }) };
const post = (body: unknown) => new Request("https://setterfi.test/api/conversations/conversation-a", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("conversation write rollout gates", () => {
  it("refuses every coach write with an honest rollout reason while the inbox flag is off", async () => {
    const disabled = () => false;
    const claim = createClaimHandler({
      enabled: disabled,
      session: async () => actor,
      claim: async () => { throw new Error("UNREACHABLE"); },
      loadConversation: async () => { throw new Error("UNREACHABLE"); },
    });
    const message = createHumanMessageHandler({
      enabled: disabled,
      session: async () => actor,
      write: async () => { throw new Error("UNREACHABLE"); },
      sendReply: async () => { throw new Error("UNREACHABLE"); },
      loadConversation: async () => { throw new Error("UNREACHABLE"); },
    });
    const release = createReleaseHandler({
      enabled: disabled,
      session: async () => actor,
      release: async () => { throw new Error("UNREACHABLE"); },
      loadConversation: async () => { throw new Error("UNREACHABLE"); },
    });

    const responses = await Promise.all([
      claim(post({ expectedState: "agent", expectedHolderId: null, confirmDisplace: false }), context),
      message(post({ kind: "reply", body: "Hello", expectedState: "human" }), context),
      release(post({ expectedHolderId: actor.userId }), context),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        code: "INBOX_VERBS_DISABLED",
        message: "Conversation actions are disabled until the controlled inbox rollout is enabled.",
      });
    }
  });

  it("keeps a cross-tenant refusal actionable without returning conversation data", async () => {
    const handler = createClaimHandler({
      enabled: () => true,
      session: async () => actor,
      claim: async () => { throw new Error("EXPECTED_TENANT_MISMATCH:conversation"); },
      loadConversation: async () => { throw new Error("UNREACHABLE"); },
    });

    const response = await handler(
      post({ expectedState: "agent", expectedHolderId: null, confirmDisplace: false }),
      context,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      code: "EXPECTED_TENANT_MISMATCH",
      message: "This conversation is not available in this workspace.",
    });
  });
});
