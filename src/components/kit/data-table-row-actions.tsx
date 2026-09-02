"use client";

import { MoreHorizontal } from "@/components/kit/icons";

import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export type RowAction = {
  id: string;
  label: string;
  onSelect?: () => void;
  href?: string;
  disabled?: boolean;
  tone?: "default" | "critical";
  /** Audit microcopy shown under the item, e.g. AUDIT_ACTIONS[...].microcopy. */
  logged?: string;
};

export type DataTableRowActionsProps = {
  actions: readonly RowAction[];
  label: string;
};

/**
 * The row kebab. It carries exactly the actions the record sheet carries, so the row and the sheet
 * never disagree about what an admin can do.
 */
export function DataTableRowActions({ actions, label }: DataTableRowActionsProps) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;

  return (
    <DropdownMenu
      onOpenChange={(nextOpen, details) => {
        if (details.reason !== "trigger-press") setOpen(nextOpen);
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label={label}
        className={cn(
          buttonVariants({ size: "icon-sm", variant: "ghost" }),
          "data-[popup-open]:bg-[var(--quiet)]",
        )}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <MoreHorizontal aria-hidden className="size-[var(--s-4)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label} className="min-w-[calc(var(--drawer-w)/2)]">
        {actions.map((action, index) => {
          const previous = actions[index - 1];
          const needsSeparator = Boolean(previous) && previous?.tone !== action.tone;
          // The menu closes with an exit animation. Leaving the callback to the primitive's own
          // close sequence meant a sheet opened from an item mounted a frame or two later, which
          // read as a stall and forced tests to settle. Closing here and calling back in the same
          // tick makes the sheet appear on the same frame as the press.
          function runAction(event: { stopPropagation: () => void }) {
            event.stopPropagation();
            setOpen(false);
            action.onSelect?.();
          }

          const item = action.href ? (
            <DropdownMenuItem
              className={cn(action.tone === "critical" && "text-[var(--critical)]")}
              disabled={action.disabled}
              key={action.id}
              nativeButton={false}
              onClick={runAction}
              render={<a href={action.href} />}
            >
              <span className="flex min-w-0 flex-col">
                <span>{action.label}</span>
                {action.logged ? (
                  <span className="text-[length:var(--t-badge)] text-[var(--faint)]">
                    {action.logged}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              className={cn(action.tone === "critical" && "text-[var(--critical)]")}
              disabled={action.disabled}
              key={action.id}
              onClick={runAction}
            >
              <span className="flex min-w-0 flex-col">
                <span>{action.label}</span>
                {action.logged ? (
                  <span className="text-[length:var(--t-badge)] text-[var(--faint)]">
                    {action.logged}
                  </span>
                ) : null}
              </span>
            </DropdownMenuItem>
          );

          return needsSeparator ? (
            <div key={`${action.id}-group`}>
              <DropdownMenuSeparator />
              {item}
            </div>
          ) : (
            item
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
