import type { ReactElement, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type KeyValueProps = {
  label: string;
  value: ReactNode;
  mono?: boolean;
  layout?: "inline" | "stacked";
};

export function KeyValue({ label, value, mono = false, layout = "inline" }: KeyValueProps): ReactElement {
  const inline = layout === "inline";

  return (
    <div
      className={cn(
        "min-w-0",
        inline
          ? "inline-flex items-baseline gap-[var(--s-2)]"
          : "flex flex-col gap-[var(--s-1)]",
      )}
      data-layout={layout}
      data-slot="key-value"
    >
      <dt className={inline ? "t-muted inline-flex items-center gap-[var(--s-2)]" : "t-overline"}>
        {label}
        {inline ? (
          <span
            aria-hidden
            className="size-[var(--s-1)] rounded-[var(--r-full)] bg-[var(--line-strong)]"
            data-slot="key-value-separator"
          />
        ) : null}
      </dt>{" "}
      <dd
        className={cn(
          // Both recipes below declare a colour -- `.t-id` muted, `.t-body` body -- and they are
          // unlayered, so without the `!` this value drew muted or body in every case and the ink
          // the author asked for never applied. Deliberate override; the recipes are right for
          // their other callers.
          "m-0 min-w-0 [overflow-wrap:anywhere] text-[var(--ink)]!",
          mono ? "t-id" : "t-body",
        )}
      >
        {value}
      </dd>{" "}
    </div>
  );
}
