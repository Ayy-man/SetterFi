import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * The half of the coach type floor that lives outside the coach's own directory.
 *
 * `coach-type-floor.test.ts` enforces `docs/SIMPLIFICATION-SPEC.md` §5 -- "nothing below 14px,
 * ever" on the coach surface -- over the modules a coach route reaches and an admin route does
 * not. Its own docstring names what that cannot see: "A shared atomic that renders too small ON a
 * coach page is a real defect this cannot see." That blind spot is not hypothetical. It has now
 * produced the same defect twice:
 *
 *   - `Overline`, 9.5px, mounted seven times on coach Home. Round 4 found it; the fix was a ban
 *     written against that one component by name.
 *   - `Segmented`, 12px, which is the range picker at the top of coach Home. `Main.dc.html:114-118`
 *     draws that control at 16px/500 in 44px pills, and the 12px is *correct* for the eight
 *     console artboards that mount the same atomic. Round 5 found it, in the fifth pass over a
 *     screen four passes had already read.
 *
 * A directory is the wrong unit for this rule, which is the point of this file. §5 is about what a
 * coach *sees*, and a shared atomic mounted on a coach page is a coach surface at render time no
 * matter which folder its px literal is typed in. So the walk here does not subtract admin: it
 * takes every module the coach shell transitively mounts, and judges the shared ones on whether
 * the coach can reach a rendering under the floor.
 *
 * ## Why this is two rules and not one
 *
 * "No sub-14px literal in anything the coach reaches" is the naive rule, and it reports about a
 * hundred violations that are the console being correctly itself: the console is 13.5px body with
 * 30-34px targets and shares most of the kit. The signal is not the presence of a small number,
 * it is whether the coach can end up rendering one:
 *
 *   1. A shared component whose *every* size is under the floor has no legible arm at all, so
 *      mounting it from a coach page is a defect however it is configured. That is the `Overline`
 *      rule, derived from the recipe rather than written against one name -- and it is what would
 *      have caught `Segmented` before the fix, when 12 / 12.5 / 11 were the only sizes it had.
 *   2. A shared component with both a small and a legible arm is fine to mount, provided the
 *      coach's mount selects the legible one. That needs the callsite, and the registry below is
 *      where each such component declares which prop does the selecting. Every row is checked
 *      against the atomic's own source, so a row cannot outlive the arm it names.
 *
 * ## The candidate filter
 *
 * Candidates are selected by *being mounted from a coach module*, never by their size, because a
 * filter that selects on the property it then judges cannot report a defect in that property.
 * That is not a hypothetical either: another guard in this repo filtered candidates on the exact
 * tracking value before bucketing them, and two drifted sites walked straight through it.
 */
const ROOT = process.cwd();
const SOURCE_EXTENSIONS = [".ts", ".tsx"];
const FLOOR = 14;

function entryFiles(directory: string): string[] {
  const absolute = resolve(ROOT, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { recursive: true, encoding: "utf8" })
    .map((entry) => resolve(absolute, entry))
    .filter((path) => statSync(path).isFile() && SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext)));
}

function importSpecifiers(source: string): string[] {
  return [
    /\bfrom\s+["']([^"']+)["']/g,
    /\bimport\s+["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveSpecifier(specifier: string, fromFile: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  for (const candidate of [
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
    SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) ? base : null,
  ]) {
    if (candidate && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachable(directory: string): Set<string> {
  const seen = new Set<string>();
  const queue = entryFiles(directory);

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || /\.test\.tsx?$/.test(file)) continue;
    seen.add(file);

    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveSpecifier(specifier, file);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
  }

  return seen;
}

const COACH = reachable("src/app/(workspace)/coach");
const ADMIN = reachable("src/app/(workspace)/admin");

/** Everything the coach shell mounts, transitively -- shared kit included. This is the surface. */
function coachSurfaceModules(): string[] {
  return [...COACH].map((file) => relative(ROOT, file)).sort();
}

/** The modules on that surface that an admin route also reaches: the shared half. */
function sharedModules(): string[] {
  return [...COACH].filter((file) => ADMIN.has(file)).map((file) => relative(ROOT, file)).sort();
}

/** The modules on that surface that exist only for the coach: the half the sibling file polices. */
function coachOnlyModules(): string[] {
  return [...COACH].filter((file) => !ADMIN.has(file)).map((file) => relative(ROOT, file)).sort();
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(?<!:)\/\/[^\n]*/g, " ");
}

