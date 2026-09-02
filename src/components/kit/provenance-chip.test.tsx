import { render } from "@testing-library/react";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/kit/page-header";
import {
  ProvenanceChip,
  seededRowLabel,
  seededRowWords,
  wholePageProvenanceKind,
} from "@/components/kit/provenance-chip";
import { DetailPage } from "@/components/kit/templates/detail-page";
import { ListPage } from "@/components/kit/templates/list-page";

/**
 * Where the seeded-data disclosure sits, which is the whole change.
 *
 * The console already said it -- as a faint badge-sized sentence under the description, last in
 * the reading order. A reader who meets a disclosure after the numbers has already read the
 * numbers, so all thirteen owner-console artboards put it above the `<h1>`. That ordering is not
 * something a snapshot or a text assertion catches, so it is asserted directly here.
 */
function order(container: HTMLElement, titleSlot: string) {
  const head = container.querySelector('[data-slot="provenance-chip"]')?.closest("header");
  const nodes = [...(head?.querySelectorAll("*") ?? [])];
  return {
    chip: nodes.findIndex((node) => node.matches('[data-slot="provenance-chip"]')),
    title: nodes.findIndex((node) => node.matches(`[data-slot="${titleSlot}"]`)),
  };
}

describe("ProvenanceChip", () => {
  it("states the provenance and the exclusion as two separate claims", () => {
    const { container } = render(<ProvenanceChip kind="demo" />);

    expect(container.querySelector('[data-slot="provenance-chip-label"]')).toHaveTextContent(
      "Demo workspace data",
    );
    expect(container.querySelector('[data-slot="provenance-chip-exclusion"]')).toHaveTextContent(
      "Excluded from analytics",
    );
  });

  it("gives generated numbers their own word rather than calling them demo rows", () => {
    const { container } = render(<ProvenanceChip kind="preview" />);
    expect(container.querySelector('[data-slot="provenance-chip-label"]')).toHaveTextContent(
      "Synthetic preview data",
    );
  });

  it("sits above the title on a list page", () => {
    const { container } = render(
      <ListPage description="What the list is for." provenanceKind="demo" title="Client book">
        <p>rows</p>
      </ListPage>,
    );

    const { chip, title } = order(container, "list-page-title");
    expect(chip).toBeGreaterThanOrEqual(0);
    expect(chip).toBeLessThan(title);
  });

  it("sits above the title on a detail page", () => {
    const { container } = render(
      <DetailPage
        provenanceKind="test"
        subtitle="What the record is."
        tabs={[{ id: "one", label: "One", content: <p>content</p> }]}
        title="Evals"
      />,
    );

    const { chip, title } = order(container, "detail-page-title");
    expect(chip).toBeGreaterThanOrEqual(0);
    expect(chip).toBeLessThan(title);
  });

  it("adds nothing to a page that passes no kind", () => {
    const { container } = render(
      <ListPage description="What the list is for." title="Client book">
        <p>rows</p>
      </ListPage>,
    );
    expect(container.querySelector('[data-slot="provenance-chip"]')).toBeNull();
  });

  it("sits above the title on a page header too", () => {
    const { container } = render(
      <PageHeader crumbs={[]} description="What the page is for." provenanceKind="test" title="Agents" />,
    );

    const { chip, title } = order(container, "page-header-title");
    expect(chip).toBeGreaterThanOrEqual(0);
    expect(chip).toBeLessThan(title);
  });
});

/**
 * One disclosure per header, and one word only where one word is true.
 *
 * These two rules are what the rollout turns on. The first stops the chip and the old sentence
 * coexisting -- which they did on every console surface that had adopted the chip while still
 * passing a sentence -- and the second stops a page whose rows are half demo and half test from
 * picking whichever word its first labelled row happened to carry.
 */
describe("one provenance claim per header", () => {
  it("refuses a list page that passes both the chip and the sentence", () => {
    expect(() =>
      render(
        <ListPage
          description="What the list is for."
          provenance="Demo rows are labelled in the table and excluded from analytics."
          provenanceKind="demo"
          title="Client book"
        >
          <p>rows</p>
        </ListPage>,
      ),
    ).toThrow(/never both/);
  });

  it("refuses a detail page that passes both", () => {
    expect(() =>
      render(
        <DetailPage
          provenance="Every row on this page is demo or test data."
          provenanceKind="test"
          subtitle="What the record is."
          tabs={[{ id: "one", label: "One", content: <p>content</p> }]}
          title="Compliance"
        />,
      ),
    ).toThrow(/never both/);
  });

  it("allows either one on its own", () => {
    expect(() =>
      render(
        <ListPage description="What the list is for." provenanceKind="demo" title="Client book">
          <p>rows</p>
        </ListPage>,
      ),
    ).not.toThrow();
    expect(() =>
      render(
        <ListPage description="What the list is for." provenance="Demo rows are labelled." title="Client book">
          <p>rows</p>
        </ListPage>,
      ),
    ).not.toThrow();
  });
});

