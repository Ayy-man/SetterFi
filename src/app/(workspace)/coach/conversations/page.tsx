import type { Metadata } from "next";
import { redirect } from "next/navigation";

import {
  CoachInbox,
  type CoachInboxView,
} from "@/components/workspace/rehaul/coach-inbox";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { brainObjectionsLive, phase1Live, simulatedSendsLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import {
  conversationViewStatuses,
  listConversationSet,
  type CoachConversationView,
  type ConversationRead,
} from "@/lib/repositories/conversations";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Conversations" };
export const dynamic = "force-dynamic";

async function liveCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fconversations");
  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }
  // The reader identity the rollup RPC verifies. It comes from getClaims(), which validates the
  // JWT server-side, and never from the URL.
  const actorId = claims.userId ?? null;
  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  if (!claims.impersonatingTenant) return { actorId, tenantId, impersonation: null };

  const raw = data.claims as { app_metadata?: Record<string, unknown> };
  const sessionId = raw.app_metadata?.impersonation_session_id;
  if (typeof sessionId !== "string") redirect("/admin/platform-clients");
  const service = createSupabaseServiceClient();
  const { data: row, error: sessionError } = await service.from("impersonation_sessions").select("id, actor_id, tenant_id, reason, started_at, ended_at, expires_at").eq("id", sessionId).single();
  if (sessionError || !row) redirect("/admin/platform-clients");
  const session: ImpersonationSession = { id: row.id, actorId: row.actor_id, tenantId: row.tenant_id, reason: row.reason, startedAt: row.started_at, endedAt: row.ended_at, expiresAt: row.expires_at };
  const context = impersonatedReadContext(data.claims, session);
  return { actorId, tenantId: context.tenantId, impersonation: { sessionId: context.sessionId, tenantId: context.tenantId } };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type PageProps = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * The Inbox's three views, in the URL because a coach can share one, mapped onto the repository's
 * own view names rather than onto a second set of status predicates. These tabs are the only
 * cohort control the screen has; the seven named views and the objection cohorts are gone.
 */
const VIEW_KEYS: Record<CoachInboxView, CoachConversationView> = {
  "needs-you": "needs_you",
  "agent-handling": "agent_handling",
  everything: "everything",
};

function requestedView(
  params: Record<string, string | string[] | undefined>,
): CoachInboxView | null {
  const raw = Array.isArray(params.view) ? params.view[0] : params.view;
  const value = (raw ?? "").trim();
  return value in VIEW_KEYS ? value as CoachInboxView : null;
}

/** A malformed objection id is treated as absent rather than as an error; a bad URL is not worth
 * a redirect, and an unfiltered page is what the coach asked for before they clicked anything. */
function requestedObjection(params: Record<string, string | string[] | undefined>) {
  const raw = Array.isArray(params.objection) ? params.objection[0] : params.objection;
  const value = (raw ?? "").trim();
  return value && UUID.test(value) ? value : null;
}

/** The ids a view holds, decided by the repository's status lookup and applied here. */
function idsInView(conversations: readonly ConversationRead[], view: CoachInboxView) {
  const statuses = conversationViewStatuses(VIEW_KEYS[view]);
  const allowed = statuses ? new Set<ConversationRead["status"]>(statuses) : null;
  return conversations
    .filter((conversation) => allowed === null || allowed.has(conversation.status))
    .map((conversation) => conversation.id);
}

export default async function CoachConversationsPage({ searchParams }: PageProps) {
  if (!phase1Live()) return <CoachInbox enabled={false} initialConversations={[]} />;

  const context = await liveCoachContext();
  const params = await searchParams;
  /*
   * `?objection=<id>` is the whole of the objection story on this route now. The inbox's cohort
   * pills were cut to three per `Inbox.dc.html`, so there is no longer a `view=objection-N` to
   * resolve; what remains is the shareable parameter the agent page's "what leads push back on"
   * rows link to, applied here on the server where the tenant scope is enforced.
   */
  const directObjectionId = brainObjectionsLive() ? requestedObjection(params) : null;

  /*
   * One read, not one per view.
   *
   * `listConversationSet` takes a `view` and filters in the query, which is the right shape for a
   * caller that wants one lane. This screen draws the size of the other two lanes on their tabs,
   * so a filtered read would need a second and a third round trip to count what it did not fetch,
   * and the playbook's rule 7 measured a bare Supabase round trip at 300 to 360ms against queries
   * that run in single-digit milliseconds. So the set is read once and the view boundary is
   * applied here from `conversationViewStatuses`, the repository's own lookup, which exists
   * precisely so the tab boundary and the status enum cannot drift apart.
   */
  const conversations = await listConversationSet(
    context.tenantId,
    { objectionId: directObjectionId },
  );

  const needsYou = idsInView(conversations, "needs-you");
  const agentHandling = idsInView(conversations, "agent-handling");
  // Absent a chosen view the screen opens where the work is, and on an inbox with nothing waiting
  // it opens on the whole list rather than on an empty lane.
  const view = requestedView(params) ?? (needsYou.length > 0 ? "needs-you" : "everything");

  return (
    <CoachInbox
      impersonation={context.impersonation}
      initialConversations={conversations}
      key={view}
      // One instant for every wait on the page, resolved here so the server pass and the hydrated
      // client cannot disagree about how long a lead has been waiting.
      nowIso={new Date().toISOString()}
      rehearsal={simulatedSendsLive()}
      view={view}
      viewCounts={{ needsYou: needsYou.length, agentHandling: agentHandling.length }}
      viewerId={context.actorId ?? null}
      viewIds={
        view === "needs-you"
          ? needsYou
          : view === "agent-handling"
            ? agentHandling
            : conversations.map((conversation) => conversation.id)
      }
    />
  );
}
