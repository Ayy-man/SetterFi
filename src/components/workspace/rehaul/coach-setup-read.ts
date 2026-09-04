/**
 * The server half of Setup: everything `CoachSetup` renders, read once per request.
 *
 * It lives beside the component and not in `src/lib/repositories/**` because it is a page read
 * rather than a repository: it composes one repository call, one A2P projection and three small
 * table reads into the exact object one screen draws, and a repository that answered "what does
 * the coach's setup page need" would be a screen's shape wearing a repository's name. The
 * `channelActivity` and `calendarConnection` helpers on the old Connections page were written the
 * same way, in the page file, for the same reason.
 *
 * Two routes mount Setup, so the composition is here rather than in either page. Duplicating it
 * would be two chances for `/coach/get-started` and `/coach/integrations` to disagree about the
 * same tenant's setup, which is precisely the three-way contradiction the 2026-09-04 audit found
 * between `/onboarding`, `/coach/get-started` and `/coach/home`.
 *
 * Every read fails soft and says so. A query that did not answer sets `checked: false` on the
 * fact it was reading, and the component renders that as words. It never collapses to an empty
 * array or a `false`, because "there is no connection" and "we could not find out" are different
 * facts and only one of them is safe to print.
 */

import { redirect } from "next/navigation";

import type {
  CoachSetupCalendarRead,
  CoachSetupChannelRead,
  CoachSetupRead,
  CoachSetupRecordRow,
} from "@/components/workspace/rehaul/coach-setup";
import { canAccessWorkspace, parseAppClaims, workspaceForRole } from "@/lib/auth/claims";
import { carrierReviewFrom, type CarrierReview } from "@/lib/onboarding/carrier-review";
import { metaOAuthStartAvailable } from "@/lib/integrations/meta-oauth";
import {
  listChannelConnections,
  type ChannelConnectionView,
} from "@/lib/repositories/channel-connections";
import { loadCoachA2pRegistration } from "@/lib/repositories/onboarding-evidence";
import { createSupabaseServerClient, createSupabaseServiceClient } from "@/lib/supabase/server";

const UNCHECKED_CHANNEL: CoachSetupChannelRead = {
  accountLabel: null,
  changedAt: null,
  checked: false,
  liveSince: null,
  state: null,
};

/** The calendar states that mean the coach has to sign in again, as the old page named them. */
const CALENDAR_RECONNECT_STATES = new Set(["error", "disconnected", "expired"]);

/**
 * A connection's "since", taken from a receipt rather than from `created_at`.
 *
 * A row exists from the moment an OAuth starts, so `created_at` would date the attempt and not the
 * service. The signed round trip is the strongest evidence the channel actually carries messages;
 * the webhook subscription is the fallback, and a row with neither says nothing about when.
 */
function liveSince(connection: ChannelConnectionView): string | null {
  return connection.receipts.signedRoundTripAt ?? connection.receipts.webhookSubscribedAt;
}

function channelRead(
  connections: readonly ChannelConnectionView[] | null,
  channel: "instagram" | "messenger" | "sms",
): CoachSetupChannelRead {
  if (connections === null) return UNCHECKED_CHANNEL;
  const connection = connections.find((row) => row.channel === channel);
  if (!connection) {
    return { accountLabel: null, changedAt: null, checked: true, liveSince: null, state: null };
  }
  return {
    accountLabel: connection.externalAccountLabel,
    changedAt: connection.updatedAt,
    checked: true,
    liveSince: liveSince(connection),
    state: connection.state,
  };
}

/**
 * The A2P registration, with "the read failed" kept distinct from "there is no registration".
 *
 * `loadCoachA2pRegistration` answers `null` for a tenant with no filing, and a bare `.catch(() =>
 * null)` around it would spend that same `null` on a query that threw. `carrierReviewFrom` is
 * built to tell those apart -- `checked: false` wins over everything -- and it can only do that if
 * the caller keeps them apart on the way in.
 */
async function registrationRead(tenantId: string) {
  try {
    return { checked: true, registration: await loadCoachA2pRegistration(tenantId) };
  } catch {
    return { checked: false, registration: null };
  }
}

/**
 * The three provisioning steps this page reports, as receipts.
 *
 * `completed_at` and not `state`. A step can be `done` in the runner's sense while carrying no
 * completion timestamp, and a step that reads done with no receipt behind it is the completion
 * theatre the honest-states rule exists to stop, so the timestamp is what ticks a step here.
 */
async function provisioningReceipts(tenantId: string) {
  const keys = ["business_profile", "test_pass", "go_live"] as const;
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("provisioning_steps")
    .select("step_key, state, completed_at")
    .eq("tenant_id", tenantId)
    .in("step_key", [...keys]);

  if (error) {
    return {
      business: { checked: false, completedAt: null },
      goLive: { checked: false, completedAt: null },
      test: { checked: false, completedAt: null },
    };
  }

  const receipt = (key: (typeof keys)[number]) => {
    const row = (data ?? []).find((candidate) => candidate.step_key === key);
    return {
      checked: true,
      completedAt: row?.state === "done" ? (row.completed_at ?? null) : null,
    };
  };

  return { business: receipt("business_profile"), goLive: receipt("go_live"), test: receipt("test_pass") };
}

