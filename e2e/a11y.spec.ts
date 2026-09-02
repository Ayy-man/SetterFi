import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  ADMIN_ROUTES,
  AFFILIATE_ROUTES,
  ALIAS_ROUTES,
  COACH_ROUTES,
  PUBLIC_ROUTES,
} from "./routes";

type Theme = "light" | "dark";
type AuthenticatedRole = "admin" | "coach" | "affiliate";

const THEMES = ["light", "dark"] as const;
const AUTHENTICATED_SWEEPS = {
  admin: [
    ...ADMIN_ROUTES,
    ...ALIAS_ROUTES.filter(([route]) => route.startsWith("/admin")).map(([route]) => route),
    "/meet-agent",
  ],
  coach: [
    ...COACH_ROUTES,
    ...ALIAS_ROUTES.filter(([route]) => route.startsWith("/coach")).map(([route]) => route),
    "/coach",
  ],
  affiliate: AFFILIATE_ROUTES,
} as const satisfies Record<AuthenticatedRole, ReadonlyArray<string>>;
const PUBLIC_SWEEP = [
  ...PUBLIC_ROUTES,
  "/access",
  "/opt-in/synthetic-coach",
  "/opt-in/synthetic-coach/privacy",
  "/opt-in/synthetic-coach/terms",
] as const;

async function selectTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.evaluate((selectedTheme) => {
    document.documentElement.dataset.theme = selectedTheme;
    document.documentElement.dataset.workspaceTheme = selectedTheme;
    window.localStorage.setItem("theme", selectedTheme);
  }, theme);
  await page.evaluate(async () => document.fonts.ready);
  // Colour transitions (transition-all controls) run after the theme flip; axe must not sample mid-transition.
  await page.evaluate(async () => {
    // Transitions start on the next style recalc, so give the flip two frames before collecting them.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await Promise.allSettled(document.getAnimations().map((animation) => animation.finished));
  });
  // axe still reads the pre-flip colours for one more paint; a short settle keeps its sample honest.
  await page.waitForTimeout(150);
}

async function assertNoHighImpactAxeViolations(page: Page, route: string): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations
    .filter(({ impact }) => impact === "serious" || impact === "critical")
    .map(({ id, impact, help, nodes }) => ({
      id,
      impact,
      help,
      targets: nodes.flatMap(({ target }) => target).slice(0, 8),
    }));

  expect(violations, `${route} has serious or critical axe violations`).toEqual([]);
}

async function assertStatusesHaveNonColorCues(page: Page, route: string): Promise<void> {
  const offenders = await page.evaluate(() => {
    const selector = [
      '[data-slot="state-badge"]',
      '[role="status"]',
      "[data-status]",
      "[data-tone]",
    ].join(",");

    return Array.from(document.querySelectorAll<HTMLElement>(selector))
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .flatMap((element) => {
        const isVisuallyRendered = (candidate: Element) => {
          let current: Element | null = candidate;
          while (current) {
            const style = getComputedStyle(current);
            if (
              style.display === "none" ||
              style.visibility === "hidden" ||
              Number.parseFloat(style.opacity) === 0 ||
              style.clip !== "auto" ||
              style.clipPath !== "none"
            ) {
              return false;
            }
            current = current.parentElement;
          }
          return true;
        };
        const textWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let hasVisibleText = false;
        let node = textWalker.nextNode();
        while (node) {
          const text = node.textContent?.trim();
          const parent = node.parentElement;
          if (text && parent) {
            const style = getComputedStyle(parent);
            const range = document.createRange();
            range.selectNodeContents(node);
            const rect = range.getBoundingClientRect();
            hasVisibleText =
              isVisuallyRendered(parent) &&
              style.color !== "transparent" &&
              !style.color.endsWith(", 0)") &&
              rect.width > 0 &&
              rect.height > 0;
            if (hasVisibleText) break;
          }
          node = textWalker.nextNode();
        }
        const hasMeaningfulVisibleIcon = Array.from(
          element.querySelectorAll<SVGElement>("svg"),
        ).some((icon) => {
          let current: Element | null = icon;
          while (current) {
            if (current.getAttribute("aria-hidden") === "true") return false;
            current = current.parentElement;
          }

          const style = getComputedStyle(icon);
          const rect = icon.getBoundingClientRect();
          const drawsShape = Boolean(icon.querySelector("path, line, polyline, polygon, rect"));
          return (
            drawsShape &&
            isVisuallyRendered(icon) &&
            style.color !== "transparent" &&
            !style.color.endsWith(", 0)") &&
            rect.width >= 8 &&
            rect.height >= 8
          );
        });

        if (hasVisibleText || hasMeaningfulVisibleIcon) return [];

        const identity = element.id
          ? `#${element.id}`
          : `${element.tagName.toLowerCase()}${element.classList.length > 0 ? `.${Array.from(element.classList).join(".")}` : ""}`;
        return [identity];
      });
  });

  expect(offenders, `${route} has statuses carried by colour alone`).toEqual([]);
}

