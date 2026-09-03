import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CoachConversations } from "@/components/workspace/live/coach-conversations";
import { CoachInbox } from "@/components/workspace/rehaul/coach-inbox";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { brainObjectionsLive, inboxVerbsLive, phase1Live, uiRehaulLive } from "@/lib/env-contract";
import { impersonatedReadContext, type ImpersonationSession } from "@/lib/impersonation";
import { loadCoachTopObjections } from "@/lib/repositories/analytics";
import {
  listConversationSet,
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

const STATUS_TO_LIFECYCLE: Record<ConversationRead["status"], string> = {
  agent: "agent",
  needs_human: "needs-you",
  human: "human",
  nurture: "follow-up",
  closed: "closed",
  scope_blocked: "scope-blocked",
  opted_out: "opted-out",
};

const STATUS_LABELS: Record<ConversationRead["status"], string> = {
  agent: "Agent handling",
  needs_human: "Needs you",
  human: "Human handling",
  nurture: "Follow-up",
  closed: "Closed",
  scope_blocked: "Scope blocked",
  opted_out: "Opted out",
};

function firstParam(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const raw = params[key];
  return Array.isArray(raw) ? raw[0] ?? "" : raw ?? "";
}

function allParams(
  params: Record<string, string | string[] | undefined>,
  key: string,
) {
  const raw = params[key];
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

function channelLabel(channel: ConversationRead["channel"]) {
  if (channel === "sms") return "Text messages (SMS)";
  if (channel === "messenger") return "Messenger";
  if (channel === "webchat") return "Web chat";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function isToday(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function outcomeMatches(conversation: ConversationRead, outcomes: readonly string[]) {
  if (outcomes.length === 0) return true;
  return outcomes.some((outcome) => {
    if (outcome === "qualified") return conversation.qualification.outcome === "BOOK";
    if (outcome === "not-fit") return conversation.qualification.outcome === "HARD_DQ";
    return outcome === "still-deciding"
      && (conversation.qualification.outcome === null
        || conversation.qualification.outcome === "SOFT_DQ");
  });
}

function filteredConversationIds(
  conversations: readonly ConversationRead[],
  params: Record<string, string | string[] | undefined>,
) {
  const requestedView = firstParam(params, "view") || "all";
  const query = firstParam(params, "q").trim().toLocaleLowerCase();
  const channels = allParams(params, "channel");
  const lifecycles = allParams(params, "lifecycle");
  const outcomes = allParams(params, "outcome");

  return conversations.filter((conversation) => {
    const matchesView = requestedView === "all"
      || (requestedView === "needs-you" && conversation.status === "needs_human")
      || (requestedView === "agent-handling" && conversation.status === "agent")
      || (requestedView === "booked-today"
        && Boolean(conversation.appointment && isToday(conversation.appointment.startAt)))
      || requestedView.startsWith("objection-");
    const latestMessage = conversation.messages.at(-1)?.body ?? "No messages yet";
    const haystack = `${conversation.contactName} ${channelLabel(conversation.channel)} ${STATUS_LABELS[conversation.status]} ${latestMessage}`.toLocaleLowerCase();
    return matchesView
      && (channels.length === 0 || channels.includes(conversation.channel))
      && (lifecycles.length === 0
        || lifecycles.includes(STATUS_TO_LIFECYCLE[conversation.status]))
      && outcomeMatches(conversation, outcomes)
      && (!query || haystack.includes(query));
  }).map((conversation) => conversation.id);
}

function queryIdentity(params: Record<string, string | string[] | undefined>) {
  return Object.entries(params)
    .flatMap(([key, raw]) => (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map((value) => [key, value] as const))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&") || "all-conversations";
}

/** A malformed objection id is treated as absent rather than as an error; a bad URL is not worth
 * a redirect, and an unfiltered page is what the coach asked for before they clicked anything. */
function requestedObjection(params: Record<string, string | string[] | undefined>) {
  const raw = Array.isArray(params.objection) ? params.objection[0] : params.objection;
  const value = (raw ?? "").trim();
  return value && UUID.test(value) ? value : null;
}

export default async function CoachConversationsPage({ searchParams }: PageProps) {
  const rehaul = uiRehaulLive();
  if (!phase1Live()) {
    return rehaul
      ? <CoachInbox enabled={false} initialConversations={[]} />
      : <CoachConversations enabled={false} initialConversations={[]} />;
  }

  const context = await liveCoachContext();
  const params = await searchParams;
  const objectionsEnabled = brainObjectionsLive();
  const rollup = objectionsEnabled && context.actorId
    ? await loadCoachTopObjections(context.actorId, context.tenantId, new Date().toISOString())
    : null;
  /*
   * `?objection=<id>` is the whole of the objection story on this route now. The inbox's cohort
   * pills were cut to three per `Inbox.dc.html`, so there is no longer a `view=objection-N` to
   * resolve -- what remains is the shareable parameter the agent page's "what leads push back on"
   * rows link to, applied here on the server where the tenant scope is enforced.
   */
  const directObjectionId = objectionsEnabled ? requestedObjection(params) : null;
  const conversations = await listConversationSet(context.tenantId, { objectionId: directObjectionId });

  let activeObjection: { id: string; label: string } | null = null;
  if (directObjectionId) {
    const row = rollup?.rows.find((candidate) => candidate.objectionId === directObjectionId) ?? null;
    activeObjection = row
      ? { id: directObjectionId, label: row.label }
      : { id: directObjectionId, label: "Selected objection, no recorded matches in the last 30 days" };
  }

  // The rehaul inbox takes the same rows, the same server-side narrowing and the same clock; the
  // objection label has no home on the three-pane layout, so only the old surface is handed it.
  if (rehaul) {
    return (
      <CoachInbox
        filteredConversationIds={filteredConversationIds(conversations, params)}
        impersonation={context.impersonation}
        initialConversations={conversations}
        key={queryIdentity(params)}
        nowIso={new Date().toISOString()}
        viewerId={context.actorId ?? null}
      />
    );
  }

  return (
    <CoachConversations
      filteredConversationIds={filteredConversationIds(conversations, params)}
      initialConversations={conversations}
      inboxVerbsEnabled={inboxVerbsLive()}
      impersonation={context.impersonation}
      key={queryIdentity(params)}
      // One instant for every wait on the page, resolved here so the server pass and the hydrated
      // client cannot disagree about how long a lead has been waiting.
      nowIso={new Date().toISOString()}
      activeObjection={activeObjection}
      viewerId={context.actorId ?? null}
    />
  );
}
