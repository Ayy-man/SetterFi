"use client";

import { useState } from "react";

import { MonoMeta, NoteStrip, Overline, Prose, StatusDot, Surface, SurfaceHeader } from "@/components/kit/atomics";
import { ChevronRight, CircleCheck, Download, Search, ShieldAlert, X } from "@/components/kit/icons";
import { PageHeader } from "@/components/kit/page-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ADMIN_GUIDES,
  filterAdminGuides,
  findAdminGuide,
  type AdminGuide,
  type AdminGuideCategory,
} from "@/lib/admin-help-guides";
import { cn } from "@/lib/utils";

const CRUMBS = [{ label: "Platform" }, { label: "Help" }] as const;

/**
 * The rail groups guides the way the sidebar groups pages: a text-only label, then its items.
 * No icons -- the labels carry the hierarchy.
 */
const CATEGORY_ORDER: readonly AdminGuideCategory[] = [
  "The Brain",
  "Client success",
  "Channels",
  "Billing",
  "Diagnostics",
];

const OPERATOR_COPY_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bpersisted\b/giu, "saved"],
  [/\bUnavailable\b/gu, "Could not read just now"],
  [/\btombstones?\b/giu, "deletion protection records"],
  [/suppression entries/giu, "current contact blocks"],
  [/compliance artifact/giu, "compliance record"],
  [/tenant\.success_owner\.reassigned/gu, "the ownership reassignment"],
];

/*
 * Artifact geometry, written once. `.surface-card`, `.surface-well` and `.surface-strip` in
 * globals.css own every face, radius, shadow and padding on this page; the strings here carry only
 * the type roles the recipes have no opinion about.
 */
const CARD_TITLE_CLASS = "text-[15px] leading-[1.3] font-semibold text-[color:var(--ink)]";
const READING_TITLE_CLASS =
  "text-[length:var(--t-section-title)] leading-[var(--t-section-title-lh)] font-[600] tracking-[var(--t-section-title-tr)] text-[color:var(--ink)]";

function operatorCopy(value: string) {
  return OPERATOR_COPY_REPLACEMENTS.reduce(
    (copy, [pattern, replacement]) => copy.replace(pattern, replacement),
    value.replaceAll("—", ","),
  );
}

function groupByCategory(guides: readonly AdminGuide[]) {
  return CATEGORY_ORDER.flatMap((category) => {
    const items = guides.filter((guide) => guide.category === category);
    return items.length ? [{ category, items }] : [];
  });
}

function formatGeneratedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date not recorded";
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(date);
}

function HelpSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative flex w-full items-center">
      <Search className="pointer-events-none absolute left-[var(--s-3)] size-[var(--s-4)] text-[var(--faint)]" />
      <span className="sr-only">Search operating guides</span>
      <Input
        className="h-[var(--s-8)] rounded-[var(--r-input)] border-[var(--line-input)] bg-[var(--well)] pr-[var(--s-8)] pl-[var(--s-10)] text-body"
        onChange={(event) => onChange(event.target.value)}
        placeholder="Filter guides"
        type="search"
        value={value}
      />
      {value ? (
        <Button
          aria-label="Clear search"
          className="absolute right-[var(--s-1)] size-[var(--s-6)] rounded-[var(--r-control)] transition-none active:translate-y-0"
          onClick={() => onChange("")}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X className="size-[var(--s-3)]" />
        </Button>
      ) : null}
    </label>
  );
}

export type HandoverPackage = {
  generatedAt: string;
  guideCount: number;
  downloads: readonly { fileName: string; content: string }[];
};

/**
 * The package is provenance, not a second page header: it says where these guides came from, so it
 * sits under the list it describes. A strip rather than a card, because it states a fact SetterFi
 * already recorded and is never the thing an operator came here to do.
 */
function HandoverLine({ handover }: { handover: HandoverPackage }) {
  return (
    <Surface
      aria-labelledby="handover-title"
      as="section"
      className="mt-[var(--s-3)] flex flex-col items-start gap-[var(--s-3)]"
      variant="strip"
    >
      <Overline>
        <span className="sr-only" id="handover-title">Operator handover package</span>
        Handover package
      </Overline>
      <MonoMeta>
        Generated {formatGeneratedAt(handover.generatedAt)} with {handover.guideCount} operator
        guides
      </MonoMeta>
      <Prose className="text-[12.5px] leading-[1.45] text-[color:var(--faint)]" measure="caption">
        These files prove what is in source, they do not prove deployment or provider state.
      </Prose>
      <details className="group relative shrink-0">
        {/* The summary is the control: a nested button would be an interactive inside an interactive. */}
        <summary
          className={cn(
            buttonVariants({ size: "sm", variant: "outline" }),
            "list-none transition-none active:translate-y-0 [&::-webkit-details-marker]:hidden",
          )}
        >
          <Download className="size-[var(--s-4)]" />
          Download files
        </summary>
        <div className="absolute left-0 z-10 mt-[var(--s-2)] flex w-[calc(var(--s-12)*5)] flex-col rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] p-[var(--s-1)] shadow-[var(--shadow-raised)]">
          {handover.downloads.map((download) => (
            <a
              className="truncate rounded-[var(--r-control)] px-[var(--s-2)] py-[var(--s-2)] text-body font-medium text-[var(--body)] hover:bg-[var(--row-hover)] hover:text-[var(--ink)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
              download={download.fileName}
              href={`data:text/markdown;charset=utf-8,${encodeURIComponent(download.content)}`}
              key={download.fileName}
            >
              {download.fileName}
            </a>
          ))}
        </div>
      </details>
    </Surface>
  );
}

