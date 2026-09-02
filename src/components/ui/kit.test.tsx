import { render, screen } from "@testing-library/react"
import "@testing-library/jest-dom/vitest"
import type { CSSProperties } from "react"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

describe("shadcn UI kit", () => {
  const primaryBackground = "rgb(9, 105, 218)"
  let style: HTMLStyleElement

  beforeAll(() => {
    style = document.createElement("style")
    style.textContent = `.bg-primary { background: ${primaryBackground}; }`
    document.head.append(style)
  })

  afterAll(() => style.remove())

  it("mounts the shared controls and uses the primary token for the default button", () => {
    render(
      <div
        data-testid="token-host"
        style={{ "--color-primary": primaryBackground } as CSSProperties}
      >
        <Button>Continue</Button>
        <Badge>Active</Badge>
        <Input aria-label="Company" />
        <Switch aria-label="Notifications" />
        <Skeleton data-testid="skeleton" />
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger render={<button type="button">Help</button>} />
            <TooltipContent>Helpful context</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    )

    const button = screen.getByRole("button", { name: "Continue" })
    expect(button).toBeInTheDocument()
    expect(screen.getByText("Active")).toBeInTheDocument()
    expect(screen.getByLabelText("Company")).toBeInTheDocument()
    expect(screen.getByRole("switch", { name: "Notifications" })).toBeInTheDocument()
    expect(screen.getByTestId("skeleton")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Help" })).toBeInTheDocument()
    expect(button).toHaveClass("bg-primary")
    const primaryToken = getComputedStyle(screen.getByTestId("token-host"))
      .getPropertyValue("--color-primary")
      .trim()
    expect(getComputedStyle(button).backgroundColor).toBe(primaryToken)
  })
})
