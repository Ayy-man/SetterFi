import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  selectItemClassName,
  selectItemTextClassName,
  selectPopupClassName,
} from "@/components/ui/select";
import { deriveCommissionCents } from "@/lib/affiliates/service";
import { workspaceNavigation } from "@/lib/workspace-navigation";
import {
  OFFER_CADENCE_CHANNEL_LABELS,
  OFFER_CADENCE_CHANNELS,
  OFFER_CADENCE_PURPOSE_LABELS,
  OFFER_CADENCE_PURPOSES,
} from "@/lib/offer/types";

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Round 4 decided live owners", () => {
  it("issues unique affiliate links without approval state", () => {
    const initialSchema = source("supabase/migrations/20260813000001_init.sql");
    const signupSchema = source("supabase/migrations/20260821000001_phase5_self_serve_onboarding.sql");
    const affiliateTable = initialSchema.match(/create table affiliates \(([\s\S]*?)\n\);/)?.[1] ?? "";
    expect(affiliateTable).toContain("referral_code text unique not null");
    expect(affiliateTable).toContain("link_active boolean not null default true");
    expect(affiliateTable).not.toMatch(/approval|approved|pending/i);
    expect(signupSchema).toContain("insert into public.affiliates (user_id, referral_code)");
    expect(signupSchema).toContain("elsif not referral_affiliate.link_active then");
  });

  it("starts commission only after the first paid invoice", () => {
    const moneySchema = source("supabase/migrations/20260822000001_phase6_money.sql");
    const stripeProcessor = source("src/lib/billing/stripe-events.ts");
    expect(stripeProcessor).toContain('event: Extract<StripeEvent, { type: "invoice.paid" }>');
    expect(stripeProcessor).toContain("dependencies.affiliates.accrueInvoice");
    expect(moneySchema).toContain("referral_commission_windows (\n      referral_id, first_invoice_id, started_at, expires_at");
    expect(moneySchema).toContain("cents := round(p_total_excluding_tax_cents::numeric * 0.10)::bigint");
    expect(deriveCommissionCents(1_000)).toBe(100);
  });
});

const LIVE_ROOT = "src/components/workspace/live";

function tsx(path: string) {
  return ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function collect<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function liveComponentFiles(directory: string): string[] {
  return readdirSync(resolve(process.cwd(), directory), { withFileTypes: true }).flatMap((entry) => {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) return liveComponentFiles(target);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [target] : [];
  });
}


// `form.proof.map(...)` rendered directly as a JSX child is the row list, one per proof editor.
// The identical call text also appears inside `onChange`, where it rewrites a single row rather
// than listing them, so a raw substring count counts handlers, not editors.

/** The six subjects the page is about, read from `TAB_LABELS` rather than from a chip list. */

function proofRowIterations(file: ts.SourceFile) {
  return collect(file, ts.isCallExpression).filter(
    (node) => node.expression.getText() === "form.proof.map" && ts.isJsxExpression(node.parent),
  );
}

describe("R4-20: Proof and case studies is not a destination of its own", () => {
  /*
   * What is left of R4-20 once the surface it was written against is gone.
   *
   * The ruling: proof stops being a destination of its own and renders inside Marketing assets,
   * with nothing about it deleted in the move. Four assertions carried it -- a six-member
   * `OfferTab` union, a `TAB_LABELS` object, the two `SettingsCard` titles and their shared parent
   * -- and all four read `coach-offer.tsx`, which the rehaul replaced with `coach-agent.tsx`
   * before the file was deleted. The rehaul surface has no tabs at all: the agent reads as one
   * ladder of panels, so "proof is not a seventh tab" is a sentence about a control that does not
   * exist, and there is nothing to point those four at.
   *
   * The half still checkable is the half that was the ruling rather than its mechanism, so it is
   * asserted against the whole tree instead of one file: proof renders in exactly one place, and
   * no navigation destination is named for it. The tab assertions went with the tabs; that is
   * recorded here rather than quietly dropped, because a ledger entry that vanishes with its
   * mechanism is how a ruling gets re-litigated.
   */
  const PROOF_SURFACE = "src/components/workspace/rehaul/coach-agent.tsx";
  const REHAUL_ROOT = "src/components/workspace/rehaul";

  it("renders proof in exactly one place, so the move copied nothing", () => {
    const files = [...liveComponentFiles(LIVE_ROOT), ...liveComponentFiles(REHAUL_ROOT)];
    // The positive control: an empty walk would leave the assertion below reading no code.
    expect(files.length, "the component walk read nothing").toBeGreaterThan(20);

    const editors = files.flatMap((file) => proofRowIterations(tsx(file)).map(() => file));
    expect(editors, "the proof editor is relocated, never copied, exactly one may exist")
      .toEqual([PROOF_SURFACE]);
  });

  it("gives proof no destination of its own", () => {
    const items = Object.values(workspaceNavigation).flat().flatMap((group) => group.items);
    expect(items.length, "the nav config resolved no items").toBeGreaterThan(5);
    expect(
      items.filter((item) => /proof/iu.test(`${item.href} ${item.label}`)),
      "Proof must not become a rail destination under any name",
    ).toEqual([]);
  });
});


