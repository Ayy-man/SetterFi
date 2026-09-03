"use client";

import { Check, ChevronDown } from "@/components/kit/icons";

import Link from "next/link";

import { useWorkspaceEnv, type DemoViewTarget } from "@/components/workspace/workspace-env";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { demoReviewPersonas } from "@/lib/workspace-navigation";

export type PersonaSwitcherProps = {
  targets: readonly DemoViewTarget[];
  current: string;
};

type SwitcherItem = {
  id: string;
  label: string;
  workspace: string;
  home: string;
  initials: string;
};

export function PersonaSwitcher({ targets, current }: PersonaSwitcherProps) {
  const { demoAccountSwitching, mode } = useWorkspaceEnv();

  if (!demoAccountSwitching) return null;

  const items: readonly SwitcherItem[] = mode === "supabase" ? demoReviewPersonas : targets;
  const currentItem = items.find((item) => item.id === current)
    ?? items.find((item) => item.home === current);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch demo persona"
        className="inline-flex h-[var(--s-5)] items-center gap-[var(--distance-small)] rounded-[var(--r-input)] border border-[var(--line-strong)] bg-transparent px-[var(--s-2)] text-[length:var(--t-badge)] font-medium leading-[var(--t-badge-lh)] text-[var(--body)] outline-none hover:bg-[var(--quiet)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        type="button"
      >
        <span
          aria-hidden="true"
          className="size-[var(--distance-small)] rounded-[var(--r-full)] bg-[var(--accent)]"
        />
        {currentItem?.label ?? "Switch persona"}
        <ChevronDown aria-hidden className="size-[var(--s-4)]" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="rounded-[var(--r-card)] border border-[var(--line)] bg-[var(--raised)] p-[var(--s-1)] shadow-[var(--shadow-raised)] [animation-duration:var(--dropdown-open-dur)] [animation-timing-function:var(--dropdown-ease)] motion-reduce:animate-none"
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {mode === "supabase" ? "Review personas" : "Demo views"}
          </DropdownMenuLabel>
          {items.map((item) => {
            const isCurrent = item.id === currentItem?.id;
            const href = mode === "supabase"
              ? `/login?next=${encodeURIComponent(item.home)}`
              : item.home;

            return (
              <DropdownMenuItem
                aria-current={isCurrent ? "page" : undefined}
                key={item.id}
                nativeButton={false}
                render={<Link href={href} />}
              >
                <span className="t-overline flex size-[var(--s-8)] shrink-0 items-center justify-center rounded-[var(--r-control)] bg-[var(--quiet)]">
                  {item.initials}
                </span>
                <span className="grid min-w-0 flex-1">
                  <span className="t-row truncate">{item.workspace}</span>
                  <span className="t-faint truncate">{item.label}</span>
                </span>
                {isCurrent ? <Check aria-label="Current persona" className="size-[var(--s-4)]" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
