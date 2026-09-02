import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  NOTIFICATION_DESTINATION_REGISTRY,
  notificationDestination,
  resolveNotificationDestination,
} from "@/lib/notifications/destinations";

const ROUTE_FILES = {
  "/admin/brain": "src/app/(workspace)/admin/brain/page.tsx",
  "/admin/channel-health": "src/app/(workspace)/admin/channel-health/page.tsx",
  "/coach/billing": "src/app/(workspace)/coach/billing/page.tsx",
  "/coach/conversations": "src/app/(workspace)/coach/conversations/page.tsx",
  "/coach/integrations": "src/app/(workspace)/coach/integrations/page.tsx",
  "/coach/get-started": "src/app/(workspace)/coach/get-started/page.tsx",
} as const;

describe("notification destination registry", () => {
  it("maps every registered destination to a page that exists", () => {
    const paths = new Set(Object.values(NOTIFICATION_DESTINATION_REGISTRY).map((entry) => entry.path));
    expect([...paths].sort()).toEqual(Object.keys(ROUTE_FILES).sort());
    for (const path of paths) expect(existsSync(join(process.cwd(), ROUTE_FILES[path]))).toBe(true);
  });

  it("builds every current static and selected-record destination", () => {
    expect([
      notificationDestination({ key: "admin.brain" }),
      notificationDestination({ key: "admin.channel-health" }),
      notificationDestination({ key: "coach.billing" }),
      notificationDestination({ key: "coach.conversations" }),
      notificationDestination({ key: "coach.conversation", conversationId: "conversation/one" }),
      notificationDestination({ key: "coach.get-started" }),
      notificationDestination({ key: "coach.integrations" }),
      notificationDestination({ key: "coach.integration", connectionId: "connection one" }),
    ]).toEqual([
      "/admin/brain",
      "/admin/channel-health",
      "/coach/billing",
      "/coach/conversations",
      "/coach/conversations?conversationId=conversation%2Fone",
      "/coach/get-started",
      "/coach/integrations",
      "/coach/integrations?connectionId=connection+one",
    ]);
  });

  it("resolves only registered links authorized for the active workspace", () => {
    expect(resolveNotificationDestination(
      "/coach/conversations?conversationId=conversation-1",
      "coach",
    )).toBe("/coach/conversations?conversationId=conversation-1");
    expect(resolveNotificationDestination("/admin/brain", "admin")).toBe("/admin/brain");
    expect(resolveNotificationDestination("/admin/brain", "coach")).toBeNull();
    expect(resolveNotificationDestination("/coach/billing", "affiliate")).toBeNull();
  });

  it.each([
    "https://attacker.test/coach/conversations",
    "//attacker.test/coach/conversations",
    "/coach/conversations/legacy-id",
    "/coach/settings/integrations",
    "/coach/conversations?conversationId=one&unexpected=true",
    "/coach/conversations?conversationId=one&conversationId=two",
    "/coach/conversations#javascript:alert(1)",
    "/coach/help",
  ])("rejects the unsafe or unregistered persisted value %s", (value) => {
    expect(resolveNotificationDestination(value, "coach")).toBeNull();
  });

  it("keeps producer links behind the registry instead of adding route literals", () => {
    const producers = [
      "agent-inactivity.ts",
      "billing-events.ts",
      "channel-events.ts",
      "events.ts",
      "scheduled-checks.ts",
    ];
    for (const producer of producers) {
      const source = readFileSync(join(process.cwd(), "src/lib/notifications", producer), "utf8");
      expect(source).not.toMatch(/link:\s*[`"]\//u);
      expect(source).toContain("notificationDestination(");
    }
  });
});