function read(file: string): string {
  return withoutComments(readFileSync(resolve(ROOT, file), "utf8"));
}

/** Px sizes a slice of source sets, from either a Tailwind arbitrary value or a CSS declaration. */
function pxSizes(source: string): number[] {
  return [...source.matchAll(/text-\[(\d+(?:\.\d+)?)px\]|font-size:\s*(\d+(?:\.\d+)?)px/g)]
    .map((match) => Number(match[1] ?? match[2]));
}

type Recipe = { component: string; file: string; sizes: number[] };

/**
 * Every exported component in a module, paired with the px sizes its own body sets.
 *
 * Sliced export-to-export rather than parsed, for the same reason the sibling file slices
 * `Overline`: two components in one file must not lend each other their sizes. `UnderlineTabs` is
 * 13.5px and lives beside `Segmented`; reading the file whole would have let either one hide
 * behind the other.
 */
function recipes(file: string): Recipe[] {
  const source = read(file);
  const starts = [...source.matchAll(/\bexport\s+(?:default\s+)?(?:function|const)\s+([A-Z]\w*)/g)];

  return starts.map((match, index) => {
    const from = match.index!;
    const to = index + 1 < starts.length ? starts[index + 1].index! : source.length;
    return { component: match[1], file, sizes: pxSizes(source.slice(from, to)) };
  });
}

/** Components a coach-only module writes into its JSX. */
function coachMountedNames(): Set<string> {
  const mounted = new Set<string>();
  for (const file of coachOnlyModules()) {
    for (const match of read(file).matchAll(/<([A-Z]\w*)[\s/>]/g)) mounted.add(match[1]);
  }
  return mounted;
}

describe("the coach surface is the whole coach surface, not the coach directory", () => {
  it("walks both halves of it", () => {
    // The positive control. A resolver change returning nothing would leave every assertion below
    // iterating over an empty set and passing, which is how the contrast suite went blind.
    const surface = coachSurfaceModules();
    const shared = sharedModules();

    expect(surface.length).toBeGreaterThan(80);
    expect(shared.length).toBeGreaterThan(20);
    // The shared half has to actually contain the atomics, or "shared" is a word this file uses
    // about nothing. Both of the defects this file exists for are in these two files.
    expect(shared).toContain("src/components/kit/atomics/segmented.tsx");
    expect(shared).toContain("src/components/kit/atomics/type.tsx");
    // And the coach-only half is still the thing the sibling guard reads, so the two partition
    // the surface between them rather than overlapping or leaving a gap.
    expect(coachOnlyModules()).toContain("src/components/workspace/rehaul/coach-dashboard.tsx");
    expect(shared.length + coachOnlyModules().length).toBe(surface.length);
  });
});

/**
 * Rule 1: a shared component with no legible arm may not be mounted on a coach page.
 *
 * DEBT holds what was already mounted when this landed, each row asserted to still be a violation
 * so that fixing one without deleting its row fails. A stale allow-list is how the 12px eyebrow
 * survived three rounds.
 */
const SHARED_MOUNT_DEBT: Record<string, string> = {
  // `Chip` (12px label) and `NoteStrip` (12.5px) had rows here until the rehaul took the live
  // offer, conversations and measurement surfaces, which were the coach's only mounts of them.
  // Neither atomic changed; no coach page reaches them any more, so the rule has nothing to say.
  // Ten of them, found the moment the walk stopped subtracting admin. None is the defect this
  // file was opened for and none is this lane's to fix, but they are the same defect: a console
  // atomic rendering console sizes on a page whose floor is 14px. Each is a coach screen reading
  // 11-13.5px somewhere today.
  // Seven more rows (Callout, DataTable, KeyValueList, MonoMeta, QueueItem, SettingRow,
  // StatusAbsent) came out on 2026-09-04 when the coach rebuild stopped mounting them; the
  // atomics are unchanged, the coach just no longer reaches them.
  Status: "11 / 11.5 / 12.5px",
};