const SOURCE_PATH = "src/components/ui/select.tsx";
const COMPONENT_ROOT = "src/components";

// `admin-brain.tsx` keeps its two native selects on purpose: phase 10 plan 10-03 is editing
// that file in a parallel lane, and a collision there costs more than the two selects are
// worth. A native select cannot exhibit the wrap defect, so this is a scope note rather than
// an open instance of R4-14. Delete this entry once 10-03 merges.
// The brain import review was the last holdout; nothing on a live surface may hand-roll a select.
//
// Empty since both legacy onboarding screens were deleted with the flag: the two holdouts went
// with the files, and no component in the tree renders a native `<select>` any more. The list
// stays rather than being inlined as `[]`, because the next holdout is added here.
const NATIVE_SELECT_ALLOWLIST: string[] = [];

function jsxElementsNamed(file: ts.SourceFile, tagName: string) {
  return collect(
    file,
    (node): node is ts.JsxSelfClosingElement | ts.JsxOpeningElement =>
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText() === tagName,
  );
}

function classNameAttributeText(element: ts.JsxSelfClosingElement | ts.JsxOpeningElement) {
  const attribute = element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === "className",
  );
  const initializer = attribute?.initializer;
  if (!initializer) return null;
  return ts.isJsxExpression(initializer) ? initializer.expression?.getText() ?? null : initializer.getText();
}

describe("R4-14: dropdown option labels fill the row on one line", () => {
  it("renders the option label through the pinned item-text class", () => {
    // The previous primitive laid the option row out as a grid: indicator on
    // `grid-column: 1`, label on `grid-column: 2`, and a grid text cell is only as wide as
    // its track, so the label bunched into a narrow left column no matter how much
    // `white-space: nowrap` was bolted onto it. Reading the className back through the AST
    // proves the live element uses the constant, which a substring scan of the file could
    // not distinguish from a comment mentioning it.
    const itemTexts = jsxElementsNamed(tsx(SOURCE_PATH), "SelectPrimitive.ItemText").filter(
      (element) => classNameAttributeText(element) === "selectItemTextClassName",
    );
    expect(itemTexts, `${SOURCE_PATH} must render exactly one option label element`).toHaveLength(1);
    expect(classNameAttributeText(itemTexts[0])).toBe("selectItemTextClassName");
  });

  it("keeps the new shadcn SelectItem label on one line", () => {
    const itemTexts = jsxElementsNamed(tsx(SOURCE_PATH), "SelectPrimitive.ItemText").filter(
      (element) => classNameAttributeText(element) !== "selectItemTextClassName",
    );
    expect(itemTexts, `${SOURCE_PATH} must render exactly one compound option label element`).toHaveLength(1);
    expect(classNameAttributeText(itemTexts[0])).toMatch(/\b(?:whitespace-nowrap|truncate|line-clamp-1)\b/);
  });

  it("keeps the label growing and the row free of a grid", () => {
    const itemTextTokens = selectItemTextClassName.split(/\s+/).filter(Boolean);
    expect(itemTextTokens, "flex-1 claims the leftover width and min-w-0 stops it being taken back").toEqual(
      expect.arrayContaining(["flex-1", "min-w-0", "whitespace-nowrap"]),
    );
    expect(
      selectItemClassName,
      "the option row must stay flex, a grid track is the layout model that produced the defect",
    ).not.toMatch(/\bgrid(-cols)?\b/);
  });

});

