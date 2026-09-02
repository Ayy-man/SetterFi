"use client"

import { MoreHorizontal } from "@/components/kit/icons";

import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export type ActionMenuItem = {
  label: string
  onSelect: () => void
  icon?: ReactNode
  shortcut?: string
  disabled?: boolean
  destructive?: boolean
  separatorBefore?: boolean
}

export type ActionMenuProps = {
  items: readonly ActionMenuItem[]
  label?: string
  trigger?: ReactNode
  disabled?: boolean
}

export function ActionMenu({
  items,
  label = "Open actions",
  trigger,
  disabled,
}: ActionMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        disabled={disabled}
        render={<Button size="icon-sm" type="button" variant="ghost" />}
      >
        {trigger ?? <MoreHorizontal aria-hidden />}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="min-w-[calc(var(--sidebar-w)-var(--s-10))] origin-(--transform-origin) rounded-(--r-card) border border-[var(--line)] bg-[var(--raised)] p-(--s-1) shadow-(--shadow-raised) duration-(--dropdown-open-dur) ease-(--dropdown-ease) motion-reduce:animate-none motion-reduce:transition-none"
        role="menu"
      >
        {items.map((item) => (
          <div key={item.label} role="none">
            {item.separatorBefore ? (
              <DropdownMenuSeparator className="mx-(--s-1) my-(--s-1) bg-[var(--line)]" />
            ) : null}
            <DropdownMenuItem
              className="min-h-(--row-h-dense) gap-(--s-2) rounded-(--r-control) px-(--s-2) py-(--s-1) text-[length:var(--t-body)] leading-(--t-body-lh) font-(--t-body-w) tracking-(--t-body-tr) text-[color:var(--body)] focus:bg-[var(--row-hover)] focus:text-[color:var(--ink)] data-[variant=destructive]:focus:bg-[var(--quiet)]"
              disabled={item.disabled}
              onClick={() => item.onSelect()}
              variant={item.destructive ? "destructive" : "default"}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.shortcut ? (
                <DropdownMenuShortcut className="text-[length:var(--t-over)] leading-(--t-over-lh) font-(--t-over-w) tracking-(--t-over-tr) text-[color:var(--faint)] uppercase">
                  {item.shortcut}
                </DropdownMenuShortcut>
              ) : null}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
