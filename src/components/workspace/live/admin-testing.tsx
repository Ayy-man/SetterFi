"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { Callout } from "@/components/kit/callout";
import { absentValue } from "@/components/kit/columns";
import { DataState } from "@/components/kit/data-state";
import { DataTable } from "@/components/kit/data-table";
import { ExportMenu } from "@/components/kit/export-menu";
import { Field } from "@/components/kit/field";
import { ShieldCheck } from "@/components/kit/icons";
import { KeyValue } from "@/components/kit/key-value";
import { LoggedButton } from "@/components/kit/logged-button";
import { RecordSheet } from "@/components/kit/record-sheet";
import { STATE_TONE_TO_TONE, Status } from "@/components/kit/atomics";
import { ConsoleStatDeck } from "@/components/kit/console-stat-deck";
import { type StatStripItem } from "@/components/kit/stat-strip";
import { StateBadge, type StateTone } from "@/components/kit/state-badge";
import { TechnicalDetail } from "@/components/kit/technical-detail";
import { DetailPage, type DetailTab } from "@/components/kit/templates/detail-page";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/kit/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  MODERATOR_STATE_COPY,
  TRACE_RULE_FALLBACK_COPY,
} from "@/lib/copy/states";
import { workspaceTimestampFormat } from "@/lib/format/datetime";

import {
  evalComparisonView,
  type EvalComparisonConfigOption,
  type EvalComparisonDraftOption,
  type EvalComparisonView,
} from "./eval-comparison-view-models";
import type { MessageTraceRead, TestingView } from "./view-models";

type ComparisonPanelInput = {
  enabled: boolean;
  configs: readonly EvalComparisonConfigOption[];
  draft: EvalComparisonDraftOption | null;
};

type Refusal = {
  state: "refused";
  code: string;
  variableNames?: readonly string[];
};

type ComparisonSuite = EvalComparisonView["suites"][number];

const PAGE_DESCRIPTION =
  "Try The Brain, then compare saved configurations against the same case set. Real leads are never split across experiments.";

// The comparison outcome is the band a suite sits in, not a column repeated on every row, so
// the default view is three columns wide: which suite, and what each arm did with it. Cost and
// latency stay available behind Display and in the row sheet.
const COMPARISON_GROUPS = [
  { id: "comparable", label: "Comparable, both arms ran the same cases" },
  { id: "incomplete", label: "Incomplete, no numeric verdict" },
  { id: "skipped", label: "Skipped" },
  { id: "not_configured", label: "Not configured" },
] as const;

/**
 * A suite that did not run has no number, and the view model fills those cells with the suite's
 * own state word -- "Not configured", "Skipped". Printed plain, that reads as a value sitting in
 * a numeric column. Rendered through `absentValue` it reads as what it is: a measurement nobody
 * took. The band header carries the same fact once for the whole run of rows.
 */
function armCell(suite: ComparisonSuite, value: string) {
  return suite.state === "comparable" ? value : absentValue(value.toLowerCase());
}

const COMPARISON_COLUMNS: ColumnDef<ComparisonSuite>[] = [
  { accessorKey: "label", header: "Suite", meta: { cellKind: "identity", label: "Suite" } },
  { accessorFn: (row) => row.armA.passed, cell: ({ row }) => armCell(row.original, row.original.armA.passed), header: "A passed", id: "aPassed", meta: { label: "A passed" } },
  { accessorFn: (row) => row.armB.passed, cell: ({ row }) => armCell(row.original, row.original.armB.passed), header: "B passed", id: "bPassed", meta: { label: "B passed" } },
  { accessorFn: (row) => row.armA.falseBlocks, cell: ({ row }) => armCell(row.original, row.original.armA.falseBlocks), header: "A false blocks", id: "aFalseBlocks", meta: { defaultHidden: true, label: "A false blocks" } },
  { accessorFn: (row) => row.armB.falseBlocks, cell: ({ row }) => armCell(row.original, row.original.armB.falseBlocks), header: "B false blocks", id: "bFalseBlocks", meta: { defaultHidden: true, label: "B false blocks" } },
  { accessorFn: (row) => row.armA.providerCostCredits, cell: ({ row }) => armCell(row.original, row.original.armA.providerCostCredits), header: "A usage credits", id: "aCredits", meta: { defaultHidden: true, label: "A usage credits" } },
  { accessorFn: (row) => row.armB.providerCostCredits, cell: ({ row }) => armCell(row.original, row.original.armB.providerCostCredits), header: "B usage credits", id: "bCredits", meta: { defaultHidden: true, label: "B usage credits" } },
  { accessorFn: (row) => `${row.armA.latencyP50Ms} / ${row.armA.latencyP95Ms}`, cell: ({ row }) => armCell(row.original, `${row.original.armA.latencyP50Ms} / ${row.original.armA.latencyP95Ms}`), header: "A p50 / p95", id: "aLatency", meta: { defaultHidden: true, label: "A p50 / p95" } },
  { accessorFn: (row) => `${row.armB.latencyP50Ms} / ${row.armB.latencyP95Ms}`, cell: ({ row }) => armCell(row.original, `${row.original.armB.latencyP50Ms} / ${row.original.armB.latencyP95Ms}`), header: "B p50 / p95", id: "bLatency", meta: { defaultHidden: true, label: "B p50 / p95" } },
];