describe("R4-24: the cadence editor uses the same primitive", () => {
  /*
   * R4-24 asked that the cadence editor stop being a native select and use the shared primitive,
   * and it checked that by reading `coach-offer.tsx` for a `<Select>` whose label named the
   * purpose.
   *
   * The rehaul replaced that page with `coach-agent.tsx`, which carries `cadencePurposes` as saved
   * state and draws no control for it: the coach cannot edit a cadence purpose on the shipped
   * surface at all. That is a gap in the rehaul rather than something this file can assert, so
   * what is kept is the guard that does not depend on where the control lives -- wherever a
   * cadence purpose is edited, it is not edited through a native select.
   */
  const REHAUL_ROOT = "src/components/workspace/rehaul";

  it("puts no native select on any surface that edits a cadence purpose", () => {
    const files = [...liveComponentFiles(LIVE_ROOT), ...liveComponentFiles(REHAUL_ROOT)];
    expect(files.length, "the component walk read nothing").toBeGreaterThan(20);

    for (const file of files.filter((path) => /OFFER_CADENCE_PURPOSE/u.test(source(path)))) {
      expect(
        jsxElementsNamed(tsx(file), "select"),
        `${file} edits a cadence purpose through a native select, the R4-24 regression`,
      ).toHaveLength(0);
    }
  });
});
describe("Native selects are gone from every live surface", () => {
  it("leaves no native select on any live surface", () => {
    // An AST walk, not a grep: `grep -c "select"` counts comments and CSS-in-JS
    // `user-select`, and this repo has already been bitten by a self-invalidating grep gate.
    const holdouts = liveComponentFiles(COMPONENT_ROOT).filter((file) => jsxElementsNamed(tsx(file), "select").length > 0);
    expect(holdouts, "every native select outside the phase 10 lane must be migrated").toEqual(
      NATIVE_SELECT_ALLOWLIST,
    );
  });

  it("leaves no dead styling for the primitive that was deleted", () => {
    const styles = readdirSync(resolve(process.cwd(), "src/app"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
      .map((entry) => source(join("src/app", entry.name)));
    for (const style of styles) {
      expect(style, "the ws-brand-select block was deleted; its grid-column shape is wrong for a popup").not.toContain(
        "ws-brand-select",
      );
    }
  });
});

describe("The select popup carries its own elevation in both themes", () => {
  it("draws the popup surface and shadow from product tokens", () => {
    expect(selectPopupClassName).toContain("--shadow-raised");
    expect(selectPopupClassName).toContain("--card");
    expect(selectPopupClassName).toContain("--line");
    expect(selectPopupClassName).toContain("--r-card");
    expect(selectPopupClassName).not.toContain("--sf-");
  });

  it("highlights an option row above the popup body it sits in", () => {
    expect(selectItemClassName).toContain("--card");
    expect(selectItemClassName).toContain("--muted");
    expect(selectItemClassName).toContain("--r-control");
  });

  it("defines every popup colour and shadow token in the product token layer", () => {
    const tokens = source("src/app/tokens.css");
    for (const token of ["--card", "--line", "--muted", "--focus-ring", "--shadow-raised"]) {
      expect(tokens, `${token} must be defined by the product token layer`).toMatch(
        new RegExp(`^\\s*${token}\\s*:`, "m"),
      );
    }
  });
});

/**
 * R4-24 again, on the copy rather than the geometry. A coach picks a cadence purpose in the offer
 * editor and reads the same purpose back in the touch list, so both surfaces have to say the same
 * words, and neither may say `value_nudge`. The label maps live beside the enums in offer/types
 * so a new member cannot be added without one.
 */
describe("cadence dropdowns speak to a coach, not to the database", () => {
  it("gives every cadence enum member a human label", () => {
    for (const purpose of OFFER_CADENCE_PURPOSES) {
      const label = OFFER_CADENCE_PURPOSE_LABELS[purpose];
      expect(label, `${purpose} has no coach-facing label`).toBeTruthy();
      expect(label, `${purpose} would render as its own enum value`).not.toBe(purpose);
      expect(label, `${label} still reads as a database identifier`).not.toMatch(/_/);
    }
    for (const channel of OFFER_CADENCE_CHANNELS) {
      const label = OFFER_CADENCE_CHANNEL_LABELS[channel];
      expect(label, `${channel} has no coach-facing label`).toBeTruthy();
      expect(label, `${channel} would render as its own enum value`).not.toBe(channel);
      expect(label, `${label} still reads as a database identifier`).not.toMatch(/_/);
    }
  });

  /*
   * Read across the tree rather than out of one file.
   *
   * This named `coach-offer.tsx` and asserted its purpose dropdown mapped through the label map.
   * That file is gone and `coach-agent.tsx` draws no cadence dropdown, so the positive half has no
   * subject; the regression half never needed one. `({ value, label: value })` is the raw-enum
   * options array this exists to catch, and it is wrong on any surface, so every component is read
   * for it rather than the one that happened to hold the control.
   */
  it("builds no option list out of raw enum values", () => {
    const files = [
      ...liveComponentFiles(LIVE_ROOT),
      ...liveComponentFiles("src/components/workspace/rehaul"),
    ];
    expect(files.length, "the component walk read nothing").toBeGreaterThan(20);
    expect(
      files.filter((file) => source(file).includes("({ value, label: value })")),
      "`label: value` in an options array renders a database identifier to a coach",
    ).toEqual([]);
  });
});
