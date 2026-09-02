// @vitest-environment node

/**
 * Every container query in the tree has to resolve against a container that actually exists.
 *
 * A Tailwind container query fails open in the loudest possible way: `@min-[440px]:flex-row`
 * compiles to a valid `@container` rule whether or not anything above it ever declared
 * `container-type`, so an unsatisfiable query is not a build error, not a type error, and not
 * visible to any render test -- the element simply keeps its base layout at every width, and the
 * screen looks like somebody drew it that way on purpose. Two of those shipped and were found by
 * eye rather than by tooling: `GridTable` put the query and the `@container` on one element, and
 * the affiliate's referral slot queried a container that was declared nowhere in its ancestry.
 *
 * A resolving query is necessary and not sufficient, which is worth knowing before trusting this
 * file: `GridTable` also set the custom property the query swaps as an inline `style`, and inline
 * outranks any class, so the query could match at the right width and still change nothing. That
 * half is checked in `atomics-controls.test.tsx`, not here.
 *
 * There are three ways to get it wrong and they are checked separately below:
 *
 *   1. **Collision.** The query and the `@container` it needs are on the same element. A query
 *      resolves against an *ancestor* container and never against the element establishing its
 *      own, so this never matches at any width.
 *   2. **No container at all.** Nothing in the ancestry declares one. No CSS file in this repo
 *      sets `container-type`, so every container in the tree comes from a Tailwind utility and
 *      this file can see all of them.
 *   3. **Named at nothing.** `@min-[440px]/pane:` where no element anywhere declares
 *      `@container/pane`.
 *
 * **A second thing it misses: a collision assembled across two files.** `admin-money-affiliates.tsx`
 * passes `@min-[300px]:grid-cols-2` as `className` into `<Surface>`, and `Surface` puts
 * `@container` on the element that class lands on -- a collision, built out of two files that are
 * each fine on their own. It is filed under `NO_CONTAINER` below because that is what a per-file
 * scan can see, and the note on its line says what it really is. Passing a query into a component
 * that might be a container is the shape to distrust.
 *
 * **A fourth way exists and this file does not catch it: resolving against the wrong container.**
 * `admin-agent-performance.tsx` queried `/perf`, the scroll pane it mounts itself, so the table's
 * narrow template switched on the pane's width rather than the table's own box -- a real
 * container, a resolving query, and the wrong measurement. Which container a query *should* name
 * is a judgement about the layout, so nothing here can decide it; that one was found by reading
 * the call site. Do not read a green run as "every query measures the right thing". It means no
 * query measures nothing.
 *
 * **What else this file can and cannot prove.** Ancestry crosses component boundaries -- a query in
 * one file routinely resolves against a container declared in another -- and no regex resolves
 * React composition. So a *named* query is checked properly: the name is either declared
 * somewhere in `src/` or it is not, and that is the whole question. An *unnamed* query can only
 * be checked as far as "does this file declare a bare container at all", which is necessary and
 * not sufficient: it still binds to whichever anonymous container happens to be nearest at
 * runtime, which is the latent variant -- correct today, wrong the moment somebody wraps the
 * screen in a `Surface`. Those are held in `WEAK` below rather than passed silently, so no new
 * one arrives without somebody editing this file and reading this paragraph.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = new URL("../", import.meta.url).pathname;

const QUERY =
  /@(?:min|max)-\[[^\]]+\](?:\/([\w-]+))?:|@(?:xs|sm|md|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl)(?:\/([\w-]+))?:/gu;
const CONTAINER = /@container(?:\/([\w-]+))?(?![\w-])/gu;
const CONST_STRING =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gu;

type Site = { file: string; kind: "collision" | "no-container" | "named-at-nothing" | "weak" | "ok"; query: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/u.test(name) && !name.includes(".test.")) out.push(path);
  }
  return out.sort();
}

/**
 * Every `className` value in a file, as one string per element.
 *
 * Grouping by element rather than by string literal is what makes the collision check work at
 * all: `cn("@container flex-col", "@min-[440px]:flex-row")` is two literals and one element, and
 * reading it as two elements reports a real collision as fine. Locally declared class constants
 * are spliced in for the same reason -- a card whose face class lives in a `const` at the top of
 * the file still carries whatever that const says.
 */