function isComparisonPayload(value: unknown): value is { comparison: Parameters<typeof evalComparisonView>[0] } {
  return Boolean(value && typeof value === "object" && "comparison" in value);
}

function refusalMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("state" in value) || value.state !== "refused") {
    return "The comparison was refused without saved evidence.";
  }
  const refusal = value as Refusal;
  return refusal.variableNames?.length
    ? `${refusal.code}: missing ${refusal.variableNames.join(", ")}.`
    : `${refusal.code}. No comparison was recorded.`;
}

function displayTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Time not recorded"
    : workspaceTimestampFormat.format(date);
}

function humanize(value: string) {
  const words = value.trim().replace(/[_-]+/g, " ").toLowerCase();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "Not recorded";
}

function armState(arm: TestingView["arms"][number]): { label: string; tone: StateTone } {
  if (arm.state === "Skipped") return { label: "Skipped", tone: "warning" };
  if (arm.state === "Mock") return { label: "Mock path", tone: "neutral" };
  return { label: "Real path", tone: "good" };
}

function TraceEvidence({ trace, grounded }: { trace: MessageTraceRead; grounded: boolean }) {
  const moderator = MODERATOR_STATE_COPY[trace.moderatorState];
  return (
    <div className="flex flex-col gap-[var(--s-4)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--s-3)]">
        <h3 className="text-section text-[var(--ink)]">Grounding receipt</h3>
        <StateBadge
          icon={grounded ? ShieldCheck : undefined}
          kind="verdict"
          label={grounded ? "Grounded" : "Source check not recorded"}
          tone={grounded ? "good" : "warning"}
        />
      </div>
      <dl className="grid gap-[var(--s-4)] sm:grid-cols-2">
        <KeyValue
          label="Rule fired"
          layout="stacked"
          value={trace.ruleFired
            ? humanize(trace.ruleFired)
            : TRACE_RULE_FALLBACK_COPY.not_recorded.label}
        />
        <KeyValue label="Retrieved entries" layout="stacked" value={trace.retrievedEntryIds.length} />
        <KeyValue
          label="Moderator"
          layout="stacked"
          value={<Status label={moderator.label} tone={STATE_TONE_TO_TONE[moderator.tone]} />}
        />
        <KeyValue label="Recorded" layout="stacked" value={displayTime(trace.createdAt)} />
      </dl>
      <TechnicalDetail
        items={[
          { label: "Trace ID", value: trace.id },
          { label: "Recorded timestamp", value: trace.createdAt },
          ...trace.retrievedEntryIds.map((id, index) => ({ label: `Retrieved entry ${index + 1}`, value: id })),
        ]}
      />
    </div>
  );
}

