// @vitest-environment node

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * What may be cut off on a 390px phone, and what may not.
 *
 * The lead's surface is the narrowest thing in the product and the only one read by someone who
 * is not a user of it, so every rule below is about the same question: when the room runs out, is
 * the thing that gives way the identity, or the metadata beside it? The coach inbox already got
 * this backwards once -- a `shrink-0` mono timestamp sharing a flex line with a truncating name,
 * so every lead in the list rendered as "Jo..." -- and nothing went red, because `text-overflow`
 * is invisible to jsdom and a rendered ellipsis is a paint-time fact.
 *
 * These are therefore source assertions on the recipes rather than measurements of a render, and
 * each one names the element by the role it plays: an identity and a compliance label wrap, a
 * status caption truncates.
 */

/*
 * Comments are stripped before anything is matched. Every rule below is documented in prose that
 * names the property it removed -- "it was `white-space: nowrap` and no ellipsis" -- so a test
 * reading the raw file finds the banned declaration inside the explanation of why it is banned,
 * and fails on its own docstring. This test did exactly that on its first run.
 */
const CONSUMER = readFileSync(new URL("./consumer.css", import.meta.url).pathname, "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "");

/** Reads one blank-line-delimited recipe out of the sheet, so a size can be read with its block. */
function recipe(selector: string): string {
  const block = CONSUMER.split(/\n\s*\n/u).find((entry) => entry.includes(`${selector} {`));
  expect(block, `the recipe for ${selector} is gone`).toBeDefined();
  return block!;
}

describe("what the consumer surface is allowed to cut off", () => {
  /**
   * The business name is the coach's brand and the whole white-label promise of the page. It has
   * to survive a long name on a narrow screen, which means wrapping -- an ellipsis on an identity
   * is the product deciding the reader does not need to know whose business this is.
   */
  it("wraps the business name rather than ellipsizing it", () => {
    const name = recipe(".consumer-identity h1");

    // The positive control: this is the identity recipe and not some other block that happens to
    // lack the two properties. A rule with no font-size is not the one being asserted about.
    expect(name).toContain("font-size: var(--consumer-name)");
    expect(name).not.toContain("white-space: nowrap");
    expect(name).not.toContain("text-overflow: ellipsis");
    // A business name can be one unbroken token, and wrapping that cannot break inside a word
    // overflows the pane instead of clipping -- which trades one defect for a worse one.
    expect(name).toContain("overflow-wrap: anywhere");
  });

  /**
   * The other half of the same decision, and the reason the test above is not simply "nothing
   * truncates". Something has to give way on a 390px header, and the status caption is the right
   * thing: the caption reads "Appointment assistant" (`consumer-experience.tsx:922`), and a lead
   * who loses its tail still has the business name in full above it and the reply window in the
   * header's own status row. The name is the white-label promise; this line says what kind of
   * thing is answering, which is the cheaper of the two to clip.
   *
   * It quoted "usually replies right away" until 2026-09-01, copy that has not rendered since the
   * identity fix. The assertions never read this prose -- nothing reads this file's source -- but
   * a quote nobody can find on the page is how a reader concludes the whole rule describes some
   * other build, which is the failure this suite already met from the other direction and why it
   * strips comments before matching.
   */
  it("still lets the status caption beneath it truncate, because something has to", () => {
    const status = recipe(".consumer-identity p");

    expect(status).toContain("font-size: var(--consumer-meta)");
    expect(status).toContain("text-overflow: ellipsis");
  });

  /**
   * The preview ribbon is the on-screen marker saying these records are seeded rather than a real
   * conversation, and it was being sliced with no ellipsis below 620px -- so the reader saw a
   * sentence that stopped, with nothing to say words were missing. "Test data is labelled on
   * screen" is a rule about what can be read, not about what is present in the markup.
   */
  it("lets the seeded-data ribbon wrap on a phone instead of slicing it", () => {
    const narrow = CONSUMER.slice(CONSUMER.indexOf("@media (max-width: 620px)"));
    const ribbon = narrow.split(/\n\s*\n/u).find((block) => block.includes(".consumer-preview-ribbon {"));

    expect(ribbon, "the narrow-screen ribbon recipe is gone").toBeDefined();
    expect(ribbon).toContain("justify-content: flex-start");
    expect(ribbon).not.toContain("white-space: nowrap");
  });
});
