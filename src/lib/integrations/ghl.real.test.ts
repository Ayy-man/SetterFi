import { describe, expect, it } from "vitest";

import { environmentValue, realArmSkipReason } from "@/lib/env-contract";

import { createRealGhlDriver } from "./ghl";

const skipReason = realArmSkipReason(
  "ghl",
  "SETTERFI_GHL_DRIVER",
  ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_WEBHOOK_PUBLIC_KEY"],
);

describe.skipIf(Boolean(skipReason))(
  `GHL real arm — SKIPPED: ${skipReason ?? "configured"}`,
  () => {
    it("constructs the credentialed arm without turning configuration into provider evidence", () => {
      const driver = createRealGhlDriver({
        clientId: environmentValue("GHL_CLIENT_ID")!,
        clientSecret: environmentValue("GHL_CLIENT_SECRET")!,
        webhookPublicKey: environmentValue("GHL_WEBHOOK_PUBLIC_KEY")!,
      });
      expect(driver).toBeDefined();
    });
  },
);
