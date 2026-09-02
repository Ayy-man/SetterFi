import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Preference } from "@/app/api/notification-preferences/handler";
import { deliveryLabel, type BellNotification } from "@/lib/notifications/bell";

import {
  EMPTY_NOTIFICATION_STATE,
  NOTIFICATION_POLL_INTERVAL_MS,
  alertRuleViews,
  applyPreferenceReadBack,
  canChangePreference,
  executeNotificationPollDecision,
  loadBellNotifications,
  loadNotificationPreferences,
  notificationListReadBack,
  notificationPollSchedule,
  notificationUnreadCount,
} from "./notification-view-models";

const preference: Preference = {
  ruleId: "rule",
  event: "billing.allowance_crossed",
  scope: "tenant",
  name: "Allowance crossed",
  description: "This account crossed its included conversation allowance.",
  category: "billing",
  audience: "coach; billing_contact",
  defaultDestinations: ["bell", "email"],
  defaultEnabled: true,
  destination: "bell",
  enabled: true,
  locked: true,
};

function preferences(locked = true): Preference[] {
  return (["bell", "email", "slack"] as const).map((destination) => ({
    ...preference,
    destination,
    enabled: destination !== "slack",
    locked,
  }));
}

const notification: BellNotification = {
  id: "notification",
  kind: "appointment.booked",
  ruleId: "rule-appointment-booked",
  sourceEventId: "event-appointment-booked-001",
  title: "Appointment booked",
  body: "Body",
  link: null,
  isTest: true,
  readAt: null,
  createdAt: "2026-08-18T00:00:00.000Z",
  deliveryLabel: "Sent",
};

