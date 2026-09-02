"use client";

import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { AppShell } from "@/components/kit/app-shell";
import { CellQuiet } from "@/components/kit/cell-quiet";
import { DataState } from "@/components/kit/data-state";
import {
  FigureStrip,
  IconTile,
  NoteStrip,
  Prose,
  STATE_TONE_TO_TONE,
  Status,
  StatusAbsent,
  Surface,
  SurfaceHeader,
  type Tone,
} from "@/components/kit/atomics";
import { DataTable } from "@/components/kit/data-table";
import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter";
import {
  ChatIcon,
  Check,
  Circle,
  FacebookLogo,
  InstagramLogo,
  Phone,
} from "@/components/kit/icons";
import { RecordSheet } from "@/components/kit/record-sheet";
import type { StateTone } from "@/components/kit/state-badge";
import {
  ReviewChecklist,
  ReviewChecklistUntracked,
  type ReviewChecklistStep,
} from "@/components/kit/review-checklist";
import { ListPage } from "@/components/kit/templates/list-page";
import { Select } from "@/components/ui/select";
import { workspaceDateTimeFormat } from "@/lib/format/datetime";
import { CARRIER_TYPICAL_DAYS } from "@/lib/onboarding/contracts";
import { receiptState } from "@/lib/copy/states";
import type { ChannelConnectionView } from "@/lib/repositories/channel-connections";
import type { MessageTemplateView } from "@/lib/repositories/message-templates";
import { withWorkspaceNavCounts, workspaceNavigationFor } from "@/lib/workspace-navigation";
import { deriveChannelTruths, deriveMetaReviewTruth } from "./view-models";

export type ChannelHealthClient = {
  id: string;
  name: string;
  isDemo: boolean;
};

type ChannelTruth = ReturnType<typeof deriveChannelTruths>[number];

const CRUMBS = [
  { label: "Run" },
  { label: "Channel health" },
] as const;

/**
 * The six steps of Meta app review, in the order they have to happen.
 *
 * These are the work, not a report on the work. Nothing in this product stores where a Meta
 * filing has got to: `MetaReviewReceipt` is a type with no repository, no route and no column
 * behind it, so the six states this list used to carry ("current", then five "blocked") were
 * typed into the source rather than read from anything. They are gone. See `ReviewChecklist` for
 * why the component swap is the fix rather than better fixture states, and docs/GAPS.md for the
 * storage that would have to exist before any of this can report progress.
 *
 * Step one is deliberately still the artifact's pairing of the two verifications, and it is
 * "you" on this surface because the admin portal belongs to the client's own team, which is the
 * party that completes Business Verification in Business Settings. docs/CONTEXT.md records that
 * these are two processes with different durations, and that Access Verification gates coach
 * self-serve volume rather than the demo; that, and the fourth Meta process the artifact omits
 * entirely, are logged as gaps rather than invented into a seventh row.
 */
const META_REVIEW_STEPS: readonly ReviewChecklistStep[] = [
  {
    body: "Complete Business Verification, Access Verification, and confirm the permissions requested for each channel.",
    key: "verification",
    owner: { label: "You" },
    title: "Business and access verification",
  },
  {
    body: "Publish the privacy and account deletion pages used by the review team.",
    key: "policy-pages",
    owner: { label: "You" },
    title: "Privacy and deletion pages",
  },
  {
    body: "Prepare the test accounts and capture the required live channel calls.",
    key: "test-assets",
    owner: { label: "You" },
    title: "Test assets and live calls",
  },
  {
    body: "Record the channel walkthroughs and check that each permission is demonstrated.",
    key: "walkthroughs",
    owner: { label: "You" },
    title: "Review walkthroughs",
  },
  {
    body: "Submit the package and store the provider filing reference before review is shown as filed.",
    key: "filing",
    owner: { label: "You" },
    title: "Submit review package",
  },
  {
    body: "Meta reviews the filed package and returns the provider decision.",
    key: "provider-review",
    owner: { external: true, label: "Meta" },
    title: "Meta review",
  },
];

/**
 * Meta's own developer documentation links this as the Business Manager entry point (fetched
 * 2026-08-31 from developers.facebook.com/docs/development/release/business-verification). The
 * root only: Meta publishes no stable deep link to the Security Center panel where Business
 * Verification is actually completed, and a guessed path is a claim about a third party that
 * nobody here has checked.
 */
const META_BUSINESS_MANAGER_URL = "https://business.facebook.com/";

function tone(value: "neutral" | "good" | "pending" | "bad"): StateTone {
  if (value === "pending") return "warning";
  if (value === "bad") return "critical";
  return value;
}

/**
 * The receipt sentence is the one place a connection is allowed to sound finished, and only a
 * signed round trip earns it. Anything short of that says which receipt is still missing.
 */
function receiptPresentation(
  connection: ChannelConnectionView | undefined,
): { label: string; tone: StateTone } {
  if (!connection) return { label: "No connection receipts", tone: "neutral" };
  const state = receiptState(connection.receipts);
  if (state === "live") return { label: "Signed round trip received", tone: "good" };
  if (state === "ready") return { label: "OAuth and asset receipts stored", tone: "info" };
  return { label: "Connection receipts incomplete", tone: "warning" };
}