describe("no shared component reaches a coach page with only a sub-floor rendering", () => {
  const mounted = coachMountedNames();
  const offenders = sharedModules()
    // Candidates are chosen by being mounted from a coach module. Not by their size -- the size is
    // the thing being judged, and a filter on it could never report a drift in it.
    .flatMap(recipes)
    .filter((recipe) => mounted.has(recipe.component))
    .filter((recipe) => recipe.sizes.length > 0 && recipe.sizes.every((size) => size < FLOOR));

  it("finds shared components mounted on coach pages at all", () => {
    // Without this the filter chain could be silently selecting nothing -- passing while reading
    // no component -- which is the failure mode every guard in this repo has had at least once.
    const anyMounted = sharedModules().flatMap(recipes).filter((recipe) => mounted.has(recipe.component));
    expect(anyMounted.length).toBeGreaterThan(5);
    // A named atomic, so the count above cannot be met by five things nobody recognises. This read
    // `Segmented` until the rehaul replaced the live measurement surface, whose window picker was
    // the coach's only mount of it; `DataTable` is mounted by the coach's own tables and carries a
    // debt row below, so it is a component this file already knows it reaches.
    // `DataTable` held this line until the Leads rebuild; `DeckPanel` is the panel anatomy every
    // rebuilt coach surface mounts, so it is the one name this file can rely on reaching.
    expect(anyMounted.some((recipe) => recipe.component === "DeckPanel")).toBe(true);
  });

  it("mounts nothing whose every size is under the floor", () => {
    const unexpected = offenders
      .filter((recipe) => !(recipe.component in SHARED_MOUNT_DEBT))
      .map((recipe) => `${recipe.component} (${recipe.file}): ${[...new Set(recipe.sizes)].sort((a, b) => a - b).join("px, ")}px`)
      .sort();

    expect(
      unexpected,
      "SIMPLIFICATION-SPEC §5: nothing under 14px on a coach surface, ever -- and a shared atomic "
        + "mounted on a coach page is a coach surface at render time. This component has no arm at "
        + "or above the floor, so no prop makes it legible here: either give it one (as `Segmented` "
        + "got `scale=\"coach\"`) and register it below, or use the coach's own equivalent.",
    ).toEqual([]);
  });

  it("keeps no debt row for a component that is already clean", () => {
    const stillOffending = new Set(offenders.map((recipe) => recipe.component));
    expect(
      Object.keys(SHARED_MOUNT_DEBT).filter((name) => !stillOffending.has(name)),
      "these rows name components that no longer violate the rule -- delete them",
    ).toEqual([]);
  });
});

/**
 * A JSX element's attribute text, scanned rather than matched.
 *
 * The obvious `<Name([\s\S]*?)/?>` stops at the first `>` in the tag, and every one of these
 * mounts holds an arrow function -- `onValueChange={(next) => {` -- so the lazy match ended two
 * attributes in and reported a prop that was plainly there as missing. Depth counting over the
 * braces is what actually finds the end of the tag.
 */
function attributes(source: string, from: number): string {
  let depth = 0;
  for (let index = from; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    else if (character === ">" && depth === 0) return source.slice(from, index);
  }
  return source.slice(from);
}

/**
 * Rule 2: where a shared component has both arms, the coach's mount has to ask for the legible one.
 *
 * Each row names the prop that selects the arm and the value the coach must pass, and each row is
 * verified against the component's source before it is used: the coach value has to resolve to a
 * size at or above the floor, and at least one other value has to be under it. If somebody raises
 * the console arm to 14px the row stops being true and the check below says to delete it, rather
 * than quietly enforcing a prop that no longer selects anything.
 */
const SCALE_REGISTRY = [
  {
    component: "Segmented",
    file: "src/components/kit/atomics/segmented.tsx",
    prop: "scale",
    coachValue: "coach",
    /**
     * `Main.dc.html:114-118` draws the range picker at 16px/500 in 44px pills; the same atomic is
     * 12px on the eight console artboards, which is correct there and is why this is a prop
     * rather than a number somebody edits in place.
     */
    reason: "Main.dc.html:114-118 draws the coach range picker at 16px/500 in 44px pills",
  },
] as const;

