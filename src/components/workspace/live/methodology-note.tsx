import { Overline } from "@/components/kit/atomics";

import type { MetricDescriptorView } from "./measurement-view-models";

/**
 * How a metric is measured, folded away until asked for.
 *
 * Every card printed its denominator, window, and clock as three full sentences
 * of body copy, so the methodology outweighed the number it described and the
 * grid read as a wall of text. The methodology still has to be reachable -- a
 * coach who doubts a figure needs to see exactly what was counted -- so it stays
 * in the DOM behind a native <details>: keyboard-operable, announced as a
 * disclosure, and reachable by an in-page find. Folding it also lets the three
 * axes be a definition list rather than one run-on string.
 */
export function MethodologyNote({ descriptor }: { descriptor: MetricDescriptorView }) {
  return (
    <details className="text-[length:var(--t-body)] text-[var(--body)]">
      <summary className="cursor-pointer text-[var(--muted)]">How this is measured</summary>
      <dl className="mt-[var(--s-2)] grid gap-[var(--s-2)]">
        <div className="grid gap-[var(--s-1)]">
          <Overline as="dt">Denominator</Overline>
          <dd>{descriptor.denominator}</dd>
        </div>
        <div className="grid gap-[var(--s-1)]">
          <Overline as="dt">Window</Overline>
          <dd>{descriptor.window}</dd>
        </div>
        <div className="grid gap-[var(--s-1)]">
          <Overline as="dt">Clock</Overline>
          <dd>{descriptor.clock}</dd>
        </div>
      </dl>
    </details>
  );
}