/**
 * A derived channel state of "good" is the connection row's own claim, not proof. The screen only
 * ever repeats the receipt sentence in its place, so nothing reads "Connected" while the signed
 * round trip is still missing.
 */
function honestChannelState(
  channel: ChannelTruth,
  connection: ChannelConnectionView | undefined,
): { label: string; tone: StateTone } {
  if (channel.tone === "good") return receiptPresentation(connection);
  return { label: channel.stateLabel, tone: tone(channel.tone) };
}

/**
 * What `AdminChannelHealth.dc.html` draws that this page refuses, and why each refusal stands.
 *
 * The canvas is a fleet view: one table of every connection across all twenty-four clients,
 * with Sent, Failed and Last error columns, a 24h/7d/30d switch, and four figures across the top
 * -- Messages delivered, Delivery failures, Median send latency, Tokens expiring in 14 days.
 * None of it ships, and the reason is the isolation boundary rather than a missing column.
 *
 * **Pooling across tenants is the refusal, and it is a product decision.**
 * The page reads one client at a time on purpose, and the empty state says so in the sentence a
 * reader meets first: a receipt only means something against the tenant that earned it, so
 * "eighteen thousand delivered" over a fleet answers no question anyone has -- it cannot tell you
 * whether the client on the phone can send. Pooling would also put twenty-four tenants' evidence
 * in one projection, which is the isolation boundary this surface exists on the safe side of.
 *
 * **The counts and the latency are not on this read, which is a narrower claim than it used to
 * be.** This comment said until 2026-09-01 that they had no source anywhere. That stopped being
 * true when `20260905000002_outbound_send_atomicity.sql` landed: `outbound_send_attempts` carries
 * one row per lead-facing send with `tenant_id`, `channel`, `status`, `last_error_code`,
 * `created_at` and `accepted_at`, and `20260905000008` runs a reconciliation service over it. Sent,
 * Failed, Last error and send-to-ack latency all have a source now, and `created_at` would even
 * give the period switch a window. What this page reads is still only connection state and
 * template approvals -- `listChannelConnections` and `listMessageTemplates`, checked 2026-09-01 --
 * so the figures are absent here because the page does not fetch them, not because nothing records
 * them. The four figures the strip carries are counted off the receipts themselves.
 *
 * The refusal above is what keeps the drawn table off this page, and it does not depend on any of
 * that. Three audit rounds read the sentence this replaces and recorded a data gap that had
 * already closed, which is why the claim now names the table it was checked against and the day it
 * was checked: a refusal citing an absent column is a claim with an expiry date, and nothing
 * re-reads it when the schema moves.
 *
 * **If a delivery column is ever built, it is three-valued.** `coach-measurement.tsx:934-939`
 * works this out for the coach's own channel: `outbound_send_attempts` models a status
 * `indeterminate` whose column comment reads "provider acceptance cannot be ruled out and
 * automatic retry is forbidden", so a flat "Failed: 9" asserts exactly what that status exists to
 * deny. Accepted, failed, and unknown -- and the unknown is not a rounding error, it is the case
 * the send path was designed around.
 *
 * **The State column is dropped deliberately, not missing.** See the band comment immediately
 * below: the rows are grouped by state, so a column repeating the band heading is the same
 * sentence twice on one line. The canvas's state words -- Live, Failing, Paused by client, In
 * carrier review -- are real states this page renders; they are simply spelled in terms of the
 * receipt that is or is not stored, which is the only thing that makes "connected" true.
 */

/**
 * The three states a channel is actually in, in the order somebody works them: the ones still
 * missing a receipt, the ones a provider is sitting on, and the ones that are done. Grouping the
 * rows by this is what lets the table drop its state pill -- the band heading already says it,
 * and repeating it in a column beside itself is the noise this pass removes.
 */
const CHANNEL_GROUPS = [
  {
    annotation: "nothing sends or receives here until the receipt is stored",
    id: "attention",
    label: "Missing a receipt",
    tone: "failure",
  },
  {
    annotation: "the clock belongs to the provider, so no decision date is shown",
    id: "waiting",
    label: "Waiting on a provider",
    tone: "waiting",
  },
  {
    annotation: "proved end to end, not merely configured",
    id: "live",
    label: "Signed round trip received",
    tone: "good",
  },
] as const satisfies readonly { annotation: string; id: string; label: string; tone: Tone }[];

function channelGroup(
  channel: ChannelTruth,
  connection: ChannelConnectionView | undefined,
): (typeof CHANNEL_GROUPS)[number]["id"] {
  const state = honestChannelState(channel, connection);
  if (state.tone === "good") return "live";
  if (state.tone === "warning") return "waiting";
  return "attention";
}

/**
 * One demo marker per name, not two.
 *
 * The seeded tenants own their marker -- their stored name already ends in "(demo)" -- and the
 * picker used to append a second one unconditionally, so the list read "Elevate Funding Co.
 * (demo) (demo)". The seeds are the source: the marker is only appended when the stored name does
 * not already carry one, which keeps a demo tenant named without it still labeled on screen
 * (CLAUDE.md: test data is labeled as such).
 */
