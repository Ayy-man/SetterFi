"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useReducedMotion } from "motion/react";

import { MonoMeta, StatusDot } from "@/components/kit/atomics";

/**
 * The pieces every offer editor is built out of, written once.
 *
 * The artifact drew 3d-3h as dialogs, and the overlay is the one part of them not worth having:
 * a card on this page already opens in place, so a modal over it would be a second way to say the
 * same thing. What those screens are actually good for is their interiors -- the live preview that
 * regenerates from the numbers above it, the week grid and its legend, the rotating suggestion,
 * and the consequence sentence on every row -- and all of that works inline unchanged. So the
 * scrim and the footer button pair are gone, and each editor renders into the section its card
 * already opens.
 *
 * What this file used to also hold was a private copy of the overline, the chip, the input frame,
 * the stated row and the accent button. Those are the kit's now. They were written here before the
 * atomics existed and by the time they did, a token move reached every other surface and not these
 * five editors -- which is the whole reason the kit exists.
 *
 * THE ONE ROLE THAT CAME BACK. The region label is a local 12px sentence-case eyebrow again rather
 * than the kit's `Overline`, and that is not a relapse into private copies -- it is the coach
 * density. `Overline` is 9.5px uppercase mono, which is correct on the owner console and is the
 * single worst legibility case in the product on a surface built for readers over 55. Every editor
 * in this folder renders only inside `/coach/agent`, so raising the role here raises it for all
 * five of them at once and reaches nothing else. The atomic and `overline-size.test.ts` are
 * untouched: the 9.5px overline still exists, it just has no callers on this side.
 */

/**
 * The label on a region, a sample exchange, or anything else inside an open editor. 12px,
 * sentence case, `--muted`.
 */
const EDITOR_LABEL_CLASS =
  "block text-[length:var(--coach-eyebrow)] leading-[1.4] text-[color:var(--muted)]";

/**
 * A titled region inside an open card's editor. The card's own heading already says which thing
 * is being edited, so this names a part of it -- "The week", "What it will say" -- in the same
 * mono overline the faces use, and nothing here repeats the card's title.
 */
