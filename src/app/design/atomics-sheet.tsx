"use client";

import { useState } from "react";

import {
  AddChipButton,
  AxisTicks,
  BarSparkline,
  Chip,
  CollapsedSettingCard,
  Figure,
  FunnelBars,
  GridTable,
  GridTableCell,
  GridTableFooter,
  GridTableHead,
  GridTableIdentity,
  GridTableRow,
  HeatRow,
  IconTile,
  KeyValueList,
  KitButton,
  KitInput,
  KitToggle,
  Legend,
  MetricCard,
  MonoMeta,
  Monogram,
  NoteStrip,
  Overline,
  ProgressBar,
  QueueItem,
  Segmented,
  SelectShell,
  SettingGroup,
  SettingRow,
  SettingSection,
  SplitBar,
  Status,
  StatusAbsent,
  StatusDot,
  Surface,
  SurfaceHeader,
  TONES,
  UnassignedMark,
  UnderlineTabs,
  ValueReadout,
  type Tone,
} from "@/components/kit/atomics";
import { DayCounter } from "@/components/kit/day-counter";
import { StepJourney, type JourneyStep } from "@/components/kit/step-journey";
import {
  Bell,
  CalendarCheck,
  Circle,
  CircleAlert,
  Clock,
  Inbox,
  SlidersHorizontal,
  Sparkle,
  UserRound,
} from "@/components/kit/icons";

/** Every tone, in the order the tone contract declares them, so a missing one is visible. */
const ALL_TONES: readonly Tone[] = TONES;

/**
 * The A2P fixture, and the reason it is the one on the sheet: its current step is owned by the
 * carrier and its actionable step is not the current one. A happy-path journey where the two
 * coincide is exactly what hid the accent-on-the-wrong-step bug, so the sheet demonstrates the
 * case that pulls them apart.
 */
const A2P_JOURNEY: readonly JourneyStep[] = [
  {
    body: "Your business details went to the carriers for vetting.",
    key: "submitted",
    owner: "setterfi",
    receipt: { at: "2026-08-21T16:00:00.000Z", label: "Submitted to the carrier" },
    state: "done",
    title: "Register the number",
  },
  {
    body: "The carriers review every campaign by hand. Nothing here is ours to hurry.",
    key: "vetting",
    owner: "carrier",
    state: "current",
    title: "Carrier vetting",
    wait: { since: "2026-08-21T16:00:00.000Z", typicalDays: [14, 21] },
  },
  {
    action: { href: "#consent", label: "Confirm consent page" },
    body: "Check the wording on the page where leads opt in, and confirm it is live.",
    key: "consent",
    owner: "you",
    state: "waiting",
    title: "Confirm consent page",
  },
  {
    action: { label: "Send a test message" },
    body: "Once the carrier clears the campaign, we send one message end to end.",
    key: "test",
    owner: "you",
    state: "blocked",
    title: "Send a test message",
  },
]

/** Pinned so the sheet's day counts are stable rather than drifting with the wall clock. */
const DEMO_NOW = new Date("2026-08-30T12:00:00.000Z");

function Section({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <section className="flex flex-col gap-[var(--s-3)]" data-section={title}>
      <Overline as="h2" className="m-0">
        {title}
      </Overline>
      {children}
    </section>
  );
}

/** A labelled specimen: the thing, with the words for what it is underneath. */
function Specimen({ children, note }: { children: React.ReactNode; note: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-2)]">
      <div className="flex min-w-0 flex-wrap items-center gap-[10px]">{children}</div>
      <MonoMeta className="text-[10.5px]">{note}</MonoMeta>
    </div>
  );
}