export function demoMarkedName(client: ChannelHealthClient) {
  if (!client.isDemo) return client.name;
  return /\(demo\)\s*$/iu.test(client.name) ? client.name : `${client.name} (demo)`;
}

function ClientPicker({
  clients,
  selectedClientId,
}: {
  clients: readonly ChannelHealthClient[];
  selectedClientId: string | null;
}) {
  const router = useRouter();
  return (
    <Select
      className="w-[calc(var(--drawer-w)/1.8)] max-w-full"
      disabled={clients.length === 0}
      label="Choose client"
      srOnly
      onValueChange={(clientId) => router.push(`/admin/channel-health?client=${encodeURIComponent(clientId)}`)}
      options={clients.map((client) => ({
        label: demoMarkedName(client),
        value: client.id,
      }))}
      placeholder="Choose a client"
      value={selectedClientId}
    />
  );
}

/**
 * The glyph that leads a channel row. Deliberately `neutral` rather than the row's own state
 * colour: the rows are already banded by state, and a column of tinted tiles beside a band heading
 * that says the same thing is the colour-for-its-own-sake this pass removes. The tile says which
 * channel; the band says how it is doing.
 */
const CHANNEL_GLYPH: Record<ChannelTruth["channel"], typeof Phone> = {
  instagram: InstagramLogo,
  messenger: FacebookLogo,
  sms: Phone,
  whatsapp: ChatIcon,
};

/**
 * The one fix, derived rather than written.
 *
 * `deriveChannelTruths` builds the four receipt checks in the order a connection actually earns
 * them, so the first incomplete one is the next thing that has to happen and everything after it
 * is blocked behind it. That is the whole of "the fix": a plain sentence per outstanding receipt
 * and the name of whoever owns it, with no invented remediation step and no ordering guessed here.
 */
const RECEIPT_FIX = [
  {
    next: "Re-authentication",
    owner: "The client",
    step: "Re-authenticate the account. The client signs in with the provider themselves, so nobody at SetterFi holds their password.",
  },
  {
    next: "The account asset check",
    owner: "SetterFi",
    step: "Confirm the account asset the agent replies from.",
  },
  {
    next: "The delivery subscription",
    owner: "SetterFi",
    step: "Subscribe message delivery for the account.",
  },
  {
    next: "A signed test message",
    owner: "SetterFi",
    step: "Run a signed test message end to end. Nothing here reads connected until that receipt is stored.",
  },
] as const;

/**
 * The next receipt a partial connection needs, in the words of the check that is missing.
 *
 * The band already says the channel is short of a receipt and the receipts cell already says it is
 * incomplete; neither can say *which one*, and that is the only thing on this row a reader has to
 * carry away. It reads off the same ordered checks the sheet's fix does, so the row and the sheet
 * can never name different next steps.
 */
function nextReceiptNeeded(channel: ChannelTruth): string | null {
  const index = channel.prerequisites.findIndex((item) => !item.complete);
  return index === -1 ? null : RECEIPT_FIX[index].next;
}

function ChannelFix({ channel }: { channel: ChannelTruth }) {
  const outstanding = channel.prerequisites
    .map((item, index) => ({ ...item, ...RECEIPT_FIX[index] }))
    .filter((item) => !item.complete);

  if (outstanding.length === 0) {
    return (
      <Prose className="t-body m-0 text-[color:var(--body)]">
        Every receipt this channel needs is stored. There is nothing to fix here.
      </Prose>
    );
  }

  return (
    <ol className="m-0 flex list-none flex-col gap-[var(--s-3)] p-0">
      {outstanding.map((item, index) => (
        <li className="flex min-w-0 items-start gap-[var(--s-3)]" key={item.label}>
          <span className="mono mt-[1px] grid size-[22px] shrink-0 place-items-center rounded-[var(--r-full)] border border-[var(--line)] bg-[var(--control-fill)] text-[11px] tabular-nums text-[color:var(--meta)]">
            {index + 1}
          </span>
          <Prose className="t-body m-0 text-[color:var(--body)]">
            {item.step}{" "}
            <span className="text-[color:var(--faint)]">{item.owner} owns this step.</span>
          </Prose>
        </li>
      ))}
    </ol>
  );
}

/**
 * What the provider said, and when the credential runs out. Screen 1f's opening sentence.
 *
 * A channel that reads "Needs attention" and stops there sends an operator to the provider's own
 * console to find out why, which is the trip this page exists to save. Both facts are columns on
 * `channel_connections` that the read was discarding, so this is a passthrough and not a
 * diagnosis: the provider's text is rendered as stored, and an empty column says the reason was
 * not recorded rather than inventing a cause that fits the state.
 *
 * The expiry is stated only when it has already passed or is the reason the connection is
 * unhealthy. A future expiry on a working channel is not news, and a countdown to it would be the
 * predicted date the honest-states rule forbids.
 */
