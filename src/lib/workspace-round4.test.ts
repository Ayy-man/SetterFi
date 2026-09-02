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
import {
  OFFER_CADENCE_CHANNEL_LABELS,
  OFFER_CADENCE_CHANNELS,
  OFFER_CADENCE_PURPOSE_LABELS,
  OFFER_CADENCE_PURPOSES,
} from "@/lib/offer/types";

const COACH_OFFER_TSX = "src/components/workspace/live/coach-offer.tsx";

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

const OFFER_FILE = "src/components/workspace/live/coach-offer.tsx";
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
/**
 * A `SettingsCard` element by its `title` attribute, as a whole JSX element rather than its opening
 * tag, so the assertions below can read its source span and its parent.
 */
function settingsCardsTitled(file: ts.SourceFile, title: string) {
  return collect(file, ts.isJsxElement).filter((node) => {
    if (node.openingElement.tagName.getText() !== "SettingsCard") return false;
    const attribute = node.openingElement.attributes.properties.find(
      (property): property is ts.JsxAttribute =>
        ts.isJsxAttribute(property) && property.name.getText() === "title",
    );
    const value = attribute?.initializer;
    return Boolean(value && ts.isStringLiteral(value) && value.text === title);
  });
}

/** The six subjects the page is about, read from `TAB_LABELS` rather than from a chip list. */
function subjectLabels(file: ts.SourceFile) {
  const declaration = collect(file, ts.isVariableDeclaration).find(
    (node) => node.name.getText() === "TAB_LABELS",
  );
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) return null;
  return initializer.properties.flatMap((property) => {
    if (!ts.isPropertyAssignment(property)) return [];
    const value = property.initializer;
    return [{
      key: property.name.getText(),
      label: ts.isStringLiteral(value) ? value.text : value.getText(),
    }];
  });
}

function proofRowIterations(file: ts.SourceFile) {
  return collect(file, ts.isCallExpression).filter(
    (node) => node.expression.getText() === "form.proof.map" && ts.isJsxExpression(node.parent),
  );
}

describe("R4-20: Proof and case studies live inside the Marketing assets tab", () => {
  it("names six offer tabs, none of them proof", () => {
    const alias = collect(tsx(OFFER_FILE), ts.isTypeAliasDeclaration).find((node) => node.name.text === "OfferTab");
    expect(alias, `${OFFER_FILE} must still declare the OfferTab union`).toBeDefined();
    const members = ts.isUnionTypeNode(alias!.type)
      ? alias!.type.types.map((member) =>
          ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal) ? member.literal.text : member.getText(),
        )
      : [alias!.type.getText()];
    expect(
      members,
      'OfferTab must name six tabs: proof is no longer a tab of its own, it renders inside "assets"',
    ).toEqual(["business", "qualification", "voice", "prices", "assets", "cadence"]);
  });

  /*
   * Rewritten for the four-card page, and deliberately not deleted.
   *
   * The ruling this guards: proof stops being a destination of its own and renders inside
   * Marketing assets, with nothing about it deleted in the move. The
   * old assertions read a `ChipTabs` options array and a `tab === "assets"` conditional, which is
   * the mechanism that carried the ruling and not the ruling itself; the canvas pass replaced the
   * six chips with four open cards and demoted "Your program" and "Marketing assets" into a shut
   * drawer, so both anchors are gone while every fact the ledger recorded still has to hold. What
   * the ruling actually names is what is asserted here: six subjects and none of them proof, one
   * destination carrying the owner's word "Marketing assets", the proof editor sitting inside that
   * destination's group rather than beside it, every proof control moved across intact, and
   * exactly one proof editor in the tree.
   */
  it("gives Marketing assets a destination and Proof none of its own", () => {
    const file = tsx(OFFER_FILE);
    const subjects = subjectLabels(file);
    expect(subjects, `${OFFER_FILE} must still declare TAB_LABELS as an object literal`).not.toBeNull();
    expect(
      subjects!.map((subject) => subject.key),
      "proof is not one of the six subjects; it renders inside assets",
    ).toEqual(["business", "qualification", "voice", "prices", "assets", "cadence"]);
    expect(
      subjects!.find((subject) => subject.key === "assets")?.label,
      'the assets subject must carry the destination name Alec used: "Marketing assets"',
    ).toBe("Marketing assets");

    const assets = settingsCardsTitled(file, "Marketing assets");
    const proof = settingsCardsTitled(file, "Proof and case studies");
    expect(assets, `${OFFER_FILE} must render exactly one Marketing assets card`).toHaveLength(1);
    expect(proof, `${OFFER_FILE} must render exactly one Proof and case studies card`).toHaveLength(1);
    // The containment the ledger records: the proof body renders beneath the assets body inside one
    // group, so Proof is reached by opening Marketing assets and never as a peer of the six
    // subjects. A shared immediate parent is what "inside" means once the tab branch is gone.
    expect(
      proof[0].parent === assets[0].parent,
      "the proof card must sit in the same group as Marketing assets, not beside the subject cards",
    ).toBe(true);
    expect(
      subjects!.map((subject) => subject.label),
      "Proof must not become a seventh subject under any name",
    ).not.toContain("Proof and case studies");
  });

  it("keeps every proof control inside the Marketing assets group", () => {
    const file = tsx(OFFER_FILE);
    const assets = settingsCardsTitled(file, "Marketing assets");
    expect(assets, `${OFFER_FILE} must render exactly one Marketing assets card`).toHaveLength(1);
    const group = assets[0].parent;
    const span = group.getText();
    const controls = [
      ">Add proof</ActionButton>",
      "form.proof.map(",
      'update("proof", form.proof.filter(',
      'resource="offer-proof"',
    ];
    for (const control of controls) {
      expect(
        span,
        `the Marketing assets group must hold the proof control \`${control}\`, the move deletes nothing`,
      ).toContain(control);
      // And nowhere else in the file. Containment alone is satisfiable by a second copy sitting
      // outside the group, so every occurrence in the file has to be one of the occurrences in the
      // span -- counted rather than matched once, because the row iteration and its two field
      // updaters all read `form.proof.map(` and all three belong to this editor.
      expect(
        span.split(control).length,
        `every \`${control}\` in ${OFFER_FILE} must be inside the Marketing assets group`,
      ).toBe(source(OFFER_FILE).split(control).length);
    }
  });

  it("holds exactly one proof editor across the live workspace components", () => {
    const editors = liveComponentFiles(LIVE_ROOT).flatMap((file) => proofRowIterations(tsx(file)).map(() => file));
    expect(editors, "the proof editor is relocated, never copied, exactly one may exist").toEqual([OFFER_FILE]);
    const file = tsx(OFFER_FILE);
    expect(
      settingsCardsTitled(file, "Proof and case studies"),
      "exactly one proof editor may exist, and it renders inside the Marketing assets group",
    ).toHaveLength(1);
  });
});


