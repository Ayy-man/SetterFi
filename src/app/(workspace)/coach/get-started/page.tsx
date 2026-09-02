import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AppShell } from "@/components/kit/app-shell";
import {
  GetStartedChecklist,
  type ChannelStripEntry,
} from "@/components/onboarding/get-started-checklist";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { CHANNEL_CONNECTION_STATE_COPY } from "@/lib/copy/states";
import { phase5Live } from "@/lib/env-contract";
import { listChannelConnections } from "@/lib/repositories/channel-connections";
import { loadTenantProvenance } from "@/lib/repositories/tenant-provenance";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Get started" };
export const dynamic = "force-dynamic";

const CRUMBS = [{ label: "Coach" }, { label: "Get started" }] as const;

async function liveCoachContext() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect("/login?next=%2Fcoach%2Fget-started");

  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }

  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  return { tenantId };
}

async function channelStrip(tenantId: string): Promise<ChannelStripEntry[]> {
  let connections: Awaited<ReturnType<typeof listChannelConnections>>;
  try {
    connections = await listChannelConnections(tenantId);
  } catch {
    // The strip is context, not the page's subject: absence renders nothing rather than a guess.
    return [];
  }

  const social = (["instagram", "facebook"] as const).map((channel): ChannelStripEntry => {
    const connection = connections.find((row) => row.channel === channel);
    const copy = connection ? CHANNEL_CONNECTION_STATE_COPY[connection.state] : null;
    return {
      key: channel,
      name: channel === "instagram" ? "Instagram" : "Facebook",
      stateLabel: copy?.label ?? "Not connected",
      tone: copy?.tone ?? "neutral",
      action:
        connection?.state === "live"
          ? null
          : { label: connection ? "Setup" : "Connect", href: "/coach/integrations" },
    };
  });

  return [
    ...social,
    {
      key: "sms",
      name: "Text messages (SMS)",
      stateLabel: "This journey",
      tone: "info",
      action: null,
    },
  ];
}

export default async function CoachGetStartedPage() {
  const { tenantId } = await liveCoachContext();
  const [channels, provenance] = await Promise.all([
    channelStrip(tenantId),
    loadTenantProvenance(tenantId),
  ]);

  return (
    <AppShell
      activePath="/coach/get-started"
      crumbs={CRUMBS}
      role="coach"
    >
      {/*
        The provenance is read here rather than inside the checklist because it is a fact about the
        account, not a resource the page polls, and this is where the tenant id already is.

        `?? "unknown"` is doing real work rather than satisfying a type. `loadTenantProvenance`
        returns null when the read did not answer, and the two natural things to write here are
        both wrong: `?? "real"` prints a reassuring claim on no evidence, and omitting the prop
        prints nothing -- which is the state this page was already in, and an unlabelled page is
        indistinguishable from one whose rows are known to be real. The unknown arm says which of
        those it is, in words.

        This is also the state a brand-new coach is most likely to see first. A workspace with
        nothing provisioned still has a `tenants` row, so a fresh real account resolves "real" and a
        seeded one resolves "demo"; `is_demo` is set at tenant creation and does not wait on any
        step of the journey below. "unknown" therefore means the read genuinely failed -- RLS, a
        dropped connection -- and not that the account is new.
      */}
      <GetStartedChecklist
        channels={channels}
        enabled={phase5Live()}
        nowIso={new Date().toISOString()}
        provenance={provenance ?? "unknown"}
      />
    </AppShell>
  );
}