function ChannelCause({ channel, now }: { channel: ChannelTruth; now: Date }) {
  const expired = channel.tokenExpiresAt !== null
    && Number.isFinite(Date.parse(channel.tokenExpiresAt))
    && Date.parse(channel.tokenExpiresAt) <= now.getTime();
  return (
    <div className="flex flex-col gap-[var(--s-2)]">
      {channel.errorText ? (
        <Prose className="t-body m-0 text-[color:var(--body)]">{channel.errorText}</Prose>
      ) : (
        <Prose className="t-muted m-0">
          The provider recorded no reason on this connection. The receipt checks below are what is
          known; nothing here guesses at a cause from the state alone.
        </Prose>
      )}
      {expired ? (
        <Prose className="t-muted m-0">
          Its credential expired on {workspaceDateTimeFormat.format(new Date(channel.tokenExpiresAt as string))}.
          Re-authenticating is the only thing that restores it.
        </Prose>
      ) : null}
    </div>
  );
}

/**
 * Who is affected, and what this screen genuinely cannot say.
 *
 * The artifact's blast-radius tiles count paused agents, queued leads and lost bookings. None of
 * those are recorded against a channel connection: `channel_connections` stores state and four
 * receipt timestamps and nothing else, and there is no agent-to-connection or queue-to-connection
 * read behind this page. A plausible "3 agents paused" here would be a fabricated statistic, which
 * `docs/DESIGN.md` names outright, so the section states the mechanism it can prove and then says
 * plainly which number is missing rather than filling it in.
 */
function ChannelBlastRadius({ channel }: { channel: ChannelTruth }) {
  return (
    <div className="flex flex-col gap-[var(--s-2)]">
      <Prose className="t-body m-0 text-[color:var(--body)]">
        While {channel.label} is short of its receipts, no agent can send or receive on it. Replies
        are held rather than dropped.
      </Prose>
      <Prose className="t-muted m-0">
        How many agents and held leads that is, is not recorded against a channel connection, so no
        count is shown here rather than an estimated one.
      </Prose>
    </div>
  );
}

/**
 * The provider window, stated once as a reference rather than repeated down a column.
 *
 * Every sentence here is read off the connection's own resolved capabilities
 * (`resolveMessagingCapabilities`, which answers per provider and per channel), so a tenant on a
 * non-windowed provider does not get told about Meta's 24 hour rule. A channel with nothing stored
 * gets no sentence at all: the capability is a fact about the provider that connected it, and with
 * no connection there is no provider to answer for.
 */
function windowSentence(connection: ChannelConnectionView | undefined): string | null {
  if (!connection) return null;
  const { postWindow, windowed } = connection.capabilities;
  if (!windowed) return "No provider window. The carrier's own rules apply instead.";
  if (postWindow === "template") {
    return "24 hours after the lead's last message, then an approved template only.";
  }
  return "24 hours after the lead's last message, then the thread waits for them.";
}

