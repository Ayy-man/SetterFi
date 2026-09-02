import { expect, type Page } from "@playwright/test";
import { ROUTE_VIOLATION_ALLOWLIST } from "./allowlist";
import {
  findPlatformEconomics,
  formatPlatformEconomicsHits,
} from "../src/test/platform-economics";

function formatList(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(" | ");
}

type AccessibleRole = Parameters<Page["getByRole"]>[0];

const ACCESSIBLE_ROLES = [
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "paragraph",
  "presentation",
  "progressbar",
  "radio",
  "radiogroup",
  "region",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  "spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  "textbox",
  "time",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
] as const satisfies ReadonlyArray<AccessibleRole>;

export async function assertNoErrorBoundary(page: Page, route: string): Promise<void> {
  const accessibleNameOffenders = (
    await Promise.all(
      ACCESSIBLE_ROLES.map(async (role) => {
        const matches = page.getByRole(role, { name: /workspace interrupted/i });
        return (await matches.allTextContents()).map(
          (text) => `${role}: ${text.trim() || "Workspace interrupted"}`,
        );
      }),
    )
  ).flat();

  const loadingText = await page.evaluate(() => {
    const bodyText = document.body.innerText;
    const loadingFailure = /couldn.t finish loading/i.test(bodyText);
    const shellCount = document.querySelectorAll("[data-shell-root]").length;
    return loadingFailure && shellCount === 0
      ? bodyText.match(/.{0,80}couldn.t finish loading.{0,80}/i)?.[0]?.trim()
      : undefined;
  });
  const offenders = Array.from(
    new Set([...accessibleNameOffenders, ...(loadingText ? [loadingText] : [])]),
  );

  expect(
    offenders,
    `${route} rendered an error boundary: ${formatList(offenders)}`,
  ).toEqual([]);
}

export async function assertNoBodyOverflow(page: Page, route: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const scrollWidth = document.documentElement.scrollWidth;
    const viewportWidth = window.innerWidth;
    if (scrollWidth <= viewportWidth + 1) return [];

    const offendingElements = Array.from(document.querySelectorAll<HTMLElement>("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > viewportWidth + 1 || rect.left < -1);
      })
      .slice(0, 10)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const identity = element.id
          ? `#${element.id}`
          : element.classList.length > 0
            ? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`
            : element.tagName.toLowerCase();
        return `${identity} from ${Math.round(rect.left)} to ${Math.round(rect.right)}px`;
      });

    return [
      `document is ${scrollWidth}px wide at a ${viewportWidth}px viewport`,
      ...offendingElements,
    ];
  });

  expect(
    offenders,
    `${route} overflows horizontally: ${formatList(offenders)}`,
  ).toEqual([]);
}

export async function assertTypeFloor(page: Page, route: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const root =
      document.querySelector<HTMLElement>("#workspace-main") ??
      document.querySelector<HTMLElement>("main") ??
      document.querySelector<HTMLElement>("[data-shell-root]") ??
      document.body;

    return [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))]
      .filter((element) => {
        const hasOwnText = Array.from(element.childNodes).some(
          (node) => node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
        );
        if (!hasOwnText || element.closest('[class*="react-flow__"]')) return false;

        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .flatMap((element) => {
        const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
        if (!Number.isFinite(fontSize) || fontSize >= 11) return [];

        const text = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim() ?? "")
          .filter(Boolean)
          .join(" ");
        const identity = element.id
          ? `#${element.id}`
          : element.classList.length > 0
            ? `${element.tagName.toLowerCase()}.${Array.from(element.classList).join(".")}`
            : element.tagName.toLowerCase();
        return [`${identity} at ${fontSize}px: ${text.slice(0, 120)}`];
      });
  });

  expect(
    offenders,
    `${route} renders text below 11px: ${formatList(offenders)}`,
  ).toEqual([]);
}

export async function assertNoMachineCopy(page: Page, route: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const visibleText = document.body.innerText;
    const pattern = /persisted|Still filling|Action refused|projection|RPC|timestamptz|tombstone|, cents\b|SETTERFI_[A-Z0-9_]+|\b[A-Z][A-Z0-9]{2,}(_[A-Z0-9]+)+\b|\b[0-9a-f]{8}-[0-9a-f]{4}-/gi;
    return Array.from(new Set(visibleText.match(pattern) ?? []));
  });

  expect(
    offenders,
    `${route} exposes machine copy: ${formatList(offenders)}`,
  ).toEqual([]);
}

export async function assertNoEmDash(page: Page, route: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const visibleText = document.body.innerText;
    const snippets: string[] = [];

    for (let index = visibleText.indexOf("\u2014"); index >= 0; index = visibleText.indexOf("\u2014", index + 1)) {
      snippets.push(visibleText.slice(Math.max(0, index - 60), index + 61).trim());
    }

    return Array.from(new Set(snippets));
  });

  expect(
    offenders,
    `${route} contains an em dash: ${formatList(offenders)}`,
  ).toEqual([]);
}

/**
 * No client surface may show the platform's own economics.
 *
 * This is deliberately NOT part of `assertAll`: admin routes are where cost and margin are
 * supposed to live, so the sweep would fail on `/admin/billing` by design. The coach and
 * affiliate smoke specs call it; the admin ones do not.
 *
 * It reads `innerText`, so it sees what a client actually sees -- a margin tile pulled onto
 * `/coach/agent` during a redesign fails here even if the number arrives from a shared
 * component. The vocabulary, and the line between our economics and the client's own bill,
 * live in `src/test/platform-economics.ts`.
 */
export async function assertNoPlatformEconomics(page: Page, route: string): Promise<void> {
  const visibleText = await page.evaluate(() => document.body.innerText);
  const offenders = formatPlatformEconomicsHits(findPlatformEconomics(visibleText));

  expect(
    offenders,
    `${route} shows platform cost economics to a client: ${formatList(offenders)}`,
  ).toEqual([]);
}

export async function assertAll(page: Page, route: string): Promise<void> {
  const assertions = [
    assertNoErrorBoundary,
    assertNoBodyOverflow,
    assertTypeFloor,
    assertNoMachineCopy,
    assertNoEmDash,
  ] as const;
  const allowlisted = ROUTE_VIOLATION_ALLOWLIST[route] ?? [];

  for (const assertion of assertions) {
    try {
      await assertion(page, route);
    } catch (error) {
      const actual = (error as { matcherResult?: { actual?: unknown } }).matcherResult?.actual;
      if (!Array.isArray(actual)) throw error;

      const unallowlisted = actual.filter(
        (violation) => !allowlisted.some((substring) => String(violation).includes(substring)),
      );
      expect(
        unallowlisted,
        `${route} has unallowlisted violations: ${formatList(unallowlisted.map(String))}`,
      ).toEqual([]);
    }
  }
}
