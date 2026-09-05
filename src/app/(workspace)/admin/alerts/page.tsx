import type { Metadata } from "next";
import { forbidden, redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import { AlertSettings } from "@/components/workspace/live/alert-settings";
import { AdminInboxUnavailable } from "@/components/workspace/live/admin-inbox";
import { inboxLanes } from "@/components/workspace/live/inbox-lanes";
import { FollowupCopyApprovals } from "@/components/workspace/rehaul/followup-copy-approvals";
import { OwnerInbox } from "@/components/workspace/rehaul/owner-inbox";
import { phase8AlertsLive } from "@/lib/env-contract";
import { loadAttentionQueue, type AttentionQueue } from "@/lib/operations/attention-queue";
import {
  platformConversationQueueLive,
  readPlatformHumanConversationQueue,
  type PlatformHumanConversation,
} from "@/lib/platform/conversation-projection";
import { listPendingFollowupCopy } from "@/lib/repositories/followup-copy";
import { listPlatformSupportThreads } from "@/lib/repositories/support";

export const metadata: Metadata = { title: "Inbox" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Run" }, { label: "Inbox" }] as const;

function InboxShell({ children }: { children: React.ReactNode }) {
  return (
    <AppShell activePath="/admin/alerts" crumbs={CRUMBS} role="admin">
      {children}
    </AppShell>
  );
}

export default async function AdminAlertsPage() {
  if (!phase8AlertsLive()) {
    return <AlertSettings enabled={false} surface="admin-alerts" />;
  }

  const { loadAlertActor } = await import("@/lib/auth/actors");
  const actor = await loadAlertActor();
  if (!actor) redirect("/login?next=%2Fadmin%2Falerts");
  if (actor.role !== "owner" && actor.role !== "admin" && actor.role !== "success") forbidden();

  /*
   * One instant, sampled once on the server and threaded into every duration on the page. The
   * onboarding lane learned this the hard way: a counter that reads the wall clock at render
   * disagrees with the page it sits on, because the two are evaluated milliseconds and one
   * hydration apart.
   */
  const nowIso = new Date().toISOString();
  const result = await readQueue(actor.userId, nowIso);
  if (!result.ok) {
    return (
      <InboxShell>
        <AdminInboxUnavailable reason={result.reason} />
      </InboxShell>
    );
  }

  /*
   * The second lane. The projection is a definer RPC that checks the actor itself and records the
   * privileged read, so a switched-off or failed read hands back a reason rather than an empty
   * array: an unreadable lane must never render as nothing waiting.
   */
  const handoffs = await readHandoffLane(actor.userId);
  // The folded Inbox owns the same platform support projection as Client requests, whose route is
  // now a redirect here. The repository remains its single query implementation.
  const clientRequests = await listPlatformSupportThreads({ actorId: actor.userId, book: "all" });
  const lanes = inboxLanes({
    queue: result.value,
    conversations: handoffs.ok ? handoffs.value : null,
    unavailableReason: handoffs.ok ? undefined : handoffs.reason,
    clientRequests,
  });

  // Follow-up copy waiting on a platform decision is a queue an operator works down, so it
  // lives in the Inbox rather than as its own rail destination. A read failure hides nothing
  // silently: the panel renders empty and the approvals page at /admin/followup-copy still works.
  const pendingCopy = await listPendingFollowupCopy().catch(() => []);
  return (
    <InboxShell>
      <OwnerInbox actorId={actor.userId} lanes={lanes} queue={result.value} />
      {pendingCopy.length > 0 ? <FollowupCopyApprovals initialItems={pendingCopy} /> : null}
    </InboxShell>
  );
}

type QueueResult =
  | { ok: true; value: AttentionQueue }
  | { ok: false; reason: string };

async function readQueue(actorId: string, nowIso: string): Promise<QueueResult> {
  try {
    return { ok: true, value: await loadAttentionQueue({ actorId, nowIso }) };
  } catch {
    return {
      ok: false,
      reason: "The notification store did not answer. Nothing is being hidden; the queue simply could not be read.",
    };
  }
}

type HandoffResult =
  | { ok: true; value: readonly PlatformHumanConversation[] }
  | { ok: false; reason: string };

/**
 * The lead-handoff lane, or the reason there isn't one.
 *
 * Two different absences, said differently. Switched off is a deployment fact the reader can do
 * nothing about, and a failed read is a fault worth reporting; collapsing them into one empty list
 * would make a broken lane look like a quiet platform.
 */
async function readHandoffLane(actorId: string): Promise<HandoffResult> {
  if (!platformConversationQueueLive()) {
    return {
      ok: false,
      reason: "The cross-tenant handoff queue is switched off in this environment, so lead handoffs "
        + "are not counted here. Each coach still sees their own in their inbox.",
    };
  }
  try {
    const queue = await readPlatformHumanConversationQueue(actorId);
    return { ok: true, value: queue.conversations };
  } catch {
    return {
      ok: false,
      reason: "The handoff queue did not answer, so this lane is not being counted. It is not empty; "
        + "it is unread.",
    };
  }
}