function ArmPanel({ arm, sharedEmptyEvidence = false }: { arm: TestingView["arms"][number]; sharedEmptyEvidence?: boolean }) {
  const state = armState(arm);
  return (
    <article className="min-w-0 rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-5)]">
      <div className="mb-[var(--s-4)] flex min-w-0 items-start gap-[var(--s-3)]">
        <span
          aria-label={`Arm ${arm.id}`}
          className="grid size-[var(--s-8)] shrink-0 place-items-center rounded-[var(--r-input)] border border-[var(--line-strong)] bg-[var(--quiet)] text-[length:var(--t-body)] font-semibold text-[var(--body)]"
        >
          {arm.id}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-section text-[var(--ink)]">{arm.label}</h2>
          <div className="mt-[var(--s-1)] flex flex-wrap items-center gap-[var(--s-2)]">
            <Status label={state.label} tone={STATE_TONE_TO_TONE[state.tone]} treatment="bare" />
            {arm.role && arm.role.toLowerCase() !== arm.label.trim().toLowerCase() ? (
              <Status label={arm.role} tone="neutral" treatment="bare" />
            ) : null}
          </div>
        </div>
      </div>

      {arm.trace ? (
        <TraceEvidence grounded={arm.grounded} trace={arm.trace} />
      ) : !sharedEmptyEvidence || arm.reason || arm.state === "Mock" ? (
        <dl className="border-t border-[var(--line)] pt-[var(--s-3)]">
          {sharedEmptyEvidence ? null : (
            <KeyValue
              label="Evidence"
              layout="stacked"
              value="No saved trace. This arm has no grounding or outcome claim."
            />
          )}
          {arm.reason ? (
            <p className="t-muted mt-[var(--s-2)]">
              {arm.reason}. This arm did not run and is not counted as passed.
            </p>
          ) : arm.state === "Mock" ? (
            <p className="t-muted mt-[var(--s-2)]">
              The deterministic mock path supports interface checks and never counts as a real provider pass.
            </p>
          ) : null}
        </dl>
      ) : null}
    </article>
  );
}

function suiteArmSection(label: string, arm: ComparisonSuite["armA"]) {
  return {
    title: label,
    body: (
      <dl className="grid gap-[var(--s-3)] sm:grid-cols-2">
        <KeyValue label="Passed" layout="stacked" value={arm.passed} />
        <KeyValue label="False blocks" layout="stacked" value={arm.falseBlocks} />
        <KeyValue label="Usage credits" layout="stacked" value={arm.providerCostCredits} />
        <KeyValue label="Latency p50 / p95" layout="stacked" value={`${arm.latencyP50Ms} / ${arm.latencyP95Ms}`} />
      </dl>
    ),
  };
}

