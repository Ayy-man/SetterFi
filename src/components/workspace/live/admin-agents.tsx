"use client";

/**
 * Screen 3a: Agent config, admin.
 *
 * Transcribed from the drawing of this screen: the artifact's three panes are the app
 * rail (already `AppShell`), a list pane, and a detail pane, so this file draws the last two.
 *
 * The drawing's premise is a product SetterFi is not. It shows "Agents · 14 across 8 clients",
 * several named agents per client, each with its own draft and its own publish. `offer_layers` is
 * `unique (tenant_id, version)`, one lineage per coach, and every setter inherits one central
 * brain, so the roster here is one agent per client and the count says so. `agent-roster.ts`
 * carries the reasoning and the columns behind every figure. The departures that show on screen:
 *
 * - **No per-agent booking rate.** The artifact's "44% booked · 312 open threads" pairs a rate the
 *   schema cannot produce with a count it can. The count stays; the rate is absent and the list
 *   says which figure it is showing rather than quietly substituting one.
 * - **Publish is not wired.** This is a presentation pass, so the detail pane states the pending
 *   edits and sends the reader to where the offer is actually edited. That means the page spends
 *   **zero accent fills**, deliberately: there is no live action here to light, and inventing one
 *   would be a control that does nothing. Pinned by a test, so nobody adds a fill without first
 *   adding a real publish.
 * - **Seven tabs became stated answers.** Offer, Tone, Qualifying and Booking are the coach's own
 *   surface at `/coach/agent`; Channels and Escalation are their own admin screens. A second
 *   editor here would have to agree with the first forever, so each card states its answer and
 *   links to the one place that owns it.
 *
 * Honest states throughout: an agent that has never published says so in different words from one
 * that is live with edits pending, because they are different things to chase; a thread count that
 * could not be read says so instead of drawing a zero; and seeded tenants stay in the list wearing
 * their label rather than being dropped.
 */

import { useMemo, useState } from "react";

import {
  IconTile,
  KitInput,
  Monogram,
  MonoMeta,
  Overline,
  ProgressBar,
  Segmented,
  Status,
  StatusDot,
  Surface,
  type Tone,
} from "@/components/kit/atomics";
import { ConsoleRow } from "@/components/kit/console-deck";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { DeckPanel } from "@/components/kit/deck-panel";
import { DataState } from "@/components/kit/data-state";
import { ExportMenu } from "@/components/kit/export-menu";
import type { StatStripItem } from "@/components/kit/stat-strip";
import { PageHeader } from "@/components/kit/page-header";
import { ChatIcon, Circle } from "@/components/kit/icons";
import { wholePageProvenanceKind } from "@/components/kit/provenance-chip";
import { workspaceCountFormat, workspaceDateFormat } from "@/lib/format/datetime";
import type {
  AgentPublishState,
  AgentRoster,
  AgentRosterEntry,
} from "@/lib/operations/agent-roster";

const CRUMBS = [{ label: "Clients" }, { label: "Agents" }] as const;

/** The list filters, and the states each one admits. */
const VIEWS = ["all", "live", "draft"] as const;

type View = (typeof VIEWS)[number];

const VIEW_LABELS: Record<View, string> = {
  all: "All",
  live: "Live",
  draft: "Draft",
};

/**
 * Live is sage, an unpublished agent is violet.
 *
 * Violet is the non-production tone and this is its whole job: a draft agent is not a broken one,
 * so it must not read as a failure, and it is not a working one either, so it must not read as
 * sage. Nothing on a live surface takes violet except this.
 */
const STATE_PRESENTATION: Record<AgentPublishState, { label: string; tone: Tone }> = {
  live: { label: "Live", tone: "good" },
  draft: { label: "Draft", tone: "draft" },
  "never-published": { label: "Never published", tone: "draft" },
};

