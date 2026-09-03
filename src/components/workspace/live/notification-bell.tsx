"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Status, StatusDot } from "@/components/kit/atomics";
import { Bell } from "@/components/kit/icons";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

import type { BellNotification } from "@/lib/notifications/bell";
import { resolveNotificationDestination } from "@/lib/notifications/destinations";
import type { WorkspaceRole } from "@/lib/workspace-navigation";

import {
  EMPTY_NOTIFICATION_STATE,
  executeNotificationPollDecision,
  loadBellNotifications,
  notificationListReadBack,
  notificationPollSchedule,
  notificationUnreadCount,
  type NotificationPollError,
} from "./notification-view-models";

export function NotificationBell({
  enabled,
  role,
}: {
  enabled: boolean;
  role: WorkspaceRole;
}) {
  const [open, setOpen] = useState(false);
  const [visibility, setVisibility] = useState<"visible" | "hidden">("visible");
  const [state, setState] = useState(EMPTY_NOTIFICATION_STATE);
  const [lastError, setLastError] = useState<NotificationPollError>(null);
  const manageHref =
    role === "coach"
      ? "/coach/settings#notifications"
      : role === "affiliate"
        ? "/affiliate"
        : "/admin/alerts";
  const heading =
    role === "coach"
      ? "Coach alerts"
      : role === "affiliate"
        ? "Partner alerts"
        : "Platform alerts";
  const unreadCount = notificationUnreadCount(state);

  useEffect(() => {
    const onVisibility = () => setVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    const decision = notificationPollSchedule(
      visibility,
      { lastSuccessAt: state.lastSuccessAt },
      now,
      lastError,
    );
    return executeNotificationPollDecision(decision, {
      now: Date.now,
      poll: () => {
        const controller = new AbortController();
        void loadBellNotifications(true, controller.signal).then((result) => {
          if (controller.signal.aborted || result.kind === "disabled") return;
          const at = Date.now();
          if (result.kind === "ready") {
            setState((current) => notificationListReadBack(current, {
              notifications: result.notifications,
              at,
            }));
            setLastError(null);
          } else {
            setState((current) => notificationListReadBack(current, { error: true }));
            setLastError((current) => ({ at, count: (current?.count ?? 0) + 1 }));
          }
        });
        return () => controller.abort();
      },
      schedule: (callback, delay) => setTimeout(callback, delay),
      cancel: (timer) => clearTimeout(timer),
    });
  }, [enabled, lastError, state.lastSuccessAt, visibility]);

  async function markRead(notification: BellNotification) {
    if (notification.readAt !== null) return;
    try {
      const response = await fetch("/api/notifications", {
        method: "PUT",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ notificationId: notification.id }),
      });
      const payload = await response.json() as { notification?: BellNotification };
      if (!response.ok || !payload.notification) return;
      setState((current) => ({
        ...current,
        notifications: current.notifications.map((item) =>
          item.id === payload.notification?.id ? payload.notification : item),
      }));
    } catch {
      // A failed mark-read keeps the persisted unread state visible; a later poll reconciles it.
    }
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <Button
            aria-label={`${heading}${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}
            className="relative transition-none active:translate-y-0"
            size="icon"
            variant="ghost"
          />
        }
      >
        <Bell />
        {unreadCount > 0 ? (
          <>
            <StatusDot
              className="absolute right-[var(--s-1)] top-[var(--s-1)] ring-2 ring-[var(--card)]"
              size={5}
              tone="warning"
            />
            <span className="sr-only">{unreadCount} unread</span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={heading}
        className="w-[calc(var(--s-12)*6)] gap-0 rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] p-[var(--s-2)] text-[length:var(--t-body)] text-[var(--body)] shadow-[var(--shadow-raised)] duration-[var(--dropdown-open-dur)] ease-[var(--dropdown-ease)] motion-reduce:animate-none motion-reduce:transition-none"
      >
        <PopoverHeader className="flex-row items-center justify-between gap-[var(--s-2)] px-[var(--s-2)] py-[var(--s-2)]">
          <PopoverTitle className="font-[var(--t-row-w)] text-[var(--ink)]">{heading}</PopoverTitle>
          <span className="text-[length:var(--t-badge)] text-[var(--muted)]">
            {enabled ? `${unreadCount} unread` : "Not enabled"}
          </span>
        </PopoverHeader>
        {!enabled ? (
          <p className="border-t border-[var(--line)] px-[var(--s-2)] py-[var(--s-3)] text-[var(--muted)]">
            Alert preferences are not enabled
          </p>
        ) : state.notifications.length > 0 ? (
          <ul className="m-0 grid list-none p-0">
            {state.notifications.map((notification) => {
              const destination = resolveNotificationDestination(notification.link, role);
              const title = (
                <strong className="block font-[var(--t-row-w)] text-[var(--ink)]">
                  {notification.title}
                </strong>
              );
              return (
                <li
                  className="flex items-start gap-[var(--s-2)] border-t border-[var(--line)] px-[var(--s-1)] py-[var(--s-3)] first:border-t-0"
                  data-tone={notification.readAt === null ? "pending" : "good"}
                  key={notification.id}
                >
                  <StatusDot
                    className="mt-[var(--s-1)]"
                    size={6}
                    tone={notification.readAt === null ? "warning" : "good"}
                  />
                  <div className="min-w-0 flex-1">
                    {/*
                      * Seeded rows carry their own marker rather than a "Test \u00b7 " prefix glued onto
                      * the title. A real notification title can contain a middot, so the prefix was a
                      * label the reader had to parse out of the sentence; this one cannot be mistaken
                      * for part of it.
                      */}
                    {notification.isTest ? (
                      <Status className="mb-[var(--s-1)]" label="Test" tone="waiting" treatment="bare" />
                    ) : null}
                    {destination ? (
                      <Link
                        className="block rounded-[var(--r-control)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                        href={destination}
                        onClick={() => {
                          setOpen(false);
                          void markRead(notification);
                        }}
                      >
                        {title}
                      </Link>
                    ) : title}
                    <p className="mt-[var(--s-1)] text-[var(--muted)]">{notification.body}</p>
                    <small className="mt-[var(--s-1)] block text-[length:var(--t-badge)] text-[var(--faint)]">
                      {notification.deliveryLabel}
                    </small>
                  </div>
                  <Button
                    disabled={notification.readAt !== null}
                    onClick={() => void markRead(notification)}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    {notification.readAt === null ? "Mark read" : "Read"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : state.status === "error" ? (
          <p className="border-t border-[var(--line)] px-[var(--s-2)] py-[var(--s-3)] text-[var(--muted)]">
            Notifications are temporarily unavailable.
          </p>
        ) : state.status === "ready" ? (
          <p className="border-t border-[var(--line)] px-[var(--s-2)] py-[var(--s-3)] text-[var(--muted)]">
            No notifications yet.
          </p>
        ) : (
          <p
            className="border-t border-[var(--line)] px-[var(--s-2)] py-[var(--s-3)] text-[var(--muted)]"
            role="status"
          >
            Checking for notifications.
          </p>
        )}
        <Link
          className="mt-[var(--s-1)] rounded-[var(--r-control)] px-[var(--s-2)] py-[var(--s-2)] font-medium text-[var(--accent-text)] hover:bg-[var(--row-hover)]"
          href={manageHref}
          onClick={() => setOpen(false)}
        >
          Manage notifications
        </Link>
      </PopoverContent>
    </Popover>
  );
}