describe("wholePageProvenanceKind", () => {
  const demo = { seeded: "demo" as const };
  const test = { seeded: "test" as const };
  const real = { seeded: null };
  const seeding = (row: { seeded: "demo" | "test" | null }) => row.seeded;

  it("names the kind when every row is seeded the same way", () => {
    expect(wholePageProvenanceKind([demo, demo], seeding)).toBe("demo");
    expect(wholePageProvenanceKind([test, test], seeding)).toBe("test");
  });

  it("says nothing about an empty table, because an empty table has no provenance", () => {
    expect(wholePageProvenanceKind([], seeding)).toBeNull();
  });

  it("says nothing when one row is real, because the chip is a whole-page claim", () => {
    expect(wholePageProvenanceKind([demo, demo, real], seeding)).toBeNull();
  });

  it("says nothing when the page mixes demo and test, because neither word is true of it", () => {
    expect(wholePageProvenanceKind([demo, test], seeding)).toBeNull();
  });
});

describe("seededRowWords", () => {
  const demo = { seeded: "demo" as const };
  const test = { seeded: "test" as const };
  const real = { seeded: null };
  const seeding = (row: { seeded: "demo" | "test" | null }) => row.seeded;

  it("names both words on a page that carries both, which one word cannot", () => {
    // Why this returns a set rather than a word: the seeded-but-mixed page is exactly the case
    // `wholePageProvenanceKind` refuses to name, so the sentence is all that is left to say it,
    // and "Demo rows are labelled" on a page holding test rows is the chip's false claim moved
    // one level down.
    expect(seededRowWords([demo, test, real], seeding)).toEqual(["Demo", "Test"]);
  });

  it("names one word when one word covers the seeded rows, and none when nothing is seeded", () => {
    expect(seededRowWords([demo, real], seeding)).toEqual(["Demo"]);
    expect(seededRowWords([test, test], seeding)).toEqual(["Test"]);
    expect(seededRowWords([real, real], seeding)).toEqual([]);
  });

  it("gives a mixed table the weaker shared word rather than a confident wrong one", () => {
    expect(seededRowLabel(["Demo"])).toBe("Demo data");
    expect(seededRowLabel(["Test"])).toBe("Test data");
    expect(seededRowLabel(["Demo", "Test"])).toBe("Seeded data");
  });
});

/**
 * The structural guard, and it exists because the defect it catches was latent on three pages at
 * once and none of them looked wrong.
 *
 * Every one of those pages derived the chip's word from `rows.find((row) => row.dataLabel !== null)`
 * -- the first labelled row in whatever order the query returned -- and gated it on "is every row
 * labelled?". The two questions compose into a false claim on a page holding one demo tenant and
 * one test tenant: every row is labelled, so the chip shipped, and the word came from whichever row
 * sorted first. No render assertion catches this, because a page whose fixture happens to be
 * uniform renders correctly and the defect only exists in a mix nobody wrote a fixture for. So the
 * rule is enforced on the source instead: a page that mounts the chip off row labels asks the
 * helper, and a fourth page cannot quietly inherit the first-row behaviour.
 */
describe("the chip's word is never taken from one row", () => {
  // Tracked files only, so an untracked scratch copy of a page cannot fail the suite, and read
  // from the repo root because that is where vitest runs.
  const sourceFiles = () =>
    execFileSync("git", ["ls-files", "src"], { cwd: process.cwd(), encoding: "utf8" })
      .split("\n")
      .filter((path) => /\.tsx?$/u.test(path) && !/\.test\.tsx?$/u.test(path));

  /*
   * Comments are stripped before either check reads the file, and that is not tidiness: the second
   * check asks whether a page calls the helper, and a page that merely *mentions* it in a note
   * explaining what it does instead would pass while doing the wrong thing. Stripping first means
   * both checks see code. It also means a comment is free to quote the old expression, which is
   * how the fix explains itself on the pages it changed.
   */
  const read = (path: string) =>
    readFileSync(join(process.cwd(), path), "utf8")
      .replaceAll(/\/\*[\s\S]*?\*\//gu, " ")
      .replaceAll(/(^|[^:])\/\/[^\n]*/gu, "$1");

  it("has no surface deriving a provenance claim from the first labelled row it finds", () => {
    const offenders = sourceFiles().filter((path) => {
      const source = read(path);
      if (!source.includes("dataLabel")) return false;
      return /\.find\([^\n]*dataLabel[^\n]*\)\s*\??\.\s*dataLabel/u.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("makes every page that mounts the chip off row labels ask wholePageProvenanceKind", () => {
    const offenders = sourceFiles().filter((path) => {
      const source = read(path);
      if (!source.includes("provenanceKind=") || !source.includes("dataLabel")) return false;
      return !source.includes("wholePageProvenanceKind");
    });
    expect(offenders).toEqual([]);
  });
});