function MessagingWindows({
  channels,
  connections,
}: {
  channels: readonly ChannelTruth[];
  connections: readonly ChannelConnectionView[];
}) {
  const rows = channels.map((channel) => ({
    channel,
    sentence: windowSentence(
      connections.find((candidate) => candidate.channel === channel.channel),
    ),
  }));
  const known = rows.filter((row) => row.sentence !== null);

  return (
    <Surface className="min-w-0" variant="panel">
      <SurfaceHeader overline="Messaging windows" />
      <div className="px-[var(--s-4)] py-[var(--s-2)]">
        {known.length === 0 ? (
          <Prose className="t-muted m-0 py-[var(--s-2)]">
            A messaging window is a fact about the provider a channel connected through, so nothing
            is stated until at least one channel has a stored connection.
          </Prose>
        ) : (
          <dl className="m-0 grid gap-0">
            {known.map((row) => (
              <div
                className="flex flex-wrap items-baseline justify-between gap-x-[var(--s-4)] gap-y-[var(--s-1)] border-b border-[var(--line-soft)] py-[var(--s-2)] last:border-b-0"
                key={row.channel.channel}
              >
                <dt className="t-body m-0 min-w-0 text-[color:var(--body)]">{row.channel.label}</dt>
                <dd className="m-0 min-w-0 text-right text-[12px] leading-[1.45] text-[color:var(--faint)]">
                  {row.sentence}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </Surface>
  );
}

function PrerequisiteList({ channel }: { channel: ChannelTruth }) {
  return (
    <ul aria-label={`${channel.label} receipt checks`} className="m-0 grid list-none gap-[var(--s-2)] p-0 sm:grid-cols-2">
      {channel.prerequisites.map((item) => (
        <li className="t-body flex items-center gap-[var(--s-2)] text-[var(--muted)]" key={item.label}>
          {item.complete
            ? <Check className="text-[var(--good)]" />
            : <Circle className="text-[var(--faint)]" />}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The two platform-wide marketplace apps, on the surface an operator opens when a channel is not
 * working.
 *
 * They are not tenant evidence, so this sits outside the client scope and stays put when no client
 * is chosen: one agency approval covers every client, and a reader who has to pick a coach first
 * to discover that the platform grant was never stored is a reader who will not discover it. The
 * card states and links; it never offers the approval, because approving belongs on the one page
 * that also carries the warm-up warning and the audit-logged button.
 */
export type AgencyInstallSummary = {
  app: string;
  title: string;
  label: string;
  tone: "neutral" | "good" | "pending" | "bad";
};

const MARKETPLACE_INSTALL_HREF = "/admin/provisioning#marketplace-installs";

function MarketplaceInstalls({ apps }: { apps: readonly AgencyInstallSummary[] }) {
  return (
    <Surface className="min-w-0" variant="panel">
      <SurfaceHeader overline="Marketplace installs" />
      <div className="px-[var(--s-4)] pb-[var(--s-3)]">
        <dl className="m-0 grid gap-0">
          {apps.map((entry) => (
            <div
              className="flex flex-wrap items-baseline justify-between gap-x-[var(--s-4)] gap-y-[var(--s-1)] border-b border-[var(--line-soft)] py-[var(--s-2)] last:border-b-0"
              key={entry.app}
            >
              <dt className="t-body m-0 min-w-0 text-[color:var(--body)]">{entry.title}</dt>
              <dd className="m-0 min-w-0">
                <Status
                  className="max-w-full whitespace-normal"
                  label={entry.label}
                  tone={STATE_TONE_TO_TONE[tone(entry.tone)]}
                  treatment="bare"
                />
              </dd>
            </div>
          ))}
        </dl>
        <Link
          className="text-body mt-[var(--s-2)] inline-block font-medium text-[var(--accent-text)] no-underline hover:underline"
          href={MARKETPLACE_INSTALL_HREF}
        >
          Open marketplace installs
        </Link>
      </div>
    </Surface>
  );
}

export function AdminChannelHealth({
  agencyInstalls = null,
  a2pSubmittedAt = null,
  connections,
  templates,
  clients = [],
  clientsUnavailable = false,
  enabled = true,
  nowIso,
  scope = "tenant",
  selectedClientId = null,
  impersonation = null,
}: {
  /**
   * The two agency apps' stored install state, or null when the flag is off or the read did not
   * run. Platform-wide, so it is deliberately not part of the tenant-scoped evidence below.
   */
  agencyInstalls?: readonly AgencyInstallSummary[] | null;
  /** The filed A2P submission receipt, or null when nothing has been filed. */
  a2pSubmittedAt?: string | null;
  connections: ChannelConnectionView[];
  templates: MessageTemplateView[];
  clients?: readonly ChannelHealthClient[];
  clientsUnavailable?: boolean;
  enabled?: boolean;
  /** The clock the day counter reads, stamped by the server so it never drifts per render. */
  nowIso?: string;
  scope?: "tenant" | "unscoped";
  selectedClientId?: string | null;
  impersonation?: { sessionId: string; tenantId: string } | null;
}) {
  const [selectedChannel, setSelectedChannel] = useState<ChannelTruth | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);

  const now = useMemo(() => (nowIso ? new Date(nowIso) : new Date()), [nowIso]);
  // The SMS row is the surface CLAUDE.md names for the carrier wait, so the derivation is handed
  // the filed submission receipt and the same clock the counter renders from. Without it the row
  // read "Not connected" through the entire two-to-three week carrier vetting window.
  const channels = deriveChannelTruths(connections, templates, now, a2pSubmittedAt);
  const review = deriveMetaReviewTruth(null);
  const selectedClient = clients.find((client) => client.id === selectedClientId) ?? null;
  const tenantEvidenceAvailable = enabled
    && scope === "tenant"
    && !clientsUnavailable
    && selectedClient !== null;
  const isDemoScope = tenantEvidenceAvailable
    && (selectedClient.isDemo || channels.some((channel) => channel.templateIsDemo));

  const columns = useMemo<ColumnDef<ChannelTruth>[]>(() => [
    {
      id: "channel",
      accessorFn: (row) => row.label,
      cell: ({ row }) => {
        const Glyph = CHANNEL_GLYPH[row.original.channel];
        return (
          <span className="inline-flex min-w-0 items-center gap-[var(--s-2)]">
            <IconTile size="sm" tone="neutral"><Glyph /></IconTile>
            <span className="min-w-0 truncate">{row.original.label}</span>
          </span>
        );
      },
      header: "Channel",
      meta: { cellKind: "identity", label: "Channel", minWidth: 190 },
    },
    {
      // No state pill: the rows are banded by state, so a column repeating the band heading is
      // the same sentence twice on one line. What earns the space instead is which receipt is
      // still missing, which the band cannot say.
      id: "receipts",
      accessorFn: (row) => receiptPresentation(
        connections.find((candidate) => candidate.channel === row.channel),
      ).label,
      cell: ({ row }) => {
        const connection = connections.find(
          (candidate) => candidate.channel === row.original.channel,
        );
        // A channel with nothing stored has not failed a check, it has never been checked, so it
        // says so in words rather than borrowing the sentence a partial connection earned.
        if (!connection) return <CellQuiet>no connection receipts stored</CellQuiet>;
        const next = nextReceiptNeeded(row.original);
        return (
          <span className="text-[var(--body)]">
            {receiptPresentation(connection).label}
            {next ? (
              <span className="text-[color:var(--faint)]">
                {". "}{next} is the next receipt it needs.
              </span>
            ) : null}
          </span>
        );
      },
      header: "Receipts",
      // 260 was sized for the short sentences ("Signed round trip received") and cut the longest
      // absence string, "no connection receipts stored", mid-word. An absence that reads as a
      // truncated word is worse than no cell at all, so the floor is the widest string this column
      // can print rather than the average one.
      meta: { cellKind: "secondary", label: "Receipts", minWidth: 320 },
    },
    {
      id: "template",
      accessorFn: (row) => row.templateLabel,
      cell: ({ row }) => (
        <Status
          label={row.original.templateLabel}
          tone={STATE_TONE_TO_TONE[tone(row.original.templateTone)]}
          treatment="bare"
        />
      ),
      header: "Template",
      meta: { cellKind: "state", label: "Template", minWidth: 180 },
    },
    {
      id: "window",
      accessorFn: (row) => row.windowLabel,
      cell: ({ row }) => row.original.windowLabel === "No provider window required"
        ? <StatusAbsent label="Not required" />
        : <span className="text-[var(--body)]">{row.original.windowLabel}</span>,
      // Off the default view: it is a provider fact, not a decision, and it read the word
      // "required" three times per row beside two other columns saying the same nothing.
      header: "Provider window",
      meta: { cellKind: "secondary", defaultHidden: true, label: "Provider window" },
    },
    {
      id: "account",
      accessorFn: (row) => row.accountLabel ?? "No saved account",
      cell: ({ row }) => row.original.accountLabel ?? <CellQuiet>no saved account</CellQuiet>,
      header: "Saved account",
      // On by default: a receipt is evidence about one account, and a row that names the state
      // without naming the account it belongs to is the per-tenant claim 5h exists to make,
      // made anonymously.
      meta: { cellKind: "secondary", label: "Saved account", minWidth: 190 },
    },
  ], [connections]);

  // One pass over the rows, and every count on the page reads off it. The strip figures, the rail
  // count and the band headings are then the same derivation rather than three that agree today.
  const grouped = channels.map((channel) => ({
    channel,
    group: channelGroup(
      channel,
      connections.find((candidate) => candidate.channel === channel.channel),
    ),
  }));
  const inGroup = (id: (typeof CHANNEL_GROUPS)[number]["id"]) =>
    grouped.filter((entry) => entry.group === id);
  const channelsNeedingWork = grouped.filter((entry) => entry.group !== "live").length;
  /**
   * Health first, worst first, and every figure is the length of the list banded under the same
   * name in the table below it. There is no send-health sparkline here: nothing on this page reads
   * per-channel send volume, and a chart drawn from no series would be decoration claiming to be
   * evidence.
   */
  const carrierDay = a2pSubmittedAt ? elapsedWorkspaceDays(a2pSubmittedAt, now) : null;
  const healthFigures = [
    ...CHANNEL_GROUPS.map((group) => {
      const members = inGroup(group.id);
      const names = members.map((entry) => entry.channel.label).join(", ");
      /*
       * The waiting figure earns the carrier clock, because "waiting on a provider" without a day
       * count is the sentence that hides a three week wait. It is the elapsed count and the
       * published window and nothing else: no percentage, no predicted decision date, and no
       * count at all when the filing receipt is missing, which is `DayCounter`'s own rule applied
       * to the one line that can print outside it.
       */
      const carrierNote = group.id === "waiting"
        && carrierDay !== null
        && members.some((entry) => entry.channel.channel === "sms")
        ? `${names}, day ${carrierDay} of the carrier's ${CARRIER_TYPICAL_DAYS[0]} to ${CARRIER_TYPICAL_DAYS[1]} day window`
        : null;
      return {
        label: group.label,
        note: carrierNote ?? (members.length > 0 ? names : "No channel is in this state"),
        tone: group.id === "attention"
          ? ("failure" as const)
          : group.id === "waiting"
            ? ("warning" as const)
            : ("good" as const),
        value: members.length,
      };
    }),
    /*
     * The fourth figure, and it counts approvals rather than templates: a template only matters
     * where the provider requires one, and three channels that need none would otherwise read as
     * three missing approvals. 5h also captions this "1 filed with the carrier registration";
     * nothing links a `message_templates` row to an A2P filing, so the note names the channels
     * still short of an approval instead of claiming a filing the schema cannot show.
     */
    (() => {
      const requiring = channels.filter((channel) => channel.templateLabel !== "Not required");
      const approved = requiring.filter((channel) => channel.templateTone === "good");
      const outstanding = requiring.filter((channel) => channel.templateTone !== "good");
      return {
        label: "Templates approved",
        note: requiring.length === 0
          ? "No channel here requires a template"
          : outstanding.length === 0
            ? `Every channel that requires one: ${approved.map((channel) => channel.label).join(", ")}`
            : `Still short: ${outstanding.map((channel) => channel.label).join(", ")}`,
        tone: "neutral" as const,
        value: approved.length,
      };
    })(),
  ];

  const selectedConnection = selectedChannel
    ? connections.find((candidate) => candidate.channel === selectedChannel.channel)
    : undefined;
  const selectedReceipts = receiptPresentation(selectedConnection);

  const body = !enabled ? (
    <DataState
      body="Channel health will appear when direct channel checks are enabled."
      kind="empty"
      title="Channel health is not enabled"
    />
  ) : clientsUnavailable ? (
    <DataState
      body="The client list could not be read. Try the page again before choosing a client."
      kind="unavailable"
      title="Clients could not load"
    />
  ) : scope === "unscoped" ? (
    // The picker sits in the empty state because the empty state is the instruction. It used to
    // say "Choose a client" while the only client picker was 1100px away in the header.
    <div className="flex min-w-0 flex-col gap-[var(--s-3)]">
      <DataState
        body="Choose a client to read its connection receipts, messaging windows, templates, and review work. Nothing here is pooled across clients on purpose, because &ldquo;connected&rdquo; for one of them proves nothing about another."
        kind="empty"
        title="Nothing to inspect yet"
      />
      <ClientPicker clients={clients} selectedClientId={null} />
    </div>
  ) : !selectedClient ? (
    <DataState
      body="The selected client could not be classified, so no tenant-scoped channel evidence was shown."
      kind="unavailable"
      title="Client classification could not be verified"
    />
  ) : (
    <div className="flex min-h-0 min-w-0 flex-col gap-[var(--s-3)]">
      {impersonation ? (
        /*
          The managed strip, which is the surface that says "this is how SetterFi has it set" --
          exactly what an impersonated session is. A card here would read as a thing to act on,
          and the whole point of the banner is that nothing on the page can be acted on.
        */
        <Surface
          className="flex flex-wrap items-center gap-x-[var(--s-3)] gap-y-[var(--s-2)]"
          role="status"
          variant="strip"
        >
          <Status label="Read-only client view" tone="waiting" treatment="bare" />
          <span className="text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
            Connection evidence can be inspected here, but it cannot be changed.
          </span>
        </Surface>
      ) : null}
      <FigureStrip items={healthFigures} label="Channel health" />
      <DataTable
        ariaLabel="Channel receipts"
        columns={columns}
        data={channels}
        emptyState={(
          <DataState
            body="No channel is configured for this client yet."
            kind="empty"
            title="No channels to inspect"
          />
        )}
        exportResource={{
          filename: "setterfi-channel-health",
          mode: "local",
          rows: channels.map((channel) => {
            const connection = connections.find((candidate) => candidate.channel === channel.channel);
            return {
              client: selectedClient?.name ?? "Not selected",
              dataClassification: isDemoScope ? "Demo" : "Real",
              channel: channel.label,
              state: honestChannelState(channel, connection).label,
              receipts: receiptPresentation(connection).label,
              template: channel.templateLabel,
              providerWindow: channel.windowLabel,
              savedAccount: channel.accountLabel ?? "No saved account",
            };
          }),
        }}
        getRowId={(row) => row.channel}
        groupBy={(row) => channelGroup(
          row,
          connections.find((candidate) => candidate.channel === row.channel),
        )}
        groups={CHANNEL_GROUPS}
        onRowOpen={setSelectedChannel}
        rowLabel={{ singular: "channel", plural: "channels" }}
        search={{ columnId: "channel", placeholder: "Search channels" }}
        footerNote="Nothing reads connected until a signed test message comes back."
        /*
          The bands are the order, and they run worst first: a reader scanning down the table meets
          the channels that cannot send before the ones that can. Saying so under the count matters
          here because the rows carry no state pill of their own -- the band is the state, so the
          ordering sentence is the only place the table admits that its top row is not simply the
          first channel alphabetically.
        */
        ordering="banded by receipt state, the channels short of one first"
        testRow={() => isDemoScope}
        testRowLabel="Demo"
        variant="ledger"
      />
      <MessagingWindows channels={channels} connections={connections} />
    </div>
  );

  return (
    <AppShell
      activePath="/admin/channel-health"
      crumbs={CRUMBS}
      /*
       * The rail count is the same number the reader is about to see banded at the top of the
       * table: channels for this client that still have a receipt outstanding. Nothing is counted
       * while no client is chosen, because nothing has been read.
       */
      nav={withWorkspaceNavCounts(workspaceNavigationFor("admin"), {
        "/admin/channel-health": tenantEvidenceAvailable ? channelsNeedingWork : 0,
      })}
      role="admin"
    >
      <ListPage
        // Scope first, then the action, and only the action is filled: the select changes what the
        // page is about, `primaryAction` is the one thing the page wants pressed.
        actions={enabled && !clientsUnavailable && scope === "tenant" ? (
          <ClientPicker clients={clients} selectedClientId={selectedClientId} />
        ) : null}
        description="Read one client at a time. A receipt only means something against the tenant that earned it."
        primaryAction={tenantEvidenceAvailable
          ? { label: "Meta review package", onClick: () => setReviewOpen(true) }
          : undefined}
        provenanceKind={isDemoScope ? "demo" : undefined}
        title="Channel health"
      >
        {agencyInstalls && agencyInstalls.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-[var(--s-3)]">
            <MarketplaceInstalls apps={agencyInstalls} />
            {body}
          </div>
        ) : body}
      </ListPage>

      <RecordSheet
        onOpenChange={(open) => { if (!open) setSelectedChannel(null); }}
        open={selectedChannel !== null}
        sections={selectedChannel ? [
          ...(selectedChannel.channel === "sms" && selectedChannel.tone === "pending" ? [{
            title: "Carrier registration",
            body: a2pSubmittedAt ? (
              <DayCounter now={now} since={a2pSubmittedAt} typicalDays={CARRIER_TYPICAL_DAYS} />
            ) : (
              <p className="t-muted m-0 max-w-[var(--measure-prose)]">
                The day counter appears once the carrier submission receipt is stored. Nothing is
                inferred from the connection row&apos;s own age.
              </p>
            ),
          }] : []),
          ...(selectedReceipts.tone === "good" ? [] : [
            { title: "What the provider said", body: <ChannelCause channel={selectedChannel} now={now} /> },
            { title: "Who this affects", body: <ChannelBlastRadius channel={selectedChannel} /> },
            { title: "The fix", body: <ChannelFix channel={selectedChannel} /> },
          ]),
          { title: "Receipt checks", body: <PrerequisiteList channel={selectedChannel} /> },
          {
            title: "Provider window",
            body: <p className="t-body m-0 text-[var(--body)]">{selectedChannel.windowLabel}</p>,
          },
          {
            title: "Template lifecycle",
            body: (
              <Status
                label={selectedChannel.templateLabel}
                tone={STATE_TONE_TO_TONE[tone(selectedChannel.templateTone)]}
              />
            ),
          },
        ] : []}
        state={selectedChannel ? {
          kind: "lifecycle",
          label: selectedReceipts.label,
          tone: selectedReceipts.tone,
        } : undefined}
        subtitle={selectedChannel?.accountLabel ?? "No saved account"}
        technical={selectedChannel && selectedClientId ? [
          { label: "Client ID", value: selectedClientId },
          ...(impersonation ? [{ label: "Session ID", value: impersonation.sessionId }] : []),
        ] : undefined}
        title={selectedChannel?.label ?? "Channel"}
      />

      <RecordSheet
        onOpenChange={setReviewOpen}
        open={reviewOpen}
        /*
         * The one filled control in the sheet, and it goes where the first step is actually done.
         * Nothing else here is pressable, because nothing else here is a thing this product can
         * do: the other five steps happen in Meta's console and in our own build.
         */
        primaryAction={{ href: META_BUSINESS_MANAGER_URL, label: "Open Business Manager" }}
        sections={[
          {
            title: "The six steps, in order",
            body: (
              <div className="flex flex-col gap-[var(--s-3)]">
                <ReviewChecklist label="Meta app review steps" steps={META_REVIEW_STEPS} />
                <ReviewChecklistUntracked>
                  No step is marked started or finished: this product stores no record of a Meta
                  filing, so the list is the work required, not a report on it.
                </ReviewChecklistUntracked>
              </div>
            ),
          },
          {
            title: "What this holds up",
            body: (
              <div className="flex flex-col gap-[var(--s-3)]">
                <NoteStrip tone="waiting">
                  The last step is Meta&apos;s clock, not ours. Nothing here predicts their decision
                  date, and no day counter runs until a filing reference is stored to count from.
                </NoteStrip>
                {/*
                  * The two-external-clocks doctrine, on the surface that would otherwise imply the
                  * opposite. A reader looking at six blocking steps concludes the build is held;
                  * the contract says an external clock extends only the work it blocks, day for
                  * day, and what this one blocks is the direct Facebook and Instagram connections.
                  */}
                <Prose className="m-0 text-[var(--muted)]">
                  This gates direct Facebook and Instagram connections, which need Advanced Access
                  before a coach can connect their own account. It does not hold the rest of the
                  build, and it does not hold text messaging, which registers on the carriers&apos; own
                  separate clock.
                </Prose>
                {/*
                  * The checklist ends at Meta's decision, so a reader takes approval for the thing
                  * that makes the channel live. It is not: `channel_connections` requires a signed
                  * round trip and both message references before a `meta_direct` row may read
                  * live, and nothing in this repository writes any of the three. The connect route
                  * stamps oauth, asset and subscription receipts and stops at ready. Saying so here
                  * is cheaper than an approved app that still cannot switch a channel on, with
                  * nobody able to say which link is missing.
                  */}
                <Prose className="m-0 text-[var(--muted)]">
                  Approval is not the last link. A direct Meta connection reaches ready and stops
                  there: nothing yet records the signed round trip a live channel requires, so the
                  chain does not close on the decision alone.
                </Prose>
              </div>
            ),
          },
        ]}
        state={{ kind: "lifecycle", label: review.label, tone: tone(review.tone) }}
        subtitle="External prerequisite, six steps in order. Filing stores the provider reference before anything reads filed."
        title="Meta review package"
      />
    </AppShell>
  );
}
