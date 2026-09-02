/**
 * The platform attention queue: screen 2a, read from the notification store rather than invented.
 *
 * Every figure on that screen is a claim somebody will act on, so this module is deliberately
 * narrow about what it will say:
 *
 * - **There is no response deadline anywhere in the schema.** `alert_rules` carries a name, a
 *   description, a category and its destinations; it carries no response target, and
 *   `notifications` carries no due-by column. So `breachAt` is part of the shape and is `null` on
 *   every live row, `responseTargets.configured` is `false`, and the surface says in words that
 *   the queue is ordered by how long an item has been open rather than by time to breach. The
 *   artifact's "41m over" is a fact about a deadline that has passed, and this platform cannot
 *   currently know one. When a target column exists, fill `breachAt` and the ordering, the clock
 *   and the summary tiles all follow without touching the surface.
 *
 * - **Every duration is measured against a caller-supplied `nowIso`**, never `Date.now()` at
 *   render. The same instant reaches the queue clock, the summary tiles and the blast radius, so
 *   the page cannot disagree with itself, and the server and the hydrated client render the same
 *   bytes.
 *
 * - **Blast radius is derived or absent.** "Leads waiting" is a count of that account's
 *   conversations sitting in `needs_human`, and "oldest wait" is the earliest `needs_human_at`
 *   among them: two real columns, one index (`conversations_needs_human_idx`). The artifact's
 *   third line, "estimated bookings lost", would need a per-account booking-rate model that does
 *   not exist, so it is not computed and not rendered.
 *
 * Addressing: a row is in scope when it is addressed to this operator or to nobody in particular
 * (`user_id is null`, which the schema comments as "everyone in scope"). Rows addressed to a
 * different named person are somebody else's inbox and are never read here.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";

export { formatElapsed, formatQueueClock } from "@/lib/operations/attention-queue-format";

/** The four values of the `notification_severity` enum, in triage order. */
export const ATTENTION_SEVERITIES = ["critical", "warning", "info", "success"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

/** How many rows the board reads. A triage list nobody can finish is a wall, not a queue. */
export const ATTENTION_QUEUE_LIMIT = 60;

/** The window the "cleared" tile measures, and the window the reply histogram covers. */
export const CLEARED_WINDOW_DAYS = 7;
export const REPLY_WINDOW_HOURS = 24;

/**
 * The ceiling on message rows read for the reply histogram. Past it the series would be a
 * partial count drawn as if it were the whole one, so the histogram reports itself unavailable
 * instead of drawing a shape that slopes down because the read stopped.
 */
export const REPLY_ROW_CAP = 20_000;

export type AttentionAction = {
  availability: "available" | "not-available";
  command: "nudge_onboarding" | "mark_read" | null;
  endpoint: string | null;
  /** Why this is or is not offered. Rendered verbatim when nothing is available. */
  reason: string;
};

export type AttentionItem = {
  id: string;
  /** The alert rule's event key: `onboarding.stalled`, `channel.disconnected`, … */
  kind: string;
  severity: AttentionSeverity;
  title: string;
  body: string | null;
  link: string | null;
  tenantId: string | null;
  tenantName: string | null;
  /** True when this account is the operator's own book (`tenants.success_owner`). */
  assignedToMe: boolean;
  isTest: boolean;
  createdAt: string;
  readAt: string | null;
  /** Minutes since the row was recorded, measured against the queue's own `asOf`. */
  openForMinutes: number;
  /**
   * The instant a response target expires. Always `null` today: nothing in the schema declares
   * one. Present in the type so the clock, the ordering and the summary have a column to read
   * the day one exists, and so nothing has to guess in the meantime.
   */
  breachAt: string | null;
  /** Minutes to (positive) or past (negative) `breachAt`. `null` whenever `breachAt` is. */
  minutesToBreach: number | null;
  ruleName: string | null;
  ruleDescription: string | null;
  ruleCategory: string | null;
  primaryAction: AttentionAction;
};

export type AttentionBlastRadius = {
  tenantId: string;
  state: "available" | "unavailable";
  /** Conversations sitting in `needs_human` for this account. Excludes test threads. */
  leadsWaiting: number;
  oldestWaitStartedAt: string | null;
  oldestWaitMinutes: number | null;
  reason: string | null;
};

export type AttentionReplyVolume = {
  tenantId: string;
  state: "available" | "unavailable";
  /** One bucket per hour, oldest first, covering `fromIso` to `asOf`. */
  hourly: readonly number[];
  fromIso: string;
  reason: string | null;
};

export type AttentionSummary = {
  open: number;
  critical: number;
  warning: number;
  clearedInWindow: number;
  /** Median minutes between recording and opening, over the cleared window. Real or `null`. */
  medianMinutesToClear: number | null;
};

export type AttentionQueue = {
  asOf: string;
  items: readonly AttentionItem[];
  summary: AttentionSummary;
  blastRadius: readonly AttentionBlastRadius[];
  replyVolume: readonly AttentionReplyVolume[];
  /**
   * Whether any item in this queue carries a response target. `false` everywhere today; the
   * surface reads it rather than hard-coding the sentence, so the copy corrects itself the moment
   * a target column exists.
   */
  responseTargets: { configured: boolean; reason: string };
  /** A truncated read is said out loud rather than drawn as if it were the whole queue. */
  truncated: boolean;
};

export const NO_RESPONSE_TARGET_REASON =
  "No response target is stored for any alert rule, so nothing here can be counted as breaching. "
  + "The queue is ordered by how long each item has been open.";

const NO_RESTART_REASON =
  "No implemented command restarts an agent or replays its queue.";

export type RawAttentionNotification = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  link: string | null;
  tenant_id: string | null;
  is_test: boolean;
  read_at: string | null;
  created_at: string;
  tenant_name: string | null;
  tenant_success_owner: string | null;
  rule_name: string | null;
  rule_description: string | null;
  rule_category: string | null;
};