async function calendarRead(tenantId: string): Promise<CoachSetupCalendarRead> {
  const service = createSupabaseServiceClient();
  const { data, error } = await service
    .from("calendar_connections")
    .select("calendar_name, state")
    .eq("tenant_id", tenantId)
    .eq("is_primary", true)
    .maybeSingle();
  if (error) return { checked: false, connected: false, name: null, needsReconnect: false };
  if (!data) return { checked: true, connected: false, name: null, needsReconnect: false };
  const needsReconnect = CALENDAR_RECONNECT_STATES.has(String(data.state));
  return {
    checked: true,
    connected: !needsReconnect,
    name: data.calendar_name ?? null,
    needsReconnect,
  };
}

/**
 * The technical record: the hashes, the carrier's decision code and who filed it.
 *
 * These are the fields `docs/SIMPLIFICATION-SPEC.md` 2.5 demotes off the face and keeps behind a
 * disclosure, and the two table reads are the same ones the artifacts and content-screen routes
 * make. They are repeated here rather than imported because those loaders are private to their
 * handler modules, which this lane does not own; the alternative was two client fetches on a page
 * that already has everything else on the server.
 *
 * A row appears only when its field is present, so the drawer never fills a gap with a plausible
 * value. "Filed by" is a constant because it is one: SetterFi files every A2P registration on the
 * coach's behalf, and that is the fact the record is being asked to prove.
 */
async function technicalRecord(
  tenantId: string,
  carrier: CarrierReview,
  terminalCode: string | null,
): Promise<CoachSetupRead["record"]> {
  const service = createSupabaseServiceClient();
  const [artifact, screen] = await Promise.all([
    service
      .from("onboarding_optin_artifacts")
      .select("id, template_version, campaign_description_hash")
      .eq("tenant_id", tenantId)
      .eq("is_current", true)
      .maybeSingle(),
    service
      .from("onboarding_content_screens")
      .select("id, input_hash")
      .eq("tenant_id", tenantId)
      .eq("is_current", true)
      .maybeSingle(),
  ]);
  if (artifact.error || screen.error) return { checked: false, rows: [] };

  const submittedAt = carrier.kind === "in-review" ? carrier.submittedAt : null;
  const rows: CoachSetupRecordRow[] = [
    ...(submittedAt ? [{ label: "Filed at", value: submittedAt }] : []),
    ...(carrier.kind === "unchecked"
      ? []
      : [{ label: "Filed by", value: "SetterFi, on your behalf" }]),
    ...(terminalCode ? [{ label: "Carrier decision code", value: terminalCode }] : []),
    ...(artifact.data?.campaign_description_hash
      ? [{ label: "Campaign hash", value: artifact.data.campaign_description_hash }]
      : []),
    ...(artifact.data?.template_version
      ? [{ label: "Consent page version", value: artifact.data.template_version }]
      : []),
    ...(artifact.data?.id ? [{ label: "Consent artifact", value: artifact.data.id }] : []),
    ...(screen.data?.input_hash
      ? [{ label: "Welcome input hash", value: screen.data.input_hash }]
      : []),
    ...(screen.data?.id ? [{ label: "Welcome screen", value: screen.data.id }] : []),
  ];
  return { checked: true, rows };
}

export async function loadCoachSetup(
  tenantId: string,
  options: { impersonating?: boolean } = {},
): Promise<CoachSetupRead> {
  const [connections, filing, receipts, calendar] = await Promise.all([
    listChannelConnections(tenantId).catch(() => null),
    registrationRead(tenantId),
    provisioningReceipts(tenantId),
    calendarRead(tenantId),
  ]);

  /*
   * The registration is read once and reduced twice: `carrierReviewFrom` for the step, and the raw
   * terminal code for the record. A second `loadCoachA2pRegistration` would be a second chance for
   * the step and the record to disagree about the same filing.
   */
  const carrier: CarrierReview = carrierReviewFrom({
    checked: filing.checked,
    registrationState: filing.registration?.registrationState ?? null,
    submittedAt: filing.registration?.submittedAt ?? null,
    terminalRejection: filing.registration?.terminalRejection ?? false,
  });

  const record = await technicalRecord(tenantId, carrier, filing.registration?.terminalCode ?? null);

  return {
    business: receipts.business,
    calendar,
    carrier,
    goLive: receipts.goLive,
    instagram: channelRead(connections, "instagram"),
    /*
     * An impersonated session may read every row above and start no OAuth: the sign-in has to
     * happen in the coach's own browser, under the coach's own Meta account. The row says that in
     * words rather than offering a button that would be refused at the route.
     */
    metaConnect: options.impersonating
      ? "read_only"
      : metaOAuthStartAvailable()
        ? "ready"
        : "awaiting_meta",
    messenger: channelRead(connections, "messenger"),
    record,
    sms: channelRead(connections, "sms"),
    test: receipts.test,
  };
}

/**
 * The signed-in coach behind a Setup request, or a redirect.
 *
 * Both routes need the identical check, so it is written once. `impersonatingTenant` is doing two
 * jobs on purpose: it names the tenant to read, and it is the whole test for whether this session
 * may start an OAuth. The old Connections page resolved a full `impersonation_sessions` row to
 * answer the same question, which is a round trip spent on a boolean the claims already carry.
 */
export async function coachSetupContext(nextPath: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) redirect(`/login?next=${encodeURIComponent(nextPath)}`);

  const claims = parseAppClaims(data.claims);
  if (!canAccessWorkspace(claims.role, "coach", { affiliateAccess: claims.affiliateAccess })) {
    const home = workspaceForRole(claims.role);
    redirect(home ? `/${home}` : "/login");
  }

  const tenantId = claims.impersonatingTenant ?? claims.tenantId;
  if (!tenantId) redirect("/admin/platform-clients");
  return { impersonating: claims.impersonatingTenant !== null, tenantId };
}
