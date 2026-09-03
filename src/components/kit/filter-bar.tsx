"use client";

import { ListFilter, Search, SlidersHorizontal, X } from "@/components/kit/icons";

import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";

import { SegmentedControl } from "@/components/kit/segmented-control";
import type { ViewDef } from "@/components/kit/view-switch";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useQueryState } from "@/lib/query-state";
import { cn } from "@/lib/utils";

export type { ViewDef } from "@/components/kit/view-switch";

export type FacetOption = {
  value: string;
  label: string;
  count?: number;
};

export type FacetGroup = {
  key: string;
  label: string;
  options: readonly FacetOption[];
  multi: boolean;
};

export type FilterBarProps = {
  views: readonly ViewDef[];
  facets: readonly FacetGroup[];
  searchPlaceholder: string;
  displayOptions?: ReactNode;
  /**
   * Rendered at the end of the controls row, after the search and the Filters popover. It is for
   * a note about the surface the bar sits over -- the leads board's drag hint, which
   * `LeadsBoard.dc.html` draws on this row -- not for another control.
   */
  trailing?: ReactNode;
  /** Applied to the saved-view segmented control so a screen with its own views rail can hide it. */
  viewsClassName?: string;
  /**
   * Raises the search field off the console's 13px `--t-body` to the coach surface's 16px in a
   * 44px control, which is what `Inbox.dc.html` and `Leads.dc.html` both draw. It is opt-in rather
   * than a `[data-shell-role="coach"]` rule because the console screens share this component and a
   * type change with no visible caller is the kind of blast radius nobody can see from the diff.
   */
  scale?: "console" | "coach";
  /**
   * Which view means "no `view` in the URL". It defaulted to the first segment, which is only the
   * same thing while the widest cohort is drawn first. `Inbox.dc.html` puts "Waiting on you" first
   * and "Everything" last, so the default has to be named rather than inferred from position --
   * otherwise clicking the first pill clears the parameter and lands the coach back on the cohort
   * they just navigated away from.
   */
  defaultViewKey?: string;
};

type AppliedFacet = {
  groupKey: string;
  groupLabel: string;
  value: string;
  optionLabel: string;
};

/**
 * The two operators the toolbar can actually express today. They are rendered as their own chip
 * segment rather than folded into the field label, so a reader can tell "Channel is Instagram"
 * from "Search contains instagram" without reading the punctuation.
 */
const CHIP_OPERATOR = {
  contains: "contains",
  is: "is",
} as const;

const SEARCH_DEBOUNCE_MS = 250;

function canonicalFacetValues(group: FacetGroup, values: readonly string[]) {
  const allowedValues = new Set(group.options.map((option) => option.value));
  const seenValues = new Set<string>();
  const validValues = values.filter((value) => {
    if (!allowedValues.has(value) || seenValues.has(value)) {
      return false;
    }

    seenValues.add(value);
    return true;
  });

  return group.multi ? validValues : validValues.slice(0, 1);
}