export type RawNeedsHumanWait = {
  tenant_id: string;
  needs_human_at: string | null;
};

export type RawAgentReply = {
  tenant_id: string;
  created_at: string;
};

export type AttentionSource = {
  readNotifications(input: { userId: string; limit: number }): Promise<readonly RawAttentionNotification[]>;
  readNeedsHumanWaits(tenantIds: readonly string[]): Promise<readonly RawNeedsHumanWait[]>;
  readAgentReplies(input: {
    tenantIds: readonly string[];
    sinceIso: string;
    cap: number;
  }): Promise<{ rows: readonly RawAgentReply[]; truncated: boolean }>;
};

function severityOf(value: string): AttentionSeverity {
  return (ATTENTION_SEVERITIES as readonly string[]).includes(value)
    ? (value as AttentionSeverity)
    : "info";
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Whole minutes between two instants, floored, and never negative for an elapsed reading: a row
 * recorded a second into the future by clock skew is zero minutes old, not minus one.
 */
function minutesBetween(fromMs: number, toMs: number) {
  return Math.max(0, Math.floor((toMs - fromMs) / 60_000));
}

export function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/**
 * The action a row offers.
 *
 * The artifact's primary is "Restart agent and replay queue". No endpoint in this codebase does
 * that: `/api/platform/clients/[id]/commands` accepts pause, resume, resend_signup,
 * nudge_onboarding, archive and note, and the connection-level `replay` command is tenant-scoped
 * and belongs to the coach's own console. So a stalled-onboarding row offers the one command that
 * genuinely addresses it, and every other row says plainly that nothing is wired.
 */
export function actionFor(kind: string, tenantId: string | null): AttentionAction {
  if (kind === "onboarding.stalled" && tenantId) {
    return {
      availability: "available",
      command: "nudge_onboarding",
      endpoint: `/api/platform/clients/${encodeURIComponent(tenantId)}/commands`,
      reason: "An onboarding nudge can be recorded through the existing client command endpoint.",
    };
  }
  return { availability: "not-available", command: null, endpoint: null, reason: NO_RESTART_REASON };
}

function mapItem(row: RawAttentionNotification, actorId: string, nowMs: number): AttentionItem | null {
  const createdMs = instant(row.created_at);
  if (createdMs === null) return null;
  return {
    id: row.id,
    kind: row.kind,
    severity: severityOf(row.severity),
    title: row.title,
    body: row.body,
    link: row.link,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    assignedToMe: row.tenant_success_owner === actorId,
    isTest: row.is_test,
    createdAt: row.created_at,
    readAt: row.read_at,
    openForMinutes: minutesBetween(createdMs, nowMs),
    // Null on every live row, deliberately: see the module header. Nothing here guesses a deadline.
    breachAt: null,
    minutesToBreach: null,
    ruleName: row.rule_name,
    ruleDescription: row.rule_description,
    ruleCategory: row.rule_category,
    primaryAction: actionFor(row.kind, row.tenant_id),
  };
}

/**
 * Ordering: unread before cleared, then severity, then oldest first. Where a response target
 * exists it wins over severity, because a deadline is a fact and a severity is a classification.
 */
function compareItems(left: AttentionItem, right: AttentionItem) {
  const cleared = Number(left.readAt !== null) - Number(right.readAt !== null);
  if (cleared !== 0) return cleared;
  if (left.minutesToBreach !== null || right.minutesToBreach !== null) {
    const leftBreach = left.minutesToBreach ?? Number.POSITIVE_INFINITY;
    const rightBreach = right.minutesToBreach ?? Number.POSITIVE_INFINITY;
    if (leftBreach !== rightBreach) return leftBreach - rightBreach;
  }
  const severity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severity !== 0) return severity;
  return right.openForMinutes - left.openForMinutes;
}

