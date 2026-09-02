import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"

import { createElement, type ComponentType } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  Select,
  selectItemClassName,
  selectItemIndicatorClassName,
  selectItemTextClassName,
  selectPopupClassName,
  type SelectProps,
} from "@/components/ui/select"

const SOURCE_PATH = "src/components/ui/select.tsx"

const WINDOW_OPTIONS = [
  { value: "1w", label: "Last 7 days" },
  { value: "1m", label: "Last 30 days" },
]

function tokens(className: string) {
  return className.split(/\s+/).filter(Boolean)
}

function render(props: SelectProps) {
  return renderToStaticMarkup(createElement(Select as ComponentType<SelectProps>, props))
}

// vitest runs in node with no layout engine, so nothing here measures a rendered pixel.
// These assertions pin the layout *model* instead: the previous primitive laid the option
// row out as a grid with the label confined to track 2, and that is why R4-14 and R4-24
// reported labels bunching into a narrow left column. A flex row with a growing label
// cannot express that defect.
describe("The option row is laid out so labels fill it (R4-14, R4-24)", () => {
  it("gives the option label the whole remaining row, on one line", () => {
    // flex-1 claims the leftover width, min-w-0 stops the flex-basis floor from
    // re-narrowing it, whitespace-nowrap keeps it off a second line.
    expect(tokens(selectItemTextClassName)).toEqual(
      expect.arrayContaining(["flex-1", "min-w-0", "whitespace-nowrap"])
    )
  })

  it("lays the option row out as flex, never as the grid that caused the defect", () => {
    expect(tokens(selectItemClassName)).toEqual(expect.arrayContaining(["flex", "w-full"]))
    expect(
      selectItemClassName,
      "a grid track re-narrows the label cell, the defect is a property of the layout model"
    ).not.toMatch(/\bgrid(-cols)?\b/)
  })

  it("keeps the indicator at the end without letting it squeeze the label", () => {
    expect(tokens(selectItemIndicatorClassName)).toEqual(
      expect.arrayContaining(["shrink-0", "order-last"])
    )
  })

  it("honours reduced motion on the popup itself", () => {
    // The global prefers-reduced-motion block scopes .agent-shell, .agent-loading and
    // .agent-dialog only, so a workspace popup inherits nothing and must carry it.
    expect(selectPopupClassName).toContain("motion-reduce:animate-none")
    expect(selectPopupClassName).toContain("motion-reduce:transition-none")
  })
})

