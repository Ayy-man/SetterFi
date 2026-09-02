import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { DayCounter, elapsedWorkspaceDays } from "@/components/kit/day-counter"

describe("DayCounter", () => {
  afterEach(() => vi.useRealTimers())

  it("renders elapsed workspace days without percentage or completion-date claims", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-08-23T16:00:00.000Z"))

    render(<DayCounter since="2026-08-14T16:00:00.000Z" typicalDays={[14, 21]} />)

    expect(screen.getByText("Day 9")).toBeInTheDocument()
    expect(screen.getByText(/submitted Aug 14/)).toBeInTheDocument()
    expect(screen.getByText(/typical 14 to 21 days/)).toBeInTheDocument()
    expect(screen.getByText(/no action needed from you/)).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent("%")
    expect(document.body).not.toHaveTextContent(/Sep|2026/)
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("counts workspace calendar boundaries across daylight saving changes", () => {
    expect(
      elapsedWorkspaceDays(
        "2026-03-07T17:00:00.000Z",
        new Date("2026-03-09T16:00:00.000Z"),
      ),
    ).toBe(2)
  })

  it("treats a date-only start as a workspace calendar date", () => {
    expect(
      elapsedWorkspaceDays("2026-08-14", new Date("2026-08-23T16:00:00.000Z")),
    ).toBe(9)
  })

  it("reads a Postgres timestamptz, which carries six fractional digits", () => {
    // The regression: timestamptz comes back as .123456, the old bound accepted at most three,
    // and every waiting row lost its counter.
    expect(
      elapsedWorkspaceDays(
        "2026-08-14T16:00:00.123456+00:00",
        new Date("2026-08-23T16:00:00.000Z"),
      ),
    ).toBe(9)
    expect(
      elapsedWorkspaceDays(
        "2026-08-14T16:00:00.123456789Z",
        new Date("2026-08-23T16:00:00.000Z"),
      ),
    ).toBe(9)
  })

  it("reports an unreadable start time as an absence, and warns rather than throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    expect(
      elapsedWorkspaceDays("2026-08-14T12:00:00", new Date("2026-08-23T16:00:00.000Z")),
    ).toBeNull()
    expect(elapsedWorkspaceDays("2026-02-31", new Date("2026-08-23T16:00:00.000Z"))).toBeNull()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it("shows no day count when the start time cannot be read", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})

    render(<DayCounter since="not a timestamp" typicalDays={[14, 21]} />)

    expect(screen.getByText("Still waiting")).toBeVisible()
    expect(document.body).not.toHaveTextContent(/Day \d/)
    expect(screen.getByText(/typical 14 to 21 days/)).toBeInTheDocument()
    warn.mockRestore()
  })
})

/**
 * The A2P sentence renders at the coach's scale on coach surfaces and does not move on the
 * console's, and both halves are asserted because only one of them is the fix.
 *
 * `DayCounter` is shared. `coach-channel-status.tsx` and `coach-integrations.tsx` mount it on the
 * coach side, `sms-eligibility` and `connect-channels` mount it in onboarding, and
 * `admin-channel-health.tsx` and `admin-provisioning.tsx` mount it inside the owner console, which
 * is deliberately the denser surface. So the lift lives in `coach.css` under
 * `[data-shell-role="coach"]` rather than in the component, and what has to be true is a pair: the
 * scoped rule exists and can reach the component's own class hooks, and the component still emits
 * the console's classes so nothing an admin route renders changes.
 *
 * Read off the stylesheet rather than a computed style because jsdom applies no CSS -- a
 * `getComputedStyle` here would report the literal `var(--coach-body)` and pass against any value.
 * What jsdom can prove is the other half: which classes the component actually emits, which is the
 * hook the rule depends on and the thing that silently breaks a scoped rule when it is renamed.
 */