async function assertVisibleFocusRings(page: Page, route: string): Promise<void> {
  await page.keyboard.press("Tab");
  const offenders = await page.evaluate(() => {
    const focusableSelector = [
      "a[href]",
      "button",
      "input",
      "select",
      "textarea",
      "summary",
      "[tabindex]",
      '[role="button"]',
      '[role="checkbox"]',
      '[role="combobox"]',
      '[role="link"]',
      '[role="menuitem"]',
      '[role="option"]',
      '[role="radio"]',
      '[role="slider"]',
      '[role="switch"]',
      '[role="tab"]',
      '[role="textbox"]',
    ].join(",");

    type Cue = {
      outline: string;
      shadow: string;
    };

    const cueSnapshot = (element: Element): Cue => {
      const style = getComputedStyle(element);
      return {
        outline: `${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
        shadow: style.boxShadow,
      };
    };
    const ancestry = (element: HTMLElement) => {
      const elements: Element[] = [element];
      let ancestor = element.parentElement;
      while (ancestor && elements.length < 4) {
        elements.push(ancestor);
        ancestor = ancestor.parentElement;
      }
      return elements;
    };
    const hasVisibleOutline = (element: Element) => {
      const style = getComputedStyle(element);
      return (
        style.outlineStyle !== "none" &&
        Number.parseFloat(style.outlineWidth) >= 1 &&
        style.outlineColor !== "transparent" &&
        !style.outlineColor.endsWith(", 0)")
      );
    };
    const hasVisibleShadow = (element: Element) => {
      const shadow = getComputedStyle(element).boxShadow;
      return shadow !== "none" && !/^rgba?\([^)]*,\s*0\)(?:\s+0px){2,}/.test(shadow);
    };
    const elements = Array.from(document.querySelectorAll<HTMLElement>(focusableSelector)).filter(
      (element) => {
        // Content of a closed <details> keeps a layout box but cannot take focus; only its summary can.
        const closedDetails = element.closest("details:not([open])");
        if (closedDetails && element.parentElement !== closedDetails) return false;
        if (closedDetails && element.tagName !== "SUMMARY") return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          element.tabIndex >= 0 &&
          !element.matches(":disabled, [aria-disabled='true'], [inert] *") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0
        );
      },
    );

    return elements.flatMap((element) => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      const observed = ancestry(element);
      const before = observed.map(cueSnapshot);
      // Programmatic focus alone does not match :focus-visible in Chromium; ask for the visible variant.
      element.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
      const after = observed.map(cueSnapshot);
      const hasNewVisibleRing = observed.some((candidate, index) => {
        if (hasVisibleOutline(candidate) && after[index].outline !== before[index].outline) return true;
        if (hasVisibleShadow(candidate) && after[index].shadow !== before[index].shadow) return true;
        return false;
      });

      if (document.activeElement === element && element.matches(":focus-visible") && hasNewVisibleRing) {
        return [];
      }

      const label =
        element.getAttribute("aria-label") ??
        element.innerText.trim().slice(0, 80) ??
        element.getAttribute("name") ??
        "unlabelled";
      return [`${element.tagName.toLowerCase()} ${label}`];
    });
  });

  expect(offenders, `${route} has interactive elements without a visible focus ring`).toEqual([]);
}

async function auditRoute(page: Page, route: string, theme: Theme): Promise<void> {
  await page.goto(route, { waitUntil: "networkidle" });
  await selectTheme(page, theme);
  await assertNoHighImpactAxeViolations(page, route);
  await assertStatusesHaveNonColorCues(page, route);
  await assertVisibleFocusRings(page, route);
}

test.describe("AA route sweep", () => {
  test.setTimeout(20 * 60 * 1_000);
  test.use({
    baseURL: `http://localhost:${process.env.E2E_PORT ?? "3000"}`,
    viewport: { width: 1440, height: 900 },
  });

  for (const theme of THEMES) {
    for (const [role, routes] of Object.entries(AUTHENTICATED_SWEEPS) as ReadonlyArray<
      [AuthenticatedRole, ReadonlyArray<string>]
    >) {
      test(`${role} routes pass in ${theme}`, async ({ browser }) => {
        const context = await browser.newContext({
          storageState: `e2e/.auth/${role}.json`,
        });
        const page = await context.newPage();

        try {
          for (const route of routes) await auditRoute(page, route, theme);
        } finally {
          await context.close();
        }
      });
    }

    test(`public routes pass in ${theme}`, async ({ page }) => {
      for (const route of PUBLIC_SWEEP) await auditRoute(page, route, theme);
    });
  }
});
