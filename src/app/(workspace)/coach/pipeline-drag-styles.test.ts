// @vitest-environment node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The pipeline drag rules against the component that is supposed to be wearing them.
 *
 * These 141 lines were written into `globals.css`, where every selector was unscoped and matched by
 * construction. They are here now: `KanbanBoard` reaches the tree only through `coach-pipeline.tsx`,
 * itself reached only by `LeadsSurface` on `/coach/pipelines` and `/coach/contacts`, both under the
 * route group whose layout imports this file. Nothing outside the coach shell could ever have drawn
 * them, and the app-wide budget was carrying one surface's behaviour for every reader of every
 * other one.
 *
 * **Moving CSS is the change that most easily goes wrong in silence.** A selector that stops
 * matching does not throw; it renders the plain thing, and the only symptom is a drag that quietly
 * stopped feeling like anything. So this compares the two sides that have to agree -- the class and
 * attribute hooks the sheet selects on, and the ones the component writes -- rather than asserting
 * that some string appears somewhere.
 *
 * It reads sources rather than rendering a board on purpose. `kanban-board.tsx` is being rewritten
 * from HTML5 drag events onto pointer events by another lane as this lands, so a render-level sweep
 * would be asserting against a moving target and would fail for reasons that have nothing to do
 * with the stylesheet. The hooks below are the part of that component's contract the rewrite does
 * not change; a render-level check belongs with whoever finishes it.
 */

const ROOT = process.cwd();
const COACH_CSS = readFileSync(resolve(ROOT, "src/app/(workspace)/coach/coach.css"), "utf8");
const BOARD = readFileSync(resolve(ROOT, "src/components/kit/kanban-board.tsx"), "utf8");
const CARD = readFileSync(resolve(ROOT, "src/components/kit/kanban-card.tsx"), "utf8");

