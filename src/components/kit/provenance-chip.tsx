/**
 * The chip above a console page's title saying the rows on it are not real.
 *
 * `CLAUDE.md` requires two things of seeded data and they are separate claims: it is segregated
 * from real analytics, and it is labelled as such on screen. Every console head already carried
 * the second one, but as a faint sentence *under* the description -- last in the reading order,
 * at badge size, in `--faint`, below the one line a reader actually stops on. All thirteen owner
 * console artboards put it first instead, as a bordered mono chip above the `<h1>`, and that
 * placement is the point: a disclosure a reader meets after they have already read the numbers is
 * a disclosure that arrived too late to change how they read them.
 *
 * ## Why both clauses are in the one chip
 *
 * The canvas draws `DEMO WORKSPACE DATA` alone. That names the provenance and drops the exclusion,
 * which is the half a reader needs to know the platform's real figures are not moving because of
 * what is on screen. Keeping the old sentence as well would state the same fact twice in the same
 * header, so the clause moved into the chip behind a middot and the sentence went away.
 *
 * ## Not on the coach side
 *
 * `coach-page-head.tsx` says the same thing in a full sentence at 16px, deliberately: the coach
 * surface is built for people over 55 and `coach-support.tsx:35` records the rule as "said in
 * words rather than in a lozenge nobody over 55 can read". This is a console component and the
 * console's own density -- 13.5px body, mono overlines, 30px titles -- is what makes a chip
 * legible here. Nothing on a coach page should mount it.
 */

/**
 * Three page-wide claims, and they are not interchangeable.
 *
 * `demo` is a seeded workspace, `test` is a tenant marked as test data, and `preview` is a
 * measurement read whose origin is `synthetic_preview` -- numbers generated so a screen has
 * something to show, which is a stronger warning than "seeded rows" and has to keep its own word.
 *
 * Every one of them asserts the whole page. A page whose rows are a mix of real and seeded must
 * not mount this: it labels the seeded rows in the row and says so in a sentence instead, because
 * a chip over the title claiming the workspace is demo, on a table where some of it is real, is
 * a disclosure that misleads in the other direction.
 */
export type ProvenanceKind = "demo" | "test" | "preview";

const PROVENANCE_LABEL: Record<ProvenanceKind, string> = {
  demo: "Demo workspace data",
  preview: "Synthetic preview data",
  test: "Test workspace data",
};

export function ProvenanceChip({ kind }: { kind: ProvenanceKind }) {
  return (
    <span
      className="inline-flex w-fit items-center gap-[7px] rounded-[var(--r-input)] border border-[var(--line)] bg-[var(--well)] px-[9px] py-[3px] font-mono text-[10.5px] leading-[1.5] tracking-[0.07em] uppercase text-[color:var(--muted)]"
      data-provenance={kind}
      data-slot="provenance-chip"
    >
      {/* Each clause is its own element so a test, and a screen reader's element navigation, can
          address the provenance and the exclusion separately -- they are two claims, not one. */}
      <span data-slot="provenance-chip-label">{PROVENANCE_LABEL[kind]}</span>
      <span aria-hidden="true" className="text-[color:var(--faint)]">
        ·
      </span>
      <span className="text-[color:var(--faint)]" data-slot="provenance-chip-exclusion">
        Excluded from analytics
      </span>
    </span>
  );
}

/**
 * The two disclosures may not both render in one header.
 *
 * `provenanceKind` is a whole-page claim in a chip above the `<h1>`; `provenance` is a free
 * sentence under the description, and the sentence a console surface passes is almost always the
 * mixed-rows arm -- "Demo rows are labelled in the table and excluded from analytics." A header
 * carrying both says the whole workspace is seeded and that only some of its rows are, in the same
 * breath, which is worse than either alone: a reader cannot tell which of the two claims is the
 * one about the numbers in front of them.
 *
 * The rule is therefore not "prefer the chip" but "pick one per render", and it is enforced here
 * rather than left to each surface, because the surfaces derive the two from separate booleans and
 * a page that computes them independently will eventually have both true at once. Throwing rather
 * than silently dropping one: a dropped disclosure is a `CLAUDE.md` violation nobody sees, and
 * this fires in development and in test, never in production, where dropping the sentence and
 * keeping the chip is the safer of the two failures.
 */
export function assertOneProvenanceClaim(
  component: string,
  provenance: string | undefined,
  provenanceKind: ProvenanceKind | undefined,
) {
  if (process.env.NODE_ENV === "production") return;
  if (!provenance || !provenanceKind) return;

  throw new Error(
    `${component}: pass either provenanceKind (the chip, a whole-page claim) or provenance (the sentence, for a page whose rows are mixed), never both. Got kind "${provenanceKind}" and the sentence ${JSON.stringify(provenance)}.`,
  );
}

/**
 * The chip's kind for a page, or `null` when no single word is true of it.
 *
 * Three of the four ways this returns `null` are the interesting ones, and each is a claim the
 * chip must not make:
 *
 *   - **No rows.** An empty table has no provenance. A chip over one asserts the workspace is
 *     seeded on the strength of nothing.
 *   - **Some rows real.** The chip is a whole-page claim, so a mixed table keeps the sentence and
 *     labels the seeded rows in the row -- see the note on `ProvenanceChip` itself.
 *   - **Seeded, but demo and test both.** `demo` and `test` are not synonyms: one is a seeded
 *     workspace, the other a tenant marked as test data, and picking either word states something
 *     false about half the rows. The surfaces that hit this carry a two-word sentence instead,
 *     which is the only accurate form. Several of these pages derived the word from *the first
 *     labelled row they found*, which on a mixed page is whichever one happened to sort first.
 */
export function wholePageProvenanceKind<T>(
  rows: readonly T[],
  seeding: (row: T) => "demo" | "test" | null,
): ProvenanceKind | null {
  if (rows.length === 0) return null;

  const kinds = new Set<"demo" | "test">();
  for (const row of rows) {
    const kind = seeding(row);
    if (kind === null) return null;
    kinds.add(kind);
  }

  return kinds.size === 1 ? [...kinds][0] : null;
}

/**
 * The seeded words actually on the page, deduplicated and ordered -- the input to the two things a
 * page still has to say when `wholePageProvenanceKind` returns `null`.
 *
 * A page that cannot mount the chip has to name its seeding some other way, and the sentence it
 * writes has to match the rows rather than the first labelled one it found. Returning the set,
 * rather than a single word, is what makes the seeded-but-mixed case expressible at all: "Demo and
 * Test rows are labelled..." is the only accurate sentence there, and every page that derived one
 * word from `rows.find(...)` was structurally unable to write it. Sorting gives "Demo" before
 * "Test" without a page choosing an order.
 */
export function seededRowWords<T>(
  rows: readonly T[],
  seeding: (row: T) => "demo" | "test" | null,
): string[] {
  const words = new Set<string>();
  for (const row of rows) {
    const kind = seeding(row);
    if (kind !== null) words.add(kind === "test" ? "Test" : "Demo");
  }
  return [...words].sort();
}

/**
 * `DataTable` takes one `testRowLabel` for every seeded row it marks, so a confident single word is
 * only printable while a single word is true of the set. A table holding a demo tenant and a test
 * tenant has no such word, and calling a test row "Demo data" is the same misstatement the chip
 * used to make one level up -- so those rows get the weaker word they genuinely share.
 */
export function seededRowLabel(words: readonly string[]): string {
  return words.length === 1 ? `${words[0]} data` : "Seeded data";
}
