"use client";

import type { ReactNode } from "react";

import { FieldShell } from "@/components/kit/atomics";

import { EditorCaret, EditorRegion, useRotatingExample } from "./offer-editor-chrome";

/**
 * Screen 3e, inline: the rules, and the empty field that suggests what belongs there.
 *
 * The artifact draws this as free prose: the coach writes "anyone who says they need to ask their
 * spouse" and we turn it into something the setter can act on. No store exists for that sentence,
 * and the platform's rules table -- not this page -- decides what actually turns a lead away. So
 * the screen keeps its shape and spends it on the rules that are real: the saved thresholds the
 * setter reads before it asks. The suggestion line still rotates, because a coach who has set
 * nothing needs to be told what a rule looks like either way, and it says plainly that a rule we
 * cannot hold as a number goes to a person rather than into this page.
 */

export type DisqualifierLine = {
  /** The stored column this line reads, so a key never has to be matched out of the prose. */
  key: string;
  /** The sentence the card already prints, rendered by the caller from the stored number. */
  text: string;
  set: boolean;
};

/**
 * The suggestions that cycle through the empty field. They are examples of the *shape* of a rule,
 * drawn from the artifact, and none of them claims to be a rule this page can save.
 */
const EXAMPLES: readonly string[] = [
  "e.g. under three months in business",
  "e.g. wants a payment plan",
  "e.g. only wants to talk on the phone",
  "e.g. found us through a giveaway",
  "e.g. needs to ask their spouse first",
];

export type DisqualifiersPanelProps = {
  /** The page's own threshold fields. */
  children: ReactNode;
  lines: readonly DisqualifierLine[];
};

export function DisqualifiersPanel({ children, lines }: DisqualifiersPanelProps) {
  const { index } = useRotatingExample(EXAMPLES.length);
  const saved = lines.filter((line) => line.set).length;

  return (
    <div className="flex min-w-0 flex-col gap-[var(--s-4)]">
      {children}

      <EditorRegion
        aside={
          <span className="font-[family-name:var(--font-mono)] text-[length:var(--coach-body)] leading-none text-[color:var(--muted)]">
            {saved} of {lines.length} set
          </span>
        }
        label="Who it turns away"
      >
        <ul className="flex list-none flex-col p-0">
          {lines.map((line) => (
            <li
              className="flex items-center gap-[13px] border-b border-[var(--line-soft)] py-[13px] text-[length:var(--coach-body)] leading-[1.5] last:border-b-0"
              data-set={line.set ? "true" : "false"}
              key={line.key}
            >
              <span
                aria-hidden
                className={`h-[2px] w-[14px] shrink-0 rounded-[2px] ${
                  line.set ? "bg-[var(--negative)]" : "bg-[var(--line-input)]"
                }`}
              />
              <span className={line.set ? "text-[color:var(--body)]" : "text-[color:var(--muted)]"}>
                {line.text}
                {line.set ? null : (
                  <span className="ml-[10px] text-[length:var(--coach-eyebrow)] text-[color:var(--muted)]">not set</span>
                )}
              </span>
            </li>
          ))}
        </ul>

        {/* The artifact's ghost field, kept as a suggestion rather than as an input that would
            take a sentence nothing can store. */}
        <FieldShell className="mt-[16px] h-[var(--coach-target)] gap-[13px] rounded-[11px] px-[15px]">
          <span
            aria-hidden
            className="h-[2px] w-[14px] shrink-0 rounded-[2px] bg-[var(--negative)] opacity-60"
          />
          <span className="min-w-0 flex-1 truncate text-[length:var(--coach-body)] leading-none text-[color:var(--muted)]">
            {EXAMPLES[index]}
          </span>
          <EditorCaret />
          {/* Sentence case: an uppercase mono tag at 10px is the exact micro-type this surface drops. */}
          <span className="shrink-0 text-[length:var(--coach-eyebrow)] leading-none text-[color:var(--muted)]">
            Ask us
          </span>
        </FieldShell>
        <p className="mt-[14px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          Rules are numbers your setter reads before it asks, not sentences it improvises. A rule we
          cannot hold as a number goes to your success owner, who adds it to the platform rules your
          setter already follows.
        </p>
      </EditorRegion>
    </div>
  );
}