export function AdminBrainTesting({
  comparison,
  testing,
  tenant,
}: {
  comparison?: ComparisonPanelInput;
  testing: TestingView;
  // `isTest` used to sit here beside these and was read nowhere, which is the exact shape of a
  // segregation claim that is true in the query and invisible on screen: the page hard-coded it
  // true, the component destructured it, and no reader ever saw it. What the rows are is said in
  // the comparison table's footer note instead, where the rows it describes actually are.
  tenant: { id: string; name: string; isDemo: boolean };
}) {
  const activeConfigs = comparison?.configs.filter((config) => config.active) ?? [];
  const challengerConfigs = comparison?.configs.filter((config) => !config.active) ?? [];
  const [modelConfigAId, setModelConfigAId] = useState(activeConfigs[0]?.id ?? "");
  const [modelConfigBId, setModelConfigBId] = useState(challengerConfigs[0]?.id ?? "");
  const [challengerModel, setChallengerModel] = useState("");
  const [challengerParams, setChallengerParams] = useState("{}");
  const [comparisonBusy, setComparisonBusy] = useState<"challenger" | "run" | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonResult, setComparisonResult] = useState<EvalComparisonView | null>(null);
  const [suiteSheet, setSuiteSheet] = useState<ComparisonSuite | null>(null);
  const latestTrace = useMemo(
    () => testing.arms
      .map((arm) => arm.trace)
      .filter((trace): trace is MessageTraceRead => trace !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null,
    [testing.arms],
  );
  const armsWithEvidence = testing.arms.filter((arm) => arm.trace !== null).length;

  async function createChallenger() {
    setComparisonBusy("challenger");
    setComparisonError(null);
    try {
      const params: unknown = JSON.parse(challengerParams);
      const response = await fetch("/api/admin/brain/model-configs/challenger", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: challengerModel, params }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !payload || typeof payload !== "object" || !("receipt" in payload)) {
        throw new Error(refusalMessage(payload));
      }
      const receipt = payload.receipt as { id?: unknown };
      if (typeof receipt.id !== "string") throw new Error("The challenger receipt did not contain a configuration id.");
      setModelConfigBId(receipt.id);
    } catch (error) {
      setComparisonError(error instanceof Error ? error.message : "The challenger was refused.");
    } finally {
      setComparisonBusy(null);
    }
  }

  async function runComparison() {
    if (!comparison?.draft) return;
    setComparisonBusy("run");
    setComparisonError(null);
    setComparisonResult(null);
    try {
      const response = await fetch("/api/admin/brain/eval-comparisons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          draftId: comparison.draft.id,
          contentHash: comparison.draft.contentHash,
          modelConfigAId,
          modelConfigBId,
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok || !isComparisonPayload(payload)) throw new Error(refusalMessage(payload));
      setComparisonResult(evalComparisonView(payload.comparison));
    } catch (error) {
      setComparisonError(error instanceof Error ? error.message : "The comparison was refused.");
    } finally {
      setComparisonBusy(null);
    }
  }

  const challengerDisabledReason = comparisonBusy
    ? "Wait for the current comparison request to finish."
    : !challengerModel.trim()
      ? "Enter a model identifier before creating an inactive challenger."
      : null;
  const comparisonDisabledReason = !comparison?.draft
    ? "Create a saved Brain draft before running a comparison."
    : !modelConfigAId || !modelConfigBId
      ? "Choose both comparison arms before running the case set."
      : modelConfigAId === modelConfigBId
        ? "Choose two different configurations before running the case set."
        : comparisonBusy
          ? "Wait for the current comparison request to finish."
          : null;

  const noArmHasEvidence = testing.arms.length > 0 && armsWithEvidence === 0;

  /*
   * "Moderator unavailable" is the one figure here whose zero is good news, so it says so in
   * words rather than printing a 0 beside two counts whose zeros mean the opposite. A tone only
   * lands when it is non-zero, because an eval bench shouting clay at a healthy moderator is the
   * signal spent on nothing.
   */
  const benchTiles: StatStripItem[] = [
    {
      label: "Configured arms",
      availability: testing.arms.length === 0
        ? { kind: "no-events", note: "No arm is configured, so there is nothing to run." }
        : { kind: "value", value: testing.arms.length, format: "count" },
    },
    {
      label: "Arms with saved evidence",
      availability: armsWithEvidence === 0
        ? { kind: "no-events", note: "No arm has a saved trace yet." }
        : { kind: "value", value: armsWithEvidence, format: "count" },
    },
    {
      label: "Moderator unavailable",
      availability: testing.moderatorUnavailableCount === 0
        ? { kind: "no-events", note: "The moderator has answered every time it was asked." }
        : { kind: "value", value: testing.moderatorUnavailableCount, format: "count" },
    },
  ];

  const benchTab = (
    <section aria-label="Configured arms" className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <p className="t-muted m-0 max-w-[var(--measure-prose)]">
        Labels and left-to-right position distinguish A and B. Evidence comes only from a saved trace.
      </p>
      {/*
        * "Arms with saved evidence" takes the single fill. It is the figure that decides whether
        * anything on this page can be believed -- an arm with no saved trace carries no grounding
        * or outcome claim at all -- so it outranks the arm count beside it. Moderator unavailable
        * is deliberately not the hero: its zero is the good case, and drenching a healthy zero is
        * the console shouting about nothing.
        */}
      <ConsoleStatDeck
        ariaLabel="Test bench summary"
        heroLabel="Arms with saved evidence"
        items={benchTiles}
      />
      {noArmHasEvidence ? (
        <p className="t-muted m-0 max-w-[var(--measure-wide)]">
          No arm has a saved trace, so neither carries a grounding or outcome claim yet.
        </p>
      ) : null}
      <div className="grid min-w-0 gap-[var(--s-4)] xl:grid-cols-2">
        {testing.arms.map((arm) => (
          <ArmPanel arm={arm} key={arm.id} sharedEmptyEvidence={noArmHasEvidence} />
        ))}
      </div>
    </section>
  );

  const comparisonTab = comparison ? (
    <section aria-label="Generator comparison" className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <p className="t-muted m-0 max-w-[var(--measure-prose)]">
        Both arms use the same saved Brain draft and identical case set. An incomplete suite has no numeric verdict.
      </p>

      {!comparison.enabled ? (
        <DataState
          body="Turn on comparison testing to create a challenger and run the shared case set."
          kind="empty"
          title="Comparison testing is not enabled"
        />
      ) : (
        <>
          <div className="grid gap-[var(--s-4)] xl:grid-cols-2">
            <Select
              label="Active generator, arm A"
              onValueChange={setModelConfigAId}
              options={[
                { value: "", label: "Select active generator" },
                ...activeConfigs.map((config) => ({ value: config.id, label: config.label })),
              ]}
              value={modelConfigAId}
            />
            <Select
              label="Inactive challenger, arm B"
              onValueChange={setModelConfigBId}
              options={[
                { value: "", label: "Select inactive challenger" },
                ...challengerConfigs.map((config) => ({ value: config.id, label: config.label })),
              ]}
              value={modelConfigBId}
            />
          </div>

          <details className="rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--card)] p-[var(--s-4)]">
            <summary className="w-fit cursor-pointer select-none text-[length:var(--t-body)] font-medium text-[var(--ink)]">
              Create a new challenger
            </summary>
            <div className="mt-[var(--s-4)] grid gap-[var(--s-4)] xl:grid-cols-2">
              <Field
                hint="Use the exact model name from the routing configuration."
                label="Challenger model identifier"
              >
                <Input
                  onChange={(event) => setChallengerModel(event.target.value)}
                  placeholder="Model name"
                  value={challengerModel}
                />
              </Field>
              <Field
                hint={'Enter a JSON object, for example {"temperature": 0}.'}
                label="Challenger parameters"
              >
                <Textarea
                  className="font-mono text-[length:var(--t-body)]"
                  onChange={(event) => setChallengerParams(event.target.value)}
                  spellCheck={false}
                  value={challengerParams}
                />
              </Field>
            </div>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="mt-[var(--s-4)] inline-flex" tabIndex={challengerDisabledReason ? 0 : -1}>
                    <LoggedButton
                      actionKey="eval.model_config.created"
                      disabled={challengerDisabledReason !== null}
                      onClick={() => void createChallenger()}
                      type="button"
                    >
                      {comparisonBusy === "challenger" ? "Creating challenger" : "Create inactive challenger"}
                    </LoggedButton>
                  </span>
                }
              />
              {challengerDisabledReason ? <TooltipContent>{challengerDisabledReason}</TooltipContent> : null}
            </Tooltip>
          </details>

          <div className="flex flex-wrap gap-[var(--s-2)]">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-flex" tabIndex={comparisonDisabledReason ? 0 : -1}>
                    <Button
                      disabled={comparisonDisabledReason !== null}
                      onClick={() => void runComparison()}
                      type="button"
                    >
                      {comparisonBusy === "run" ? "Running case set" : "Run comparison"}
                    </Button>
                  </span>
                }
              />
              {comparisonDisabledReason ? <TooltipContent>{comparisonDisabledReason}</TooltipContent> : null}
            </Tooltip>
          </div>

          {comparisonError ? (
            <div role="alert">
              <Callout
                body={
                  <>
                    Nothing was saved, so no suite carries a verdict from this attempt.
                    <TechnicalDetail className="mt-[var(--s-2)]" items={[{ label: "Response detail", value: comparisonError }]} />
                  </>
                }
                title="The comparison request did not complete"
                tone="critical"
              />
            </div>
          ) : null}

          {comparisonResult ? (
            <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
              <div className="flex flex-wrap items-start justify-between gap-[var(--s-3)]">
                <div>
                  <h3 className="text-section text-[var(--ink)]">{comparisonResult.stateLabel}</h3>
                  <p className="t-muted mt-[var(--s-1)] max-w-[var(--measure-prose)]">
                    {comparisonResult.stateReason ?? "Every configured suite has matching case evidence for both arms."}
                  </p>
                </div>
                <StateBadge
                  kind="verdict"
                  label={comparisonResult.driverLabel}
                  tone={comparisonResult.state === "comparable" && comparisonResult.driverArm === "real" ? "good" : "warning"}
                />
              </div>
              {/* Both exports are always on screen, and the reason lives inside each menu rather
                  than in a field beside them. The page used to hold one shared reason box and
                  render neither control until somebody typed in it, which meant a reader who did
                  not know the box existed saw a table with no way out of it -- a live break of
                  CLAUDE.md's "every table exports CSV/JSON". `ExportMenu` already carries the
                  reason input, labels it "Required for this export", and keeps both download
                  items disabled until it is filled, so the requirement is enforced in the same
                  place it is explained. The two are named because they export different things:
                  one comparison run per row against one suite result per row. */}
              <div className="flex flex-wrap items-end justify-end gap-[var(--s-3)]">
                <ExportMenu
                  filename="setterfi-eval-comparisons"
                  label="Export comparison runs"
                  mode="server"
                  query={{ order: "created_desc", reason: "" }}
                  resource="eval-comparisons"
                />
              </div>
              <DataTable
                ariaLabel="Saved per-suite comparison evidence"
                columns={COMPARISON_COLUMNS}
                data={comparisonResult.suites}
                emptyState={
                  <DataState
                    body="Run the identical case set to populate suite evidence."
                    kind="empty"
                    title="No comparison evidence"
                  />
                }
                exportResource={{
                  filename: "setterfi-eval-comparison-results",
                  label: "Export suite results",
                  mode: "server",
                  query: { order: "created_desc", reason: "" },
                  resource: "eval-comparison-results",
                }}
                footerNote="Every row is a case from the eval case set run through both arms, never a real lead conversation, and nothing here reaches analytics."
                getRowId={(row) => row.suite}
                groupBy={(row) => row.state}
                groups={COMPARISON_GROUPS}
                onRowClick={setSuiteSheet}
                rowLabel={{ singular: "suite", plural: "suites" }}
                search={{ placeholder: "Search suites" }}
                ungroupedLabel="Outcome not recorded"
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  ) : null;

  const latestRunTab = (
    <section aria-label="Latest saved run" className="relative flex min-w-0 flex-col gap-[var(--s-4)]">
      <p className="t-muted m-0 max-w-[var(--measure-prose)]">
        This reads the saved trace and never infers grounding from a generated answer.
      </p>
      {latestTrace ? (
        <TraceEvidence
          grounded={testing.arms.some((arm) => arm.trace?.id === latestTrace.id && arm.grounded)}
          trace={latestTrace}
        />
      ) : (
        <DataState
          body="Run a test arm with source checks to create the first grounding receipt."
          kind="empty"
          title="No saved trace"
        />
      )}
    </section>
  );

  const tabs: DetailTab[] = [
    { id: "bench", label: "Test bench", content: benchTab, ...(testing.arms.length ? { count: testing.arms.length } : {}) },
    ...(comparisonTab
      ? [{
        id: "comparison",
        label: "Comparison",
        content: comparisonTab,
        // The count appears only once a run has produced suites; before that the tab says its
        // own emptiness in the body rather than wearing a zero.
        ...(comparisonResult?.suites.length ? { count: comparisonResult.suites.length } : {}),
      }]
      : []),
    { id: "runs", label: "Latest run", content: latestRunTab, ...(latestTrace ? { count: 1 } : {}) },
  ];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DetailPage
        actions={<TechnicalDetail items={[{ label: "Tenant ID", value: tenant.id }]} />}
        provenanceKind={tenant.isDemo ? "test" : undefined}
        subtitle={`${tenant.name} · ${PAGE_DESCRIPTION}`}
        tabs={tabs}
        title="Evals"
      />

      <RecordSheet
        onOpenChange={(open) => { if (!open) setSuiteSheet(null); }}
        open={suiteSheet !== null}
        sections={suiteSheet ? [
          suiteArmSection("Arm A", suiteSheet.armA),
          suiteArmSection("Arm B", suiteSheet.armB),
        ] : []}
        state={suiteSheet ? { kind: "tag", label: suiteSheet.stateLabel, tone: "neutral" } : undefined}
        subtitle={suiteSheet ? suiteSheet.stateLabel : undefined}
        technical={suiteSheet ? [{ label: "Suite key", value: suiteSheet.suite }] : undefined}
        title={suiteSheet?.label ?? ""}
      />
    </div>
  );
}