export function EditorRegion({
  aside,
  children,
  label,
}: {
  /** A mono note on the heading's right: a count, a unit, a legend. */
  aside?: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <section aria-label={label} className="min-w-0">
      <div className="mb-[12px] flex flex-wrap items-center gap-[10px]">
        <span aria-hidden className={EDITOR_LABEL_CLASS}>
          {label}
        </span>
        {aside ? <span className="ml-auto flex items-center gap-[10px]">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

/**
 * A lead line and the replies under it. The artifact draws this in both the prices dialog and the
 * tone dialog, and the same rule governs both: every word rendered here is either the coach's own
 * saved text or a fixed template filled with figures the coach saved. Nothing composes a sentence
 * the runtime did not, because the runtime answers through a gated pipeline and a handwritten
 * reply would claim wording the agent never produced.
 */
export function SampleExchange({
  caption,
  label,
  lead,
  replies,
  because,
}: {
  caption?: string;
  label: string;
  lead: string;
  replies: readonly string[];
  because?: readonly string[];
}) {
  return (
    <section
      aria-label={label}
      className="rounded-[12px] border border-[var(--line)] bg-[var(--canvas)] p-[16px]"
    >
      <span aria-hidden className={`${EDITOR_LABEL_CLASS} mb-[12px]`}>
        {label}
      </span>
      {/* The bubbles carry the words a lead will actually read, so they are set at the size a
          lead's phone would show them rather than at console caption size. */}
      <p className="mb-[10px] max-w-[80%] rounded-[13px_13px_13px_4px] bg-[rgba(255,255,255,0.06)] px-[15px] py-[11px] text-[length:var(--coach-body)] leading-[1.55] text-[color:var(--body)]">
        {lead}
      </p>
      {replies.map((reply, index) => (
        <p
          className="mb-[10px] ml-auto max-w-[88%] rounded-[13px_13px_4px_13px] bg-[var(--accent-fill)] px-[15px] py-[11px] text-[length:var(--coach-body)] leading-[1.55] text-[color:var(--on-accent)] last:mb-0"
          key={`${index}-${reply.slice(0, 24)}`}
        >
          {reply}
        </p>
      ))}
      {because?.length ? (
        <div className="mt-[12px] flex flex-wrap items-center gap-[8px] border-t border-[var(--line)] pt-[10px]">
          <span className="text-[length:var(--coach-eyebrow)] leading-none text-[color:var(--muted)]">
            Because you chose:
          </span>
          {because.map((token) => (
            <MonoMeta className="text-[length:var(--coach-eyebrow)] leading-none" key={token} tone="accent">
              {token}
            </MonoMeta>
          ))}
        </div>
      ) : null}
      {caption ? (
        <p className="mt-[13px] text-[length:var(--coach-eyebrow)] leading-[1.5] text-[color:var(--muted)]">
          {caption}
        </p>
      ) : null}
    </section>
  );
}

/**
 * Advice, in the one ochre note a dialog is allowed. It never blocks the choice it comments on:
 * the coach owns the setting, we own the observation about it.
 */
export function EditorAdvice({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-[11px] rounded-[10px] border border-[var(--warning-line)] bg-[var(--warning-wash)] px-[15px] py-[13px] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--warning-body)]">
      <StatusDot className="mt-[6px]" tone="warning" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A row that states what SetterFi already decided rather than offering a control. The artifact
 * drew several of these as toggles; they are printed values here wherever no coach-writable store
 * stands behind them, because a switch that saves nothing is a claim the product cannot keep.
 *
 * It was `SettingRow` from the kit until the coach port; the note inside the function says why it
 * is not any more, and everything about the row that was a decision rather than a size is kept.
 */
export function EditorStatedRow({
  detail,
  title,
  value,
}: {
  detail: string;
  title: string;
  value: string;
}) {
  return (
    /*
      Written out rather than delegated to `SettingRow`, and the reason is density rather than
      taste. `SettingRow` sets its title and description from the kit's console type roles, which
      no prop on it can raise, so a coach reading the one kind of row that says "we decided this
      for you" would be reading it at 13px on a 16px page. Everything else about the row is
      unchanged: no icon, the hairline between rows, the value on the right in mono, because a
      decorative teal tile on a row stating a platform decision is exactly what the Ownership Rule
      forbids.
    */
    <div className="flex flex-col gap-[10px] border-b border-[var(--line-soft)] py-[16px] last:border-b-0 @min-[440px]:flex-row @min-[440px]:items-start @min-[440px]:gap-[16px]">
      <div className="min-w-0 flex-1">
        <p className="m-0 text-[17px] leading-[1.35] font-medium text-[color:var(--ink)]">
          {title}
        </p>
        <p className="m-0 mt-[4px] max-w-[var(--measure-prose)] text-[length:var(--coach-body)] leading-[1.5] text-[color:var(--muted)]">
          {detail}
        </p>
      </div>
      <MonoMeta className="shrink-0 text-[length:var(--coach-body)] leading-[1.5]">{value}</MonoMeta>
    </div>
  );
}

/**
 * The empty field's rotating suggestion, and the caret beside it.
 *
 * Both are motion, so both stop under `prefers-reduced-motion`: the placeholder settles on the
 * first example and the caret stays lit rather than blinking. A suggestion that a reader cannot
 * finish reading is worse than one suggestion held still.
 */
export function useRotatingExample(count: number, intervalMs = 3000) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced || count < 2) return;
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % count);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [count, intervalMs, reduced]);

  return { index: index % Math.max(count, 1), reduced: Boolean(reduced) };
}

/** `steps(1)` at 1.1s, in JS so the same reduced-motion answer governs it. */
export function useCaretBlink() {
  const reduced = useReducedMotion();
  const [lit, setLit] = useState(true);

  useEffect(() => {
    if (reduced) return;
    const timer = window.setInterval(() => setLit((current) => !current), 550);
    return () => window.clearInterval(timer);
  }, [reduced]);

  return reduced ? true : lit;
}

/** The artifact's caret: a hairline of accent that blinks beside an empty field. */
export function EditorCaret() {
  const lit = useCaretBlink();
  return (
    <span
      aria-hidden
      className="h-[20px] w-[2px] shrink-0 bg-[var(--accent-bright)]"
      style={{ opacity: lit ? 1 : 0 }}
    />
  );
}