function classNameAttributes(source: string): { index: number; text: string }[] {
  const attributes: { index: number; text: string }[] = [];
  for (const match of source.matchAll(/className=/gu)) {
    const start = match.index + match[0].length;
    let text = "";
    if (source[start] === '"') {
      text = source.slice(start + 1, source.indexOf('"', start + 1));
    } else if (source[start] === "{") {
      let depth = 0;
      let index = start;
      while (index < source.length) {
        if (source[index] === "{") depth += 1;
        else if (source[index] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
        index += 1;
      }
      text = source.slice(start + 1, index);
    }
    if (text) attributes.push({ index: match.index, text });
  }
  return attributes;
}

function elementClassLists(source: string): string[] {
  const constants = new Map<string, string>();
  for (const [, name, dq, sq, tq] of source.matchAll(CONST_STRING)) {
    constants.set(name, dq ?? sq ?? tq ?? "");
  }

  return classNameAttributes(source).map(({ text }) => {
    let expanded = text;
    for (const [name, value] of constants) {
      if (new RegExp(`\\b${name}\\b`, "u").test(text)) expanded += ` ${value}`;
    }
    return expanded;
  });
}

/** The analysis itself, over a set of files, so the fixtures below run through the same code. */
function classify(sources: Map<string, string>): Site[] {
  const declaredNames = new Set<string>();
  const declaresAnonymous = new Set<string>();
  for (const [file, source] of sources) {
    for (const [, name] of source.matchAll(CONTAINER)) {
      if (name) declaredNames.add(name);
      else declaresAnonymous.add(file);
    }
  }

  const sites: Site[] = [];
  for (const [file, source] of sources) {
    for (const list of elementClassLists(source)) {
      const queries = [...list.matchAll(QUERY)];
      if (queries.length === 0) continue;
      const onThisElement = new Set([...list.matchAll(CONTAINER)].map(([, name]) => name ?? ""));

      for (const query of queries) {
        const name = query[1] ?? query[2] ?? "";
        const kind: Site["kind"] = onThisElement.has(name)
          ? "collision"
          : name
            ? declaredNames.has(name)
              ? "ok"
              : "named-at-nothing"
            : declaresAnonymous.has(file)
              ? "weak"
              : "no-container";
        sites.push({ file, kind, query: query[0] });
      }
    }
  }
  return sites;
}

/**
 * The sites of one kind, as `file query` with no line number and no count.
 *
 * Deliberately coarse. Line numbers churn every time anybody edits a screen, and counts move when
 * a class list is refactored without a query changing at all; either one would make the ledgers
 * below fail for reasons that have nothing to do with container queries, on six lanes at once.
 * What is worth failing on is a file gaining a broken query it did not have.
 */
function tally(sites: Site[], kind: Site["kind"]): string[] {
  return [...new Set(sites.filter((entry) => entry.kind === kind).map((site) => `${site.file} ${site.query}`))].sort();
}

/**
 * What is in the tree and not in the ledger -- the assertion direction that matters.
 *
 * One-directional on purpose. A lane that *fixes* one of these must not turn every other lane's
 * gate red for the minutes before somebody prunes the ledger, so a disappeared entry passes
 * silently and the list here goes stale in the safe direction. A lane that *adds* one fails
 * immediately, which is the whole point: that is the defect this file exists to catch, and it is
 * invisible to typecheck, lint, and every render test in the project.
 *
 * This is a deliberate trade and not an oversight, so do not "tighten" it into a two-way equality:
 * that guard punishes the lane that fixes something, and a guard people route around is worth
 * less than a loose one they keep. What would justify reversing it is the contention going away
 * -- one lane in these files, and a stale ledger costing more than a red gate. Until then the
 * lists rot in the safe direction and want an occasional prune.
 */
function unrecorded(sites: Site[], kind: Site["kind"], ledger: readonly string[]): string[] {
  return tally(sites, kind).filter((entry) => !ledger.includes(entry));
}

/**
 * Components that put `@container` on the very element they merge the caller's `className` onto.
 *
 * Derived rather than listed, so the next one somebody writes is covered without anybody
 * remembering this file exists. `Surface` is the live example: `cn("@container", ..., className)`,
 * which means any class a caller hands it lands on the container itself. `GridTable` was one until
 * it grew its wrapper, and it correctly drops out of this set now.
 */
function containerMergingComponents(sources: Map<string, string>): Map<string, Set<string>> {
  const merging = new Map<string, Set<string>>();
  for (const source of sources.values()) {
    for (const { index, text } of classNameAttributes(source)) {
      const declared = [...text.matchAll(CONTAINER)].map(([, name]) => name ?? "");
      if (declared.length === 0 || !/\bclassName\b/u.test(text)) continue;
      const declaration = [...source.slice(0, index).matchAll(/function\s+([A-Z][\w$]*)\s*\(/gu)].pop();
      if (!declaration) continue;
      const existing = merging.get(declaration[1]) ?? new Set<string>();
      for (const name of declared) existing.add(name);
      merging.set(declaration[1], existing);
    }
  }
  return merging;
}

/**
 * Call sites handing one of those components a container query as `className`.
 *
 * This is the fifth mechanism and the only one no per-file reading can find, because neither file
 * contains the defect: `admin-money-affiliates.tsx` passes `@min-[300px]:grid-cols-2` into
 * `<Surface>`, `Surface` puts `@container` on the element that class merges onto, and the
 * collision exists only in the composition of the two. Both files are correct alone. Passing a
 * query into a component that might be a container is the shape to distrust, and it will recur,
 * because handing a component a class is the natural way to make it responsive from outside.
 */
function passedIntoAContainer(sources: Map<string, string>, components: Map<string, Set<string>>): string[] {
  const found: string[] = [];
  for (const [file, source] of sources) {
    for (const [component, declared] of components) {
      for (const opening of source.matchAll(new RegExp(`<${component}\\b[^>]*`, "gu"))) {
        const className = /className=(?:"([^"]*)"|\{([^}]*)\})/u.exec(opening[0]);
        if (!className) continue;
        const value = className[1] ?? className[2] ?? "";
        for (const query of [...value.matchAll(QUERY)]) {
          // Only a query the merged container would *answer* is a collision. A named query
          // resolves past it to the container it names, which is exactly why naming is the fix:
          // `coach-integrations.tsx` hands `Surface` an `@xl/page:` class and is fine, because
          // `/page` is declared above it and `Surface`'s own container is anonymous.
          const name = query[1] ?? query[2] ?? "";
          if (declared.has(name)) found.push(`${file} <${component} className="${query[0]}...">`);
        }
      }
    }
  }
  return [...new Set(found)].sort();
}

function treeSources(): Map<string, string> {
  return new Map(
    sourceFiles(SRC).map((path) => [path.slice(SRC.length), readFileSync(path, "utf8")]),
  );
}

describe("the container-query detector", () => {
  /*
    Both directions, because a detector that never fires reads exactly like a clean tree, and this
    one is a pile of regexes over class strings -- the day somebody renames the utility prefix it
    would go quiet and stay green. These four fixtures are the only evidence that it can still
    see anything.
  */
  const fixtures = new Map([
    ["dead.tsx", `<div className="flex flex-col @min-[440px]:flex-row" />`],
    ["collide.tsx", `<div className={cn("@container flex-col", "@min-[440px]:flex-row")} />`],
    ["misnamed.tsx", `<div className="@container/pane"><i className="@min-[440px]/nowhere:flex" /></div>`],
    ["fine.tsx", `<div className="@container/pane"><i className="@min-[440px]/pane:flex" /></div>`],
  ]);

  it("flags a query with no container in its file", () => {
    expect(classify(fixtures).filter((site) => site.file === "dead.tsx")).toEqual([
      { file: "dead.tsx", kind: "no-container", query: "@min-[440px]:" },
    ]);
  });

  it("flags a query sharing an element with the container it would have to resolve past", () => {
    expect(classify(fixtures).filter((site) => site.file === "collide.tsx")).toEqual([
      { file: "collide.tsx", kind: "collision", query: "@min-[440px]:" },
    ]);
  });

  it("flags a query naming a container nothing declares", () => {
    expect(classify(fixtures).filter((site) => site.file === "misnamed.tsx")).toEqual([
      { file: "misnamed.tsx", kind: "named-at-nothing", query: "@min-[440px]/nowhere:" },
    ]);
  });

  it("finds the components that merge className onto their own container, and only those", () => {
    const merging = new Map([
      ["surface.tsx", `export function Surface({ className }) { return <div className={cn("@container", className)} />; }`],
      ["wrapped.tsx", `export function Wrapped({ className }) { return <div className="@container/w"><i className={cn("x", className)} /></div>; }`],
    ]);
    expect([...containerMergingComponents(merging).keys()]).toEqual(["Surface"]);
  });

  it("flags a query handed to a component that puts @container on the class it merges", () => {
    const composed = new Map([
      ["surface.tsx", `export function Surface({ className }) { return <div className={cn("@container", className)} />; }`],
      ["caller.tsx", `<Surface className="grid @min-[300px]:grid-cols-2" />`],
      ["innocent.tsx", `<Surface className="grid gap-2" />`],
      // Named at a container declared elsewhere, so it resolves past Surface's anonymous one.
      ["named.tsx", `<Surface className="@min-[300px]/page:grid-cols-2" />`],
    ]);
    const merging = containerMergingComponents(composed);
    expect(passedIntoAContainer(composed, merging)).toEqual([
      'caller.tsx <Surface className="@min-[300px]:...">',
    ]);
  });

  it("does not flag a query resolving to a named ancestor container", () => {
    expect(classify(fixtures).filter((site) => site.file === "fine.tsx")).toEqual([
      { file: "fine.tsx", kind: "ok", query: "@min-[440px]/pane:" },
    ]);
  });
});

describe("container queries in the tree", () => {
  const sources_ = treeSources();
  const sites = classify(sources_);

  /*
    One assertion per `it`, deliberately.

    The first version of this file put the collision and no-container checks in one test, and the
    regeneration run reported no-container as *empty* -- which was false. The collision assertion
    above it failed first, so the second one never executed. An empty list out of a test that has
    already failed is not a finding, it is an unexecuted assertion, and it reads exactly like a
    clean result. Split, both report.

    The general form, which cost two break-proofs elsewhere the same night: a multi-assertion test
    hides everything after the first failure.
  */
  it("scanned a tree that actually has container queries in it", () => {
    // Not a smoke test: every assertion below is over a filtered list, and an empty scan satisfies
    // all of them. The tree carried ~90 queries when this was written.
    expect(sites.length).toBeGreaterThan(60);
    expect(sites.filter((site) => site.kind === "ok").length).toBeGreaterThan(30);
  });

  /**
   * What the sweep of 2026-09-01 found, and none of it is acceptable -- each line is a screen
   * rendering its narrow layout at every width.
   *
   * They are recorded rather than fixed because every one sits in a file another lane was editing
   * that night. The shape the fix takes is `grid-table.tsx`'s: a wrapper declaring a *named*
   * container, with the query on the element inside.
   *
   * **They are not all equally hard, and the note on each line says which.** Only the kit atomics
   * -- `queue-item.tsx`'s `NoteStrip` and `setting-row.tsx`'s two -- forward a caller's
   * `className`, and there the wrapper is a real decision: `className` carries layout the caller
   * meant for the element that positions itself, so moving the container out without moving
   * `className` with it silently drops a caller's `flex-1` or grid placement onto an element that
   * no longer positions anything. The screen-level ones take no `className` prop at all; several
   * only need the declaration moved one element up, to a `<li>` or `<ul>` that is already sitting
   * there free.
   *
   * Deleting a line is how a lane records that it fixed one -- and it never has to, because
   * `unrecorded` only fails on additions. Nothing should be added without saying who is fixing it.
   */
  const COLLISION: readonly string[] = [
    // NoteStrip root declares it, queries it, AND takes the caller className
    "components/kit/atomics/queue-item.tsx @min-[420px]:",
    // SettingRow root: same three-in-one as NoteStrip; children at :102 depend on the container
    "components/kit/atomics/setting-row.tsx @min-[440px]:",
    // CollapsedSettingCard <button> (className) and SettingSection toggle <button> (no className; the panel div above it already declares one)
    "components/kit/atomics/setting-row.tsx @min-[520px]:",
    // local SettingRow copy, no className prop at all -- a wrapper is safe here
    "components/workspace/live/account-security-settings.tsx @min-[440px]:",
    // panel toggle <button>, no className prop; its parent panel div already declares a container
    "components/workspace/live/account-security-settings.tsx @min-[520px]:",
    // one div holds @container/agents and @3xl/agents:, no className prop -- move the declaration up one
    "components/workspace/live/admin-agents.tsx @3xl/agents:",
    // the job <article> (its <li> parent is free) and the provider <li> (its <ul> parent is free); neither takes a className prop
    "components/workspace/live/admin-system-health.tsx @min-[520px]:",
  ];

  const NO_CONTAINER: readonly string[] = [
    // plain <nav>, no className prop; nothing above it is a container
    "app/page.tsx @min-[560px]:",
    // plain grid div inside a DeckPanel, which declares no container
    "app/signup/signup-form.tsx @min-[520px]:",
    // plain grid div, page level
    "components/onboarding/coach-onboarding.tsx @min-[1000px]:",
    // plain grid div inside a DeckPanel, which declares no container
    "components/onboarding/coach-onboarding.tsx @min-[520px]:",
    // surface-strip div -- the class is CSS-only and sets no container-type
    "components/onboarding/connect-channels.tsx @min-[720px]:",
    // surface-strip div, same shape as connect-channels
    "components/onboarding/offer-review.tsx @min-[720px]:",
    // plain grid div wrapping DeckPanels
    "components/onboarding/offer-review.tsx @min-[860px]:",
    // NOT what it looks like: the query is passed as className into <Surface>, which declares @container on that same element -- a collision across a file boundary, which the per-file scan cannot see
    "components/workspace/live/admin-money-affiliates.tsx @min-[300px]:",
    // plain row div, no className prop
    "components/workspace/live/offer-editor-chrome.tsx @min-[440px]:",
  ];

  it("grows no new collision between a query and its own container", () => {
    expect(unrecorded(sites, "collision", COLLISION), "a new query shares an element with its own container").toEqual([]);
  });

  it("grows no new query with no container anywhere in its file", () => {
    expect(unrecorded(sites, "no-container", NO_CONTAINER), "a new query has no container to resolve against").toEqual([]);
  });

  it("never points a named query at a container nothing declares", () => {
    // Nothing on this one, and it stays that way: a name is fully checkable, so there is no
    // reason for this list to ever be non-empty.
    expect(tally(sites, "named-at-nothing")).toEqual([]);
  });

  /**
   * The fifth mechanism, ledgered like the rest.
   *
   * One entry, and it is the same site that sits in `NO_CONTAINER` above -- filed there because
   * that is what a per-file scan sees, and named here for what it actually is.
   */
  const PASSED_INTO_A_CONTAINER = [
    'components/workspace/live/admin-money-affiliates.tsx <Surface className="@min-[300px]:...">',
  ];

  it("hands no new container query to a component that is itself the container", () => {
    const merging = containerMergingComponents(sources_);
    // The detector is worthless if it found no such components to check against.
    expect(merging.size, "no container-merging component was found to check call sites against").toBeGreaterThan(0);
    expect(
      passedIntoAContainer(sources_, merging).filter((entry) => !PASSED_INTO_A_CONTAINER.includes(entry)),
      "a query was passed as className into a component that declares @container on it",
    ).toEqual([]);
  });

  /**
   * The latent variant: an unnamed query in a file that does declare an unnamed container. It
   * resolves at runtime, and it resolves against whichever anonymous container is nearest, which
   * is not necessarily the one the author meant and changes the day somebody wraps the screen in
   * a `Surface` -- itself a bare `@container`. Frozen for the same reason as the two lists above:
   * new code names its container.
   */
  const WEAK: readonly string[] = [
    // NoteStrip root declares it, queries it, AND takes the caller className
    "components/kit/atomics/queue-item.tsx @min-[420px]:",
    // SettingRow root: same three-in-one as NoteStrip; children at :102 depend on the container
    "components/kit/atomics/setting-row.tsx @min-[440px]:",
    // CollapsedSettingCard <button> (className) and SettingSection toggle <button> (no className; the panel div above it already declares one)
    "components/kit/atomics/setting-row.tsx @min-[520px]:",
    "components/kit/atomics/surface.tsx @min-[380px]:",
    // local SettingRow copy, no className prop at all -- a wrapper is safe here
    "components/workspace/live/account-security-settings.tsx @min-[440px]:",
    // panel toggle <button>, no className prop; its parent panel div already declares a container
    "components/workspace/live/account-security-settings.tsx @min-[520px]:",
    "components/workspace/live/admin-audit-log.tsx @min-[720px]:",
    "components/workspace/live/admin-audit-log.tsx @min-[860px]:",
    "components/workspace/live/admin-brain.tsx @min-[560px]:",
    "components/workspace/live/admin-brain.tsx @min-[640px]:",
    "components/workspace/live/admin-brain.tsx @min-[720px]:",
    "components/workspace/live/affiliate-money.tsx @min-[440px]:",
  ];

  it("adds no new unnamed query leaning on whichever container happens to be nearest", () => {
    expect(unrecorded(sites, "weak", WEAK), "a new unnamed query leans on whichever container is nearest").toEqual([]);
  });
});