describe("The server-rendered accessibility and form contract", () => {
  it("renders the trigger as a combobox that owns a listbox", () => {
    const html = render({ label: "Window", options: WINDOW_OPTIONS, value: "1w" })
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
  })

  it("names the trigger with the field label span, in the server markup", () => {
    // Base UI wires aria-labelledby from a post-mount effect. The component owns the id
    // instead, so the accessible name exists in the first paint rather than after hydration.
    const html = render({ label: "Window", options: WINDOW_OPTIONS, value: "1w" })
    const labelId = html.match(/<span[^>]*\bid="([^"]+)"[^>]*>Window<\/span>/)?.[1]
    const labelledBy = html.match(/aria-labelledby="([^"]+)"/)?.[1]
    expect(labelId, "the field label must render as a span carrying an id").toBeTruthy()
    expect(labelledBy).toBe(labelId)
  })

  it("keeps a visually hidden label in the accessibility tree", () => {
    const html = render({
      label: "Conversation state filter",
      options: WINDOW_OPTIONS,
      value: "1w",
      srOnly: true,
    })
    const label = html.match(/<span[^>]*>Conversation state filter<\/span>/)?.[0] ?? ""
    expect(label, "srOnly hides the label visually, never from a screen reader").toContain("sr-only")
    const labelId = label.match(/\bid="([^"]+)"/)?.[1]
    expect(html.match(/aria-labelledby="([^"]+)"/)?.[1]).toBe(labelId)
  })

  it("submits through a hidden input so forms keep working", () => {
    // coach-measurement.tsx is uncontrolled inside <form method="get">; if this input
    // stops carrying the value the window filter silently stops filtering.
    const html = render({ label: "Window", options: WINDOW_OPTIONS, name: "window", defaultValue: "1w" })
    const input = html.match(/<input[^>]*\bname="window"[^>]*>/)?.[0]
    expect(input, "a select with a name must render a submittable hidden input").toBeTruthy()
    expect(input).toContain('value="1w"')
  })

  it("shows the selected option's label on the trigger, not its raw value", () => {
    const html = render({ label: "Window", options: WINDOW_OPTIONS, value: "1m" })
    expect(html).toContain("Last 30 days")
    expect(html, 'the trigger must never surface a raw value like "1m" as its text').not.toMatch(
      />1m</
    )
  })

  it("shows the placeholder when nothing is selected", () => {
    const html = render({
      label: "Window",
      options: WINDOW_OPTIONS,
      value: null,
      placeholder: "Choose a window",
    })
    expect(html).toContain("Choose a window")
  })

  it("disables the trigger when the select is disabled", () => {
    const html = render({ label: "Assignee", options: WINDOW_OPTIONS, value: "1w", disabled: true })
    expect(html).toMatch(/<button[^>]*\bdisabled=""/)
  })

  it("renders every option label as escaped React text", () => {
    // T-ujc-01: option labels carry admin- and tenant-authored text (config labels,
    // success-owner names, correction identifiers). React escapes text children; an
    // innerHTML escape hatch here would turn all of them into an injection surface.
    const source = readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf8")
    expect(source).not.toContain("dangerouslySetInnerHTML")
  })
})

/**
 * The one door onto Base UI's select, so nothing can opt out of the label resolution above.
 *
 * `select.tsx` resolves a trigger's text from the items a caller already wrote, and `SelectValue`
 * falls back to the placeholder rather than to `String(value)`. Both live in this file, so both
 * are bypassed by a surface that reaches `@base-ui/react/select` itself -- and the bypass would
 * look like ordinary composed usage while printing a UUID at a reader, which is precisely the
 * defect the resolution was written for.
 *
 * A guard on the six known call sites would have said nothing about the seventh. This one is about
 * the boundary, so a new surface either goes through this file or fails here.
 */
describe("nothing reaches Base UI's select except this file", () => {
  const SELECT_IMPORT = /from\s+["']@base-ui\/react\/select["']/

  // The filesystem rather than `git ls-files`: a surface added in the same change that reaches
  // past this file would not be tracked yet, and the scan has to see it on the run that would
  // otherwise let it through.
  function sources() {
    return ["src/app", "src/components", "src/lib"]
      .flatMap((root) =>
        readdirSync(root, { recursive: true, encoding: "utf8" })
          .filter((entry) => /\.tsx?$/.test(entry))
          .map((entry) => `${root}/${entry}`))
      .filter((file) => file !== SOURCE_PATH)
  }

  it("scans a non-empty set of sources", () => {
    // Without this a mistyped glob would report a clean tree by finding nothing at all.
    expect(sources().length).toBeGreaterThan(200)
  })

  it("leaves the Base UI select primitive imported in exactly one place", () => {
    const offenders = sources()
      .filter((file) => SELECT_IMPORT.test(readFileSync(resolve(process.cwd(), file), "utf8")))
    expect(
      offenders,
      "these files reach past src/components/ui/select.tsx, so the trigger's label resolution does not apply to them",
    ).toEqual([])
  })

  it("finds the import it is looking for, in the file that is allowed to have it", () => {
    // The regex is the whole test; a pattern that matched nothing would pass the sweep above on
    // any tree at all.
    expect(SELECT_IMPORT.test(readFileSync(resolve(process.cwd(), SOURCE_PATH), "utf8"))).toBe(true)
  })
})