describe("DayCounter across the two densities", () => {
  const COACH_CSS = readFileSync(
    resolve(process.cwd(), "src/app/(workspace)/coach/coach.css"),
    "utf8",
  )

  /** The rule body for one selector, from its brace to the next. */
  function ruleFor(selector: string) {
    const start = COACH_CSS.indexOf(`${selector} {`)
    expect(start, `${selector} is not in coach.css, so nothing below was checked`).toBeGreaterThan(-1)
    return COACH_CSS.slice(start, COACH_CSS.indexOf("}", start))
  }

  it("still emits the class hooks the coach rule selects on", () => {
    render(<DayCounter now={new Date("2026-08-23T16:00:00.000Z")} since="2026-08-14T16:00:00.000Z" typicalDays={[14, 21]} />)

    // The rule is `.daycount` and `.daycount strong`. If either hook is renamed the stylesheet goes
    // on matching nothing, which looks exactly like a surface that was never fixed.
    const line = screen.getByText(/typical 14 to 21 days/).closest("p")
    expect(line).toHaveClass("daycount")
    expect(line?.querySelector("strong")).toHaveTextContent("Day 9")
  })

  it("keeps the same hooks on the arm that cannot count", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    render(<DayCounter since="not a timestamp" typicalDays={[14, 21]} />)

    // The honest-state arm is the one a coach sees when the filing receipt is missing, so it needs
    // the lift as much as the counting arm -- and it is a separate return in the component.
    const line = screen.getByText("Still waiting").closest("p")
    expect(line).toHaveClass("daycount")
    warn.mockRestore()
  })

  it("lifts the coach side to the coach tokens, from a scope the console cannot be in", () => {
    expect(ruleFor('[data-shell-role="coach"] .daycount')).toContain("font-size: var(--coach-body)")
    expect(ruleFor('[data-shell-role="coach"] .daycount strong'))
      .toContain("font-size: var(--coach-row-name)")

    // The tokens have to be declared, or both rules resolve to nothing and drop -- the `--r-pill`
    // failure. They are declared in the same sheet, under the same attribute.
    expect(COACH_CSS).toContain("--coach-body: 16px")
    expect(COACH_CSS).toContain("--coach-row-name: 17px")
  })

  /**
   * The half a one-directional test misses. Every `.daycount` rule in the sheet has to be scoped,
   * because an unscoped one in this file would still be loaded on an admin route and would move
   * the console -- `coach.css` is imported by the app, not by the coach routes alone.
   */
  it("scopes every daycount rule, so no admin mount can match one", () => {
    /*
     * Comments stripped first, and that is the whole reason this assertion works.
     *
     * Two earlier versions of this line both passed against a deliberately unscoped rule. The
     * first required a character before `.daycount`, so a bare `.daycount {` -- the exact rule it
     * exists to catch -- matched nothing and the loop ran over an empty list. The second matched
     * it, but a selector pattern of `[^{}]*` runs backwards through any comment above the rule,
     * because a CSS comment contains no braces; the block above these rules explains the scoping
     * and therefore *quotes* `[data-shell-role="coach"]`, so the captured "selector" contained the
     * attribute as prose and `toContain` passed on the documentation rather than on the code.
     */
    const selectors = [...COACH_CSS.replace(/\/\*[\s\S]*?\*\//gu, "\n").matchAll(/^([^{}\n][^{}]*)\{/gmu)]
      .map((match) => match[1].trim())
      .filter((selector) => selector.includes(".daycount"))

    expect(selectors, "no .daycount rule was found, so this asserted nothing").not.toHaveLength(0)
    for (const selector of selectors) {
      expect(selector, `${selector} is not scoped to the coach shell`)
        .toContain('[data-shell-role="coach"]')
    }
  })

  /**
   * And the component keeps the console's own sizes, which is what "admin does not move" means in
   * the only place it can be checked: the classes the shared component emits. A lift done by
   * editing these would have fixed the coach side and silently enlarged two admin surfaces.
   */
  it("leaves the console's sizes on the component itself", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/kit/day-counter.tsx"),
      "utf8",
    )
    expect(source).toContain("text-body")
    expect(source).toContain("text-row")
    // No coach token may leak into the shared component; that is what the scoped sheet is for.
    expect(source).not.toContain("--coach-")
  })
})
