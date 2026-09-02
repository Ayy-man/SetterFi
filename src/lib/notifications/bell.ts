/** Bell projections derive outbound labels from persisted delivery aggregates only. */

import { createSupabaseServerClient } from "@/lib/supabase/server";

export type DeliveryAggregateStatus = "pending" | "sending" | "accepted" | "delivered" | "failed" | "unavailable";
export type DeliveryLabel = "Recorded" | "Queued" | "Sent" | "Delivered" | "Failed" | "Unavailable";

export function deliveryLabel(deliveries: readonly {
  destination: "bell" | "email" | "slack";
  status: DeliveryAggregateStatus;
}[]): DeliveryLabel {
  const outbound = deliveries.filter((delivery) => delivery.destination !== "bell");
  if (outbound.length === 0) return "Recorded";
  if (outbound.some((delivery) => delivery.status === "unavailable")) return "Unavailable";
  if (outbound.some((delivery) => delivery.status === "failed")) return "Failed";
  if (outbound.some((delivery) => delivery.status === "pending" || delivery.status === "sending")) return "Queued";
  if (outbound.some((delivery) => delivery.status === "accepted")) return "Sent";
  return "Delivered";
}

export type BellNotification = {
  id: string;
  kind: string;
  ruleId: string | null;
  sourceEventId: string | null;
  title: string;
  body: string;
  link: string | null;
  isTest: boolean;
  readAt: string | null;
  createdAt: string;
  deliveryLabel: DeliveryLabel;
};

export type BellRepository = {
  list(input: BellListInput): Promise<BellListResult>;
  unreadCount(userId: string): Promise<number>;
  markRead(userId: string, notificationId: string): Promise<BellNotification>;
  markAllRead(): Promise<number>;
};

export type BellListInput = {
  userId: string;
  limit: number;
  cursor: { createdAt: string; id: string } | null;
};

export type BellListResult = {
  notifications: BellNotification[];
  nextCursor: { createdAt: string; id: string } | null;
};

type BellRow = {
  id: string; kind: string; rule_id: string | null; source_event_id: string | null;
  title: string; body: string; link: string | null;
  is_test: boolean; read_at: string | null; created_at: string;
  notification_deliveries: Array<{ destination: "bell" | "email" | "slack"; status: DeliveryAggregateStatus }>;
};

function mapBell(row: BellRow): BellNotification {
  return {
    id: row.id, kind: row.kind, ruleId: row.rule_id, sourceEventId: row.source_event_id,
    title: row.title, body: row.body, link: row.link,
    isTest: row.is_test, readAt: row.read_at, createdAt: row.created_at,
    deliveryLabel: deliveryLabel(row.notification_deliveries),
  };
}

export function createBellRepository(): BellRepository {
  return {
    list: async ({ userId, limit, cursor }) => {
      const client = await createSupabaseServerClient();
      let query = client.from("notifications")
        .select("id,kind,rule_id,source_event_id,title,body,link,is_test,read_at,created_at,notification_deliveries(destination,status)")
        .eq("user_id", userId).order("created_at", { ascending: false }).order("id", { ascending: false })
        .limit(limit + 1);
      if (cursor) query = query.or(
        `created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
      );
      const { data, error } = await query;
      if (error) throw new Error("NOTIFICATION_BELL_READ_FAILED");
      const rows = data ?? [];
      const page = rows.slice(0, limit).map((row) => mapBell(row as unknown as BellRow));
      const last = page.at(-1);
      return {
        notifications: page,
        nextCursor: rows.length > limit && last
          ? { createdAt: last.createdAt, id: last.id }
          : null,
      };
    },
    unreadCount: async (userId) => {
      const client = await createSupabaseServerClient();
      const { count, error } = await client.from("notifications")
        .select("id", { count: "exact", head: true }).eq("user_id", userId).is("read_at", null);
      if (error) throw new Error("NOTIFICATION_UNREAD_COUNT_FAILED");
      return count ?? 0;
    },
    markRead: async (userId, notificationId) => {
      const client = await createSupabaseServerClient();
      const { error: markError } = await client.rpc("mark_notification_read", {
        p_notification_id: notificationId,
      });
      if (markError) throw new Error("NOTIFICATION_MARK_READ_REFUSED");
      const { data, error } = await client.from("notifications")
        .select("id,kind,rule_id,source_event_id,title,body,link,is_test,read_at,created_at,notification_deliveries(destination,status)")
        // The row the RPC just marked: this operator's own, or the shared one addressed to nobody
        // in particular. The RPC already refused anything else, so this only has to find it again.
        .eq("id", notificationId).or(`user_id.eq.${userId},user_id.is.null`)
        .single();
      if (error || !data) throw new Error("NOTIFICATION_MARK_READ_REFUSED");
      return mapBell(data as unknown as BellRow);
    },
    markAllRead: async () => {
      const client = await createSupabaseServerClient();
      const { data, error } = await client.rpc("mark_all_notifications_read");
      const row = Array.isArray(data) ? data[0] : data;
      if (error || !row || typeof row.marked_count !== "number") {
        throw new Error("NOTIFICATION_MARK_ALL_READ_REFUSED");
      }
      return row.marked_count;
    },
  };
}