/**
 * The client's account is paused, so this agent is answering nobody whatever its publish state.
 *
 * Deliberately a separate question from `entry.state`. A paused client can have a perfectly
 * published, perfectly configured agent; it is not broken and it is not a draft, it is switched
 * off by somebody else, and the person to go and talk to is different in each case. Folding it
 * into the publish enum would have made "paused" and "never published" look like the same job.
 */
function isPaused(entry: AgentRosterEntry) {
  return entry.accountState.toLocaleLowerCase() === "paused";
}

function stateMatchesView(entry: AgentRosterEntry, view: View) {
  if (view === "all") return true;
  if (view === "live") return entry.state === "live";
  return entry.state !== "live";
}

/** The sentence under an agent's name in the list. Never a rate the platform cannot produce. */
function listSubline(entry: AgentRosterEntry): string {
  const threads = entry.openThreads === null
    ? "thread count unavailable"
    : `${workspaceCountFormat.format(entry.openThreads)} open ${entry.openThreads === 1 ? "thread" : "threads"}`;
  if (entry.state === "never-published") return `${threads} · not answering yet`;
  if (entry.unpublishedEdits > 0) {
    const edits = workspaceCountFormat.format(entry.unpublishedEdits);
    return `${threads} · ${edits} unpublished ${entry.unpublishedEdits === 1 ? "edit" : "edits"}`;
  }
  return `${threads} · nothing pending`;
}

/**
 * What the agent is doing right now, in a full sentence.
 *
 * The three states are genuinely different work for an admin, so they get three different
 * sentences rather than one sentence and a coloured word.
 */
function stateSentence(entry: AgentRosterEntry): string {
  /*
   * Checked before the publish states on purpose. "Answering leads on version 4" is false while
   * the client is paused, and a sentence that is false is worse than one that is vague.
   */
  if (isPaused(entry)) {
    return entry.state === "live"
      ? `Published on version ${entry.liveVersion}, but this client's account is paused, so the setter is answering nobody. Inbound leads are not being replied to.`
      : "This client's account is paused and the setter has never been published, so nothing is answering leads.";
  }
  if (entry.state === "never-published") {
    return "This setter has never been published, so it has not answered a lead. Nothing it is configured with is live.";
  }
  if (entry.state === "draft") {
    return "This setter has saved edits but has never published, so nothing it is configured with is answering leads yet.";
  }
  if (entry.unpublishedEdits > 0) {
    const edits = workspaceCountFormat.format(entry.unpublishedEdits);
    return `Answering leads on version ${entry.liveVersion}. ${edits} newer ${entry.unpublishedEdits === 1 ? "edit is" : "edits are"} saved and not published, so ${entry.unpublishedEdits === 1 ? "it is" : "they are"} not in anything a lead sees.`;
  }
  return `Answering leads on version ${entry.liveVersion}. Nothing is saved above it.`;
}

function publishedLine(entry: AgentRosterEntry): string {
  if (!entry.publishedAt) return "Not published";
  const date = new Date(entry.publishedAt);
  return Number.isNaN(date.getTime())
    ? "Publish date not recorded"
    : workspaceDateFormat.format(date);
}

/* -------------------------------------------------------------------------------------------- */
/* The list pane                                                                                  */
/* -------------------------------------------------------------------------------------------- */

