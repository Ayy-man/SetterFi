import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Fragment } from "react";

export type Crumb = {
  label: string;
  href?: string;
};

export function AppBreadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  // One crumb is the top-level page that sits in no group (Overview); three is
  // the ceiling, because a fourth level means the IA is too deep.
  if (crumbs.length < 1 || crumbs.length > 3) {
    throw new RangeError("Breadcrumbs require one to three items.");
  }

  return (
    <Breadcrumb aria-label="Breadcrumb" className="min-w-0">
      {/*
        Mono 11 (`--t-mono-crumb`): the trail is machine-ish metadata about where you are, not
        running prose, and setting it in the mono face separates it from the page title an inch
        below it without needing a rule or a colour.
      */}
      <BreadcrumbList
        className="t-mono-crumb flex-nowrap gap-[calc(var(--s-1)+var(--s-1)/2)]"
        data-slot="app-breadcrumb-list"
      >
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;

          return (
            <Fragment key={`${crumb.label}:${index}`}>
              <BreadcrumbItem className={isLast ? "min-w-0" : "max-sm:hidden"}>
                {isLast ? (
                  /*
                    `--body`, not `--ink`. All 24 admin artboards draw the trail's three parts at
                    three different weights of the same ramp -- root and links `--faint`, the
                    separator `--meta`, the current page `--body`
                    (`AdminClients.dc.html:207-208`, byte-identical on the other 23) -- and the
                    point of ending at `--body` rather than at the top of the ramp is that the
                    trail has to stay quieter than the page title an inch below it. At `--ink` the
                    crumb is set in the same colour as the `<h1>` it annotates and competes with
                    it; the drop to 12.6:1 is still far clear of AA.
                  */
                  <span
                    aria-current="page"
                    className="block truncate text-[var(--body)]"
                    data-slot="app-breadcrumb-current"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <BreadcrumbLink
                    className="text-[var(--faint)] hover:text-[var(--ink)]"
                    href={crumb.href}
                  >
                    {crumb.label}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {/*
                The separator takes `--meta`, a step below the links it divides: the slash is
                punctuation, and at the links' own `--faint` it had the same presence as the names
                it separates. Drawn that way on all 24 admin artboards
                (`AdminClients.dc.html:208`).
              */}
              {!isLast ? (
                <BreadcrumbSeparator className="text-[var(--meta)] max-sm:hidden">
                  <span>/</span>
                </BreadcrumbSeparator>
              ) : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