export function FilterBar({
  views,
  facets,
  searchPlaceholder,
  displayOptions,
  trailing,
  scale = "console",
  defaultViewKey,
  viewsClassName,
}: FilterBarProps) {
  const query = useQueryState();
  const getQueryValues = query.getAll;
  const setQueryValues = query.setMany;
  const queryText = query.get("q") ?? "";
  const requestedView = query.get("view");
  const fallbackViewKey = defaultViewKey ?? views.at(0)?.key ?? "";
  const activeView = views.find((view) => view.key === requestedView)?.key ?? fallbackViewKey;
  const [searchDraft, setSearchDraft] = useState(() => ({
    source: queryText,
    value: queryText,
  }));
  const searchText = searchDraft.source === queryText ? searchDraft.value : queryText;
  const setQueryValue = query.set;

  useEffect(() => {
    if (searchText === queryText) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setQueryValue("q", searchText.trim() || null);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [queryText, searchText, setQueryValue]);

  const activeFacetValues = useMemo(
    () =>
      new Map(
        facets.map((group) => [
          group.key,
          canonicalFacetValues(group, getQueryValues(group.key)),
        ]),
      ),
    [facets, getQueryValues],
  );

  useEffect(() => {
    const corrections: Record<string, readonly string[]> = {};

    for (const group of facets) {
      const currentValues = getQueryValues(group.key);
      const canonicalValues = activeFacetValues.get(group.key) ?? [];
      if (
        currentValues.length !== canonicalValues.length ||
        currentValues.some((value, index) => value !== canonicalValues[index])
      ) {
        corrections[group.key] = canonicalValues;
      }
    }

    if (Object.keys(corrections).length > 0) {
      setQueryValues(corrections);
    }
  }, [activeFacetValues, facets, getQueryValues, setQueryValues]);

  const appliedFacets = useMemo<AppliedFacet[]>(
    () =>
      facets.flatMap((group) => {
        const selected = activeFacetValues.get(group.key) ?? [];
        return group.options
          .filter((option) => selected.includes(option.value))
          .map((option) => ({
            groupKey: group.key,
            groupLabel: group.label,
            value: option.value,
            optionLabel: option.label,
          }));
      }),
    [activeFacetValues, facets],
  );

  const managedKeys = useMemo(
    () => ["view", "q", ...facets.map((facet) => facet.key)],
    [facets],
  );
  const hasManagedQuery = managedKeys.some((key) => query.has(key));

  const setFacet = (group: FacetGroup, option: FacetOption, checked: boolean) => {
    if (!checked) {
      query.remove(group.key, option.value);
      return;
    }

    if (!group.multi) {
      query.set(group.key, option.value);
      return;
    }

    query.toggle(group.key, option.value, true);
  };

  const removeSearch = () => {
    setSearchDraft({ source: queryText, value: "" });
    query.remove("q");
  };

  const clearAll = () => {
    setSearchDraft({ source: queryText, value: "" });
    query.clear();
  };

  const anythingToClear =
    queryText.length > 0 || appliedFacets.length > 0 || hasManagedQuery;

  // Escape clears the whole toolbar, which is what the chip row's `esc` hint promises. The
  // handler reads the latest closure through a ref so the listener is bound once per state of
  // "is there anything to clear", not once per keystroke in the search box.
  const clearAllRef = useRef(clearAll);
  useEffect(() => {
    clearAllRef.current = clearAll;
  });

  useEffect(() => {
    if (!anythingToClear) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      // An open popover, menu, or dialog owns Escape while it is up: it closes itself, and
      // wiping the filters out from under it would be a second, unasked-for action.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[role="dialog"],[role="menu"],[role="listbox"]')
      ) {
        return;
      }

      clearAllRef.current();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [anythingToClear]);

  return (
    <div
      className="mb-[var(--s-3)] flex min-w-0 flex-col gap-[var(--s-3)]"
      data-slot="filter-bar"
    >
      {views.length > 0 ? (
        <div className={cn("min-w-0", viewsClassName)}>
          <SegmentedControl
            ariaLabel="Views"
            onValueChange={(value) => {
              query.set("view", value === fallbackViewKey ? null : value);
            }}
            segments={views}
            value={activeView}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-[var(--s-2)]">
        <div className={cn("flex w-full items-center gap-[var(--s-2)] rounded-[var(--r-input)] [border-width:calc(var(--s-1)/4)] border-[var(--line-strong)] bg-[var(--card)] px-[var(--s-2)] text-[var(--faint)] focus-within:border-[var(--accent)] focus-within:ring-[var(--s-1)] focus-within:ring-[var(--focus-ring)] sm:max-w-[calc(var(--s-12)*5+var(--s-5))]", scale === "coach" ? "h-[44px]" : "h-[var(--s-8)]")}>
          <Search aria-hidden="true" className="size-[var(--s-4)] shrink-0" />
          <Input
            aria-label={searchPlaceholder}
            autoComplete="off"
            className={cn(
              "h-full border-0 bg-transparent px-0 [font-weight:var(--t-body-w)] [line-height:var(--t-body-lh)] [letter-spacing:var(--t-body-tr)] text-[var(--ink)] shadow-none transition-none placeholder:text-[var(--faint)] focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent",
              scale === "coach"
                ? "[font-size:16px] md:[font-size:16px]"
                : "[font-size:var(--t-body)] md:[font-size:var(--t-body)]",
            )}
            onChange={(event) =>
              setSearchDraft({ source: queryText, value: event.currentTarget.value })
            }
            placeholder={searchPlaceholder}
            type="search"
            value={searchText}
          />
        </div>

        <Popover>
          <PopoverTrigger
            render={
              <Button
                className="[font-size:var(--t-body)] transition-none"
                size="default"
                variant="outline"
              />
            }
          >
            <ListFilter aria-hidden="true" data-icon="inline-start" />
            Filters
            {appliedFacets.length > 0 ? (
              <span
                aria-label={`${appliedFacets.length} applied`}
                className="tabular rounded-[var(--r-full)] bg-[var(--accent-wash)] px-[var(--s-2)] py-[var(--s-1)] text-badge [color:var(--accent-text)]"
              >
                {appliedFacets.length}
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="Filters"
            className="w-[calc(var(--s-12)*6)] gap-0 rounded-[var(--r-card)] [border-width:calc(var(--s-1)/4)] border-[var(--line)] bg-[var(--raised)] p-[var(--s-2)] text-[var(--body)] shadow-[var(--shadow-raised)] duration-[var(--dropdown-open-dur)] ease-[var(--dropdown-ease)] motion-reduce:animate-none motion-reduce:transition-none"
            role="dialog"
          >
            <PopoverHeader className="sr-only">
              <PopoverTitle>Filters</PopoverTitle>
            </PopoverHeader>
            {facets.map((group, groupIndex) => (
              <section
                key={group.key}
                aria-labelledby={`filter-group-${group.key}`}
                className={
                  groupIndex === 0
                    ? "px-[var(--s-2)] py-[var(--s-2)]"
                    : "[border-top-width:calc(var(--s-1)/4)] border-[var(--line)] px-[var(--s-2)] py-[var(--s-2)]"
                }
              >
                <h3
                  className="mb-[var(--s-2)] text-over [color:var(--faint)]"
                  id={`filter-group-${group.key}`}
                >
                  {group.label}
                </h3>
                <div className="grid grid-cols-1 gap-[var(--s-1)] sm:grid-cols-2">
                  {group.options
                    .filter((option) => option.label.trim().toLocaleLowerCase() !== "all")
                    .map((option) => {
                      const checked =
                        activeFacetValues.get(group.key)?.includes(option.value) ?? false;
                      return (
                        <div
                          key={option.value}
                          className="flex min-h-[var(--s-8)] items-center gap-[var(--s-2)] rounded-[var(--r-control)] px-[var(--s-1)] text-body [color:var(--body)] hover:bg-[var(--row-hover)]"
                        >
                          <Checkbox
                            aria-label={`${group.label}: ${option.label}`}
                            checked={checked}
                            className="transition-none"
                            onCheckedChange={(nextChecked) =>
                              setFacet(group, option, nextChecked)
                            }
                            value={option.value}
                          />
                          <span>{option.label}</span>
                          {option.count !== undefined ? (
                            <span
                              aria-label={`${option.count} items`}
                              className="tabular ml-auto text-badge [color:var(--faint)]"
                            >
                              {option.count}
                            </span>
                          ) : null}
                        </div>
                      );
                    })}
                </div>
              </section>
            ))}
          </PopoverContent>
        </Popover>

        {displayOptions !== undefined ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="[font-size:var(--t-body)] transition-none"
                  size="default"
                  variant="outline"
                />
              }
            >
              <SlidersHorizontal aria-hidden="true" data-icon="inline-start" />
              Display
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              aria-label="Display options"
              className="min-w-[calc(var(--s-12)*4)] rounded-[var(--r-card)] bg-[var(--raised)] p-[var(--s-1)] shadow-[var(--shadow-raised)] duration-[var(--dropdown-open-dur)] ease-[var(--dropdown-ease)] motion-reduce:animate-none motion-reduce:transition-none"
            >
              <DropdownMenuGroup>
                <DropdownMenuLabel className="text-over [color:var(--faint)]">
                  Display options
                </DropdownMenuLabel>
                {displayOptions}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {trailing ? <div className="ml-auto flex min-w-0 items-center">{trailing}</div> : null}
      </div>

      {anythingToClear ? (
        <div
          aria-label="Applied filters"
          className="flex flex-wrap items-center gap-[calc(var(--s-1)+var(--s-1)/2)]"
        >
          {queryText ? (
            <FilterChip
              label="Search"
              onRemove={removeSearch}
              operator={CHIP_OPERATOR.contains}
              value={queryText}
            />
          ) : null}
          {appliedFacets.map((facet) => (
            <FilterChip
              key={`${facet.groupKey}:${facet.value}`}
              label={facet.groupLabel}
              onRemove={() => query.remove(facet.groupKey, facet.value)}
              operator={CHIP_OPERATOR.is}
              value={facet.optionLabel}
            />
          ))}
          <button
            aria-label="Clear all"
            className="inline-flex items-center gap-[var(--s-2)] rounded-[var(--r-control)] px-[var(--s-2)] py-[var(--s-1)] [font-size:var(--t-body)] [line-height:var(--t-body-lh)] [color:var(--muted)] transition-none hover:bg-[var(--row-hover)] hover:[color:var(--ink)] focus-visible:[outline:calc(var(--s-1)/2)_solid_var(--focus-ring)]"
            data-slot="filter-clear-all"
            onClick={clearAll}
            type="button"
          >
            Clear all
            <kbd
              aria-hidden="true"
              className="inline-flex h-[var(--s-4)] items-center rounded-[calc(var(--r-control)/2)] [border-width:calc(var(--s-1)/4)] border-[var(--line)] bg-[var(--quiet)] px-[calc(var(--s-1)+var(--s-1)/2)] [font-family:var(--font-mono)] [font-size:var(--t-mono-crumb)] [font-weight:var(--t-mono-crumb-w)] [line-height:var(--t-mono-crumb-lh)] [color:var(--faint)]"
              data-slot="filter-clear-all-key"
            >
              esc
            </kbd>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * One applied filter, drawn as three segments (field, operator, value) divided by hairlines.
 * The value is the part a reader is scanning for, so it alone sits in ink at weight 500; the
 * field and the operator stay muted because they are the grammar, not the answer.
 */
function FilterChip({
  label,
  operator,
  value,
  onRemove,
}: {
  label: string;
  operator: string;
  value: string;
  onRemove: () => void;
}) {
  const segment =
    "inline-flex items-center px-[calc(var(--s-1)+var(--s-1)/2)] [font-size:var(--t-badge)] [line-height:var(--t-badge-lh)] [letter-spacing:var(--t-badge-tr)]";
  const divider = "[border-left-width:calc(var(--s-1)/4)] border-[var(--line)]";

  return (
    <span
      className="inline-flex h-[calc(var(--s-6)+var(--s-1)/2)] items-stretch overflow-hidden rounded-[var(--r-input)] [border-width:calc(var(--s-1)/4)] border-[var(--line-strong)] bg-[var(--card)]"
      data-slot="filter-chip"
    >
      <span
        className={cn(segment, "[font-weight:var(--t-body-w)] [color:var(--muted)]")}
        data-chip-segment="field"
      >
        {label}
      </span>
      <span
        className={cn(segment, divider, "[font-weight:var(--t-body-w)] [color:var(--muted)]")}
        data-chip-segment="operator"
      >
        {operator}
      </span>
      <span
        className={cn(segment, divider, "[font-weight:500] [color:var(--ink)]")}
        data-chip-segment="value"
      >
        {value}
      </span>
      <button
        aria-label={`Remove ${label.toLocaleLowerCase()} filter`}
        className={cn(
          divider,
          "grid w-[var(--s-6)] shrink-0 place-items-center text-[var(--muted)] transition-none hover:bg-[var(--quiet)] hover:text-[var(--ink)] focus-visible:[outline:calc(var(--s-1)/2)_solid_var(--focus-ring)]",
        )}
        onClick={onRemove}
        type="button"
      >
        <X aria-hidden="true" className="size-[var(--s-3)]" />
      </button>
    </span>
  );
}