export function AdminHelp({ handover }: { handover?: HandoverPackage }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(ADMIN_GUIDES[0].id);

  const visible = filterAdminGuides(query);
  const activeId = visible.some((guide) => guide.id === selectedId)
    ? selectedId
    : visible[0]?.id ?? null;
  const open = activeId ? findAdminGuide(activeId) : null;
  const next = open?.next ? findAdminGuide(open.next) : null;
  const groups = groupByCategory(visible);

  return (
    <div
      className="@container/help flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-4)] lg:h-[calc(100svh-var(--topbar-h,3.5rem)-var(--s-6)*2)]"
      data-layout="fixed"
    >
      <PageHeader
        crumbs={CRUMBS}
        description="Choose an operator task, follow its steps, then use the checks to prove the result."
        title="Help"
      />

      {/*
        The one rule on this page that is not about a guide. Twenty runbooks end by telling an
        operator to escalate, and escalating means typing what went wrong into a system neither the
        coach nor the lead can see -- so the rule that protects a card number and a phone number has
        to be read before the guide, not filed at the end of whichever one happened to be open. It
        sits under the header rather than inside a runbook for exactly that reason: it is the only
        line here that every operator passes on every visit.
      */}
      <NoteStrip
        className="shrink-0"
        icon={<ShieldAlert />}
        tone="warning"
      >
        Never paste a coach&rsquo;s card details or a lead&rsquo;s phone number into a ticket. Send
        the client name and the conversation id instead.
      </NoteStrip>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--s-6)] lg:flex-row">
        <aside
          aria-labelledby="runbook-index-title"
          className="relative flex min-w-0 shrink-0 flex-col overflow-y-auto lg:w-[calc(var(--sidebar-w)*1.05)]"
        >
          {/*
           * The index is a panel: it holds a header strip, a filter and a list of rows, and giving
           * it the card face is what separates "the set of guides" from the guide being read. The
           * article opposite deliberately has no face, so the page has exactly one card species.
           */}
          <Surface className="min-w-0" variant="panel">
            <SurfaceHeader
              overline="Operating guides"
              trailing={
                <MonoMeta>
                  {visible.length} of {ADMIN_GUIDES.length}
                </MonoMeta>
              }
            />
            <h2 className="sr-only" id="runbook-index-title">Operating guides</h2>
            <div className="px-[var(--s-3)] pt-[var(--s-3)]">
              {/* The field belongs to the list it filters, not to the topbar's global search. */}
              <HelpSearch onChange={setQuery} value={query} />
            </div>

            {groups.length ? (
              <nav aria-label="Operating guides" className="flex flex-col py-[var(--s-3)]">
                {groups.map((group) => (
                  <div
                    className="flex flex-col border-t border-[var(--line-soft)] pt-[var(--s-2)] first:border-t-0 first:pt-0 [&+&]:mt-[var(--s-2)]"
                    key={group.category}
                  >
                    {/* Body-weight, not an overline: two nav levels 240px apart must not read as
                        one system, and the rail outside this panel already owns the mono label. */}
                    <span className="px-[var(--s-3)] pb-[var(--s-1)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] font-medium text-[var(--muted)]">
                      {group.category}
                    </span>
                    {group.items.map((guide) => {
                      const active = guide.id === activeId;
                      return (
                        <button
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "mx-[var(--s-2)] flex min-h-[var(--row-h-compact)] items-center gap-[var(--s-2)] rounded-[var(--r-chip)] px-[var(--s-2)] py-[var(--s-2)] text-left text-[length:var(--t-nav)] text-[var(--body)] hover:bg-[var(--row-hover)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]",
                            // Selected reads as a full wash plus a dot, never a stripe down one
                            // edge, and the dot is what keeps the state off colour alone.
                            active &&
                              "bg-[var(--accent-wash-strong)] font-medium text-[var(--ink)]",
                          )}
                          key={guide.id}
                          onClick={() => setSelectedId(guide.id)}
                          type="button"
                        >
                          {active ? <StatusDot size={5} tone="accent" /> : null}
                          <span className="min-w-0">{operatorCopy(guide.title)}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </nav>
            ) : (
              <div className="px-[var(--s-4)] py-[var(--s-5)]">
                <h3 className={CARD_TITLE_CLASS}>No matching runbook</h3>
                <Prose
                  className="mt-[var(--s-1)] text-[12.5px] leading-[1.45] text-[color:var(--faint)]"
                  measure="caption"
                >
                  Try a broader task such as publish, trace, carrier, or billing.
                </Prose>
              </div>
            )}
          </Surface>

          {handover ? <HandoverLine handover={handover} /> : null}
        </aside>

        {open ? (
          /*
           * The runbook itself takes no face. It is the content of the page rather than an object
           * on it, the same ruling the Inbox thread pane landed on: a card around a document only
           * adds a second frame inside the pane the reader is already looking at.
           */
          <article className="relative min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[var(--measure-prose)] pb-[var(--s-8)]">
              <header className="border-b border-[var(--line)] pb-[var(--s-5)]">
                <div className="flex items-baseline justify-between gap-[var(--s-4)]">
                  <Overline>{open.category} runbook</Overline>
                  <MonoMeta className="shrink-0">{open.steps.length} steps</MonoMeta>
                </div>
                {/* The guide is a section of the Help page, so it sits a step under the page
                    title rather than outweighing it. */}
                <h2 className={cn("mt-[var(--s-2)]", READING_TITLE_CLASS)}>
                  {operatorCopy(open.title)}
                </h2>
                <Prose className="mt-[var(--s-2)] text-[13px] leading-[1.6] text-[color:var(--body)]">
                  {operatorCopy(open.outcome)}
                </Prose>
              </header>

              {/* A numbered mono rail, which is this page's one repeated interior: the step number
                  is a figure, so it sets in mono beside the Archivo heading it belongs to. */}
              <ol className="divide-y divide-[var(--line-soft)]">
                {open.steps.map((step, index) => (
                  <li
                    className="grid grid-cols-[var(--s-8)_minmax(0,1fr)] gap-[var(--s-4)] py-[var(--s-4)]"
                    key={step.heading}
                  >
                    <MonoMeta className="pt-[2px] text-[color:var(--faint)]">
                      {String(index + 1).padStart(2, "0")}
                    </MonoMeta>
                    <div className="min-w-0">
                      <h3 className="text-[13px] leading-[1.4] font-medium text-[color:var(--ink)]">
                        {operatorCopy(step.heading)}
                      </h3>
                      <Prose className="mt-[var(--s-1)] text-[13px] leading-[1.6] text-[color:var(--body)]">
                        {operatorCopy(step.caption)}
                      </Prose>
                    </div>
                  </li>
                ))}
              </ol>

              {/* The proof block is recessed, not another card: it belongs to the runbook above it
                  and a second face here would read as a second document. */}
              <Surface
                aria-labelledby="verify-title"
                as="section"
                className="mt-[var(--s-4)]"
                variant="well"
              >
                <Overline>Verify it worked</Overline>
                <h3 className="sr-only" id="verify-title">Verification checks</h3>
                <ul className="mt-[var(--s-3)] flex flex-col gap-[var(--s-2)]">
                  {open.verify.map((check) => (
                    <li
                      className="flex items-start gap-[var(--s-2)] text-[13px] leading-[1.6] text-[color:var(--body)]"
                      key={check}
                    >
                      <CircleCheck className="mt-[3px] size-[var(--s-4)] shrink-0 text-[var(--good)]" />
                      <span className="min-w-0">{operatorCopy(check)}</span>
                    </li>
                  ))}
                </ul>
                <Prose className="mt-[var(--s-3)] border-t border-[var(--line-soft)] pt-[var(--s-3)] text-[12.5px] leading-[1.5] text-[color:var(--faint)]">
                  {operatorCopy(open.troubleshoot)}
                </Prose>
              </Surface>

              {next ? (
                <button
                  className="mt-[var(--s-4)] flex w-full items-center gap-[var(--s-3)] rounded-[var(--r-chip)] border border-[var(--line)] px-[var(--s-3)] py-[var(--s-3)] text-left hover:border-[var(--accent-edge)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
                  onClick={() => setSelectedId(next.id)}
                  type="button"
                >
                  <span className="min-w-0 flex-1">
                    <Overline>Next runbook</Overline>
                    <strong className="mt-[var(--s-1)] block text-[13px] leading-[1.4] font-medium text-[color:var(--ink)]">
                      {operatorCopy(next.title)}
                    </strong>
                  </span>
                  <ChevronRight className="size-[var(--s-4)] shrink-0 text-[var(--muted)]" />
                </button>
              ) : null}
            </div>
          </article>
        ) : null}
      </div>
    </div>
  );
}