export function AtomicsSheet() {
  const [period, setPeriod] = useState("30D");
  const [view, setView] = useState("all");
  const [tab, setTab] = useState("conversation");
  const [quietHours, setQuietHours] = useState(true);
  const [expanded, setExpanded] = useState(false);

  return (
    <main
      className="min-h-dvh [background:var(--pane-bloom),var(--canvas)] px-[var(--s-6)] py-[var(--s-8)] text-[color:var(--body)]"
      data-slot="atomics-sheet"
    >
      <div className="mx-auto flex max-w-[1120px] flex-col gap-[var(--s-8)]">
        <header>
          <h1 className="m-0 mb-[6px] text-[25px] leading-[1.2] font-[600] tracking-[-0.02em] text-[color:var(--ink)]">
            Atomics
          </h1>
          <p className="m-0 max-w-[var(--measure-prose)] text-[13.5px] leading-[1.55] text-[color:var(--muted)] text-pretty">
            Every primitive the admin screens are built from, in every variant it has, including the
            states a happy path never renders. If a state is not here, no screen should be inventing
            it.
          </p>
        </header>

        {/* ------------------------------------------------------- surface ladder */}
        <Section title="Surface ladder">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-[12px]">
            <div className="flex h-[92px] items-end rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--canvas)] p-[10px]">
              <MonoMeta className="text-[11px]">canvas</MonoMeta>
            </div>
            <Surface className="flex h-[92px] items-end" variant="card">
              <MonoMeta className="text-[11px]">card</MonoMeta>
            </Surface>
            <Surface className="flex h-[92px] items-end" tone="accent" variant="card">
              <MonoMeta className="text-[11px]">card, accent frame</MonoMeta>
            </Surface>
            <Surface className="flex h-[92px] items-end" tone="failure" variant="card">
              <MonoMeta className="text-[11px]">card, failure frame</MonoMeta>
            </Surface>
            <Surface className="flex h-[92px] items-end" variant="well">
              <MonoMeta className="text-[11px]">well</MonoMeta>
            </Surface>
            <Surface className="flex h-[92px] items-end" variant="strip">
              <MonoMeta className="text-[11px]">strip</MonoMeta>
            </Surface>
            <Surface className="flex h-[92px] items-end p-[10px]" open variant="card">
              <MonoMeta className="text-[11px]">card, open</MonoMeta>
            </Surface>
          </div>
          <Surface variant="panel">
            <SurfaceHeader
              overline="Queue"
              subtitle="A panel gives up its padding to whatever it holds."
              title="Panel with a header"
              trailing={<KitButton size="sm">Action</KitButton>}
            />
            <div className="p-[var(--s-4)]">
              <MonoMeta>panel body</MonoMeta>
            </div>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- status */}
        <Section title="Status — two treatments, seven tones">
          <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
            <Specimen note="tinted pill · glow on warning and failure only">
              {ALL_TONES.map((tone) => (
                <Status key={tone} label={tone} tone={tone} treatment="pill" />
              ))}
            </Specimen>
            <Specimen note="pill with mono detail">
              <Status detail="2d" label="Open request" tone="warning" />
              <Status detail="retry 2 of 4" label="Past due" tone="failure" />
              <Status detail="12 edits" label="Draft" tone="draft" />
              <Status detail="since Tue" label="Waiting on coach" tone="waiting" />
            </Specimen>
            <Specimen note="bare dot · the dense-table treatment">
              {ALL_TONES.map((tone) => (
                <Status key={tone} label={tone} tone={tone} treatment="bare" />
              ))}
            </Specimen>
            <Specimen note="glow suppressed · a page that already spent its glow">
              <Status glow={false} label="Open request" tone="warning" />
              <Status glow={false} label="Breaching" tone="failure" />
            </Specimen>
            <Specimen note="dots alone, and the absence that is not a status">
              {ALL_TONES.map((tone) => (
                <StatusDot key={tone} size={6} tone={tone} />
              ))}
              <StatusAbsent label="No request" />
            </Specimen>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- icon tiles and marks */}
        <Section title="Icon tiles, monograms, the empty seat">
          <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
            <Specimen note="four sizes: 22 / 26 / 28 / 33">
              <IconTile size="xs"><Circle /></IconTile>
              <IconTile size="sm"><Clock /></IconTile>
              <IconTile size="md"><Inbox /></IconTile>
              <IconTile size="lg"><SlidersHorizontal /></IconTile>
            </Specimen>
            <Specimen note="tinted by the state of the card it leads, not by what it depicts">
              {ALL_TONES.map((tone) => (
                <IconTile key={tone} tone={tone}>
                  <CircleAlert />
                </IconTile>
              ))}
            </Specimen>
            <Specimen note="account monogram, person monogram, the seat nobody is in">
              <Monogram name="Elevate Funding Co." />
              <Monogram kind="person" name="Dana Whitfield" />
              <Monogram kind="person" name="Ayman" size={34} />
              <UnassignedMark />
            </Specimen>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- buttons and inputs */}
        <Section title="Buttons and inputs">
          <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
            <Specimen note="one primary per page, at most, and often zero">
              <KitButton size="lg" variant="primary">Publish</KitButton>
              <KitButton size="lg" variant="secondary">Export</KitButton>
              <KitButton size="lg" variant="ghost">Cancel</KitButton>
              <KitButton size="lg" variant="soft">Assign owner</KitButton>
              <KitButton size="lg" variant="destructive">Restart agent</KitButton>
            </Specimen>
            <Specimen note="three heights: 26 / 30 / 34">
              <KitButton size="sm">Snooze</KitButton>
              <KitButton size="md">Snooze</KitButton>
              <KitButton size="lg">Snooze</KitButton>
            </Specimen>
            <Specimen note="disabled, and the dashed add">
              <KitButton disabled variant="primary">Publish</KitButton>
              <KitButton disabled>Export</KitButton>
              <AddChipButton />
            </Specimen>
            <Specimen note="input at rest, invalid, and a select stating what it holds">
              <KitInput
                defaultValue=""
                leading={<Circle />}
                placeholder="Search clients, agents, invoices"
                shellClassName="w-[260px]"
              />
              <KitInput defaultValue="not a number" invalid shellClassName="w-[180px]" />
              <SelectShell value="Direct, no emoji" />
              <SelectShell needsValue value="Choose owner" />
            </Specimen>
            <Specimen note="chips, and the toggle that has exactly two states">
              <Chip>not interested</Chip>
              <Chip onRemove={() => undefined}>wrong number</Chip>
              <Chip selected>Support: open</Chip>
              <KitToggle checked={quietHours} label="Quiet hours" onCheckedChange={setQuietHours} />
              <KitToggle checked={!quietHours} label="Inverse example" onCheckedChange={(next) => setQuietHours(!next)} />
              <ValueReadout>1.7</ValueReadout>
            </Specimen>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- type */}
        <Section title="Type — Archivo for prose, Plex Mono for every number">
          <Surface className="flex flex-wrap items-end gap-[28px]" variant="card">
            <Specimen note="figure sm / md / lg / xl">
              <Figure size="sm">$1,490</Figure>
              <Figure size="md">37%</Figure>
              <Figure size="lg">4,812</Figure>
              <Figure size="xl">$96,420</Figure>
            </Specimen>
            <Specimen note="a toned figure is a claim that this one is the problem">
              <Figure size="lg" tone="failure">1,284</Figure>
              <Figure size="lg" tone="good">37%</Figure>
              <Figure size="lg" tone="warning">3</Figure>
            </Specimen>
            <Specimen note="overline, mono meta, toned mono meta">
              <Overline>Total leads</Overline>
              <MonoMeta>Aug 29 · 16:37</MonoMeta>
              <MonoMeta tone="failure">retry Aug 31</MonoMeta>
            </Specimen>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- metrics */}
        <Section title="KPI tiles">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-[13px]">
            <MetricCard
              footer={<BarSparkline label="Total leads, last 7 days" points={[30, 52, 41, 70, 58, 88, 100]} />}
              note="vs prior period"
              overline="Total leads"
              value="4,812"
            />
            <MetricCard
              delta="+4pts"
              footer={<ProgressBar label="Booking rate, 1,780 of 4,812" tone="good" value={0.37} />}
              icon={<CalendarCheck />}
              note="1,780 of 4,812"
              overline="Booking rate"
              tone="good"
              value="37%"
            />
            <MetricCard
              glow
              icon={<Bell />}
              note="oldest 2d 4h"
              overline="Open requests"
              tone="warning"
              value="3"
            />
            <MetricCard
              glow
              icon={<CircleAlert />}
              note="nobody owns these"
              overline="Unassigned"
              tone="failure"
              value="7"
            />
            <MetricCard
              icon={<Clock />}
              note="12 unpublished edits"
              overline="Draft agents"
              tone="draft"
              value="2"
            />
            <MetricCard
              icon={<UserRound />}
              note="waiting on the coach"
              overline="Blocked on client"
              tone="waiting"
              value="5"
            />
          </div>
        </Section>

        {/* ------------------------------------------------------- charts */}
        <Section title="Trends, proportions, funnels">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-[13px]">
            <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
              <Specimen note="bar sparkline · accent, good, failure, and a series too short to draw">
                <BarSparkline className="w-[130px]" label="Leads" points={[38, 50, 44, 66, 78, 92, 100]} />
                <BarSparkline className="w-[130px]" label="Booked" points={[38, 50, 44, 66, 78, 92, 100]} tone="good" />
                <BarSparkline className="w-[130px]" label="Collapsing" points={[82, 74, 60, 44, 30, 18, 12]} tone="failure" />
                <MonoMeta>{"[one point renders nothing]"}</MonoMeta>
                <BarSparkline label="Too short" points={[4]} />
              </Specimen>
              <Specimen note="heat row · same height, opacity is the value">
                <div className="w-full">
                  <HeatRow label="Bookings by hour" points={[2, 3, 7, 12, 18, 23, 15, 10, 13, 8, 4, 2]} />
                  <AxisTicks className="mt-[8px]" ticks={["6a", "10a", "2p", "6p", "10p"]} />
                </div>
              </Specimen>
            </Surface>
            <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
              <Specimen note="progress bar · four heights, every tone">
                <div className="flex w-full flex-col gap-[8px]">
                  <ProgressBar height={4} label="Rollout checklist, 4 of 6" value={0.66} />
                  <ProgressBar height={6} label="Booking rate" tone="good" value={0.37} />
                  <ProgressBar height={8} label="Send volume" tone="warning" value={0.62} />
                  <ProgressBar height={8} label="Failed sends" tone="failure" value={0.11} />
                  <ProgressBar height={8} label="Out of range, clamped" value={4.2} />
                </div>
              </Specimen>
              <Specimen note="split bar and its legend">
                <div className="flex w-full flex-col gap-[11px]">
                  <SplitBar
                    label="MRR movement this month"
                    segments={[
                      { label: "New", tone: "good", value: 7900 },
                      { label: "Upgrades", secondary: true, tone: "good", value: 3480 },
                      { label: "Churn", tone: "failure", value: 3220 },
                      { label: "Downgrades", secondary: true, tone: "failure", value: 1980 },
                    ]}
                  />
                  <Legend
                    items={[
                      { label: "New", tone: "good", value: "+7,900" },
                      { label: "Upgrades", tone: "good", value: "+3,480" },
                      { label: "Churn", tone: "failure", value: "−3,220" },
                      { label: "Downgrades", tone: "failure", value: "−1,980" },
                    ]}
                  />
                </div>
              </Specimen>
              <Specimen note="funnel · every share computed from the steps themselves">
                <div className="w-full">
                  <FunnelBars
                    steps={[
                      { label: "Contacted", value: 4812 },
                      { label: "Replied", value: 3940 },
                      { label: "Qualified", value: 2610 },
                      { label: "Booked", tone: "good", value: 1780 },
                    ]}
                  />
                </div>
              </Specimen>
            </Surface>
          </div>
        </Section>

        {/* ------------------------------------------------------- switches */}
        <Section title="Segmented controls and tabs">
          <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
            <Specimen note="mono face · the period switch">
              <Segmented
                face="mono"
                label="Period"
                onValueChange={setPeriod}
                options={[{ key: "7D", label: "7D" }, { key: "14D", label: "14D" }, { key: "30D", label: "30D" }, { key: "90D", label: "90D" }]}
                value={period}
              />
            </Specimen>
            <Specimen note="sans face · a view switch, with one toned segment carrying its count">
              <Segmented
                label="Views"
                onValueChange={setView}
                options={[
                  { key: "all", label: "All" },
                  { count: 8, key: "attention", label: "Needs attention", tone: "warning" },
                  { key: "mine", label: "Mine" },
                ]}
                value={view}
              />
            </Specimen>
            <Specimen note="fill · equal segments in a narrow column">
              <div className="w-[238px]">
                <Segmented
                  fill
                  label="Agent state"
                  onValueChange={setView}
                  options={[{ key: "all", label: "All" }, { key: "live", label: "Live" }, { key: "draft", label: "Draft" }]}
                  value={view}
                />
              </div>
            </Specimen>
            <div className="w-full">
              <UnderlineTabs
                label="Agent sections"
                onValueChange={setTab}
                tabs={[
                  { key: "offer", label: "Offer" },
                  { key: "tone", label: "Tone" },
                  { key: "conversation", label: "Conversation" },
                  { key: "qualifying", label: "Qualifying" },
                  { key: "booking", label: "Booking" },
                ]}
                value={tab}
              />
              <MonoMeta className="mt-[var(--s-2)] block text-[10.5px]">underline tabs · no pill, no fill</MonoMeta>
            </div>
          </Surface>
        </Section>

        {/* ------------------------------------------------------- settings rows */}
        <Section title="Settings row kit — label left, control right">
          <SettingGroup>
            <SettingRow
              control={<KitToggle checked={quietHours} label="Quiet hours" onCheckedChange={setQuietHours} />}
              description="One decision, on or off."
              icon={<Circle />}
              title="Toggle"
            />
            <SettingRow
              control={
                <>
                  <ProgressBar className="w-[130px]" label="First reply delay" value={0.34} />
                  <ValueReadout>1.7</ValueReadout>
                </>
              }
              description="Bounded number you tune by feel."
              icon={<SlidersHorizontal />}
              title="Slider with readout"
            />
            <SettingRow
              control={<SelectShell value="Direct, no emoji" />}
              description="One of a known list."
              icon={<Inbox />}
              title="Select"
            />
            <SettingRow
              control={
                <Segmented
                  label="Objection handling"
                  onValueChange={setView}
                  options={[{ key: "all", label: "Off" }, { key: "live", label: "Soft" }, { key: "draft", label: "Hard" }]}
                  value={view}
                />
              }
              description="Two or three options, always visible."
              icon={<CalendarCheck />}
              title="Segmented"
            />
            <SettingRow
              align="start"
              control={
                <>
                  <Chip>not interested</Chip>
                  <Chip>wrong number</Chip>
                  <AddChipButton />
                </>
              }
              description="Open-ended list the user grows."
              icon={<Bell />}
              title="Tag input"
            />
            <SettingRow
              control={<Status label="on" tone="good" treatment="bare" />}
              description="Most rows in a done-for-you product state what SetterFi already chose. A settled decision is a sentence, never a disabled control."
              icon={<Clock />}
              title="Stated value, no control"
            />
            <SettingRow
              control={<SelectShell needsValue value="Choose owner" />}
              description="Blocks publish until it is set."
              icon={<CircleAlert />}
              title="Needs a value"
              tone="failure"
            />
            <SettingRow
              control={<Status label="Waiting on coach" tone="waiting" />}
              description="We asked, they have not answered, and the clock is theirs."
              icon={<UserRound />}
              title="Waiting on someone else"
              tone="waiting"
            />
          </SettingGroup>

          <CollapsedSettingCard
            description="What it quotes, what it can discount, and what it must never promise."
            expanded={expanded}
            onToggle={() => setExpanded((open) => !open)}
            summary="$4k setup · $1.5k/mo · no discounts"
            title="Offer and pricing"
          />
          <CollapsedSettingCard
            description="Who picks up the thread when the agent gives up, and how fast."
            summary={<Status label="no owner set" tone="warning" treatment="bare" />}
            title="Escalation and handoff"
            tone="warning"
          />

          {/*
            The open half of the same accordion: the header sits on the section's own face and the
            rows attach to it, rather than a collapsed card with a second card stacked underneath.
          */}
          <SettingSection
            description="Where these notices reach you. One of them is required and stays on."
            expanded
            summary="2 bell · 0 email"
            title="Bookings"
          >
            <SettingRow
              control={<Status label="on" tone="good" treatment="bare" />}
              description="A lead booked an appointment."
              icon={<CalendarCheck />}
              iconTone="neutral"
              title="Appointment booked"
            />
            <SettingRow
              control={<Status label="on" tone="good" treatment="bare" />}
              description="An appointment moved to a new slot."
              icon={<CalendarCheck />}
              iconTone="accent"
              title="Appointment rescheduled"
            />
          </SettingSection>
        </Section>

        {/* ------------------------------------------------------- notes and queues */}
        <Section title="Notes and the attention queue">
          <NoteStrip action={<KitButton size="sm" variant="ghost">Open the Brain</KitButton>} icon={<Sparkle />}>
            9 of 14 settings come from <strong className="font-[600] text-[color:var(--ink)]">The Brain v18</strong>.
            Anything you change here overrides it for this agent only.
          </NoteStrip>
          <NoteStrip icon={<CircleAlert />} tone="warning">
            SMS is still registering with the carriers. Day 9 of a 2 to 3 week vetting window.
          </NoteStrip>
          <NoteStrip icon={<CircleAlert />} tone="failure">
            Three agents stopped replying in the last hour and nobody has picked them up.
          </NoteStrip>

          <Surface variant="panel">
            <SurfaceHeader overline="Queue" />
            <QueueItem
              actions={
                <>
                  <KitButton size="sm" variant="destructive">Restart agent</KitButton>
                  <KitButton size="sm">Assign</KitButton>
                </>
              }
              clock="41m over"
              context="Reid Funding Group · Closer agent · 38 leads waiting"
              title="Agent stopped replying"
              tone="failure"
            />
            <QueueItem
              clock="4h 10m"
              context="Measurement Review Workspace · since calendar change Tue"
              title="Booking rate fell 18pts"
              tone="warning"
            />
            <QueueItem
              clock="2d"
              context="Northstar Capital Coaching · 4 docs older than 90 days"
              title="Knowledge base stale"
              tone="waiting"
            />
            <QueueItem
              cleared
              clock="cleared"
              context="Elevate Funding Co. · resolved by Dana Whitfield"
              title="Escalation unanswered"
              tone="good"
            />
          </Surface>

          <Surface className="max-w-[360px]" variant="well">
            <Overline className="mb-[10px] block">Blast radius</Overline>
            <KeyValueList
              rows={[
                { label: "Leads waiting", tone: "failure", value: "38" },
                { label: "Oldest wait", value: "3h 19m" },
                { label: "Est. bookings lost", tone: "warning", value: "14" },
              ]}
            />
          </Surface>
        </Section>

        {/* ------------------------------------------------------- shared kit under audit */}
        <Section title="Waiting: the day counter and the journey">
          <Surface className="flex flex-col gap-[var(--s-4)]" variant="card">
            <Specimen note="a real elapsed-day count, in mono beside the mono meta around it">
              <div className="w-full">
                <DayCounter now={DEMO_NOW} since="2026-08-21T16:00:00.000Z" typicalDays={[14, 21]} />
              </div>
            </Specimen>
            <Specimen note="day 0 · the wait started today, and the counter still refuses a percentage">
              <div className="w-full">
                <DayCounter now={DEMO_NOW} since="2026-08-30T09:00:00.000Z" typicalDays={[14, 21]} />
              </div>
            </Specimen>
            <Specimen note="unreadable start · an absence, never a zero and never a guess">
              <div className="w-full">
                <DayCounter now={DEMO_NOW} since="not a timestamp" typicalDays={[14, 21]} />
              </div>
            </Specimen>
          </Surface>

          <Surface variant="card">
            <p className="m-0 mb-[var(--s-4)] max-w-[var(--measure-prose)] text-[12.5px] leading-[1.55] text-[color:var(--muted)] text-pretty">
              The A2P journey, drawn where it actually hurts: the carrier holds the current step for
              weeks, and the one thing the coach can press sits below it. The fill belongs to the
              action, not to the position.
            </p>
            <StepJourney steps={A2P_JOURNEY} />
          </Surface>
        </Section>

        {/* ------------------------------------------------------- table */}
        <Section title="Grid table">
          <Surface variant="panel">
            <GridTable
              className="@max-[640px]/grid-table:[--grid-table-columns:var(--grid-table-columns-narrow)]"
              columns="1.7fr 1fr .9fr .8fr 90px"
              columnsNarrow="1.4fr .9fr 80px"
              label="Client book"
            >
              <GridTableHead
                columns={[
                  { label: "Client" },
                  { label: "Success owner" },
                  { label: "Support" },
                  { label: "Updated" },
                  { align: "right", label: "MRR" },
                ]}
              />
              <GridTableRow>
                <GridTableCell>
                  <GridTableIdentity
                    leading={<Monogram name="Elevate Funding Co." />}
                    name="Elevate Funding Co."
                    subline="Growth · demo"
                  />
                </GridTableCell>
                <GridTableCell className="flex items-center gap-[var(--s-2)] text-[12.5px] text-[color:var(--faint)]">
                  <UnassignedMark />
                  Unassigned
                </GridTableCell>
                <GridTableCell><StatusAbsent label="No request" /></GridTableCell>
                <GridTableCell><MonoMeta>Aug 29 · 16:37</MonoMeta></GridTableCell>
                <GridTableCell align="right"><Figure size="sm">$1,490</Figure></GridTableCell>
              </GridTableRow>
              <GridTableRow tone="warning">
                <GridTableCell>
                  <GridTableIdentity
                    leading={<Monogram name="Measurement Review Workspace" />}
                    name="Measurement Review Workspace"
                    subline="No plan"
                  />
                </GridTableCell>
                <GridTableCell className="flex items-center gap-[var(--s-2)] text-[12.5px] text-[color:var(--faint)]">
                  <UnassignedMark />
                  Unassigned
                </GridTableCell>
                <GridTableCell><Status label="Open request" tone="warning" /></GridTableCell>
                <GridTableCell><MonoMeta>Aug 29 · 16:37</MonoMeta></GridTableCell>
                <GridTableCell align="right"><StatusAbsent label="No MRR" /></GridTableCell>
              </GridTableRow>
              <GridTableRow selected>
                <GridTableCell>
                  <GridTableIdentity
                    leading={<Monogram name="Reid Funding Group" />}
                    name="Reid Funding Group"
                    subline="Growth · demo"
                  />
                </GridTableCell>
                <GridTableCell className="flex items-center gap-[var(--s-2)] text-[12.5px] text-[color:var(--body)]">
                  <Monogram kind="person" name="Dana Whitfield" />
                  Dana Whitfield
                </GridTableCell>
                <GridTableCell><Status label="Waiting on coach" tone="waiting" /></GridTableCell>
                <GridTableCell><MonoMeta>Aug 29 · 16:37</MonoMeta></GridTableCell>
                <GridTableCell align="right"><Figure size="sm">$2,940</Figure></GridTableCell>
              </GridTableRow>
              <GridTableRow last tone="failure">
                <GridTableCell>
                  <GridTableIdentity
                    leading={<Monogram name="Boyd and Sons Advisory" />}
                    name="Boyd and Sons Advisory"
                    subline="Growth · demo"
                  />
                </GridTableCell>
                <GridTableCell className="flex items-center gap-[var(--s-2)] text-[12.5px] text-[color:var(--body)]">
                  <Monogram kind="person" name="Dana Whitfield" />
                  Dana Whitfield
                </GridTableCell>
                <GridTableCell><Status label="Past due" tone="failure" /></GridTableCell>
                <GridTableCell><MonoMeta tone="failure">retry Aug 31</MonoMeta></GridTableCell>
                <GridTableCell align="right"><Figure size="sm">$2,940</Figure></GridTableCell>
              </GridTableRow>
            </GridTable>
            <GridTableFooter left="Showing 1–4 of 8 clients" right="$8,350 MRR in view" />
          </Surface>
        </Section>
      </div>
    </main>
  );
}
