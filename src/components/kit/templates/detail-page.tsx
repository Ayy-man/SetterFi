"use client";

import Link from "next/link";
import { useRef, type ReactNode } from "react";

import { useSingleFilledActionWarning } from "@/components/kit/page-header";
import { StateBadge, type StateBadgeProps } from "@/components/kit/state-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  PrimaryActionButton,
  type PrimaryAction,
} from "@/components/kit/primary-action";
import {
  assertOneProvenanceClaim,
  ProvenanceChip,
  type ProvenanceKind,
} from "@/components/kit/provenance-chip";
import { BREAK } from "@/components/kit/templates/rhythm";
import { cn } from "@/lib/utils";

export type DetailTab = {
  id: string;
  label: string;
  content: ReactNode;
  /**
   * An optional count, rendered faint in mono after the label. Decorative: the label alone stays
   * the tab's accessible name, so a reader is not told "Knowledge 412" every time focus lands.
   * Leave it off rather than passing 0. An empty tab says so in its own body, and a grey zero in
   * the tab strip reads as a broken count.
   */
  count?: number;
  /**
   * A route-driven tab. The trigger becomes a link to `href` and marks itself `aria-current` when
   * it is the open tab, so a sub-route the reader can bookmark and open in a new tab still reads
   * as a tab rather than a nav item. The role stays `tab`; only the element changes.
   */
  href?: string;
};

export type DetailPageProps = {
  title: string;
  /**
   * Required. The detail page's equivalent of ListPage's `description`: one muted sentence of
   * identity and purpose under the title: an id, an owner, a plan, what this record is for. It
   * is the same slot it always was, now mandatory rather than optional, so the prop keeps the
   * name every existing call site already passes.
   */
  subtitle: string;
  breadcrumb?: ReactNode;
  state?: StateBadgeProps;
  /**
   * Right-aligned, and every one of them outline or ghost. **At most one filled control per
   * page**, and the fill belongs to `primaryAction`, never here.
   */
  actions?: ReactNode;
  /** The single filled control on the page, rendered last in the action row. */
  primaryAction?: PrimaryAction;
  /** One line under the header when the record is not production data, as ListPage does. */
  provenance?: string;
  /**
   * The seeded-data chip above the title, on the console.
   *
   * Distinct from `provenance`, which is a free sentence under the description, and it supersedes
   * it: a page that passes this should not also pass a sentence saying the rows are seeded, or the
   * same fact is stated twice in one header. All thirteen owner-console artboards put the
   * disclosure first, above the `<h1>`, because a reader who meets it under the description has
   * already read the numbers. Coach pages state it in words instead and leave this unset.
   */
  provenanceKind?: ProvenanceKind;
  tabs: readonly DetailTab[];
  defaultTab?: string;
  onTabChange?: (id: string) => void;
  value?: string;
  className?: string;
};

/**
 * The detail shape: a header that does not move and tabs whose content scrolls. Tab one is the
 * decision view; economics, provisioning internals, and raw logs live in later tabs.
 *
 * The head matches ListPage: mono breadcrumb, 20/600 title, one required muted sentence
 * (`subtitle`), right-aligned actions with at most one filled control. Tabs underline 2px in ink
 * on the active one and take an optional faint mono count. In development the action row warns
 * when it can see two fills; a fill placed elsewhere on the page is beyond what it can see.
 *
 * **A detail page's rhythm is not a list page's.** The tab strip is bare text with no border or
 * ground of its own, so it takes the wider 24px break under the head to read as a separate
 * register, and then sits close over the panel it controls -- the panel belongs to the tab. A list
 * page inverts that: its stat strip is a bordered block that separates itself, so it sits closer
 * to the head and further from the rows. Two page kinds, two textures.
 */
export function DetailPage({
  actions,
  breadcrumb,
  className,
  defaultTab,
  onTabChange,
  primaryAction,
  provenance,
  provenanceKind,
  state,
  subtitle,
  tabs,
  title,
  value,
}: DetailPageProps) {
  const first = tabs[0]?.id;
  const activeTab = value ?? defaultTab ?? first;
  assertOneProvenanceClaim("DetailPage", provenance, provenanceKind);

  const actionsRef = useRef<HTMLDivElement>(null);
  useSingleFilledActionWarning(actionsRef, "DetailPage", [actions, primaryAction]);

  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col lg:h-[calc(100svh-var(--topbar-h,3.5rem)-var(--s-6)*2)]",
        className,
      )}
      data-layout="fixed"
      data-slot="detail-page"
    >
      {breadcrumb ? (
        <div className={cn("t-mono-crumb min-w-0", BREAK.crumb)} data-slot="detail-page-breadcrumb">
          {breadcrumb}
        </div>
      ) : null}

      <header
        className="flex shrink-0 items-start justify-between gap-[var(--s-6)] max-sm:flex-col"
        data-slot="detail-page-header"
      >
        <div className="flex min-w-0 flex-col gap-[var(--s-1)]">
          {provenanceKind ? (
            <div className="mb-[var(--s-1)]">
              <ProvenanceChip kind={provenanceKind} />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-wrap items-center gap-[var(--s-3)]">
            <h1 className="t-page-title m-0 min-w-0" data-slot="detail-page-title">
              {title}
            </h1>
            {state ? <StateBadge {...state} /> : null}
          </div>
          <p
            className="m-0 max-w-[var(--measure-prose)] text-[length:var(--t-body)] leading-[var(--t-body-lh)] text-[color:var(--muted)]"
            data-slot="detail-page-subtitle"
          >
            {subtitle}
          </p>
          {provenance ? (
            <p
              className="m-0 max-w-[var(--measure-wide)] text-[length:var(--t-badge)] text-[color:var(--faint)]"
              data-slot="detail-page-provenance"
            >
              {provenance}
            </p>
          ) : null}
        </div>
        {actions || primaryAction ? (
          <div
            className="flex shrink-0 items-center gap-[var(--s-2)] max-sm:w-full max-sm:flex-wrap"
            data-slot="detail-page-actions"
            ref={actionsRef}
          >
            {actions}
            {primaryAction ? <PrimaryActionButton action={primaryAction} /> : null}
          </div>
        ) : null}
      </header>

      <Tabs
        className={cn("flex min-h-0 min-w-0 flex-1 flex-col", BREAK.bareControl)}
        defaultValue={value === undefined ? (defaultTab ?? first) : undefined}
        onValueChange={(next) => onTabChange?.(String(next))}
        value={value}
      >
        <TabsList className="shrink-0" variant="line">
          {tabs.map((tab) => (
            <TabsTrigger
              aria-current={tab.href && activeTab === tab.id ? "page" : undefined}
              key={tab.id}
              nativeButton={tab.href ? false : undefined}
              render={tab.href ? <Link href={tab.href} /> : undefined}
              value={tab.id}
            >
              {tab.label}
              {tab.count !== undefined ? (
                <span
                  aria-hidden="true"
                  className="[font-family:var(--font-mono)] [font-size:var(--t-mono-crumb)] [font-weight:var(--t-mono-crumb-w)] [line-height:var(--t-mono-crumb-lh)] [color:var(--faint)] tabular-nums"
                  data-slot="detail-page-tab-count"
                >
                  {tab.count}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((tab) => (
          <TabsContent
            className={cn("relative min-h-0 min-w-0 flex-1 overflow-y-auto", BREAK.control)}
            key={tab.id}
            value={tab.id}
          >
            {tab.content}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