function AgentListItem({
  entry,
  onSelect,
  selected,
}: {
  entry: AgentRosterEntry;
  onSelect: () => void;
  selected: boolean;
}) {
  const presentation = STATE_PRESENTATION[entry.state];
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className="flex w-full flex-col gap-[5px] rounded-[var(--r-control)] border border-transparent px-[11px] py-[9px] text-left transition-colors duration-[var(--duration-quick)] hover:bg-[var(--quiet)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-reduce:transition-none data-[selected=true]:border-[var(--accent-edge)] data-[selected=true]:bg-[var(--accent-wash)]"
      data-selected={selected ? "true" : undefined}
      data-slot="agent-list-item"
      onClick={onSelect}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-[var(--s-2)]">
        <span className="min-w-0 flex-1 truncate text-[13px] leading-[1.3] font-[600] text-[color:var(--ink)]">
          {entry.clientName}
        </span>
        {/* The list has one status treatment, and it is the bare dot: a column of pills is a
            column of lozenges rather than a column of states. */}
        <Status
          glow={false}
          label={presentation.label}
          tone={presentation.tone}
          treatment="bare"
        />
      </span>
      <span className="block truncate text-[11.5px] leading-[1.4] text-[color:var(--faint)]">
        {listSubline(entry)}
      </span>
      {entry.isTest ? (
        <span className="block text-[11px] leading-[1.4] text-[color:var(--faint)]">
          Seeded test client, excluded from analytics
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The detail pane                                                                                */
/* -------------------------------------------------------------------------------------------- */

/**
 * A setting this screen states but does not own, with the one place that does.
 *
 * Every row here is a link rather than a control on purpose. The coach's own surface already
 * writes these, and a second editor would have to agree with the first forever.
 */
const OWNED_ELSEWHERE = [
  {
    key: "offer",
    title: "Offer and pricing",
    description: "What the setter quotes, and whether it may ever soften the number.",
    href: "/coach/agent",
    where: "The coach's own setter page",
  },
  {
    key: "tone",
    title: "How it sounds",
    description: "The voice the coach chose, and the habits that go with it.",
    href: "/coach/agent",
    where: "The coach's own setter page",
  },
  {
    key: "qualifying",
    title: "Qualifying and disqualifiers",
    description: "The thresholds a lead has to clear, and who is turned away.",
    href: "/coach/agent",
    where: "The coach's own setter page",
  },
  {
    key: "booking",
    title: "Booking rules",
    description: "Call length, notice and the hours leads are offered.",
    href: "/coach/agent",
    where: "The coach's own setter page",
  },
  {
    key: "channels",
    title: "Channels",
    description: "Which inboxes this setter answers, and what the carriers say about them.",
    href: "/admin/channel-health",
    where: "Channel health",
  },
  {
    key: "escalation",
    title: "Escalation",
    description: "What reaches a person, and how quickly it is picked up.",
    href: "/admin/alerts",
    where: "Attention",
  },
] as const;

function InheritanceStrip({
  brainVersion,
  entry,
  settingCount,
}: {
  brainVersion: number | null;
  entry: AgentRosterEntry;
  settingCount: number;
}) {
  const inherited = Math.max(settingCount - entry.overrides, 0);
  const version = brainVersion === null ? null : `v${brainVersion}`;
  return (
    <Surface
      className="flex flex-col gap-[9px] p-[13px_16px]"
      data-slot="inheritance-strip"
      variant="strip"
    >
      <span className="flex flex-wrap items-baseline gap-x-[8px] gap-y-[2px]">
        <MonoMeta>
          {workspaceCountFormat.format(inherited)} of {workspaceCountFormat.format(settingCount)}
        </MonoMeta>
        <span className="text-[12.5px] leading-[1.45] text-[color:var(--body)]">
          {version === null
            ? "settings come from The Brain. Which version is published could not be read, so it is not named here."
            : `settings come from The Brain ${version}. The rest are set on this client's own offer and apply to their setter only.`}
        </span>
      </span>
      <ProgressBar
        height={4}
        label={`${inherited} of ${settingCount} settings inherited from The Brain`}
        tone="accent"
        value={settingCount === 0 ? 0 : inherited / settingCount}
      />
    </Surface>
  );
}

function AgentDetail({
  brainVersion,
  entry,
  settingCount,
}: {
  brainVersion: number | null;
  entry: AgentRosterEntry;
  settingCount: number;
}) {
  const presentation = STATE_PRESENTATION[entry.state];
  const pending = entry.unpublishedEdits > 0;

  return (
    <Surface className="flex min-h-0 min-w-0 flex-col" data-slot="agent-detail" variant="panel">
      <div className="flex flex-wrap items-start gap-[var(--s-3)] border-b border-[var(--line)] px-[18px] py-[16px]">
        <Monogram name={entry.clientName} />
        <div className="min-w-0 flex-1">
          <h2 className="t-section-title m-0 truncate">{entry.clientName}</h2>
          <p className="m-0 mt-[3px] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
            One setter, answering this client&rsquo;s leads.
            {entry.isTest ? " Seeded test client, excluded from analytics." : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-[var(--s-2)]">
          <Status
            label={pending
              ? `${workspaceCountFormat.format(entry.unpublishedEdits)} unpublished`
              : presentation.label}
            tone={pending ? "draft" : presentation.tone}
            treatment="pill"
          />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-[var(--s-3)] overflow-y-auto p-[18px]">
        <Surface className="flex flex-col gap-[10px] p-[15px_17px]" data-slot="agent-state">
          <Overline>What it is doing</Overline>
          <p className="m-0 max-w-[var(--measure-wide)] text-[13px] leading-[1.5] text-[color:var(--body)]">
            {stateSentence(entry)}
          </p>
          <dl className="m-0 mt-[3px] grid gap-[10px] sm:grid-cols-3">
            <div>
              <Overline className="mb-[5px] block">Live version</Overline>
              <dd className="m-0">
                {entry.liveVersion === null ? (
                  <span className="text-[12.5px] italic text-[color:var(--faint)]">
                    nothing published
                  </span>
                ) : (
                  <MonoMeta>v{entry.liveVersion}</MonoMeta>
                )}
              </dd>
            </div>
            <div>
              <Overline className="mb-[5px] block">Published</Overline>
              <dd className="m-0"><MonoMeta>{publishedLine(entry)}</MonoMeta></dd>
            </div>
            <div>
              <Overline className="mb-[5px] block">Open threads</Overline>
              <dd className="m-0">
                {entry.openThreads === null ? (
                  <span className="text-[12.5px] italic text-[color:var(--faint)]">
                    not readable right now
                  </span>
                ) : (
                  <MonoMeta>{workspaceCountFormat.format(entry.openThreads)}</MonoMeta>
                )}
              </dd>
            </div>
          </dl>
        </Surface>

        <InheritanceStrip
          brainVersion={brainVersion}
          entry={entry}
          settingCount={settingCount}
        />

        {/*
          * The publish path is not wired from this screen, so it says so rather than offering a
          * button that would not publish. This is the whole reason the page spends no accent fill.
          */}
        {pending ? (
          <Surface
            className="flex flex-col gap-[8px] p-[14px_16px]"
            data-slot="pending-edits"
            variant="well"
          >
            <span className="flex items-center gap-[7px]">
              <StatusDot tone="draft" />
              <Overline>Waiting to be published</Overline>
            </span>
            <p className="m-0 max-w-[var(--measure-wide)] text-[12.5px] leading-[1.5] text-[color:var(--body)]">
              {workspaceCountFormat.format(entry.unpublishedEdits)}{" "}
              {entry.unpublishedEdits === 1 ? "edit is" : "edits are"} saved above the live version.
              Publishing happens on the client&rsquo;s own offer page, where the change can be
              reviewed against what it replaces. This screen reports the state, it does not
              change it.
            </p>
          </Surface>
        ) : null}

        <div className="flex flex-col gap-[var(--s-2)]">
          <Overline>Where each setting is owned</Overline>
          {OWNED_ELSEWHERE.map((setting) => (
            <a
              className="surface-card is-actionable flex flex-wrap items-center gap-[13px] p-[13px_16px] no-underline transition-[border-color] duration-[var(--duration-quick)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] motion-reduce:transition-none"
              data-slot="owned-elsewhere"
              href={setting.href}
              key={setting.key}
            >
              <IconTile tone="neutral">
                {setting.key === "channels" ? <ChatIcon aria-hidden /> : <Circle aria-hidden />}
              </IconTile>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] leading-[1.3] font-[600] text-[color:var(--ink)]">
                  {setting.title}
                </span>
                <span className="block text-[12px] leading-[1.45] text-[color:var(--muted)]">
                  {setting.description}
                </span>
              </span>
              <MonoMeta className="shrink-0">{setting.where}</MonoMeta>
            </a>
          ))}
        </div>
      </div>
    </Surface>
  );
}

/* -------------------------------------------------------------------------------------------- */
/* The surface                                                                                    */
/* -------------------------------------------------------------------------------------------- */

export function AdminAgentsUnavailable({ reason }: { reason: string }) {
  return <DataState body={reason} kind="unavailable" title="Agents unavailable" />;
}

export function AdminAgentsSurface({ roster }: { roster: AgentRoster }) {
  const [view, setView] = useState<View>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    roster.entries[0]?.tenantId ?? null,
  );

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return roster.entries.filter((entry) =>
      stateMatchesView(entry, view)
      && (needle === "" || entry.clientName.toLocaleLowerCase().includes(needle)),
    );
  }, [query, roster.entries, view]);

  const selected = roster.entries.find((entry) => entry.tenantId === selectedId)
    ?? visible[0]
    ?? null;

  /*
   * The roster carries `isTest` per client and said so only in the row. Where the whole fleet is
   * seeded that per-row tag distinguishes nothing, so the claim moves up to the chip; where a real
   * client is on the list the row tag is the honest form and the head stays bare.
   */
  const rosterProvenanceKind = wholePageProvenanceKind(
    roster.entries,
    (entry) => (entry.isTest ? "test" : null),
  );

  const liveCount = roster.entries.filter((entry) => entry.state === "live").length;
  const pendingCount = roster.entries.filter((entry) => entry.unpublishedEdits > 0).length;
  const neverCount = roster.entries.filter((entry) => entry.state === "never-published").length;
  const pausedCount = roster.entries.filter(isPaused).length;
  /*
   * The queue the canvas calls "Waiting on somebody": every agent that is not answering leads, and
   * the reason it is not, ordered so the never-published ones lead. This is the whole point of the
   * screen -- an unpublished or switched-off agent caught before a lead meets it -- and it was
   * previously only discoverable by working the filter segments one at a time.
   */
  /*
   * The export carries the whole roster, not the filtered view, and it says which figures the
   * platform does not have rather than leaving a reader to assume the columns are all there is.
   * `openThreads` is written as an empty cell when it could not be read, never as a zero.
   */
  const exportRows = roster.entries.map((entry) => ({
    client: entry.clientName,
    publish_state: entry.state,
    account_state: entry.accountState,
    live_version: entry.liveVersion ?? "",
    published_at: entry.publishedAt ?? "",
    unpublished_edits: entry.unpublishedEdits,
    latest_edit_at: entry.latestEditAt ?? "",
    open_threads: entry.openThreads ?? "",
    settings_overridden: entry.overrides,
    settings_inherited: Math.max(roster.settingCount - entry.overrides, 0),
    brain_version: roster.brainVersion ?? "",
    test_data: entry.isTest,
  }));

  const waiting = roster.entries.filter(
    (entry) => entry.state !== "live" || isPaused(entry),
  );

  /*
   * The strip the canvas draws over this screen, at console scale.
   *
   * `AdminAgents.dc.html:240-259` puts four figures here -- published and live, draft never
   * published, paused by the client, and grounding refusals in 24h. **Three of the four are real
   * and one is substituted**, and it is worth saying which, because the reason has changed once
   * already and a stale reason here is what argues a working tile back out again.
   *
   * Live (`:518`) and never-published (`:523`) come straight off `AgentPublishState`. Paused
   * (`:528`) is real too, and it is *not* on that enum: `isPaused` at `:99` reads
   * `entry.accountState`, deliberately a separate question, so a paused client with a perfectly
   * published agent is not miscounted as a draft. An earlier version of this comment claimed
   * there was no paused state at all and that two of the four were unavailable; that was true
   * before `isPaused` existed, it survived the tile going live, and a round-3 audit read the
   * sentence rather than the code and recorded the drawn tile as refused.
   *
   * Only "Grounding refusals, 24h" is substituted, by "Edits not published". No refusal counter
   * is joined to the roster, and the `platform.*` metric keys carry none either, so drawing the
   * drawn label over whatever number is nearest is how a chart starts lying.
   *
   * The rule this is an instance of: a refusal comment names the column that is missing, so it
   * has to be re-read against the schema whenever the schema moves. A justification nobody
   * re-checks outranks the code in every audit that follows it.
   *
   * The deck spends no drench, which matches this page's standing rule: publishing is not wired
   * from here, so there is nothing on the page that acts, and a saturated panel would be emphasis
   * pointing at nothing. `admin-agents.test.tsx` pins the same rule for filled buttons.
   */
  const tiles: StatStripItem[] = [
    {
      label: "Published and live",
      availability: { kind: "value", value: liveCount, format: "count" },
      note: "Answering leads right now, on a published version.",
    },
    {
      label: "Never published",
      availability: { kind: "value", value: neverCount, format: "count" },
      note: "A coach configured a setter and stopped. No lead has met these.",
    },
    {
      label: "Paused by the client",
      availability: { kind: "value", value: pausedCount, format: "count" },
      note: "The account is switched off, so a published setter is still answering nobody.",
    },
    {
      label: "Edits not published",
      availability: { kind: "value", value: pendingCount, format: "count" },
      note: "Saved above the live version, so nothing a lead sees carries them yet.",
    },
  ];

  return (
    <>
      <PageHeader
        /*
         * Every table in the product exports CSV and JSON, and this one did not. That is a hard
         * rule rather than a nicety: an operator chasing eight unpublished agents across a
         * spreadsheet is the actual job, and a screen that can only be read is a screen whose
         * contents get retyped.
         *
         * `mode="local"` rather than a server resource. The roster is already fully in the
         * browser, so a local export carries exactly what the reader can see and needs no new
         * entry in the closed `ExportResource` union, no column whitelist and no feature gate --
         * all of which a server resource requires and all of which are pinned by
         * `src/app/api/exports/routes.test.ts`. `admin-inbox.tsx` sets the same precedent.
         */
        actions={<ExportMenu filename="setterfi-agent-roster" mode="local" rows={exportRows} />}
        crumbs={[...CRUMBS]}
        description={
          /*
           * The canvas's sentence, which says what the screen is for, followed by the counts the
           * old one led with. The counts were doing real work -- a reader who cannot see how many
           * clients there are wonders where the other agents went -- so they are kept rather than
           * replaced, and the purpose now comes first.
           */
          "One setter per client. This is where an unpublished or drifting agent gets caught"
          + " before a lead meets it. "
          + `${workspaceCountFormat.format(roster.entries.length)} ${roster.entries.length === 1 ? "client" : "clients"}, ${workspaceCountFormat.format(liveCount)} answering leads`
          + `${pendingCount > 0 ? `, ${workspaceCountFormat.format(pendingCount)} with edits saved and not published` : ""}.`
        }
        provenanceKind={rosterProvenanceKind ?? undefined}
        title="Agents"
      />

      <ConsoleStatDeck
        ariaLabel="Fleet figures"
        className="mb-[var(--s-4)]"
        items={tiles}
      />

      {/*
        * "Waiting on somebody": every agent that is not answering leads, in one place.
        *
        * `ConsoleRow` requires a sentence beside the name and that requirement is the reason this
        * panel is worth having. "Pinnacle Credit Lab" in amber tells an operator something is
        * wrong and not which thing; "the coach saved edits and never published" and "the account
        * is paused" are the same colour and completely different jobs, with different people to go
        * and chase. The panel is absent rather than empty when nothing is waiting, because an
        * empty queue is good news and a headed empty box reads as a broken read.
        */}
      {waiting.length > 0 ? (
        <DeckPanel
          className="mb-[var(--s-4)]"
          dataSlot="agents-waiting"
          eyebrow={`${workspaceCountFormat.format(waiting.length)} ${waiting.length === 1 ? "agent is" : "agents are"} not answering leads`}
          headingId="agents-waiting-heading"
          name="Waiting on somebody"
        >
          {waiting.map((entry) => (
            <ConsoleRow
              key={entry.tenantId}
              mark={<StatusDot tone={isPaused(entry) ? "warning" : "draft"} />}
              name={entry.clientName}
              sentence={stateSentence(entry)}
              trailing={(
                <MonoMeta>
                  {isPaused(entry)
                    ? "Paused"
                    : entry.state === "never-published" ? "Never published" : "Draft"}
                </MonoMeta>
              )}
            />
          ))}
        </DeckPanel>
      ) : null}

      <div
        className="@container/agents grid min-h-0 flex-1 gap-[var(--s-3)] @3xl/agents:grid-cols-[266px_minmax(0,1fr)]"
        data-slot="agents-panes"
      >
        <Surface className="flex min-h-0 min-w-0 flex-col" data-slot="agent-list" variant="panel">
          <div className="flex flex-col gap-[var(--s-2)] border-b border-[var(--line)] px-[13px] py-[12px]">
            <span className="flex items-baseline justify-between gap-[var(--s-2)]">
              <span className="text-[13px] font-[600] text-[color:var(--ink)]">Agents</span>
              <MonoMeta>
                {workspaceCountFormat.format(roster.entries.length)},{" "}
                one per client
              </MonoMeta>
            </span>
            <KitInput
              aria-label="Search agents"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search agents"
              value={query}
            />
            {/* Every segment carries its own count, which is the redesign's rule for a filter:
                a tab that cannot say how much is behind it makes the reader click to find out. */}
            <Segmented
              fill
              label="Agent view"
              onValueChange={(next) => setView(next as View)}
              options={VIEWS.map((key) => ({
                key,
                label: VIEW_LABELS[key],
                count: workspaceCountFormat.format(
                  roster.entries.filter((entry) => stateMatchesView(entry, key)).length,
                ),
                tone: key === "draft" && pendingCount > 0 ? ("draft" as const) : undefined,
              }))}
              value={view}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col gap-[2px] overflow-y-auto p-[7px]">
            {visible.length === 0 ? (
              <p className="m-0 px-[11px] py-[14px] text-[12.5px] leading-[1.45] text-[color:var(--muted)]">
                No agent matches this view.
              </p>
            ) : (
              visible.map((entry) => (
                <AgentListItem
                  entry={entry}
                  key={entry.tenantId}
                  onSelect={() => setSelectedId(entry.tenantId)}
                  selected={selected?.tenantId === entry.tenantId}
                />
              ))
            )}
          </div>
        </Surface>

        {selected ? (
          <AgentDetail
            brainVersion={roster.brainVersion}
            entry={selected}
            settingCount={roster.settingCount}
          />
        ) : (
          <Surface className="flex min-h-0 min-w-0 flex-col" variant="panel">
            <div className="flex flex-1 items-center justify-center p-[var(--s-5)]">
              <p className="m-0 max-w-[var(--measure-tight)] text-center text-[12.5px] leading-[1.5] text-[color:var(--muted)]">
                No client has a setter yet. An agent appears here as soon as a client has an offer
                layer, published or not.
              </p>
            </div>
          </Surface>
        )}
      </div>
    </>
  );
}