describe("a shared component with two densities is mounted at the coach's density", () => {
  for (const row of SCALE_REGISTRY) {
    /** The `SCALE` table's arms, read as `name: { ... label: "text-[Npx]" ... }` blocks. */
    function arms(): Record<string, number[]> {
      const source = read(row.file);
      const found: Record<string, number[]> = {};
      for (const match of source.matchAll(/(\w+):\s*\{([^}]*)\}/g)) found[match[1]] = pxSizes(match[2]);
      return found;
    }

    it(`${row.component} still has the two arms this registry claims`, () => {
      const table = arms();
      const coach = table[row.coachValue];
      expect(coach, `no \`${row.coachValue}\` arm in ${row.file} -- this row is stale`).toBeDefined();
      expect(coach!.length, `the \`${row.coachValue}\` arm sets no px size`).toBeGreaterThan(0);
      for (const size of coach!) {
        expect(size, `${row.component}'s coach arm is under the floor: ${row.reason}`).toBeGreaterThanOrEqual(FLOOR);
      }

      // The premise: some other arm is under the floor. If none is, the prop is selecting between
      // two legible densities and this rule has nothing left to protect -- delete the row.
      const others = Object.entries(table).filter(([name]) => name !== row.coachValue);
      expect(
        others.some(([, sizes]) => sizes.some((size) => size < FLOOR)),
        `every arm of ${row.component} is now at or above ${FLOOR}px -- drop this registry row`,
      ).toBe(true);
    });

    it(`every coach mount of ${row.component} asks for the coach density`, () => {
      const mounts = coachOnlyModules().flatMap((file) => {
        const source = read(file);
        return [...source.matchAll(new RegExp(`<${row.component}\\b`, "g"))]
          .map((match) => attributes(source, match.index! + match[0].length))
          .filter((attrs) => !new RegExp(`${row.prop}=\\{?"${row.coachValue}"`).test(attrs))
          .map(() => file);
      });

      expect(
        [...new Set(mounts)],
        `these coach modules mount <${row.component}> without ${row.prop}="${row.coachValue}", so it `
          + `renders at the console's density on a coach page. ${row.reason}.`,
      ).toEqual([]);
    });
  }
});

/**
 * The half the two rules above cannot state: a component may be *allowed* on a coach page and
 * still render under the floor there.
 *
 * `SHARED_MOUNT_DEBT` records ten components as known violations and then permits them, which is
 * honest about the state of the code and does nothing for the coach reading 11.5px. The
 * 2026-09-04 visual audit measured the result -- the floor breached on nine of eleven coach
 * screens, every breach coming from a kit component rather than from page code.
 *
 * So each debt row now owes a rule in `coach.css` that raises it under `[data-shell-role="coach"]`
 * and nowhere else, and this is where that is checked. The debt list stays as it is: the literal
 * in the component is still a literal, the console still renders it, and the row is still true.
 * What changes is that a coach can read it. A row may be deleted only when the component itself
 * stops carrying a sub-floor size, which is what the sibling assertion above already enforces.
 */
const COACH_CSS = readFileSync(resolve(ROOT, "src/app/(workspace)/coach/coach.css"), "utf8");

/** The selector in `coach.css` that has to reach each recorded component. */
const FLOOR_SELECTORS: Record<string, readonly string[]> = {
  // The rules for Callout, DataTable, KeyValueList, MonoMeta, QueueItem, SettingRow and
  // StatusAbsent are still in coach.css; their rows left with the debt rows on 2026-09-04 once no
  // coach page mounted them, and the assertion below deletes a row the moment its debt is gone,
  // so this register cannot outlive the one above it.
  Status: ['[data-slot="status"]', '[data-slot="status-detail"]'],
};

describe("every shared component that renders under the floor is raised by the coach stylesheet", () => {
  it("names a rule for every recorded debt row", () => {
    const uncovered = Object.keys(SHARED_MOUNT_DEBT).filter((name) => !(name in FLOOR_SELECTORS));

    expect(
      uncovered,
      "these components are permitted onto a coach page with only a sub-floor rendering and "
        + "nothing in coach.css raises them, so a coach reads them below 14px. Add a scoped rule "
        + "and register its selector here.",
    ).toEqual([]);
  });

  it("finds each of those rules in the stylesheet, scoped to the coach shell", () => {
    const missing = Object.entries(FLOOR_SELECTORS)
      .flatMap(([component, selectors]) =>
        selectors
          .filter((selector) => !COACH_CSS.includes(selector))
          .map((selector) => `${component}: ${selector}`))
      .sort();

    expect(missing, "registered here but absent from coach.css").toEqual([]);
  });

  it("keeps no selector row for a component that is no longer in debt", () => {
    const stale = Object.keys(FLOOR_SELECTORS).filter((name) => !(name in SHARED_MOUNT_DEBT));

    expect(stale, "these components carry no sub-floor size any more -- drop their rows").toEqual([]);
  });
});