describe("notification preference projections", () => {
  it("keeps every destination visible and marks nonsuppressible billing rows Required", () => {
    expect(alertRuleViews(preferences())).toEqual([expect.objectContaining({
      event: "billing.allowance_crossed",
      required: true,
      enabled: true,
      bell: expect.objectContaining({ enabled: true, locked: true }),
      email: expect.objectContaining({ enabled: true, locked: true }),
      slack: expect.objectContaining({ enabled: false, locked: true }),
    })]);
  });

  it("commits only the persisted read-back and preserves the prior preference after failure", () => {
    const current = preferences(false);
    expect(applyPreferenceReadBack(current, null)).toBe(current);
    const saved = applyPreferenceReadBack(current, {
      ruleId: "rule",
      destination: "email",
      enabled: false,
      locked: false,
    });
    expect(saved.find((item) => item.destination === "email")?.enabled).toBe(false);
    expect(current.find((item) => item.destination === "email")?.enabled).toBe(true);
  });

  it("never dispatches a false preference for a locked billing consequence", () => {
    const lockedEmail = preferences().find((item) => item.destination === "email")!;
    expect(canChangePreference(lockedEmail, false)).toBe(false);
    expect(canChangePreference({ ...lockedEmail, locked: false }, false)).toBe(true);
  });

  it("performs no client request at all while the alerts flag is off", async () => {
    const request = vi.fn();
    const signal = new AbortController().signal;
    await expect(loadNotificationPreferences(false, signal, request)).resolves.toEqual({ kind: "disabled" });
    await expect(loadBellNotifications(false, signal, request)).resolves.toEqual({ kind: "disabled" });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("persisted bell state and pure polling", () => {
  it("labels only persisted delivery receipts and never upgrades accepted to delivered", () => {
    expect(deliveryLabel([{ destination: "email", status: "accepted" }])).toBe("Sent");
    expect(deliveryLabel([{ destination: "email", status: "delivered" }])).toBe(
      "Delivered",
    );
  });

  it("preserves the last unread receipt state on error instead of inventing zero", () => {
    const ready = notificationListReadBack(EMPTY_NOTIFICATION_STATE, {
      notifications: [notification],
      at: 1_000,
    });
    const failed = notificationListReadBack(ready, { error: true });
    expect(notificationUnreadCount(failed)).toBe(1);
    expect(failed.notifications[0]?.deliveryLabel).toBe("Sent");
    expect(failed.status).toBe("error");
  });

  it("stops while hidden and never polls faster than thirty seconds while visible", () => {
    expect(notificationPollSchedule("hidden", null, 0, null)).toEqual({
      action: "stop",
      nextDueAt: null,
    });
    expect(notificationPollSchedule("visible", { lastSuccessAt: 10_000 }, 20_000, null)).toEqual({
      action: "wait",
      nextDueAt: 10_000 + NOTIFICATION_POLL_INTERVAL_MS,
    });
    expect(notificationPollSchedule("visible", { lastSuccessAt: 10_000 }, 40_000, null)).toEqual({
      action: "poll",
      nextDueAt: null,
    });
  });

  it("backs off after an error and schedules exactly one cancelable timer", () => {
    const decision = notificationPollSchedule("visible", { lastSuccessAt: 1_000 }, 10_000, {
      at: 10_000,
      count: 2,
    });
    expect(decision).toEqual({ action: "preserve", nextDueAt: 70_000 });
    const poll = vi.fn();
    const schedule = vi.fn(() => 7 as unknown as ReturnType<typeof setTimeout>);
    const cancel = vi.fn();
    const cleanup = executeNotificationPollDecision(decision, {
      now: () => 10_000,
      poll,
      schedule,
      cancel,
    });
    expect(schedule).toHaveBeenCalledOnce();
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(poll).not.toHaveBeenCalled();
    cleanup();
    expect(cancel).toHaveBeenCalledWith(7);
  });

  it("runs an immediate poll once and aborts it on unmount", () => {
    const abort = vi.fn();
    const poll = vi.fn(() => abort);
    const cleanup = executeNotificationPollDecision(
      { action: "poll", nextDueAt: null },
      { now: () => 0, poll, schedule: setTimeout, cancel: clearTimeout },
    );
    expect(poll).toHaveBeenCalledOnce();
    cleanup();
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("dedicated alert page source boundaries", () => {
  it("checks the alerts flag before dynamic actor work on live settings pages", () => {
    for (const page of [
      "src/app/(workspace)/admin/alerts/page.tsx",
      "src/app/(workspace)/coach/settings/page.tsx",
    ]) {
      const source = readFileSync(resolve(process.cwd(), page), "utf8");
      expect(source.indexOf("if (!phase8AlertsLive())"), page).toBeGreaterThan(-1);
      expect(source.indexOf("if (!phase8AlertsLive())"), page)
        .toBeLessThan(source.indexOf("await import("));
      expect(source).not.toContain("workspace-fixtures");
      expect(source).not.toContain("localStorage");
    }
  });

  it("redirects the former admin settings route to notifications", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/admin/settings/page.tsx"),
      "utf8",
    );

    expect(source).toContain('redirect("/admin/alerts")');
    expect(source).not.toContain("phase8AlertsLive");
    expect(source).not.toContain("loadAlertActor");
  });

  it("wires the persisted bell and scopes affiliate access to coach settings", () => {
    const bell = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/notification-bell.tsx"),
      "utf8",
    );
    const alertSettings = readFileSync(
      resolve(process.cwd(), "src/components/workspace/live/alert-settings.tsx"),
      "utf8",
    );
    const coachSettings = readFileSync(
      resolve(process.cwd(), "src/app/(workspace)/coach/settings/page.tsx"),
      "utf8",
    );

    expect(bell).toContain("notificationPollSchedule(");
    expect(bell).toContain("executeNotificationPollDecision(");
    expect(bell).toContain('fetch("/api/notifications"');
    expect(bell).toContain("notification.deliveryLabel");
    expect(bell).toContain("notification.isTest");
    expect(bell).toContain("new AbortController()");
    expect(alertSettings).toContain("affiliateAccess?: boolean");
    expect(alertSettings).toContain('surface === "coach-settings" && affiliateAccess');
    expect(coachSettings).toContain("affiliateAccess={actor.affiliateAccess}");
  });
});