function summarise(items: readonly AttentionItem[], nowMs: number): AttentionSummary {
  // Test rows are excluded from every figure. They are labelled in the list, but a seeded alert
  // must never move a number an operator reads as the state of the real platform.
  const real = items.filter((item) => !item.isTest);
  const open = real.filter((item) => item.readAt === null);
  const clearedFrom = nowMs - CLEARED_WINDOW_DAYS * 24 * 60 * 60_000;
  const cleared = real.filter((item) => {
    const readMs = instant(item.readAt);
    return readMs !== null && readMs >= clearedFrom;
  });
  const clearTimes = cleared.flatMap((item) => {
    const createdMs = instant(item.createdAt);
    const readMs = instant(item.readAt);
    return createdMs === null || readMs === null ? [] : [minutesBetween(createdMs, readMs)];
  });
  return {
    open: open.length,
    critical: open.filter((item) => item.severity === "critical").length,
    warning: open.filter((item) => item.severity === "warning").length,
    clearedInWindow: cleared.length,
    medianMinutesToClear: medianOf(clearTimes),
  };
}

function blastRadiusFor(
  tenantIds: readonly string[],
  waits: readonly RawNeedsHumanWait[] | null,
  nowMs: number,
): AttentionBlastRadius[] {
  return tenantIds.map((tenantId) => {
    if (waits === null) {
      return {
        tenantId,
        state: "unavailable" as const,
        leadsWaiting: 0,
        oldestWaitStartedAt: null,
        oldestWaitMinutes: null,
        reason: "Waiting threads could not be read for this account.",
      };
    }
    const mine = waits.filter((wait) => wait.tenant_id === tenantId);
    const stamps = mine.flatMap((wait) => {
      const value = instant(wait.needs_human_at);
      return value === null ? [] : [{ iso: wait.needs_human_at as string, ms: value }];
    }).sort((left, right) => left.ms - right.ms);
    const oldest = stamps[0] ?? null;
    return {
      tenantId,
      state: "available" as const,
      leadsWaiting: mine.length,
      oldestWaitStartedAt: oldest?.iso ?? null,
      oldestWaitMinutes: oldest ? minutesBetween(oldest.ms, nowMs) : null,
      reason: null,
    };
  });
}

function replyVolumeFor(
  tenantIds: readonly string[],
  replies: { rows: readonly RawAgentReply[]; truncated: boolean } | null,
  fromMs: number,
  nowMs: number,
): AttentionReplyVolume[] {
  const fromIso = new Date(fromMs).toISOString();
  const buckets = REPLY_WINDOW_HOURS;
  const width = (nowMs - fromMs) / buckets;
  return tenantIds.map((tenantId) => {
    if (replies === null || replies.truncated) {
      return {
        tenantId,
        state: "unavailable" as const,
        hourly: [],
        fromIso,
        reason: replies === null
          ? "Agent replies could not be read for this account."
          : "Too many replies to count in one read, so the last 24 hours are not drawn.",
      };
    }
    const hourly = new Array<number>(buckets).fill(0);
    for (const reply of replies.rows) {
      if (reply.tenant_id !== tenantId) continue;
      const at = instant(reply.created_at);
      if (at === null || at < fromMs || at > nowMs) continue;
      const bucket = Math.min(buckets - 1, Math.floor((at - fromMs) / width));
      hourly[bucket] += 1;
    }
    return { tenantId, state: "available" as const, hourly, fromIso, reason: null };
  });
}

export function buildAttentionQueue(input: {
  actorId: string;
  nowIso: string;
  notifications: readonly RawAttentionNotification[];
  waits: readonly RawNeedsHumanWait[] | null;
  replies: { rows: readonly RawAgentReply[]; truncated: boolean } | null;
  truncated: boolean;
}): AttentionQueue {
  const nowMs = instant(input.nowIso);
  if (nowMs === null) throw new AttentionQueueError("INVALID_CLOCK");
  const items = input.notifications
    .flatMap((row) => {
      const item = mapItem(row, input.actorId, nowMs);
      return item ? [item] : [];
    })
    .sort(compareItems);
  const tenantIds = [...new Set(items.flatMap((item) => (item.tenantId ? [item.tenantId] : [])))];
  const replyFromMs = nowMs - REPLY_WINDOW_HOURS * 60 * 60_000;
  return {
    asOf: input.nowIso,
    items,
    summary: summarise(items, nowMs),
    blastRadius: blastRadiusFor(tenantIds, input.waits, nowMs),
    replyVolume: replyVolumeFor(tenantIds, input.replies, replyFromMs, nowMs),
    responseTargets: {
      configured: items.some((item) => item.breachAt !== null),
      reason: NO_RESPONSE_TARGET_REASON,
    },
    truncated: input.truncated,
  };
}