const SOURCE_PATH = "src/components/ui/select.tsx";
const COMPONENT_ROOT = "src/components";

// `admin-brain.tsx` keeps its two native selects on purpose: phase 10 plan 10-03 is editing
// that file in a parallel lane, and a collision there costs more than the two selects are
// worth. A native select cannot exhibit the wrap defect, so this is a scope note rather than
// an open instance of R4-14. Delete this entry once 10-03 merges.
// The brain import review was the last holdout; nothing on a live surface may hand-roll a select.
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
  it("builds the cadence row from the shared select", () => {
    const file = tsx(OFFER_FILE);
    const importsPrimitive = collect(file, ts.isImportDeclaration).some(
      (node) => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "@/components/ui/select",
    );
    expect(importsPrimitive, `${OFFER_FILE} must import the shared select`).toBe(true);
    // The redesign made the cadence schedule platform-driven: the coach edits only the
    // Purpose of each fixed touch, so the Channel class dropdown no longer exists at all.
    // R4-24's substance survives: the remaining cadence control is the shared Select.
    const labels = jsxElementsNamed(file, "Select").flatMap((element) =>
      element.attributes.properties.flatMap((property) =>
        ts.isJsxAttribute(property) && property.name.getText() === "label" && property.initializer
          ? [property.initializer.getText()]
          : [],
      ),
    );
    expect(
      labels.some((label) => /purpose/iu.test(label)),
      "the cadence purpose control Alec reported must be the shared Select, not a native select",
    ).toBe(true);
    expect(
      labels.some((label) => label.includes("Channel class")),
      "the channel-class dropdown is platform-scheduled now and must not come back as a control",
    ).toBe(false);
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

  it("builds both cadence option lists from the label maps", () => {
    const source = readFileSync(resolve(process.cwd(), COACH_OFFER_TSX), "utf8");
    expect(
      source,
      "the purpose dropdown must map through OFFER_CADENCE_PURPOSE_LABELS, not `label: value`",
    ).toContain("label: OFFER_CADENCE_PURPOSE_LABELS[value]");
    expect(
      source,
      "`label: value` in an options array is the raw-enum regression this test exists to catch",
    ).not.toContain("({ value, label: value })");
  });
});
