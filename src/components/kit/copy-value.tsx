"use client";

import { Copy } from "@/components/kit/icons";

import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type CopyValueProps = {
  value: string;
  label?: string;
  className?: string;
};

export function CopyValue({ value, label = "value", className }: CopyValueProps) {
  async function copyValue() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Couldn’t copy");
    }
  }

  return (
    <Button
      aria-label={`Copy ${label}`}
      className={cn(
        "!size-[var(--s-6)] !rounded-[var(--r-control)] !border-[var(--line)] !bg-[var(--card)] !p-0 !text-[var(--muted)] hover:!border-[var(--line-strong)] hover:!bg-[var(--row-hover)] hover:!text-[var(--ink)]",
        className,
      )}
      onClick={() => void copyValue()}
      size="icon-xs"
      type="button"
      variant="outline"
    >
      <Copy aria-hidden className="!size-[var(--s-3)]" />
    </Button>
  );
}
