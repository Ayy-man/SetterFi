"use client";

import { animate, motion, useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, type ReactNode } from "react";

import { DURATION, EASE } from "./tokens";

const NUMERIC_PATTERN = /^(\D*?)(-?\d[\d,]*(?:\.\d+)?)([\s\S]*)$/;

function parseNumeric(text: string) {
  const match = NUMERIC_PATTERN.exec(text);
  if (!match) return null;

  const [, prefix, token, suffix] = match;
  // Only lead figures count up. "First 12 paid months" reads as prose, not a metric.
  if (/\p{L}/u.test(prefix)) return null;

  const value = Number(token.replaceAll(",", ""));
  if (!Number.isFinite(value)) return null;

  const decimals = token.includes(".") ? token.split(".")[1].length : 0;
  const useGrouping = token.includes(",");

  return {
    value,
    render: (latest: number) =>
      `${prefix}${latest.toLocaleString("en-US", {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
        useGrouping,
      })}${suffix}`,
  };
}

function CountUpText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const played = useRef(false);
  const animatedText = useRef<string | null>(null);
  const inView = useInView(ref, { amount: 0.5, once: true });
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node || !inView || reducedMotion || played.current) return;

    const parsed = parseNumeric(text);
    if (!parsed) return;

    played.current = true;
    animatedText.current = text;
    const controls = animate(0, parsed.value, {
      duration: DURATION.fast,
      ease: EASE.smoothOut,
      onUpdate: (latest) => {
        node.textContent = parsed.render(latest);
      },
    });

    return () => {
      controls.stop();
      node.textContent = text;
    };
  }, [inView, reducedMotion, text]);

  // The count-up plays once, then owns the node's text, so a figure that changes afterwards
  // (a chart switching metric, say) has to be written back here. React's own commit of the new
  // text child is undone by the effect cleanup above, which restores the reading it animated to.
  useEffect(() => {
    const node = ref.current;
    if (!node || !played.current || animatedText.current === text) return;
    node.textContent = text;
  }, [text]);

  return (
    <span className={className} ref={ref}>
      {text}
    </span>
  );
}

/** Counts a formatted figure up from zero the first time it scrolls into view. */
export function CountUp({ value, className }: { value: ReactNode; className?: string }) {
  const reducedMotion = useReducedMotion();

  if (typeof value !== "number") {
    return className ? <span className={className}>{value}</span> : <>{value}</>;
  }
  if (reducedMotion) return <span className={className}>{value}</span>;

  return <CountUpText className={className} text={String(value)} />;
}

/** Holds a scaleX bar at zero until it scrolls into view, then lets it draw to width. */
export function useDrawIn<T extends Element>(amount = 0.4) {
  const ref = useRef<T>(null);
  const inView = useInView(ref, { amount, once: true });
  const reducedMotion = useReducedMotion();

  return { ref, drawn: reducedMotion ? true : inView };
}

export function useHoverLift(
  { interactive }: { interactive: boolean } = { interactive: true },
) {
  const reducedMotion = useReducedMotion();

  if (reducedMotion || !interactive) return {};

  return {
    whileHover: { y: "calc(var(--distance-micro) * -1)" },
    transition: { duration: DURATION.quick, ease: EASE.smoothOut },
  } as const;
}

/** Crossfades whatever renders under a given key, including route sections and tab panels. */
export function Crossfade({
  children,
  sectionKey,
  className,
}: {
  children: ReactNode;
  sectionKey: string | number;
  className?: string;
}) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      animate={{ opacity: 1 }}
      className={className}
      initial={reducedMotion ? false : { opacity: 0 }}
      key={sectionKey}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

export const fadeInProps = {
  animate: { opacity: 1 },
  initial: { opacity: 0 },
  transition: { duration: 0.22, ease: "easeOut" },
} as const;
