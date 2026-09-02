import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The accent budget on the one page an end consumer sees.
 *
 * `docs/DESIGN.md` caps the accent at twice per screen and one fill, and the Ownership Rule says
 * what the two may be spent on: the things the reader owns. On the consumer chat that is asking
 * for a person and confirming a time, and nothing else.
 *
 * This surface had drifted to five spends -- the human button's text, the disclosure link, the
 * Confirm fill, the whole right-hand panel's `--accent-wash` ground, and that panel's eyebrow and
 * hairlines. The panel was the expensive one: a full-height accent field behind copy that states
 * what the coach already decided out-shouts the one control on the page that actually commits the
 * lead to something.
 *
 * The test names the two spenders rather than counting, because a count says "you have three" and
 * a name says "this one should not be accent at all", which is the finding worth having. Add a
 * spender only by deciding, in words, that the lead owns it.
 */

const CONSUMER_CSS = new URL("./consumer.css", import.meta.url).pathname;

const ALLOWED_SPENDERS = [".consumer-human-button", ".consumer-primary-button"] as const;

/** Selector -> declaration body, for every rule in the file that is not inside an at-rule. */
function rules(source: string): { body: string; selector: string }[] {
  const out: { body: string; selector: string }[] = [];
  const pattern = /([^{}@]+)\{([^{}]*)\}/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const selector = match[1].replace(/\/\*[\s\S]*?\*\//gu, "").trim();
    if (selector.length > 0) out.push({ body: match[2], selector });
  }
  return out;
}

describe("the consumer accent budget", () => {
  it("is spent on the two controls the lead owns, and nowhere else", () => {
    const spenders = rules(readFileSync(CONSUMER_CSS, "utf8"))
      .filter((rule) => /var\(--accent/u.test(rule.body))
      .map((rule) => rule.selector)
      .filter((selector) => !ALLOWED_SPENDERS.some((allowed) => selector.startsWith(allowed)));

    expect(spenders).toEqual([]);
  });

  /**
   * The other half of the rule. `--critical` is the destructive-affordance family and its text
   * role sits below the small-text floor on purpose; a send that failed is a *state*, and the kit
   * splits `critical` three ways: states become `failure`, inline error text takes a text token,
   * and a destructive affordance is a button variant. The failure family is the one whose
   * contrast was actually measured for a sentence on its own wash.
   */
  it("draws a failed turn in the failure family, never in critical", () => {
    expect(readFileSync(CONSUMER_CSS, "utf8")).not.toContain("var(--critical");
  });
});