/** Selector heads in `coach.css` that name the board, comments and declarations stripped. */
function kanbanSelectors() {
  return COACH_CSS.replace(/\/\*[\s\S]*?\*\//gu, " ")
    .split("}")
    .map((block) => block.split("{")[0].trim())
    .flatMap((head) => head.split(",").map((one) => one.trim()))
    .filter((one) => one.includes("kanban"))
    // Keyframe steps and at-rule heads are not selectors.
    .filter((one) => !one.startsWith("@") && !/^\d/u.test(one))
    .map((one) => one.replace(/\s+/gu, " "));
}

describe("the pipeline drag stylesheet and the board agree on their hooks", () => {
  it("finds the rules it is about to check", () => {
    // Without this, a sheet that lost the whole block -- or a parse that produced nothing -- would
    // report perfect agreement between two empty sets.
    const selectors = kanbanSelectors();
    expect(selectors.length).toBeGreaterThan(10);
    expect(selectors.some((one) => one.startsWith(".kanban-drag-preview"))).toBe(true);
    expect(selectors.some((one) => one.includes("[data-kanban-column]"))).toBe(true);
  });

  /**
   * Every `kanban-` class the sheet selects on is one the component actually writes.
   *
   * This is the rename half: `.kanban-drag-preview-label` becoming `.kanban-drag-label` in the
   * component leaves three rules here selecting nothing, and no test that renders a board would
   * notice, because the board still renders.
   */
  it("selects on no class the component does not assign", () => {
    const written = new Set(
      [...`${BOARD}${CARD}`.matchAll(/"(kanban-[a-z-]+)"/gu)].map((match) => match[1]),
    );
    // Classes are also added through `classList.add`, which the literal sweep above catches, but
    // the control proves the sweep found something rather than agreeing with an empty set.
    expect(written.size, "no kanban class literal was found in the component").toBeGreaterThan(2);

    const selected = new Set(
      kanbanSelectors().flatMap((one) => [...one.matchAll(/\.(kanban-[a-z-]+)/gu)].map((m) => m[1])),
    );
    expect(selected.size).toBeGreaterThan(2);
    expect(
      [...selected].filter((one) => !written.has(one)),
      "these classes are selected in coach.css and written nowhere in the board, so the rules are dead",
    ).toEqual([]);
  });

  /**
   * The same for the data attributes, which is the half the drag states are actually built on.
   *
   * `data-drop-allowed`, `data-drop-target` and `data-drag-active` are what tell a coach which lane
   * will take the card. They are written as JSX props, so the sheet's `[data-drop-target="true"]`
   * and the component's `data-drop-target={...}` have to be checked against each other by name.
   */
  it("selects on no data attribute the board does not set", () => {
    /*
     * Every `data-` attribute the component writes, matched by shape.
     *
     * The first draft listed the names -- `data-kanban-*`, `data-drop-*`, `data-dragging`,
     * `data-landed` -- and that is an allowlist wearing a scan's clothes: `data-drag-enabled`
     * existed in both files and the pattern simply did not ask about it, so the guard reported a
     * live rule dead. A check that enumerates by hand can only ever see what its author already
     * knew, which is the opposite of what this one is for.
     */
    const written = new Set(
      [...`${BOARD}${CARD}`.matchAll(/\b(data-[a-z][a-z0-9-]*)\b/gu)].map((match) => match[1]),
    );
    expect(written.size, "no drag attribute was found in the board").toBeGreaterThan(4);

    const selected = new Set(
      kanbanSelectors().flatMap((one) => [...one.matchAll(/\[(data-[a-z-]+)/gu)].map((m) => m[1])),
    );
    expect(selected.size).toBeGreaterThan(4);
    /*
     * Three are written elsewhere and are named here rather than pattern-matched away, so each
     * exclusion is a sentence somebody had to mean: `data-shell-role` is stamped by `AppShell` on
     * the shell root and is what scopes this whole file, `data-state` is the column's own
     * expanded/collapsed state from the surface above the board, and `data-valid` is set on the
     * preview node by hand rather than through JSX.
     */
    const ELSEWHERE = ["data-shell-role", "data-state", "data-valid"];
    expect(
      [...selected].filter((one) => !ELSEWHERE.includes(one) && !written.has(one)),
      "these attributes are selected in coach.css and set nowhere in the board, so the rules are dead",
    ).toEqual([]);
  });

  /**
   * The preview's rules stay reachable from `document.body`.
   *
   * `createDragPreview` appends the preview outside the `[data-shell-role]` root, because a
   * `position: fixed` node inside a transformed ancestor positions against that ancestor instead of
   * the viewport. So a rule scoped to the shell cannot reach it. Adding that scope is a one-line
   * change that would silently unstyle the whole preview, which is precisely why it is pinned here
   * rather than left to a reviewer to notice.
   */
  it("leaves the portalled preview reachable, with no shell scope in front of it", () => {
    const previewRules = kanbanSelectors().filter((one) => one.includes("kanban-drag-preview"));
    expect(previewRules.length, "no preview rule was found to check").toBeGreaterThan(4);

    for (const rule of previewRules) {
      expect(
        rule.startsWith(".kanban-drag-preview"),
        `"${rule}" puts something in front of the preview's own class; the preview is appended to document.body and no ancestor selector reaches it there`,
      ).toBe(true);
    }

    expect(
      BOARD,
      "the preview is no longer appended to document.body, so the reachability rule above may no longer be the right one -- re-derive it before relaxing this",
    ).toContain("document.body.append(preview)");
  });

  /**
   * Nothing in the preview reads a token that is only declared inside the coach shell.
   *
   * Custom properties inherit through the DOM, not the React tree. A `--coach-*` token read at
   * `document.body` is undefined, and an undefined property with no fallback makes the browser drop
   * the whole declaration -- so the rule does not render wrong, it does not render. `--r-pill` was
   * exactly this: never declared anywhere, so the label's `border-radius` was dropped and the pill
   * drew square from the day it shipped.
   */
  it("reads no coach-scoped token from the portalled preview", () => {
    const block = COACH_CSS.slice(COACH_CSS.indexOf(".kanban-drag-preview {"));
    expect(block.length, "the preview block was not found").toBeGreaterThan(200);
    const previewBlock = block.slice(0, block.indexOf("[data-shell-role=\"coach\"] [data-kanban-card][data-landed"));
    expect(previewBlock.length, "the preview block had no end, so this read the rest of the file")
      .toBeGreaterThan(200);

    const coachTokens = [...previewBlock.matchAll(/var\(\s*(--coach-[a-z0-9-]+)/gu)].map((m) => m[1]);
    expect(
      coachTokens,
      "these resolve to nothing at document.body, so the browser drops the declarations that read them",
    ).toEqual([]);
  });
});