export class AttentionQueueError extends Error {
  constructor(readonly code: "UNAVAILABLE" | "INVALID_CLOCK") {
    super(code);
    this.name = "AttentionQueueError";
  }
}

type NotificationJoinRow = {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  link: string | null;
  tenant_id: string | null;
  is_test: boolean;
  read_at: string | null;
  created_at: string;
  tenants: { name: string; success_owner: string | null } | { name: string; success_owner: string | null }[] | null;
  alert_rules: { name: string; description: string | null; category: string | null }
    | { name: string; description: string | null; category: string | null }[]
    | null;
};

function first<T>(value: T | T[] | null): T | null {
  if (value === null) return null;
  return Array.isArray(value) ? value[0] ?? null : value;
}

export function createLiveAttentionSource(): AttentionSource {
  return {
    readNotifications: async ({ userId, limit }) => {
      const client = createSupabaseServiceClient();
      const { data, error } = await client
        .from("notifications")
        .select(
          "id,kind,severity,title,body,link,tenant_id,is_test,read_at,created_at,"
          + "tenants(name,success_owner),alert_rules(name,description,category)",
        )
        // Addressed to this operator, or to nobody in particular. Never another named inbox.
        .or(`user_id.eq.${userId},user_id.is.null`)
        .order("created_at", { ascending: false })
        .limit(limit + 1);
      if (error) throw new AttentionQueueError("UNAVAILABLE");
      return (data ?? []).map((raw) => {
        const row = raw as unknown as NotificationJoinRow;
        const tenant = first(row.tenants);
        const rule = first(row.alert_rules);
        return {
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          title: row.title,
          body: row.body,
          link: row.link,
          tenant_id: row.tenant_id,
          is_test: row.is_test,
          read_at: row.read_at,
          created_at: row.created_at,
          tenant_name: tenant?.name ?? null,
          tenant_success_owner: tenant?.success_owner ?? null,
          rule_name: rule?.name ?? null,
          rule_description: rule?.description ?? null,
          rule_category: rule?.category ?? null,
        } satisfies RawAttentionNotification;
      });
    },
    readNeedsHumanWaits: async (tenantIds) => {
      if (tenantIds.length === 0) return [];
      const client = createSupabaseServiceClient();
      const { data, error } = await client
        .from("conversations")
        .select("tenant_id,needs_human_at")
        .in("tenant_id", [...tenantIds])
        .eq("status", "needs_human")
        .eq("is_test", false);
      if (error) throw new AttentionQueueError("UNAVAILABLE");
      return (data ?? []) as RawNeedsHumanWait[];
    },
    readAgentReplies: async ({ tenantIds, sinceIso, cap }) => {
      if (tenantIds.length === 0) return { rows: [], truncated: false };
      const client = createSupabaseServiceClient();
      const { data, error } = await client
        .from("messages")
        .select("tenant_id,created_at")
        .in("tenant_id", [...tenantIds])
        .eq("direction", "out")
        .eq("author", "agent")
        .eq("is_test", false)
        .gte("created_at", sinceIso)
        .limit(cap + 1);
      if (error) throw new AttentionQueueError("UNAVAILABLE");
      const rows = (data ?? []) as RawAgentReply[];
      return { rows: rows.slice(0, cap), truncated: rows.length > cap };
    },
  };
}

/**
 * The one read the page makes. `nowIso` is threaded rather than sampled so every duration on the
 * screen — the queue clocks, the cleared median, the oldest wait — is measured against the same
 * instant, and so the server render and the hydrated client render agree byte for byte.
 */
export async function loadAttentionQueue(input: {
  actorId: string;
  nowIso: string;
  source?: AttentionSource;
  limit?: number;
}): Promise<AttentionQueue> {
  const source = input.source ?? createLiveAttentionSource();
  const limit = input.limit ?? ATTENTION_QUEUE_LIMIT;
  const raw = await source.readNotifications({ userId: input.actorId, limit });
  const notifications = raw.slice(0, limit);
  const tenantIds = [...new Set(notifications.flatMap((row) => (row.tenant_id ? [row.tenant_id] : [])))];
  const sinceIso = new Date(Date.parse(input.nowIso) - REPLY_WINDOW_HOURS * 60 * 60_000).toISOString();
  const [waits, replies] = await Promise.all([
    source.readNeedsHumanWaits(tenantIds).catch(() => null),
    source.readAgentReplies({ tenantIds, sinceIso, cap: REPLY_ROW_CAP }).catch(() => null),
  ]);
  return buildAttentionQueue({
    actorId: input.actorId,
    nowIso: input.nowIso,
    notifications,
    waits,
    replies,
    truncated: raw.length > limit,
  });
}
